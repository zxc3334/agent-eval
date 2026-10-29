import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { normalizeCriteria } from '../src/criteria.ts';
import { loadCase } from '../src/config.ts';
import { validateVerifierOutput, verify } from '../src/verifier.ts';
import type { Criterion } from '../src/types.ts';
import { execute, read, runDirs, setup, write } from './helpers.ts';

function equals(field: string, expected: unknown, id = 'field'): Criterion {
  return { id, type: 'equals', target: { artifact: 'config.json', field }, params: { expected }, mode: 'hard', reason: 'Check a structured requirement.' };
}
const parseable: Criterion = { id: 'parse', type: 'json_parseable', target: { artifact: 'config.json', field: '' }, params: {}, mode: 'hard', reason: 'The file must parse.' };
const baseline = { theme: 'light', profile: { owner: 'Ada', labels: ['a', 'b'] }, enabled: false, nullable: null };
const preserved: Criterion = { id: 'keep', type: 'fields_preserved', target: parseable.target,
  params: { baseline, fields: ['/profile', '/enabled', '/nullable'] }, mode: 'hard', reason: 'Preserve unrelated fields.' };
function sandbox(t: { after: (fn: () => void) => void }) {
  const dir = mkdtempSync(join(tmpdir(), 'agent-eval-fields-'));
  const artifacts = join(dir, 'artifacts'); mkdirSync(artifacts);
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return { dir, artifacts, file: join(artifacts, 'config.json') };
}

test('structured assertions resolve nested fields, array items, literal keys and escaped JSON Pointers', async t => {
  const s = sandbox(t);
  const document = { nested: { rows: [{ count: 2 }], no: false, nil: null }, 'a/b': { '~key': 7 }, 'a.b': 'literal', '': 'empty' };
  write(s.file, document);
  const selections: [string, unknown][] = [['/nested/rows/0/count', 2], ['/nested/no', false], ['/nested/nil', null],
    ['/a~1b/~0key', 7], ['a.b', 'literal'], ['/', 'empty'], ['', document], ['/nested/rows', [{ count: 2 }]]];
  const result = await verify(selections.map(([field, value], i) => equals(field, value, `field-${i}`)), s.artifacts, s.dir);
  assert.equal(result.status, 'pass');
  assert.equal(result.assertions.length, selections.length);
  assert.deepEqual(result.assertions[3].evidence, [{ artifact: s.file, field: '/a~1b/~0key' }]);
  for (const a of result.assertions) assert.deepEqual(a.actual, a.expected);
});

test('missing fields cannot equal null; types, array order and own-property boundaries are strict', async t => {
  const s = sandbox(t); write(s.file, { value: 2, rows: ['a', 'b'], nil: null });
  const checks = [equals('/missing', null, 'missing'), equals('/value', '2', 'type'), equals('/rows', ['b', 'a'], 'order'),
    equals('/rows/length', 2, 'length'), equals('/rows/01', 'b', 'index'), equals('/constructor', null, 'inherited'), equals('/nil/child', null, 'null-child')];
  const result = await verify(checks, s.artifacts, s.dir);
  assert.equal(result.status, 'fail'); assert.ok(result.assertions.every(a => !a.passed));
  assert.match(result.assertions[0].problem!, /missing field/);
  assert.equal(result.assertions[0].actual, null);
  assert.doesNotMatch(JSON.stringify(result), /undefined/);
  writeFileSync(s.file, '{"__proto__":{"kept":true}}');
  assert.equal((await verify([equals('/__proto__/kept', true)], s.artifacts, s.dir)).status, 'pass');
});

test('parseable accepts all finite JSON roots and fails missing, malformed, nonfinite and nonregular artifacts', async t => {
  const s = sandbox(t);
  for (const value of [null, false, 0, 'text', [], {}]) {
    write(s.file, value);
    assert.equal((await verify([parseable, equals('', value)], s.artifacts, s.dir)).status, 'pass');
  }
  for (const text of ['', '{bad', '{"x":1e999}', '{"x":1} trailing']) {
    writeFileSync(s.file, text);
    const result = await verify([parseable], s.artifacts, s.dir);
    assert.equal(result.status, 'fail'); assert.match(result.assertions[0].problem!, /not finite JSON/);
  }
  rmSync(s.file);
  const missing = await verify([parseable], s.artifacts, s.dir);
  assert.equal(missing.status, 'fail'); assert.match(missing.assertions[0].problem!, /ENOENT/);
  mkdirSync(s.file);
  assert.equal((await verify([parseable], s.artifacts, s.dir)).status, 'fail');
  rmSync(s.file, { recursive: true });
  write(join(s.dir, 'outside.json'), { secret: true }); symlinkSync(join(s.dir, 'outside.json'), s.file);
  const linked = await verify([parseable], s.artifacts, s.dir);
  assert.equal(linked.status, 'fail'); assert.match(linked.assertions[0].problem!, /not a regular file/);
});

test('preservation ignores formatting, key order and unselected changes, but detects modification and removal', async t => {
  const s = sandbox(t);
  const changed = { nullable: null, enabled: false, profile: { labels: ['a', 'b'], owner: 'Ada' }, theme: 'dark', extra: 1 };
  const text = JSON.stringify(changed, null, 4); writeFileSync(s.file, text);
  const before = JSON.stringify(preserved);
  const result = await verify([parseable, equals('/theme', 'dark'), preserved], s.artifacts, s.dir);
  assert.equal(result.status, 'pass');
  assert.deepEqual(result.assertions[2].expected, { '/profile': baseline.profile, '/enabled': false, '/nullable': null });
  assert.equal(readFileSync(s.file, 'utf8'), text); assert.equal(JSON.stringify(preserved), before);
  for (const value of [
    { ...changed, profile: { ...changed.profile, owner: 'Grace' } },
    { ...changed, profile: { ...changed.profile, labels: ['b', 'a'] } },
    { ...changed, enabled: 0 },
    { theme: 'dark', profile: changed.profile, enabled: false },
  ]) {
    write(s.file, value);
    const failed = await verify([preserved], s.artifacts, s.dir);
    assert.equal(failed.status, 'fail'); assert.equal(failed.assertions[0].passed, false);
  }
  const removedNull = await verify([preserved], s.artifacts, s.dir);
  assert.match(removedNull.assertions[0].problem!, /nullable/);
});

test('new criteria reject malformed targets, params and baselines before running', () => {
  assert.deepEqual(normalizeCriteria([parseable, preserved], 'acceptance.json'), [parseable, preserved]);
  const bad = [
    { ...preserved, type: ['fields_preserved'] },
    ...['../config.json', '/config.json', 'sub/config.json', 'sub\\config.json', 'input.json', 'stdout.log', 'C:\\config.json'].map(artifact => ({ ...parseable, target: { artifact, field: '' } })),
    { ...equals('/bad~2escape', 1) }, { ...parseable, target: { ...parseable.target, field: '/theme' } },
    { ...parseable, params: { expected: true } }, { ...preserved, params: { baseline, fields: [] } },
    { ...preserved, params: { baseline, fields: ['/nullable', '/nullable'] } },
    { ...preserved, params: { baseline, fields: ['/absent'] } }, { ...preserved, params: { fields: ['/theme'] } },
    { ...preserved, params: { baseline: { value: Infinity }, fields: ['/value'] } },
    { ...preserved, params: { baseline, fields: [3] } }, { ...preserved, params: { baseline, fields: ['/theme'], extra: true } },
  ];
  for (const criterion of bad) assert.throws(() => normalizeCriteria([criterion], 'acceptance.json'), /acceptance.json: criteria\[0\].*fix:/);
});

test('loader validates allowlisted targets and stub file fixtures without leaking private baselines', () => {
  const t = setup();
  try {
    const dir = join(t.cases, 'fields/fields-pass-a');
    const configFile = join(dir, 'case.json'); const config = read(configFile);
    const load = () => loadCase(t.cases, 'fields', { id: 'fields-pass-a', version: '1.0.0' });
    const acceptanceFile = join(dir, 'acceptance.json'); const acceptance = read(acceptanceFile);
    acceptance.criteria[2].params.baseline.profile.owner = 'PRIVATE_BASELINE_ONLY'; write(acceptanceFile, acceptance);
    const loaded = load();
    assert.ok(loaded.input.fixture.files?.['config.json']);
    assert.doesNotMatch(JSON.stringify(loaded.input), /PRIVATE_BASELINE_ONLY|criteria|gold|reviewed/);
    write(configFile, { ...config, artifact_allowlist: ['answer.json'] });
    assert.throws(load, /files|artifact_allowlist/);
    write(configFile, config);
    const fixtureFile = join(dir, 'fixture.json'); const fixture = read(fixtureFile);
    for (const files of [{ '../outside.json': '{}' }, { 'answer.json': '{}' }, { 'config.json': {} }, []]) {
      write(fixtureFile, { ...fixture, files }); assert.throws(load, /fixture.json: files:.*fix:/);
    }
    write(fixtureFile, fixture);
    acceptance.criteria[0].target.artifact = 'not-allowlisted.json'; write(acceptanceFile, acceptance);
    assert.throws(load, /criteria\[0\].target.artifact: not in artifact_allowlist/);
  } finally { rmSync(t.root, { recursive: true, force: true }); }
});

test('missing diagnostic artifacts remain visible and do not affect hard verdict; faults stay verifier_error', async t => {
  const s = sandbox(t); write(s.file, { theme: 'dark' });
  const diagnostic: Criterion = { ...parseable, mode: 'diagnostic', target: { artifact: 'optional.json', field: '' } };
  const result = await verify([equals('/theme', 'dark'), diagnostic], s.artifacts, s.dir);
  assert.equal(result.status, 'pass'); assert.deepEqual(result.assertions.map(a => a.passed), [true, false]);
  assert.match(result.assertions[1].problem!, /ENOENT/);
  for (const inject of ['verifier_error', 'verifier_invalid'] as const) {
    const fault = await verify([parseable, preserved], s.artifacts, s.dir, inject);
    assert.equal(fault.status, 'verifier_error'); assert.deepEqual(fault.assertions, []);
    assert.equal(read(join(fault.result_dir, 'result.json')).status, 'verifier_error');
  }
});

test('new verifier output validates expected projections and failure diagnostics at the worker boundary', async t => {
  const s = sandbox(t); write(s.file, baseline);
  const result = await verify([parseable, preserved], s.artifacts, s.dir);
  const raw = read(join(result.result_dir, 'output.json'));
  assert.equal(validateVerifierOutput(raw, [parseable, preserved], s.artifacts).length, 2);
  const forged = structuredClone(raw); forged.assertions[1].expected['/nullable'] = 'forged';
  assert.throws(() => validateVerifierOutput(forged, [parseable, preserved], s.artifacts), /expected value/);
  for (const problem of [42, '', 'cannot read']) {
    const malformed = structuredClone(raw); malformed.assertions[0].problem = problem;
    assert.throws(() => validateVerifierOutput(malformed, [parseable, preserved], s.artifacts), /problem diagnostic/);
  }
});

test('CLI examples accept two different correct outputs and fail keywords, malformed files and clobbered fields', () => {
  const t = setup();
  try {
    const execution = execute([...t.args, '--suite', 'fields']);
    assert.equal(execution.status, 1, execution.stderr);
    assert.match(execution.stdout, /problem: artifact cannot be read: ENOENT/);
    const run = runDirs(t.runs)[0];
    const summary = read(join(run, 'summary.json'));
    assert.equal(summary.counts.pass, 2); assert.equal(summary.counts.fail, 3);
    assert.equal(summary.counts.verifier_error, 0); assert.equal(summary.scored, 5);
    const result = (id: string) => read(join(run, 'cases', id, 'result.json'));
    assert.equal(result('fields-pass-a').status, 'pass'); assert.equal(result('fields-pass-b').status, 'pass');
    assert.equal(result('fields-pass-b').assertions[3].passed, false);
    assert.notDeepEqual(read(join(run, 'cases/fields-pass-a/artifacts/answer.json')), read(join(run, 'cases/fields-pass-b/artifacts/answer.json')));
    for (const id of ['fields-missing', 'fields-malformed', 'fields-clobbered']) {
      assert.equal(result(id).status, 'fail');
      assert.equal(read(join(run, 'cases', id, 'artifacts/answer.json')).success, true);
      assert.equal(result(id).assertions.length, 4);
    }
    assert.deepEqual(result('fields-clobbered').assertions.map((a: { passed: boolean }) => a.passed), [true, true, false, true]);
    const reportFile = join(run, 'report.md'); const report = readFileSync(reportFile, 'utf8');
    assert.match(report, /problem: artifact cannot be read: ENOENT/);
    assert.equal(execute(['report', run.split('/').at(-1)!, '--runs-dir', t.runs]).status, 0);
    assert.equal(readFileSync(reportFile, 'utf8'), report);
    assert.equal(execute([...t.args, '--suite', 'fields', '--case', 'fields-pass-b']).status, 0);
  } finally { rmSync(t.root, { recursive: true, force: true }); }
});
