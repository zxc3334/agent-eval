import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { setup, execute, runDirs, read, write } from './helpers.ts';

test('repeat retains independent trials and reports every result and reproducibility data', () => {
  const t = setup();
  try {
    const result = execute([...t.args, '--case', 'smoke-pass', '--repeat', '2']);
    assert.equal(result.status, 0, result.stderr);
    const dir = runDirs(t.runs)[0];
    const one = join(dir, 'cases/smoke-pass/trials/1');
    const two = join(dir, 'cases/smoke-pass/trials/2');
    assert.equal(read(join(one, 'result.json')).status, 'pass');
    assert.equal(read(join(two, 'result.json')).status, 'pass');
    assert.notEqual(read(join(one, 'session.json')).id, read(join(two, 'session.json')).id);
    const report = readFileSync(join(dir, 'report.md'), 'utf8');
    assert.match(report, /smoke-pass/); assert.match(report, /2\/2/);
    assert.match(report, /unknown/i); assert.match(report, /--rerun/); assert.match(report, /config\.json/);
    assert.ok(read(join(dir, 'manifest.json')).artifacts);
    assert.match(result.stdout, /smoke-pass.*(prepare|agent)/i);
  } finally { rmSync(t.root, { recursive: true, force: true }); }
});

test('rerun compares local fixture and displays differences before execution', () => {
  const t = setup();
  try {
    assert.equal(execute([...t.args, '--case', 'smoke-pass']).status, 0);
    const source = runDirs(t.runs)[0];
    write(join(t.cases, 'smoke/smoke-pass/fixture.json'), { answer: 'changed' });
    const result = execute(['--rerun', basename(source), '--runs-dir', t.runs]);
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stdout, /fixture\.json/);
    assert.match(result.stdout, /differ|mismatch|changed/i);
    assert.ok(result.stdout.indexOf('fixture.json') < result.stdout.indexOf('Run directory:'));
  } finally { rmSync(t.root, { recursive: true, force: true }); }
});

test('repeat rejects invalid counts', () => {
  const t = setup();
  try { for (const count of ['0', '-1', '1.5', 'abc']) assert.equal(execute([...t.args, '--repeat', count]).status, 2); }
  finally { rmSync(t.root, { recursive: true, force: true }); }
});

test('rerun shows changed inputs even if the new fixture is invalid', () => {
  const t = setup();
  try {
    assert.equal(execute([...t.args, '--case', 'smoke-pass']).status, 0);
    const source = runDirs(t.runs)[0];
    writeFileSync(join(t.cases, 'smoke/smoke-pass/fixture.json'), '{invalid');
    const result = execute(['--rerun', basename(source), '--runs-dir', t.runs]);
    assert.equal(result.status, 2);
    assert.match(result.stdout, /source differences[\s\S]*fixture\.json/i);
    assert.match(result.stderr, /JSON\/read/);
  } finally { rmSync(t.root, { recursive: true, force: true }); }
});
