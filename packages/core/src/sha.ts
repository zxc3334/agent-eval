import { spawnSync } from 'node:child_process';

/** Full Git SHA-1 or SHA-256. Short SHAs are a format error, not an existence result. */
const SHA = /^[0-9a-f]{40}$|^[0-9a-f]{64}$/;

export const SHA_FORMAT_MESSAGE = 'not a full 40- or 64-character hex SHA';

export type CommitLookupState = 'found' | 'missing' | 'unavailable';

export type ShaAssessment =
  | { ok: true; sha: string }
  | { ok: false; kind: 'format'; sha: string; message: string }
  | { ok: false; kind: 'missing'; sha: string; message: string }
  | { ok: false; kind: 'unavailable'; sha: string; message: string };

export interface AssessOptions {
  /** Do not consult a commit store. The result is unavailable, not missing. */
  offline?: boolean;
  /** Local checkout used when `probe` is omitted. */
  repoDir?: string;
  /**
   * Object-store lookup. Called only after the format check passes and the
   * lookup is online. Throw when the store cannot be reached.
   */
  probe?: (sha: string) => Promise<CommitLookupState> | CommitLookupState;
}

/** Lowercase full SHA, or undefined when the format is wrong. */
export function canonicalSha(value: string): string | undefined {
  const sha = value.trim().toLowerCase();
  return SHA.test(sha) ? sha : undefined;
}

/**
 * Three different results: bad format, commit not in the store, store not checked
 * or not reachable. Format is decided before any lookup.
 */
export async function assessCommit(input: string, options: AssessOptions = {}): Promise<ShaAssessment> {
  if (typeof input !== 'string') {
    return { ok: false, kind: 'format', sha: '', message: SHA_FORMAT_MESSAGE };
  }
  const sha = canonicalSha(input);
  if (!sha) {
    return { ok: false, kind: 'format', sha: input.trim().toLowerCase(), message: SHA_FORMAT_MESSAGE };
  }
  if (options.offline) {
    return {
      ok: false,
      kind: 'unavailable',
      sha,
      message: 'existence was not checked because the lookup is offline',
    };
  }
  if (!options.probe && !options.repoDir) {
    return { ok: false, kind: 'unavailable', sha, message: 'no commit store was configured' };
  }
  try {
    const state = options.probe ? await options.probe(sha) : gitLookup(options.repoDir!, sha);
    if (state === 'found') return { ok: true, sha };
    if (state === 'missing') {
      return { ok: false, kind: 'missing', sha, message: 'commit is not in the repository' };
    }
    return { ok: false, kind: 'unavailable', sha, message: 'commit store is unreachable' };
  } catch {
    return { ok: false, kind: 'unavailable', sha, message: 'commit store is unreachable' };
  }
}

function gitLookup(repoDir: string, sha: string): CommitLookupState {
  let result;
  try {
    result = spawnSync('git', ['-C', repoDir, 'cat-file', '-e', `${sha}^{commit}`], {
      encoding: 'utf8',
      timeout: 10_000,
    });
  } catch {
    return 'unavailable';
  }
  if (result.error || result.status == null) return 'unavailable';
  if (result.status === 0) return 'found';
  const stderr = result.stderr ?? '';
  if (/not a valid object name|bad object/i.test(stderr)) return 'missing';
  return 'unavailable';
}
