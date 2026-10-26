import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, existsSync, linkSync, mkdirSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { validateSchema } from '../src/validation.ts';
import { loadCase } from '../src/config.ts';
import { createCase } from '../src/scaffold.ts';
import { execute, read, runDirs, setup, write } from './helpers.ts';

const ref = { id: 'smoke-pass', version: '1.0.0' };
const validate = (cases: string, suite = 'smoke') => execute(['validate', '--schema-only', '--cases-dir', cases, '--suite', suite], dirname(cases));

test('schema-only accepts smoke, fault injection and fresh scaffold without executing or writing', () => {
  const t = setup();
  try {
    createCase(t.cases, 'local', 'draft', 'REQ-E3c');
    // Even a valid maximum delay and tiny runtime budget must not start the adapter.
    const dir = join(t.cases, 'local/draft');
    write(join(dir, 'fixture.json'), { answer: 'stub', delay_ms: 300000 });
    const config = read(join(dir, 'case.json'));
    write(join(dir, 'case.json'), { ...config, budgets: { timeout_ms: 1, max_steps: 1 } });
    const before = readFileSync(join(dir, 'case.json'), 'utf8');
    // This cwd has no experiments/stub.json; schema-only must not require one.
    assert.equal(execute(['validate', '--schema-only', '--cases-dir', t.cases], t.root).status, 0);
    for (const [suite, count] of [['smoke', 2], ['faults', 5], ['local', 1]] as const) {
      assert.deepEqual(validateSchema(t.cases, suite), { checked: count, errors: [] });
      const result = validate(t.cases, suite);
      assert.equal(result.status, 0, result.stderr);
      assert.match(result.stdout, new RegExp(`checked ${count} case\\(s\\), 0 error`));
      assert.doesNotMatch(result.stdout, /Run directory|PASS|FAIL|Report:/);
    }
    assert.equal(readFileSync(join(dir, 'case.json'), 'utf8'), before);
    assert.ok(!existsSync(t.runs));
  } finally { rmSync(t.root, { recursive: true, force: true }); }
});

test('schema-only reports suite duplicate IDs and invalid references with file, field and fix', () => {
  const t = setup(); const file = join(t.cases, 'smoke/suite.json');
  const examples = [
    { cases: [ref, ref], field: 'cases[1].id', detail: 'duplicate id' },
    { cases: [{ ...ref, id: '../escape' }], field: 'cases[0].id', detail: 'invalid identifier' },
    { cases: [{ id: ref.id }], field: 'cases[0].version', detail: 'expected exact version' },
    { cases: [{ ...ref, version: '^1.0.0' }], field: 'cases[0].version', detail: 'expected exact version' },
    { cases: [{ ...ref, id: 'missing' }], field: 'cases[missing]', detail: 'missing/case.json' },
    { cases: [], field: 'cases', detail: 'expected nonempty' },
  ];
  try {
    for (const example of examples) {
      write(file, { schema_version: 2, cases: example.cases });
      const result = validate(t.cases);
      assert.equal(result.status, 2, result.stdout);
      for (const part of [file, example.field, example.detail, 'fix:']) assert.ok(result.stderr.includes(part), result.stderr);
    }
    writeFileSync(file, '{broken');
    assert.match(validate(t.cases).stderr, /suite.json: JSON\/read:.*fix:/);
    rmSync(file);
    assert.match(validate(t.cases).stderr, /suite.json: suite:.*fix:/);
  } finally { rmSync(t.root, { recursive: true, force: true }); }
});

test('schema-only diagnoses missing files, invalid versions, IDs, budgets and criteria', () => {
  const t = setup(); const dir = join(t.cases, 'smoke/smoke-pass');
  const file = join(dir, 'case.json'); const config = read(file);
  try {
    const mutations: { patch: Record<string, unknown>; field: string; detail: string }[] = [
      { patch: { id: 'other' }, field: 'id', detail: 'expected smoke-pass' },
      { patch: { version: '2.0.0' }, field: 'version', detail: 'suite pins 1.0.0' },
      { patch: { version: 'latest' }, field: 'version', detail: 'expected exact version' },
    ];
    for (const field of ['input', 'fixture', 'initial_state', 'acceptance', 'brief']) {
      mutations.push({ patch: { [field]: 'missing.json' }, field, detail: 'missing.json' });
      for (const path of ['../outside.json', '/tmp/outside.json', 'C:\\outside.json']) {
        mutations.push({ patch: { [field]: path }, field, detail: 'path must stay inside' });
      }
    }
    for (const timeout_ms of [undefined, 0, -1, 300001, 1.5, '2000', null]) {
      mutations.push({ patch: { budgets: { timeout_ms, max_steps: 1 } }, field: 'budgets.timeout_ms', detail: 'integer 1..300000' });
    }
    for (const max_steps of [undefined, 0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, '1', null]) {
      mutations.push({ patch: { budgets: { timeout_ms: 2000, max_steps } }, field: 'budgets.max_steps', detail: 'positive safe integer' });
    }
    for (const { patch, field, detail } of mutations) {
      write(file, { ...config, ...patch });
      const result = validateSchema(t.cases, 'smoke');
      assert.equal(result.checked, 2);
      assert.equal(result.errors.length, 1, JSON.stringify(patch));
      for (const part of [file, field, detail, 'fix:']) assert.ok(result.errors[0].includes(part), result.errors[0]);
    }
    write(file, { ...config, budgets: { timeout_ms: 300000, max_steps: Number.MAX_SAFE_INTEGER } });
    assert.deepEqual(validateSchema(t.cases, 'smoke').errors, []);
    write(file, config);
    const acceptanceFile = join(dir, 'acceptance.json'); const acceptance = read(acceptanceFile);
    write(acceptanceFile, { ...acceptance, criteria: [acceptance.criteria[0], acceptance.criteria[0]] });
    assert.match(validate(t.cases).stderr, /acceptance.json: criteria\[1\]:.*unique id.*fix:/);
  } finally { rmSync(t.root, { recursive: true, force: true }); }
});

test('schema-only collects independent case errors and never emits run artifacts on failure', () => {
  const t = setup();
  try {
    rmSync(join(t.cases, 'smoke/smoke-pass/input.json'));
    const file = join(t.cases, 'smoke/smoke-fail/case.json');
    write(file, { ...read(file), budgets: { timeout_ms: 0, max_steps: 1 } });
    const result = validate(t.cases);
    assert.equal(result.status, 2);
    assert.match(result.stdout, /checked 2 case\(s\), 2 error/);
    assert.match(result.stderr, /smoke-pass\/case.json: input:.*fix:/);
    assert.match(result.stderr, /smoke-fail\/case.json: budgets.timeout_ms:.*fix:/);
    assert.ok(!existsSync(t.runs));
  } finally { rmSync(t.root, { recursive: true, force: true }); }
});

test('schema-only rejects symlink escapes at file, case and suite boundaries and directory references', () => {
  const t = setup(); const dir = join(t.cases, 'smoke/smoke-pass'); const file = join(dir, 'case.json');
  const config = read(file);
  try {
    write(join(t.root, 'outside.json'), { prompt: 'outside' });
    symlinkSync(join(t.root, 'outside.json'), join(dir, 'link.json'));
    write(file, { ...config, input: 'link.json' });
    assert.match(validate(t.cases).stderr, /case.json: input: symlink path escapes.*fix:/);
    mkdirSync(join(dir, 'directory'));
    write(file, { ...config, input: 'directory' });
    assert.match(validate(t.cases).stderr, /case.json: input: expected regular file.*fix:/);
    // A filename beginning with '..' is not itself a traversal.
    write(join(dir, '..public.json'), { prompt: 'public' });
    write(file, { ...config, input: '..public.json' });
    assert.equal(validate(t.cases).status, 0);
    write(file, config);
    renameSync(dir, join(t.root, 'outside-case'));
    symlinkSync(join(t.root, 'outside-case'), dir);
    assert.match(validate(t.cases).stderr, /suite.json: cases\[smoke-pass\]: symlink path escapes.*fix:/);
    rmSync(dir); renameSync(join(t.root, 'outside-case'), dir);
    renameSync(dir, join(t.cases, 'faults/smoke-pass'));
    symlinkSync('../faults/smoke-pass', dir);
    assert.match(validate(t.cases).stderr, /suite.json: cases\[smoke-pass\]: symlink path escapes.*fix:/);
    rmSync(dir); renameSync(join(t.cases, 'faults/smoke-pass'), dir);
    renameSync(join(t.cases, 'smoke'), join(t.root, 'outside-suite'));
    symlinkSync(join(t.root, 'outside-suite'), join(t.cases, 'smoke'));
    assert.match(validate(t.cases).stderr, /suite.json: suite: symlink path escapes.*fix:/);
  } finally { rmSync(t.root, { recursive: true, force: true }); }
});

test('public file references cannot alias private acceptance/brief, including symbolic and hard links', () => {
  const t = setup(); const dir = createCase(t.cases, 'smoke', 'draft', 'REQ-E3c');
  const file = join(dir, 'case.json'); const config = read(file);
  try {
    for (const privateFile of ['acceptance.json', 'brief.md']) {
      symlinkSync(privateFile, join(dir, 'symbolic'));
      linkSync(join(dir, privateFile), join(dir, 'hard'));
      for (const field of ['input', 'fixture', 'initial_state']) {
        for (const path of [privateFile, 'symbolic', 'hard']) {
          write(file, { ...config, [field]: path });
          assert.throws(() => loadCase(t.cases, 'smoke', { id: 'draft', version: '1.0.0' }), new RegExp(`${field}: public reference aliases private.*fix:`));
          assert.equal(validateSchema(t.cases, 'smoke').errors.length, 1);
        }
      }
      rmSync(join(dir, 'symbolic')); rmSync(join(dir, 'hard'));
    }
  } finally { rmSync(t.root, { recursive: true, force: true }); }
});

test('AgentInput projection and actual adapter payload exclude private content and paths', () => {
  const t = setup(); const dir = join(t.cases, 'smoke/smoke-pass'); const file = join(dir, 'case.json');
  const config = read(file);
  const privateMetadata = {
    gold: { answer: 'PRIVATE_GOLD' }, gold_path: 'private/gold.json',
    hidden_tests: [{ input: 'PRIVATE_HIDDEN', expected: 'PRIVATE_EXPECTED' }], hidden_tests_path: 'private/hidden-tests.json',
    error_examples: [{ answer: 'PRIVATE_COUNTEREXAMPLE', reason: 'PRIVATE_REASON' }], error_examples_path: 'private/counterexamples.json',
    counterexamples: ['PRIVATE_COUNTEREXAMPLE_ALIAS'],
  };
  try {
    mkdirSync(join(dir, 'private'));
    cpSync(join(dir, 'acceptance.json'), join(dir, 'private/acceptance.json'));
    writeFileSync(join(dir, 'private/brief.md'), 'PRIVATE_BRIEF');
    write(join(dir, 'private/hidden-tests.json'), privateMetadata.hidden_tests);
    const acceptanceFile = join(dir, 'private/acceptance.json');
    write(acceptanceFile, { ...read(acceptanceFile), ...privateMetadata });
    write(file, { ...config, ...privateMetadata, acceptance: 'private/acceptance.json', brief: 'private/brief.md',
      budgets: { ...config.budgets, ...privateMetadata } });
    write(join(dir, 'input.json'), { prompt: 'Public task', ...privateMetadata });
    write(join(dir, 'fixture.json'), { answer: 'hello', delay_ms: 0, ...privateMetadata });
    write(join(dir, 'initial-state.json'), { seen: false, items: [{ value: 'public' }] });
    const expected = {
      prompt: 'Public task', fixture: { answer: 'hello', delay_ms: 0 }, initial_state: { seen: false, items: [{ value: 'public' }] },
      artifact_allowlist: config.artifact_allowlist, budgets: config.budgets,
    };
    assert.deepEqual(loadCase(t.cases, 'smoke', ref).input, expected);
    assert.equal(validate(t.cases).status, 0);
    const result = execute([...t.args, '--case', ref.id]);
    assert.equal(result.status, 0, result.stderr);
    const caseRun = join(runDirs(t.runs)[0], 'cases', ref.id);
    const payloadFile = join(caseRun, 'workspace/input.json');
    assert.deepEqual(read(payloadFile), expected);
    assert.doesNotMatch(readFileSync(payloadFile, 'utf8'), /PRIVATE_|private\/|gold|hidden_tests|counterexamples|error_examples|acceptance|brief|case.json/);
    assert.ok(!existsSync(join(caseRun, 'workspace/private')));
    assert.deepEqual(read(join(caseRun, 'snapshot.json')).acceptance.hidden_tests, privateMetadata.hidden_tests);
  } finally { rmSync(t.root, { recursive: true, force: true }); }
});

test('validate requires schema-only and rejects runtime flags rather than silently executing', () => {
  for (const args of [
    ['validate'], ['validate', '--schema-only', 'extra'], ['--schema-only'],
    ...['watch', 'fail-fast', 'agent', 'experiment', 'runs-dir', 'case', 'failed-from', 'requirement'].map(flag => [
      'validate', '--schema-only', `--${flag}`, ...(['watch', 'fail-fast'].includes(flag) ? [] : ['unused']),
    ]),
  ]) {
    const result = execute(args);
    assert.equal(result.status, 2, args.join(' '));
    assert.match(result.stderr, /usage:|unsupported option|only supported/);
    assert.doesNotMatch(result.stdout, /Run directory/);
  }
  assert.match(execute(['--help']).stdout, /validate --schema-only/);
});
