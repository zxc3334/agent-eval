import { join, relative, sep } from 'node:path';
import { stringify } from 'yaml';
import type { ScoreResult } from './evidence.ts';
import type { MeasuredNumber, VariantMetrics } from './metrics.ts';
import { SCHEMA_VERSION, parseTaskCardYaml } from './task-card.ts';
import type { TaskCard, VerifyState } from './task-card.ts';

/**
 * With/without comparison over metrics that R8 already wrote.
 *
 * A row is one task, one run, and one repeat. It is not given a single
 * improve/regress label. Each metric keeps its own outcome.
 * `unknown` is a missing measurement. `missing` is a side that was not run.
 * Neither is `flat`, and neither is stored as 0.
 * A measured 0 stays 0 and can be `flat` only when both attempts completed.
 * An interrupted or failed attempt with a 0 delta stays interrupted or failed.
 */
export const COMPARE_SCHEMA_VERSION = 1 as const;

export const COMPARE_METRICS = ['interventions', 'rework_rounds', 'duration_ms', 'input_tokens', 'output_tokens'] as const;
export type CompareMetricName = (typeof COMPARE_METRICS)[number];

export const METRIC_OUTCOMES = ['improved', 'worsened', 'flat', 'unknown', 'missing', 'interrupted', 'failed', 'unscored', 'conflict'] as const;
export type MetricOutcome = (typeof METRIC_OUTCOMES)[number];

export const VERIFY_OUTCOMES = ['improved', 'worsened', 'flat', 'unavailable', 'interrupted', 'conflict'] as const;
export type VerifyOutcome = (typeof VERIFY_OUTCOMES)[number];

export type AttemptStatus = 'completed' | 'interrupted' | 'error' | 'missing';
export type PairStatus = 'match' | 'mismatch' | 'unknown';

export interface EvidencePaths {
  events: string | null;
  result: string | null;
  metrics: string | null;
  verify: string | null;
}

export interface CompareSide {
  present: boolean;
  /** Parsed metrics. Absent or invalid files leave this empty and are not filled with 0. */
  metrics?: VariantMetrics;
  metricsInvalid: boolean;
  attemptStatus: AttemptStatus;
  base: string | 'unknown';
  /** Stable config identity. The skill list is not part of it. `unknown` means the file was not readable. */
  configKey: string | 'unknown';
  score: ScoreResult | 'missing';
  evidence: EvidencePaths;
}

export interface CompareObservation {
  taskId: string;
  runId: string;
  attempt: number;
  /** Repo-relative run directory, for example `runs/<id>`. */
  runDir: string;
  a: CompareSide;
  b: CompareSide;
}

export interface MetricCell {
  outcome: MetricOutcome;
  a: number | 'unknown' | 'missing';
  b: number | 'unknown' | 'missing';
  /** Numeric only when both sides measured a finite number. Never 0 for unknown or missing. */
  delta: number | 'unknown' | 'missing';
}

export interface VerifyCell {
  outcome: VerifyOutcome;
  a: ScoreResult | 'missing';
  b: ScoreResult | 'missing';
}

export interface CompareRow {
  task_id: string;
  run_id: string;
  attempt: number;
  run_dir: string;
  base: string;
  base_status: PairStatus;
  config: PairStatus;
  flags: string[];
  metrics: Record<CompareMetricName, MetricCell>;
  verify: VerifyCell;
  evidence: { a: EvidencePaths; b: EvidencePaths };
}

export interface CompareSummary {
  metrics: Record<CompareMetricName, Record<MetricOutcome, number>>;
  verify: Record<VerifyOutcome, number>;
}

export interface CompareReport {
  schema_version: typeof COMPARE_SCHEMA_VERSION;
  a: string;
  b: string;
  tasks: string;
  pairs: number;
  warnings: string[];
  summary: CompareSummary;
  rows: CompareRow[];
}

export interface FeedbackMetric {
  name: CompareMetricName;
  delta: number;
  a: number;
  b: number;
}

const EMPTY_EVIDENCE: EvidencePaths = { events: null, result: null, metrics: null, verify: null };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Config identity used for pairing. Skills are the intended difference, so they are left out. */
export function configKeyFrom(config: unknown): string | 'unknown' {
  if (!isRecord(config)) return 'unknown';
  return JSON.stringify({
    adapter: config.adapter ?? null,
    entry: config.entry ?? null,
    args: config.args ?? null,
    model: config.model ?? null,
    prompt_sha256: config.prompt_sha256 ?? null,
  });
}

function emptyMetricCounts(): Record<MetricOutcome, number> {
  return { improved: 0, worsened: 0, flat: 0, unknown: 0, missing: 0, interrupted: 0, failed: 0, unscored: 0, conflict: 0 };
}

function emptyVerifyCounts(): Record<VerifyOutcome, number> {
  return { improved: 0, worsened: 0, flat: 0, unavailable: 0, interrupted: 0, conflict: 0 };
}

function measured(value: MeasuredNumber): number | 'unknown' {
  if (value === 'unknown') return 'unknown';
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  return 'unknown';
}

function metricValue(side: CompareSide, metric: CompareMetricName): number | 'unknown' | 'missing' {
  if (!side.present) return 'missing';
  if (side.metricsInvalid || !side.metrics) return 'unknown';
  switch (metric) {
    case 'interventions':
      return measured(side.metrics.actual_human_intervention);
    case 'rework_rounds':
      return measured(side.metrics.rework_rounds);
    case 'duration_ms':
      return measured(side.metrics.duration_ms);
    case 'input_tokens':
      return measured(side.metrics.input_tokens);
    case 'output_tokens':
      return measured(side.metrics.output_tokens);
    default:
      return 'unknown';
  }
}

function pairStatus(a: CompareSide, b: CompareSide, pick: (side: CompareSide) => string | 'unknown'): PairStatus {
  if (!a.present || !b.present) return 'unknown';
  const left = pick(a);
  const right = pick(b);
  if (left === 'unknown' || right === 'unknown') return left === right ? 'unknown' : 'mismatch';
  return left === right ? 'match' : 'mismatch';
}

function baseText(a: CompareSide, b: CompareSide, status: PairStatus): string {
  if (status === 'match') return a.base;
  if (status === 'mismatch') return `a ${a.base} b ${b.base}`;
  if (a.present && a.base !== 'unknown') return a.base;
  if (b.present && b.base !== 'unknown') return b.base;
  return 'unknown';
}

function classifyMetric(a: CompareSide, b: CompareSide, metric: CompareMetricName, conflict: boolean): MetricCell {
  const left = metricValue(a, metric);
  const right = metricValue(b, metric);
  if (left === 'missing' || right === 'missing') return { outcome: 'missing', a: left, b: right, delta: 'missing' };
  if (left === 'unknown' || right === 'unknown') return { outcome: 'unknown', a: left, b: right, delta: 'unknown' };
  const delta = right - left;
  if (conflict) return { outcome: 'conflict', a: left, b: right, delta };
  if (delta < 0) return { outcome: 'improved', a: left, b: right, delta };
  if (delta > 0) return { outcome: 'worsened', a: left, b: right, delta };
  const interrupted = a.attemptStatus === 'interrupted' || b.attemptStatus === 'interrupted';
  if (interrupted) return { outcome: 'interrupted', a: left, b: right, delta };
  if (a.attemptStatus === 'error' || b.attemptStatus === 'error') return { outcome: 'failed', a: left, b: right, delta };
  if (a.attemptStatus !== 'completed' || b.attemptStatus !== 'completed') return { outcome: 'unscored', a: left, b: right, delta };
  return { outcome: 'flat', a: left, b: right, delta };
}

function classifyVerify(a: CompareSide, b: CompareSide): VerifyCell {
  const left = a.present ? a.score : 'missing';
  const right = b.present ? b.score : 'missing';
  if (left === 'missing' || right === 'missing') return { outcome: 'unavailable', a: left, b: right };
  if (left === 'interrupted' || right === 'interrupted') return { outcome: 'interrupted', a: left, b: right };
  if (left === 'unavailable' || right === 'unavailable') return { outcome: 'unavailable', a: left, b: right };
  if (left === 'verifier error' || right === 'verifier error') return { outcome: 'conflict', a: left, b: right };
  if ((left === 'pass' || left === 'feature fail') && (right === 'pass' || right === 'feature fail')) {
    const rank = (score: ScoreResult) => (score === 'pass' ? 1 : 0);
    const delta = rank(right) - rank(left);
    const outcome: VerifyOutcome = delta > 0 ? 'improved' : delta < 0 ? 'worsened' : 'flat';
    return { outcome, a: left, b: right };
  }
  return { outcome: 'conflict', a: left, b: right };
}

function flagsFor(a: CompareSide, b: CompareSide, config: PairStatus, base: PairStatus): string[] {
  const flags: string[] = [];
  if (!a.present) flags.push('missing-a');
  if (!b.present) flags.push('missing-b');
  if (a.attemptStatus === 'interrupted' || b.attemptStatus === 'interrupted') flags.push('interrupted');
  if (a.attemptStatus === 'error' || b.attemptStatus === 'error') flags.push('failed');
  if ((a.present && a.attemptStatus === 'missing') || (b.present && b.attemptStatus === 'missing')) flags.push('unscored');
  if (config === 'mismatch') flags.push('config-mismatch');
  if (config === 'unknown' && a.present && b.present) flags.push('config-unknown');
  if (base === 'mismatch') flags.push('base-mismatch');
  if (base === 'unknown' && a.present && b.present && (a.base === 'unknown' || b.base === 'unknown')) flags.push('base-unknown');
  if (a.metricsInvalid || b.metricsInvalid) flags.push('metrics-invalid');
  if ((a.present && !a.metrics && !a.metricsInvalid) || (b.present && !b.metrics && !b.metricsInvalid)) flags.push('unmeasured');
  return flags.sort();
}

function rowFrom(observation: CompareObservation, attemptFlag?: string): CompareRow {
  const config = pairStatus(observation.a, observation.b, side => side.configKey);
  const baseStatus = pairStatus(observation.a, observation.b, side => side.base);
  const conflict = config === 'mismatch' || baseStatus === 'mismatch';
  const metrics = {} as Record<CompareMetricName, MetricCell>;
  for (const metric of COMPARE_METRICS) metrics[metric] = classifyMetric(observation.a, observation.b, metric, conflict);
  const flags = flagsFor(observation.a, observation.b, config, baseStatus);
  if (attemptFlag) flags.push(attemptFlag);
  flags.sort();
  return {
    task_id: observation.taskId,
    run_id: observation.runId,
    attempt: observation.attempt,
    run_dir: observation.runDir,
    base: baseText(observation.a, observation.b, baseStatus),
    base_status: baseStatus,
    config,
    flags,
    metrics,
    verify: classifyVerify(observation.a, observation.b),
    evidence: {
      a: observation.a.evidence ?? EMPTY_EVIDENCE,
      b: observation.b.evidence ?? EMPTY_EVIDENCE,
    },
  };
}

export function summarizeRows(rows: readonly CompareRow[]): CompareSummary {
  const summary: CompareSummary = { metrics: {} as CompareSummary['metrics'], verify: emptyVerifyCounts() };
  for (const metric of COMPARE_METRICS) summary.metrics[metric] = emptyMetricCounts();
  for (const row of rows) {
    for (const metric of COMPARE_METRICS) summary.metrics[metric][row.metrics[metric].outcome] += 1;
    summary.verify[row.verify.outcome] += 1;
  }
  return summary;
}

export function buildCompareReport(input: {
  a: string;
  b: string;
  tasks: string;
  observations: readonly CompareObservation[];
  warnings?: readonly string[];
}): CompareReport {
  const seen = new Set<string>();
  const rows: CompareRow[] = [];
  for (const observation of input.observations) {
    const key = `${observation.taskId}\0${observation.runId}\0${observation.attempt}`;
    if (seen.has(key)) throw new Error(`duplicate pair ${observation.taskId} ${observation.runId} attempt ${observation.attempt}`);
    seen.add(key);
    const attemptFlag = [observation.a, observation.b].some(side => side.metrics && side.metrics.attempt !== observation.attempt)
      ? 'attempt-mismatch'
      : undefined;
    rows.push(rowFrom(observation, attemptFlag));
  }
  rows.sort((left, right) => left.task_id.localeCompare(right.task_id) || left.run_id.localeCompare(right.run_id) || left.attempt - right.attempt);
  const warnings = [...(input.warnings ?? [])].sort();
  return {
    schema_version: COMPARE_SCHEMA_VERSION,
    a: input.a,
    b: input.b,
    tasks: input.tasks,
    pairs: rows.length,
    warnings,
    summary: summarizeRows(rows),
    rows,
  };
}

export function worsenedMetrics(row: CompareRow): FeedbackMetric[] {
  const found: FeedbackMetric[] = [];
  for (const metric of COMPARE_METRICS) {
    const cell = row.metrics[metric];
    if (cell.outcome !== 'worsened' || typeof cell.delta !== 'number' || typeof cell.a !== 'number' || typeof cell.b !== 'number') continue;
    found.push({ name: metric, delta: cell.delta, a: cell.a, b: cell.b });
  }
  return found;
}

function formatEnd(value: number | 'unknown' | 'missing' | ScoreResult): string {
  return String(value);
}

function formatSigned(value: number): string {
  return value > 0 ? `+${value}` : String(value);
}

export function formatMetricCell(name: string, cell: MetricCell): string {
  const ends = `(a ${formatEnd(cell.a)} → b ${formatEnd(cell.b)})`;
  if (cell.outcome === 'unknown' || cell.outcome === 'missing') return `${name}: ${cell.outcome} ${ends}`;
  return `${name}: ${cell.outcome} ${formatSigned(cell.delta as number)} ${ends}`;
}

export function formatVerifyCell(cell: VerifyCell): string {
  return `verify: ${cell.outcome} (a ${formatEnd(cell.a)} → b ${formatEnd(cell.b)})`;
}

function summaryLine(name: string, counts: Record<string, number>, keys: readonly string[]): string {
  return `summary.${name}: ${keys.map(key => `${key}=${counts[key] ?? 0}`).join(' ')}`;
}

export function summaryLines(report: CompareReport): string[] {
  const lines = COMPARE_METRICS.map(metric => summaryLine(metric, report.summary.metrics[metric], METRIC_OUTCOMES));
  lines.push(summaryLine('verify', report.summary.verify, VERIFY_OUTCOMES));
  return lines;
}

function rowHeader(row: CompareRow): string {
  return `row ${row.task_id} attempt ${row.attempt} run ${row.run_id} base ${row.base} config ${row.config}`;
}

function rowLines(row: CompareRow): string[] {
  return [
    rowHeader(row),
    ...COMPARE_METRICS.map(metric => `  ${formatMetricCell(metric, row.metrics[metric])}`),
    `  ${formatVerifyCell(row.verify)}`,
    `  flags: ${row.flags.length > 0 ? row.flags.join(' ') : 'none'}`,
  ];
}

function worseningLines(report: CompareReport): string[] {
  const lines = ['worsening:'];
  const rows = report.rows.filter(row => worsenedMetrics(row).length > 0 || row.verify.outcome === 'worsened');
  if (rows.length === 0) {
    lines.push('- none');
    return lines;
  }
  for (const row of rows) {
    const parts = worsenedMetrics(row).map(metric => `${metric.name} ${formatSigned(metric.delta)}`);
    if (row.verify.outcome === 'worsened') parts.push('verify');
    lines.push(`- ${row.task_id} attempt ${row.attempt} run ${row.run_id} ${parts.join(', ')}`);
    lines.push(`  run: ${row.run_dir}`);
    for (const side of ['a', 'b'] as const) {
      const evidence = row.evidence[side];
      for (const kind of ['events', 'result', 'metrics', 'verify'] as const) {
        const path = evidence[kind];
        if (path) lines.push(`  ${side} ${kind}: ${path}`);
      }
    }
    if (!row.evidence.a.verify && !row.evidence.b.verify) lines.push('  verify: unavailable');
  }
  return lines;
}

export function renderCompareTerminal(report: CompareReport): string {
  const lines = [
    `compare: a=${report.a} b=${report.b}`,
    `tasks: ${report.tasks}`,
    `pairs: ${report.pairs}`,
    ...report.warnings.map(warning => `warning: ${warning}`),
    ...summaryLines(report),
    ...worseningLines(report),
    ...report.rows.flatMap(row => rowLines(row)),
  ];
  return `${lines.join('\n')}\n`;
}

function mdHref(fromDir: string, root: string, repoPath: string): string {
  const abs = join(root, repoPath);
  let rel = relative(fromDir, abs).split(sep).join('/');
  if (rel === '') rel = '.';
  else if (!rel.startsWith('.')) rel = `./${rel}`;
  return rel;
}

function mdLink(label: string, fromDir: string, root: string, repoPath: string | null): string | undefined {
  if (!repoPath) return undefined;
  return `[${label}](${mdHref(fromDir, root, repoPath)})`;
}

export function renderCompareMarkdown(report: CompareReport, fromDir: string, root: string): string {
  const lines = [
    `# Compare ${report.a} → ${report.b}`,
    '',
    `tasks: ${report.tasks}`,
    `pairs: ${report.pairs}`,
    '',
    '## Summary',
    '',
    ...summaryLines(report),
    '',
    '## Worsening',
    '',
  ];
  const worsening = report.rows.filter(row => worsenedMetrics(row).length > 0 || row.verify.outcome === 'worsened');
  if (worsening.length === 0) lines.push('- none', '');
  for (const row of worsening) {
    const parts = worsenedMetrics(row).map(metric => `${metric.name} ${formatSigned(metric.delta)}`);
    if (row.verify.outcome === 'worsened') parts.push('verify');
    lines.push(`### ${row.task_id} attempt ${row.attempt} run ${row.run_id}`, '');
    lines.push(`- ${parts.join(', ')}`);
    lines.push(`- flags: ${row.flags.length > 0 ? row.flags.join(' ') : 'none'}`);
    const runLink = mdLink(row.run_id, fromDir, root, row.run_dir);
    if (runLink) lines.push(`- run: ${runLink}`);
    for (const side of ['a', 'b'] as const) {
      const evidence = row.evidence[side];
      for (const kind of ['events', 'result', 'metrics', 'verify'] as const) {
        const link = mdLink(`${side} ${kind}`, fromDir, root, evidence[kind]);
        if (link) lines.push(`- ${link}`);
      }
    }
    if (!row.evidence.a.verify && !row.evidence.b.verify) lines.push('- verify: unavailable');
    lines.push('');
  }
  lines.push('## Rows', '', ...report.rows.flatMap(row => rowLines(row)), '');
  return `${lines.join('\n')}\n`;
}

export function feedbackCardId(taskId: string, runId: string, attempt: number): string {
  const raw = `fb-${taskId}-${runId}-a${attempt}`;
  const cleaned = raw.replace(/[^a-zA-Z0-9_-]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
  return /^[a-zA-Z0-9]/.test(cleaned) ? cleaned : `fb-${cleaned}`;
}

export function feedbackSourceRef(runId: string): string {
  return `runs/${runId}`;
}

export function isSameFeedback(card: TaskCard, runId: string, attempt: number): boolean {
  const ref = feedbackSourceRef(runId);
  const mark = `attempt ${attempt}`;
  const sources = card.private.sources.some(source => source.ref === ref && (source.note ?? '').includes(mark));
  const provenance = card.private.provenance;
  const fromProvenance = Boolean(
    provenance && 'ref' in provenance && provenance.ref === ref && (provenance.note ?? '').includes(mark),
  );
  return sources || fromProvenance;
}

function verifyDoc(verify: VerifyState): Record<string, unknown> {
  if (verify.status === 'path') return { status: 'path', path: verify.path };
  if (verify.status === 'none') return verify.reason ? { status: 'none', reason: verify.reason } : { status: 'none' };
  return { status: verify.status, reason: verify.reason };
}

function feedbackRecord(kind: 'intervention' | 'rework', runId: string, attempt: number, metric: FeedbackMetric): Record<string, unknown> {
  const turn = `feedback-${kind}-a${attempt}`;
  const id = kind === 'intervention' ? 'fb-intervention' : 'fb-rework';
  const record: Record<string, unknown> = {
    id,
    summary: `with-skill increased ${metric.name} by ${metric.delta}`,
    source: feedbackSourceRef(runId),
    turn,
    kind,
    confirmation: 'confirmed',
    excerpt: `source run ${runId} attempt ${attempt}: ${metric.name} ${metric.a} → ${metric.b}`,
    origin: 'manual',
    provenance: {
      kind: 'file',
      ref: feedbackSourceRef(runId),
      note: `source run ${runId} attempt ${attempt}`,
    },
  };
  if (kind === 'rework') record.round = turn;
  return record;
}

/** Replayable copy of the source card, plus a confirmed mark when intervention or rework worsened. */
export function renderFeedbackCard(input: {
  source: TaskCard;
  runId: string;
  attempt: number;
  sideB: string;
  worsened: readonly FeedbackMetric[];
  verifyWorsened: boolean;
}): { id: string; yaml: string } {
  if (input.worsened.length === 0 && !input.verifyWorsened) {
    throw new Error('compare feedback: no worsened metric');
  }
  const id = feedbackCardId(input.source.id, input.runId, input.attempt);
  const note = [
    `source run ${input.runId} attempt ${input.attempt} task ${input.source.id}`,
    `compared against ${input.sideB}`,
    input.worsened.length > 0 ? `worsened ${input.worsened.map(metric => metric.name).join(', ')}` : undefined,
    input.verifyWorsened ? 'verify worsened' : undefined,
  ].filter((part): part is string => Boolean(part)).join('; ');
  const requirement = typeof input.source.public.requirement === 'string' ? input.source.public.requirement : undefined;
  const repo = input.source.public.repo;
  const repoValue = repo && typeof repo === 'object' && 'id' in repo && 'host' in repo ? repo : undefined;
  const base = typeof input.source.public.base_commit === 'string' ? input.source.public.base_commit : undefined;
  const replayable = Boolean(requirement && repoValue && base);
  const intervention = input.worsened.find(metric => metric.name === 'interventions');
  const rework = input.worsened.find(metric => metric.name === 'rework_rounds');
  const priv: Record<string, unknown> = {
    provenance: { kind: 'file', ref: feedbackSourceRef(input.runId), note },
    pr: { status: 'N/A', reason: 'Feedback card from a compare run; no pull request.' },
    merge: { status: 'N/A', reason: 'Feedback card from a compare run; nothing was merged.' },
    interventions: intervention
      ? { records: [feedbackRecord('intervention', input.runId, input.attempt, intervention)] }
      : { status: 'unknown' },
    rework: rework
      ? { records: [feedbackRecord('rework', input.runId, input.attempt, rework)] }
      : { status: 'unknown' },
    verify: verifyDoc(input.source.private.verify),
    sources: [{ kind: 'file', ref: feedbackSourceRef(input.runId), note }],
  };
  if (!replayable) {
    priv.not_replay_ready = { reason: 'Source card is missing a concrete requirement, repo, or base commit.' };
  }
  const doc: Record<string, unknown> = {
    schema_version: SCHEMA_VERSION,
    id,
    status: replayable ? 'replay-ready' : 'draft',
    public: replayable
      ? { requirement, repo: { id: repoValue!.id, host: repoValue!.host }, base_commit: base }
      : {
          requirement: requirement ?? { status: 'unknown', reason: 'Source requirement was not concrete.' },
          repo: repoValue ?? { status: 'unknown', reason: 'Source repo was not concrete.' },
          base_commit: base ?? { status: 'unknown', reason: 'Source base commit was not concrete.' },
        },
    private: priv,
  };
  const yaml = stringify(doc, { lineWidth: 0, defaultStringType: 'QUOTE_DOUBLE', defaultKeyType: 'PLAIN' });
  const text = yaml.endsWith('\n') ? yaml : `${yaml}\n`;
  const parsed = parseTaskCardYaml(text, { expectedId: id });
  if (!parsed.ok) {
    throw new Error(parsed.errors.map(issue => `${issue.field}: ${issue.message}`).join('\n'));
  }
  return { id, yaml: text };
}
