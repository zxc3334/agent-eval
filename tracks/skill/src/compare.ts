import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import {
  buildCompareReport,
  configKeyFrom,
  isSameFeedback,
  renderCompareMarkdown,
  renderCompareTerminal,
  renderFeedbackCard,
  worsenedMetrics,
} from '../../../packages/core/src/compare.ts';
import type { CompareObservation, CompareReport, CompareSide, EvidencePaths } from '../../../packages/core/src/compare.ts';
import { writeJson } from '../../../packages/core/src/config.ts';
import { SCORE_RESULTS } from '../../../packages/core/src/evidence.ts';
import type { ScoreResult } from '../../../packages/core/src/evidence.ts';
import { parseVariantMetrics } from '../../../packages/core/src/metrics.ts';
import { loadTaskCard, parseTaskCardYaml, TaskCardError } from '../../../packages/core/src/task-card.ts';
import type { TaskCard } from '../../../packages/core/src/task-card.ts';

export class CompareError extends Error {
  readonly exitCode: number;

  constructor(message: string, exitCode = 2) {
    super(message);
    this.name = 'CompareError';
    this.exitCode = exitCode;
  }
}

const EMPTY_EVIDENCE: EvidencePaths = { events: null, result: null, metrics: null, verify: null };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function repoPath(root: string, file: string): string {
  return relative(root, file).split(sep).join('/');
}

function readJson(file: string): { value: unknown; invalid: boolean } {
  if (!existsSync(file)) return { value: undefined, invalid: false };
  try {
    return { value: JSON.parse(readFileSync(file, 'utf8')) as unknown, invalid: false };
  } catch {
    return { value: undefined, invalid: true };
  }
}

function scoreOf(value: unknown): ScoreResult | undefined {
  if (!isRecord(value) || typeof value.score !== 'string') return undefined;
  return (SCORE_RESULTS as readonly string[]).includes(value.score) ? value.score as ScoreResult : undefined;
}

function absentSide(): CompareSide {
  return {
    present: false,
    metricsInvalid: false,
    attemptStatus: 'missing',
    base: 'unknown',
    configKey: 'unknown',
    score: 'missing',
    evidence: { ...EMPTY_EVIDENCE },
  };
}

function existing(root: string, file: string): string | null {
  return existsSync(file) ? repoPath(root, file) : null;
}

function loadSide(root: string, dir: string, cardBase: string | undefined): CompareSide {
  const metricsFile = join(dir, 'metrics.json');
  const resultFile = join(dir, 'result.json');
  const configFile = join(dir, 'config.json');
  const verifyFile = join(dir, 'verify', 'result.json');
  const metricsRaw = readJson(metricsFile);
  const parsed = metricsRaw.invalid ? undefined : parseVariantMetrics(metricsRaw.value);
  const metricsInvalid = metricsRaw.invalid || (metricsRaw.value !== undefined && !parsed);
  const resultRaw = readJson(resultFile);
  let attemptStatus: CompareSide['attemptStatus'] = 'missing';
  let base: string | 'unknown' = cardBase ?? 'unknown';
  if (isRecord(resultRaw.value)) {
    if (resultRaw.value.status === 'completed' || resultRaw.value.status === 'interrupted' || resultRaw.value.status === 'error') {
      attemptStatus = resultRaw.value.status;
    }
    if (typeof resultRaw.value.expected_base === 'string' && resultRaw.value.expected_base) base = resultRaw.value.expected_base;
  }
  const configRaw = readJson(configFile);
  const configKey = isRecord(configRaw.value) ? configKeyFrom(configRaw.value) : 'unknown';
  let score: ScoreResult = parsed?.score ?? 'unavailable';
  if (!parsed) {
    const fromVerify = scoreOf(readJson(verifyFile).value);
    if (fromVerify) score = fromVerify;
  }
  return {
    present: true,
    metrics: parsed,
    metricsInvalid,
    attemptStatus,
    base,
    configKey,
    score,
    evidence: {
      events: existing(root, join(dir, 'events.jsonl')),
      result: existing(root, resultFile),
      metrics: existing(root, metricsFile),
      verify: existing(root, verifyFile),
    },
  };
}

function attemptDirs(variantDir: string): Map<number, string> {
  const found = new Map<number, string>();
  if (!existsSync(variantDir) || !statSync(variantDir).isDirectory()) return found;
  const attempts = join(variantDir, 'attempts');
  if (existsSync(attempts) && statSync(attempts).isDirectory()) {
    for (const name of readdirSync(attempts)) {
      if (!/^[1-9][0-9]*$/.test(name)) continue;
      const dir = join(attempts, name);
      if (statSync(dir).isDirectory()) found.set(Number(name), dir);
    }
    return found;
  }
  found.set(1, variantDir);
  return found;
}

export function taskMatches(taskId: string, filter: string): boolean {
  const parts = filter.split(',').map(part => part.trim()).filter(Boolean);
  return parts.some(part => {
    const body = part.split('*').map(segment => segment.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*');
    return new RegExp(`^${body}$`).test(taskId);
  });
}

function cardBaseOf(root: string, taskId: string): string | undefined {
  const dir = join(root, 'tasks', taskId);
  if (!existsSync(join(dir, 'card.yaml'))) return undefined;
  try {
    const card = loadTaskCard(dir);
    return typeof card.public.base_commit === 'string' ? card.public.base_commit : undefined;
  } catch {
    return undefined;
  }
}

export function loadCompareObservations(options: {
  root: string;
  runsDir: string;
  tasks: string;
  a: string;
  b: string;
}): { observations: CompareObservation[]; warnings: string[] } {
  const warnings: string[] = [];
  const observations: CompareObservation[] = [];
  if (!existsSync(options.runsDir)) return { observations, warnings };
  const names = readdirSync(options.runsDir).filter(name => {
    const dir = join(options.runsDir, name);
    return statSync(dir).isDirectory();
  }).sort();
  for (const name of names) {
    const runDir = join(options.runsDir, name);
    const planFile = join(runDir, 'run.json');
    if (!existsSync(planFile)) continue;
    const planRaw = readJson(planFile);
    if (planRaw.invalid || !isRecord(planRaw.value) || typeof planRaw.value.taskId !== 'string') {
      warnings.push(`run ${name} has no task id`);
      continue;
    }
    const taskId = planRaw.value.taskId;
    if (!taskMatches(taskId, options.tasks)) continue;
    const cardBase = cardBaseOf(options.root, taskId);
    const sides = {
      a: attemptDirs(join(runDir, 'variants', options.a)),
      b: attemptDirs(join(runDir, 'variants', options.b)),
    };
    const attempts = [...new Set([...sides.a.keys(), ...sides.b.keys()])].sort((left, right) => left - right);
    for (const attempt of attempts) {
      const left = sides.a.get(attempt);
      const right = sides.b.get(attempt);
      observations.push({
        taskId,
        runId: name,
        attempt,
        runDir: repoPath(options.root, runDir),
        a: left ? loadSide(options.root, left, cardBase) : absentSide(),
        b: right ? loadSide(options.root, right, cardBase) : absentSide(),
      });
    }
  }
  return { observations, warnings };
}

export function writeCompareReport(options: {
  root: string;
  runsDir: string;
  tasks: string;
  a: string;
  b: string;
  outDir: string;
}): { report: CompareReport; markdown: string; json: string; terminal: string } {
  const loaded = loadCompareObservations(options);
  const report = buildCompareReport({
    a: options.a,
    b: options.b,
    tasks: options.tasks,
    observations: loaded.observations,
    warnings: loaded.warnings,
  });
  mkdirSync(options.outDir, { recursive: true });
  const json = join(options.outDir, 'compare.json');
  const markdown = join(options.outDir, 'compare.md');
  writeJson(json, report);
  writeFileSync(markdown, renderCompareMarkdown(report, options.outDir, options.root));
  const terminal = [
    renderCompareTerminal(report).replace(/\n$/, ''),
    `markdown: ${repoPath(options.root, markdown)}`,
    `json: ${repoPath(options.root, json)}`,
  ].join('\n');
  return { report, markdown, json, terminal: `${terminal}\n` };
}

function loadSourceCard(root: string, taskId: string): TaskCard {
  try {
    return loadTaskCard(join(root, 'tasks', taskId));
  } catch (error) {
    if (error instanceof TaskCardError) throw new CompareError(error.message);
    throw error;
  }
}

export function applyFeedback(options: {
  root: string;
  runsDir: string;
  taskId: string;
  runId: string;
  attempt: number;
  a: string;
  b: string;
}): { status: 'created' | 'unchanged'; id: string; file: string; runId: string } {
  const loaded = loadCompareObservations({
    root: options.root,
    runsDir: options.runsDir,
    tasks: options.taskId,
    a: options.a,
    b: options.b,
  });
  const runDir = join(options.runsDir, options.runId);
  if (!existsSync(join(runDir, 'run.json'))) throw new CompareError(`run not found: ${options.runId}`);
  const observations = loaded.observations.filter(item => item.runId === options.runId);
  if (observations.length === 0) throw new CompareError(`run ${options.runId} has no ${options.a}/${options.b} pair for ${options.taskId}`);
  const report = buildCompareReport({
    a: options.a,
    b: options.b,
    tasks: options.taskId,
    observations,
    warnings: loaded.warnings,
  });
  const row = report.rows.find(item => item.attempt === options.attempt);
  if (!row) {
    const attempts = report.rows.map(item => item.attempt).join(', ');
    throw new CompareError(`run ${options.runId} has no attempt ${options.attempt} (have ${attempts || 'none'})`);
  }
  const worsened = worsenedMetrics(row);
  const verifyWorsened = row.verify.outcome === 'worsened';
  if (worsened.length === 0 && !verifyWorsened) {
    throw new CompareError(`compare feedback: no worsened metric for ${options.taskId} run ${options.runId} attempt ${options.attempt}`);
  }
  const source = loadSourceCard(options.root, options.taskId);
  const rendered = renderFeedbackCard({
    source,
    runId: options.runId,
    attempt: options.attempt,
    sideB: options.b,
    worsened,
    verifyWorsened,
  });
  const file = join(options.root, 'tasks', rendered.id, 'card.yaml');
  if (existsSync(file)) {
    const parsed = parseTaskCardYaml(readFileSync(file, 'utf8'), { expectedId: rendered.id });
    if (!parsed.ok) throw new CompareError(parsed.errors.map(issue => `${issue.field}: ${issue.message}`).join('\n'));
    if (isSameFeedback(parsed.card, options.runId, options.attempt)) {
      return { status: 'unchanged', id: rendered.id, file, runId: options.runId };
    }
    throw new CompareError(`task already exists: ${rendered.id}`);
  }
  mkdirSync(join(options.root, 'tasks', rendered.id), { recursive: true });
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, rendered.yaml);
  renameSync(tmp, file);
  return { status: 'created', id: rendered.id, file, runId: options.runId };
}
