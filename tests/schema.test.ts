import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { loadCase, suiteCases } from '../src/config.ts';
import { setup, read, write, execute, runDirs } from './helpers.ts';

const passRef = { id: 'smoke-pass', version: '1.0.0' };

test('all shipped suites pin v2 cases with public inputs and private acceptance materials', () => {
  for (const suite of ['smoke', 'faults']) {
    for (const ref of suiteCases('cases', suite)) {
      const c = loadCase('cases', suite, ref);
      assert.equal(c.config.schema_version, 2);
      assert.equal(c.config.version, ref.version);
      assert.ok(['positive', 'negative'].includes(c.config.type));
      assert.equal(c.input.budgets.max_steps, 1);
      assert.deepEqual(c.input.initial_state, {});
      assert.ok(c.input.artifact_allowlist.includes('answer.json'));
      assert.deepEqual(c.acceptance.gold, { answer: 'hello' });
      assert.equal(c.acceptance.criteria[0].type, 'equals');
      assert.ok(c.acceptance.error_examples.length > 0);
      assert.equal(c.acceptance.reviewed, false);
    }
  }
  assert.equal(loadCase('cases', 'smoke', passRef).config.type, 'positive');
  assert.equal(loadCase('cases', 'smoke', { id: 'smoke-fail', version: '1.0.0' }).config.type, 'negative');
});

test('suite requires exact versions and rejects mismatches before starting a run', () => {
  const t = setup(); const file = join(t.cases, 'smoke/suite.json');
  try {
    for (const version of [undefined, 'latest', '^1.0.0', '1.*', '01.0.0']) {
      write(file, { schema_version: 2, cases: [{ id: 'smoke-pass', version }] });
      assert.throws(() => suiteCases(t.cases, 'smoke'), /version.*expected exact version/);
    }
    write(file, { schema_version: 2, cases: [passRef, passRef] });
    assert.throws(() => suiteCases(t.cases, 'smoke'), /duplicate id/);
    write(file, { cases: ['smoke-pass'] });
    assert.throws(() => suiteCases(t.cases, 'smoke'), /schema_version.*migrate v1/);
    write(file, { schema_version: 2, cases: [{ ...passRef, version: '2.0.0' }] });
    const result = execute(t.args);
    assert.equal(result.status, 2);
    assert.match(result.stderr, /version: suite pins 2.0.0, found 1.0.0/);
    assert.deepEqual(runDirs(t.runs), []);
  } finally { rmSync(t.root, { recursive: true, force: true }); }
});

test('v2 required case and acceptance fields fail with a field-level diagnostic', () => {
  const t = setup(); const dir = join(t.cases, 'smoke/smoke-pass');
  const configFile = join(dir, 'case.json'); const config = read(configFile);
  const acceptanceFile = join(dir, 'acceptance.json'); const acceptance = read(acceptanceFile);
  const load = () => loadCase(t.cases, 'smoke', passRef);
  try {
    for (const field of ['schema_version', 'version', 'type', 'initial_state', 'artifact_allowlist', 'budgets']) {
      const broken = { ...config }; delete broken[field]; write(configFile, broken);
      assert.throws(load, new RegExp(field === 'budgets' ? 'budgets.timeout_ms' : field));
    }
    for (const budgets of [{ timeout_ms: 0, max_steps: 1 }, { timeout_ms: 100, max_steps: 0 }]) {
      write(configFile, { ...config, budgets }); assert.throws(load, /budgets/);
    }
    for (const artifact_allowlist of [['../answer.json'], ['answer.json', '../secret'], ['answer.json', 'input.json']]) {
      write(configFile, { ...config, artifact_allowlist }); assert.throws(load, /artifact_allowlist/);
    }
    write(configFile, config);
    for (const field of ['gold', 'criteria', 'error_examples', 'reviewed']) {
      const broken = { ...acceptance }; delete broken[field]; write(acceptanceFile, broken);
      assert.throws(load, new RegExp(field));
    }
    write(acceptanceFile, { ...acceptance, reviewed: 'yes' });
    assert.throws(load, /reviewed/);
    write(acceptanceFile, acceptance);
    write(join(dir, 'initial-state.json'), []); assert.throws(load, /initial_state/);
  } finally { rmSync(t.root, { recursive: true, force: true }); }
});

test('serialized AgentInput excludes private fields and experiment choices; artifacts obey allowlist', () => {
  const t = setup(); const dir = join(t.cases, 'smoke/smoke-pass');
  const experiment = join(t.root, 'experiment.json');
  const privateFields = {
    gold: { answer: 'PRIVATE_GOLD_SENTINEL' },
    criteria: [{ id: 'private-criterion', type: 'equals', expected: 'hello' }],
    error_examples: [{ answer: 'PRIVATE_ERROR_SENTINEL', reason: 'private explanation' }],
    reviewed: true,
  };
  try {
    write(join(dir, 'acceptance.json'), privateFields);
    // Extra metadata in authored input must not be forwarded by a spread/cast.
    write(join(dir, 'input.json'), { prompt: 'Public task', ...privateFields, adapter: 'private-adapter', model: 'PRIVATE_MODEL', product: { token: 'PRIVATE_PRODUCT' } });
    write(join(dir, 'fixture.json'), { answer: 'hello', ...privateFields });
    write(join(dir, 'initial-state.json'), { greeting_seen: false });
    const config = read(join(dir, 'case.json'));
    write(join(dir, 'case.json'), { ...config, artifact_allowlist: ['answer.json'], budgets: { ...config.budgets, gold: 'PRIVATE_BUDGET_EXTRA' } });
    write(experiment, { adapter: 'stub', model: 'PRIVATE_MODEL', product: { name: 'PRIVATE_PRODUCT' } });
    const result = execute([...t.args, '--case', 'smoke-pass', '--experiment', experiment]);
    assert.equal(result.status, 0, result.stderr);
    const run = runDirs(t.runs)[0]; const caseDir = join(run, 'cases/smoke-pass');
    const publicFile = join(caseDir, 'workspace/input.json'); const input = read(publicFile);
    assert.deepEqual(input, {
      prompt: 'Public task', fixture: { answer: 'hello' }, initial_state: { greeting_seen: false },
      artifact_allowlist: ['answer.json'], budgets: { timeout_ms: 2000, max_steps: 1 },
    });
    assert.doesNotMatch(readFileSync(publicFile, 'utf8'), /PRIVATE_|gold|criteria|error_examples|reviewed|adapter|model|product|acceptance/);
    assert.deepEqual(readdirSync(join(caseDir, 'workspace')).sort(), ['answer.json', 'clock.cjs', 'fixture.json', 'initial-state.json', 'input.json', 'resource.json', 'session.json']);
    for (const name of ['fixture.json', 'initial-state.json', 'session.json']) assert.doesNotMatch(readFileSync(join(caseDir, 'workspace', name), 'utf8'), /PRIVATE_|criteria|error_examples|acceptance/);
    assert.deepEqual(readdirSync(join(caseDir, 'frozen')).sort(), ['answer.json']);
    assert.deepEqual(readdirSync(join(caseDir, 'artifacts')).sort(), ['answer.json', 'stderr.log', 'stdout.log']);
    assert.deepEqual(read(join(caseDir, 'snapshot.json')).acceptance, privateFields);
    const saved = read(join(run, 'config.json'));
    assert.deepEqual(saved.case_refs, [passRef]);
    assert.deepEqual(saved.experiment, read(experiment));
    assert.equal(saved.experiment_file, experiment);
    assert.ok(!existsSync(join(caseDir, 'workspace/acceptance.json')));
  } finally { rmSync(t.root, { recursive: true, force: true }); }
});
