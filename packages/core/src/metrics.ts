import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { ScoreResult } from './evidence.ts';
import { SCORE_RESULTS } from './evidence.ts';

/**
 * Per-variant metrics. Counts are supplied by the skill track from one pass
 * over the Cursor Agent event stream. This module does not count events again.
 *
 * `intervention_request` and `actual_human_intervention` stay separate.
 * Historical comparison uses the actual column only.
 * Missing measurements are `unknown`. Evidence completeness is `N/A` when the
 * score is unavailable. Neither missing value is stored as 0.
 */
export const METRICS_SCHEMA_VERSION = 1 as const;

export type MeasuredNumber = number | 'unknown';
export type BaselineSide = number | 'unknown' | 'none';
export type EvidenceCompleteness = number | 'N/A';

export interface MetricComparison {
  replay: MeasuredNumber;
  /** `none` is a confirmed empty baseline. It is not the number 0. */
  baseline: BaselineSide;
  /** `none` counts as 0 only inside this subtraction. `unknown` stays `unknown`. */
  delta: MeasuredNumber;
}

export interface VariantMetrics {
  schema_version: typeof METRICS_SCHEMA_VERSION;
  task_id: string;
  run_id: string;
  variant: string;
  attempt: number;
  intervention_request: MeasuredNumber;
  actual_human_intervention: MeasuredNumber;
  rework_rounds: MeasuredNumber;
  evidence_completeness: EvidenceCompleteness;
  score: ScoreResult;
  duration_ms: MeasuredNumber;
  input_tokens: MeasuredNumber;
  output_tokens: MeasuredNumber;
  cost: MeasuredNumber;
  baseline: {
    interventions: BaselineSide;
    rework_rounds: BaselineSide;
  };
  comparison: {
    interventions: MetricComparison;
    rework_rounds: MetricComparison;
  };
}

export interface MetricFeatureRow {
  evidence?: readonly unknown[];
}

const VARIANT_ORDER = ['without', 'with-skill'];

export function evidenceCompleteness(score: ScoreResult, features: readonly MetricFeatureRow[]): EvidenceCompleteness {
  if (score === 'unavailable' || score === 'interrupted') return 'N/A';
  if (features.length === 0) return 0;
  return features.filter(feature => Array.isArray(feature.evidence) && feature.evidence.length > 0).length / features.length;
}

export function compareMetric(replay: MeasuredNumber, baseline: BaselineSide): MetricComparison {
  if (replay === 'unknown' || baseline === 'unknown') {
    return { replay, baseline, delta: 'unknown' };
  }
  const base = baseline === 'none' ? 0 : baseline;
  return { replay, baseline, delta: replay - base };
}

export function buildVariantMetrics(input: {
  taskId: string;
  runId: string;
  variant: string;
  attempt: number;
  interventionRequest: MeasuredNumber;
  actualHumanIntervention: MeasuredNumber;
  reworkRounds: MeasuredNumber;
  score: ScoreResult;
  features: readonly MetricFeatureRow[];
  durationMs: MeasuredNumber;
  inputTokens: MeasuredNumber;
  outputTokens: MeasuredNumber;
  cost: MeasuredNumber;
  baselineInterventions: BaselineSide;
  baselineReworkRounds: BaselineSide;
}): VariantMetrics {
  return {
    schema_version: METRICS_SCHEMA_VERSION,
    task_id: input.taskId,
    run_id: input.runId,
    variant: input.variant,
    attempt: input.attempt,
    intervention_request: input.interventionRequest,
    actual_human_intervention: input.actualHumanIntervention,
    rework_rounds: input.reworkRounds,
    evidence_completeness: evidenceCompleteness(input.score, input.features),
    score: input.score,
    duration_ms: input.durationMs,
    input_tokens: input.inputTokens,
    output_tokens: input.outputTokens,
    cost: input.cost,
    baseline: {
      interventions: input.baselineInterventions,
      rework_rounds: input.baselineReworkRounds,
    },
    comparison: {
      interventions: compareMetric(input.actualHumanIntervention, input.baselineInterventions),
      rework_rounds: compareMetric(input.reworkRounds, input.baselineReworkRounds),
    },
  };
}

export function formatMetricValue(value: MeasuredNumber | BaselineSide | EvidenceCompleteness): string {
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return 'unknown';
    return String(value);
  }
  return value;
}

export function formatVariantMetrics(metrics: VariantMetrics): string[] {
  return [
    `variant ${metrics.variant} attempt ${metrics.attempt}:`,
    `  intervention_request: ${formatMetricValue(metrics.intervention_request)}`,
    `  actual_human_intervention: ${formatMetricValue(metrics.actual_human_intervention)}`,
    `  rework_rounds: ${formatMetricValue(metrics.rework_rounds)}`,
    `  duration_ms: ${formatMetricValue(metrics.duration_ms)}`,
    `  input_tokens: ${formatMetricValue(metrics.input_tokens)}`,
    `  output_tokens: ${formatMetricValue(metrics.output_tokens)}`,
    `  cost: ${formatMetricValue(metrics.cost)}`,
    `  score: ${metrics.score}`,
    `  evidence_completeness: ${formatMetricValue(metrics.evidence_completeness)}`,
    `  baseline.interventions: ${formatMetricValue(metrics.baseline.interventions)}`,
    `  baseline.rework_rounds: ${formatMetricValue(metrics.baseline.rework_rounds)}`,
    `  comparison.interventions: replay ${formatMetricValue(metrics.comparison.interventions.replay)} baseline ${formatMetricValue(metrics.comparison.interventions.baseline)} delta ${formatMetricValue(metrics.comparison.interventions.delta)}`,
    `  comparison.rework_rounds: replay ${formatMetricValue(metrics.comparison.rework_rounds.replay)} baseline ${formatMetricValue(metrics.comparison.rework_rounds.baseline)} delta ${formatMetricValue(metrics.comparison.rework_rounds.delta)}`,
  ];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function measured(value: unknown): MeasuredNumber | undefined {
  if (value === 'unknown') return 'unknown';
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  return undefined;
}

function baselineSide(value: unknown): BaselineSide | undefined {
  if (value === 'unknown' || value === 'none') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  return undefined;
}

function completeness(value: unknown): EvidenceCompleteness | undefined {
  if (value === 'N/A') return 'N/A';
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  return undefined;
}

function comparison(value: unknown): MetricComparison | undefined {
  if (!isRecord(value)) return undefined;
  const replay = measured(value.replay);
  const baseline = baselineSide(value.baseline);
  const delta = measured(value.delta);
  if (replay === undefined || baseline === undefined || delta === undefined) return undefined;
  return { replay, baseline, delta };
}

/** Read a metrics file without filling gaps as 0. Invalid files return undefined. */
export function parseVariantMetrics(value: unknown): VariantMetrics | undefined {
  if (!isRecord(value)) return undefined;
  if (value.schema_version !== METRICS_SCHEMA_VERSION) return undefined;
  if (typeof value.task_id !== 'string' || typeof value.run_id !== 'string' || typeof value.variant !== 'string') return undefined;
  if (typeof value.attempt !== 'number' || !Number.isInteger(value.attempt) || value.attempt < 1) return undefined;
  const interventionRequest = measured(value.intervention_request);
  const actual = measured(value.actual_human_intervention);
  const rework = measured(value.rework_rounds);
  const duration = measured(value.duration_ms);
  const inputTokens = measured(value.input_tokens);
  const outputTokens = measured(value.output_tokens);
  const cost = measured(value.cost);
  const evidence = completeness(value.evidence_completeness);
  if (
    interventionRequest === undefined || actual === undefined || rework === undefined || duration === undefined
    || inputTokens === undefined || outputTokens === undefined || cost === undefined || evidence === undefined
  ) return undefined;
  if (typeof value.score !== 'string' || !(SCORE_RESULTS as readonly string[]).includes(value.score)) return undefined;
  if (!isRecord(value.baseline) || !isRecord(value.comparison)) return undefined;
  const baselineInterventions = baselineSide(value.baseline.interventions);
  const baselineRework = baselineSide(value.baseline.rework_rounds);
  const interventions = comparison(value.comparison.interventions);
  const reworkComparison = comparison(value.comparison.rework_rounds);
  if (baselineInterventions === undefined || baselineRework === undefined || !interventions || !reworkComparison) return undefined;
  return {
    schema_version: METRICS_SCHEMA_VERSION,
    task_id: value.task_id,
    run_id: value.run_id,
    variant: value.variant,
    attempt: value.attempt,
    intervention_request: interventionRequest,
    actual_human_intervention: actual,
    rework_rounds: rework,
    evidence_completeness: evidence,
    score: value.score as ScoreResult,
    duration_ms: duration,
    input_tokens: inputTokens,
    output_tokens: outputTokens,
    cost,
    baseline: { interventions: baselineInterventions, rework_rounds: baselineRework },
    comparison: { interventions, rework_rounds: reworkComparison },
  };
}

function variantNames(variantsDir: string): string[] {
  return readdirSync(variantsDir).filter(name => {
    const dir = join(variantsDir, name);
    return statSync(dir).isDirectory();
  }).sort((a, b) => {
    const ai = VARIANT_ORDER.indexOf(a);
    const bi = VARIANT_ORDER.indexOf(b);
    if (ai !== -1 || bi !== -1) return (ai === -1 ? 99 : ai) - (bi === -1 ? 99 : bi);
    return a.localeCompare(b);
  });
}

function metricPaths(variantDir: string): string[] {
  const attemptsDir = join(variantDir, 'attempts');
  if (existsSync(attemptsDir) && statSync(attemptsDir).isDirectory()) {
    return readdirSync(attemptsDir)
      .filter(name => /^[1-9][0-9]*$/.test(name))
      .sort((a, b) => Number(a) - Number(b))
      .map(name => join(attemptsDir, name, 'metrics.json'))
      .filter(file => existsSync(file));
  }
  const file = join(variantDir, 'metrics.json');
  return existsSync(file) ? [file] : [];
}

/**
 * Print metrics that were already written. Does not read the event stream
 * and does not add the request column to the actual column.
 */
export function describeRunMetrics(runDir: string, runId: string): string[] {
  const lines = [`run: ${runId}`];
  const variantsDir = join(runDir, 'variants');
  if (!existsSync(variantsDir) || !statSync(variantsDir).isDirectory()) {
    lines.push('metrics: not collected');
    return lines;
  }
  const files = variantNames(variantsDir).flatMap(name => metricPaths(join(variantsDir, name)));
  if (files.length === 0) {
    lines.push('metrics: not collected');
    return lines;
  }
  for (const file of files) {
    let parsed: VariantMetrics | undefined;
    try {
      parsed = parseVariantMetrics(JSON.parse(readFileSync(file, 'utf8')));
    } catch {
      parsed = undefined;
    }
    if (!parsed) {
      lines.push(`metrics: invalid ${file}`);
      continue;
    }
    lines.push(...formatVariantMetrics(parsed));
  }
  return lines;
}
