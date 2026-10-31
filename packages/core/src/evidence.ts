import { createHash } from 'node:crypto';
import { existsSync, statSync } from 'node:fs';
import { isAbsolute, join, relative, resolve } from 'node:path';

export interface RunRef {
  id: string;
  dir: string;
}

/**
 * Reserved evidence hook. Run creation still writes nothing.
 * Verify scores are a separate command; they are not emitted from this hook.
 */
export interface EvidenceHook {
  readonly name: string;
  onRunCreated?(run: RunRef): void;
}

export function reservedEvidenceHooks(): readonly EvidenceHook[] {
  return [];
}

/** Scores a pinned verify skill is allowed to produce. Nothing else is a score. */
export const SCORE_RESULTS = ['pass', 'feature fail', 'verifier error', 'unavailable', 'interrupted'] as const;
export type ScoreResult = (typeof SCORE_RESULTS)[number];

export const VERIFY_PHASES = ['launch', 'doctor', 'drive', 'evidence', 'cleanup'] as const;
export type VerifyPhase = (typeof VERIFY_PHASES)[number];

/**
 * Exit a verify phase uses when it cannot score this tree.
 * Any other non-zero exit is a verifier error, not a feature failure.
 */
export const VERIFY_UNAVAILABLE_EXIT = 75;

export type EvidenceMode = 'hard' | 'diagnostic';

export interface EvidenceRef {
  artifact: string;
  field: string;
  root: 'workspace' | 'evidence';
}

export interface FeatureEvidence {
  id: string;
  mode: EvidenceMode;
  reason: string;
  passed: boolean;
  actual?: unknown;
  evidence: EvidenceRef[];
}

export interface FeatureSpec {
  id: string;
  mode: EvidenceMode;
  reason: string;
}

export interface FeaturesMap {
  version: string;
  features: FeatureSpec[];
}

export interface PinFile {
  id: string;
  version: string;
}

export interface VerifyPin extends PinFile {
  digest: string;
}

export interface PhaseRecord {
  phase: VerifyPhase;
  status: 'ok' | 'unavailable' | 'error' | 'interrupted' | 'skipped';
  exit_code: number | null;
}

export interface VerifyResult {
  name: string;
  score: ScoreResult;
  score_reason: string;
  pin: VerifyPin | null;
  features: FeatureEvidence[];
  phases: PhaseRecord[];
}

export type SkillEvidence =
  | { ok: true; features: FeatureEvidence[] }
  | { ok: false; kind: 'missing_result' | 'invalid_result'; reason: string };

const IDENTIFIER = /^[a-zA-Z0-9][a-zA-Z0-9_-]*$/;

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}

function assertJsonValue(value: unknown, field: string, ancestors = new Set<unknown>()): void {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return;
  if (typeof value === 'number' && Number.isFinite(value)) return;
  if (typeof value !== 'object' || ancestors.has(value)) throw new Error(`${field}: expected finite JSON value`);
  if (!record(value) && !Array.isArray(value)) throw new Error(`${field}: expected plain JSON`);
  ancestors.add(value);
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) assertJsonValue(value[index], `${field}[${index}]`, ancestors);
  } else {
    for (const [key, item] of Object.entries(value)) assertJsonValue(item, `${field}.${key}`, ancestors);
  }
  ancestors.delete(value);
}

function unknownKeys(value: Record<string, unknown>, allowed: readonly string[]): string | undefined {
  return Object.keys(value).find(key => !allowed.includes(key));
}

/**
 * Content digest of a pinned verify bundle. The same bytes produce the same
 * digest, so every variant in one comparison can be checked against one pin.
 */
export function pinnedDigest(entries: readonly { path: string; bytes: Uint8Array }[]): string {
  const hash = createHash('sha256');
  const sorted = [...entries].sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0);
  for (const entry of sorted) {
    hash.update(entry.path);
    hash.update('\0');
    hash.update(entry.bytes);
    hash.update('\0');
  }
  return hash.digest('hex');
}

export function parsePinFile(value: unknown): { ok: true; pin: PinFile } | { ok: false; reason: string } {
  if (!record(value)) return { ok: false, reason: 'pin.json: expected an object' };
  const extra = unknownKeys(value, ['id', 'version']);
  if (extra) return { ok: false, reason: `pin.json: unknown field ${extra}` };
  if (typeof value.id !== 'string' || !IDENTIFIER.test(value.id)) return { ok: false, reason: 'pin.json: id must be an identifier' };
  if (typeof value.version !== 'string' || !value.version.trim() || value.version !== value.version.trim()) {
    return { ok: false, reason: 'pin.json: version must be a non-empty string' };
  }
  return { ok: true, pin: { id: value.id, version: value.version } };
}

export function parseFeaturesMap(value: unknown): { ok: true; map: FeaturesMap } | { ok: false; reason: string } {
  if (!record(value)) return { ok: false, reason: 'features-map.json: expected an object' };
  const extra = unknownKeys(value, ['version', 'features']);
  if (extra) return { ok: false, reason: `features-map.json: unknown field ${extra}` };
  if (typeof value.version !== 'string' || !value.version.trim()) return { ok: false, reason: 'features-map.json: version must be a non-empty string' };
  if (!Array.isArray(value.features) || value.features.length === 0) return { ok: false, reason: 'features-map.json: features must be a non-empty list' };
  const seen = new Set<string>();
  const features: FeatureSpec[] = [];
  for (let index = 0; index < value.features.length; index += 1) {
    const raw = value.features[index];
    const field = `features-map.json features[${index}]`;
    if (!record(raw)) return { ok: false, reason: `${field}: expected an object` };
    const featureExtra = unknownKeys(raw, ['id', 'mode', 'reason']);
    if (featureExtra) return { ok: false, reason: `${field}: unknown field ${featureExtra}` };
    if (typeof raw.id !== 'string' || !IDENTIFIER.test(raw.id) || seen.has(raw.id)) {
      return { ok: false, reason: `${field}: requires a unique identifier id` };
    }
    seen.add(raw.id);
    if (raw.mode !== 'hard' && raw.mode !== 'diagnostic') return { ok: false, reason: `${field}: mode must be hard or diagnostic` };
    if (typeof raw.reason !== 'string' || !raw.reason.trim()) return { ok: false, reason: `${field}: reason must be non-empty` };
    features.push({ id: raw.id, mode: raw.mode, reason: raw.reason });
  }
  return { ok: true, map: { version: value.version, features } };
}

function isInside(parent: string, child: string): boolean {
  const rel = relative(resolve(parent), resolve(child));
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

function locateArtifact(artifact: string, workspace: string, evidenceDir: string): EvidenceRef['root'] | undefined {
  if (!artifact || artifact.includes('\0') || isAbsolute(artifact) || artifact.split(/[\\/]/).includes('..')) return undefined;
  const inWorkspace = join(workspace, artifact);
  if (isInside(workspace, inWorkspace) && existsSync(inWorkspace) && statSync(inWorkspace).isFile()) return 'workspace';
  const inEvidence = join(evidenceDir, artifact);
  if (isInside(evidenceDir, inEvidence) && existsSync(inEvidence) && statSync(inEvidence).isFile()) return 'evidence';
  return undefined;
}

/**
 * Accept the verify skill's own feature rows. Modes come from the pinned
 * features-map, not from the skill row. A missing or invalid result is not a
 * feature failure.
 */
export function checkSkillEvidence(raw: unknown, map: FeaturesMap, workspace: string, evidenceDir: string): SkillEvidence {
  let jsonError: string | undefined;
  try {
    assertJsonValue(raw, 'skill result');
  } catch (error) {
    jsonError = (error as Error).message;
  }
  if (jsonError) return { ok: false, kind: 'invalid_result', reason: jsonError };
  if (!record(raw) || !Array.isArray(raw.features)) {
    return { ok: false, kind: 'missing_result', reason: 'skill result is missing features' };
  }
  const extra = unknownKeys(raw, ['features']);
  if (extra) return { ok: false, kind: 'invalid_result', reason: `skill result: unknown field ${extra}` };
  const rows = raw.features;
  if (rows.length !== map.features.length) {
    return {
      ok: false,
      kind: rows.length < map.features.length ? 'missing_result' : 'invalid_result',
      reason: 'skill result feature rows do not match the pinned features-map',
    };
  }
  const seen = new Set<string>();
  for (const row of rows) {
    if (!record(row) || typeof row.id !== 'string' || seen.has(row.id) || !map.features.some(feature => feature.id === row.id)) {
      return { ok: false, kind: 'invalid_result', reason: 'skill result has a duplicate or unknown feature id' };
    }
    seen.add(row.id);
  }
  const features: FeatureEvidence[] = [];
  for (const spec of map.features) {
    const row = rows.find(item => record(item) && item.id === spec.id);
    if (!row || !record(row)) return { ok: false, kind: 'missing_result', reason: `feature ${spec.id} is missing` };
    const rowExtra = unknownKeys(row, ['id', 'passed', 'actual', 'evidence']);
    if (rowExtra) return { ok: false, kind: 'invalid_result', reason: `feature ${spec.id}: unknown field ${rowExtra}` };
    if (typeof row.passed !== 'boolean') return { ok: false, kind: 'invalid_result', reason: `feature ${spec.id}: passed must be boolean` };
    if (!Array.isArray(row.evidence) || row.evidence.length === 0) {
      return { ok: false, kind: 'missing_result', reason: `feature ${spec.id}: evidence is missing` };
    }
    const evidence: EvidenceRef[] = [];
    for (let index = 0; index < row.evidence.length; index += 1) {
      const ref = row.evidence[index];
      if (!record(ref) || unknownKeys(ref, ['artifact', 'field'])) {
        return { ok: false, kind: 'invalid_result', reason: `feature ${spec.id}: evidence[${index}] is invalid` };
      }
      if (typeof ref.artifact !== 'string' || typeof ref.field !== 'string' || !ref.field.trim()) {
        return { ok: false, kind: 'invalid_result', reason: `feature ${spec.id}: evidence artifact and field are required` };
      }
      const root = locateArtifact(ref.artifact, workspace, evidenceDir);
      if (!root) return { ok: false, kind: 'invalid_result', reason: `feature ${spec.id}: evidence artifact is not on disk` };
      evidence.push({ artifact: ref.artifact, field: ref.field, root });
    }
    const feature: FeatureEvidence = { id: spec.id, mode: spec.mode, reason: spec.reason, passed: row.passed, evidence };
    if ('actual' in row) feature.actual = row.actual;
    features.push(feature);
  }
  return { ok: true, features };
}

/**
 * Only hard rows gate the verdict. Diagnostic rows are evidence and cannot
 * turn a pass into a feature fail. No hard row is a verifier error, not a pass.
 */
export function verdictFromFeatures(features: readonly FeatureEvidence[]): 'pass' | 'feature fail' | 'verifier error' {
  const hard = features.filter(feature => feature.mode === 'hard');
  if (hard.length === 0) return 'verifier error';
  return hard.every(feature => feature.passed) ? 'pass' : 'feature fail';
}

/** Invalid skill output becomes verifier error. It is never pass or feature fail. */
export function scoreFromCheckedEvidence(checked: SkillEvidence): { score: 'pass' | 'feature fail' | 'verifier error'; reason: string; features: FeatureEvidence[] } {
  if (!checked.ok) return { score: 'verifier error', reason: checked.reason, features: [] };
  const score = verdictFromFeatures(checked.features);
  if (score === 'verifier error') return { score, reason: 'pinned features-map has no hard feature', features: checked.features };
  if (score === 'feature fail') {
    const failed = checked.features.filter(feature => feature.mode === 'hard' && !feature.passed).map(feature => feature.id);
    return { score, reason: `hard feature failed: ${failed.join(', ')}`, features: checked.features };
  }
  return { score, reason: 'hard features passed', features: checked.features };
}

/**
 * Process exit for one score. `unavailable` is 0 so a card with no verify still
 * succeeds; `feature fail` is the only 1. Verifier errors and interrupts are
 * neither 0 nor 1.
 */
export function scoreExitCode(score: ScoreResult): number {
  switch (score) {
    case 'pass':
    case 'unavailable':
      return 0;
    case 'feature fail':
      return 1;
    case 'verifier error':
      return 2;
    case 'interrupted':
      return 3;
  }
}

/** Variant scores only. A verifier error stays an error when another variant failed a feature. */
export function aggregateScoreExit(scores: readonly ScoreResult[]): number {
  if (scores.some(score => score === 'interrupted')) return scoreExitCode('interrupted');
  if (scores.some(score => score === 'verifier error')) return scoreExitCode('verifier error');
  if (scores.some(score => score === 'feature fail')) return scoreExitCode('feature fail');
  return 0;
}
