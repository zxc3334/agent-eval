import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { stageSeeds } from '../src/seed-validation.ts';
import { contentHash, RECEIPT, requireReviewedSuite } from '../src/review.ts';
import { loadCase } from '../src/config.ts';
import { execute, read, runDirs, write } from './helpers.ts';

test('five E6a seeds calibrate through the CLI, preserve evidence isolation and obey reviewed/content gates', t => {
  const root = mkdtempSync(join(tmpdir(), 'e6a-calibration-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const cases = join(root, 'cases'); const runs = join(root, 'runs');
  const refs = stageSeeds(resolve('cases/seeds'), cases);
  assert.deepEqual(refs.map(r => r.id), ['bounded-recovery', 'fixed-retrieval', 'precise-config', 'state-correction', 'tool-result']);
  assert.equal(existsSync('cases/seeds/suite.json'), false, 'source collection stays separate from suite manifests');
  let controls = 0;
  for (const ref of refs) {
    const c = loadCase(cases, 'e6a', ref);
    assert.equal(c.config.type, 'positive');
    assert.equal(c.config.requirement_id, `REQ-E6a-${ref.id}`);
    assert.ok(c.acceptance.criteria.length > 0);
    assert.ok(c.acceptance.error_examples.length > 0);
    assert.equal(c.acceptance.reviewed, false, 'do not impersonate human review');
    controls += c.acceptance.error_examples.length;
  }
  const cmd = execute(['validate', '--suite', 'e6a', '--cases-dir', cases, '--runs-dir', runs]);
  assert.equal(cmd.status, 0, cmd.stdout + cmd.stderr);
  const run = runDirs(runs).at(-1)!; const summary = read(join(run, 'summary.json'));
  assert.deepEqual(summary.solvability, { passed: 5, total: 5 });
  assert.deepEqual(summary.detection, { rejected: controls, attempted: controls, total: controls });
  assert.equal(summary.real_agent_attempted, 0);
  assert.equal(summary.real_agent_pass_rate, null);
  for (const ref of refs) {
    const dir = join(cases, 'e6a', ref.id);
    const receipt = read(join(dir, RECEIPT));
    assert.equal(receipt.status, 'passed');
    assert.equal(receipt.content_hash, contentHash(join(dir, 'case.json')));
    const evidence = read(receipt.evidence);
    assert.equal(evidence.oracle.status, 'pass');
    for (const control of evidence.controls) {
      assert.equal(control.result.status, 'fail');
      assert.deepEqual(control.actual_failed_criteria, [...control.expected_failed_criteria].sort());
      assert.notEqual(control.result.verifier_result_dir, evidence.oracle.verifier_result_dir);
    }
    const oracleInput = read(join(evidence.oracle.events, '../workspace/input.json'));
    assert.equal(oracleInput.fixture, undefined);
    assert.equal(oracleInput.acceptance, undefined);
    assert.equal(read(join(dir, 'acceptance.json')).reviewed, false);
  }
  write(join(cases, 'e6a/suite.json'), { schema_version: 2, formal: true, cases: refs });
  const blockedRuns = join(root, 'blocked-runs');
  const blocked = execute(['--suite', 'e6a', '--case', refs[0].id, '--agent', 'oracle', '--cases-dir', cases, '--runs-dir', blockedRuns]);
  assert.equal(blocked.status, 2);
  assert.match(blocked.stderr, /reviewed gate/);
  assert.equal(runDirs(blockedRuns).length, 0);
  // Simulate the human decision only inside disposable test copies.
  for (const ref of refs) {
    const file = join(cases, 'e6a', ref.id, 'acceptance.json');
    write(file, { ...read(file), reviewed: true });
  }
  assert.doesNotThrow(() => requireReviewedSuite(cases, 'e6a', refs));
  const accepted = execute(['--suite', 'e6a', '--agent', 'oracle', '--cases-dir', cases, '--runs-dir', join(root, 'reviewed-runs')]);
  assert.equal(accepted.status, 0, accepted.stdout + accepted.stderr);
  const input = join(cases, 'e6a', refs[0].id, 'input.json');
  write(input, { prompt: 'Changed requirement after review.' });
  assert.throws(() => requireReviewedSuite(cases, 'e6a', refs), /content hash changed/);
});

test('seed Gold derives results from task data, stops on success and snapshots corrections independently', t => {
  const root = mkdtempSync(join(tmpdir(), 'e6a-gold-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const solve = (id: string, mutate: (state: any) => void, artifact: string) => {
    const source = resolve('cases/seeds', id);
    const state = read(join(source, 'initial-state.json')); mutate(state);
    write(join(root, 'input.json'), { initial_state: state });
    const result = spawnSync(process.execPath, [join(source, 'solve.ts')], { cwd: root, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    return read(join(root, artifact));
  };
  assert.equal(solve('fixed-retrieval', s => { s.documents[2].retention_days = 45; }, 'retrieval.json').retention_days, 45);
  assert.equal(solve('tool-result', s => { s.tool_fixture.result.unit_price_cents = 800; }, 'order.json').total_cents, 2400);
  const config = solve('precise-config', s => { s.request.max_attempts = 7; s.config.extra = { keep: true }; }, 'config.json');
  assert.equal(config.retry.max_attempts, 7); assert.deepEqual(config.extra, { keep: true });
  const recovery = solve('bounded-recovery', s => { s.responses[0] = { status: 'ok', receipt: 'early' }; }, 'recovery.json');
  assert.deepEqual(recovery, { status: 'recovered', attempts: 1, receipt: 'early' });
  assert.equal(read(join(root, 'trace.json')).calls.length, 2);
  const history = solve('state-correction', s => { s.turns[1].changes.destination = 'Wuxi'; }, 'history.json');
  assert.equal(history.snapshots[0].state.destination, 'Suzhou');
  assert.equal(history.snapshots[1].state.destination, 'Wuxi');
  assert.equal(read(join(root, 'state.json')).destination, 'Wuxi');
  // A permanent error cannot consume a later successful response.
  const state = read('cases/seeds/bounded-recovery/initial-state.json');
  state.responses[0] = { status: 'permanent_error' };
  write(join(root, 'input.json'), { initial_state: state });
  const result = spawnSync(process.execPath, [resolve('cases/seeds/bounded-recovery/solve.ts')], { cwd: root, encoding: 'utf8' });
  assert.equal(result.status, 1); assert.match(result.stderr, /Recovery failed within attempt limit/);
});
