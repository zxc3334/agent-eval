import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { contentHash, RECEIPT, requireReviewedSuite } from '../src/review.ts';
import { suiteCases } from '../src/config.ts';
import { execute, launch, read, runDirs, setup, until, write, writeSuite } from './helpers.ts';

function sandbox(t: { after: (fn: () => void) => void }) {
  const s = setup(); t.after(() => rmSync(s.root, { recursive: true, force: true })); return s;
}
function validate(s: ReturnType<typeof setup>, suite = 'smoke') {
  return execute(['validate', '--suite', suite, ...s.args], s.root);
}
function result(runs: string, id = 'smoke-pass') {
  return read(join(runDirs(runs).at(-1)!, 'cases', id, 'calibration.json'));
}
function markReviewed(cases: string, suite = 'smoke') {
  for (const ref of suiteCases(cases, suite)) {
    const file = join(cases, suite, ref.id, 'acceptance.json');
    write(file, { ...read(file), reviewed: true });
  }
}
function formal(cases: string) {
  const file = join(cases, 'smoke/suite.json'); write(file, { ...read(file), formal: true });
}

test('validate suite executes Oracle and every control from fresh fixed inputs, persists separate evidence and rebuilds reports', t => {
  const s = sandbox(t); const dir = join(s.cases, 'smoke/smoke-pass');
  const file = join(dir, 'acceptance.json'); const a = read(file);
  a.error_examples.push({ answer: 'also wrong', reason: 'second negative', expected_failed_criteria: ['answer-equals'] });
  write(file, a);
  const fixtureBefore = readFileSync(join(dir, 'fixture.json'), 'utf8');
  const stateBefore = readFileSync(join(dir, 'initial-state.json'), 'utf8');
  // A prior Oracle output must never satisfy a subsequent control.
  writeFileSync(join(dir, 'solve.ts'), readFileSync(join(dir, 'solve.ts'), 'utf8') + "\nwriteFileSync('oracle-only.json', 'true');\n");
  const cmd = validate(s); assert.equal(cmd.status, 0, cmd.stdout + cmd.stderr);
  assert.match(cmd.stdout, /Oracle smoke-pass: pass[\s\S]*Control smoke-pass\/2: rejected/);
  const run = runDirs(s.runs).at(-1)!; const r = result(s.runs);
  assert.equal(r.calibrated, true); assert.equal(r.controls.length, 2);
  const workspaces = [r.oracle, ...r.controls.map((c: any) => c.result)].map(r => join(r.events, '..', 'workspace'));
  for (const workspace of workspaces) {
    assert.deepEqual(read(join(workspace, 'input.json')), read(join(workspaces[0], 'input.json')));
    assert.deepEqual(read(join(workspace, '../snapshot.json')).input.fixture, read(join(dir, 'fixture.json')));
  }
  assert.ok(existsSync(join(workspaces[0], 'oracle-only.json')));
  assert.ok(workspaces.slice(1).every(w => !existsSync(join(w, 'oracle-only.json'))));
  assert.deepEqual(r.controls.map((c: any) => read(join(c.result.events, '../artifacts/answer.json')).answer), ['wrong', 'also wrong']);
  for (const control of r.controls) {
    assert.deepEqual(control.actual_failed_criteria, ['answer-equals']);
    assert.deepEqual(read(join(control.result.verifier_result_dir, 'result.json')).assertions, control.result.assertions);
  }
  const summary = read(join(run, 'summary.json'));
  assert.equal(summary.kind, 'calibration'); assert.equal(summary.real_agent_attempted, 0);
  assert.equal(summary.real_agent_pass_rate, null); assert.equal(summary.pass_rate, undefined);
  assert.deepEqual(summary.solvability, { passed: 2, total: 2 });
  assert.deepEqual(summary.detection, { rejected: 3, attempted: 3, total: 3 });
  const report = readFileSync(join(run, 'report.md'), 'utf8');
  assert.match(report, /可解性/); assert.match(report, /检出/); assert.match(report, /excluded from real agent/);
  rmSync(join(run, 'report.md'));
  assert.equal(execute(['report', summary.run_id, '--runs-dir', s.runs]).status, 0);
  assert.equal(readFileSync(join(run, 'report.md'), 'utf8'), report);
  for (const w of workspaces) writeFileSync(join(w, 'input.json'), 'poison');
  assert.equal(validate(s).status, 0);
  assert.notEqual(result(s.runs).oracle.events, r.oracle.events);
  assert.equal(readFileSync(join(dir, 'fixture.json'), 'utf8'), fixtureBefore);
  assert.equal(readFileSync(join(dir, 'initial-state.json'), 'utf8'), stateBefore);
  assert.equal(read(file).reviewed, false, 'calibration does not impersonate human review');
});

test('calibration distinguishes unexpected pass, wrong criterion, extra failures and Oracle failure without fail-fast', t => {
  const s = sandbox(t); const file = join(s.cases, 'smoke/smoke-pass/acceptance.json');
  const a = read(file);
  a.criteria.push({ id: 'second', type: 'equals', expected: 'hello' });
  a.error_examples = [
    { answer: 'hello', reason: 'accidentally correct', expected_failed_criteria: ['answer-equals'] },
    { answer: 'wrong', reason: 'undeclared second failure', expected_failed_criteria: ['answer-equals'] },
    { answer: 'wrong', reason: 'matching both failures', expected_failed_criteria: ['second', 'answer-equals'] },
  ];
  write(file, a);
  assert.equal(validate(s).status, 1);
  const r = result(s.runs);
  assert.deepEqual(r.controls.map((c: any) => c.calibrated), [false, false, true]);
  assert.match(r.controls[0].reason, /unexpected pass/); assert.match(r.controls[1].reason, /do not match/);
  assert.equal(result(s.runs, 'smoke-fail').calibrated, true, 'later cases still run');
  assert.equal(read(join(s.cases, 'smoke/smoke-pass', RECEIPT)).status, 'failed');
  // Fail a valid but different criterion, rather than merely an unknown ID.
  a.criteria[1] = { id: 'second', type: 'equals', target: { artifact: 'answer.json', field: 'success' }, params: { expected: true }, mode: 'hard', reason: 'protocol flag' };
  a.error_examples = [{ answer: 'wrong', reason: 'wrong failure location', expected_failed_criteria: ['second'] }];
  write(file, a);
  assert.equal(validate(s).status, 1);
  assert.deepEqual(result(s.runs).controls[0].actual_failed_criteria, ['answer-equals']);
  const solve = join(s.cases, 'smoke/smoke-pass/solve.ts');
  writeFileSync(solve, readFileSync(solve, 'utf8').replace("answer: 'hello'", "answer: 'broken'"));
  assert.equal(validate(s).status, 1); assert.equal(result(s.runs).oracle.status, 'fail');
});

test('calibration treats verifier exceptions and timeouts as errors, never rejection evidence', t => {
  const s = sandbox(t); writeSuite(s.cases, ['smoke-pass']);
  const file = join(s.cases, 'smoke/smoke-pass/case.json'); const c = read(file);
  for (const inject of ['verifier_error', 'verifier_timeout', 'verifier_missing', 'verifier_invalid', 'environment_error']) {
    write(file, { ...c, inject }); const cmd = validate(s);
    assert.equal(cmd.status, 2, cmd.stdout + cmd.stderr);
    const r = result(s.runs);
    assert.equal(r.calibrated, false); assert.equal(r.controls.length, 1);
    assert.equal(r.controls[0].calibrated, false);
    assert.match(r.controls[0].reason, /execution error/);
    assert.equal(read(join(s.cases, 'smoke/smoke-pass', RECEIPT)).status, 'failed');
  }
});

test('counterexample declarations must be nonempty unique hard IDs; legacy drafts stay locally usable', t => {
  const s = sandbox(t); const dir = join(s.cases, 'smoke/smoke-pass'); const file = join(dir, 'acceptance.json'); const a = read(file);
  for (const expected of [[], ['unknown'], ['answer-equals', 'answer-equals'], 'answer-equals']) {
    write(file, { ...a, error_examples: [{ ...a.error_examples[0], expected_failed_criteria: expected }] });
    assert.equal(validate(s).status, 2);
    assert.match(result(s.runs).errors[0], /expected_failed_criteria/);
    assert.equal(result(s.runs, 'smoke-fail').calibrated, true);
  }
  write(file, { ...a, error_examples: [{ answer: 'wrong', reason: 'legacy no declaration' }] });
  assert.equal(execute(['validate', '--schema-only', '--cases-dir', s.cases]).status, 0);
  assert.equal(execute([...s.args, '--case', 'smoke-pass']).status, 0);
  assert.equal(validate(s).status, 2);
  assert.match(result(s.runs).controls[0].reason, /missing expected_failed_criteria/);
  write(file, { ...a, error_examples: [] });
  assert.equal(validate(s).status, 2); assert.match(result(s.runs).errors[0], /at least one/);
  write(file, { ...a, error_examples: [{ ...a.error_examples[0], files: { '../escape.json': 'oops' } }] });
  assert.equal(validate(s).status, 2); assert.match(result(s.runs).errors[0], /files:/);
});

test('formal suites require human review and calibration for every member, even with case selection', t => {
  const s = sandbox(t); formal(s.cases);
  const args = [...s.args, '--case', 'smoke-pass'];
  assert.match(execute(args).stderr, /reviewed gate.*reviewed=true/);
  markReviewed(s.cases);
  assert.equal(execute(args).status, 2); assert.match(execute(args).stderr, /calibration receipt/);
  assert.equal(runDirs(s.runs).length, 0, 'gate runs before execution');
  const cmd = validate(s); assert.equal(cmd.status, 0, cmd.stdout + cmd.stderr);
  assert.equal(execute(args).status, 0);
  const scaffold = execute(['case', 'new', 'draft', '--requirement', 'REQ-E5b', '--suite', 'smoke', '--cases-dir', s.cases]);
  assert.equal(scaffold.status, 2); assert.match(scaffold.stderr, /unreviewed draft/);
  assert.ok(!existsSync(join(s.cases, 'smoke/draft')));
  const file = join(s.cases, 'smoke/smoke-fail/acceptance.json');
  write(file, { ...read(file), reviewed: false });
  assert.equal(execute(args).status, 2, 'unselected member cannot bypass formal admission');
  write(file, { ...read(file), reviewed: true });
  const receipt = join(s.cases, 'smoke/smoke-fail', RECEIPT);
  write(receipt, { ...read(receipt), status: 'failed' });
  assert.match(execute(args).stderr, /every declared control/);
  assert.equal(validate(s).status, 0); assert.equal(execute(args).status, 0);
});

test('content hash invalidates review on acceptance, fixture, state, input, case and Oracle edits; recalibration restores admission', t => {
  const s = sandbox(t); const dir = join(s.cases, 'smoke/smoke-pass');
  formal(s.cases); assert.equal(validate(s).status, 0);
  const originalHash = contentHash(join(dir, 'case.json'));
  markReviewed(s.cases);
  assert.equal(contentHash(join(dir, 'case.json')), originalHash, 'human review toggle does not invalidate calibration');
  const gate = () => requireReviewedSuite(s.cases, 'smoke', suiteCases(s.cases, 'smoke'));
  assert.doesNotThrow(gate);
  for (const name of ['acceptance.json', 'fixture.json', 'initial-state.json', 'input.json', 'case.json', 'gold.md', 'solve.ts']) {
    const file = join(dir, name); const before = readFileSync(file, 'utf8');
    if (name === 'acceptance.json') write(file, { ...read(file), gold: { answer: 'new private value' } });
    else writeFileSync(file, before + '\n');
    assert.notEqual(contentHash(join(dir, 'case.json')), originalHash, name);
    assert.throws(gate, /content hash changed/, name);
    writeFileSync(file, before); assert.doesNotThrow(gate);
  }
  const acceptanceFile = join(dir, 'acceptance.json'); const beforeAcceptance = readFileSync(acceptanceFile, 'utf8');
  const acceptance = read(acceptanceFile); acceptance.criteria[0].expected = 'changed acceptance'; write(acceptanceFile, acceptance);
  assert.throws(gate, /content hash changed/); assert.equal(validate(s).status, 1);
  writeFileSync(acceptanceFile, beforeAcceptance);
  assert.throws(gate, /every declared control/, 'restoring content does not revive a failed receipt');
  assert.equal(validate(s).status, 0); assert.doesNotThrow(gate);
  const fixture = join(dir, 'fixture.json'); write(fixture, { answer: 'different stub response' });
  assert.equal(execute([...s.args, '--case', 'smoke-pass']).status, 2);
  assert.equal(validate(s).status, 0); assert.doesNotThrow(gate);
  assert.equal(execute([...s.args, '--case', 'smoke-pass']).status, 1, 'new stub output still judged normally');
});

test('E4 field/tool controls support artifacts and ignore diagnostic failures consistently with Oracle', t => {
  const s = sandbox(t);
  const dir = join(s.cases, 'fields/fields-pass-a'); const file = join(dir, 'acceptance.json'); const a = read(file);
  const state = read(join(dir, 'initial-state.json')).config;
  a.error_examples.push({ answer: 'does not matter', files: { 'config.json': JSON.stringify(state) }, reason: 'theme unchanged', expected_failed_criteria: ['theme-updated'] });
  write(file, a);
  const toolFile = join(s.cases, 'tools/tools-pass/acceptance.json'); const toolAcceptance = read(toolFile);
  toolAcceptance.error_examples.push({ answer: 'claimed success', reason: 'search argument differs',
    files: { 'trace.json': JSON.stringify({ owner: 'Ada', calls: [{ tool: 'search', arguments: { query: 'beta' } }] }) },
    expected_failed_criteria: ['args'] });
  write(toolFile, toolAcceptance);
  for (const suite of ['fields', 'tools']) {
    const cmd = validate(s, suite); assert.equal(cmd.status, 0, cmd.stdout + cmd.stderr);
    const summary = read(join(runDirs(s.runs).at(-1)!, 'summary.json'));
    assert.equal(summary.solvability.passed, summary.planned);
    assert.equal(summary.detection.rejected, summary.detection.total);
  }
  const fieldRun = runDirs(s.runs)[0]; const r = read(join(fieldRun, 'cases/fields-pass-a/calibration.json'));
  assert.equal(r.oracle.assertions.find((a: any) => a.criterion_id === 'wording-hint').passed, false);
  assert.deepEqual(r.controls[1].actual_failed_criteria, ['theme-updated']);
});

test('interruption revokes old receipts; edits during validation cannot produce a usable receipt', async t => {
  const s = sandbox(t); writeSuite(s.cases, ['smoke-pass']);
  const dir = join(s.cases, 'smoke/smoke-pass'); const solve = join(dir, 'solve.ts');
  writeFileSync(solve, readFileSync(solve, 'utf8') + '\nawait new Promise(r => setTimeout(r, 500));\n');
  assert.equal(validate(s).status, 0);
  const args = ['validate', '--suite', 'smoke', ...s.args];
  const first = launch(args);
  try {
    await until(() => first.output().includes('Calibration directory:'));
    await until(() => read(join(dir, RECEIPT)).status === 'pending');
    first.child.kill('SIGINT'); assert.equal(await first.done, 2);
    assert.notEqual(read(join(dir, RECEIPT)).status, 'passed');
  } finally { first.child.kill('SIGTERM'); await first.done; }
  const second = launch(args);
  try {
    await until(() => second.output().includes('Calibration directory:'));
    write(join(dir, 'fixture.json'), { answer: 'edited while oracle runs' });
    assert.equal(await second.done, 2);
    assert.match(result(s.runs).errors.join(' '), /content changed during calibration/);
    assert.equal(read(join(dir, RECEIPT)).status, 'failed');
  } finally { second.child.kill('SIGTERM'); await second.done; }
});

test('validate runtime rejects irrelevant CLI flags and overlapping output roots', t => {
  const s = sandbox(t);
  for (const args of [['--agent', 'stub'], ['--case', 'smoke-pass'], ['--fail-fast'], ['--watch'], ['--experiment', 'x']]) {
    const cmd = execute(['validate', '--suite', 'smoke', ...s.args, ...args]);
    assert.equal(cmd.status, 2); assert.match(cmd.stderr, /unsupported option/);
  }
  const cmd = execute(['validate', '--suite', 'smoke', '--cases-dir', s.cases, '--runs-dir', join(s.cases, 'smoke')]);
  assert.equal(cmd.status, 2); assert.match(cmd.stderr, /outside the cases directory/);
  const manifest = join(s.cases, 'smoke/suite.json'); write(manifest, { ...read(manifest), formal: 'yes' });
  assert.equal(validate(s).status, 2);
});
