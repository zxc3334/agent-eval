import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

test('smoke is graded by hard assertions, saves evidence, and exits 1', () => {
  const runs = mkdtempSync(join(tmpdir(), 'agent-eval-test-'));
  try {
    const result = spawnSync(process.execPath, ['src/cli.ts', '--suite', 'smoke', '--agent', 'stub', '--runs-dir', runs], { encoding: 'utf8' });
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stdout, /PASS.*smoke-pass/);
    assert.match(result.stdout, /FAIL.*smoke-fail/);
    const run = join(runs, readdirSync(runs)[0]);
    const failed = JSON.parse(readFileSync(join(run, 'cases/smoke-fail/result.json'), 'utf8'));
    assert.equal(failed.status, 'fail');
    assert.equal(failed.assertions[0].criterion_id, 'answer-equals');
    assert.equal(failed.assertions[0].expected, 'hello');
    assert.equal(failed.assertions[0].actual, 'wrong');
    assert.ok(readFileSync(join(run, 'cases/smoke-fail/events.jsonl'), 'utf8').includes('verifier'));
    assert.equal(JSON.parse(readFileSync(join(run, 'config.json'), 'utf8')).agent, 'stub');
    assert.ok(result.stdout.includes(resolve(run)));
  } finally { rmSync(runs, { recursive: true, force: true }); }
});

test('single pass exits 0; configuration failure exits 2', () => {
  const runs = mkdtempSync(join(tmpdir(), 'agent-eval-test-'));
  try {
    const pass = spawnSync(process.execPath, ['src/cli.ts', '--case', 'smoke-pass', '--runs-dir', runs], { encoding: 'utf8' });
    assert.equal(pass.status, 0, pass.stderr);
    const invalid = spawnSync(process.execPath, ['src/cli.ts', '--agent', 'real'], { encoding: 'utf8' });
    assert.equal(invalid.status, 2);
    assert.match(invalid.stderr, /agent/);
  } finally { rmSync(runs, { recursive: true, force: true }); }
});
