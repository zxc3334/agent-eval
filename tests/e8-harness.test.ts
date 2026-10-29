import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { loadExperiment } from '../src/config.ts';
import { generateReport } from '../src/report.ts';

test('product experiment is accepted and product reports describe actual attempts', () => {
  const dir = mkdtempSync(join(tmpdir(), 'e8-report-'));
  try {
    const experiment = join(dir, 'experiment.json');
    writeFileSync(experiment, JSON.stringify({ adapter: 'jackson-bot-pi', model: 'test', product: {} }));
    assert.equal(loadExperiment(experiment).adapter, 'jackson-bot-pi');
    writeFileSync(join(dir, 'config.json'), JSON.stringify({ run_id: 'test', agent: 'jackson-bot-pi', case_ids: ['a'], config_source: 'test' }));
    mkdirSync(join(dir, 'cases', 'a'), { recursive: true });
    writeFileSync(join(dir, 'cases', 'a', 'result.json'), JSON.stringify({ case_id: 'a', status: 'fail', duration_ms: 1, assertions: [], events: 'events.jsonl', agent_started: true }));
    const summary = generateReport(dir);
    assert.equal(summary.real_agent_attempted, 1);
    assert.equal(summary.real_agent_pass_rate, 0);
    assert.doesNotMatch(readFileSync(join(dir, 'report.md'), 'utf8'), /未运行真实 jackson-bot|not jackson-bot/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('harness evidence cannot be overwritten through the artifact allowlist', async () => {
  const { outputName } = await import('../src/artifact-freeze.ts');
  for (const name of ['product-events.jsonl', 'product-request.json']) {
    assert.equal(outputName(name), false, `${name} is harness evidence`);
  }
});
