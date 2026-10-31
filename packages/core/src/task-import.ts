import { existsSync, mkdirSync, readdirSync, renameSync, rmdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { stringify } from 'yaml';
import { readGithubPull } from './task-import-github.ts';
import { readOriginPull } from './task-import-origin.ts';
import { ImportError, loadImportFile } from './task-import-snapshot.ts';
import type { PullSnapshot } from './task-import-snapshot.ts';
import { parseTaskCardYaml } from './task-card.ts';
import type { RepoHost } from './task-card.ts';

export { ImportError } from './task-import-snapshot.ts';

export const CANDIDATE_DISCLAIMER = 'PR base and description are candidates only, not the original start commit or the original user utterance.';

export interface ImportChoices {
  id: string;
  requirement: 'accept' | 'todo';
  base: 'accept' | 'todo';
}

export interface ImportIo {
  ask(prompt: string): string;
  log(text: string): void;
}

export interface ImportRunOptions {
  root: string;
  prs: readonly string[];
  origins: readonly string[];
  files: readonly string[];
  host?: string;
  repo?: string;
  id?: string;
  offline: boolean;
  io: ImportIo;
  env?: NodeJS.ProcessEnv;
}

interface Spec {
  kind: 'file' | 'origin' | 'github';
  file?: string;
  repo?: string;
  number?: number;
  host: RepoHost;
}

function isRepoHost(value: string | undefined): value is RepoHost {
  return value === 'origin' || value === 'github' || value === 'other';
}

function branchName(ref: string): string {
  return ref.replace(/^refs\/heads\//, '');
}

export function baseWarning(snapshot: PullSnapshot): string | undefined {
  const base = snapshot.baseRef ? branchName(snapshot.baseRef) : undefined;
  const fallback = snapshot.defaultBranch ? branchName(snapshot.defaultBranch) : undefined;
  if (base && fallback && base !== fallback) {
    return `Base branch ${base} is not the default branch ${fallback}. Stacked pull requests were not split.`;
  }
  if (snapshot.stacked) return 'This pull request is part of a stack. Stacked pull requests were not split.';
  return undefined;
}

function clip(text: string, max = 240): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  if (flat.length <= max) return flat;
  return `${flat.slice(0, max - 1)}…`;
}

function sourceKind(kind: string): 'pr' | 'issue' | 'chat' | 'file' {
  if (kind === 'linked_issue' || kind === 'issue') return 'issue';
  if (kind === 'chat') return 'chat';
  if (kind === 'file') return 'file';
  return 'pr';
}

function idHint(snapshot: PullSnapshot): string {
  const name = snapshot.repo.split('/')[1] ?? 'pr';
  const hint = `${name}-pr-${snapshot.number}`.replace(/[^A-Za-z0-9_-]/g, '-');
  return /^[A-Za-z0-9]/.test(hint) ? hint : `pr-${snapshot.number}`;
}

function diffStats(snapshot: PullSnapshot): { files: number; additions: number; deletions: number } | undefined {
  if (snapshot.changedFiles === undefined || snapshot.additions === undefined || snapshot.deletions === undefined) return undefined;
  return { files: snapshot.changedFiles, additions: snapshot.additions, deletions: snapshot.deletions };
}

function render(doc: Record<string, unknown>): string {
  const text = stringify(doc, { lineWidth: 0, defaultStringType: 'QUOTE_DOUBLE', defaultKeyType: 'PLAIN' });
  return text.endsWith('\n') ? text : `${text}\n`;
}

export function buildImportedCard(snapshot: PullSnapshot, choices: ImportChoices): string {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(choices.id)) throw new ImportError(`invalid task id: ${choices.id}`, 1);
  const prRef = snapshot.url ?? `${snapshot.repo}#${snapshot.number}`;
  const acceptedRequirement = choices.requirement === 'accept' ? snapshot.requirementCandidates[0] : undefined;
  const acceptedBase = choices.base === 'accept' && snapshot.baseSha ? snapshot.baseSha : undefined;
  const warning = baseWarning(snapshot);
  const stats = diffStats(snapshot);
  const note = [
    CANDIDATE_DISCLAIMER,
    acceptedRequirement
      ? `Requirement text is the accepted ${acceptedRequirement.kind} candidate, not a separately recorded user utterance.`
      : 'Requirement text was not accepted and was not copied into public.requirement.',
    acceptedBase
      ? 'base_commit is the accepted PR base SHA, not a separately recorded original start commit.'
      : snapshot.baseSha
        ? `PR base SHA ${snapshot.baseSha} was not accepted as the task start.`
        : 'No base SHA was in the source.',
    snapshot.mergeSha ? 'Merge SHA is the recorded merge result, not the task start.' : 'Merge SHA was not in the source.',
    snapshot.headSha ? `Head SHA ${snapshot.headSha} is the pull request head, not the task start.` : undefined,
    snapshot.title ? `Pull request title: ${clip(snapshot.title, 180)}.` : undefined,
    warning,
    snapshot.baseRef && !snapshot.defaultBranch ? 'Default branch was not in the source.' : undefined,
  ].filter((part): part is string => Boolean(part)).join(' ');

  const sources: { kind: string; ref: string; note: string }[] = [
    { kind: 'pr', ref: prRef, note: 'Pull request used for this import. Description and base SHA are candidates only.' },
  ];
  if (snapshot.file) {
    sources.push({ kind: 'file', ref: snapshot.file, note: 'Export file used for this import.' });
  }
  if (acceptedRequirement) {
    sources.push({
      kind: sourceKind(acceptedRequirement.kind),
      ref: acceptedRequirement.ref ?? prRef,
      note: `accepted requirement candidate (${acceptedRequirement.kind}). This is not a separately recorded user utterance.`,
    });
  } else {
    for (const candidate of snapshot.requirementCandidates) {
      sources.push({
        kind: sourceKind(candidate.kind),
        ref: candidate.ref ?? prRef,
        note: `unaccepted requirement candidate (${candidate.kind}): ${clip(candidate.text)}`,
      });
    }
  }
  for (const comment of snapshot.comments) {
    sources.push({
      kind: 'pr',
      ref: comment.url ?? prRef,
      note: `unconfirmed ${comment.kind} candidate: ${clip(comment.body)}`,
    });
  }

  const requirement = acceptedRequirement
    ? acceptedRequirement.text
    : {
      status: 'todo',
      reason: snapshot.requirementCandidates.length
        ? 'PR description or linked text is only a candidate, not the original user utterance.'
        : 'No requirement text was in the import source.',
    };
  const base = acceptedBase
    ? acceptedBase
    : {
      status: 'todo',
      reason: snapshot.baseSha
        ? `PR base ${snapshot.baseSha}${snapshot.baseRef ? ` on ${snapshot.baseRef}` : ''} is only a candidate, not the original start commit.`
        : 'No base SHA was in the import source.',
    };
  const concrete = typeof requirement === 'string' && typeof base === 'string';
  const gaps = [
    typeof requirement === 'string' ? undefined : 'requirement',
    typeof base === 'string' ? undefined : 'base commit',
  ].filter((part): part is string => Boolean(part));
  const merge = snapshot.mergeSha
    ? stats
      ? { sha: snapshot.mergeSha, diff_stats: stats }
      : { sha: snapshot.mergeSha }
    : {
      status: 'todo',
      reason: stats
        ? `Merge SHA was not in the source. Diff candidate: ${stats.files} files, +${stats.additions}, -${stats.deletions}. Not a gold patch.`
        : 'Merge SHA was not in the source.',
    };
  const verify = snapshot.verify.kind === 'none'
    ? { status: 'none', reason: 'No project verify was recorded. Missing verify does not block the card.' }
    : snapshot.verify.kind === 'path'
      ? { status: 'path', path: snapshot.verify.path }
      : snapshot.verify.kind === 'todo'
        ? { status: 'todo', reason: snapshot.verify.reason }
        : { status: 'todo', reason: 'Import did not check a project verify. Missing verify does not block the card.' };
  const priv: Record<string, unknown> = {
    provenance: { kind: 'pr', ref: prRef, note },
    pr: snapshot.url ? { number: snapshot.number, url: snapshot.url } : { number: snapshot.number },
    merge,
    interventions: snapshot.comments.length
      ? { status: 'todo', reason: 'Unconfirmed review or fixup candidates are listed in sources. They are not a baseline.' }
      : { status: 'unknown' },
    verify,
    sources,
  };
  if (!concrete) {
    priv.not_replay_ready = {
      reason: `${gaps.join(' and ')} ${gaps.length > 1 ? 'are' : 'is'} still todo. PR base and description were not treated as the task start.`,
    };
  }
  const doc = {
    schema_version: 1,
    id: choices.id,
    status: concrete ? 'replay-ready' : 'draft',
    public: {
      requirement,
      repo: { id: snapshot.repo, host: snapshot.host },
      base_commit: base,
    },
    private: priv,
  };
  const yaml = render(doc);
  const parsed = parseTaskCardYaml(yaml, { expectedId: choices.id });
  if (!parsed.ok) {
    throw new ImportError(parsed.errors.map(issue => `${issue.field}: ${issue.message}`).join('\n'), 1);
  }
  return yaml;
}

export function writeTaskCardFile(tasksDir: string, id: string, yaml: string): string {
  const dir = join(tasksDir, id);
  const file = join(dir, 'card.yaml');
  if (existsSync(file)) throw new ImportError(`task already exists: ${id}`, 1);
  let renamed = false;
  try {
    mkdirSync(dir, { recursive: true });
    const tmp = `${file}.tmp`;
    try {
      writeFileSync(tmp, yaml);
      renameSync(tmp, file);
      renamed = true;
    } finally {
      if (!renamed) {
        try { unlinkSync(tmp); } catch { /* no partial temp */ }
        try {
          if (existsSync(dir) && readdirSync(dir).length === 0) rmdirSync(dir);
        } catch { /* leave a non-empty directory alone */ }
      }
    }
  } catch (error) {
    if (error instanceof ImportError) throw error;
    throw new ImportError(`failed to write ${file}: ${(error as Error).message}. No card was written for ${id}.`, 1);
  }
  return file;
}

function parsePullRef(input: string, hostHint: RepoHost): { repo: string; number: number; host: RepoHost } {
  const text = input.trim().replace(/\/$/, '');
  let host = hostHint;
  if (/^https?:\/\//i.test(text)) {
    if (text.includes('github.com')) host = 'github';
    else if (text.includes('cursor.com')) host = 'origin';
  }
  const match = /([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)(?:\/pull\/|#)(\d+)$/.exec(text);
  if (!match) throw new ImportError(`expected owner/repo#N, got ${input}`);
  return { repo: `${match[1]}/${match[2]}`, number: Number(match[3]), host };
}

function collect(options: ImportRunOptions, hostHint: RepoHost): Spec[] {
  const specs: Spec[] = [];
  for (const ref of options.origins) {
    const parsed = parsePullRef(ref, 'origin');
    specs.push({ kind: 'origin', repo: parsed.repo, number: parsed.number, host: 'origin' });
  }
  for (const ref of options.prs) {
    const parsed = parsePullRef(ref, hostHint);
    if (parsed.host === 'other') {
      throw new ImportError(`no forge reader for ${parsed.repo}#${parsed.number}. Use --from-file.`);
    }
    specs.push({ kind: parsed.host === 'github' ? 'github' : 'origin', repo: parsed.repo, number: parsed.number, host: parsed.host });
  }
  for (const file of options.files) specs.push({ kind: 'file', file, host: hostHint });
  return specs;
}

function askChoice(io: ImportIo, prompt: string, choices: readonly string[]): string {
  for (;;) {
    const answer = io.ask(prompt).trim().toLowerCase();
    if (choices.includes(answer)) return answer;
    io.log(`expected one of: ${choices.join(', ')}`);
  }
}

function askId(io: ImportIo, tasksDir: string, hint: string): string {
  for (;;) {
    const raw = io.ask(`task id [${hint}]: `).trim();
    const id = raw || hint;
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(id)) {
      io.log('invalid identifier');
      continue;
    }
    if (existsSync(join(tasksDir, id, 'card.yaml'))) {
      io.log(`task already exists: ${id}`);
      continue;
    }
    return id;
  }
}

function preview(snapshot: PullSnapshot, warning: string | undefined): string {
  const lines = [`import: ${snapshot.repo}#${snapshot.number} (${snapshot.host})`];
  if (snapshot.url) lines.push(`url: ${snapshot.url}`);
  if (snapshot.title) lines.push(`title: ${snapshot.title}`);
  if (snapshot.file) lines.push(`file: ${snapshot.file}`);
  lines.push(`repo: ${snapshot.repo} host ${snapshot.host}`);
  lines.push(`base branch: ${snapshot.baseRef ?? 'unknown'}`);
  lines.push(`default branch: ${snapshot.defaultBranch ?? 'unknown'}`);
  lines.push(`base candidate: ${snapshot.baseSha ?? 'unknown'}`);
  lines.push(`head: ${snapshot.headSha ?? 'unknown'}`);
  lines.push(`merge candidate: ${snapshot.mergeSha ?? 'unknown'}`);
  const stats = diffStats(snapshot);
  lines.push(stats
    ? `diff candidate: files ${stats.files}, additions ${stats.additions}, deletions ${stats.deletions}`
    : 'diff candidate: unknown');
  lines.push('requirement candidates:');
  if (snapshot.requirementCandidates.length === 0) lines.push('  (none)');
  snapshot.requirementCandidates.forEach((candidate, index) => {
    lines.push(`  ${index + 1}. ${candidate.kind}${candidate.ref ? ` ${candidate.ref}` : ''}`);
    lines.push(`     ${candidate.text.split('\n')[0].slice(0, 160)}`);
  });
  lines.push('intervention candidates:');
  if (snapshot.comments.length === 0) lines.push('  (none recorded)');
  snapshot.comments.forEach((comment, index) => {
    lines.push(`  ${index + 1}. ${comment.kind} ${comment.body.split('\n')[0].slice(0, 160)}`);
  });
  lines.push(`verify: ${snapshot.verify.kind === 'path' ? snapshot.verify.path : snapshot.verify.kind}`);
  if (snapshot.merged === false) lines.push('warning: this pull request is not merged');
  if (warning) lines.push(`warning: ${warning}`);
  lines.push(CANDIDATE_DISCLAIMER);
  return lines.join('\n');
}

function loadSpec(spec: Spec, options: ImportRunOptions, hostHint: RepoHost): PullSnapshot[] {
  if (spec.kind === 'file') {
    const file = spec.file ?? '';
    return loadImportFile(resolve(file), { repo: options.repo, host: hostHint, displayPath: file });
  }
  const repo = spec.repo ?? '';
  const number = spec.number ?? 0;
  const env = options.env ?? process.env;
  if (spec.kind === 'github') {
    return [readGithubPull(repo, number, { bin: env.AGENT_EVAL_GH_BIN || 'gh', offline: options.offline })];
  }
  return [readOriginPull(repo, number, { bin: env.AGENT_EVAL_ORIGIN_BIN || 'origin', offline: options.offline })];
}

export function runImport(options: ImportRunOptions): number {
  if (!isRepoHost(options.host) && options.host) throw new ImportError(`--host must be origin, github, or other, got ${options.host}`);
  const hostHint: RepoHost = isRepoHost(options.host) ? options.host : 'origin';
  const specs = collect(options, hostHint);
  if (specs.length === 0) {
    throw new ImportError('usage: pnpm eval task import --pr <owner/repo#N> [--origin <owner/repo#N>] [--from-file <export>]');
  }
  if (options.id && specs.length !== 1) throw new ImportError('--id applies to a single pull request');
  const tasksDir = join(options.root, 'tasks');
  let loadFailed = false;
  let writeFailed = false;
  let written = 0;

  for (const spec of specs) {
    let snapshots: PullSnapshot[];
    try {
      snapshots = loadSpec(spec, options, hostHint);
    } catch (error) {
      loadFailed = true;
      options.io.log(error instanceof Error ? error.message : String(error));
      continue;
    }
    if (options.id && snapshots.length !== 1) {
      loadFailed = true;
      options.io.log('--id applies to a single pull request. No card was written.');
      continue;
    }
    for (const snapshot of snapshots) {
      const item = `${snapshot.repo}#${snapshot.number}`;
      const warning = baseWarning(snapshot);
      options.io.log(preview(snapshot, warning));
      if (warning) {
        const proceed = askChoice(options.io, 'non-default base [yes/no]: ', ['yes', 'no']);
        if (proceed === 'no') {
          options.io.log(`rejected: no card written for ${item}`);
          continue;
        }
      }
      const action = askChoice(options.io, 'action [write/reject/skip]: ', ['write', 'reject', 'skip']);
      if (action !== 'write') {
        options.io.log(`${action === 'reject' ? 'rejected' : 'skipped'}: no card written for ${item}`);
        continue;
      }
      const hint = options.id ?? idHint(snapshot);
      const id = askId(options.io, tasksDir, hint);
      const requirement = snapshot.requirementCandidates.length === 0
        ? 'todo'
        : askChoice(options.io, 'requirement [accept/todo]: ', ['accept', 'todo']) as 'accept' | 'todo';
      const base = snapshot.baseSha
        ? askChoice(options.io, 'base [accept/todo]: ', ['accept', 'todo']) as 'accept' | 'todo'
        : 'todo';
      try {
        const yaml = buildImportedCard(snapshot, { id, requirement, base });
        const file = writeTaskCardFile(tasksDir, id, yaml);
        console.log(file);
        written += 1;
      } catch (error) {
        writeFailed = true;
        options.io.log(error instanceof Error ? error.message : String(error));
      }
    }
  }

  if (loadFailed && written === 0 && !writeFailed) return 2;
  if (loadFailed || writeFailed) return 1;
  return 0;
}
