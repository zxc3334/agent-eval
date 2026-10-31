import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { identifier } from './config.ts';
import { canonicalSha, SHA_FORMAT_MESSAGE } from './sha.ts';

export const SCHEMA_VERSION = 1;

/** Keys copied into the agent-facing payload. Everything else on a card stays out. */
export const AGENT_INPUT_ALLOWLIST = ['task_id', 'requirement', 'repo', 'base_commit'] as const;

export const PUBLIC_FIELD_ROLES = {
  requirement: 'required',
  repo: 'required',
  base_commit: 'required',
} as const;

export const PRIVATE_FIELD_ROLES = {
  provenance: 'optional',
  pr: 'optional',
  merge: 'optional',
  interventions: 'optional',
  rework: 'optional',
  candidates: 'optional',
  verify: 'optional',
  sources: 'optional',
  not_replay_ready: 'optional',
} as const;

const ROOT_KEYS = ['schema_version', 'id', 'status', 'public', 'private'] as const;
const PUBLIC_KEYS = ['requirement', 'repo', 'base_commit'] as const;
const PRIVATE_KEYS = ['provenance', 'pr', 'merge', 'interventions', 'rework', 'candidates', 'verify', 'sources', 'not_replay_ready'] as const;
const FORBIDDEN_KEYS = new Set(['gold', 'expected', 'answer', 'oracle']);
const REPO_HOSTS = ['origin', 'github', 'other'] as const;
const SOURCE_KINDS = ['pr', 'issue', 'chat', 'file'] as const;
const REQUIRED_GAPS = ['todo', 'unknown', 'unavailable'] as const;
const OPTIONAL_GAPS = ['none', 'todo', 'unknown', 'N/A', 'unavailable'] as const;

export type RepoHost = (typeof REPO_HOSTS)[number];
export type SourceKind = (typeof SOURCE_KINDS)[number];
export type RequiredGapStatus = (typeof REQUIRED_GAPS)[number];
export type OptionalGapStatus = (typeof OPTIONAL_GAPS)[number];

export interface RequiredGap {
  status: RequiredGapStatus;
  reason: string;
}

export type OptionalGap =
  | { status: 'none' | 'unknown'; reason?: string }
  | { status: 'todo' | 'unavailable' | 'N/A'; reason: string };

export interface RepoValue {
  id: string;
  host: RepoHost;
}

export interface SourceRef {
  kind: SourceKind;
  ref: string;
  note?: string;
}

export interface PullRequestValue {
  number: number;
  url?: string;
}

export interface DiffStats {
  files: number;
  additions: number;
  deletions: number;
}

export interface MergeValue {
  sha: string;
  diff_stats?: DiffStats;
}

export const MARK_KINDS = ['intervention', 'rework'] as const;
export type MarkKind = (typeof MARK_KINDS)[number];
export const MARK_ORIGINS = ['fixup', 'review', 'chat', 'pr-review', 'manual'] as const;
export type MarkOrigin = (typeof MARK_ORIGINS)[number];
export const MARK_BOUNDARIES = ['submit', 'verify', 'human-confirm', 'later-run'] as const;
export type MarkBoundary = (typeof MARK_BOUNDARIES)[number];

export interface InterventionRecord {
  id: string;
  summary: string;
  source?: string;
  /** Stable id within `source`. Dedupe key is source + turn. */
  turn?: string;
  kind?: MarkKind;
  /** Present on rows written by `task mark`. Lists under interventions/rework are confirmed either way. */
  confirmation?: 'confirmed';
  excerpt?: string;
  origin?: MarkOrigin;
  boundary?: MarkBoundary;
  /** Rework group. Records that share `round` are one rework round. */
  round?: string;
  provenance?: SourceRef;
}

/** Unconfirmed row. R3 fixup/review candidates live here and do not count until `task mark` confirms them. */
export interface MarkCandidate {
  id: string;
  summary: string;
  source: string;
  turn: string;
  excerpt: string;
  origin: MarkOrigin;
  provenance: SourceRef;
  suggested?: MarkKind;
  boundary?: MarkBoundary;
}

export type Interventions =
  | { status: 'none' | 'unknown'; reason?: string }
  | { status: 'todo' | 'unavailable' | 'N/A'; reason: string }
  | { records: InterventionRecord[] };

export type VerifyState =
  | { status: 'none'; reason?: string }
  | { status: 'todo' | 'unavailable'; reason: string }
  | { status: 'path'; path: string };

export interface TaskCard {
  schema_version: typeof SCHEMA_VERSION;
  id: string;
  status: 'draft' | 'replay-ready';
  public: {
    requirement: string | RequiredGap;
    repo: RepoValue | RequiredGap;
    base_commit: string | RequiredGap;
  };
  private: {
    provenance?: SourceRef | OptionalGap;
    pr?: PullRequestValue | OptionalGap;
    merge?: MergeValue | OptionalGap;
    interventions: Interventions;
    rework?: Interventions;
    candidates?: MarkCandidate[];
    verify: VerifyState;
    sources: SourceRef[];
    not_replay_ready?: { reason: string };
  };
}

export interface AgentInput {
  task_id: string;
  requirement: string;
  repo: { id: string; host: RepoHost };
  base_commit: string;
}

export interface CardIssue {
  field: string;
  message: string;
}

export type CardResult = { ok: true; card: TaskCard } | { ok: false; errors: CardIssue[] };

export class TaskCardError extends Error {
  readonly errors: readonly CardIssue[];

  constructor(errors: readonly CardIssue[]) {
    super(errors.map(issue => `${issue.field}: ${issue.message}`).join('\n'));
    this.name = 'TaskCardError';
    this.errors = errors;
  }
}

type Read<T> = { kind: 'value'; value: T } | { kind: 'gap'; gap: RequiredGap } | { kind: 'bad' } | { kind: 'missing' };

const YAML_PARSE = { schema: 'core' as const, uniqueKeys: true, strict: true, maxAliasCount: 10 };

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function rejectUnknown(obj: Record<string, unknown>, allowed: readonly string[], field: string, errors: CardIssue[]): void {
  for (const key of Object.keys(obj)) {
    const path = field ? `${field}.${key}` : key;
    if (FORBIDDEN_KEYS.has(key)) {
      errors.push({ field: path, message: 'gold and expected output are out of scope for a task card' });
    } else if (!allowed.includes(key)) {
      errors.push({ field: path, message: 'unknown field' });
    }
  }
}

function readIdentifier(value: unknown, field: string, errors: CardIssue[]): string | undefined {
  if (typeof value !== 'string') {
    errors.push({ field, message: 'expected a string identifier' });
    return undefined;
  }
  try {
    return identifier(value, field);
  } catch {
    errors.push({ field, message: `invalid identifier ${JSON.stringify(value)}` });
    return undefined;
  }
}

function nonempty(value: unknown, field: string, errors: CardIssue[]): string | undefined {
  if (typeof value !== 'string' || !value.trim()) {
    errors.push({ field, message: 'expected a non-empty string' });
    return undefined;
  }
  return value;
}

function readReason(obj: Record<string, unknown>, field: string, errors: CardIssue[], required: boolean): string | undefined {
  if (!('reason' in obj)) {
    if (required) errors.push({ field: `${field}.reason`, message: 'a gap on a required field needs a reason' });
    return undefined;
  }
  const reason = nonempty(obj.reason, `${field}.reason`, errors);
  return reason?.trim();
}

function optionalReason(obj: Record<string, unknown>, field: string, errors: CardIssue[], status: OptionalGapStatus): string | undefined {
  const required = status === 'N/A' || status === 'todo' || status === 'unavailable';
  if (!('reason' in obj)) {
    if (required) errors.push({ field: `${field}.reason`, message: `${status} requires a reason` });
    return undefined;
  }
  return nonempty(obj.reason, `${field}.reason`, errors)?.trim();
}

function readRequiredGap(obj: Record<string, unknown>, field: string, errors: CardIssue[]): Read<never> {
  const status = obj.status;
  if (status === 'none' || status === 'N/A') {
    errors.push({ field: `${field}.status`, message: `${status} is not allowed on a required field` });
    return { kind: 'bad' };
  }
  if (status !== 'todo' && status !== 'unknown' && status !== 'unavailable') {
    errors.push({ field: `${field}.status`, message: 'expected todo, unknown, or unavailable' });
    return { kind: 'bad' };
  }
  const before = errors.length;
  const reason = readReason(obj, field, errors, true);
  if (errors.length !== before || !reason) return { kind: 'bad' };
  return { kind: 'gap', gap: { status, reason } };
}

function readShaValue(value: unknown, field: string, errors: CardIssue[]): string | undefined {
  if (typeof value === 'number' || typeof value === 'bigint') {
    errors.push({ field, message: 'quote the SHA so it is not parsed as a number' });
    return undefined;
  }
  if (typeof value !== 'string' || !canonicalSha(value)) {
    errors.push({ field, message: SHA_FORMAT_MESSAGE });
    return undefined;
  }
  return canonicalSha(value);
}

function readRequirement(value: unknown, errors: CardIssue[]): Read<string> {
  const field = 'public.requirement';
  if (typeof value === 'string') {
    if (!value.trim()) {
      errors.push({ field, message: 'expected non-empty requirement text' });
      return { kind: 'bad' };
    }
    return { kind: 'value', value };
  }
  if (!isObject(value)) {
    errors.push({ field, message: 'expected requirement text or a gap status' });
    return { kind: 'bad' };
  }
  const before = errors.length;
  rejectUnknown(value, ['text', 'status', 'reason'], field, errors);
  if ('status' in value && 'text' in value) {
    errors.push({ field, message: 'use either text or a gap status, not both' });
    return { kind: 'bad' };
  }
  if ('status' in value) return readRequiredGap(value, field, errors);
  if (typeof value.text !== 'string' || !value.text.trim()) {
    errors.push({ field: `${field}.text`, message: 'expected non-empty requirement text' });
    return { kind: 'bad' };
  }
  if (errors.length !== before) return { kind: 'bad' };
  return { kind: 'value', value: value.text };
}

function readRepo(value: unknown, errors: CardIssue[]): Read<RepoValue> {
  const field = 'public.repo';
  if (!isObject(value)) {
    errors.push({ field, message: 'expected a repo id and host, or a gap status' });
    return { kind: 'bad' };
  }
  const before = errors.length;
  rejectUnknown(value, ['id', 'host', 'status', 'reason'], field, errors);
  const gapKeys = 'status' in value || 'reason' in value;
  const valueKeys = 'id' in value || 'host' in value;
  if (gapKeys && valueKeys) {
    errors.push({ field, message: 'use either id and host, or a gap status, not both' });
    return { kind: 'bad' };
  }
  if (gapKeys) return readRequiredGap(value, field, errors);
  const id = typeof value.id === 'string' ? value.id : undefined;
  if (!id || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(id)) {
    errors.push({ field: `${field}.id`, message: 'expected owner/name' });
  }
  if (typeof value.host !== 'string' || !REPO_HOSTS.includes(value.host as RepoHost)) {
    errors.push({ field: `${field}.host`, message: 'expected origin, github, or other' });
  }
  if (errors.length !== before || typeof value.id !== 'string' || typeof value.host !== 'string') return { kind: 'bad' };
  return { kind: 'value', value: { id: value.id, host: value.host as RepoHost } };
}

function readBase(value: unknown, errors: CardIssue[]): Read<string> {
  const field = 'public.base_commit';
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'bigint') {
    const sha = readShaValue(value, field, errors);
    return sha ? { kind: 'value', value: sha } : { kind: 'bad' };
  }
  if (!isObject(value)) {
    errors.push({ field, message: 'expected a quoted full SHA or a gap status' });
    return { kind: 'bad' };
  }
  const before = errors.length;
  rejectUnknown(value, ['sha', 'status', 'reason'], field, errors);
  if ('status' in value && 'sha' in value) {
    errors.push({ field, message: 'use either sha or a gap status, not both' });
    return { kind: 'bad' };
  }
  if ('status' in value || ('reason' in value && !('sha' in value))) return readRequiredGap(value, field, errors);
  const sha = readShaValue(value.sha, `${field}.sha`, errors);
  if (errors.length !== before || !sha) return { kind: 'bad' };
  return { kind: 'value', value: sha };
}

function concrete<T>(read: Read<T>, field: string, status: 'draft' | 'replay-ready', errors: CardIssue[]): T | RequiredGap | undefined {
  if (read.kind === 'missing') {
    errors.push({ field, message: 'required field is missing' });
    return undefined;
  }
  if (read.kind === 'bad') return undefined;
  if (read.kind === 'gap') {
    if (status === 'replay-ready') {
      errors.push({ field: 'status', message: `replay-ready requires a concrete ${field}` });
      return undefined;
    }
    return read.gap;
  }
  return read.value;
}

function readSource(value: unknown, field: string, errors: CardIssue[]): SourceRef | undefined {
  if (!isObject(value)) {
    errors.push({ field, message: 'expected kind and ref' });
    return undefined;
  }
  const before = errors.length;
  rejectUnknown(value, ['kind', 'ref', 'note'], field, errors);
  if (typeof value.kind !== 'string' || !SOURCE_KINDS.includes(value.kind as SourceKind)) {
    errors.push({ field: `${field}.kind`, message: 'expected pr, issue, chat, or file' });
  }
  const ref = nonempty(value.ref, `${field}.ref`, errors);
  let note: string | undefined;
  if ('note' in value) note = nonempty(value.note, `${field}.note`, errors)?.trim();
  if (errors.length !== before || typeof value.kind !== 'string' || !ref) return undefined;
  const source: SourceRef = { kind: value.kind as SourceKind, ref };
  if (note) source.note = note;
  return source;
}

function readOptionalGap(obj: Record<string, unknown>, field: string, errors: CardIssue[]): OptionalGap | undefined {
  const status = obj.status;
  if (typeof status !== 'string' || !OPTIONAL_GAPS.includes(status as OptionalGapStatus)) {
    errors.push({ field: `${field}.status`, message: 'expected none, todo, unknown, N/A, or unavailable' });
    return undefined;
  }
  const gapStatus = status as OptionalGapStatus;
  const before = errors.length;
  const reason = optionalReason(obj, field, errors, gapStatus);
  if (errors.length !== before) return undefined;
  if (gapStatus === 'todo' || gapStatus === 'unavailable' || gapStatus === 'N/A') {
    if (!reason) return undefined;
    return { status: gapStatus, reason };
  }
  return reason ? { status: gapStatus, reason } : { status: gapStatus };
}

function readProvenance(value: unknown, errors: CardIssue[]): SourceRef | OptionalGap | undefined {
  const field = 'private.provenance';
  if (!isObject(value)) {
    errors.push({ field, message: 'expected a source or a gap status' });
    return undefined;
  }
  rejectUnknown(value, ['kind', 'ref', 'note', 'status', 'reason'], field, errors);
  const gapKeys = 'status' in value || 'reason' in value;
  const valueKeys = 'kind' in value || 'ref' in value || 'note' in value;
  if (gapKeys && valueKeys) {
    errors.push({ field, message: 'use either a source or a gap status, not both' });
    return undefined;
  }
  if (gapKeys) return readOptionalGap(value, field, errors);
  return readSource(value, field, errors);
}

function readPr(value: unknown, errors: CardIssue[]): PullRequestValue | OptionalGap | undefined {
  const field = 'private.pr';
  if (typeof value === 'number') {
    errors.push({ field, message: 'expected a pull request number under number, or a gap status' });
    return undefined;
  }
  if (!isObject(value)) {
    errors.push({ field, message: 'expected a pull request or a gap status' });
    return undefined;
  }
  rejectUnknown(value, ['number', 'url', 'status', 'reason'], field, errors);
  const gapKeys = 'status' in value || 'reason' in value;
  const valueKeys = 'number' in value || 'url' in value;
  if (gapKeys && valueKeys) {
    errors.push({ field, message: 'use either a pull request or a gap status, not both' });
    return undefined;
  }
  if (gapKeys) return readOptionalGap(value, field, errors);
  if (typeof value.number !== 'number' || !Number.isInteger(value.number) || value.number <= 0) {
    errors.push({ field: `${field}.number`, message: 'expected a positive integer' });
    return undefined;
  }
  const pr: PullRequestValue = { number: value.number };
  if ('url' in value) {
    const url = nonempty(value.url, `${field}.url`, errors);
    if (!url) return undefined;
    pr.url = url;
  }
  return pr;
}

function readDiffStats(value: unknown, errors: CardIssue[]): DiffStats | undefined {
  const field = 'private.merge.diff_stats';
  if (!isObject(value)) {
    errors.push({ field, message: 'expected files, additions, and deletions' });
    return undefined;
  }
  const before = errors.length;
  rejectUnknown(value, ['files', 'additions', 'deletions'], field, errors);
  const stats = {} as DiffStats;
  for (const key of ['files', 'additions', 'deletions'] as const) {
    const item = value[key];
    if (typeof item !== 'number' || !Number.isInteger(item) || item < 0) {
      errors.push({ field: `${field}.${key}`, message: 'expected a non-negative integer' });
    } else {
      stats[key] = item;
    }
  }
  if (errors.length !== before) return undefined;
  return stats;
}

function readMerge(value: unknown, errors: CardIssue[]): MergeValue | OptionalGap | undefined {
  const field = 'private.merge';
  if (!isObject(value)) {
    errors.push({ field, message: 'expected a merge sha or a gap status' });
    return undefined;
  }
  rejectUnknown(value, ['sha', 'diff_stats', 'status', 'reason'], field, errors);
  const gapKeys = 'status' in value || 'reason' in value;
  const valueKeys = 'sha' in value || 'diff_stats' in value;
  if (gapKeys && valueKeys) {
    errors.push({ field, message: 'use either a merge sha or a gap status, not both' });
    return undefined;
  }
  if (gapKeys) return readOptionalGap(value, field, errors);
  const sha = readShaValue(value.sha, `${field}.sha`, errors);
  if (!sha) return undefined;
  const merge: MergeValue = { sha };
  if ('diff_stats' in value) {
    const stats = readDiffStats(value.diff_stats, errors);
    if (!stats) return undefined;
    merge.diff_stats = stats;
  }
  return merge;
}

const RECORD_KEYS = ['id', 'summary', 'source', 'turn', 'kind', 'confirmation', 'excerpt', 'origin', 'boundary', 'round', 'provenance'] as const;

function readPlain(value: unknown, field: string, errors: CardIssue[]): string | undefined {
  return nonempty(value, field, errors)?.trim();
}

function readRecord(item: unknown, path: string, listKind: MarkKind, errors: CardIssue[]): InterventionRecord | undefined {
  if (!isObject(item)) {
    errors.push({ field: path, message: 'expected id and summary' });
    return undefined;
  }
  const before = errors.length;
  rejectUnknown(item, RECORD_KEYS, path, errors);
  const id = readIdentifier(item.id, `${path}.id`, errors);
  const summary = readPlain(item.summary, `${path}.summary`, errors);
  const record: InterventionRecord = { id: id ?? '', summary: summary ?? '' };
  if ('source' in item) {
    const source = readPlain(item.source, `${path}.source`, errors);
    if (source) record.source = source;
  }
  if ('turn' in item) {
    const turn = readPlain(item.turn, `${path}.turn`, errors);
    if (turn) record.turn = turn;
  }
  if ('kind' in item) {
    if (item.kind !== listKind) errors.push({ field: `${path}.kind`, message: `expected ${listKind}` });
    else record.kind = listKind;
  }
  if ('confirmation' in item) {
    if (item.confirmation !== 'confirmed') errors.push({ field: `${path}.confirmation`, message: 'records are confirmed events; unconfirmed rows belong in candidates' });
    else record.confirmation = 'confirmed';
  }
  if ('excerpt' in item) {
    const excerpt = readPlain(item.excerpt, `${path}.excerpt`, errors);
    if (excerpt) record.excerpt = excerpt;
  }
  if ('origin' in item) {
    if (typeof item.origin !== 'string' || !MARK_ORIGINS.includes(item.origin as MarkOrigin)) {
      errors.push({ field: `${path}.origin`, message: 'expected fixup, review, chat, pr-review, or manual' });
    } else {
      record.origin = item.origin as MarkOrigin;
    }
  }
  if ('boundary' in item) {
    if (typeof item.boundary !== 'string' || !MARK_BOUNDARIES.includes(item.boundary as MarkBoundary)) {
      errors.push({ field: `${path}.boundary`, message: 'expected submit, verify, human-confirm, or later-run' });
    } else {
      record.boundary = item.boundary as MarkBoundary;
    }
  }
  if ('round' in item) {
    const round = readPlain(item.round, `${path}.round`, errors);
    if (round) record.round = round;
  }
  if ('provenance' in item) {
    const provenance = readSource(item.provenance, `${path}.provenance`, errors);
    if (provenance) record.provenance = provenance;
  }
  if (errors.length !== before || !id || !summary) return undefined;
  record.id = id;
  record.summary = summary;
  return record;
}

function readRecords(value: unknown, field: string, listKind: MarkKind, errors: CardIssue[]): InterventionRecord[] | undefined {
  if (!Array.isArray(value) || value.length === 0) {
    errors.push({ field, message: 'expected at least one confirmed record' });
    return undefined;
  }
  const records: InterventionRecord[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const record = readRecord(value[index], `${field}[${index}]`, listKind, errors);
    if (record) records.push(record);
  }
  return records.length === value.length ? records : undefined;
}

function readInterventions(value: unknown, field: string, listKind: MarkKind, errors: CardIssue[]): Interventions | undefined {
  if (typeof value === 'number') {
    errors.push({ field, message: 'expected a status or a list of records, not a count' });
    return undefined;
  }
  if (!isObject(value)) {
    errors.push({ field, message: 'expected a status or a list of records' });
    return undefined;
  }
  if ('count' in value) {
    errors.push({
      field: `${field}.count`,
      message: 'do not store a count; missing history is status unknown, not 0',
    });
    return undefined;
  }
  rejectUnknown(value, ['status', 'reason', 'records'], field, errors);
  if ('records' in value && ('status' in value || 'reason' in value)) {
    errors.push({ field, message: 'use either records or a gap status, not both' });
    return undefined;
  }
  if ('records' in value) {
    const records = readRecords(value.records, `${field}.records`, listKind, errors);
    return records ? { records } : undefined;
  }
  if (!('status' in value)) {
    errors.push({ field, message: 'expected a status or a list of records' });
    return undefined;
  }
  return readOptionalGap(value, field, errors);
}

function readCandidate(item: unknown, path: string, errors: CardIssue[]): MarkCandidate | undefined {
  if (!isObject(item)) {
    errors.push({ field: path, message: 'expected a candidate' });
    return undefined;
  }
  const before = errors.length;
  rejectUnknown(item, ['id', 'summary', 'source', 'turn', 'excerpt', 'origin', 'provenance', 'suggested', 'boundary'], path, errors);
  const id = readIdentifier(item.id, `${path}.id`, errors);
  const summary = readPlain(item.summary, `${path}.summary`, errors);
  const source = readPlain(item.source, `${path}.source`, errors);
  const turn = readPlain(item.turn, `${path}.turn`, errors);
  const excerpt = readPlain(item.excerpt, `${path}.excerpt`, errors);
  if (typeof item.origin !== 'string' || !MARK_ORIGINS.includes(item.origin as MarkOrigin)) {
    errors.push({ field: `${path}.origin`, message: 'expected fixup, review, chat, pr-review, or manual' });
  }
  const provenance = readSource(item.provenance, `${path}.provenance`, errors);
  let suggested: MarkKind | undefined;
  if ('suggested' in item) {
    if (item.suggested !== 'intervention' && item.suggested !== 'rework') {
      errors.push({ field: `${path}.suggested`, message: 'expected intervention or rework' });
    } else {
      suggested = item.suggested;
    }
  }
  let boundary: MarkBoundary | undefined;
  if ('boundary' in item) {
    if (typeof item.boundary !== 'string' || !MARK_BOUNDARIES.includes(item.boundary as MarkBoundary)) {
      errors.push({ field: `${path}.boundary`, message: 'expected submit, verify, human-confirm, or later-run' });
    } else {
      boundary = item.boundary as MarkBoundary;
    }
  }
  if (errors.length !== before || !id || !summary || !source || !turn || !excerpt || !provenance || typeof item.origin !== 'string') return undefined;
  const candidate: MarkCandidate = {
    id,
    summary,
    source,
    turn,
    excerpt,
    origin: item.origin as MarkOrigin,
    provenance,
  };
  if (suggested) candidate.suggested = suggested;
  if (boundary) candidate.boundary = boundary;
  return candidate;
}

function readCandidates(value: unknown, errors: CardIssue[]): MarkCandidate[] | undefined {
  const field = 'private.candidates';
  if (!Array.isArray(value)) {
    errors.push({ field, message: 'expected a list of candidates' });
    return undefined;
  }
  const candidates: MarkCandidate[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const candidate = readCandidate(value[index], `${field}[${index}]`, errors);
    if (candidate) candidates.push(candidate);
  }
  return candidates.length === value.length ? candidates : undefined;
}

function readVerify(value: unknown, errors: CardIssue[]): VerifyState | undefined {
  const field = 'private.verify';
  if (value === 'none') return { status: 'none' };
  if (value === 'todo' || value === 'unavailable') {
    errors.push({ field, message: `${value} requires a reason` });
    return undefined;
  }
  if (!isObject(value)) {
    errors.push({ field, message: 'expected none, todo, unavailable, or path' });
    return undefined;
  }
  rejectUnknown(value, ['status', 'reason', 'path'], field, errors);
  const status = value.status;
  if (status === 'path') {
    if ('reason' in value) errors.push({ field: `${field}.reason`, message: 'unknown field' });
    if (typeof value.path !== 'string' || !value.path.trim() || value.path.includes('\0') || value.path.split(/[\\/]/).includes('..')) {
      errors.push({ field: `${field}.path`, message: 'expected a path without parent segments' });
      return undefined;
    }
    if ('reason' in value) return undefined;
    return { status: 'path', path: value.path };
  }
  if (status === 'none') {
    const reason = 'reason' in value ? nonempty(value.reason, `${field}.reason`, errors)?.trim() : undefined;
    if ('reason' in value && !reason) return undefined;
    return reason ? { status: 'none', reason } : { status: 'none' };
  }
  if (status === 'todo' || status === 'unavailable') {
    if ('path' in value) {
      errors.push({ field: `${field}.path`, message: 'path is only used when status is path' });
      return undefined;
    }
    const reason = optionalReason(value, field, errors, status);
    if (!reason) return undefined;
    return { status, reason };
  }
  errors.push({ field: `${field}.status`, message: 'expected none, todo, unavailable, or path' });
  return undefined;
}

function readSources(value: unknown, errors: CardIssue[]): SourceRef[] | undefined {
  const field = 'private.sources';
  if (!Array.isArray(value)) {
    errors.push({ field, message: 'expected a list of sources' });
    return undefined;
  }
  const sources: SourceRef[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const source = readSource(value[index], `${field}[${index}]`, errors);
    if (source) sources.push(source);
  }
  return sources.length === value.length ? sources : undefined;
}

export function validateTaskCard(value: unknown, options: { expectedId?: string } = {}): CardResult {
  const errors: CardIssue[] = [];
  if (!isObject(value)) {
    return { ok: false, errors: [{ field: 'card', message: 'expected a YAML mapping' }] };
  }
  rejectUnknown(value, ROOT_KEYS, '', errors);
  if (value.schema_version !== SCHEMA_VERSION) {
    errors.push({ field: 'schema_version', message: 'expected 1' });
  }
  const id = readIdentifier(value.id, 'id', errors);
  if (id && options.expectedId && id !== options.expectedId) {
    errors.push({ field: 'id', message: `directory name ${JSON.stringify(options.expectedId)} does not match card id ${JSON.stringify(id)}` });
  }
  const status = value.status === 'draft' || value.status === 'replay-ready' ? value.status : undefined;
  if (!status) errors.push({ field: 'status', message: 'expected draft or replay-ready' });

  const cardStatus = status ?? 'draft';
  let requirement: string | RequiredGap | undefined;
  let repo: RepoValue | RequiredGap | undefined;
  let base: string | RequiredGap | undefined;
  if (!isObject(value.public)) {
    errors.push({ field: 'public', message: 'required section is missing' });
  } else {
    rejectUnknown(value.public, PUBLIC_KEYS, 'public', errors);
    requirement = concrete(
      'requirement' in value.public ? readRequirement(value.public.requirement, errors) : { kind: 'missing' },
      'public.requirement',
      cardStatus,
      errors,
    );
    repo = concrete(
      'repo' in value.public ? readRepo(value.public.repo, errors) : { kind: 'missing' },
      'public.repo',
      cardStatus,
      errors,
    );
    base = concrete(
      'base_commit' in value.public ? readBase(value.public.base_commit, errors) : { kind: 'missing' },
      'public.base_commit',
      cardStatus,
      errors,
    );
  }

  const privateSection: TaskCard['private'] = {
    interventions: { status: 'unknown' },
    verify: { status: 'none' },
    sources: [],
  };
  if (value.private !== undefined) {
    if (!isObject(value.private)) {
      errors.push({ field: 'private', message: 'expected a mapping' });
    } else {
      rejectUnknown(value.private, PRIVATE_KEYS, 'private', errors);
      if ('provenance' in value.private) {
        const provenance = readProvenance(value.private.provenance, errors);
        if (provenance) privateSection.provenance = provenance;
      }
      if ('pr' in value.private) {
        const pr = readPr(value.private.pr, errors);
        if (pr) privateSection.pr = pr;
      }
      if ('merge' in value.private) {
        const merge = readMerge(value.private.merge, errors);
        if (merge) privateSection.merge = merge;
      }
      if ('interventions' in value.private) {
        const interventions = readInterventions(value.private.interventions, 'private.interventions', 'intervention', errors);
        if (interventions) privateSection.interventions = interventions;
      }
      if ('rework' in value.private) {
        const rework = readInterventions(value.private.rework, 'private.rework', 'rework', errors);
        if (rework) privateSection.rework = rework;
      }
      if ('candidates' in value.private) {
        const candidates = readCandidates(value.private.candidates, errors);
        if (candidates) privateSection.candidates = candidates;
      }
      if ('verify' in value.private) {
        const verify = readVerify(value.private.verify, errors);
        if (verify) privateSection.verify = verify;
      }
      if ('sources' in value.private) {
        const sources = readSources(value.private.sources, errors);
        if (sources) privateSection.sources = sources;
      }
      if ('not_replay_ready' in value.private) {
        const blocker = value.private.not_replay_ready;
        if (!isObject(blocker)) {
          errors.push({ field: 'private.not_replay_ready', message: 'expected a reason' });
        } else {
          rejectUnknown(blocker, ['reason'], 'private.not_replay_ready', errors);
          const reason = nonempty(blocker.reason, 'private.not_replay_ready.reason', errors);
          if (reason) privateSection.not_replay_ready = { reason: reason.trim() };
        }
      }
    }
  }

  if (status === 'draft' && !privateSection.not_replay_ready) {
    errors.push({
      field: 'private.not_replay_ready.reason',
      message: 'draft cards must say why they are not replay-ready',
    });
  }
  if (status === 'replay-ready' && privateSection.not_replay_ready) {
    errors.push({ field: 'private.not_replay_ready', message: 'replay-ready cards cannot include not_replay_ready' });
  }

  if (errors.length > 0 || !id || !status || requirement === undefined || repo === undefined || base === undefined) {
    return { ok: false, errors };
  }
  const card: TaskCard = {
    schema_version: SCHEMA_VERSION,
    id,
    status,
    public: { requirement, repo, base_commit: base },
    private: privateSection,
  };
  return { ok: true, card };
}

export function parseTaskCardYaml(text: string, options: { expectedId?: string } = {}): CardResult {
  let value: unknown;
  try {
    value = parseYaml(text, YAML_PARSE);
  } catch (error) {
    return { ok: false, errors: [{ field: 'card.yaml', message: `YAML parse error: ${(error as Error).message}` }] };
  }
  return validateTaskCard(value, options);
}

export function parseTaskCardJson(text: string, options: { expectedId?: string } = {}): CardResult {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (error) {
    return { ok: false, errors: [{ field: 'card.json', message: `JSON parse error: ${(error as Error).message}` }] };
  }
  return validateTaskCard(value, options);
}

export function loadTaskCard(taskDir: string): TaskCard {
  const id = basename(taskDir);
  const file = join(taskDir, 'card.yaml');
  if (!existsSync(file)) {
    throw new TaskCardError([{ field: 'card.yaml', message: `missing ${file}` }]);
  }
  const result = parseTaskCardYaml(readFileSync(file, 'utf8'), { expectedId: id });
  if (!result.ok) throw new TaskCardError(result.errors);
  return result.card;
}

export function loadTaskCards(tasksDir: string): TaskCard[] {
  return readdirSync(tasksDir, { withFileTypes: true })
    .filter(entry => entry.isDirectory() && existsSync(join(tasksDir, entry.name, 'card.yaml')))
    .map(entry => entry.name)
    .sort()
    .map(name => loadTaskCard(join(tasksDir, name)));
}

/** Optional interchange export. `card.yaml` stays the primary format. */
export function exportCardJson(card: TaskCard): string {
  return `${JSON.stringify(card, null, 2)}\n`;
}

function isRepoValue(value: RepoValue | RequiredGap): value is RepoValue {
  return !('status' in value);
}

/**
 * Allowlist projection. Reads `task_id`, `requirement`, `repo.id`, `repo.host`,
 * and `base_commit` only. Merge, diff stats, interventions, verify, and any
 * other keys on `raw` are ignored.
 */
export function projectAgentInput(raw: Readonly<Record<string, unknown>>): AgentInput {
  const repo = isObject(raw.repo) ? raw.repo : undefined;
  const host = repo?.host;
  if (typeof raw.task_id !== 'string' || !raw.task_id.trim()) {
    throw new TaskCardError([{ field: 'task_id', message: 'expected a non-empty string' }]);
  }
  if (typeof raw.requirement !== 'string' || !raw.requirement.trim()) {
    throw new TaskCardError([{ field: 'requirement', message: 'expected non-empty requirement text' }]);
  }
  if (!repo || typeof repo.id !== 'string' || typeof host !== 'string' || !REPO_HOSTS.includes(host as RepoHost)) {
    throw new TaskCardError([{ field: 'repo', message: 'expected id and host' }]);
  }
  const sha = typeof raw.base_commit === 'string' ? canonicalSha(raw.base_commit) : undefined;
  if (!sha) throw new TaskCardError([{ field: 'base_commit', message: SHA_FORMAT_MESSAGE }]);
  return {
    task_id: raw.task_id,
    requirement: raw.requirement,
    repo: { id: repo.id, host: host as RepoHost },
    base_commit: sha,
  };
}

/** Build the replay payload from a replay-ready card. Draft cards throw. */
export function buildAgentInput(card: TaskCard): AgentInput {
  if (card.status !== 'replay-ready') {
    const reason = card.private.not_replay_ready?.reason;
    throw new TaskCardError([{
      field: 'status',
      message: reason ? `draft cards are not replay-ready: ${reason}` : 'draft cards are not replay-ready',
    }]);
  }
  if (typeof card.public.requirement !== 'string' || typeof card.public.base_commit !== 'string' || !isRepoValue(card.public.repo)) {
    throw new TaskCardError([{ field: 'public', message: 'replay-ready card is missing a concrete requirement, repo, or base commit' }]);
  }
  return projectAgentInput({
    task_id: card.id,
    requirement: card.public.requirement,
    repo: { id: card.public.repo.id, host: card.public.repo.host },
    base_commit: card.public.base_commit,
  });
}

export function serializeAgentInput(card: TaskCard): string {
  return `${JSON.stringify(buildAgentInput(card), null, 2)}\n`;
}
