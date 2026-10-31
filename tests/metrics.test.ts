import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { buildVariantMetrics, compareMetric, evidenceCompleteness } from '../packages/core/src/metrics.ts';
import { parseStreamLine, summarizeCursorStream } from '../tracks/skill/src/cursor-agent.ts';
import type { StreamEvent } from '../tracks/skill/src/cursor-agent.ts';
import { countReworkRounds, measureAttempt } from '../tracks/skill/src/metrics.ts';

const repoRoot = join(import.meta.dirname, '..');
const fixtureDir = join(repoRoot, 'tests/fixtures/metrics');
const sha = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';

function loadEvents(name: string): StreamEvent[] {
  return readFileSync(join(fixtureDir, name), 'utf8')
    .split('\n')
    .map(line => parseStreamLine(line))
    .filter((event): event is StreamEvent => event !== undefined);
}

function evalCli(args: string[]) {
  return spawnSync(process.execPath, [join(repoRoot, 'src/eval.ts'), ...args], {
    cwd: repoRoot,
    encoding: 'utf8',
    timeout: 20_000,
  });
}

function writeCard(root: string, id: string, extra = ''): void {
  const dir = join(root, 'tasks', id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'card.yaml'), `schema_version: 1
id: ${id}
status: replay-ready
public:
  requirement: |
    Add hello.txt that says replayed.
  repo:
    id: example/widget
    host: other
  base_commit: "${sha}"
${extra}`);
}

function writeVariant(runDir: string, variant: string, events: string, usage?: unknown): void {
  const dir = join(runDir, 'variants', variant);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'events.jsonl'), events.endsWith('\n') ? events : `${events}\n`);
  writeFileSync(join(dir, 'result.json'), JSON.stringify({ status: 'completed', score: 'unavailable', verify: 'omitted' }));
  if (usage !== undefined) writeFileSync(join(dir, 'usage.json'), JSON.stringify(usage));
}

test('request and actual stay separate on a real stream sample', () => {
  const asked = loadEvents('request-only.jsonl');
  const answered = loadEvents('one-answer.jsonl');
  const askedSummary = summarizeCursorStream(asked, { spawned: true, aborted: false });
  const answeredSummary = summarizeCursorStream(answered, { spawned: true, aborted: false });
  const askedMetrics = measureAttempt(asked, { usage: undefined, score: 'unavailable', features: [] });
  const answeredMetrics = measureAttempt(answered, { usage: undefined, score: 'unavailable', features: [] });

  assert.equal(askedMetrics.intervention_request, askedSummary.interventions.intervention_request);
  assert.equal(askedMetrics.actual_human_intervention, askedSummary.interventions.actual_intervention);
  assert.equal(answeredMetrics.intervention_request, answeredSummary.interventions.intervention_request);
  assert.equal(answeredMetrics.actual_human_intervention, answeredSummary.interventions.actual_intervention);

  assert.equal(askedMetrics.intervention_request, 1);
  assert.equal(askedMetrics.actual_human_intervention, 0);
  assert.equal(answeredMetrics.intervention_request, 1);
  assert.equal(answeredMetrics.actual_human_intervention, 1);
  assert.equal(
    Number(answeredMetrics.actual_human_intervention) - Number(askedMetrics.actual_human_intervention),
    1,
  );
  assert.equal(Object.hasOwn(askedMetrics, 'interventions'), false);
  assert.notEqual(
    answeredMetrics.actual_human_intervention,
    Number(answeredMetrics.intervention_request) + Number(answeredMetrics.actual_human_intervention),
  );
});

test('rework counts a user-driven modify round once', () => {
  const asked = loadEvents('request-only.jsonl');
  const answered = loadEvents('one-answer.jsonl');
  const confirmed = loadEvents('confirm-after-edit.jsonl');
  assert.equal(countReworkRounds(asked, true), 0);
  assert.equal(countReworkRounds(answered.filter(event => event.subtype !== 'completed'), true), 0);
  assert.equal(countReworkRounds(answered, true), 1);
  assert.equal(countReworkRounds(answered, false), 1);
  assert.equal(countReworkRounds(confirmed, true), 1);
  assert.equal(countReworkRounds(confirmed, false), 1);
  assert.equal(countReworkRounds(asked, false), 0);

  const second = confirmed.filter(event => event.type !== 'result');
  second.push({
    type: 'tool_call',
    subtype: 'completed',
    raw: { type: 'tool_call', subtype: 'completed', tool_call: { writeToolCall: { args: { path: 'again.txt' } } } },
  });
  second.push({ type: 'result', subtype: 'success', raw: { type: 'result', subtype: 'success', result: 'done' } });
  assert.equal(countReworkRounds(second, true), 2);
});

test('missing tokens and history are unknown, and a measured zero stays zero', () => {
  const measured = loadEvents('measured-zero.jsonl');
  const metrics = measureAttempt(measured, { usage: undefined, score: 'unavailable', features: [] });
  assert.equal(metrics.intervention_request, 0);
  assert.equal(metrics.actual_human_intervention, 0);
  assert.equal(metrics.input_tokens, 0);
  assert.equal(metrics.output_tokens, 4);
  assert.equal(metrics.cost, 'unknown');
  assert.notEqual(metrics.cost, 0);
  assert.equal(metrics.evidence_completeness, 'N/A');
  assert.notEqual(metrics.evidence_completeness, 0);

  const bare = measureAttempt(loadEvents('request-only.jsonl'), { usage: { duration_ms: 'unknown' }, score: 'unavailable', features: [] });
  assert.equal(bare.input_tokens, 'unknown');
  assert.equal(bare.output_tokens, 'unknown');
  assert.equal(bare.cost, 'unknown');
  assert.equal(bare.duration_ms, 'unknown');
  assert.notEqual(bare.input_tokens, 0);

  const harness = measureAttempt(loadEvents('request-only.jsonl'), {
    usage: { duration_ms: 12 },
    score: 'unavailable',
    features: [],
  });
  assert.equal(harness.duration_ms, 12);

  const missing = measureAttempt([], { usage: undefined, score: 'unavailable', features: [] });
  assert.equal(missing.intervention_request, 'unknown');
  assert.equal(missing.actual_human_intervention, 'unknown');
  assert.equal(missing.rework_rounds, 'unknown');
  assert.notEqual(missing.intervention_request, 0);
  assert.notEqual(missing.rework_rounds, 0);

  assert.equal(evidenceCompleteness('unavailable', [{ evidence: [{}] }]), 'N/A');
  assert.equal(evidenceCompleteness('interrupted', []), 'N/A');
  assert.equal(evidenceCompleteness('pass', [{ evidence: [{}] }, { evidence: [{}] }]), 1);
  assert.equal(evidenceCompleteness('feature fail', [{ evidence: [{}] }, { evidence: [] }]), 0.5);
  assert.equal(evidenceCompleteness('verifier error', []), 0);

  const unknownDelta = compareMetric(1, 'unknown');
  assert.equal(unknownDelta.delta, 'unknown');
  assert.notEqual(unknownDelta.delta, 0);
  const noneDelta = compareMetric(1, 'none');
  assert.equal(noneDelta.baseline, 'none');
  assert.equal(noneDelta.delta, 1);

  const built = buildVariantMetrics({
    taskId: 'widget',
    runId: 'run-r8',
    variant: 'without',
    attempt: 1,
    interventionRequest: 2,
    actualHumanIntervention: 1,
    reworkRounds: 1,
    score: 'unavailable',
    features: [{ evidence: [{}] }],
    durationMs: 'unknown',
    inputTokens: 'unknown',
    outputTokens: 'unknown',
    cost: 'unknown',
    baselineInterventions: 'unknown',
    baselineReworkRounds: 'unknown',
  });
  assert.equal(built.actual_human_intervention, 1);
  assert.equal(built.comparison.interventions.replay, 1);
  assert.equal(built.comparison.interventions.delta, 'unknown');
  assert.equal(built.evidence_completeness, 'N/A');
  assert.equal(Object.hasOwn(built, 'interventions'), false);
});

test('metrics help and a no-verify fixture show both variants', () => {
  const help = evalCli(['metrics', '--help']);
  assert.equal(help.status, 0, help.stderr);
  assert.match(help.stdout, /N\/A/);
  assert.match(help.stdout, /unknown is not 0/i);

  const root = mkdtempSync(join(tmpdir(), 'agent-eval-metrics-'));
  try {
    const id = 'widget-hello';
    writeCard(root, id);
    const runs = join(root, 'runs');
    const runDir = join(runs, 'run-r8');
    mkdirSync(runDir, { recursive: true });
    writeFileSync(join(runDir, 'run.json'), JSON.stringify({ taskId: id }));
    const requestOnly = readFileSync(join(fixtureDir, 'request-only.jsonl'), 'utf8');
    const oneAnswer = readFileSync(join(fixtureDir, 'one-answer.jsonl'), 'utf8');
    writeVariant(runDir, 'without', oneAnswer, { duration_ms: 12, input_tokens: 'unknown', output_tokens: 'unknown' });
    writeVariant(runDir, 'with-skill', requestOnly, { duration_ms: 9 });
    mkdirSync(join(runDir, 'variants', 'with-skill', 'verify'), { recursive: true });
    writeFileSync(join(runDir, 'variants', 'without', 'interventions.json'), JSON.stringify({
      intervention_request: 1,
      actual_intervention: 9,
    }));
    writeFileSync(join(runDir, 'variants', 'with-skill', 'verify', 'result.json'), JSON.stringify({
      name: 'with-skill',
      score: 'unavailable',
      score_reason: 'card verify is none',
      features: [],
      phases: [],
    }));

    const collected = evalCli(['metrics', id, '--run', 'run-r8', '--root', root, '--runs-dir', runs]);
    assert.equal(collected.status, 0, collected.stderr + collected.stdout);
    const without = JSON.parse(readFileSync(join(runDir, 'variants', 'without', 'metrics.json'), 'utf8'));
    const withSkill = JSON.parse(readFileSync(join(runDir, 'variants', 'with-skill', 'metrics.json'), 'utf8'));
    assert.equal(without.actual_human_intervention, 1);
    assert.equal(without.intervention_request, 1);
    assert.notEqual(without.actual_human_intervention, 9);
    assert.notEqual(without.actual_human_intervention, 10);
    assert.equal(without.rework_rounds, 1);
    assert.equal(without.input_tokens, 'unknown');
    assert.equal(without.cost, 'unknown');
    assert.equal(without.duration_ms, 12);
    assert.equal(without.evidence_completeness, 'N/A');
    assert.equal(without.score, 'unavailable');
    assert.equal(without.baseline.interventions, 'unknown');
    assert.equal(without.comparison.interventions.delta, 'unknown');
    assert.equal(without.comparison.interventions.replay, 1);
    assert.equal(Object.hasOwn(without, 'interventions'), false);
    assert.equal(withSkill.actual_human_intervention, 0);
    assert.equal(withSkill.intervention_request, 1);
    assert.equal(withSkill.rework_rounds, 0);
    assert.equal(withSkill.evidence_completeness, 'N/A');
    assert.notEqual(withSkill.evidence_completeness, 0);
    assert.equal(withSkill.input_tokens, 'unknown');
    assert.notEqual(withSkill.input_tokens, 0);

    const shown = evalCli(['task', 'show', id, '--run', 'run-r8', '--root', root, '--runs-dir', runs]);
    assert.equal(shown.status, 0, shown.stderr + shown.stdout);
    assert.match(shown.stdout, /variant without attempt 1:/);
    assert.match(shown.stdout, /variant with-skill attempt 1:/);
    assert.match(shown.stdout, /actual_human_intervention: 1/);
    assert.match(shown.stdout, /actual_human_intervention: 0/);
    assert.match(shown.stdout, /intervention_request: 1/);
    assert.match(shown.stdout, /rework_rounds: 1/);
    assert.match(shown.stdout, /rework_rounds: 0/);
    assert.match(shown.stdout, /duration_ms: 12/);
    assert.match(shown.stdout, /duration_ms: 9/);
    assert.match(shown.stdout, /input_tokens: unknown/);
    assert.match(shown.stdout, /cost: unknown/);
    assert.match(shown.stdout, /score: unavailable/);
    assert.match(shown.stdout, /evidence_completeness: N\/A/);
    assert.doesNotMatch(shown.stdout, /evidence_completeness: 0/);
    assert.match(shown.stdout, /comparison\.interventions: replay 1 baseline unknown delta unknown/);
    assert.match(shown.stdout, /comparison\.interventions: replay 0 baseline unknown delta unknown/);
    assert.doesNotMatch(shown.stdout, /delta 0/);

    without.actual_human_intervention = 7;
    without.comparison.interventions.replay = 7;
    writeFileSync(join(runDir, 'variants', 'without', 'metrics.json'), JSON.stringify(without));
    const echoed = evalCli(['task', 'show', id, '--run', 'run-r8', '--root', root, '--runs-dir', runs]);
    assert.equal(echoed.status, 0, echoed.stderr);
    assert.match(echoed.stdout, /variant without attempt 1:[\s\S]*actual_human_intervention: 7/);
    assert.match(echoed.stdout, /variant with-skill attempt 1:[\s\S]*actual_human_intervention: 0/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a verify pass records evidence completeness and does not turn N/A into zero', () => {
  const root = mkdtempSync(join(tmpdir(), 'agent-eval-metrics-verify-'));
  try {
    const id = 'widget-hello';
    writeCard(root, id, `private:
  interventions:
    status: none
  rework:
    status: none
`);
    const runs = join(root, 'runs');
    const runDir = join(runs, 'run-r8');
    mkdirSync(join(runDir, 'variants', 'without', 'verify'), { recursive: true });
    mkdirSync(join(runDir, 'variants', 'with-skill'), { recursive: true });
    writeFileSync(join(runDir, 'run.json'), JSON.stringify({ taskId: id }));
    writeFileSync(join(runDir, 'variants', 'without', 'events.jsonl'), readFileSync(join(fixtureDir, 'one-answer.jsonl')));
    writeFileSync(join(runDir, 'variants', 'without', 'result.json'), JSON.stringify({ score: 'unavailable' }));
    writeFileSync(join(runDir, 'variants', 'without', 'verify', 'result.json'), JSON.stringify({
      score: 'pass',
      features: [
        { id: 'hello-file', passed: true, evidence: [{ artifact: 'hello.txt', field: 'body' }] },
        { id: 'readme-untouched', passed: true, evidence: [{ artifact: 'notes.txt', field: 'body' }] },
      ],
    }));
    writeFileSync(join(runDir, 'variants', 'with-skill', 'result.json'), JSON.stringify({ score: 'unavailable' }));

    const collected = evalCli(['metrics', id, '--run', 'run-r8', '--root', root, '--runs-dir', runs]);
    assert.equal(collected.status, 0, collected.stderr + collected.stdout);
    const without = JSON.parse(readFileSync(join(runDir, 'variants', 'without', 'metrics.json'), 'utf8'));
    const withSkill = JSON.parse(readFileSync(join(runDir, 'variants', 'with-skill', 'metrics.json'), 'utf8'));
    assert.equal(without.evidence_completeness, 1);
    assert.equal(without.score, 'pass');
    assert.equal(without.baseline.interventions, 'none');
    assert.equal(without.comparison.interventions.baseline, 'none');
    assert.equal(without.comparison.interventions.replay, 1);
    assert.equal(without.comparison.interventions.delta, 1);
    assert.notEqual(without.baseline.interventions, 0);
    assert.equal(withSkill.intervention_request, 'unknown');
    assert.equal(withSkill.actual_human_intervention, 'unknown');
    assert.equal(withSkill.input_tokens, 'unknown');
    assert.equal(withSkill.cost, 'unknown');
    assert.equal(withSkill.evidence_completeness, 'N/A');
    assert.notEqual(withSkill.input_tokens, 0);
    assert.notEqual(withSkill.evidence_completeness, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

function git(cwd: string, ...args: string[]): string {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return result.stdout.trim();
}

test('replay of a card with no verify still produces both variants metrics', () => {
  const root = mkdtempSync(join(tmpdir(), 'agent-eval-metrics-replay-'));
  try {
    const runs = join(root, 'runs');
    const repo = join(root, 'widget');
    mkdirSync(runs);
    mkdirSync(repo);
    git(repo, 'init', '-q');
    git(repo, 'config', 'user.email', 'replay@example.com');
    git(repo, 'config', 'user.name', 'replay');
    writeFileSync(join(repo, 'README'), 'base\n');
    git(repo, 'add', 'README');
    git(repo, 'commit', '-q', '-m', 'base');
    const base = git(repo, 'rev-parse', 'HEAD');
    const skill = join(root, 'focus');
    mkdirSync(skill);
    writeFileSync(join(skill, 'SKILL.md'), '---\nname: focus\n---\nSKILL_BODY_FOCUS\n');
    const agent = join(root, 'cursor-agent.mjs');
    writeFileSync(agent, `#!/usr/bin/env node
const events = [
  { type: 'system', subtype: 'init', model: 'composer' },
  { type: 'user', message: { content: [{ type: 'text', text: 'prompt' }] } },
  { type: 'assistant', message: { content: [{ type: 'text', text: 'wrote hello.txt' }] } },
  { type: 'interaction', subtype: 'request', text: 'Which name should the file use?' },
  { type: 'tool_call', subtype: 'completed', tool_call: { writeToolCall: { args: { path: 'hello.txt' } } } },
  { type: 'result', subtype: 'success', result: 'done' },
];
for (const event of events) process.stdout.write(JSON.stringify(event) + '\\n');
`);
    chmodSync(agent, 0o755);
    const id = 'widget-hello';
    writeCard(root, id, '');
    const card = join(root, 'tasks', id, 'card.yaml');
    writeFileSync(card, readFileSync(card, 'utf8').replace(sha, base));

    const replay = evalCli([
      'replay', id,
      '--root', root,
      '--runs-dir', runs,
      '--repo-dir', repo,
      '--agent-bin', agent,
      '--variant', 'without',
      '--variant', `with-skill=${skill}`,
    ]);
    assert.equal(replay.status, 0, replay.stderr + replay.stdout);
    const runId = /^Run (\S+)/m.exec(replay.stdout)?.[1];
    assert.ok(runId, replay.stdout);
    const collected = evalCli(['metrics', id, '--run', runId, '--root', root, '--runs-dir', runs]);
    assert.equal(collected.status, 0, collected.stderr + collected.stdout);
    const shown = evalCli(['task', 'show', id, '--run', runId, '--root', root, '--runs-dir', runs]);
    assert.equal(shown.status, 0, shown.stderr + shown.stdout);
    for (const variant of ['without', 'with-skill']) {
      const metrics = JSON.parse(readFileSync(join(runs, runId, 'variants', variant, 'metrics.json'), 'utf8'));
      assert.equal(metrics.intervention_request, 1);
      assert.equal(metrics.actual_human_intervention, 0);
      assert.equal(metrics.rework_rounds, 0);
      assert.equal(metrics.input_tokens, 'unknown');
      assert.equal(metrics.output_tokens, 'unknown');
      assert.equal(metrics.cost, 'unknown');
      assert.equal(typeof metrics.duration_ms, 'number');
      assert.equal(metrics.score, 'unavailable');
      assert.equal(metrics.evidence_completeness, 'N/A');
      assert.equal(metrics.comparison.interventions.delta, 'unknown');
    }
    assert.match(shown.stdout, /variant without attempt 1:/);
    assert.match(shown.stdout, /variant with-skill attempt 1:/);
    assert.match(shown.stdout, /evidence_completeness: N\/A/);
    assert.match(shown.stdout, /input_tokens: unknown/);
    assert.doesNotMatch(shown.stdout, /evidence_completeness: 0/);
    assert.doesNotMatch(shown.stdout, /input_tokens: 0/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
