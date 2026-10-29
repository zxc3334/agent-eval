import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const cli = resolve('src/cli.ts');
function invoke(...args: string[]) { return spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8' }); }
function fixture(root: string, id: string) {
  const dir = join(root, id); mkdirSync(dir);
  writeFileSync(join(dir, 'config.json'), JSON.stringify({ run_id: id }));
  writeFileSync(join(dir, 'manifest.json'), JSON.stringify({ schema_version: 1 }));
}

test('baseline set records explicit selections and rejects missing runs without changing history', () => {
  const root = mkdtempSync(join(tmpdir(), 'eval-baseline-'));
  try {
    fixture(root, 'first'); fixture(root, 'second');
    const first = invoke('baseline', 'set', 'first', '--runs-dir', root);
    assert.equal(first.status, 0, first.stderr);
    const initial = JSON.parse(readFileSync(join(root, 'baseline.json'), 'utf8'));
    assert.equal(initial.run_id, 'first');
    assert.deepEqual(initial.history.map((item: any) => item.run_id), ['first']);
    assert.ok(Number.isFinite(Date.parse(initial.history[0].selected_at)));
    const invalid = invoke('baseline', 'set', 'missing', '--runs-dir', root);
    assert.equal(invalid.status, 2);
    assert.deepEqual(JSON.parse(readFileSync(join(root, 'baseline.json'), 'utf8')), initial);
    const second = invoke('baseline', 'set', 'second', '--runs-dir', root);
    assert.equal(second.status, 0, second.stderr);
    const current = JSON.parse(readFileSync(join(root, 'baseline.json'), 'utf8'));
    assert.equal(current.run_id, 'second');
    assert.deepEqual(current.history.map((item: any) => item.run_id), ['first', 'second']);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
