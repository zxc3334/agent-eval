import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { execute, read, write } from './helpers.ts';

const fixture = read('tests/fixtures/e10/runs.json');

function fixedRuns() {
  const root = mkdtempSync(join(tmpdir(), 'agent-eval-e10-'));
  const runs = join(root, 'runs');
  for (const id of ['baseline', 'candidate'] as const) {
    const dir = join(runs, id); mkdirSync(dir, { recursive: true });
    write(join(dir, 'config.json'), { ...fixture.config, run_id: id });
    write(join(dir, 'manifest.json'), fixture.manifest);
    for (const [caseId, status] of Object.entries(fixture[id])) {
      const caseDir = join(dir, 'cases', caseId);
      mkdirSync(join(caseDir, 'artifacts'), { recursive: true });
      const artifact = join(caseDir, 'artifacts', 'answer.json');
      const events = join(caseDir, 'events.jsonl');
      write(artifact, { answer: status === 'pass' ? 'hello' : 'wrong' });
      writeFileSync(events, '{"event":"fixture"}\n');
      write(join(caseDir, 'result.json'), {
        case_id: caseId, status, duration_ms: 1, events,
        assertions: status === 'agent_error' ? [] : [{ criterion_id: 'answer-equals', passed: status === 'pass', artifact }],
      });
    }
  }
  return { root, runs, close: () => rmSync(root, { recursive: true, force: true }) };
}

test('fixed results report pass-to-fail, fail-to-pass, unchanged and run fault with regression evidence', () => {
  const t = fixedRuns();
  try {
    const result = execute(['compare', 'baseline', 'candidate', '--runs-dir', t.runs]);
    assert.equal(result.status, 0, result.stderr);
    for (const label of ['improve', 'regress', 'flat', 'error-change']) assert.match(result.stdout, new RegExp(label));
    const dir = join(t.runs, 'comparisons', 'baseline--candidate');
    const report = read(join(dir, 'compare.json'));
    assert.equal(report.compatible, true);
    assert.deepEqual(Object.fromEntries(report.cases.map((c: any) => [c.case_id, c.classification])), {
      regression: 'regress', improvement: 'improve', unchanged: 'flat', fault: 'error-change',
    });
    const markdown = readFileSync(join(dir, 'compare.md'), 'utf8');
    for (const side of ['baseline', 'candidate']) {
      for (const path of ['result.json', 'events.jsonl', 'artifacts']) {
        const expected = join(t.runs, side, 'cases', 'regression', path);
        assert.ok(existsSync(expected));
        assert.ok(markdown.includes(expected) || markdown.includes(expected.replace(t.runs + '/', '../../')), `${side} ${path} is linked in report`);
      }
    }
  } finally { t.close(); }
});

test('content, experiment, repeat and undeclared environment changes prevent an overall conclusion', () => {
  const changes: [string, (manifest: any) => void][] = [
    ['suite', m => { m.suite.sha256 = 'changed-suite'; }],
    ['case', m => { m.cases[0].files['acceptance.json'] = 'changed-case'; }],
    ['verifier', m => { m.verifier.sha256 = 'changed-verifier'; }],
    ['experiment', m => { m.effective_config.experiment.product.temperature = 0.9; }],
    ['repeat', m => { m.effective_config.repeat = 2; }],
    ['platform', m => { m.platform.node = 'another-node'; }],
    ['adapter', m => { m.adapter.name = 'oracle'; m.effective_config.experiment.adapter = 'oracle'; }],
  ];
  for (const [label, change] of changes) {
    const t = fixedRuns();
    try {
      const file = join(t.runs, 'candidate', 'manifest.json'); const manifest = read(file); change(manifest); write(file, manifest);
      const result = execute(['compare', 'baseline', 'candidate', '--runs-dir', t.runs]);
      assert.ok(result.status === 0 || result.status === 1 || result.status === 2, `${label}: ${result.stderr}`);
      const report = read(join(t.runs, 'comparisons/baseline--candidate/compare.json'));
      assert.equal(report.compatible, false, label);
      assert.match(JSON.stringify(report.reasons), new RegExp(label, 'i'), label);
      assert.ok(report.conclusion == null || /incompat|unavailable|no .*conclusion/i.test(String(report.conclusion)), label);
    } finally { t.close(); }
  }
});

test('declared model and product revision changes remain visible along with other differences', () => {
  const t = fixedRuns();
  try {
    const file = join(t.runs, 'candidate', 'manifest.json'); const m = read(file);
    m.model = 'model-b'; m.effective_config.experiment.model = 'model-b'; m.product_revision = 'revision-b';
    m.effective_config.experiment.product.temperature = 0.9;
    write(file, m);
    const result = execute(['compare', 'baseline', 'candidate', '--runs-dir', t.runs, '--vary', 'model', '--vary', 'product_revision']);
    assert.ok(result.status === 0 || result.status === 1 || result.status === 2, result.stderr);
    const report = read(join(t.runs, 'comparisons/baseline--candidate/compare.json'));
    assert.equal(report.compatible, false);
    const details = JSON.stringify(report.differences);
    for (const value of ['model-b', 'revision-b', 'temperature']) assert.ok(details.includes(value), value);
  } finally { t.close(); }
});

test('declared model, prompt and product revision changes can each be compared and remain visible', () => {
  for (const variable of ['model', 'prompt', 'product_revision']) {
    const t = fixedRuns();
    try {
      const manifestFile = join(t.runs, 'candidate', 'manifest.json'); const m = read(manifestFile);
      const configFile = join(t.runs, 'candidate', 'config.json'); const c = read(configFile);
      if (variable === 'model') { c.experiment.model = 'model-b'; m.effective_config.experiment.model = 'model-b'; m.model = 'model-b'; }
      if (variable === 'prompt') { c.experiment.product.prompt = 'prompt-b'; m.effective_config.experiment.product.prompt = 'prompt-b'; }
      if (variable === 'product_revision') m.product_revision = 'revision-b';
      if (variable !== 'product_revision') m.experiment_sha256 = 'different-experiment-hash';
      write(configFile, c); write(manifestFile, m);
      const result = execute(['compare', 'baseline', 'candidate', '--runs-dir', t.runs, '--vary', variable]);
      assert.equal(result.status, 0, `${variable}: ${result.stdout} ${result.stderr}`);
      const report = read(join(t.runs, 'comparisons/baseline--candidate/compare.json'));
      assert.equal(report.compatible, true, variable);
      assert.ok(report.differences.some((d: any) => d.declared && JSON.stringify(d.candidate).includes(variable === 'model' ? 'model-b' : variable === 'prompt' ? 'prompt-b' : 'revision-b')), variable);
    } finally { t.close(); }
  }
});

test('unknown model or revision cannot establish real product identity', () => {
  const t = fixedRuns();
  try {
    for (const id of ['baseline', 'candidate']) {
      const configFile = join(t.runs, id, 'config.json'); const c = read(configFile);
      const manifestFile = join(t.runs, id, 'manifest.json'); const m = read(manifestFile);
      c.agent = c.experiment.adapter = 'jackson-bot-pi'; m.adapter.name = m.effective_config.experiment.adapter = 'jackson-bot-pi';
      m.product_revision = 'unknown'; m.model = 'unknown';
      write(configFile, c); write(manifestFile, m);
    }
    execute(['compare', 'baseline', 'candidate', '--runs-dir', t.runs]);
    const report = read(join(t.runs, 'comparisons/baseline--candidate/compare.json'));
    assert.equal(report.compatible, false);
    assert.match(JSON.stringify(report.reasons), /unknown/i);
    assert.equal(report.conclusion, null);
  } finally { t.close(); }
});

test('missing content identity on both sides and a mismatched run id cannot produce a conclusion', () => {
  for (const field of ['case version', 'case files', 'verifier version', 'run id']) {
    const t = fixedRuns();
    try {
      for (const id of ['baseline', 'candidate']) {
        const manifestFile = join(t.runs, id, 'manifest.json'); const m = read(manifestFile);
        const configFile = join(t.runs, id, 'config.json'); const c = read(configFile);
        if (field === 'case version') delete m.cases[0].version;
        if (field === 'case files') delete m.cases[0].files;
        if (field === 'verifier version') delete m.verifier.version;
        if (field === 'run id') c.run_id = 'wrong-id';
        write(configFile, c); write(manifestFile, m);
      }
      execute(['compare', 'baseline', 'candidate', '--runs-dir', t.runs]);
      const report = read(join(t.runs, 'comparisons/baseline--candidate/compare.json'));
      assert.equal(report.compatible, false, field);
      assert.ok(report.reasons.length, field);
      assert.equal(report.conclusion, null, field);
    } finally { t.close(); }
  }
});

test('a declared model change does not hide changes in other experiment fields', () => {
  const t = fixedRuns();
  try {
    const manifestFile = join(t.runs, 'candidate', 'manifest.json'); const m = read(manifestFile);
    const configFile = join(t.runs, 'candidate', 'config.json'); const c = read(configFile);
    c.experiment.model = m.effective_config.experiment.model = m.model = 'model-b';
    m.experiment_sha256 = 'new-hash'; m.experiment_extra_fields.unrecognized = 'new-field-hash';
    write(configFile, c); write(manifestFile, m);
    execute(['compare', 'baseline', 'candidate', '--runs-dir', t.runs, '--vary', 'model']);
    const report = read(join(t.runs, 'comparisons/baseline--candidate/compare.json'));
    assert.equal(report.compatible, false);
    assert.match(JSON.stringify(report.reasons), /experiment_extra_fields.*unrecognized/);
    assert.equal(report.conclusion, null);
  } finally { t.close(); }
});

test('real repeated runs compare all trials and report a missing trial as a run fault', () => {
  const t = fixedRuns();
  try {
    for (let i = 0; i < 2; i++) {
      const result = execute(['--suite', 'smoke', '--case', 'smoke-pass', '--agent', 'stub', '--repeat', '2', '--runs-dir', t.runs]);
      assert.equal(result.status, 0, result.stderr);
    }
    const dirs = readdirSync(t.runs).filter(id => id !== 'baseline' && id !== 'candidate').sort();
    assert.equal(dirs.length, 2);
    let result = execute(['compare', dirs[0], dirs[1], '--runs-dir', t.runs]);
    assert.equal(result.status, 0, result.stderr);
    const compareDir = join(t.runs, 'comparisons', `${dirs[0]}--${dirs[1]}`);
    assert.equal(read(join(compareDir, 'compare.json')).cases[0].classification, 'flat');
    const changed = join(t.runs, dirs[1], 'cases/smoke-pass/trials/1/result.json');
    const changedResult = read(changed); changedResult.status = 'fail'; write(changed, changedResult);
    result = execute(['compare', dirs[0], dirs[1], '--runs-dir', t.runs]);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(read(join(compareDir, 'compare.json')).cases[0].classification, 'regress');
    const markdown = readFileSync(join(compareDir, 'compare.md'), 'utf8');
    const links = [...markdown.matchAll(/\]\(([^)]+)\)/g)].map(match => resolve(compareDir, decodeURIComponent(match[1])));
    for (const id of dirs) for (const trial of [1, 2]) for (const name of ['result.json', 'events.jsonl', 'artifacts']) {
      const target = join(t.runs, id, 'cases/smoke-pass/trials', String(trial), name);
      assert.ok(links.includes(target), `missing link to ${target}`);
      assert.ok(existsSync(target), `broken link to ${target}`);
    }
    rmSync(join(t.runs, dirs[1], 'cases/smoke-pass/trials/2/result.json'));
    result = execute(['compare', dirs[0], dirs[1], '--runs-dir', t.runs]);
    assert.ok(result.status === 0 || result.status === 1 || result.status === 2, result.stderr);
    assert.equal(read(join(compareDir, 'compare.json')).cases[0].classification, 'error-change');
  } finally { t.close(); }
});

test('baseline is explicitly selected and history survives later runs', () => {
  const t = fixedRuns();
  try {
    assert.equal(existsSync(join(t.runs, 'baseline.json')), false);
    let result = execute(['baseline', 'set', 'baseline', '--runs-dir', t.runs]);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(read(join(t.runs, 'baseline.json')).run_id, 'baseline');
    result = execute(['--suite', 'smoke', '--case', 'smoke-pass', '--agent', 'stub', '--runs-dir', t.runs]);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(read(join(t.runs, 'baseline.json')).run_id, 'baseline');
    result = execute(['baseline', 'set', 'candidate', '--runs-dir', t.runs]);
    assert.equal(result.status, 0, result.stderr);
    const baseline = read(join(t.runs, 'baseline.json'));
    assert.equal(baseline.run_id, 'candidate');
    assert.deepEqual(baseline.history.map((entry: any) => entry.run_id), ['baseline', 'candidate']);
    assert.ok(baseline.history.every((entry: any) => !Number.isNaN(Date.parse(entry.selected_at))));
  } finally { t.close(); }
});
