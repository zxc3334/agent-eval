import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const template = join(process.cwd(), 'experiments', 'feedback.template.json');

test('experiment template records the hypothesis, requirement, run IDs and expected changes', () => {
  assert.ok(existsSync(template), 'experiment feedback template should exist');
  const record = JSON.parse(readFileSync(template, 'utf8'));
  for (const key of ['hypothesis', 'requirement_id', 'baseline_run_id', 'candidate_run_id']) assert.equal(typeof record[key], 'string', key);
  assert.ok(Array.isArray(record.expected_changes) && record.expected_changes.length > 0);
});

test('completed experiment records are validated without running any agent', async () => {
  const { readExperimentRecord } = await import('../src/experiment-record.ts');
  const dir = mkdtempSync(join(tmpdir(), 'experiment-record-'));
  try {
    const file = join(dir, 'record.json');
    const record = { schema_version: 1, hypothesis: 'Reduce missing citations', requirement_id: 'REQ-1', baseline_run_id: 'baseline', candidate_run_id: 'candidate', expected_changes: ['More citations'] };
    writeFileSync(file, JSON.stringify(record));
    assert.deepEqual(readExperimentRecord(file), record);
    for (const invalid of [{ ...record, expected_changes: [] }, { ...record, candidate_run_id: '../candidate' }, { ...record, hypothesis: ' ' }]) {
      writeFileSync(file, JSON.stringify(invalid));
      assert.throws(() => readExperimentRecord(file));
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
