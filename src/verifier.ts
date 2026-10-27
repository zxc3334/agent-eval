import { mkdirSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { Worker } from 'node:worker_threads';
import { isDeepStrictEqual } from 'node:util';
import { assertJsonValue, record } from './criteria.ts';
import { json } from './storage.ts';
import type { Assertion, Criterion, CaseConfig } from './types.ts';

export const VERIFIER_TIMEOUT_MS = 2000;
type ErrorKind = 'exception' | 'timeout' | 'missing_result' | 'invalid_result';
export interface Verification {
  status: 'pass' | 'fail' | 'verifier_error'; assertions: Assertion[]; result_dir: string;
  error_kind?: ErrorKind; reason?: string;
}
class VerifierError extends Error {
  kind: ErrorKind;
  constructor(kind: ErrorKind, message: string) { super(message); this.kind = kind; }
}

// Worker messages are untrusted protocol values, even when the implementation is local.
export function validateVerifierOutput(raw: unknown, criteria: Criterion[], artifacts: string): Assertion[] {
  if (!record(raw) || !Array.isArray(raw.assertions)) throw new VerifierError('missing_result', 'verifier assertions result is missing');
  assertJsonValue(raw, 'verifier result');
  const rows = raw.assertions;
  if (rows.length < criteria.length) throw new VerifierError('missing_result', 'verifier criterion result is missing');
  if (rows.length !== criteria.length) throw new VerifierError('invalid_result', 'unexpected verifier criterion results');
  const seen = new Set<string>();
  for (const row of rows) {
    if (!record(row) || typeof row.criterion_id !== 'string' || seen.has(row.criterion_id)
      || !criteria.some(c => c.id === row.criterion_id)) throw new VerifierError('invalid_result', 'duplicate or unknown criterion result');
    seen.add(row.criterion_id);
  }
  return criteria.map(c => {
    const row = rows.find(r => r.criterion_id === c.id);
    if (!row || !Object.hasOwn(row, 'expected') || !Object.hasOwn(row, 'actual') || !Object.hasOwn(row, 'passed') || !Object.hasOwn(row, 'evidence')) {
      throw new VerifierError('missing_result', `criterion ${c.id}: expected/actual/passed/evidence result is missing`);
    }
    if (typeof row.passed !== 'boolean' || !isDeepStrictEqual(row.expected, c.params.expected)) {
      throw new VerifierError('invalid_result', `criterion ${c.id}: invalid verdict or expected value`);
    }
    const artifact = join(artifacts, c.target.artifact);
    const evidence = [{ artifact, field: c.target.field }];
    if (!isDeepStrictEqual(row.evidence, evidence)) throw new VerifierError('invalid_result', `criterion ${c.id}: invalid evidence reference`);
    return { criterion_id: c.id, type: c.type, target: c.target, params: c.params, mode: c.mode, reason: c.reason,
      expected: row.expected, actual: row.actual, passed: row.passed, artifact, evidence };
  });
}

async function executeVerifier(criteria: Criterion[], artifacts: string, inject: CaseConfig['inject'], signal: AbortSignal): Promise<unknown> {
  const worker = new Worker(new URL('./verifier-worker.ts', import.meta.url), { workerData: { criteria, artifacts, inject } });
  let timer: NodeJS.Timeout | undefined;
  let abort: (() => void) | undefined;
  try {
    return await new Promise((resolve, reject) => {
      worker.once('message', resolve);
      worker.once('error', error => reject(new VerifierError('exception', `verifier threw: ${error.message}`)));
      worker.once('exit', code => reject(new VerifierError('missing_result', `verifier exited (${code}) without a result`)));
      timer = setTimeout(() => reject(new VerifierError('timeout', `verifier timed out (${VERIFIER_TIMEOUT_MS}ms)`)), VERIFIER_TIMEOUT_MS);
      abort = () => reject(new VerifierError('exception', 'verifier interrupted by signal'));
      signal.addEventListener('abort', abort, { once: true });
      if (signal.aborted) abort();
    });
  } finally {
    clearTimeout(timer);
    if (abort) signal.removeEventListener('abort', abort);
    // Terminate even synchronous infinite loops and wait before publishing the result.
    await worker.terminate();
  }
}

export async function verify(criteria: Criterion[], artifacts: string, caseDir: string, inject?: CaseConfig['inject'], signal = new AbortController().signal): Promise<Verification> {
  const root = join(caseDir, 'verifier'); mkdirSync(root, { recursive: true });
  const resultDir = mkdtempSync(join(root, 'attempt-'));
  json(join(resultDir, 'input.json'), { criteria, artifacts, timeout_ms: VERIFIER_TIMEOUT_MS });
  let result: Verification;
  try {
    const raw = await executeVerifier(criteria, artifacts, inject, signal);
    const assertions = validateVerifierOutput(raw, criteria, artifacts);
    json(join(resultDir, 'output.json'), raw);
    result = { status: assertions.filter(a => a.mode === 'hard').every(a => a.passed) ? 'pass' : 'fail', assertions, result_dir: resultDir };
  } catch (error) {
    result = { status: 'verifier_error', assertions: [], result_dir: resultDir,
      error_kind: error instanceof VerifierError ? error.kind : 'invalid_result',
      reason: error instanceof Error ? error.message : String(error) };
  }
  json(join(resultDir, 'result.json'), result);
  return result;
}
