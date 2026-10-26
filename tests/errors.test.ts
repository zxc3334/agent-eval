import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { join, basename } from 'node:path';
import { setup, writeSuite, addCase, write, read, execute, runDirs, launch, until } from './helpers.ts';

test('faults have distinct statuses, mixed errors exit 2, reports regenerate offline', () => {
  const t = setup();
  try {
    const faults = ['agent_error', 'protocol_error', 'timeout', 'verifier_error', 'environment_error'];
    for (const fault of faults) addCase(t.cases, fault, fault);
    writeSuite(t.cases, ['smoke-pass', 'smoke-fail', ...faults]);
    const result = execute(t.args);
    assert.equal(result.status, 2, result.stderr);
    const dir = runDirs(t.runs)[0];
    for (const fault of faults) {
      const r = read(join(dir, 'cases', fault, 'result.json'));
      assert.equal(r.status, fault === 'protocol_error' ? 'agent_error' : fault);
      assert.ok(r.stage); assert.ok(r.reason); assert.deepEqual(r.assertions, []);
      for (const file of ['stdout.log', 'stderr.log']) assert.ok(existsSync(join(dir, 'cases', fault, 'artifacts', file)));
    }
    const s = read(join(dir, 'summary.json'));
    assert.equal(s.attempted, 7); assert.equal(s.pass_rate, 1 / 7); assert.equal(s.scoring_coverage, 2 / 7);
    assert.equal(s.counts.agent_error, 2); assert.equal(s.exit_code, 2);
    const original = readFileSync(join(dir, 'report.md'), 'utf8');
    rmSync(join(dir, 'report.md')); rmSync(t.cases, { recursive: true });
    const report = execute(['report', basename(dir), '--runs-dir', t.runs]);
    assert.equal(report.status, 0, report.stderr);
    assert.equal(readFileSync(join(dir, 'report.md'), 'utf8'), original);
    const pid = read(join(dir, 'cases/timeout/artifacts/descendant.json')).pid;
    assert.throws(() => process.kill(pid, 0), /ESRCH/);
    assert.ok(!existsSync(read(join(dir, 'cases/timeout/artifacts/resource.json')).path));
  } finally { rmSync(t.root, { recursive: true, force: true }); }
});

test('fail-fast stops after failed assertion while default continues', () => {
  const t = setup();
  try {
    writeSuite(t.cases, ['smoke-fail', 'smoke-pass']);
    assert.equal(execute([...t.args, '--fail-fast']).status, 1);
    const s = read(join(runDirs(t.runs)[0], 'summary.json'));
    assert.equal(s.attempted, 1); assert.deepEqual(s.not_attempted, ['smoke-pass']);
  } finally { rmSync(t.root, { recursive: true, force: true }); }
});

test('Ctrl-C preserves partial evidence, kills descendants and exits 2', async () => {
  const t = setup(); addCase(t.cases, 'interrupted', 'timeout');
  const f = join(t.cases, 'smoke/interrupted/case.json'); write(f, { ...read(f), budgets: { ...read(f).budgets, timeout_ms: 10000 } });
  writeSuite(t.cases, ['interrupted', 'smoke-pass']);
  const p = launch(t.args);
  try {
    await until(() => runDirs(t.runs).some(d => existsSync(join(d, 'cases/interrupted/workspace/descendant.json'))));
    p.child.kill('SIGINT'); assert.equal(await p.done, 2);
    const dir = runDirs(t.runs)[0]; const r = read(join(dir, 'cases/interrupted/result.json'));
    assert.equal(r.status, 'environment_error'); assert.match(r.reason, /interrupted/);
    assert.equal(read(join(dir, 'summary.json')).interrupted, true);
    assert.match(readFileSync(join(dir, 'cases/interrupted/artifacts/stdout.log'), 'utf8'), /stub/);
    assert.ok(existsSync(join(dir, 'report.md')));
    assert.throws(() => process.kill(read(join(dir, 'cases/interrupted/artifacts/descendant.json')).pid, 0), /ESRCH/);
  } finally { p.child.kill('SIGKILL'); rmSync(t.root, { recursive: true, force: true }); }
});

test('case status is emitted before a later slow case finishes', async () => {
  const t = setup(); addCase(t.cases, 'slow', undefined, 1600);
  writeSuite(t.cases, ['smoke-pass', 'slow']);
  const p = launch(t.args);
  try {
    await until(() => p.output().includes('PASS smoke-pass'));
    assert.ok(!p.output().includes('PASS slow')); assert.equal(p.child.exitCode, null);
    assert.equal(await p.done, 0);
  } finally { p.child.kill('SIGKILL'); rmSync(t.root, { recursive: true, force: true }); }
});
