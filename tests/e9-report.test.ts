import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { generateReport } from '../src/report.ts';

test('report preserves every attempt, per-case counts and unknown usage', () => {
  const dir = mkdtempSync(join(tmpdir(), 'e9-report-'));
  try {
    writeFileSync(join(dir, 'config.json'), JSON.stringify({ run_id: 'run-a', agent: 'stub', case_ids: ['a', 'b'], repeat: 2, config_source: 'source' }));
    for (const [id, trial, status, usage] of [['a', 1, 'pass', { input_tokens: 5, output_tokens: 0, cost: 0.01 }], ['a', 2, 'fail', undefined], ['b', 1, 'pass', undefined]] as const) {
      const trialDir = join(dir, 'cases', id, 'trials', String(trial));
      mkdirSync(trialDir, { recursive: true });
      writeFileSync(join(trialDir, 'result.json'), JSON.stringify({ case_id: id, trial, status, duration_ms: 42, assertions: [], events: 'events', usage }));
    }
    const summary = generateReport(dir);
    assert.equal(summary.attempted, 3);
    assert.equal(summary.planned, 4);
    assert.equal(summary.counts.pass, 2);
    assert.equal(summary.counts.fail, 1);
    const report = readFileSync(join(dir, 'report.md'), 'utf8');
    assert.match(report, /a: 1\/2 passed/);
    assert.match(report, /b: 1\/2 passed/);
    assert.match(report, /a.*trial 1.*pass/i);
    assert.match(report, /a.*trial 2.*fail/i);
    assert.match(report, /b.*trial 2.*not attempted/i);
    assert.match(report, /input tokens: 5; output tokens: 0; cost: 0\.01/i);
    assert.match(report, /input tokens: unknown; output tokens: unknown; cost: unknown/i);
    assert.match(report, /42ms/);
    assert.match(report, /--rerun/);
    assert.match(report, /config\.json/);
    assert.match(report, /not.*identical/i);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
