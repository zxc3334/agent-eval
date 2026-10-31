import { parse as parseYaml } from 'yaml';
import { canonicalSha } from './sha.ts';
import { validateTaskCard } from './task-card.ts';
import type { CardIssue, TaskCard } from './task-card.ts';

const YAML_PARSE = { schema: 'core' as const, uniqueKeys: true, strict: true, maxAliasCount: 10 };

const KNOWN_FIELDS = [
  'schema_version',
  'id',
  'status',
  'public.requirement',
  'public.repo',
  'public.base_commit',
  'private.provenance',
  'private.pr',
  'private.merge',
  'private.interventions',
  'private.verify',
  'private.sources',
  'private.not_replay_ready',
] as const;

export interface ListCells {
  id: string;
  status: string;
  base: string;
  intervention: string;
  verify: string;
  missing_required: string;
}

export type VerifyView =
  | { kind: 'missing' }
  | { kind: 'none' }
  | { kind: 'status'; status: string }
  | { kind: 'path'; path: string }
  | { kind: 'invalid' };

export interface CardReport {
  schemaOk: boolean;
  card?: TaskCard;
  /** Set only when the card is schema-valid and base_commit is a concrete SHA. */
  baseSha?: string;
  lines: string[];
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readYaml(text: string): { ok: true; value: unknown } | { ok: false; message: string } {
  try {
    return { ok: true, value: parseYaml(text, YAML_PARSE) };
  } catch (error) {
    return { ok: false, message: (error as Error).message };
  }
}

function errorsUnder(errors: readonly CardIssue[], field: string): CardIssue[] {
  return errors.filter(issue =>
    issue.field === field
    || issue.field.startsWith(`${field}.`)
    || issue.field.startsWith(`${field}[`),
  );
}

function claimed(field: string): boolean {
  return KNOWN_FIELDS.some(key => field === key || field.startsWith(`${key}.`) || field.startsWith(`${key}[`));
}

function concreteRequirement(value: unknown): boolean {
  if (typeof value === 'string') return value.trim().length > 0;
  if (!isObject(value) || 'status' in value) return false;
  return typeof value.text === 'string' && value.text.trim().length > 0;
}

function concreteRepo(value: unknown): boolean {
  if (!isObject(value) || 'status' in value) return false;
  return typeof value.id === 'string'
    && /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(value.id)
    && (value.host === 'origin' || value.host === 'github' || value.host === 'other');
}

function shaOf(value: unknown): string | undefined {
  if (typeof value === 'string') return canonicalSha(value);
  if (isObject(value) && typeof value.sha === 'string' && !('status' in value)) return canonicalSha(value.sha);
  return undefined;
}

function countMissingRequired(raw: unknown): number {
  if (!isObject(raw) || !isObject(raw.public)) return 3;
  let missing = 0;
  if (!concreteRequirement(raw.public.requirement)) missing += 1;
  if (!concreteRepo(raw.public.repo)) missing += 1;
  if (!shaOf(raw.public.base_commit)) missing += 1;
  return missing;
}

export function verifyView(raw: unknown): VerifyView {
  if (!isObject(raw) || !isObject(raw.private) || !('verify' in raw.private)) return { kind: 'missing' };
  const verify = raw.private.verify;
  if (verify === 'none') return { kind: 'none' };
  if (!isObject(verify) || typeof verify.status !== 'string' || !verify.status.trim()) return { kind: 'invalid' };
  if (verify.status === 'none') return { kind: 'none' };
  if (verify.status === 'path') {
    return typeof verify.path === 'string' && verify.path.trim()
      ? { kind: 'path', path: verify.path }
      : { kind: 'invalid' };
  }
  return { kind: 'status', status: verify.status };
}

/** List column. A missing verify is `missing`, never `error`. */
export function verifyColumn(raw: unknown): string {
  const view = verifyView(raw);
  if (view.kind === 'missing') return 'missing';
  if (view.kind === 'none') return 'none';
  if (view.kind === 'path') return view.path;
  if (view.kind === 'status') return view.status;
  return 'invalid';
}

export function interventionColumn(raw: unknown): string {
  if (!isObject(raw) || !isObject(raw.private) || !('interventions' in raw.private)) return 'unknown';
  const value = raw.private.interventions;
  if (typeof value === 'number' || !isObject(value) || 'count' in value) return 'invalid';
  if (Array.isArray(value.records)) return `records:${value.records.length}`;
  if (typeof value.status === 'string' && value.status.trim()) return value.status;
  return 'invalid';
}

function baseColumn(raw: unknown): string {
  if (!isObject(raw) || !isObject(raw.public) || !('base_commit' in raw.public)) return 'missing';
  const sha = shaOf(raw.public.base_commit);
  if (sha) return sha.slice(0, 7);
  const value = raw.public.base_commit;
  if (isObject(value) && typeof value.status === 'string' && value.status.trim()) return value.status;
  return 'invalid';
}

function statusColumn(raw: unknown): string {
  if (!isObject(raw)) return 'invalid';
  return typeof raw.status === 'string' && raw.status.trim() ? raw.status : 'invalid';
}

const UNREADABLE: Omit<ListCells, 'id'> = {
  status: 'invalid',
  base: 'missing',
  intervention: 'unknown',
  verify: 'missing',
  missing_required: '3',
};

export function listCellsFromText(id: string, text: string): ListCells {
  const parsed = readYaml(text);
  if (!parsed.ok || !isObject(parsed.value)) return { id, ...UNREADABLE };
  return {
    id,
    status: statusColumn(parsed.value),
    base: baseColumn(parsed.value),
    intervention: interventionColumn(parsed.value),
    verify: verifyColumn(parsed.value),
    missing_required: String(countMissingRequired(parsed.value)),
  };
}

export function formatList(rows: readonly ListCells[]): string {
  const header = ['id', 'status', 'base', 'intervention', 'verify', 'missing_required'];
  const lines = [
    header.join('\t'),
    ...rows.map(row => header.map(key => row[key as keyof ListCells]).join('\t')),
  ];
  return `${lines.join('\n')}\n`;
}

function publicOf(raw: unknown): Record<string, unknown> | undefined {
  return isObject(raw) && isObject(raw.public) ? raw.public : undefined;
}

function privateOf(raw: unknown): Record<string, unknown> | undefined {
  return isObject(raw) && isObject(raw.private) ? raw.private : undefined;
}

function reasonOf(value: unknown): string | undefined {
  if (!isObject(value) || typeof value.reason !== 'string') return undefined;
  const reason = value.reason.trim();
  return reason || undefined;
}

function statusOf(value: unknown): string | undefined {
  if (!isObject(value) || typeof value.status !== 'string' || !value.status.trim()) return undefined;
  return value.status;
}

function gapText(status: string, value: unknown): string {
  const reason = reasonOf(value);
  return reason ? `status ${status} — ${reason}` : `status ${status}`;
}

function errorText(issues: readonly CardIssue[]): string {
  return `error ${issues.map(issue => issue.message).join('; ')}`;
}

function requirementLine(value: unknown, issues: readonly CardIssue[], verbose: boolean): string {
  if (issues.length > 0) return `public.requirement: ${errorText(issues)}`;
  if (typeof value === 'string' && value.trim()) {
    if (!verbose || !value.includes('\n')) return verbose ? `public.requirement: value ${value}` : 'public.requirement: ok';
    return `public.requirement: value\n${value.split('\n').map(line => `  ${line}`).join('\n')}`;
  }
  if (isObject(value) && typeof value.text === 'string' && !('status' in value)) {
    return requirementLine(value.text, [], verbose);
  }
  const status = statusOf(value);
  if (status) return `public.requirement: ${gapText(status, value)}`;
  return 'public.requirement: missing';
}

function repoLine(value: unknown, issues: readonly CardIssue[], verbose: boolean): string {
  if (issues.length > 0) return `public.repo: ${errorText(issues)}`;
  if (concreteRepo(value) && isObject(value)) {
    return verbose ? `public.repo: value ${value.id} host ${value.host}` : 'public.repo: ok';
  }
  const status = statusOf(value);
  if (status) return `public.repo: ${gapText(status, value)}`;
  return 'public.repo: missing';
}

function baseLine(value: unknown, issues: readonly CardIssue[], verbose: boolean): string {
  if (issues.length > 0) return `public.base_commit: ${errorText(issues)}`;
  const sha = shaOf(value);
  if (sha) return verbose ? `public.base_commit: value ${sha}` : 'public.base_commit: ok';
  const status = statusOf(value);
  if (status) return `public.base_commit: ${gapText(status, value)}`;
  return 'public.base_commit: missing';
}

function sourceLine(field: string, value: unknown, issues: readonly CardIssue[], verbose: boolean): string {
  if (value === undefined) return `${field}: omitted`;
  if (issues.length > 0) return `${field}: ${errorText(issues)}`;
  const status = statusOf(value);
  if (status) return `${field}: ${gapText(status, value)}`;
  if (isObject(value) && typeof value.kind === 'string' && typeof value.ref === 'string') {
    return verbose ? `${field}: value ${value.kind} ${value.ref}` : `${field}: ok`;
  }
  return `${field}: invalid`;
}

function prLine(value: unknown, issues: readonly CardIssue[], verbose: boolean): string {
  if (value === undefined) return 'private.pr: omitted';
  if (issues.length > 0) return `private.pr: ${errorText(issues)}`;
  const status = statusOf(value);
  if (status) return `private.pr: ${gapText(status, value)}`;
  if (isObject(value) && typeof value.number === 'number') {
    return verbose ? `private.pr: value ${value.number}` : 'private.pr: ok';
  }
  return 'private.pr: invalid';
}

function mergeLine(value: unknown, issues: readonly CardIssue[], verbose: boolean): string {
  if (value === undefined) return 'private.merge: omitted';
  if (issues.length > 0) return `private.merge: ${errorText(issues)}`;
  const status = statusOf(value);
  if (status) return `private.merge: ${gapText(status, value)}`;
  const sha = shaOf(value);
  if (sha) return verbose ? `private.merge: value ${sha}` : 'private.merge: ok';
  return 'private.merge: invalid';
}

function interventionLine(raw: unknown, issues: readonly CardIssue[]): string {
  if (issues.length > 0) return `private.interventions: ${errorText(issues)}`;
  const label = interventionColumn(raw);
  if (label.startsWith('records:')) return `private.interventions: ${label.replace(':', ' ')}`;
  if (label === 'invalid') return 'private.interventions: invalid';
  return `private.interventions: status ${label}`;
}

function verifyLine(raw: unknown, issues: readonly CardIssue[]): string {
  if (issues.length > 0) return `private.verify: ${errorText(issues)}`;
  const view = verifyView(raw);
  if (view.kind === 'missing') return 'private.verify: missing';
  if (view.kind === 'none') return 'private.verify: status none';
  if (view.kind === 'path') return `private.verify: path ${view.path}`;
  if (view.kind === 'status') return `private.verify: status ${view.status}`;
  return 'private.verify: invalid';
}

function sourcesLine(value: unknown, issues: readonly CardIssue[]): string {
  if (value === undefined) return 'private.sources: omitted';
  if (issues.length > 0) return `private.sources: ${errorText(issues)}`;
  if (Array.isArray(value)) return `private.sources: value ${value.length}`;
  return 'private.sources: invalid';
}

function blockerLine(value: unknown, issues: readonly CardIssue[], verbose: boolean): string {
  if (value === undefined && issues.length === 0) return 'private.not_replay_ready: omitted';
  if (issues.length > 0) return `private.not_replay_ready: ${errorText(issues)}`;
  const reason = reasonOf(value);
  if (reason) return verbose ? `private.not_replay_ready: value ${reason}` : 'private.not_replay_ready: ok';
  return 'private.not_replay_ready: invalid';
}

export function describeCard(id: string, text: string, options: { verbose: boolean }): CardReport {
  const parsed = readYaml(text);
  if (!parsed.ok) {
    return {
      schemaOk: false,
      lines: [
        `id: ${id}`,
        `card.yaml: error YAML parse error: ${parsed.message}`,
        'schema: failed',
      ],
    };
  }
  const result = validateTaskCard(parsed.value, { expectedId: id });
  const errors = result.ok ? [] : result.errors;
  const raw = parsed.value;
  const pub = publicOf(raw);
  const priv = privateOf(raw);
  const verbose = options.verbose;
  const idIssues = errorsUnder(errors, 'id');
  const shownId = result.ok
    ? result.card.id
    : (isObject(raw) && typeof raw.id === 'string' ? raw.id : id);
  const lines = [
    idIssues.length > 0 ? `id: ${errorText(idIssues)}` : (verbose ? `id: value ${shownId}` : 'id: ok'),
    fieldLine('schema_version', errors, verbose ? `schema_version: ${isObject(raw) ? String(raw.schema_version) : 'missing'}` : 'schema_version: ok'),
    fieldLine('status', errors, isObject(raw) && typeof raw.status === 'string' ? `status: ${raw.status}` : 'status: missing'),
    requirementLine(pub?.requirement, errorsUnder(errors, 'public.requirement'), verbose),
    repoLine(pub?.repo, errorsUnder(errors, 'public.repo'), verbose),
    baseLine(pub?.base_commit, errorsUnder(errors, 'public.base_commit'), verbose),
    sourceLine('private.provenance', priv && 'provenance' in priv ? priv.provenance : undefined, errorsUnder(errors, 'private.provenance'), verbose),
    prLine(priv && 'pr' in priv ? priv.pr : undefined, errorsUnder(errors, 'private.pr'), verbose),
    mergeLine(priv && 'merge' in priv ? priv.merge : undefined, errorsUnder(errors, 'private.merge'), verbose),
    interventionLine(raw, errorsUnder(errors, 'private.interventions')),
    verifyLine(raw, errorsUnder(errors, 'private.verify')),
    sourcesLine(priv && 'sources' in priv ? priv.sources : undefined, errorsUnder(errors, 'private.sources')),
    blockerLine(priv && 'not_replay_ready' in priv ? priv.not_replay_ready : undefined, errorsUnder(errors, 'private.not_replay_ready'), verbose),
  ];
  for (const issue of errors) {
    if (!claimed(issue.field)) lines.push(`${issue.field}: error ${issue.message}`);
  }
  lines.push(result.ok ? 'schema: ok' : 'schema: failed');
  if (!result.ok) {
    return { schemaOk: false, lines };
  }
  const baseSha = typeof result.card.public.base_commit === 'string' ? result.card.public.base_commit : undefined;
  return { schemaOk: true, card: result.card, baseSha, lines };
}

function fieldLine(field: string, errors: readonly CardIssue[], okLine: string): string {
  const issues = errorsUnder(errors, field);
  if (issues.length === 0) return okLine;
  return `${field}: ${errorText(issues)}`;
}
