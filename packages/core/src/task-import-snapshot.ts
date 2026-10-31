import { existsSync, readFileSync, statSync } from 'node:fs';
import { parse as parseYaml } from 'yaml';
import { canonicalSha, SHA_FORMAT_MESSAGE } from './sha.ts';
import type { RepoHost } from './task-card.ts';

const REPO_ID = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const YAML_PARSE = { schema: 'core' as const, uniqueKeys: true, strict: true, maxAliasCount: 10 };

export class ImportError extends Error {
  readonly exitCode: number;

  constructor(message: string, exitCode = 2) {
    super(message);
    this.name = 'ImportError';
    this.exitCode = exitCode;
  }
}

export interface ImportComment {
  kind: 'review' | 'fixup' | 'comment';
  body: string;
  url?: string;
}

export interface RequirementCandidate {
  kind: string;
  text: string;
  ref?: string;
}

export type VerifyClaim =
  | { kind: 'unchecked' }
  | { kind: 'none' }
  | { kind: 'todo'; reason: string }
  | { kind: 'path'; path: string };

export interface PullSnapshot {
  host: RepoHost;
  repo: string;
  number: number;
  url?: string;
  title?: string;
  baseRef?: string;
  baseSha?: string;
  headRef?: string;
  headSha?: string;
  mergeSha?: string;
  defaultBranch?: string;
  additions?: number;
  deletions?: number;
  changedFiles?: number;
  merged?: boolean;
  stacked: boolean;
  requirementCandidates: RequirementCandidate[];
  comments: ImportComment[];
  verify: VerifyClaim;
  /** Path the user passed, when the snapshot was read from an export. */
  file?: string;
}

export interface LoadHints {
  repo?: string;
  host?: RepoHost;
  /** User-facing path stored on the snapshot. Defaults to the file that was read. */
  displayPath?: string;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readPath(value: unknown, path: string): unknown {
  let current = value;
  for (const part of path.split('.')) {
    if (!isObject(current) || !(part in current)) return undefined;
    current = current[part];
  }
  return current;
}

function firstString(value: unknown, paths: readonly string[]): string | undefined {
  for (const path of paths) {
    const item = readPath(value, path);
    if (typeof item === 'string' && item.trim()) return item.trim();
  }
  return undefined;
}

function readRepoId(value: unknown): string | undefined {
  if (typeof value === 'string' && REPO_ID.test(value.trim())) return value.trim();
  if (!isObject(value)) return undefined;
  if (typeof value.nameWithOwner === 'string' && REPO_ID.test(value.nameWithOwner)) return value.nameWithOwner;
  const owner = typeof value.owner === 'string'
    ? value.owner
    : isObject(value.owner) && typeof value.owner.slug === 'string'
      ? value.owner.slug
      : typeof value.org === 'string'
        ? value.org
        : undefined;
  if (typeof owner === 'string' && typeof value.name === 'string' && REPO_ID.test(`${owner}/${value.name}`)) {
    return `${owner}/${value.name}`;
  }
  if ('repo' in value) {
    const nested = readRepoId(value.repo);
    if (nested) return nested;
  }
  if ('repository' in value) {
    const nested = readRepoId(value.repository);
    if (nested) return nested;
  }
  return undefined;
}

function readPositiveInt(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isInteger(value) && value > 0) return value;
  if (typeof value === 'string' && /^[1-9]\d*$/.test(value)) {
    const number = Number(value);
    return Number.isSafeInteger(number) ? number : undefined;
  }
  return undefined;
}

function readCount(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isInteger(value) && value >= 0) return value;
  if (typeof value === 'string' && /^\d+$/.test(value)) return Number(value);
  return undefined;
}

function readShaField(value: unknown, field: string): string | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value !== 'string') throw new ImportError(`${field} is not a SHA string`);
  const sha = canonicalSha(value);
  if (!sha) throw new ImportError(`${field}: ${SHA_FORMAT_MESSAGE}`);
  return sha;
}

function readHost(value: unknown, url: string | undefined, hint: RepoHost | undefined): RepoHost {
  if (value === undefined || value === null || value === '') {
    if (hint) return hint;
    if (url?.includes('github.com')) return 'github';
    return 'origin';
  }
  if (value === 'origin' || value === 'github' || value === 'other') return value;
  throw new ImportError(`host must be origin, github, or other, got ${JSON.stringify(value)}`);
}

function validVerifyPath(path: string): boolean {
  return path.trim().length > 0 && !path.includes('\0') && !path.split(/[\\/]/).includes('..');
}

function readVerify(value: unknown, present: boolean): VerifyClaim {
  if (!present) return { kind: 'unchecked' };
  if (value === null || value === 'none') return { kind: 'none' };
  if (value === 'todo' || value === 'unavailable') {
    return { kind: 'todo', reason: 'Import marked verify as todo. Missing verify does not block the card.' };
  }
  if (typeof value === 'string') {
    return validVerifyPath(value)
      ? { kind: 'path', path: value }
      : { kind: 'todo', reason: 'Import could not read verify. Missing verify does not block the card.' };
  }
  if (!isObject(value)) return { kind: 'todo', reason: 'Import could not read verify. Missing verify does not block the card.' };
  if (value.status === 'none' || value.status === undefined && !('path' in value)) return { kind: 'none' };
  if (value.status === 'path' && typeof value.path === 'string' && validVerifyPath(value.path)) {
    return { kind: 'path', path: value.path };
  }
  if (value.status === 'todo' || value.status === 'unavailable') {
    const reason = typeof value.reason === 'string' && value.reason.trim()
      ? value.reason.trim()
      : 'Import marked verify as todo. Missing verify does not block the card.';
    return { kind: 'todo', reason };
  }
  return { kind: 'todo', reason: 'Import could not read verify. Missing verify does not block the card.' };
}

function commentKind(body: string, hinted: unknown, state: unknown): ImportComment['kind'] {
  if (hinted === 'review' || hinted === 'fixup' || hinted === 'comment') return hinted;
  const reviewState = typeof state === 'string' ? state.toUpperCase() : '';
  if (reviewState === 'CHANGES_REQUESTED') return 'fixup';
  if (reviewState === 'APPROVED' || reviewState === 'COMMENTED' || reviewState === 'DISMISSED') return 'review';
  if (/^fixup!?\b/i.test(body.trim())) return 'fixup';
  return 'comment';
}

function pushComment(out: ImportComment[], body: unknown, extra: { kind?: unknown; url?: unknown; state?: unknown }): void {
  if (typeof body !== 'string' || !body.trim()) return;
  const url = typeof extra.url === 'string' && extra.url.trim() ? extra.url.trim() : undefined;
  const comment: ImportComment = { kind: commentKind(body, extra.kind, extra.state), body: body.trim() };
  if (url) comment.url = url;
  out.push(comment);
}

function readCommentValue(value: unknown, out: ImportComment[]): void {
  if (!isObject(value)) return;
  const url = value.url ?? value.html_url ?? value.webUrl;
  pushComment(out, value.body ?? value.excerpt, { kind: value.kind, url, state: value.state });
  if (Array.isArray(value.comments)) {
    for (const child of value.comments) readCommentValue(child, out);
  }
}

function readComments(value: unknown, out: ImportComment[]): void {
  if (!Array.isArray(value)) return;
  for (const item of value) readCommentValue(item, out);
}

function readFixupCommits(value: unknown, out: ImportComment[]): void {
  if (!Array.isArray(value)) return;
  for (const item of value) {
    if (!isObject(item)) continue;
    const headline = typeof item.messageHeadline === 'string' ? item.messageHeadline : '';
    const message = typeof item.message === 'string' ? item.message : headline;
    if (!/^fixup!?\b/i.test(message.trim()) && !/^fixup!?\b/i.test(headline.trim())) continue;
    const body = [headline, typeof item.messageBody === 'string' ? item.messageBody : ''].filter(part => part.trim()).join('\n').trim();
    pushComment(out, body || message, { kind: 'fixup', url: item.url });
  }
}

function readCandidates(value: unknown, out: RequirementCandidate[]): void {
  if (!Array.isArray(value)) return;
  for (const item of value) {
    if (!isObject(item) || typeof item.text !== 'string' || !item.text.trim()) continue;
    const candidate: RequirementCandidate = {
      kind: typeof item.kind === 'string' && item.kind.trim() ? item.kind.trim() : 'other',
      text: item.text.trim(),
    };
    if (typeof item.ref === 'string' && item.ref.trim()) candidate.ref = item.ref.trim();
    out.push(candidate);
  }
}

function dedupeComments(comments: readonly ImportComment[]): ImportComment[] {
  const seen = new Set<string>();
  const out: ImportComment[] = [];
  for (const comment of comments) {
    const key = `${comment.kind}\n${comment.body}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(comment);
  }
  return out;
}

function dedupeCandidates(candidates: readonly RequirementCandidate[]): RequirementCandidate[] {
  const seen = new Set<string>();
  const out: RequirementCandidate[] = [];
  for (const candidate of candidates) {
    const key = candidate.text.trim();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(candidate);
  }
  return out;
}

function branchPresent(value: unknown): boolean {
  if (typeof value === 'string') return value.trim().length > 0;
  if (typeof value === 'number') return true;
  return isObject(value);
}

function readMergeSha(pull: Record<string, unknown>, envelope: Record<string, unknown>): string | undefined {
  const direct = firstString(pull, ['merge_sha', 'mergeCommitSha']) ?? firstString(envelope, ['merge_sha', 'mergeCommitSha']);
  if (direct) return readShaField(direct, 'merge sha');
  for (const source of [pull, envelope]) {
    const merge = source.mergeCommit ?? source.merge_commit;
    if (typeof merge === 'string') return readShaField(merge, 'merge sha');
    if (isObject(merge)) {
      const oid = merge.oid ?? merge.sha;
      if (typeof oid === 'string') return readShaField(oid, 'merge sha');
    }
  }
  return undefined;
}

function readMerged(state: string | undefined, raw: unknown, mergeSha: string | undefined): boolean | undefined {
  if (raw === true) return true;
  if (raw === false) return false;
  if (state) {
    const normalized = state.toLowerCase();
    if (normalized === 'merged') return true;
    if (normalized === 'open' || normalized === 'draft') return false;
  }
  if (mergeSha) return true;
  return undefined;
}

export function snapshotFromUnknown(value: unknown, hints: LoadHints = {}): PullSnapshot {
  if (!isObject(value)) throw new ImportError('export item must be an object');
  const envelope = value;
  const pull = isObject(envelope.pull) ? envelope.pull : envelope;
  const repo = readRepoId(envelope) ?? readRepoId(pull) ?? (hints.repo && REPO_ID.test(hints.repo) ? hints.repo : undefined);
  if (!repo) throw new ImportError('export is missing repo (owner/name)');
  const number = readPositiveInt(pull.number ?? pull.pull_number) ?? readPositiveInt(envelope.number ?? envelope.pull_number);
  if (!number) throw new ImportError(`export for ${repo} is missing a pull request number`);

  const url = firstString(pull, ['url', 'webUrl', 'html_url']) ?? firstString(envelope, ['url', 'webUrl', 'html_url']);
  const host = readHost(envelope.host ?? pull.host, url, hints.host);
  const baseSha = readShaField(
    firstString(pull, ['base_sha', 'baseSha', 'baseRefOid']) ?? firstString(pull, ['base.sha'])
      ?? firstString(envelope, ['base_sha', 'baseSha', 'baseRefOid']) ?? firstString(envelope, ['base.sha']),
    'base sha',
  );
  const headSha = readShaField(
    firstString(pull, ['head_sha', 'headSha', 'headRefOid']) ?? firstString(pull, ['head.sha'])
      ?? firstString(envelope, ['head_sha', 'headSha', 'headRefOid']) ?? firstString(envelope, ['head.sha']),
    'head sha',
  );
  const mergeSha = readMergeSha(pull, envelope);
  const description = firstString(pull, ['description', 'body']) ?? (pull === envelope ? undefined : firstString(envelope, ['description', 'body']));
  const comments: ImportComment[] = [];
  readComments(envelope.comments, comments);
  readComments(pull.comments, comments);
  readComments(pull.threads, comments);
  readComments(envelope.threads, comments);
  readComments(pull.reviews, comments);
  readComments(envelope.reviews, comments);
  readFixupCommits(pull.commits, comments);
  readFixupCommits(envelope.commits, comments);

  const candidates: RequirementCandidate[] = [];
  readCandidates(envelope.requirement_candidates, candidates);
  if (pull !== envelope) readCandidates(pull.requirement_candidates, candidates);
  if (description) {
    candidates.unshift({ kind: 'pr_description', text: description, ref: url });
  }

  const verifyPresent = 'verify' in envelope || (pull !== envelope && 'verify' in pull);
  const verifyValue = 'verify' in envelope ? envelope.verify : pull.verify;
  const stacked = branchPresent(envelope.stack_id ?? envelope.stackId ?? pull.stack_id ?? pull.stackId)
    || branchPresent(readPath(pull, 'stack.id'))
    || branchPresent(envelope.parent_number ?? envelope.parentChangeId ?? pull.parent_number ?? pull.parentChangeId)
    || branchPresent(readPath(pull, 'stack.parentPullRequest'))
    || branchPresent(readPath(envelope, 'stack.parentPullRequest'));
  const state = firstString(pull, ['state', 'status']) ?? firstString(envelope, ['state', 'status']);
  const snapshot: PullSnapshot = {
    host,
    repo,
    number,
    baseRef: firstString(pull, ['base_ref', 'baseRef', 'baseRefName', 'baseBranch']) ?? firstString(pull, ['base.ref'])
      ?? firstString(envelope, ['base_ref', 'baseRef', 'baseRefName', 'baseBranch']),
    baseSha,
    headRef: firstString(pull, ['head_ref', 'headRef', 'headRefName', 'headBranch']) ?? firstString(pull, ['head.ref'])
      ?? firstString(envelope, ['head_ref', 'headRef', 'headRefName', 'headBranch']),
    headSha,
    mergeSha,
    defaultBranch: firstString(envelope, ['default_branch', 'defaultBranch']) ?? firstString(pull, ['default_branch', 'defaultBranch'])
      ?? firstString(envelope, ['defaultBranchRef.name']) ?? firstString(pull, ['defaultBranchRef.name']),
    additions: readCount(pull.additions ?? envelope.additions),
    deletions: readCount(pull.deletions ?? envelope.deletions),
    changedFiles: readCount(pull.changed_files ?? pull.changedFiles ?? envelope.changed_files ?? envelope.changedFiles),
    merged: readMerged(state, envelope.merged ?? pull.merged, mergeSha),
    stacked,
    requirementCandidates: dedupeCandidates(candidates),
    comments: dedupeComments(comments),
    verify: readVerify(verifyValue, verifyPresent),
  };
  const title = firstString(pull, ['title']) ?? firstString(envelope, ['title']);
  if (url) snapshot.url = url;
  if (title) snapshot.title = title;
  if (hints.displayPath) snapshot.file = hints.displayPath;
  return snapshot;
}

function sectionMeta(text: string): { kind?: string; ref?: string; body: string } {
  const lines = text.split('\n');
  let index = 0;
  let kind: string | undefined;
  let ref: string | undefined;
  while (index < lines.length) {
    const kindMatch = /^kind:\s*(.*)$/.exec(lines[index]);
    const refMatch = /^ref:\s*(.*)$/.exec(lines[index]);
    if (kindMatch) {
      kind = kindMatch[1].trim();
      index += 1;
      continue;
    }
    if (refMatch) {
      ref = refMatch[1].trim();
      index += 1;
      continue;
    }
    if (!lines[index].trim()) {
      index += 1;
      continue;
    }
    break;
  }
  return { kind, ref, body: lines.slice(index).join('\n').trim() };
}

function parseMarkdown(text: string, displayPath: string, hints: LoadHints): PullSnapshot {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(text.replace(/^\uFEFF/, ''));
  if (!match) throw new ImportError(`export ${displayPath} is missing YAML front matter. No card was written for ${displayPath}.`);
  let front: unknown;
  try {
    front = parseYaml(match[1], YAML_PARSE);
  } catch (error) {
    throw new ImportError(`cannot parse export ${displayPath}: ${(error as Error).message}. No card was written for ${displayPath}.`);
  }
  if (!isObject(front)) throw new ImportError(`export ${displayPath} front matter must be an object`);
  const candidates: RequirementCandidate[] = [];
  const comments: ImportComment[] = [];
  const parts = match[2].split(/^##[ \t]+/m);
  for (let index = 1; index < parts.length; index += 1) {
    const chunk = parts[index];
    const breakAt = chunk.indexOf('\n');
    const heading = (breakAt === -1 ? chunk : chunk.slice(0, breakAt)).trim().toLowerCase();
    const meta = sectionMeta(breakAt === -1 ? '' : chunk.slice(breakAt + 1));
    if (!meta.body) continue;
    if (heading.startsWith('requirement')) {
      candidates.push({ kind: meta.kind || 'other', text: meta.body, ref: meta.ref });
      continue;
    }
    if (heading === 'review' || heading === 'fixup' || heading === 'comment') {
      pushComment(comments, meta.body, { kind: heading, url: meta.ref });
    }
  }
  const snapshot = snapshotFromUnknown({
    ...front,
    requirement_candidates: candidates,
    comments,
  }, { ...hints, displayPath });
  return snapshot;
}

export function loadImportFile(file: string, hints: LoadHints = {}): PullSnapshot[] {
  if (!existsSync(file) || !statSync(file).isFile()) {
    throw new ImportError(`export file not found: ${file}. No card was written for ${file}.`);
  }
  const displayPath = hints.displayPath ?? file;
  const text = readFileSync(file, 'utf8');
  const lower = file.toLowerCase();
  if (lower.endsWith('.md') || lower.endsWith('.markdown') || text.trimStart().startsWith('---')) {
    return [parseMarkdown(text, displayPath, hints)];
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (error) {
    throw new ImportError(`cannot parse export ${displayPath}: ${(error as Error).message}. No card was written for ${displayPath}.`);
  }
  const items = Array.isArray(value)
    ? value
    : isObject(value) && Array.isArray(value.items) && !('number' in value) && !('pull' in value)
      ? value.items
      : [value];
  if (items.length === 0) throw new ImportError(`export ${displayPath} has no pull requests. No card was written for ${displayPath}.`);
  return items.map((item, index) => {
    try {
      return snapshotFromUnknown(item, { ...hints, displayPath });
    } catch (error) {
      if (error instanceof ImportError && items.length > 1) {
        throw new ImportError(`export ${displayPath} item ${index + 1}: ${error.message}`, error.exitCode);
      }
      throw error;
    }
  });
}
