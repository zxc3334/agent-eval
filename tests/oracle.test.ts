import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, linkSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { loadCase, suiteCases } from '../src/config.ts';
import { normalizeCriteria } from '../src/criteria.ts';
import { loadGold, oracleInput } from '../src/oracle.ts';
import { verify } from '../src/verifier.ts';
import { execute, launch, read, runDirs, setup, until, write } from './helpers.ts';

function sandbox(t: { after: (fn: () => void) => void }) {
  const s = setup();
  t.after(() => rmSync(s.root, { recursive: true, force: true }));
  return s;
}
function latest(runs: string, id: string) { return join(runDirs(runs).at(-1)!, 'cases', id); }

test('every shipped case has reference materials; Oracle scores smoke, fields and tools through verifier evidence', async t => {
  const s = sandbox(t);
  for (const suite of ['smoke', 'fields', 'tools', 'faults']) {
    for (const ref of suiteCases(s.cases, suite)) {
      const c = loadCase(s.cases, suite, ref);
      const gold = loadGold(c.file);
      assert.ok(gold.notes.includes(ref.id));
      assert.ok(gold.solve.trim());
    }
  }
  for (const suite of ['smoke', 'fields', 'tools']) {
    const command = execute([...s.args, '--suite', suite, '--agent', 'oracle']);
    assert.equal(command.status, 0, command.stdout + command.stderr);
    const run = runDirs(s.runs).at(-1)!;
    assert.equal(read(join(run, 'config.json')).experiment.adapter, 'oracle');
    assert.equal(read(join(run, 'summary.json')).agent, 'oracle');
    assert.match(readFileSync(join(run, 'report.md'), 'utf8'), /local reference solution/);
    for (const ref of suiteCases(s.cases, suite)) {
      const dir = join(run, 'cases', ref.id);
      const result = read(join(dir, 'result.json'));
      assert.equal(result.status, 'pass');
      assert.ok(result.assertions.length);
      assert.ok(result.assertions.filter((a: any) => a.mode === 'hard').every((a: any) => a.passed));
      if (suite === 'fields') assert.equal(result.assertions.find((a: any) => a.criterion_id === 'wording-hint').passed, false);
      const snapshot = read(join(dir, 'snapshot.json'));
      const input = oracleInput(snapshot.input);
      assert.deepEqual(read(join(dir, 'workspace/input.json')), input);
      assert.deepEqual(read(join(dir, 'oracle/input.json')), input);
      assert.deepEqual(read(join(result.verifier_result_dir, 'result.json')).assertions, result.assertions);
      const verifierInput = read(join(result.verifier_result_dir, 'input.json'));
      assert.equal(verifierInput.artifacts, join(dir, 'artifacts'));
      assert.deepEqual(verifierInput.criteria, normalizeCriteria(snapshot.acceptance.criteria, 'test'));
      // Re-evaluate the saved artifacts using the exact ordinary verifier API.
      const replay = await verify(verifierInput.criteria, verifierInput.artifacts, dir);
      assert.equal(replay.status, result.status);
      assert.deepEqual(replay.assertions, result.assertions);
      assert.notEqual(replay.result_dir, result.verifier_result_dir);
      for (const file of ['gold.md', 'solve.ts']) {
        assert.equal(readFileSync(join(dir, 'oracle', file), 'utf8'), readFileSync(join(s.cases, suite, ref.id, file), 'utf8'));
        assert.ok(!existsSync(join(dir, 'workspace', file)));
        assert.ok(!existsSync(join(dir, 'artifacts', file)));
      }
      assert.equal(readFileSync(join(dir, 'events.jsonl'), 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line)).find(e => e.type === 'agent_start').data.agent, 'oracle');
    }
  }
});

test('Oracle starts from fixed initial state on every run and preserves unrelated state without using fixture files', t => {
  const s = sandbox(t); const dir = join(s.cases, 'fields/fields-clobbered');
  const state = read(join(dir, 'initial-state.json'));
  state.config.extra = { items: [null, false, 0], keep: 'untouched' };
  write(join(dir, 'initial-state.json'), state);
  const before = readFileSync(join(dir, 'initial-state.json'), 'utf8');
  const args = [...s.args, '--suite', 'fields', '--case', 'fields-clobbered', '--agent', 'oracle'];
  assert.equal(execute(args).status, 0);
  const first = latest(s.runs, 'fields-clobbered');
  const expected = { ...state.config, theme: 'dark' };
  assert.deepEqual(read(join(first, 'artifacts/config.json')), expected);
  write(join(first, 'workspace/input.json'), { initial_state: { config: { theme: 'poison' } } });
  write(join(first, 'workspace/config.json'), { poisoned: true });
  assert.equal(execute(args).status, 0);
  const second = latest(s.runs, 'fields-clobbered');
  assert.notEqual(first, second);
  assert.deepEqual(read(join(second, 'artifacts/config.json')), expected);
  assert.deepEqual(read(join(second, 'workspace/input.json')).initial_state, state);
  assert.equal(readFileSync(join(dir, 'initial-state.json'), 'utf8'), before);
});

test('changing acceptance changes Oracle verdict but never its generated answer; legacy gold and fixture are not solutions', t => {
  const s = sandbox(t); const dir = join(s.cases, 'smoke/smoke-fail');
  const file = join(dir, 'acceptance.json'); const acceptance = read(file);
  write(file, { ...acceptance, gold: { answer: 'PRIVATE_GOLD_SENTINEL' } });
  write(join(dir, 'fixture.json'), { answer: 'PRIVATE_FIXTURE_SENTINEL' });
  const args = [...s.args, '--case', 'smoke-fail', '--agent', 'oracle'];
  assert.equal(execute(args).status, 0);
  const first = latest(s.runs, 'smoke-fail');
  assert.equal(read(join(first, 'artifacts/answer.json')).answer, 'hello');
  assert.doesNotMatch(readFileSync(join(first, 'workspace/input.json'), 'utf8'), /PRIVATE_|"fixture"|"criteria"|"gold"/);
  acceptance.criteria[0].expected = 'changed requirement';
  write(file, acceptance);
  assert.equal(execute(args).status, 1);
  const second = latest(s.runs, 'smoke-fail');
  assert.deepEqual(read(join(second, 'artifacts/answer.json')), read(join(first, 'artifacts/answer.json')));
  const result = read(join(second, 'result.json'));
  assert.equal(result.status, 'fail');
  assert.equal(result.assertions[0].expected, 'changed requirement');
  assert.equal(result.assertions[0].actual, 'hello');
});

test('corrupted gold cannot claim pass: answer, field and tool mistakes fail hard assertions', t => {
  const s = sandbox(t);
  for (const [suite, id, from, to, criterion] of [
    ['smoke', 'smoke-pass', "answer: 'hello'", "answer: 'wrong'", 'answer-equals'],
    ['fields', 'fields-pass-a', "config.theme = 'dark'", "config.theme = 'light'", 'theme-updated'],
    ['tools', 'tools-pass', "query: 'alpha'", "query: 'wrong'", 'args'],
  ]) {
    const file = join(s.cases, suite, id, 'solve.ts');
    const source = readFileSync(file, 'utf8'); assert.ok(source.includes(from));
    writeFileSync(file, source.replace(from, to));
    const command = execute([...s.args, '--suite', suite, '--case', id, '--agent', 'oracle']);
    assert.equal(command.status, 1, command.stdout + command.stderr);
    const dir = latest(s.runs, id); const result = read(join(dir, 'result.json'));
    assert.equal(read(join(dir, 'artifacts/answer.json')).success, true);
    assert.equal(result.status, 'fail');
    assert.equal(result.assertions.find((a: any) => a.criterion_id === criterion).passed, false);
  }
});

test('diagnostic tool failures remain visible without failing the Oracle run', t => {
  const s = sandbox(t); const file = join(s.cases, 'tools/tools-diagnostic/solve.ts');
  writeFileSync(file, readFileSync(file, 'utf8').replace("query: 'alpha'", "query: 'wrong'"));
  assert.equal(execute([...s.args, '--suite', 'tools', '--case', 'tools-diagnostic', '--agent', 'oracle']).status, 0);
  const result = read(join(latest(s.runs, 'tools-diagnostic'), 'result.json'));
  assert.equal(result.status, 'pass');
  assert.equal(result.assertions[0].mode, 'diagnostic');
  assert.equal(result.assertions[0].passed, false);
});

test('Oracle tool writes and duplicate side effects fail the existing E4c assertions', t => {
  const s = sandbox(t); const file = join(s.cases, 'tools/tools-pass/solve.ts');
  const source = readFileSync(file, 'utf8');
  for (const [extra, failed] of [
    [", { tool: 'write', arguments: { text: 'hi' } }", ['read-only']],
    [", { tool: 'send', arguments: { text: 'hi' } }, { tool: 'send', arguments: { text: 'hi' } }", ['read-only', 'once']],
  ] as const) {
    writeFileSync(file, source.replace("query: 'alpha' } }]", `query: 'alpha' } }${extra}]`));
    const command = execute([...s.args, '--suite', 'tools', '--case', 'tools-pass', '--agent', 'oracle']);
    assert.equal(command.status, 1, command.stdout + command.stderr);
    const result = read(join(latest(s.runs, 'tools-pass'), 'result.json'));
    for (const id of failed) assert.equal(result.assertions.find((a: any) => a.criterion_id === id).passed, false);
  }
});

test('reference process cannot read private acceptance, import verifier implementation or write verifier results', t => {
  const s = sandbox(t); const dir = join(s.cases, 'smoke/smoke-pass');
  for (const source of [
    `import { readFileSync } from 'node:fs'; readFileSync(${JSON.stringify(join(dir, 'acceptance.json'))});`,
    `await import(${JSON.stringify(pathToFileURL(resolve('src/file-verifier.ts')).href)});`,
    "import { writeFileSync } from 'node:fs'; writeFileSync('../result.json', JSON.stringify({ status: 'pass' }));",
  ]) {
    writeFileSync(join(dir, 'solve.ts'), source);
    const command = execute([...s.args, '--case', 'smoke-pass', '--agent', 'oracle']);
    assert.equal(command.status, 2, command.stdout + command.stderr);
    const run = latest(s.runs, 'smoke-pass');
    assert.equal(read(join(run, 'result.json')).status, 'agent_error');
    assert.match(readFileSync(join(run, 'artifacts/stderr.log'), 'utf8'), /ERR_ACCESS_DENIED/);
    assert.ok(!existsSync(join(run, 'verifier')));
  }
});

test('Gold stays private to normal agents, including public path aliases', t => {
  const s = sandbox(t); const dir = join(s.cases, 'smoke/smoke-pass');
  writeFileSync(join(dir, 'gold.md'), 'PRIVATE_NOTES_SENTINEL');
  writeFileSync(join(dir, 'solve.ts'), "throw new Error('PRIVATE_SOLVE_SENTINEL');");
  assert.equal(execute([...s.args, '--case', 'smoke-pass']).status, 0);
  const run = latest(s.runs, 'smoke-pass');
  assert.doesNotMatch(readFileSync(join(run, 'workspace/input.json'), 'utf8'), /PRIVATE_|solve|gold/);
  assert.ok(!existsSync(join(run, 'oracle')));
  assert.ok(!existsSync(join(run, 'workspace/solve.ts')));
  const config = read(join(dir, 'case.json'));
  for (const name of ['gold.md', 'solve.ts']) {
    linkSync(join(dir, name), join(dir, 'alias'));
    for (const field of ['input', 'fixture', 'initial_state']) {
      write(join(dir, 'case.json'), { ...config, [field]: 'alias' });
      assert.throws(() => loadCase(s.cases, 'smoke', { id: 'smoke-pass', version: '1.0.0' }), /public reference aliases private/);
    }
    rmSync(join(dir, 'alias'));
  }
});

test('missing or empty gold fails before running; legacy stub cases need no gold; escaped sources are refused', t => {
  const s = sandbox(t); const dir = join(s.cases, 'smoke/smoke-pass');
  const args = [...s.args, '--case', 'smoke-pass', '--agent', 'oracle'];
  rmSync(join(dir, 'gold.md'));
  let command = execute(args);
  assert.equal(command.status, 2); assert.match(command.stderr, /oracle.gold.md/);
  assert.deepEqual(runDirs(s.runs), []);
  writeFileSync(join(dir, 'gold.md'), ' ');
  command = execute(args);
  assert.equal(command.status, 2); assert.match(command.stderr, /nonempty gold.md/);
  writeFileSync(join(dir, 'gold.md'), 'Reference'); rmSync(join(dir, 'solve.ts'));
  command = execute(args);
  assert.equal(command.status, 2); assert.match(command.stderr, /oracle.solve.ts/);
  assert.deepEqual(runDirs(s.runs), []);
  assert.equal(execute([...s.args, '--case', 'smoke-pass']).status, 0);
  const outside = join(s.root, 'outside.ts'); writeFileSync(outside, 'throw new Error();');
  symlinkSync(outside, join(dir, 'solve.ts'));
  command = execute(args);
  assert.equal(command.status, 2); assert.match(command.stderr, /symlink path escapes/);
});

test('Oracle solver crash, invalid protocol and timeout keep runtime statuses and partial evidence', t => {
  const s = sandbox(t); const dir = join(s.cases, 'smoke/smoke-pass');
  const config = read(join(dir, 'case.json'));
  write(join(dir, 'case.json'), { ...config, artifact_allowlist: ['answer.json', 'partial.txt'], budgets: { timeout_ms: 300, max_steps: 1 } });
  for (const [source, status, stage] of [
    ["throw new Error('broken reference');", 'agent_error', 'agent'],
    ["import { writeFileSync } from 'node:fs'; writeFileSync('answer.json', '{}');", 'agent_error', 'protocol'],
    ["import { writeFileSync } from 'node:fs'; writeFileSync('partial.txt', 'started'); while (true) {}", 'timeout', 'agent'],
  ]) {
    writeFileSync(join(dir, 'solve.ts'), source);
    const command = execute([...s.args, '--case', 'smoke-pass', '--agent', 'oracle']);
    assert.equal(command.status, 2, command.stdout + command.stderr);
    const run = latest(s.runs, 'smoke-pass'); const result = read(join(run, 'result.json'));
    assert.equal(result.status, status); assert.equal(result.stage, stage);
    assert.deepEqual(result.assertions, []);
    if (status === 'timeout') assert.equal(readFileSync(join(run, 'artifacts/partial.txt'), 'utf8'), 'started');
  }
});

test('Oracle preserves verifier faults and never treats missing grades as pass', t => {
  const s = sandbox(t); const file = join(s.cases, 'smoke/smoke-pass/case.json'); const config = read(file);
  for (const inject of ['verifier_error', 'verifier_timeout', 'verifier_missing', 'verifier_invalid']) {
    write(file, { ...config, inject });
    const command = execute([...s.args, '--case', 'smoke-pass', '--agent', 'oracle']);
    assert.equal(command.status, 2, command.stdout + command.stderr);
    const result = read(join(latest(s.runs, 'smoke-pass'), 'result.json'));
    assert.equal(result.status, 'verifier_error'); assert.equal(result.stage, 'verifier');
    assert.equal(read(join(result.verifier_result_dir, 'result.json')).status, 'verifier_error');
  }
});

test('Oracle failed-from keeps executor and current source; reports regenerate without source cases', t => {
  const s = sandbox(t); const solve = join(s.cases, 'smoke/smoke-fail/solve.ts'); const original = readFileSync(solve, 'utf8');
  writeFileSync(solve, original.replace("answer: 'hello'", "answer: 'wrong'"));
  assert.equal(execute([...s.args, '--agent', 'oracle']).status, 1);
  const first = runDirs(s.runs).at(-1)!;
  writeFileSync(solve, original);
  assert.equal(execute([...s.args, '--failed-from', basename(first)]).status, 0);
  const second = runDirs(s.runs).at(-1)!;
  const config = read(join(second, 'config.json'));
  assert.equal(config.agent, 'oracle'); assert.equal(config.source_run_id, basename(first));
  assert.deepEqual(config.case_ids, ['smoke-fail']);
  const report = readFileSync(join(second, 'report.md'), 'utf8');
  rmSync(s.cases, { recursive: true }); rmSync(join(second, 'report.md'));
  assert.equal(execute(['report', basename(second), '--runs-dir', s.runs]).status, 0);
  assert.equal(readFileSync(join(second, 'report.md'), 'utf8'), report);
});

test('new cases include an independently editable red Oracle template without a reviewed gate', t => {
  const s = sandbox(t);
  assert.equal(execute(['case', 'new', 'draft', '--requirement', 'E5a', '--suite', 'local', '--cases-dir', s.cases]).status, 0);
  const dir = join(s.cases, 'local/draft');
  assert.ok(readdirSync(dir).includes('gold.md')); assert.ok(readdirSync(dir).includes('solve.ts'));
  const args = [...s.args, '--suite', 'local', '--agent', 'oracle'];
  assert.equal(execute(args).status, 1);
  const file = join(dir, 'solve.ts');
  writeFileSync(file, readFileSync(file, 'utf8').replace('TODO_REFERENCE_ANSWER', 'TODO_EXPECTED_ANSWER'));
  assert.equal(read(join(dir, 'acceptance.json')).reviewed, false);
  assert.equal(execute(args).status, 0);
  assert.equal(execute([...s.args, '--suite', 'local', '--agent', 'stub']).status, 1);
});

test('Oracle watch reruns edited reference sources with fresh workspaces', async t => {
  const s = sandbox(t); const file = join(s.cases, 'smoke/smoke-pass/solve.ts');
  const p = launch([...s.args, '--case', 'smoke-pass', '--agent', 'oracle', '--watch']);
  try {
    await until(() => p.output().includes('Attempted 1'));
    writeFileSync(file, readFileSync(file, 'utf8').replace("answer: 'hello'", "answer: 'wrong'"));
    await until(() => p.output().includes('FAIL smoke-pass') && p.output().includes('exit 1'));
    p.child.kill('SIGINT'); assert.equal(await p.done, 1);
    const dirs = runDirs(s.runs); assert.equal(dirs.length, 2);
    assert.equal(read(join(dirs[0], 'cases/smoke-pass/artifacts/answer.json')).answer, 'hello');
    assert.equal(read(join(dirs[1], 'cases/smoke-pass/artifacts/answer.json')).answer, 'wrong');
  } finally { p.child.kill('SIGTERM'); await p.done; }
});
