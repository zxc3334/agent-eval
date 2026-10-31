import { spawnSync } from 'node:child_process';
import { ImportError, snapshotFromUnknown } from './task-import-snapshot.ts';
import type { ForgeRun } from './task-import-origin.ts';
import type { PullSnapshot } from './task-import-snapshot.ts';

const VIEW_FIELDS = [
  'number',
  'title',
  'body',
  'baseRefName',
  'headRefName',
  'baseRefOid',
  'headRefOid',
  'mergeCommit',
  'additions',
  'deletions',
  'changedFiles',
  'url',
  'state',
  'reviews',
  'comments',
  'commits',
].join(',');

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function assertReadOnly(args: readonly string[]): void {
  const words = args.filter(arg => !arg.startsWith('-'));
  const head = words.slice(0, 2).join(' ');
  if (head !== 'repo view' && head !== 'pr view') {
    throw new ImportError(`refusing to run gh ${head || args.join(' ')}; import is read-only`);
  }
}

function runGh(bin: string, args: readonly string[], label: string): { ok: true; stdout: string } | { ok: false; message: string } {
  assertReadOnly(args);
  let result;
  try {
    result = spawnSync(bin, [...args], { encoding: 'utf8', timeout: 30_000, maxBuffer: 10 * 1024 * 1024 });
  } catch (error) {
    return { ok: false, message: `GitHub could not be started for ${label}: ${(error as Error).message}. No card was written for ${label}.` };
  }
  if (result.error) {
    const code = (result.error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') {
      return { ok: false, message: `The gh command was not found, so ${label} was not read. No card was written for ${label}.` };
    }
    return { ok: false, message: `GitHub could not be started for ${label}: ${result.error.message}. No card was written for ${label}.` };
  }
  if (result.status !== 0) {
    const line = `${result.stderr ?? ''}`.trim().split('\n').find(item => item.trim()) ?? `gh exited ${result.status}`;
    return { ok: false, message: `GitHub read failed for ${label}: ${line.trim().slice(0, 400)}. No card was written for ${label}.` };
  }
  return { ok: true, stdout: result.stdout ?? '' };
}

function parseStdout(stdout: string, label: string): unknown {
  try {
    return JSON.parse(stdout);
  } catch (error) {
    throw new ImportError(`GitHub returned unreadable JSON for ${label}: ${(error as Error).message}. No card was written for ${label}.`);
  }
}

/** Optional GitHub read. Not required for the Origin / --from-file path. */
export function readGithubPull(repo: string, number: number, run: ForgeRun = { bin: 'gh' }): PullSnapshot {
  const label = `${repo}#${number}`;
  if (run.offline) {
    throw new ImportError(`Offline: cannot read ${label} from GitHub. Use --from-file with an export. No card was written for ${label}.`);
  }
  let defaultBranch: string | undefined;
  const repoView = runGh(run.bin, ['repo', 'view', repo, '--json', 'defaultBranchRef'], label);
  if (repoView.ok) {
    const repoJson = parseStdout(repoView.stdout, label);
    const ref = isObject(repoJson) ? repoJson.defaultBranchRef : undefined;
    if (isObject(ref) && typeof ref.name === 'string' && ref.name.trim()) defaultBranch = ref.name.trim();
  }
  const pullView = runGh(run.bin, ['pr', 'view', String(number), '--repo', repo, '--json', VIEW_FIELDS], label);
  if (!pullView.ok) throw new ImportError(pullView.message);
  const pull = parseStdout(pullView.stdout, label);
  if (!isObject(pull)) throw new ImportError(`GitHub returned a non-object for ${label}. No card was written for ${label}.`);
  return snapshotFromUnknown({
    ...pull,
    repo,
    host: 'github',
    default_branch: defaultBranch,
  });
}
