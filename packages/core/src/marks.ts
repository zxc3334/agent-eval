import { createHash } from 'node:crypto';
import { relative, resolve, sep } from 'node:path';
import type {
  InterventionRecord,
  Interventions,
  MarkBoundary,
  MarkCandidate,
  MarkKind,
  MarkOrigin,
  SourceKind,
  SourceRef,
  TaskCard,
} from './task-card.ts';

/**
 * Count vocabulary shared with R8.
 *
 * intervention: one confirmed human-intervention event.
 * rework round: a related set of edits until the next submit/verify boundary.
 * Without verify, that boundary may be a human confirmation or a later run.
 * Missing history is `unknown`, never a confirmed 0.
 * Unconfirmed candidates, including R3 fixup/review rows, do not count.
 * Dedupe key is source + turn. Reading the same export again is a no-op.
 */
export const MARK_UNITS = {
  intervention: 'one confirmed human-intervention event',
  rework_round: 'a related set of edits until the next submit/verify boundary; without verify, that boundary may be a human confirmation or a later run',
  missing: 'unknown',
} as const;

export type BaselineCount = number | 'unknown';

export interface SharedBaseline {
  interventions: BaselineCount;
  rework_rounds: BaselineCount;
}

export interface ResolvedProvenance {
  dedupe_key: string;
  source: string;
  turn: string;
  kind: SourceKind;
  ref: string;
  note?: string;
}

const KIND_WORDS: Readonly<Record<string, MarkKind>> = {
  插手: 'intervention',
  intervention: 'intervention',
  返工: 'rework',
  rework: 'rework',
};

const HUMAN_ROLES = new Set(['user', 'human', 'reviewer']);

export class MarkPlanError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MarkPlanError';
  }
}

export function dedupeKey(source: string, turn: string): string {
  return `${source.trim()}\n${turn.trim()}`;
}

export function parseMarkKind(input: string): MarkKind | undefined {
  return KIND_WORDS[input.trim().toLowerCase()] ?? KIND_WORDS[input.trim()];
}

export function countRounds(records: readonly { id: string; round?: string }[]): number {
  return new Set(records.map(record => record.round ?? record.id)).size;
}

export function sharedBaseline(card: Pick<TaskCard, 'private'>): SharedBaseline {
  return {
    interventions: numericBaseline(card.private.interventions, 'events'),
    rework_rounds: numericBaseline(card.private.rework, 'rounds'),
  };
}

/** Display label. Confirmed-empty is `none`. Missing history is `unknown`. Neither label is `0`. */
export function formatBaseline(value: Interventions | undefined, mode: 'events' | 'rounds'): string {
  if (!value || ('records' in value && value.records.length === 0)) return 'unknown';
  if ('records' in value) return String(mode === 'events' ? value.records.length : countRounds(value.records));
  return value.status;
}

/** Same labels as {@link formatBaseline}, for a raw YAML value that may be invalid. */
export function baselineLabelFromRaw(value: unknown, mode: 'events' | 'rounds'): string {
  if (value === undefined) return 'unknown';
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return 'invalid';
  if ('count' in value) return 'invalid';
  if ('records' in value) {
    if (!Array.isArray(value.records) || value.records.length === 0) return 'invalid';
    if (mode === 'events') return String(value.records.length);
    return String(countRounds(value.records.map((item, index) => {
      if (typeof item !== 'object' || item === null) return { id: String(index) };
      const round = 'round' in item && typeof item.round === 'string' ? item.round : undefined;
      const id = 'id' in item && typeof item.id === 'string' ? item.id : String(index);
      return round ? { id, round } : { id };
    })));
  }
  if ('status' in value && typeof value.status === 'string' && value.status.trim()) {
    if (value.status === 'none' || value.status === 'unknown' || value.status === 'todo' || value.status === 'unavailable' || value.status === 'N/A') {
      return value.status;
    }
  }
  return 'invalid';
}

function numericBaseline(value: Interventions | undefined, mode: 'events' | 'rounds'): BaselineCount {
  if (!value || !('records' in value) || value.records.length === 0) {
    if (value && !('records' in value) && value.status === 'none') return 0;
    return 'unknown';
  }
  return mode === 'events' ? value.records.length : countRounds(value.records);
}

export function resolveProvenance(record: {
  source?: string;
  turn?: string;
  provenance?: SourceRef;
}): ResolvedProvenance | undefined {
  if (!record.source || !record.turn) return undefined;
  const resolved: ResolvedProvenance = {
    dedupe_key: dedupeKey(record.source, record.turn),
    source: record.source,
    turn: record.turn,
    kind: record.provenance?.kind ?? 'file',
    ref: record.provenance?.ref ?? record.source,
  };
  if (record.provenance?.note) resolved.note = record.provenance.note;
  return resolved;
}

export function normalizeMarkSource(input: string, root: string): string {
  const trimmed = input.trim();
  if (/^[a-z][a-z0-9+.-]*:/i.test(trimmed)) return trimmed;
  const absolute = resolve(trimmed);
  const rel = relative(root, absolute);
  if (rel && !rel.startsWith('..') && !rel.startsWith(`..${sep}`)) return rel.split(sep).join('/');
  return absolute.split(sep).join('/');
}

export function markId(source: string, turn: string, used: ReadonlySet<string>): string {
  if (/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(turn) && !used.has(turn)) return turn;
  let id = `m${createHash('sha256').update(dedupeKey(source, turn)).digest('hex').slice(0, 10)}`;
  while (used.has(id)) id = `${id}x`;
  return id;
}

export function noteTurn(kind: MarkKind, note: string): string {
  return `n${createHash('sha256').update(`${kind}\0${note.trim()}`).digest('hex').slice(0, 12)}`;
}

function oneLine(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

function clip(text: string, max: number): string {
  const line = oneLine(text);
  return line.length <= max ? line : `${line.slice(0, max - 1)}…`;
}

export function summarize(text: string): string {
  return clip(text, 80);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stringField(obj: Record<string, unknown>, keys: readonly string[]): string | undefined {
  for (const key of keys) {
    const value = obj[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return undefined;
}

function roleOf(item: Record<string, unknown>): string | undefined {
  const role = stringField(item, ['role']);
  if (role) return role.toLowerCase();
  const type = stringField(item, ['type']);
  if (!type) return undefined;
  const upper = type.toUpperCase();
  if (upper === 'USER_INPUT' || upper === 'USER') return 'user';
  if (upper === 'ASSISTANT') return 'assistant';
  return type.toLowerCase();
}

function turnOf(item: Record<string, unknown>, index: number): string {
  const raw = item.id ?? item.turn ?? item.step_index ?? item.index;
  if (typeof raw === 'string' && raw.trim()) return raw.trim();
  if (typeof raw === 'number' && Number.isInteger(raw) && raw >= 0) return `t${String(raw).padStart(2, '0')}`;
  return `t${String(index + 1).padStart(2, '0')}`;
}

function boundaryOf(value: unknown, field: string): MarkBoundary | undefined {
  if (value === undefined) return undefined;
  if (value === 'submit' || value === 'verify' || value === 'human-confirm' || value === 'later-run') return value;
  throw new MarkPlanError(`${field}: expected submit, verify, human-confirm, or later-run`);
}

function suggestedOf(value: unknown, field: string): MarkKind | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string') throw new MarkPlanError(`${field}: expected intervention or rework`);
  const kind = parseMarkKind(value);
  if (!kind) throw new MarkPlanError(`${field}: expected intervention or rework`);
  return kind;
}

function originOf(value: unknown, field: string): MarkOrigin {
  if (value === 'fixup' || value === 'review' || value === 'chat' || value === 'pr-review' || value === 'manual') return value;
  throw new MarkPlanError(`${field}: expected fixup, review, chat, pr-review, or manual`);
}

interface DraftCandidate {
  turn: string;
  source: string;
  excerpt: string;
  origin: MarkOrigin;
  provenance: SourceRef;
  boundary?: MarkBoundary;
  suggested?: MarkKind;
}

function takeCandidate(draft: DraftCandidate, used: Set<string>, seen: Set<string>): MarkCandidate {
  const key = dedupeKey(draft.source, draft.turn);
  if (seen.has(key)) throw new MarkPlanError(`mark file: duplicate turn ${draft.turn}`);
  seen.add(key);
  const id = markId(draft.source, draft.turn, used);
  used.add(id);
  const excerpt = clip(draft.excerpt, 500);
  const candidate: MarkCandidate = {
    id,
    summary: summarize(excerpt),
    source: draft.source,
    turn: draft.turn,
    excerpt,
    origin: draft.origin,
    provenance: draft.provenance,
  };
  if (draft.boundary) candidate.boundary = draft.boundary;
  if (draft.suggested) candidate.suggested = draft.suggested;
  return candidate;
}

function fromTurns(list: unknown, source: string, provenanceKind: SourceKind): MarkCandidate[] {
  if (!Array.isArray(list)) throw new MarkPlanError('mark file: expected a list of turns');
  const used = new Set<string>();
  const seen = new Set<string>();
  const out: MarkCandidate[] = [];
  list.forEach((item, index) => {
    if (!isObject(item)) throw new MarkPlanError(`mark file: turn ${index + 1} is not an object`);
    const role = roleOf(item);
    if (!role || !HUMAN_ROLES.has(role)) return;
    const text = stringField(item, ['text', 'content', 'body', 'message']);
    if (!text) return;
    const turnSource = stringField(item, ['source']) ?? source;
    out.push(takeCandidate({
      turn: turnOf(item, index),
      source: turnSource,
      excerpt: text,
      origin: provenanceKind === 'pr' ? 'pr-review' : 'chat',
      provenance: { kind: provenanceKind, ref: source },
      boundary: boundaryOf(item.boundary, `turn ${index + 1} boundary`),
      suggested: suggestedOf(item.suggested, `turn ${index + 1} suggested`),
    }, used, seen));
  });
  return out;
}

function fromReview(obj: Record<string, unknown>, source: string): MarkCandidate[] {
  const url = stringField(obj, ['pull_request', 'url', 'pr']) ?? source;
  const reviews = Array.isArray(obj.reviews) ? obj.reviews : [];
  const comments = Array.isArray(obj.comments) ? obj.comments : [];
  const used = new Set<string>();
  const seen = new Set<string>();
  const out: MarkCandidate[] = [];
  const rows = [
    ...reviews.map((item, index) => ({ item, index, label: 'review' })),
    ...comments.map((item, index) => ({ item, index, label: 'comment' })),
  ];
  for (const row of rows) {
    if (!isObject(row.item)) throw new MarkPlanError(`mark file: ${row.label} ${row.index + 1} is not an object`);
    const text = stringField(row.item, ['body', 'text', 'content']);
    if (!text) continue;
    const turn = turnOf(row.item, row.index);
    out.push(takeCandidate({
      turn,
      source: url,
      excerpt: text,
      origin: 'pr-review',
      provenance: { kind: 'pr', ref: url },
      boundary: boundaryOf(row.item.boundary, `${row.label} ${row.index + 1} boundary`),
    }, used, seen));
  }
  return out;
}

function provenanceOf(value: unknown, fallback: SourceRef, field: string): SourceRef {
  if (value === undefined) return fallback;
  if (!isObject(value)) throw new MarkPlanError(`${field}: expected kind and ref`);
  const kind = value.kind;
  if (kind !== 'pr' && kind !== 'issue' && kind !== 'chat' && kind !== 'file') {
    throw new MarkPlanError(`${field}.kind: expected pr, issue, chat, or file`);
  }
  const ref = stringField(value, ['ref']);
  if (!ref) throw new MarkPlanError(`${field}.ref: expected a non-empty string`);
  const provenance: SourceRef = { kind, ref };
  const note = stringField(value, ['note']);
  if (note) provenance.note = note;
  return provenance;
}

function fromItems(list: unknown, source: string): MarkCandidate[] {
  if (!Array.isArray(list)) throw new MarkPlanError('mark file: expected a list of candidates');
  const used = new Set<string>();
  const seen = new Set<string>();
  return list.map((item, index) => {
    if (!isObject(item)) throw new MarkPlanError(`mark file: candidate ${index + 1} is not an object`);
    const field = `candidate ${index + 1}`;
    const excerpt = stringField(item, ['excerpt', 'summary', 'body', 'text']);
    if (!excerpt) throw new MarkPlanError(`${field}: expected an excerpt`);
    const turn = stringField(item, ['turn', 'id']) ?? turnOf(item, index);
    const itemSource = stringField(item, ['source']) ?? source;
    return takeCandidate({
      turn,
      source: itemSource,
      excerpt,
      origin: originOf(item.origin, `${field}.origin`),
      provenance: provenanceOf(item.provenance, { kind: 'file', ref: itemSource }, `${field}.provenance`),
      boundary: boundaryOf(item.boundary, `${field}.boundary`),
      suggested: suggestedOf(item.suggested, `${field}.suggested`),
    }, used, seen);
  });
}

function recognizedJson(value: unknown, source: string): MarkCandidate[] {
  if (Array.isArray(value)) return fromTurns(value, source, 'chat');
  if (!isObject(value)) throw new MarkPlanError('mark file: expected an export object');
  const hasTurns = 'turns' in value || 'messages' in value || 'steps' in value;
  const hasReview = 'reviews' in value || 'comments' in value;
  const hasItems = 'items' in value || 'candidates' in value;
  const shapes = [hasTurns, hasReview, hasItems].filter(Boolean).length;
  if (shapes === 0) throw new MarkPlanError('mark file: expected turns, a pull request review, or candidates');
  if (shapes > 1) throw new MarkPlanError('mark file: use one export shape, not a mix');
  if (hasItems) return fromItems(value.items ?? value.candidates, source);
  if (hasReview) return fromReview(value, source);
  const turns = value.turns ?? value.messages ?? value.steps;
  return fromTurns(turns, source, 'chat');
}

function fromJsonl(text: string, source: string): MarkCandidate[] | undefined {
  const lines = text.split('\n').map(line => line.trim()).filter(line => line.length > 0);
  if (lines.length === 0 || !lines.every(line => line.startsWith('{'))) return undefined;
  const parsed: unknown[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    try {
      parsed.push(JSON.parse(lines[index]));
    } catch (error) {
      throw new MarkPlanError(`mark file: line ${index + 1}: ${(error as Error).message}`);
    }
  }
  return fromTurns(parsed, source, 'chat');
}

function fromMarkdown(text: string, source: string): MarkCandidate[] {
  const blocks: { id: string; role: string; body: string[] }[] = [];
  let current: { id: string; role: string; body: string[] } | undefined;
  let auto = 0;
  let labels = 0;
  const flush = () => {
    if (current) blocks.push(current);
    current = undefined;
  };
  for (const line of text.split('\n')) {
    const heading = /^(#{1,6})\s+(\S+)\s+(user|human|assistant|system|tool|agent|reviewer)\s*$/i.exec(line.trim());
    const label = /^(user|human|assistant|system|tool|agent|reviewer|用户|助手)\s*[:：]\s*(.*)$/i.exec(line.trim());
    if (heading || label) {
      labels += 1;
      flush();
      if (heading) {
        current = { id: heading[2], role: heading[3].toLowerCase(), body: [] };
      } else if (label) {
        auto += 1;
        const raw = label[1].toLowerCase();
        const role = raw === '用户' ? 'user' : raw === '助手' ? 'assistant' : raw;
        current = { id: `t${String(auto).padStart(2, '0')}`, role, body: label[2] ? [label[2]] : [] };
      }
      continue;
    }
    if (current) current.body.push(line);
  }
  flush();
  if (labels === 0) throw new MarkPlanError('mark file: unrecognized export');
  const used = new Set<string>();
  const seen = new Set<string>();
  const out: MarkCandidate[] = [];
  for (const block of blocks) {
    if (!HUMAN_ROLES.has(block.role)) continue;
    const excerpt = block.body.join('\n');
    if (!excerpt.trim()) continue;
    out.push(takeCandidate({
      turn: block.id,
      source,
      excerpt,
      origin: 'chat',
      provenance: { kind: 'chat', ref: source },
    }, used, seen));
  }
  return out;
}

/** Read a chat export, a pull-request review file, or a candidate list. No network. */
export function parseMarkExport(text: string, source: string): MarkCandidate[] {
  const trimmed = text.trim();
  if (!trimmed) throw new MarkPlanError('mark file is empty');
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    try {
      return recognizedJson(JSON.parse(trimmed), source);
    } catch (error) {
      if (error instanceof MarkPlanError) throw error;
      const jsonl = fromJsonl(text, source);
      if (jsonl) return jsonl;
      throw new MarkPlanError(`mark file: invalid JSON: ${(error as Error).message}`);
    }
  }
  const jsonl = fromJsonl(text, source);
  if (jsonl) return jsonl;
  return fromMarkdown(text, source);
}

export interface ConfirmChoice {
  key: string;
  kind: MarkKind;
}

export interface DirectMark {
  note: string;
  kind: MarkKind;
  source: string;
  round?: string;
}

export interface MarkPlan {
  incoming: readonly MarkCandidate[];
  confirms: readonly ConfirmChoice[];
  direct?: DirectMark;
}

export interface MarkPlanResult {
  changed: boolean;
  notes: string[];
  interventions: Interventions;
  rework?: Interventions;
  candidates?: MarkCandidate[];
  writeInterventions: boolean;
  writeRework: boolean;
  writeCandidates: boolean;
  baseline: SharedBaseline;
}

interface Located {
  where: 'candidate' | MarkKind;
  id: string;
  candidate?: MarkCandidate;
}

function recordedInterventions(card: TaskCard): InterventionRecord[] {
  return 'records' in card.private.interventions ? card.private.interventions.records : [];
}

function recordedRework(card: TaskCard): InterventionRecord[] {
  return card.private.rework && 'records' in card.private.rework ? card.private.rework.records : [];
}

function locate(key: string, candidates: readonly MarkCandidate[], interventions: readonly InterventionRecord[], rework: readonly InterventionRecord[]): Located {
  const hits: Located[] = [];
  for (const candidate of candidates) {
    if (candidate.id === key || candidate.turn === key) hits.push({ where: 'candidate', id: candidate.id, candidate });
  }
  for (const record of interventions) {
    if (record.id === key || record.turn === key) hits.push({ where: 'intervention', id: record.id });
  }
  for (const record of rework) {
    if (record.id === key || record.turn === key) hits.push({ where: 'rework', id: record.id });
  }
  const unique = new Map<string, Located>();
  for (const hit of hits) unique.set(`${hit.where}\n${hit.id}`, hit);
  const found = [...unique.values()];
  if (found.length > 1) throw new MarkPlanError(`ambiguous mark: ${key}`);
  if (found.length === 0) throw new MarkPlanError(`unknown candidate: ${key}`);
  return found[0];
}

export function pendingCandidates(card: TaskCard, incoming: readonly MarkCandidate[]): MarkCandidate[] {
  const known = new Set<string>();
  for (const candidate of card.private.candidates ?? []) known.add(dedupeKey(candidate.source, candidate.turn));
  for (const record of [...recordedInterventions(card), ...recordedRework(card)]) {
    if (record.source && record.turn) known.add(dedupeKey(record.source, record.turn));
  }
  const used = new Set<string>([
    ...(card.private.candidates ?? []).map(candidate => candidate.id),
    ...recordedInterventions(card).map(record => record.id),
    ...recordedRework(card).map(record => record.id),
  ]);
  const pool = [...(card.private.candidates ?? [])];
  for (const item of incoming) {
    const key = dedupeKey(item.source, item.turn);
    if (known.has(key)) continue;
    const copy: MarkCandidate = { ...item, provenance: { ...item.provenance } };
    if (used.has(copy.id)) copy.id = markId(copy.source, copy.turn, used);
    used.add(copy.id);
    known.add(key);
    pool.push(copy);
  }
  return pool;
}

function toRecord(candidate: MarkCandidate, kind: MarkKind, round?: string): InterventionRecord {
  const record: InterventionRecord = {
    id: candidate.id,
    summary: candidate.summary,
    source: candidate.source,
    turn: candidate.turn,
    kind,
    confirmation: 'confirmed',
    excerpt: candidate.excerpt,
    origin: candidate.origin,
    provenance: candidate.provenance,
  };
  if (kind === 'rework') record.round = round ?? candidate.turn;
  if (candidate.boundary) record.boundary = candidate.boundary;
  return record;
}

function provenanceForDirect(source: string): SourceRef {
  if (/\/pull\/\d+/.test(source)) return { kind: 'pr', ref: source };
  if (/\/issues\/\d+/.test(source)) return { kind: 'issue', ref: source };
  return { kind: 'file', ref: source };
}

function withBaseline(card: TaskCard, interventions: Interventions, rework: Interventions | undefined, rest: Omit<MarkPlanResult, 'baseline' | 'interventions' | 'rework'>): MarkPlanResult {
  const result: MarkPlanResult = { ...rest, interventions, rework, baseline: { interventions: 'unknown', rework_rounds: 'unknown' } };
  result.baseline = sharedBaseline({ private: { ...card.private, interventions, rework } });
  return result;
}

export function planMarks(card: TaskCard, plan: MarkPlan): MarkPlanResult {
  if (plan.direct && (plan.incoming.length > 0 || plan.confirms.length > 0)) {
    throw new MarkPlanError('direct note cannot be combined with a file or confirmations');
  }
  const interventions = card.private.interventions;
  const rework = card.private.rework;
  let interventionRecords = recordedInterventions(card);
  let reworkRecords = recordedRework(card);

  if (plan.direct) {
    const note = plan.direct.note.trim();
    if (!note) throw new MarkPlanError('mark note: expected a non-empty note');
    const turn = noteTurn(plan.direct.kind, note);
    const source = plan.direct.source.trim();
    if (!source) throw new MarkPlanError('mark source: expected a url');
    const key = dedupeKey(source, turn);
    const existing = [...interventionRecords, ...reworkRecords].find(record => record.source && record.turn && dedupeKey(record.source, record.turn) === key);
    if (existing) {
      const existingKind: MarkKind = reworkRecords.some(record => record.id === existing.id) ? 'rework' : 'intervention';
      if (existingKind !== plan.direct.kind) throw new MarkPlanError(`${existing.id} is already recorded as ${existingKind}`);
      return withBaseline(card, interventions, rework, {
        changed: false,
        notes: ['unchanged'],
        candidates: card.private.candidates,
        writeInterventions: false,
        writeRework: false,
        writeCandidates: false,
      });
    }
    if (plan.direct.round) {
      const known = reworkRecords.some(record => record.round === plan.direct?.round || record.id === plan.direct?.round);
      if (!known) throw new MarkPlanError(`unknown rework round: ${plan.direct.round}`);
    }
    const used = new Set<string>([...interventionRecords, ...reworkRecords, ...(card.private.candidates ?? [])].map(item => item.id));
    const candidate: MarkCandidate = {
      id: markId(source, turn, used),
      summary: summarize(note),
      source,
      turn,
      excerpt: clip(note, 500),
      origin: 'manual',
      provenance: provenanceForDirect(source),
    };
    const record = toRecord(candidate, plan.direct.kind, plan.direct.kind === 'rework' ? (plan.direct.round ?? turn) : undefined);
    if (plan.direct.kind === 'intervention') interventionRecords = [...interventionRecords, record];
    else reworkRecords = [...reworkRecords, record];
    const nextInterventions = plan.direct.kind === 'intervention' ? { records: interventionRecords } : interventions;
    const nextRework = plan.direct.kind === 'rework' ? { records: reworkRecords } : rework;
    return withBaseline(card, nextInterventions, nextRework, {
      changed: true,
      notes: [`recorded ${record.id} ${plan.direct.kind}${record.round ? ` round ${record.round}` : ''}`],
      candidates: card.private.candidates,
      writeInterventions: plan.direct.kind === 'intervention',
      writeRework: plan.direct.kind === 'rework',
      writeCandidates: false,
    });
  }

  const pool = pendingCandidates(card, plan.incoming);
  const priorKeys = new Set((card.private.candidates ?? []).map(candidate => dedupeKey(candidate.source, candidate.turn)));
  const addedCandidates = pool.filter(candidate => !priorKeys.has(dedupeKey(candidate.source, candidate.turn)));
  const selected = new Map<string, MarkKind>();
  for (const confirm of plan.confirms) {
    const hit = locate(confirm.key, pool, interventionRecords, reworkRecords);
    if (hit.where === 'candidate') {
      const previous = selected.get(hit.id);
      if (previous && previous !== confirm.kind) throw new MarkPlanError(`${hit.id} is already recorded as ${previous}`);
      selected.set(hit.id, confirm.kind);
      continue;
    }
    if (hit.where !== confirm.kind) throw new MarkPlanError(`${hit.id} is already recorded as ${hit.where}`);
  }

  const roundOf = new Map<string, string>();
  let open: { source: string; round: string } | undefined;
  for (const candidate of pool) {
    if (selected.get(candidate.id) !== 'rework') continue;
    if (!open || open.source !== candidate.source) open = { source: candidate.source, round: candidate.turn };
    roundOf.set(candidate.id, open.round);
    if (candidate.boundary) open = undefined;
  }

  const addedInterventions: InterventionRecord[] = [];
  const addedRework: InterventionRecord[] = [];
  const remove = new Set<string>();
  const notes: string[] = [];
  for (const candidate of addedCandidates) {
    if (!selected.has(candidate.id)) notes.push(`candidate ${candidate.id}`);
  }
  for (const candidate of pool) {
    const kind = selected.get(candidate.id);
    if (!kind) continue;
    remove.add(candidate.id);
    const record = toRecord(candidate, kind, roundOf.get(candidate.id));
    if (kind === 'intervention') addedInterventions.push(record);
    else addedRework.push(record);
    notes.push(`recorded ${record.id} ${kind}${record.round ? ` round ${record.round}` : ''}`);
  }
  const nextCandidates = pool.filter(candidate => !remove.has(candidate.id));
  const writeInterventions = addedInterventions.length > 0;
  const writeRework = addedRework.length > 0;
  const writeCandidates = addedCandidates.length > 0 || remove.size > 0;
  const changed = writeInterventions || writeRework || writeCandidates;
  if (writeInterventions) interventionRecords = [...interventionRecords, ...addedInterventions];
  if (writeRework) reworkRecords = [...reworkRecords, ...addedRework];
  return withBaseline(
    card,
    writeInterventions ? { records: interventionRecords } : interventions,
    writeRework ? { records: reworkRecords } : rework,
    {
      changed,
      notes: changed ? notes : ['unchanged'],
      candidates: nextCandidates,
      writeInterventions,
      writeRework,
      writeCandidates,
    },
  );
}

export function parseConfirmSpec(values: readonly string[]): ConfirmChoice[] {
  const out: ConfirmChoice[] = [];
  for (const value of values) {
    for (const part of value.split(',')) {
      const trimmed = part.trim();
      if (!trimmed) continue;
      const colon = trimmed.lastIndexOf(':');
      if (colon <= 0) throw new MarkPlanError(`mark confirm: expected <turn>:<type>, got ${trimmed}`);
      const key = trimmed.slice(0, colon).trim();
      const kind = parseMarkKind(trimmed.slice(colon + 1));
      if (!key || !kind) throw new MarkPlanError(`mark confirm: expected 插手 or 返工, got ${trimmed}`);
      out.push({ key, kind });
    }
  }
  return out;
}

function recordToYaml(record: InterventionRecord): Record<string, unknown> {
  const out: Record<string, unknown> = { id: record.id, summary: record.summary };
  if (record.source) out.source = record.source;
  if (record.turn) out.turn = record.turn;
  if (record.kind) out.kind = record.kind;
  if (record.confirmation) out.confirmation = record.confirmation;
  if (record.excerpt) out.excerpt = record.excerpt;
  if (record.origin) out.origin = record.origin;
  if (record.round) out.round = record.round;
  if (record.boundary) out.boundary = record.boundary;
  if (record.provenance) {
    const provenance: Record<string, unknown> = { kind: record.provenance.kind, ref: record.provenance.ref };
    if (record.provenance.note) provenance.note = record.provenance.note;
    out.provenance = provenance;
  }
  return out;
}

function interventionsToYaml(value: Interventions): Record<string, unknown> {
  if ('records' in value) return { records: value.records.map(recordToYaml) };
  const out: Record<string, unknown> = { status: value.status };
  if (value.reason) out.reason = value.reason;
  return out;
}

function candidateToYaml(candidate: MarkCandidate): Record<string, unknown> {
  const out: Record<string, unknown> = {
    id: candidate.id,
    summary: candidate.summary,
    source: candidate.source,
    turn: candidate.turn,
    excerpt: candidate.excerpt,
    origin: candidate.origin,
    provenance: candidate.provenance.note
      ? { kind: candidate.provenance.kind, ref: candidate.provenance.ref, note: candidate.provenance.note }
      : { kind: candidate.provenance.kind, ref: candidate.provenance.ref },
  };
  if (candidate.suggested) out.suggested = candidate.suggested;
  if (candidate.boundary) out.boundary = candidate.boundary;
  return out;
}

export function isMarkMapping(value: unknown): value is Record<string, unknown> {
  return isObject(value);
}

export function assignMarkFields(raw: Record<string, unknown>, result: MarkPlanResult): void {
  if (!result.changed) return;
  const priv: Record<string, unknown> = isObject(raw.private) ? raw.private : {};
  raw.private = priv;
  if (result.writeInterventions) priv.interventions = interventionsToYaml(result.interventions);
  if (result.writeRework && result.rework) priv.rework = interventionsToYaml(result.rework);
  if (result.writeCandidates) {
    if (result.candidates && result.candidates.length > 0) priv.candidates = result.candidates.map(candidateToYaml);
    else delete priv.candidates;
  }
}
