import { spawnSync } from 'node:child_process';
import { ImportError, snapshotFromUnknown } from './task-import-snapshot.ts';
import type { PullSnapshot } from './task-import-snapshot.ts';

const VIEW_FIELDS = [
  'number',
  'title',
  'description',
  'headRef',
  'baseRef',
  'status',
  'mergeCommitSha',
  'additions',
  'deletions',
  'changedFiles',
  'headSha',
  'baseSha',
  'url',
  'parentChangeId',
  'stackId',
].join(',');

const COMMENT_FIELDS = `${VIEW_FIELDS},comments,threads,reviews,commits`;

export interface ForgeRun {
  bin: string;
  offline?: boolean;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function labelOf(repo: string, number: number): string {
  return `${repo}#${number}`;
}

function assertReadOnly(args: readonly string[]): void {
  const words = args.filter(arg => !arg.startsWith('-'));
  const head = words.slice(0, 2).join(' ');
  if (head !== 'repo view' && head !== 'pr view') {
    throw new ImportError(`refusing to run origin ${head || args.join(' ')}; import is read-only`);
  }
}

function runOrigin(bin: string, args: readonly string[], label: string): { ok: true; stdout: string } | { ok: false; message: string } {
  assertReadOnly(args);
  let result;
  try {
    result = spawnSync(bin, [...args], { encoding: 'utf8', timeout: 30_000, maxBuffer: 10 * 1024 * 1024 });
  } catch (error) {
    return { ok: false, message: `Origin could not be started for ${label}: ${(error as Error).message}. No card was written for ${label}.` };
  }
  if (result.error) {
    const code = (result.error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') {
      return { ok: false, message: `The origin command was not found, so ${label} was not read. No card was written for ${label}.` };
    }
    return { ok: false, message: `Origin could not be started for ${label}: ${result.error.message}. No card was written for ${label}.` };
  }
  if (result.status !== 0) {
    const stderr = `${result.stderr ?? ''}`;
    if (/not authenticated|CURSOR_AUTH_TOKEN|CURSOR_API_KEY|auth status/i.test(stderr)) {
      return {
        ok: false,
        message: `Origin is not authenticated, so ${label} was not read. Export the pull request and use --from-file. No card was written for ${label}.`,
      };
    }
    const line = stderr.trim().split('\n').find(item => item.trim()) ?? `origin exited ${result.status}`;
    return { ok: false, message: `Origin read failed for ${label}: ${line.trim().slice(0, 400)}. No card was written for ${label}.` };
  }
  return { ok: true, stdout: result.stdout ?? '' };
}

function parseStdout(stdout: string, label: string): unknown {
  try {
    return JSON.parse(stdout);
  } catch (error) {
    throw new ImportError(`Origin returned unreadable JSON for ${label}: ${(error as Error).message}. No card was written for ${label}.`);
  }
}

function defaultBranchFrom(value: unknown): string | undefined {
  if (!isObject(value)) return undefined;
  if (typeof value.defaultBranch === 'string' && value.defaultBranch.trim()) return value.defaultBranch.trim();
  const ref = value.defaultBranchRef;
  if (isObject(ref) && typeof ref.name === 'string' && ref.name.trim()) return ref.name.trim();
  return undefined;
}

/**
 * Read one Origin pull request. Spawns `origin repo view` and `origin pr view` only.
 * Write subcommands are refused before the process starts.
 */
export function readOriginPull(repo: string, number: number, run: ForgeRun = { bin: 'origin' }): PullSnapshot {
  const label = labelOf(repo, number);
  if (run.offline) {
    throw new ImportError(`Offline: cannot read ${label} from Origin. Use --from-file with an export. No card was written for ${label}.`);
  }
  let defaultBranch: string | undefined;
  const repoView = runOrigin(run.bin, ['repo', 'view', repo, '--json', 'org,name,defaultBranch'], label);
  if (repoView.ok) defaultBranch = defaultBranchFrom(parseStdout(repoView.stdout, label));

  const full = runOrigin(run.bin, ['pr', 'view', String(number), '-R', repo, '--json', COMMENT_FIELDS], label);
  let pullStdout: string;
  if (full.ok) {
    pullStdout = full.stdout;
  } else {
    const slim = runOrigin(run.bin, ['pr', 'view', String(number), '-R', repo, '--json', VIEW_FIELDS], label);
    if (!slim.ok) throw new ImportError(full.message);
    pullStdout = slim.stdout;
  }
  const pull = parseStdout(pullStdout, label);
  if (!isObject(pull)) throw new ImportError(`Origin returned a non-object for ${label}. No card was written for ${label}.`);
  return snapshotFromUnknown({
    ...pull,
    repo,
    host: 'origin',
    default_branch: defaultBranch,
  });
}
