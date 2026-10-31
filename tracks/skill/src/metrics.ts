import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { writeJson } from '../../../packages/core/src/config.ts';
import { SCORE_RESULTS } from '../../../packages/core/src/evidence.ts';
import type { ScoreResult } from '../../../packages/core/src/evidence.ts';
import { buildVariantMetrics, formatVariantMetrics } from '../../../packages/core/src/metrics.ts';
import type { BaselineSide, MetricFeatureRow, VariantMetrics } from '../../../packages/core/src/metrics.ts';
import { formatBaseline } from '../../../packages/core/src/marks.ts';
import { loadTaskCard, TaskCardError } from '../../../packages/core/src/task-card.ts';
import type { Interventions } from '../../../packages/core/src/task-card.ts';
import { interventionKind, parseStreamLine, streamToolName, summarizeCursorStream } from './cursor-agent.ts';
import type { StreamEvent } from './cursor-agent.ts';

const MODIFY_TOOLS = new Set([
  'write',
  'edit',
  'delete',
  'strreplace',
  'searchreplace',
  'applypatch',
  'writetoolcall',
  'edittoolcall',
  'deletetoolcall',
  'strreplacetoolcall',
]);

const REVERIFY_TOOLS = new Set(['verify', 'reverify', 'verifytoolcall']);

function normalizeTool(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]/g, '');
}

function countedTool(event: StreamEvent, names: ReadonlySet<string>): boolean {
  if (event.type !== 'tool_call') return false;
  if (event.subtype && event.subtype !== 'completed') return false;
  const name = streamToolName(event.raw);
  if (!name) return false;
  return names.has(normalizeTool(name));
}

/**
 * Rework rounds in one replay stream.
 *
 * A round is a run of modifying tool calls closed by the next boundary.
 * `started` and `completed` for the same edit are one modify, not two.
 * An intervention-request does not open or close a round.
 *
 * Boundaries:
 * - human-confirm: an actual human intervention after those edits. Always one round.
 * - reverify: an in-stream verify tool, or the trailing R7 verify when its score
 *   is not unavailable. The first autonomous edit group is the initial attempt,
 *   so that single trailing verify does not count. A later group does.
 * - submit: the `result` event, only when verify cannot score, and only when the
 *   group was user-driven or already followed an earlier boundary.
 *
 * Without a usable verify score, user-driven modify rounds still count.
 * The same group is not counted again at the next boundary.
 */
export function countReworkRounds(events: readonly StreamEvent[], verifyUnavailable: boolean): number {
  const cursor = { userEvents: 0 };
  let open = false;
  let openedByUser = false;
  let priorBoundary = false;
  let armedByUser = false;
  let rounds = 0;

  const discardOpen = () => {
    open = false;
    openedByUser = false;
  };

  for (const event of events) {
    const kind = interventionKind(event, cursor);
    if (kind === 'request') continue;
    if (kind === 'actual') {
      if (open) {
        rounds += 1;
        priorBoundary = true;
        discardOpen();
      }
      armedByUser = true;
      continue;
    }
    if (countedTool(event, REVERIFY_TOOLS)) {
      if (open && (openedByUser || priorBoundary)) rounds += 1;
      if (open) priorBoundary = true;
      discardOpen();
      continue;
    }
    if (countedTool(event, MODIFY_TOOLS)) {
      if (!open) {
        open = true;
        openedByUser = armedByUser;
        armedByUser = false;
      }
      continue;
    }
    if (event.type !== 'result') continue;
    if (!verifyUnavailable && open && (openedByUser || priorBoundary)) continue;
    if (!verifyUnavailable) {
      discardOpen();
      continue;
    }
    if (open && (openedByUser || priorBoundary)) rounds += 1;
    discardOpen();
  }

  if (open && (openedByUser || priorBoundary)) rounds += 1;
  return rounds;
}

export interface CollectResult {
  lines: string[];
  files: string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function baselineSide(value: Interventions | undefined, mode: 'events' | 'rounds'): BaselineSide {
  const label = formatBaseline(value, mode);
  if (label === 'none') return 'none';
  if (/^[1-9][0-9]*$/.test(label)) return Number(label);
  return 'unknown';
}

function readEvents(file: string): StreamEvent[] {
  if (!existsSync(file)) return [];
  const events: StreamEvent[] = [];
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    const parsed = parseStreamLine(line);
    if (parsed) events.push(parsed);
  }
  return events;
}

function scoreOf(value: unknown): ScoreResult | undefined {
  return typeof value === 'string' && (SCORE_RESULTS as readonly string[]).includes(value) ? value as ScoreResult : undefined;
}

function readScore(attemptDir: string): { score: ScoreResult; features: MetricFeatureRow[] } {
  const verifyFile = join(attemptDir, 'verify', 'result.json');
  if (existsSync(verifyFile)) {
    try {
      const parsed = JSON.parse(readFileSync(verifyFile, 'utf8')) as unknown;
      if (isRecord(parsed)) {
        const score = scoreOf(parsed.score) ?? 'unavailable';
        const features = Array.isArray(parsed.features)
          ? parsed.features.filter(isRecord).map(row => ({ evidence: Array.isArray(row.evidence) ? row.evidence : [] }))
          : [];
        return { score, features };
      }
    } catch {
      return { score: 'unavailable', features: [] };
    }
  }
  const resultFile = join(attemptDir, 'result.json');
  if (existsSync(resultFile)) {
    try {
      const parsed = JSON.parse(readFileSync(resultFile, 'utf8')) as unknown;
      if (isRecord(parsed)) return { score: scoreOf(parsed.score) ?? 'unavailable', features: [] };
    } catch {
      /* fall through */
    }
  }
  return { score: 'unavailable', features: [] };
}

function durationFromUsage(value: unknown): number | 'unknown' | 'missing' {
  if (!isRecord(value) || !('duration_ms' in value)) return 'missing';
  const raw = value.duration_ms;
  if (raw === 'unknown') return 'unknown';
  if (typeof raw === 'number' && Number.isFinite(raw)) return raw;
  return 'unknown';
}

function durationFromResult(events: readonly StreamEvent[]): number | 'unknown' {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (!event || event.type !== 'result') continue;
    const raw = event.raw.duration_ms ?? event.raw.durationMs;
    if (typeof raw === 'number' && Number.isFinite(raw)) return raw;
  }
  return 'unknown';
}

function readUsageFile(file: string): unknown {
  if (!existsSync(file)) return undefined;
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return undefined;
  }
}

function attemptDirs(variantDir: string): { attempt: number; dir: string }[] {
  const attempts = join(variantDir, 'attempts');
  if (existsSync(attempts) && statSync(attempts).isDirectory()) {
    return readdirSync(attempts)
      .filter(name => /^[1-9][0-9]*$/.test(name))
      .sort((a, b) => Number(a) - Number(b))
      .flatMap(name => {
        const dir = join(attempts, name);
        return statSync(dir).isDirectory() ? [{ attempt: Number(name), dir }] : [];
      });
  }
  return [{ attempt: 1, dir: variantDir }];
}

function variantNames(variantsDir: string): string[] {
  const preferred = ['without', 'with-skill'];
  return readdirSync(variantsDir).filter(name => statSync(join(variantsDir, name)).isDirectory()).sort((a, b) => {
    const ai = preferred.indexOf(a);
    const bi = preferred.indexOf(b);
    if (ai !== -1 || bi !== -1) return (ai === -1 ? 99 : ai) - (bi === -1 ? 99 : bi);
    return a.localeCompare(b);
  });
}

/**
 * One measurement of a variant attempt.
 * Intervention columns come from `summarizeCursorStream` only.
 * `interventions.json` is not added on top of the stream.
 */
export function measureAttempt(events: readonly StreamEvent[], input: {
  usage: unknown;
  score: ScoreResult;
  features: readonly MetricFeatureRow[];
}): Pick<VariantMetrics, 'intervention_request' | 'actual_human_intervention' | 'rework_rounds' | 'duration_ms' | 'input_tokens' | 'output_tokens' | 'cost' | 'evidence_completeness' | 'score'> {
  const observed = events.length > 0;
  const summary = observed
    ? summarizeCursorStream(events, { spawned: true, aborted: false })
    : undefined;
  const verifyUnavailable = input.score === 'unavailable' || input.score === 'interrupted';
  const harnessDuration = durationFromUsage(input.usage);
  const duration = harnessDuration === 'missing' ? durationFromResult(events) : harnessDuration;
  const metrics = buildVariantMetrics({
    taskId: 'measure',
    runId: 'measure',
    variant: 'measure',
    attempt: 1,
    interventionRequest: summary ? summary.interventions.intervention_request : 'unknown',
    actualHumanIntervention: summary ? summary.interventions.actual_intervention : 'unknown',
    reworkRounds: summary ? countReworkRounds(events, verifyUnavailable) : 'unknown',
    score: input.score,
    features: verifyUnavailable ? [] : input.features,
    durationMs: typeof duration === 'number' ? duration : 'unknown',
    inputTokens: summary ? summary.usage.input_tokens : 'unknown',
    outputTokens: summary ? summary.usage.output_tokens : 'unknown',
    cost: summary ? summary.usage.cost : 'unknown',
    baselineInterventions: 'unknown',
    baselineReworkRounds: 'unknown',
  });
  return metrics;
}

export function collectRunMetrics(options: { root: string; runsDir: string; taskId: string; runId: string }): CollectResult {
  const runDir = join(options.runsDir, options.runId);
  if (!existsSync(runDir) || !statSync(runDir).isDirectory()) throw new Error(`run not found: ${options.runId}`);
  const planFile = join(runDir, 'run.json');
  if (existsSync(planFile)) {
    const plan = JSON.parse(readFileSync(planFile, 'utf8')) as { taskId?: string };
    if (plan.taskId && plan.taskId !== options.taskId) throw new Error(`run ${options.runId} is for task ${plan.taskId}`);
  }
  let card;
  try {
    card = loadTaskCard(join(options.root, 'tasks', options.taskId));
  } catch (error) {
    if (error instanceof TaskCardError) throw new Error(error.message);
    throw error;
  }
  const baselineInterventions = baselineSide(card.private.interventions, 'events');
  const baselineReworkRounds = baselineSide(card.private.rework, 'rounds');
  const variantsDir = join(runDir, 'variants');
  if (!existsSync(variantsDir) || !statSync(variantsDir).isDirectory()) {
    throw new Error(`run ${options.runId} has no variants`);
  }
  const lines = [`run: ${options.runId}`];
  const files: string[] = [];
  for (const variant of variantNames(variantsDir)) {
    for (const attempt of attemptDirs(join(variantsDir, variant))) {
      const events = readEvents(join(attempt.dir, 'events.jsonl'));
      const verdict = readScore(attempt.dir);
      const measured = measureAttempt(events, {
        usage: readUsageFile(join(attempt.dir, 'usage.json')),
        score: verdict.score,
        features: verdict.features,
      });
      const metrics = buildVariantMetrics({
        taskId: options.taskId,
        runId: options.runId,
        variant,
        attempt: attempt.attempt,
        interventionRequest: measured.intervention_request,
        actualHumanIntervention: measured.actual_human_intervention,
        reworkRounds: measured.rework_rounds,
        score: verdict.score,
        features: verdict.score === 'unavailable' || verdict.score === 'interrupted' ? [] : verdict.features,
        durationMs: measured.duration_ms,
        inputTokens: measured.input_tokens,
        outputTokens: measured.output_tokens,
        cost: measured.cost,
        baselineInterventions,
        baselineReworkRounds,
      });
      const file = join(attempt.dir, 'metrics.json');
      writeJson(file, metrics);
      files.push(file);
      lines.push(...formatVariantMetrics(metrics));
    }
  }
  return { lines, files };
}
