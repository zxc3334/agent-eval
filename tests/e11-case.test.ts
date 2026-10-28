import { test } from 'node:test';
import assert from 'node:assert/strict';
import { basename, join } from 'node:path';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { execute, read, runDirs, setup, write } from './helpers.ts';

test('failure feedback retains source evidence and requires calibration before review', () => {
  const t = setup();
  try {
    const sourceCase = join(t.cases, 'smoke/smoke-fail/case.json');
    write(sourceCase, { ...read(sourceCase), requirement_id: 'REQ-11' });
    assert.equal(execute([...t.args, '--case', 'smoke-fail']).status, 1);
    const run = basename(runDirs(t.runs)[0]);
    const args = ['case', 'new', 'feedback-one', '--from-run', run, '--case', 'smoke-fail', '--suite', 'feedback', ...t.args];
    const created = execute(args); assert.equal(created.status, 0, created.stderr);
    const dir = join(t.cases, 'feedback/feedback-one');
    const config = read(join(dir, 'case.json')); const acceptance = read(join(dir, 'acceptance.json'));
    assert.equal(config.requirement_id, 'REQ-11');
    assert.equal(config.source_evidence.run_id, run);
    assert.equal(read(join(dir, config.source_evidence.result)).status, 'fail');
    assert.ok(existsSync(join(dir, 'source-evidence/events.jsonl')));
    assert.ok(existsSync(join(dir, 'source-evidence/artifacts/answer.json')));
    assert.equal(acceptance.reviewed, false);
    assert.equal(acceptance.gold.answer, 'TODO_EXPECTED_ANSWER');
    assert.match(readFileSync(join(dir, 'brief.md'), 'utf8'), /smoke-fail/);
    write(join(dir, 'acceptance.json'), { ...acceptance, reviewed: true });
    const invalid = execute(['validate', '--schema-only', '--suite', 'feedback', '--cases-dir', t.cases]);
    assert.equal(invalid.status, 2); assert.match(invalid.stderr, /review|calibration/i);
    const invalidRun = execute(['--suite', 'feedback', ...t.args]);
    assert.equal(invalidRun.status, 2); assert.match(invalidRun.stderr, /review|calibration/i);
    write(join(dir, 'acceptance.json'), acceptance);
    writeFileSync(join(dir, 'solve.ts'), "import { writeFileSync } from 'node:fs';\nwriteFileSync('answer.json', JSON.stringify({answer:'TODO_EXPECTED_ANSWER'}));\n");
    const placeholders = execute(['validate', '--suite', 'feedback', ...t.args]);
    assert.notEqual(placeholders.status, 0); assert.match(placeholders.stderr, /TODO/);
    write(join(dir, 'acceptance.json'), { ...acceptance, gold: { answer: 'good' }, criteria: [{ ...acceptance.criteria[0], params: { expected: 'good' }, reason: 'must be correct' }], error_examples: [{ answer: 'bad', reason: 'incorrect response', expected_failed_criteria: ['answer-equals'] }] });
    writeFileSync(join(dir, 'gold.md'), '# Independent reference\nDerive the expected answer from the task.\n');
    writeFileSync(join(dir, 'solve.ts'), "import { writeFileSync } from 'node:fs';\nwriteFileSync('answer.json', JSON.stringify({answer:'good'}));\n");
    const validated = execute(['validate', '--suite', 'feedback', ...t.args]); assert.equal(validated.status, 0, validated.stderr);
    const authored = read(join(dir, 'acceptance.json')); write(join(dir, 'acceptance.json'), { ...authored, reviewed: true });
    assert.equal(execute(['validate', '--schema-only', '--suite', 'feedback', '--cases-dir', t.cases]).status, 0);
    const resultFile = join(dir, config.source_evidence.result);
    const originalResult = readFileSync(resultFile, 'utf8');
    writeFileSync(resultFile, `${originalResult} `);
    const changedEvidence = execute(['--suite', 'feedback', ...t.args]);
    assert.equal(changedEvidence.status, 2); assert.match(changedEvidence.stderr, /review|calibration/i);
    writeFileSync(resultFile, originalResult);
    writeFileSync(join(dir, 'gold.md'), '# Independent reference\nRevised explanation of the expected answer.\n');
    assert.equal(execute(['--suite', 'feedback', ...t.args]).status, 2);
    const recalibrated = execute(['validate', '--suite', 'feedback', ...t.args]);
    assert.equal(recalibrated.status, 0, recalibrated.stderr);
    assert.equal(execute(['--suite', 'feedback', ...t.args]).status, 1);
    writeFileSync(join(dir, 'gold.md'), '# TODO\n');
    assert.notEqual(execute(['validate', '--suite', 'feedback', ...t.args]).status, 0);
    assert.equal(read(join(dir, '.calibration.json')).status, 'pending');
    assert.equal(execute(['--suite', 'feedback', ...t.args]).status, 2);
    writeFileSync(join(dir, 'gold.md'), '# Independent reference\nRevised explanation of the expected answer.\n');
    assert.equal(execute(['validate', '--suite', 'feedback', ...t.args]).status, 0);
    const firstRun = execute(['--suite', 'feedback', ...t.args]); assert.equal(firstRun.status, 1, firstRun.stderr);
    const firstId = /Run ([^\s]+)/.exec(firstRun.stdout)![1];
    const before = read(join(t.cases, 'feedback/suite.json')).version;
    assert.equal(execute(['case', 'new', 'feedback-two', '--from-run', run, '--case', 'smoke-fail', '--suite', 'feedback', ...t.args]).status, 0);
    assert.notEqual(read(join(t.cases, 'feedback/suite.json')).version, before);
    const secondRun = execute(['--suite', 'feedback', ...t.args]); assert.equal(secondRun.status, 1, secondRun.stderr);
    const secondId = /Run ([^\s]+)/.exec(secondRun.stdout)![1];
    const comparison = execute(['compare', firstId, secondId, '--runs-dir', t.runs]);
    assert.equal(comparison.status, 2, comparison.stderr); assert.match(comparison.stdout, /incompatible/i); assert.match(comparison.stdout, /suite\.version/);
    assert.ok(existsSync(join(dir, '.calibration.json')));
  } finally { rmSync(t.root, { recursive: true, force: true }); }
});

test('feedback refuses passing cases and failures without a recorded requirement', () => {
  const t = setup();
  try {
    assert.equal(execute([...t.args]).status, 1);
    const run = basename(runDirs(t.runs)[0]);
    for (const id of ['smoke-pass', 'smoke-fail']) {
      const result = execute(['case', 'new', 'draft', '--from-run', run, '--case', id, '--suite', 'feedback', ...t.args]);
      assert.equal(result.status, 2);
      assert.match(result.stderr, /fail|requirement/i);
    }
  } finally { rmSync(t.root, { recursive: true, force: true }); }
});
