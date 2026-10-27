import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCase } from '../src/scaffold.ts';
import { loadCase, suiteCases } from '../src/config.ts';
import { execute, read, runDirs, setup, write } from './helpers.ts';

test('case new generates a linked private brief and a runnable v2 template in a new suite', () => {
  const root = mkdtempSync(join(tmpdir(), 'agent-eval-scaffold-'));
  const cases = join(root, 'cases'); const runs = join(root, 'runs');
  try {
    const result = execute(['case', 'new', 'draft', '--requirement', 'REQ-42', '--suite', 'local', '--cases-dir', cases]);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Created case:.*draft/);
    assert.match(result.stdout, /reviewed=false/);
    assert.ok(!existsSync(runs));
    const refs = suiteCases(cases, 'local');
    assert.deepEqual(refs, [{ id: 'draft', version: '1.0.0' }]);
    const c = loadCase(cases, 'local', refs[0]);
    assert.equal(c.config.requirement_id, 'REQ-42');
    assert.equal(c.config.schema_version, 2);
    assert.equal(c.acceptance.reviewed, false);
    const dir = join(cases, 'local/draft');
    assert.deepEqual(readdirSync(dir).sort(), ['acceptance.json', 'brief.md', 'case.json', 'fixture.json', 'gold.md', 'initial-state.json', 'input.json', 'solve.ts']);
    const brief = readFileSync(join(dir, c.config.brief!), 'utf8');
    for (const text of ['requirement_id: REQ-42', '目标行为', '退化信号', '验收标准', 'answer-equals']) assert.ok(brief.includes(text), text);
    // Private sentinels must stay out of the actual serialized adapter input/workspace.
    writeFileSync(join(dir, 'brief.md'), brief + '\nPRIVATE_BRIEF_SENTINEL\n');
    write(join(dir, 'acceptance.json'), { ...c.acceptance, gold: { answer: 'PRIVATE_GOLD_SENTINEL' } });
    const run = execute(['--suite', 'local', '--case', 'draft', '--cases-dir', cases, '--runs-dir', runs]);
    assert.equal(run.status, 1, run.stderr);
    assert.match(run.stdout, /FAIL draft/);
    const caseRun = join(runDirs(runs)[0], 'cases/draft');
    assert.deepEqual(read(join(caseRun, 'workspace/input.json')), c.input);
    assert.doesNotMatch(readFileSync(join(caseRun, 'workspace/input.json'), 'utf8'), /PRIVATE_|REQ-42|requirement_id|brief|gold|criteria|reviewed|error_examples|TODO_EXPECTED_ANSWER/);
    assert.ok(!existsSync(join(caseRun, 'workspace/brief.md')));
    assert.ok(!existsSync(join(caseRun, 'workspace/acceptance.json')));
    assert.equal(read(join(caseRun, 'snapshot.json')).config.requirement_id, 'REQ-42');
    assert.equal(read(join(caseRun, 'result.json')).assertions[0].criterion_id, 'answer-equals');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('case new defaults to smoke, preserves suite metadata, and supports multiple cases per requirement', () => {
  const t = setup(); const suiteFile = join(t.cases, 'smoke/suite.json');
  try {
    const original = read(suiteFile);
    write(suiteFile, { ...original, description: 'Keep this' });
    for (const id of ['first', 'second']) {
      const result = execute(['case', 'new', id, '--requirement', 'REQ-1', '--cases-dir', t.cases]);
      assert.equal(result.status, 0, result.stderr);
      assert.equal(loadCase(t.cases, 'smoke', { id, version: '1.0.0' }).config.requirement_id, 'REQ-1');
    }
    assert.deepEqual(read(suiteFile), { ...original, description: 'Keep this', cases: [...original.cases,
      { id: 'first', version: '1.0.0' }, { id: 'second', version: '1.0.0' }] });
  } finally { rmSync(t.root, { recursive: true, force: true }); }
});

test('duplicate case directories and registered IDs are refused without overwriting user files', () => {
  const t = setup(); const suiteFile = join(t.cases, 'smoke/suite.json');
  try {
    const manifest = readFileSync(suiteFile, 'utf8');
    const dir = createCase(t.cases, 'smoke', 'draft', 'REQ-1');
    writeFileSync(join(dir, 'brief.md'), 'User edits');
    const registered = readFileSync(suiteFile, 'utf8');
    const repeat = execute(['case', 'new', 'draft', '--requirement', 'REQ-2', '--cases-dir', t.cases]);
    assert.equal(repeat.status, 2);
    assert.match(repeat.stderr, /already exists/);
    assert.equal(readFileSync(join(dir, 'brief.md'), 'utf8'), 'User edits');
    assert.equal(readFileSync(suiteFile, 'utf8'), registered);
    rmSync(dir, { recursive: true });
    assert.throws(() => createCase(t.cases, 'smoke', 'draft', 'REQ-1'), /already exists/);
    assert.ok(!existsSync(dir));
    writeFileSync(suiteFile, manifest);
    mkdirSync(dir); writeFileSync(join(dir, 'notes.txt'), 'Unregistered work');
    assert.throws(() => createCase(t.cases, 'smoke', 'draft', 'REQ-1'), /already exists/);
    assert.equal(readFileSync(join(dir, 'notes.txt'), 'utf8'), 'Unregistered work');
    assert.equal(readFileSync(suiteFile, 'utf8'), manifest);
  } finally { rmSync(t.root, { recursive: true, force: true }); }
});

test('invalid command arguments and path-like IDs fail before creating files', () => {
  const root = mkdtempSync(join(tmpdir(), 'agent-eval-scaffold-'));
  const cases = join(root, 'cases');
  try {
    const badArgs = [
      ['case', 'new', 'draft'], ['case', 'new', '--requirement', 'REQ-1'],
      ['case', 'new', 'draft', 'extra', '--requirement', 'REQ-1'],
      ['case', 'remove', 'draft', '--requirement', 'REQ-1'],
      ['case', 'new', '../escape', '--requirement', 'REQ-1'],
      ['case', 'new', 'draft', '--requirement', '../escape'],
      ['case', 'new', 'draft', '--requirement', ''],
      ['case', 'new', 'draft', '--requirement', 'REQ-1', '--suite', '../escape'],
      ['case', 'new', 'draft', '--requirement', 'REQ-1', '--watch'],
      ['case', 'new', 'draft', '--requirement', 'REQ-1', '--agent', 'stub'],
      ['--requirement', 'REQ-1'],
    ];
    for (const args of badArgs) {
      const result = execute([...args, '--cases-dir', cases]);
      assert.equal(result.status, 2, JSON.stringify(args));
      assert.match(result.stderr, /usage:|invalid identifier|unsupported option|only supported/);
      assert.ok(!existsSync(cases));
    }
    const help = execute(['case', 'new', '--help', '--cases-dir', cases]);
    assert.equal(help.status, 0);
    assert.match(help.stdout, /case new <id> --requirement <id>/);
    assert.ok(!existsSync(cases));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('invalid manifests and an active writer leave existing suite content intact', () => {
  const t = setup(); const suiteDir = join(t.cases, 'smoke'); const suiteFile = join(suiteDir, 'suite.json');
  try {
    writeFileSync(suiteFile, '{broken');
    assert.throws(() => createCase(t.cases, 'smoke', 'draft', 'REQ-1'), /JSON\/read/);
    assert.equal(readFileSync(suiteFile, 'utf8'), '{broken');
    assert.ok(!existsSync(join(suiteDir, 'draft')));
    assert.ok(!existsSync(join(suiteDir, '.case-new.lock')));
    writeFileSync(join(suiteDir, '.case-new.lock'), 'Another writer');
    assert.throws(() => createCase(t.cases, 'smoke', 'draft', 'REQ-1'), /already in progress/);
    assert.equal(readFileSync(join(suiteDir, '.case-new.lock'), 'utf8'), 'Another writer');
  } finally { rmSync(t.root, { recursive: true, force: true }); }
});

test('failed suite publication rolls back the newly created case', () => {
  const t = setup(); const suiteDir = join(t.cases, 'smoke'); const suiteFile = join(suiteDir, 'suite.json');
  try {
    const original = readFileSync(suiteFile, 'utf8');
    mkdirSync(`${suiteFile}.tmp`); // Force the existing atomic JSON writer to fail.
    assert.throws(() => createCase(t.cases, 'smoke', 'draft', 'REQ-1'), /EISDIR/);
    assert.equal(readFileSync(suiteFile, 'utf8'), original);
    assert.ok(!existsSync(join(suiteDir, 'draft')));
    assert.ok(!existsSync(join(suiteDir, '.case-new.lock')));
  } finally { rmSync(t.root, { recursive: true, force: true }); }
});

test('authoring metadata is optional for old v2 cases and validated when present', () => {
  const t = setup();
  try {
    assert.equal(loadCase(t.cases, 'smoke', { id: 'smoke-pass', version: '1.0.0' }).config.requirement_id, undefined);
    const dir = createCase(t.cases, 'smoke', 'draft', 'REQ-1');
    const file = join(dir, 'case.json'); const original = read(file);
    const load = () => loadCase(t.cases, 'smoke', { id: 'draft', version: '1.0.0' });
    write(file, { ...original, requirement_id: '../escape' });
    assert.throws(load, /requirement_id: invalid identifier/);
    write(file, { ...original, brief: '../brief.md' });
    assert.throws(load, /brief: path must stay inside case directory/);
    write(file, original);
    writeFileSync(join(dir, 'brief.md'), '  \n');
    assert.throws(load, /brief: expected nonempty document/);
  } finally { rmSync(t.root, { recursive: true, force: true }); }
});
