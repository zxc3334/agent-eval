import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { normalizeCriteria } from '../src/criteria.ts';
import { validateVerifierOutput, verify } from '../src/verifier.ts';
import type { Criterion } from '../src/types.ts';
import { addCase, execute, read, runDirs, setup, write, writeSuite } from './helpers.ts';

function criterion(id: string, mode: Criterion['mode'], expected: unknown): Criterion {
  return { id, type: 'equals', target: { artifact: 'answer.json', field: 'answer' }, params: { expected }, mode, reason: `Check requirement ${id}` };
}
const hard = criterion('must-match', 'hard', 'hello');
const diagnostic = criterion('hint', 'diagnostic', 'other');

test('criterion protocol validates complete metadata and keeps legacy IDs stable', () => {
  const legacy = { id: 'answer-equals', type: 'equals', expected: null };
  const normalized = normalizeCriteria([legacy, diagnostic], 'acceptance.json');
  assert.equal(normalized[0].id, legacy.id);
  assert.equal(normalized[0].mode, 'hard');
  assert.deepEqual(normalized[0].params, { expected: null });
  assert.deepEqual(normalized[0].target, hard.target);
  assert.ok(normalized[0].reason.length > 0);
  assert.deepEqual(normalized[1], diagnostic);
  for (const field of ['target', 'params', 'mode', 'reason']) {
    const broken: Record<string, unknown> = { ...hard }; delete broken[field];
    assert.throws(() => normalizeCriteria([broken], 'acceptance.json'), new RegExp(field));
  }
  for (const broken of [
    { ...hard, reason: ' ' }, { ...hard, id: '../x' }, { ...hard, mode: 'soft' },
    { ...hard, target: { artifact: 'stdout.log', field: 'answer' } },
    { ...hard, params: {} }, { ...hard, expected: 'ambiguous' },
    { ...hard, params: { expected: { nested: Infinity } } },
  ]) assert.throws(() => normalizeCriteria([broken], 'acceptance.json'), /acceptance.json: criteria\[0\].*fix:/);
  assert.throws(() => normalizeCriteria([hard, hard], 'acceptance.json'), /unique id/);
  assert.throws(() => normalizeCriteria([], 'acceptance.json'), /nonempty/);
});

test('hard alone controls the verdict; adapter self reports cannot grant or deny a pass', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'agent-eval-criteria-'));
  const artifacts = join(dir, 'artifacts'); mkdirSync(artifacts);
  try {
    write(join(artifacts, 'answer.json'), { answer: 'hello', success: false, status: 'fail' });
    const passed = await verify([hard, diagnostic], artifacts, dir);
    assert.equal(passed.status, 'pass');
    assert.deepEqual(passed.assertions.map(a => a.passed), [true, false]);
    assert.deepEqual(passed.assertions[1], {
      criterion_id: diagnostic.id, type: 'equals', mode: 'diagnostic', reason: diagnostic.reason,
      target: diagnostic.target, params: diagnostic.params, expected: 'other', actual: 'hello', passed: false,
      artifact: join(artifacts, 'answer.json'), evidence: [{ artifact: join(artifacts, 'answer.json'), field: 'answer' }],
    });
    const saved = readFileSync(join(passed.result_dir, 'result.json'), 'utf8');
    write(join(artifacts, 'answer.json'), { answer: 'wrong', success: true, status: 'pass', score: 1 });
    const failed = await verify([hard, criterion('helpful', 'diagnostic', 'wrong')], artifacts, dir);
    assert.equal(failed.status, 'fail');
    assert.deepEqual(failed.assertions.map(a => a.passed), [false, true]);
    const onlyDiagnostics = await verify([diagnostic], artifacts, dir);
    assert.equal(onlyDiagnostics.status, 'pass');
    const errored = await verify([hard], artifacts, dir, 'verifier_missing');
    assert.equal(errored.status, 'verifier_error');
    assert.equal(new Set([passed, failed, onlyDiagnostics, errored].map(r => r.result_dir)).size, 4);
    assert.equal(readFileSync(join(passed.result_dir, 'result.json'), 'utf8'), saved);
    assert.deepEqual(read(join(errored.result_dir, 'result.json')).assertions, []);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('verifier result boundary rejects missing, duplicate, unknown, malformed and nonfinite results', () => {
  const artifacts = '/local/artifacts';
  const valid = { criterion_id: hard.id, expected: 'hello', actual: 'hello', passed: true,
    evidence: [{ artifact: join(artifacts, 'answer.json'), field: 'answer' }] };
  const check = (raw: unknown) => validateVerifierOutput(raw, [hard], artifacts);
  assert.equal(check({ assertions: [valid] })[0].mode, 'hard');
  for (const raw of [undefined, null, {}, { assertions: [] }]) assert.throws(() => check(raw), /missing/);
  for (const field of ['expected', 'actual', 'passed', 'evidence']) {
    const row: Record<string, unknown> = { ...valid }; delete row[field];
    assert.throws(() => check({ assertions: [row] }), /missing/);
  }
  for (const row of [
    { ...valid, passed: 1 }, { ...valid, criterion_id: 'rogue' }, { ...valid, expected: 'wrong' },
    { ...valid, evidence: [] }, { ...valid, evidence: [{ artifact: '../forged.json', field: 'answer' }] },
    ...[NaN, Infinity, -Infinity, undefined].map(actual => ({ ...valid, actual: { nested: [actual] } })),
  ]) assert.throws(() => check({ assertions: [row] }));
  assert.throws(() => check({ assertions: [valid, valid] }), /unexpected/);
  assert.throws(() => validateVerifierOutput({ assertions: [valid, valid] }, [hard, diagnostic], artifacts), /duplicate/);
  assert.throws(() => check({ assertions: [valid], score: NaN }), /finite/);
});

test('CLI keeps diagnostic failures visible without affecting exit code and preserves all hard gates', () => {
  const t = setup(); const file = join(t.cases, 'smoke/smoke-pass/acceptance.json');
  try {
    write(file, { ...read(file), criteria: [hard, diagnostic] });
    const first = execute([...t.args, '--case', 'smoke-pass']);
    assert.equal(first.status, 0, first.stderr);
    assert.match(first.stdout, /hint \[diagnostic\]/);
    const firstDir = runDirs(t.runs)[0];
    const resultFile = join(firstDir, 'cases/smoke-pass/result.json');
    const saved = readFileSync(resultFile, 'utf8');
    assert.equal(read(resultFile).status, 'pass');
    assert.equal(read(join(firstDir, 'summary.json')).scored, 1);
    assert.match(readFileSync(join(firstDir, 'report.md'), 'utf8'), /hint \[diagnostic\]: fail/);
    const raw = read(join(firstDir, 'cases/smoke-pass/artifacts/answer.json'));
    assert.equal(raw.success, true);
    write(file, { ...read(file), criteria: [hard, { ...diagnostic, mode: 'hard' }] });
    assert.equal(execute([...t.args, '--case', 'smoke-pass']).status, 1);
    const dirs = runDirs(t.runs); assert.equal(dirs.length, 2);
    const secondDir = dirs.find(d => d !== firstDir)!;
    assert.equal(read(join(secondDir, 'cases/smoke-pass/result.json')).status, 'fail');
    assert.equal(readFileSync(resultFile, 'utf8'), saved);
    assert.notEqual(read(resultFile).verifier_result_dir, read(join(secondDir, 'cases/smoke-pass/result.json')).verifier_result_dir);
    // The report can still be rebuilt entirely from saved results.
    const report = readFileSync(join(firstDir, 'report.md'), 'utf8');
    assert.equal(execute(['report', firstDir.split('/').at(-1)!, '--runs-dir', t.runs]).status, 0);
    assert.equal(readFileSync(join(firstDir, 'report.md'), 'utf8'), report);
  } finally { rmSync(t.root, { recursive: true, force: true }); }
});

test('verifier exception, blocked worker timeout, missing result and NaN all persist as verifier_error', () => {
  const t = setup();
  const faults = { verifier_error: 'exception', verifier_timeout: 'timeout', verifier_missing: 'missing_result', verifier_invalid: 'invalid_result' };
  try {
    for (const fault of Object.keys(faults)) addCase(t.cases, fault, fault);
    writeSuite(t.cases, Object.keys(faults));
    const execution = execute(t.args);
    assert.equal(execution.status, 2, execution.stderr);
    const dir = runDirs(t.runs)[0];
    for (const [fault, kind] of Object.entries(faults)) {
      const result = read(join(dir, 'cases', fault, 'result.json'));
      assert.equal(result.status, 'verifier_error'); assert.equal(result.stage, 'verifier');
      assert.deepEqual(result.assertions, []);
      assert.match(result.reason, new RegExp(kind));
      const verifier = read(join(result.verifier_result_dir, 'result.json'));
      assert.equal(verifier.error_kind, kind); assert.equal(verifier.status, 'verifier_error');
      assert.deepEqual(verifier.assertions, []);
      assert.equal(read(join(dir, 'cases', fault, 'artifacts/answer.json')).success, true);
    }
    const summary = read(join(dir, 'summary.json'));
    assert.equal(summary.counts.verifier_error, 4); assert.equal(summary.scored, 0);
    assert.equal(summary.scoring_coverage, 0); assert.equal(summary.exit_code, 2);
  } finally { rmSync(t.root, { recursive: true, force: true }); }
});
