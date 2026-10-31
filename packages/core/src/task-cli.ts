import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, readSync, renameSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { stringify } from 'yaml';
import type { Command } from './cli.ts';
import { assessCommit } from './sha.ts';
import { SHA_FORMAT_MESSAGE, canonicalSha } from './sha.ts';
import { MarkPlanError } from './marks.ts';
import { parseTaskCardYaml } from './task-card.ts';
import type { TaskCard } from './task-card.ts';
import { executeMark } from './task-mark.ts';
import { describeCard, formatList, listCellsFromText } from './task-view.ts';

const TASK_HELP = [
  'task — add, list, show, validate, and mark task cards',
  '',
  'Usage:',
  '  pnpm eval task add [--root <dir>]',
  '  pnpm eval task list [--root <dir>]',
  '  pnpm eval task show <id> [--root <dir>] [--offline] [--repo-dir <dir>]',
  '  pnpm eval task validate [id] [--root <dir>] [--offline] [--repo-dir <dir>]',
  '  pnpm eval task mark <id> [--root <dir>] [--from-file <path>] [--select]',
  '  pnpm eval task mark <id> --confirm <turn>:<type>[,<turn>:<type>...]',
  '  pnpm eval task mark <id> --note "…" --type 返工 --source <url>',
  '',
  'add asks for each field. Requirement text can come from multiline input',
  '(end with a line that is only "."), a file, or the clipboard.',
  'Draft cards are allowed. replay-ready needs a concrete requirement, repo,',
  'and base commit; otherwise the card is saved as draft.',
  '',
  'list columns, tab-separated: id, status, base, intervention, verify, missing_required.',
  'base is a 7-character SHA, or the gap status. intervention "unknown" means the',
  'history was not recorded, not 0. verify is a path, none, or missing.',
  'A missing verify is not an error.',
  '',
  'show prints none, todo, unknown, N/A, and unavailable as statuses.',
  'Only schema problems are marked error.',
  '',
  'validate prints one result per field. SHA format is checked without git.',
  'Commit existence is unavailable when --offline is set or no local checkout',
  'matches the card repo. unavailable is not a failure.',
  'A missing verify is not a failure. An illegal verify status is.',
  'Deleting the base SHA, or a base SHA that is not in the checkout, exits non-zero.',
  '',
  'mark reads a chat export or a pull-request review file, or rows already',
  'stored as candidates. You choose 插手 or 返工. Unchosen rows stay',
  'unconfirmed and do not change the baseline. Missing history stays unknown,',
  'never a confirmed zero. Reading the same file again does not add a second copy.',
  'mark does not need verify. A chat-only card can omit pull-request fields.',
  '--type accepts 插手, 返工, intervention, or rework.',
  '--confirm selects without a prompt. --select reads one choice per row.',
  'A direct --note is one confirmed event. The same note, type, and source again is a no-op.',
].join('\n');

const REQUIRED_GAPS = ['todo', 'unknown', 'unavailable'] as const;
const OPTIONAL_GAPS = ['none', 'todo', 'unknown', 'N/A', 'unavailable'] as const;
const HOSTS = ['origin', 'github', 'other'] as const;
const SOURCE_KINDS = ['pr', 'issue', 'chat', 'file'] as const;

type RequiredGap = (typeof REQUIRED_GAPS)[number];
type Host = (typeof HOSTS)[number];

class TaskCliError extends Error {
  readonly exitCode: number;

  constructor(message: string, exitCode = 2) {
    super(message);
    this.name = 'TaskCliError';
    this.exitCode = exitCode;
  }
}

class LineReader {
  private pending = '';
  private readonly decoder = new TextDecoder('utf8');
  private sawEof = false;

  raw(): string {
    for (;;) {
      const nl = this.pending.indexOf('\n');
      if (nl !== -1) {
        const line = this.pending.slice(0, nl).replace(/\r$/, '');
        this.pending = this.pending.slice(nl + 1);
        return line;
      }
      if (this.sawEof) {
        if (this.pending.length === 0) throw new TaskCliError('unexpected end of input');
        const rest = this.pending.replace(/\r$/, '');
        this.pending = '';
        return rest;
      }
      const buf = Buffer.alloc(4096);
      let n = 0;
      try {
        n = readSync(0, buf, 0, buf.length, null);
      } catch (error) {
        throw new TaskCliError(`cannot read input: ${(error as Error).message}`);
      }
      if (n === 0) {
        this.sawEof = true;
        this.pending += this.decoder.decode();
        continue;
      }
      this.pending += this.decoder.decode(buf.subarray(0, n), { stream: true });
    }
  }
}

function writeErr(text: string): void {
  writeSync(2, text);
}

function ask(io: LineReader, label: string): string {
  writeErr(`${label}: `);
  return io.raw().trim();
}

function askRequired(io: LineReader, label: string): string {
  for (;;) {
    const answer = ask(io, label);
    if (answer) return answer;
    writeErr('expected a non-empty value\n');
  }
}

function askChoice<T extends string>(io: LineReader, label: string, choices: readonly T[], fallback?: T): T {
  const hint = fallback !== undefined ? ` [${fallback}]` : '';
  const shown = choices.join(', ');
  for (;;) {
    const answer = ask(io, `${label} (${shown})${hint}`);
    if (!answer && fallback !== undefined) return fallback;
    if ((choices as readonly string[]).includes(answer)) return answer as T;
    writeErr(`expected one of: ${shown}\n`);
  }
}

function askSha(io: LineReader, label: string): string {
  for (;;) {
    const raw = ask(io, label).replace(/^['"]|['"]$/g, '');
    const sha = canonicalSha(raw);
    if (sha) return sha;
    writeErr(`${SHA_FORMAT_MESSAGE}\n`);
  }
}

function validVerifyPath(path: string): boolean {
  return path.trim().length > 0 && !path.includes('\0') && !path.includes('\t') && !path.split(/[\\/]/).includes('..');
}

function readClipboard(): string | undefined {
  const candidates: readonly (readonly [string, readonly string[]])[] = [
    ['pbpaste', []],
    ['wl-paste', ['--no-newline']],
    ['xclip', ['-selection', 'clipboard', '-o']],
    ['xsel', ['--clipboard', '--output']],
  ];
  for (const [command, args] of candidates) {
    let result;
    try {
      result = spawnSync(command, [...args], { encoding: 'utf8', timeout: 3000 });
    } catch {
      continue;
    }
    if (result.status === 0 && result.stdout.trim()) return result.stdout.replace(/\n$/, '');
  }
  return undefined;
}

interface TextAnswer { kind: 'text'; text: string }
interface GapAnswer { kind: 'gap'; status: RequiredGap; reason: string }
interface RepoAnswer { kind: 'value'; id: string; host: Host }
type RequirementAnswer = TextAnswer | GapAnswer;
type RepoField = RepoAnswer | GapAnswer;
type BaseAnswer = { kind: 'sha'; sha: string } | GapAnswer;
type PlainStatus = { status: 'none' | 'unknown' } | { status: 'todo' | 'N/A' | 'unavailable'; reason: string };
type VerifyAnswer =
  | { kind: 'omit' }
  | { kind: 'none' }
  | { kind: 'path'; path: string }
  | { kind: 'gap'; status: 'todo' | 'unavailable'; reason: string };
type PrAnswer =
  | { kind: 'number'; number: number; url?: string }
  | { kind: 'status'; status: 'none' | 'unknown' }
  | { kind: 'gap'; status: 'todo' | 'N/A' | 'unavailable'; reason: string };
type MergeAnswer =
  | { kind: 'sha'; sha: string }
  | { kind: 'status'; status: 'none' | 'unknown' }
  | { kind: 'gap'; status: 'todo' | 'N/A' | 'unavailable'; reason: string };

function askRequirement(io: LineReader): RequirementAnswer {
  for (;;) {
    const source = askChoice(io, 'requirement source', ['multiline', 'file', 'clipboard', 'gap'] as const);
    if (source === 'gap') {
      return {
        kind: 'gap',
        status: askChoice(io, 'requirement gap', REQUIRED_GAPS),
        reason: askRequired(io, 'requirement reason'),
      };
    }
    const text = source === 'multiline' ? askMultiline(io) : source === 'file' ? askFile(io) : askClipboardText();
    if (text === undefined) {
      writeErr('clipboard is unavailable\n');
      continue;
    }
    if (!text.trim()) {
      writeErr('expected non-empty requirement text\n');
      continue;
    }
    if (source === 'clipboard') writeErr(`requirement from clipboard: ${text.split('\n')[0].slice(0, 80)}\n`);
    return { kind: 'text', text };
  }
}

function askMultiline(io: LineReader): string {
  writeErr('requirement text (end with a single "." line):\n');
  const lines: string[] = [];
  for (;;) {
    const line = io.raw();
    if (line === '.') break;
    lines.push(line);
  }
  return lines.join('\n');
}

function askFile(io: LineReader): string {
  for (;;) {
    const file = resolve(askRequired(io, 'requirement file'));
    if (!existsSync(file) || !statSync(file).isFile()) {
      writeErr(`requirement file not found: ${file}\n`);
      continue;
    }
    const text = readFileSync(file, 'utf8').replace(/\n$/, '');
    if (!text.trim()) {
      writeErr('expected non-empty requirement text\n');
      continue;
    }
    return text;
  }
}

function askClipboardText(): string | undefined {
  return readClipboard();
}

function askRepo(io: LineReader): RepoField {
  const source = askChoice(io, 'repo source', ['value', 'gap'] as const, 'value');
  if (source === 'gap') {
    return {
      kind: 'gap',
      status: askChoice(io, 'repo gap', REQUIRED_GAPS),
      reason: askRequired(io, 'repo reason'),
    };
  }
  for (;;) {
    const id = askRequired(io, 'repo id (owner/name)');
    if (/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(id)) {
      return { kind: 'value', id, host: askChoice(io, 'repo host', HOSTS, 'github') };
    }
    writeErr('expected owner/name\n');
  }
}

function askBase(io: LineReader): BaseAnswer {
  const source = askChoice(io, 'base_commit source', ['sha', 'gap'] as const);
  if (source === 'sha') return { kind: 'sha', sha: askSha(io, 'base_commit sha') };
  return {
    kind: 'gap',
    status: askChoice(io, 'base_commit gap', REQUIRED_GAPS),
    reason: askRequired(io, 'base_commit reason'),
  };
}

function askInterventions(io: LineReader): PlainStatus {
  const status = askChoice(io, 'interventions', OPTIONAL_GAPS, 'unknown');
  if (status === 'todo' || status === 'N/A' || status === 'unavailable') {
    return { status, reason: askRequired(io, 'interventions reason') };
  }
  return { status };
}

function askVerify(io: LineReader): VerifyAnswer {
  const choice = askChoice(io, 'verify', ['omit', 'none', 'path', 'todo', 'unavailable'] as const, 'omit');
  if (choice === 'omit' || choice === 'none') return { kind: choice };
  if (choice === 'path') {
    for (;;) {
      const path = askRequired(io, 'verify path');
      if (validVerifyPath(path)) return { kind: 'path', path };
      writeErr('expected a path without parent segments\n');
    }
  }
  return { kind: 'gap', status: choice, reason: askRequired(io, 'verify reason') };
}

function askPr(io: LineReader): PrAnswer | undefined {
  const choice = askChoice(io, 'pr', ['omit', 'number', ...OPTIONAL_GAPS] as const, 'omit');
  if (choice === 'omit') return undefined;
  if (choice === 'number') {
    for (;;) {
      const raw = askRequired(io, 'pr number');
      const number = Number(raw);
      if (/^[1-9]\d*$/.test(raw) && Number.isSafeInteger(number)) {
        const url = ask(io, 'pr url (empty to omit)');
        return url ? { kind: 'number', number, url } : { kind: 'number', number };
      }
      writeErr('expected a positive integer\n');
    }
  }
  if (choice === 'none' || choice === 'unknown') return { kind: 'status', status: choice };
  return { kind: 'gap', status: choice, reason: askRequired(io, 'pr reason') };
}

function askMerge(io: LineReader): MergeAnswer | undefined {
  const choice = askChoice(io, 'merge', ['omit', 'sha', ...OPTIONAL_GAPS] as const, 'omit');
  if (choice === 'omit') return undefined;
  if (choice === 'sha') return { kind: 'sha', sha: askSha(io, 'merge sha') };
  if (choice === 'none' || choice === 'unknown') return { kind: 'status', status: choice };
  return { kind: 'gap', status: choice, reason: askRequired(io, 'merge reason') };
}

function askProvenance(io: LineReader): { kind: string; ref: string; note?: string } | undefined {
  const kind = askChoice(io, 'provenance', ['omit', ...SOURCE_KINDS] as const, 'omit');
  if (kind === 'omit') return undefined;
  const ref = askRequired(io, 'provenance ref');
  const note = ask(io, 'provenance note (empty to omit)');
  return note ? { kind, ref, note } : { kind, ref };
}

function askId(io: LineReader, tasksDir: string): string {
  for (;;) {
    const id = ask(io, 'task id');
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(id)) {
      writeErr('invalid identifier\n');
      continue;
    }
    if (existsSync(join(tasksDir, id))) {
      writeErr(`task already exists: ${id}\n`);
      continue;
    }
    return id;
  }
}

function renderCard(doc: Record<string, unknown>): string {
  const text = stringify(doc, { lineWidth: 0, defaultStringType: 'QUOTE_DOUBLE', defaultKeyType: 'PLAIN' });
  return text.endsWith('\n') ? text : `${text}\n`;
}

function buildDocument(input: {
  id: string;
  status: 'draft' | 'replay-ready';
  requirement: RequirementAnswer;
  repo: RepoField;
  base: BaseAnswer;
  interventions: PlainStatus;
  verify: VerifyAnswer;
  pr?: PrAnswer;
  merge?: MergeAnswer;
  provenance?: { kind: string; ref: string; note?: string };
  draftReason?: string;
}): Record<string, unknown> {
  const priv: Record<string, unknown> = {};
  if (input.provenance) priv.provenance = input.provenance;
  if (input.pr?.kind === 'number') priv.pr = input.pr.url ? { number: input.pr.number, url: input.pr.url } : { number: input.pr.number };
  if (input.pr?.kind === 'status') priv.pr = { status: input.pr.status };
  if (input.pr?.kind === 'gap') priv.pr = { status: input.pr.status, reason: input.pr.reason };
  if (input.merge?.kind === 'sha') priv.merge = { sha: input.merge.sha };
  if (input.merge?.kind === 'status') priv.merge = { status: input.merge.status };
  if (input.merge?.kind === 'gap') priv.merge = { status: input.merge.status, reason: input.merge.reason };
  priv.interventions = 'reason' in input.interventions
    ? { status: input.interventions.status, reason: input.interventions.reason }
    : { status: input.interventions.status };
  if (input.verify.kind === 'none') priv.verify = { status: 'none' };
  if (input.verify.kind === 'path') priv.verify = { status: 'path', path: input.verify.path };
  if (input.verify.kind === 'gap') priv.verify = { status: input.verify.status, reason: input.verify.reason };
  if (input.draftReason) priv.not_replay_ready = { reason: input.draftReason };
  return {
    schema_version: 1,
    id: input.id,
    status: input.status,
    public: {
      requirement: input.requirement.kind === 'text'
        ? input.requirement.text
        : { status: input.requirement.status, reason: input.requirement.reason },
      repo: input.repo.kind === 'value'
        ? { id: input.repo.id, host: input.repo.host }
        : { status: input.repo.status, reason: input.repo.reason },
      base_commit: input.base.kind === 'sha'
        ? input.base.sha
        : { status: input.base.status, reason: input.base.reason },
    },
    private: priv,
  };
}

function runAdd(root: string): number {
  const tasksDir = join(root, 'tasks');
  mkdirSync(tasksDir, { recursive: true });
  const io = new LineReader();
  const id = askId(io, tasksDir);
  let status = askChoice(io, 'status', ['draft', 'replay-ready'] as const, 'draft');
  const requirement = askRequirement(io);
  const repo = askRepo(io);
  const base = askBase(io);
  const interventions = askInterventions(io);
  const verify = askVerify(io);
  const pr = askPr(io);
  const merge = askMerge(io);
  const provenance = askProvenance(io);
  const concrete = requirement.kind === 'text' && repo.kind === 'value' && base.kind === 'sha';
  if (status === 'replay-ready' && !concrete) {
    writeErr('replay-ready needs a concrete requirement, repo, and base commit; saving as draft\n');
    status = 'draft';
  }
  const draftReason = status === 'draft' ? askRequired(io, 'not_replay_ready reason') : undefined;
  const text = renderCard(buildDocument({
    id, status, requirement, repo, base, interventions, verify, pr, merge, provenance, draftReason,
  }));
  const parsed = parseTaskCardYaml(text, { expectedId: id });
  if (!parsed.ok) {
    writeErr(parsed.errors.map(issue => `${issue.field}: ${issue.message}`).join('\n') + '\n');
    return 1;
  }
  const dir = join(tasksDir, id);
  if (existsSync(dir)) throw new TaskCliError(`task already exists: ${id}`);
  mkdirSync(dir, { recursive: true });
  const file = join(dir, 'card.yaml');
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, text);
  renameSync(tmp, file);
  console.log(file);
  return 0;
}

function taskDirs(tasksDir: string): string[] {
  if (!existsSync(tasksDir)) return [];
  return readdirSync(tasksDir, { withFileTypes: true })
    .filter(entry => entry.isDirectory() && existsSync(join(tasksDir, entry.name, 'card.yaml')))
    .map(entry => entry.name)
    .sort();
}

function runList(root: string): number {
  const tasksDir = join(root, 'tasks');
  const rows = taskDirs(tasksDir).map(id => {
    try {
      return listCellsFromText(id, readFileSync(join(tasksDir, id, 'card.yaml'), 'utf8'));
    } catch {
      return {
        id,
        status: 'invalid',
        base: 'missing',
        intervention: 'unknown',
        verify: 'missing',
        missing_required: '3',
      };
    }
  });
  process.stdout.write(formatList(rows));
  return 0;
}

function checkId(id: string | undefined, usage: string): string {
  if (!id) throw new TaskCliError(usage);
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(id)) throw new TaskCliError(`invalid task id: ${id}`);
  return id;
}

function cardFile(root: string, id: string): string {
  const file = join(root, 'tasks', id, 'card.yaml');
  if (!existsSync(file)) throw new TaskCliError(`unknown task: ${id}`);
  return file;
}

function originSlug(root: string): string | undefined {
  let result;
  try {
    result = spawnSync('git', ['-C', root, 'remote', 'get-url', 'origin'], { encoding: 'utf8', timeout: 5000 });
  } catch {
    return undefined;
  }
  if (result.error || result.status !== 0) return undefined;
  const url = result.stdout.trim().replace(/\.git$/, '');
  return url.match(/[:/]([^/:]+\/[^/:]+)$/)?.[1];
}

function repoIdOf(card: TaskCard): string | undefined {
  const repo = card.public.repo;
  return repo && typeof repo === 'object' && 'id' in repo && typeof repo.id === 'string' ? repo.id : undefined;
}

async function existenceState(sha: string, root: string, card: TaskCard | undefined, flags: { offline: boolean; repoDir?: string }): Promise<'found' | 'missing' | 'unavailable'> {
  if (flags.offline) {
    const result = await assessCommit(sha, { offline: true });
    return result.ok ? 'found' : result.kind === 'missing' ? 'missing' : 'unavailable';
  }
  const repoDir = flags.repoDir ?? (card && originSlug(root) === repoIdOf(card) ? root : undefined);
  const result = await assessCommit(sha, repoDir ? { repoDir } : {});
  if (result.ok) return 'found';
  return result.kind === 'missing' ? 'missing' : 'unavailable';
}

async function reportFile(
  id: string,
  file: string,
  root: string,
  flags: { offline: boolean; repoDir?: string },
  verbose: boolean,
): Promise<{ schemaOk: boolean; existence?: 'found' | 'missing' | 'unavailable' | 'N/A'; lines: string[] }> {
  const report = describeCard(id, readFileSync(file, 'utf8'), { verbose });
  const lines = [`path: ${file}`, ...report.lines];
  if (!report.schemaOk) return { schemaOk: false, lines };
  if (!report.baseSha) {
    lines.push('public.base_commit.existence: N/A');
    return { schemaOk: true, existence: 'N/A', lines };
  }
  const existence = await existenceState(report.baseSha, root, report.card, flags);
  lines.push(`public.base_commit.existence: ${existence}`);
  return { schemaOk: true, existence, lines };
}

async function runShow(root: string, id: string, flags: { offline: boolean; repoDir?: string }): Promise<number> {
  const file = cardFile(root, id);
  const report = await reportFile(id, file, root, flags, true);
  process.stdout.write(`${report.lines.join('\n')}\n`);
  return report.schemaOk ? 0 : 1;
}

async function runValidate(root: string, id: string | undefined, flags: { offline: boolean; repoDir?: string }): Promise<number> {
  const ids = id ? [id] : taskDirs(join(root, 'tasks'));
  if (!id && ids.length === 0) {
    console.log('no task cards');
    return 0;
  }
  const blocks: string[] = [];
  let failed = false;
  for (const taskId of ids) {
    const file = cardFile(root, taskId);
    const report = await reportFile(taskId, file, root, flags, false);
    const bad = !report.schemaOk || report.existence === 'missing';
    if (bad) failed = true;
    blocks.push([`task ${taskId}`, ...report.lines, `result: ${bad ? 'failed' : 'ok'}`].join('\n'));
  }
  process.stdout.write(`${blocks.join('\n\n')}\n`);
  return failed ? 1 : 0;
}

interface Flags {
  help: boolean;
  root?: string;
  offline: boolean;
  repoDir?: string;
  fromFile?: string;
  select: boolean;
  confirm: string[];
  note?: string;
  type?: string;
  source?: string;
  round?: string;
  positionals: string[];
}

function asList(value: string | string[] | boolean | undefined): string[] {
  if (!value || typeof value === 'boolean') return [];
  return Array.isArray(value) ? value : [value];
}

function readFlags(args: readonly string[]): Flags {
  try {
    const { values, positionals } = parseArgs({
      args: [...args],
      allowPositionals: true,
      strict: true,
      options: {
        help: { type: 'boolean', short: 'h', default: false },
        root: { type: 'string' },
        offline: { type: 'boolean', default: false },
        'repo-dir': { type: 'string' },
        'from-file': { type: 'string' },
        select: { type: 'boolean', default: false },
        confirm: { type: 'string', multiple: true },
        note: { type: 'string' },
        type: { type: 'string' },
        source: { type: 'string' },
        round: { type: 'string' },
      },
    });
    return {
      help: values.help,
      root: values.root,
      offline: values.offline,
      repoDir: values['repo-dir'],
      fromFile: values['from-file'],
      select: values.select,
      confirm: asList(values.confirm),
      note: values.note,
      type: values.type,
      source: values.source,
      round: values.round,
      positionals,
    };
  } catch (error) {
    throw new TaskCliError(`task: ${(error as Error).message}`);
  }
}

export function findRepoRoot(start: string): string {
  let dir = resolve(start);
  for (;;) {
    if (existsSync(join(dir, 'pnpm-workspace.yaml'))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return resolve(start);
    dir = parent;
  }
}

function resolveRoot(flag: string | undefined): string {
  const root = resolve(flag ?? findRepoRoot(process.cwd()));
  if (!existsSync(root) || !statSync(root).isDirectory()) throw new TaskCliError(`root does not exist: ${root}`);
  return root;
}

async function dispatch(args: readonly string[]): Promise<number> {
  const flags = readFlags(args);
  const [sub, ...rest] = flags.positionals;
  if (!sub || flags.help) {
    console.log(TASK_HELP);
    return 0;
  }
  const root = resolveRoot(flags.root);
  const lookup = { offline: flags.offline, repoDir: flags.repoDir };
  if (sub !== 'mark' && (flags.fromFile || flags.select || flags.confirm.length > 0 || flags.note || flags.type || flags.source || flags.round)) {
    throw new TaskCliError(`task ${sub}: unknown option`);
  }
  if (sub === 'add') {
    if (rest.length > 0) throw new TaskCliError('task add: no arguments');
    return runAdd(root);
  }
  if (sub === 'list') {
    if (rest.length > 0) throw new TaskCliError('task list: no arguments');
    return runList(root);
  }
  if (sub === 'show') {
    const id = checkId(rest[0], 'usage: pnpm eval task show <id>');
    if (rest.length !== 1) throw new TaskCliError('usage: pnpm eval task show <id>');
    return runShow(root, id, lookup);
  }
  if (sub === 'validate') {
    if (rest.length > 1) throw new TaskCliError('usage: pnpm eval task validate [id]');
    const id = rest[0] ? checkId(rest[0], 'usage: pnpm eval task validate [id]') : undefined;
    return runValidate(root, id, lookup);
  }
  if (sub === 'mark') {
    if (rest.length !== 1) throw new TaskCliError('usage: pnpm eval task mark <id>');
    const id = checkId(rest[0], 'usage: pnpm eval task mark <id>');
    return runMark(root, id, flags);
  }
  throw new TaskCliError(`unknown task command: ${sub}`);
}

function runMark(root: string, id: string, flags: Flags): number {
  const io = new LineReader();
  try {
    const result = executeMark(root, id, {
      fromFile: flags.fromFile,
      select: flags.select,
      confirm: flags.confirm,
      note: flags.note,
      type: flags.type,
      source: flags.source,
      round: flags.round,
      readLine: () => io.raw(),
      writeErr,
    });
    process.stdout.write(`${result.lines.join('\n')}\n`);
    return 0;
  } catch (error) {
    if (error instanceof MarkPlanError) throw new TaskCliError(error.message);
    throw error;
  }
}

export const taskCommand: Command = {
  name: 'task',
  summary: 'Add, list, show, validate, and mark task cards.',
  run(args) {
    return runTask(args);
  },
};

async function runTask(args: readonly string[]): Promise<number> {
  try {
    return await dispatch(args);
  } catch (error) {
    if (error instanceof TaskCliError) {
      console.error(error.message);
      return error.exitCode;
    }
    console.error(`environment_error: ${(error as Error).message}`);
    return 2;
  }
}
