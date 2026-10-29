import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execute, read, write } from './helpers.ts';

function linksWork(dir: string, name: string) {
  const markdown = readFileSync(join(dir, name), 'utf8');
  const links = [...markdown.matchAll(/\]\(([^)]+)\)/g)].map(m => m[1]);
  assert.ok(links.length > 0);
  for (const link of links) assert.ok(existsSync(resolve(dir, decodeURIComponent(link))), `missing ${link}`);
}

test('run report preserves requirement coverage and evidence when copied and regenerated', () => {
  const root = mkdtempSync(join(tmpdir(), 'e11-report-'));
  try {
    const dir = join(root, 'runs', 'run1'); mkdirSync(join(dir, 'cases', 'one'), { recursive: true });
    write(join(dir, 'config.json'), { run_id: 'run1', agent: 'stub', case_ids: ['one'], repeat: 1, cases: [{ config: { id: 'one', requirement_id: 'REQ-1' } }], requirement_catalog: [{ case_id: 'one', requirement_id: 'REQ-1' }, { case_id: 'two', requirement_id: 'REQ-2' }, { case_id: 'three', requirement_id: 'REQ-1' }] });
    write(join(dir, 'cases/one/result.json'), { case_id: 'one', status: 'fail', duration_ms: 1, assertions: [], events: join(dir, 'cases/one/events.jsonl') });
    writeFileSync(join(dir, 'cases/one/events.jsonl'), '{}\n');
    assert.equal(execute(['report', 'run1', '--runs-dir', join(root, 'runs')]).status, 0);
    const summary = read(join(dir, 'summary.json'));
    assert.equal(summary.requirement_coverage.find((r: any) => r.requirement_id === 'REQ-1').covered, true);
    assert.deepEqual(summary.requirement_coverage.find((r: any) => r.requirement_id === 'REQ-1').uncovered_case_ids, ['three']);
    assert.equal(summary.requirement_coverage.find((r: any) => r.requirement_id === 'REQ-2').covered, false);
    assert.deepEqual(summary.attempt_evidence[0], { case_id: 'one', trial: 1, result: 'cases/one/result.json', events: 'cases/one/events.jsonl', artifacts: null });
    const moved = join(root, 'moved', 'run1'); cpSync(dir, moved, { recursive: true }); rmSync(dir, { recursive: true });
    assert.equal(execute(['report', 'run1', '--runs-dir', join(root, 'moved')]).status, 0);
    linksWork(moved, 'report.md');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('compare bundles evidence and experiment conclusion for portable report regeneration', () => {
  const root = mkdtempSync(join(tmpdir(), 'e11-compare-')); const runs = join(root, 'runs');
  try {
    const fixture = read('tests/fixtures/e10/runs.json');
    for (const id of ['baseline', 'candidate']) {
      const dir = join(runs, id); mkdirSync(dir, { recursive: true });
      write(join(dir, 'config.json'), { ...fixture.config, run_id: id, requirement_catalog: [{ case_id: 'regression', requirement_id: 'REQ-1' }, { case_id: 'missing', requirement_id: 'REQ-2' }] });
      write(join(dir, 'manifest.json'), fixture.manifest);
      for (const [caseId, status] of Object.entries(fixture[id])) {
        const caseDir = join(dir, 'cases', caseId); mkdirSync(join(caseDir, 'artifacts'), { recursive: true });
        writeFileSync(join(caseDir, 'events.jsonl'), '{}\n');
        write(join(caseDir, 'result.json'), { case_id: caseId, status, assertions: [] });
      }
    }
    const experiment = join(root, 'experiment.json');
    write(experiment, { schema_version: 1, hypothesis: 'better response', requirement_id: 'REQ-1', baseline_run_id: 'baseline', candidate_run_id: 'candidate', expected_changes: ['fewer failures'] });
    const compared = execute(['compare', 'baseline', 'candidate', '--runs-dir', runs, '--experiment-record', experiment]);
    assert.equal(compared.status, 0, compared.stderr);
    const dir = join(runs, 'comparisons/baseline--candidate'); const report = read(join(dir, 'compare.json'));
    assert.equal(report.experiment.hypothesis, 'better response');
    assert.equal(report.experiment.requirement_id, 'REQ-1');
    assert.match(report.experiment_conclusion, /1 regressed/);
    assert.ok(report.experiment_evidence.every((p: string) => existsSync(join(dir, p))));
    assert.ok(report.cases.flatMap((c: any) => [...c.baseline, ...c.candidate]).filter((a: any) => a.result).every((a: any) => existsSync(join(dir, a.result))));
    assert.equal(report.requirement_coverage.find((r: any) => r.requirement_id === 'REQ-2').covered, false);
    const moved = join(root, 'moved', 'comparison'); cpSync(dir, moved, { recursive: true }); rmSync(runs, { recursive: true }); rmSync(experiment);
    assert.equal(execute(['report', 'comparison', '--runs-dir', join(root, 'moved')]).status, 0);
    linksWork(moved, 'compare.md');
    const markdown = readFileSync(join(moved, 'compare.md'), 'utf8');
    assert.match(markdown, /REQ-1/); assert.match(markdown, /REQ-2/); assert.match(markdown, /better response/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('selecting a case does not validate unrelated case dependencies', () => {
  const root = mkdtempSync(join(tmpdir(), 'e11-selected-'));
  try {
    const cases = join(root, 'cases'); const runs = join(root, 'runs');
    cpSync('cases/smoke', join(cases, 'smoke'), { recursive: true });
    rmSync(join(cases, 'smoke/smoke-fail/initial-state.json'));
    const result = execute(['--suite', 'smoke', '--case', 'smoke-pass', '--agent', 'stub', '--cases-dir', cases, '--runs-dir', runs]);
    assert.equal(result.status, 0, result.stderr);
    const config = read(join(runs, readdirSync(runs)[0], 'config.json'));
    assert.deepEqual(config.requirement_catalog.map((c: any) => c.case_id), ['smoke-pass', 'smoke-fail']);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
