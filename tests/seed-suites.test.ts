import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync, rmSync, symlinkSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { loadCase, suiteCases } from '../src/config.ts';
import { requireReviewedSuite } from '../src/review.ts';
import { execute, launch, read, runDirs, setup, until, write } from './helpers.ts';

const notice = /只验证评测链路.*仅验评测链路.*不代表产品\/模型质量/;

test('E6 smoke represents both seed types; full pins every E6a/E6b seed exactly once', () => {
  const full = suiteCases('cases', 'e6-full');
  const expected = ['seeds', 'negative-seeds'].flatMap(source =>
    readdirSync(join('cases', source), { withFileTypes: true }).filter(entry => entry.isDirectory())
      .map(entry => {
        const config = read(join('cases', source, entry.name, 'case.json'));
        return { id: config.id, version: config.version, source };
      }));
  const sort = (refs: typeof full) => [...refs].sort((a, b) => a.id.localeCompare(b.id));
  assert.equal(full.length, 8);
  assert.deepEqual(sort(full), sort(expected));
  const smoke = suiteCases('cases', 'e6-smoke');
  assert.ok(smoke.length > 0 && smoke.length <= 3);
  for (const ref of smoke) assert.ok(full.some(entry => JSON.stringify(entry) === JSON.stringify(ref)));
  assert.deepEqual(new Set(smoke.map(ref => loadCase('cases', 'e6-smoke', ref).config.type)), new Set(['positive', 'negative']));
  for (const suite of ['e6-smoke', 'e6-full']) {
    assert.equal(read(`cases/${suite}/suite.json`).formal, false);
    for (const ref of suiteCases('cases', suite)) {
      const c = loadCase('cases', suite, ref);
      assert.equal(c.file, resolve('cases', ref.source!, ref.id, 'case.json'));
      assert.equal(c.acceptance.reviewed, false);
    }
  }
});

for (const [suite, count] of [['e6-smoke', 3], ['e6-full', 8]] as const) {
  test(`${suite} stub scores all seeds with separate evidence and an offline-rebuildable pipeline-only report`, t => {
    const env = setup(); t.after(() => rmSync(env.root, { recursive: true, force: true }));
    const result = execute([...env.args, '--suite', suite, '--agent', 'stub']);
    assert.equal(result.status, 1, result.stdout + result.stderr);
    assert.match(result.stdout, notice);
    const run = runDirs(env.runs)[0];
    const summary = read(join(run, 'summary.json'));
    assert.equal(summary.attempted, count); assert.equal(summary.scored, count); assert.equal(summary.planned, count);
    assert.deepEqual(summary.counts, { pass: 0, fail: count, agent_error: 0, timeout: 0, verifier_error: 0, environment_error: 0 });
    assert.deepEqual(summary.not_attempted, []);
    assert.equal(summary.evaluation_scope, 'pipeline_only'); assert.match(summary.scope_note, notice);
    assert.equal(summary.real_agent_attempted, 0); assert.equal(summary.real_agent_pass_rate, null);
    const config = read(join(run, 'config.json'));
    assert.deepEqual(config.case_refs, suiteCases(env.cases, suite));
    for (const id of config.case_ids) {
      const dir = join(run, 'cases', id);
      const evidence = read(join(dir, 'result.json'));
      assert.equal(evidence.status, 'fail');
      assert.ok(evidence.assertions.some((a: any) => a.mode === 'hard' && !a.passed));
      assert.ok(existsSync(join(dir, 'artifacts/answer.json')));
      assert.ok(existsSync(evidence.verifier_result_dir));
      assert.ok(existsSync(join(dir, 'events.jsonl')));
      assert.equal(existsSync(join(dir, 'oracle')), false, 'stub never runs Gold');
      const input = read(join(dir, 'workspace/input.json'));
      assert.equal(input.acceptance, undefined); assert.equal(input.source, undefined);
    }
    assert.match(readFileSync(join(run, 'report.md'), 'utf8'), notice);
    rmSync(env.cases, { recursive: true });
    rmSync(join(run, 'report.md'));
    const rebuilt = execute(['report', config.run_id, '--runs-dir', env.runs]);
    assert.equal(rebuilt.status, 0, rebuilt.stderr);
    assert.match(readFileSync(join(run, 'report.md'), 'utf8'), notice);
    assert.deepEqual(read(join(run, 'summary.json')), summary);
  });
}

test('shared references retain path containment, exact versions, unique IDs and the formal review gate', t => {
  const env = setup(); t.after(() => rmSync(env.root, { recursive: true, force: true }));
  const file = join(env.cases, 'e6-smoke/suite.json');
  const manifest = read(file); const ref = manifest.cases[0];
  for (const source of ['../seeds', '/tmp', 'seeds/../seeds', '', null, 42]) {
    write(file, { ...manifest, cases: [{ ...ref, source }] });
    assert.throws(() => suiteCases(env.cases, 'e6-smoke'), /source.*invalid identifier/);
    assert.throws(() => loadCase(env.cases, 'e6-smoke', { ...ref, source }), /source.*invalid identifier/);
  }
  write(file, { ...manifest, cases: [ref, { ...ref, source: 'negative-seeds' }] });
  assert.throws(() => suiteCases(env.cases, 'e6-smoke'), /duplicate id/);
  assert.throws(() => loadCase(env.cases, 'e6-smoke', { ...ref, version: '2.0.0' }), /version: suite pins/);
  symlinkSync(resolve('cases/seeds'), join(env.cases, 'escape'), 'dir');
  assert.throws(() => loadCase(env.cases, 'e6-smoke', { ...ref, source: 'escape' }), /symlink path escapes/);
  write(file, { ...manifest, formal: true });
  const blocked = execute([...env.args, '--suite', 'e6-smoke', '--case', ref.id]);
  assert.equal(blocked.status, 2); assert.match(blocked.stderr, /reviewed gate/);
  assert.deepEqual(runDirs(env.runs), []);
  // Calibration and simulated review are restricted to disposable copies.
  const calibrated = execute(['validate', ...env.args, '--suite', 'e6-smoke']);
  assert.equal(calibrated.status, 0, calibrated.stdout + calibrated.stderr);
  const summary = read(join(runDirs(env.runs)[0], 'summary.json'));
  assert.deepEqual(summary.solvability, { passed: 3, total: 3 });
  assert.deepEqual(summary.detection, { rejected: 7, attempted: 7, total: 7 });
  for (const entry of manifest.cases) {
    const acceptance = join(env.cases, entry.source, entry.id, 'acceptance.json');
    assert.equal(read(acceptance).reviewed, false);
    write(acceptance, { ...read(acceptance), reviewed: true });
  }
  const refs = suiteCases(env.cases, 'e6-smoke');
  assert.doesNotThrow(() => requireReviewedSuite(env.cases, 'e6-smoke', refs));
  const sourceInput = join(env.cases, ref.source, ref.id, 'input.json');
  write(sourceInput, { prompt: 'Changed after calibration.' });
  assert.throws(() => requireReviewedSuite(env.cases, 'e6-smoke', refs), /content hash changed/);
});

test('seed selection and failed-from reuse the registered sources and current fixtures', t => {
  const env = setup(); t.after(() => rmSync(env.root, { recursive: true, force: true }));
  const first = execute([...env.args, '--suite', 'e6-full', '--case', 'fixed-retrieval']);
  assert.equal(first.status, 1, first.stderr);
  const source = runDirs(env.runs)[0]; const config = read(join(source, 'config.json'));
  const fixture = join(env.cases, 'seeds/fixed-retrieval/fixture.json');
  write(fixture, { answer: 'Updated stub response' });
  const retry = execute(['--failed-from', config.run_id, '--runs-dir', env.runs]);
  assert.equal(retry.status, 1, retry.stderr);
  const rerun = runDirs(env.runs)[1]; const saved = read(join(rerun, 'config.json'));
  assert.equal(saved.source_run_id, config.run_id);
  assert.deepEqual(saved.case_refs, config.case_refs);
  assert.deepEqual(saved.case_ids, ['fixed-retrieval']);
  assert.equal(read(join(rerun, 'cases/fixed-retrieval/artifacts/answer.json')).answer, 'Updated stub response');
});

test('watch reruns when a referenced seed changes outside the suite directory', async t => {
  const env = setup();
  const child = launch([...env.args, '--suite', 'e6-smoke', '--case', 'fixed-retrieval', '--watch']);
  t.after(async () => { child.child.kill('SIGTERM'); await child.done; rmSync(env.root, { recursive: true, force: true }); });
  await until(() => runDirs(env.runs).some(dir => existsSync(join(dir, 'summary.json'))));
  write(join(env.cases, 'seeds/fixed-retrieval/fixture.json'), { answer: 'Watch updated response' });
  await until(() => runDirs(env.runs).length >= 2 && existsSync(join(runDirs(env.runs)[1], 'summary.json')));
  const rerun = runDirs(env.runs)[1];
  assert.equal(read(join(rerun, 'cases/fixed-retrieval/artifacts/answer.json')).answer, 'Watch updated response');
});
