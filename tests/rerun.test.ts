import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { setup, writeSuite, read, write, execute, runDirs, launch, until, addCase } from './helpers.ts';

test('failed-from selects every non-pass, reloads current cases and preserves source evidence', () => {
  const t = setup();
  try {
    addCase(t.cases, 'crash', 'agent_error');
    writeSuite(t.cases, ['smoke-pass', 'smoke-fail', 'crash']);
    assert.equal(execute(t.args).status, 2);
    const source = runDirs(t.runs)[0]; const before = readFileSync(join(source, 'config.json'), 'utf8');
    write(join(t.cases, 'smoke/smoke-fail/fixture.json'), { answer: 'hello' });
    const crash = join(t.cases, 'smoke/crash/case.json'); write(crash, { ...read(crash), inject: undefined });
    const rerun = execute(['--failed-from', basename(source), '--runs-dir', t.runs]);
    assert.equal(rerun.status, 0, rerun.stderr);
    assert.match(rerun.stdout, /Configuration source:.*current files/);
    const dir = runDirs(t.runs)[1]; const config = read(join(dir, 'config.json'));
    assert.deepEqual(config.case_ids, ['smoke-fail', 'crash']);
    assert.equal(config.source_run_id, basename(source));
    assert.equal(readFileSync(join(source, 'config.json'), 'utf8'), before);
    assert.equal(execute(['--failed-from', basename(dir), '--runs-dir', t.runs]).status, 0);
    assert.equal(read(join(runDirs(t.runs)[2], 'summary.json')).attempted, 0);
  } finally { rmSync(t.root, { recursive: true, force: true }); }
});

test('watch reloads selected input/fixture/acceptance, merges saves, recovers from invalid JSON and fields', async () => {
  const t = setup(); const dir = join(t.cases, 'smoke/smoke-pass');
  const acceptance = read(join(dir, 'acceptance.json'));
  const p = launch([...t.args, '--case', 'smoke-pass', '--watch']);
  try {
    await until(() => p.output().includes('Attempted 1'));
    const initial = runDirs(t.runs)[0];
    const before = readFileSync(join(initial, 'cases/smoke-pass/result.json'), 'utf8');
    const start = Date.now();
    write(join(dir, 'input.json'), { prompt: 'edited' });
    write(join(dir, 'fixture.json'), { answer: 'edited' });
    write(join(dir, 'acceptance.json'), { ...acceptance, criteria: [{ id: 'edited-assertion', type: 'equals', expected: 'edited' }] });
    await until(() => runDirs(t.runs).length === 2);
    assert.ok(Date.now() - start < 1000);
    await until(() => (p.output().match(/Attempted 1/g) ?? []).length === 2);
    const second = runDirs(t.runs)[1];
    assert.equal(read(join(second, 'config.json')).source_run_id, basename(initial));
    assert.equal(read(join(second, 'cases/smoke-pass/snapshot.json')).input.prompt, 'edited');
    assert.equal(read(join(second, 'cases/smoke-pass/result.json')).status, 'pass');
    writeFileSync(join(dir, 'acceptance.json'), '{invalid');
    await until(() => p.output().includes('acceptance.json: JSON/read'));
    write(join(dir, 'acceptance.json'), { ...acceptance, criteria: [{ id: 'broken', type: 'unknown', expected: 'edited' }] });
    await until(() => p.output().includes('criteria[0]'));
    write(join(dir, 'acceptance.json'), { ...acceptance, criteria: [{ id: 'fixed', type: 'equals', expected: 'edited' }] });
    await until(() => (p.output().match(/Attempted 1/g) ?? []).length === 3);
    await new Promise(resolve => setTimeout(resolve, 500));
    assert.equal(runDirs(t.runs).length, 3, 'run output must not cause a watch loop');
    assert.equal(readFileSync(join(initial, 'cases/smoke-pass/result.json'), 'utf8'), before);
    p.child.kill('SIGINT'); assert.equal(await p.done, 0);
  } finally { p.child.kill('SIGKILL'); rmSync(t.root, { recursive: true, force: true }); }
});

test('watch queues within 1 second while busy, runs serially, ignores unselected cases', async () => {
  const t = setup(); const dir = join(t.cases, 'smoke/smoke-pass');
  write(join(dir, 'fixture.json'), { answer: 'hello', delay_ms: 1800 });
  const p = launch([...t.args, '--case', 'smoke-pass', '--watch']);
  try {
    await until(() => runDirs(t.runs).length === 1);
    const start = Date.now(); write(join(dir, 'fixture.json'), { answer: 'hello' });
    await until(() => p.output().includes('queued'));
    assert.ok(Date.now() - start < 1000); assert.equal(runDirs(t.runs).length, 1);
    await until(() => (p.output().match(/Attempted 1/g) ?? []).length === 2);
    const first = runDirs(t.runs)[0]; const second = runDirs(t.runs)[1];
    const events1 = readFileSync(join(first, 'cases/smoke-pass/events.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line));
    const events2 = readFileSync(join(second, 'cases/smoke-pass/events.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line));
    assert.ok(events2[0].time >= events1.at(-1).time);
    write(join(t.cases, 'smoke/smoke-fail/fixture.json'), { answer: 'changed unselected case' });
    await new Promise(resolve => setTimeout(resolve, 500)); assert.equal(runDirs(t.runs).length, 2);
    p.child.kill('SIGINT'); await p.done;
  } finally { p.child.kill('SIGKILL'); rmSync(t.root, { recursive: true, force: true }); }
});

test('watch starts with invalid config and recovers without restarting CLI', async () => {
  const t = setup(); const file = join(t.cases, 'smoke/smoke-pass/case.json');
  const valid = read(file); write(file, { ...valid, budgets: { ...valid.budgets, timeout_ms: 0 } });
  const p = launch([...t.args, '--case', 'smoke-pass', '--watch']);
  try {
    await until(() => p.output().includes('timeout_ms'));
    assert.equal(p.child.exitCode, null);
    write(file, valid); await until(() => p.output().includes('PASS smoke-pass'));
    p.child.kill('SIGINT'); await p.done;
  } finally { p.child.kill('SIGKILL'); rmSync(t.root, { recursive: true, force: true }); }
});

test('watch rejects output equal to a case or suite root instead of silently missing edits', async () => {
  for (const location of ['smoke', 'smoke/smoke-pass']) {
    const t = setup();
    const p = launch(['--cases-dir', t.cases, '--runs-dir', join(t.cases, location), '--case', 'smoke-pass', '--watch']);
    try {
      await until(() => p.child.exitCode !== null, 1200);
      assert.equal(await p.done, 2); assert.match(p.output(), /runs-dir.*overlap/);
    } finally { p.child.kill('SIGTERM'); await p.done; rmSync(t.root, { recursive: true, force: true }); }
  }
});

test('watch ignores runs nested inside a selected case but still detects fixture edits', async () => {
  const t = setup(); const dir = join(t.cases, 'smoke/smoke-pass'); const nestedRuns = join(dir, 'runs');
  const p = launch(['--cases-dir', t.cases, '--runs-dir', nestedRuns, '--case', 'smoke-pass', '--watch']);
  try {
    await until(() => p.output().includes('Attempted 1'));
    await new Promise(resolve => setTimeout(resolve, 500)); assert.equal(runDirs(nestedRuns).length, 1);
    write(join(dir, 'fixture.json'), { answer: 'changed' });
    await until(() => p.output().includes('FAIL smoke-pass'));
    await new Promise(resolve => setTimeout(resolve, 500)); assert.equal(runDirs(nestedRuns).length, 2);
    p.child.kill('SIGINT'); assert.equal(await p.done, 1);
  } finally { p.child.kill('SIGTERM'); await p.done; rmSync(t.root, { recursive: true, force: true }); }
});
