import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { normalizeCriteria } from '../src/criteria.ts';
import { loadCase } from '../src/config.ts';
import { validateVerifierOutput, verify } from '../src/verifier.ts';
import type { Criterion, ToolCriterion } from '../src/types.ts';
import { execute, read, runDirs, setup, write } from './helpers.ts';

const target = { artifact: 'trace.json', field: '/calls' };
const args: ToolCriterion = { id: 'args', type: 'tool_args', target,
  params: { tool: 'search', field: '/query', expected: 'alpha' }, mode: 'hard', reason: 'Use the required query.' };
const noWrite: ToolCriterion = { id: 'read-only', type: 'no_write', target,
  params: { read_only_tools: ['search', 'get'] }, mode: 'hard', reason: 'Only read operations are allowed.' };
const unique: ToolCriterion = { id: 'once', type: 'no_duplicate_side_effects', target,
  params: { side_effect_tools: ['send', 'write'] }, mode: 'hard', reason: 'Do not repeat side effects.' };
const call = (tool: string, arguments_: Record<string, unknown>) => ({ tool, arguments: arguments_ });
function sandbox(t: { after: (fn: () => void) => void }) {
  const dir = mkdtempSync(join(tmpdir(), 'agent-eval-tools-'));
  const artifacts = join(dir, 'artifacts'); mkdirSync(artifacts);
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return { dir, artifacts, file: join(artifacts, 'trace.json') };
}

test('tool_args checks every matching call, requires at least one, and keeps call indexes', async t => {
  const s = sandbox(t);
  write(s.file, { calls: [call('get', {}), call('search', { query: 'alpha', limit: 1 }), call('search', { query: 'alpha' })] });
  const passed = await verify([args], s.artifacts, s.dir);
  assert.equal(passed.status, 'pass');
  assert.deepEqual(passed.assertions[0].actual, [{ index: 1, found: true, value: 'alpha' }, { index: 2, found: true, value: 'alpha' }]);
  for (const calls of [[], [call('get', { query: 'alpha' })], [call('search', { query: 'alpha' }), call('search', { query: 'wrong' })]]) {
    write(s.file, { calls });
    const failed = await verify([args], s.artifacts, s.dir);
    assert.equal(failed.status, 'fail'); assert.ok(failed.assertions[0].problem);
  }
});

test('tool arguments use strict deep equality and E4b pointers, including missing versus null', async t => {
  const s = sandbox(t);
  const arguments_ = { 'a/b': { '~key': [false, null, 2] }, obj: { b: 2, a: 1 }, list: [1, 2] };
  write(s.file, { calls: [call('search', arguments_)] });
  const checks: [string, unknown, boolean][] = [
    ['/a~1b/~0key/0', false, true], ['/a~1b/~0key/1', null, true], ['/a~1b/~0key/2', '2', false],
    ['/obj', { a: 1, b: 2 }, true], ['/list', [2, 1], false], ['/missing', null, false],
    ['/constructor', null, false], ['/list/length', 2, false], ['/list/01', 2, false], ['', arguments_, true],
  ];
  const criteria = checks.map(([field, expected], i): Criterion => ({ ...args, id: `args-${i}`, params: { tool: 'search', field, expected } }));
  const result = await verify(criteria, s.artifacts, s.dir);
  assert.deepEqual(result.assertions.map(a => a.passed), checks.map(c => c[2]));
  assert.deepEqual(result.assertions[5].actual, [{ index: 0, found: false, value: null }]);
});

test('no_write permits only declared read tools, rejects unknown tools and ignores claimed safety/success', async t => {
  const s = sandbox(t);
  for (const calls of [[], [call('search', {}), call('search', {}), call('get', {})]]) {
    write(s.file, { calls }); assert.equal((await verify([noWrite], s.artifacts, s.dir)).status, 'pass');
  }
  write(s.file, { calls: [call('get', {}), { ...call('send', { text: 'hi' }), read_only: true, success: false }, call('unknown', {})] });
  const failed = await verify([noWrite], s.artifacts, s.dir);
  assert.equal(failed.status, 'fail');
  assert.deepEqual(failed.assertions[0].expected, []);
  assert.deepEqual(failed.assertions[0].actual, [{ index: 1, tool: 'send', arguments: { text: 'hi' } }, { index: 2, tool: 'unknown', arguments: {} }]);
  write(s.file, { calls: [call('search', {})] });
  assert.equal((await verify([{ ...noWrite, params: { read_only_tools: [] } }], s.artifacts, s.dir)).status, 'fail');
});

test('duplicate side effects ignore object order and attempt metadata but preserve tool, type and array order', async t => {
  const s = sandbox(t);
  const calls = [
    call('search', {}), call('search', {}),
    { ...call('send', { to: 'a', payload: { a: 1, b: [1, 2] } }), id: 'first', success: false },
    call('write', { to: 'a', payload: { a: 1, b: [1, 2] } }),
    call('send', { to: 'a', payload: { b: [2, 1], a: 1 } }),
    call('send', { to: 'a', payload: { b: [1, 2], a: '1' } }),
    { ...call('send', { payload: { b: [1, 2], a: 1 }, to: 'a' }), id: 'retry', success: true },
    call('send', { to: 'a', payload: { a: 1, b: [1, 2] } }),
  ];
  write(s.file, { calls: calls.slice(0, 6) });
  assert.equal((await verify([unique], s.artifacts, s.dir)).status, 'pass');
  write(s.file, { calls });
  const failed = await verify([unique], s.artifacts, s.dir);
  assert.equal(failed.status, 'fail');
  assert.deepEqual(failed.assertions[0].actual, [6, 7].map(index => ({ index, first_index: 2, tool: 'send', arguments: calls[index].arguments })));
  write(s.file, { calls: [] });
  assert.equal((await verify([unique], s.artifacts, s.dir)).status, 'pass');
});

test('missing, malformed and invalid traces fail all tool checks instead of passing an empty trace', async t => {
  const s = sandbox(t);
  const criteria = [args, noWrite, unique];
  const missing = await verify(criteria, s.artifacts, s.dir);
  assert.equal(missing.status, 'fail'); assert.ok(missing.assertions.every(a => /ENOENT/.test(a.problem!)));
  for (const value of [{}, { calls: null }, { calls: {} }, { calls: [null] }, { calls: [{ tool: 'get' }] },
    { calls: [call('search', { query: 'alpha' }), { tool: 'other', arguments: 'raw JSON' }] },
    { calls: [{ tool: '', arguments: {} }] }, { calls: [{ tool: 'get', arguments: [] }] }]) {
    write(s.file, value);
    const result = await verify(criteria, s.artifacts, s.dir);
    assert.equal(result.status, 'fail'); assert.ok(result.assertions.every(a => !a.passed && a.problem));
  }
  for (const text of ['{broken', '{"calls":[{"tool":"search","arguments":{"query":1e999}}]}']) {
    writeFileSync(s.file, text);
    const result = await verify(criteria, s.artifacts, s.dir);
    assert.equal(result.status, 'fail'); assert.ok(result.assertions.every(a => /not finite JSON/.test(a.problem!)));
  }
});

test('tool criterion normalization rejects invalid params and allows a root trace target', () => {
  const root: Criterion = { ...args, target: { ...target, field: '' } };
  assert.deepEqual(normalizeCriteria([root, noWrite, unique], 'acceptance.json'), [root, noWrite, unique]);
  const invalid = [
    ...[{}, { tool: 'search', expected: 1 }, { tool: ' ', field: '', expected: 1 }, { tool: 'search', field: '/bad~2', expected: 1 },
      { tool: 'search', field: '', expected: Infinity }, { ...args.params, extra: true }].map(params => ({ ...args, params })),
    ...[{}, { read_only_tools: 'get' }, { read_only_tools: ['get', 'get'] }, { read_only_tools: [null] },
      { read_only_tools: [' '] }, { read_only_tools: [], extra: true }].map(params => ({ ...noWrite, params })),
    ...[{}, { side_effect_tools: [] }, { side_effect_tools: ['send', 'send'] }, { side_effect_tools: [1] }].map(params => ({ ...unique, params })),
  ];
  for (const c of invalid) assert.throws(() => normalizeCriteria([c], 'acceptance.json'), /acceptance.json: criteria\[0\].params:.*fix:/);
});

test('tool assertions retain the complete E4a evidence contract and coexist with E4b', async t => {
  const s = sandbox(t); const calls = [call('search', { query: 'wrong' })]; write(s.file, { calls, owner: 'Ada' });
  const criteria: Criterion[] = [
    { ...args, mode: 'diagnostic' }, noWrite, unique,
    { id: 'owner', type: 'equals', target: { ...target, field: '/owner' }, params: { expected: 'Ada' }, mode: 'hard', reason: 'Owner field.' },
    { id: 'preserve', type: 'fields_preserved', target: { ...target, field: '' }, params: { baseline: { owner: 'Ada' }, fields: ['/owner'] }, mode: 'hard', reason: 'Preserve owner.' },
  ];
  const original = readFileSync(s.file, 'utf8');
  const passed = await verify(criteria, s.artifacts, s.dir);
  assert.equal(passed.status, 'pass'); assert.equal(passed.assertions[0].passed, false);
  const row = passed.assertions[0];
  assert.deepEqual(row, { criterion_id: args.id, type: args.type, target, params: args.params, mode: 'diagnostic', reason: args.reason,
    expected: 'alpha', actual: [{ index: 0, found: true, value: 'wrong' }], passed: false, artifact: s.file,
    evidence: [{ artifact: s.file, field: '/calls' }], problem: 'tool arguments mismatch or missing field at call indexes: 0' });
  assert.equal(readFileSync(s.file, 'utf8'), original);
  const raw = read(join(passed.result_dir, 'output.json'));
  assert.deepEqual(validateVerifierOutput(raw, criteria, s.artifacts), passed.assertions);
  const forged = structuredClone(raw); forged.assertions[0].evidence[0].field = '/other';
  assert.throws(() => validateVerifierOutput(forged, criteria, s.artifacts), /evidence/);
  const badExpected = structuredClone(raw); badExpected.assertions[1].expected = true;
  assert.throws(() => validateVerifierOutput(badExpected, criteria, s.artifacts), /expected value/);
  const hard = await verify([args, noWrite, unique], s.artifacts, s.dir);
  assert.equal(hard.status, 'fail'); assert.notEqual(hard.result_dir, passed.result_dir);
  assert.equal(read(join(passed.result_dir, 'result.json')).status, 'pass');
  write(s.file, calls);
  assert.equal((await verify([{ ...noWrite, target: { ...target, field: '' } }], s.artifacts, s.dir)).status, 'pass');
});

test('tool verifier faults remain verifier_error for hard and diagnostic modes', async t => {
  const s = sandbox(t); write(s.file, { calls: [call('search', { query: 'alpha' })] });
  for (const [inject, kind] of Object.entries({ verifier_error: 'exception', verifier_timeout: 'timeout', verifier_missing: 'missing_result', verifier_invalid: 'invalid_result' }) as [NonNullable<Parameters<typeof verify>[3]>, string][]) {
    const result = await verify([{ ...args, mode: 'diagnostic' }, noWrite, unique], s.artifacts, s.dir, inject);
    assert.equal(result.status, 'verifier_error'); assert.equal(result.error_kind, kind); assert.deepEqual(result.assertions, []);
    assert.equal(read(join(result.result_dir, 'result.json')).error_kind, kind);
  }
});

test('tools CLI suite persists evidence, diagnostics and reproducible reports; validation catches authoring errors', () => {
  const t = setup();
  try {
    assert.equal(execute(['validate', '--schema-only', '--suite', 'tools', '--cases-dir', t.cases]).status, 0);
    const execution = execute([...t.args, '--suite', 'tools']);
    assert.equal(execution.status, 1, execution.stderr);
    const run = runDirs(t.runs)[0]; const summary = read(join(run, 'summary.json'));
    assert.equal(summary.counts.pass, 2); assert.equal(summary.counts.fail, 4); assert.equal(summary.scored, 6);
    assert.equal(summary.counts.verifier_error, 0);
    for (const id of ['tools-pass', 'tools-diagnostic', 'tools-bad-args', 'tools-write', 'tools-duplicate', 'tools-malformed']) {
      const dir = join(run, 'cases', id); const result = read(join(dir, 'result.json'));
      assert.equal(result.status, ['tools-pass', 'tools-diagnostic'].includes(id) ? 'pass' : 'fail');
      assert.equal(read(join(dir, 'artifacts/answer.json')).success, true);
      assert.equal(result.assertions[0].evidence[0].artifact, join(dir, 'artifacts/trace.json'));
      assert.equal(result.assertions[0].evidence[0].field, '/calls');
      assert.deepEqual(read(join(result.verifier_result_dir, 'result.json')).assertions, result.assertions);
    }
    assert.match(execution.stdout, /args \[diagnostic\]/);
    const report = readFileSync(join(run, 'report.md'), 'utf8');
    assert.match(report, /args \[diagnostic\]: fail/);
    assert.equal(execute(['report', run.split('/').at(-1)!, '--runs-dir', t.runs]).status, 0);
    assert.equal(readFileSync(join(run, 'report.md'), 'utf8'), report);
    assert.equal(execute([...t.args, '--suite', 'tools', '--case', 'tools-pass']).status, 0);
    const dir = join(t.cases, 'tools/tools-pass'); const file = join(dir, 'acceptance.json'); const acceptance = read(file);
    acceptance.criteria[0].params.expected = 'PRIVATE_TOOL_EXPECTED'; write(file, acceptance);
    const loaded = loadCase(t.cases, 'tools', { id: 'tools-pass', version: '1.0.0' });
    assert.doesNotMatch(JSON.stringify(loaded.input), /PRIVATE_TOOL_EXPECTED|read_only_tools|side_effect_tools/);
    acceptance.criteria[0].params.field = '/bad~2'; write(file, acceptance);
    const invalid = execute(['validate', '--schema-only', '--suite', 'tools', '--cases-dir', t.cases]);
    assert.equal(invalid.status, 2); assert.match(invalid.stdout + invalid.stderr, /criteria\[0\].params/);
  } finally { rmSync(t.root, { recursive: true, force: true }); }
});
