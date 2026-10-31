import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { test } from 'node:test';
import {
  buildCompareReport,
  configKeyFrom,
  isSameFeedback,
  renderCompareTerminal,
  renderFeedbackCard,
  summarizeRows,
} from '../packages/core/src/compare.ts';
import type { CompareObservation, CompareReport, CompareSide } from '../packages/core/src/compare.ts';
import { writeJson } from '../packages/core/src/config.ts';
import type { ScoreResult } from '../packages/core/src/evidence.ts';
import { buildVariantMetrics } from '../packages/core/src/metrics.ts';
import type { MeasuredNumber, VariantMetrics } from '../packages/core/src/metrics.ts';
import { parseTaskCardYaml } from '../packages/core/src/task-card.ts';

const repoRoot = join(import.meta.dirname, '..');
const sha = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';

function evalCli(args: string[]) {
  return spawnSync(process.execPath, [join(repoRoot, 'src/eval.ts'), ...args], {
    cwd: repoRoot,
    encoding: 'utf8',
    timeout: 20_000,
  });
}

function configKey(prompt = 'abc', skills: unknown = []): string {
  const key = configKeyFrom({
    adapter: 'cursor-agent',
    entry: 'agent',
    args: ['--print'],
    model: null,
    prompt_sha256: prompt,
    skills,
  });
  assert.notEqual(key, 'unknown');
  return key;
}

function metrics(input: {
  taskId?: string;
  runId?: string;
  variant?: string;
  attempt?: number;
  actual?: MeasuredNumber;
  rework?: MeasuredNumber;
  duration?: MeasuredNumber;
  inputTokens?: MeasuredNumber;
  outputTokens?: MeasuredNumber;
  score?: ScoreResult;
}): VariantMetrics {
  return buildVariantMetrics({
    taskId: input.taskId ?? 'widget',
    runId: input.runId ?? 'run-1',
    variant: input.variant ?? 'without',
    attempt: input.attempt ?? 1,
    interventionRequest: 0,
    actualHumanIntervention: input.actual ?? 0,
    reworkRounds: input.rework ?? 0,
    score: input.score ?? 'unavailable',
    features: [],
    durationMs: input.duration ?? 'unknown',
    inputTokens: input.inputTokens ?? 'unknown',
    outputTokens: input.outputTokens ?? 'unknown',
    cost: 'unknown',
    baselineInterventions: 'unknown',
    baselineReworkRounds: 'unknown',
  });
}

function side(overrides: Partial<CompareSide> = {}): CompareSide {
  return {
    present: true,
    metricsInvalid: false,
    attemptStatus: 'completed',
    base: sha,
    configKey: configKey(),
    score: 'unavailable',
    evidence: { events: null, result: null, metrics: null, verify: null },
    ...overrides,
  };
}

function observation(overrides: Partial<CompareObservation> & Pick<CompareObservation, 'taskId' | 'runId'>): CompareObservation {
  return {
    attempt: 1,
    runDir: `runs/${overrides.runId}`,
    a: side(),
    b: side(),
    ...overrides,
  };
}

function counts(stdout: string, name: string): Record<string, number> {
  const line = stdout.split('\n').find(item => item.startsWith(`summary.${name}:`));
  assert.ok(line, name);
  return Object.fromEntries(line.slice(`summary.${name}:`.length).trim().split(' ').map(part => {
    const [key, value] = part.split('=');
    assert.match(value ?? '', /^[0-9]+$/);
    return [key, Number(value)];
  }));
}

function rowBlock(stdout: string, taskId: string, attempt: number, runId: string): string {
  const header = `row ${taskId} attempt ${attempt} run ${runId} `;
  const lines = stdout.split('\n');
  const start = lines.findIndex(line => line.startsWith(header));
  assert.notEqual(start, -1, header);
  const block = [lines[start]];
  for (let index = start + 1; index < lines.length; index += 1) {
    const line = lines[index];
    if (!line?.startsWith('  ')) break;
    block.push(line);
  }
  return block.join('\n');
}

const sourceCard = `schema_version: 1
id: widget
status: replay-ready
public:
  requirement: "Add hello.txt that says replayed."
  repo:
    id: example/widget
    host: other
  base_commit: "${sha}"
private:
  interventions:
    status: unknown
  verify:
    status: none
  sources: []
`;

test('config identity ignores skills and keeps a prompt change', () => {
  assert.equal(configKey('abc', []), configKey('abc', [{ name: 'demo', path: '/tmp/demo' }]));
  assert.notEqual(configKey('abc'), configKey('def'));
});

test('pairing is reproducible and a missing side stays missing', () => {
  const shared = configKey();
  const first = observation({
    taskId: 'zeta',
    runId: 'run-b',
    attempt: 2,
    a: side({ configKey: shared, metrics: metrics({ actual: 1, attempt: 2 }) }),
    b: side({ present: false, score: 'missing', attemptStatus: 'missing', base: 'unknown', configKey: 'unknown' }),
  });
  const second = observation({
    taskId: 'alpha',
    runId: 'run-a',
    a: side({ configKey: shared, metrics: metrics({ taskId: 'alpha', actual: 4, duration: 9 }) }),
    b: side({ configKey: shared, metrics: metrics({ taskId: 'alpha', variant: 'with-skill', actual: 4, duration: 9 }) }),
  });
  const forward = buildCompareReport({ a: 'without', b: 'with-skill', tasks: '*', observations: [first, second] });
  const backward = buildCompareReport({ a: 'without', b: 'with-skill', tasks: '*', observations: [second, first] });
  assert.deepEqual(forward.rows.map(row => [row.task_id, row.run_id, row.attempt]), [
    ['alpha', 'run-a', 1],
    ['zeta', 'run-b', 2],
  ]);
  assert.deepEqual(forward, backward);
  const missing = forward.rows[1];
  assert.equal(missing?.metrics.interventions.outcome, 'missing');
  assert.equal(missing?.metrics.interventions.delta, 'missing');
  assert.notEqual(missing?.metrics.interventions.delta, 0);
  assert.equal(missing?.flags.includes('missing-b'), true);
  assert.equal(missing?.verify.outcome, 'unavailable');
  assert.throws(
    () => buildCompareReport({ a: 'without', b: 'with-skill', tasks: '*', observations: [second, second] }),
    /duplicate pair/,
  );
});

test('unknown is not flat and not 0; interrupted equal numbers are not flat; config conflict is per metric', () => {
  const matched = configKey();
  const report = buildCompareReport({
    a: 'without',
    b: 'with-skill',
    tasks: '*',
    observations: [
      observation({
        taskId: 'measured',
        runId: 'run-unknown',
        a: side({
          configKey: matched,
          metrics: metrics({ actual: 0, duration: 'unknown', outputTokens: 0 }),
        }),
        b: side({
          configKey: matched,
          metrics: metrics({ variant: 'with-skill', actual: 0, duration: 0, outputTokens: 0 }),
        }),
      }),
      observation({
        taskId: 'stopped',
        runId: 'run-interrupted',
        a: side({
          configKey: matched,
          metrics: metrics({ taskId: 'stopped', runId: 'run-interrupted', actual: 2, rework: 0, duration: 10, inputTokens: 3, outputTokens: 4 }),
        }),
        b: side({
          configKey: matched,
          attemptStatus: 'interrupted',
          metrics: metrics({
            taskId: 'stopped',
            runId: 'run-interrupted',
            variant: 'with-skill',
            actual: 2,
            rework: 0,
            duration: 10,
            inputTokens: 3,
            outputTokens: 4,
          }),
        }),
      }),
      observation({
        taskId: 'drift',
        runId: 'run-config',
        a: side({
          configKey: matched,
          metrics: metrics({ taskId: 'drift', actual: 1, duration: 8, inputTokens: 1, outputTokens: 1, rework: 1 }),
        }),
        b: side({
          configKey: configKey('other-prompt'),
          metrics: metrics({
            taskId: 'drift',
            variant: 'with-skill',
            actual: 3,
            duration: 'unknown',
            inputTokens: 1,
            outputTokens: 1,
            rework: 1,
          }),
        }),
      }),
    ],
  });
  const unknown = report.rows.find(row => row.task_id === 'measured');
  assert.equal(unknown?.metrics.duration_ms.outcome, 'unknown');
  assert.equal(unknown?.metrics.duration_ms.delta, 'unknown');
  assert.notEqual(unknown?.metrics.duration_ms.delta, 0);
  assert.equal(unknown?.metrics.interventions.outcome, 'flat');
  assert.equal(unknown?.metrics.interventions.delta, 0);
  assert.equal(unknown?.metrics.output_tokens.outcome, 'flat');

  const stopped = report.rows.find(row => row.task_id === 'stopped');
  assert.equal(stopped?.metrics.duration_ms.outcome, 'interrupted');
  assert.equal(stopped?.metrics.interventions.outcome, 'interrupted');
  assert.equal(stopped?.flags.includes('interrupted'), true);
  assert.equal(report.summary.metrics.duration_ms.flat, 0);
  assert.equal(report.summary.metrics.duration_ms.interrupted, 1);
  assert.equal(report.summary.metrics.duration_ms.unknown, 2);

  const drift = report.rows.find(row => row.task_id === 'drift');
  assert.equal(drift?.config, 'mismatch');
  assert.equal(drift?.metrics.interventions.outcome, 'conflict');
  assert.equal(drift?.metrics.interventions.delta, 2);
  assert.equal(drift?.metrics.duration_ms.outcome, 'unknown');
  assert.equal('classification' in (drift ?? {}), false);

  const text = renderCompareTerminal(report);
  assert.match(text, /duration_ms: unknown \(a unknown → b 0\)/);
  assert.match(text, /duration_ms: interrupted 0 \(a 10 → b 10\)/);
  assert.match(text, /interventions: conflict \+2 \(a 1 → b 3\)/);
  assert.doesNotMatch(rowBlock(text, 'stopped', 1, 'run-interrupted'), /flat/);
  assert.doesNotMatch(rowBlock(text, 'drift', 1, 'run-config'), /worsened/);
  assert.deepEqual(report.summary, summarizeRows(report.rows));
});

test('feedback card is replayable, keeps unknown off zero, and recognizes the same run', () => {
  const source = parseTaskCardYaml(sourceCard, { expectedId: 'widget' });
  assert.equal(source.ok, true);
  if (!source.ok) return;
  const rendered = renderFeedbackCard({
    source: source.card,
    runId: 'run-worsened',
    attempt: 1,
    sideB: 'with-skill',
    worsened: [{ name: 'interventions', delta: 2, a: 1, b: 3 }],
    verifyWorsened: false,
  });
  assert.match(rendered.id, /run-worsened/);
  const card = parseTaskCardYaml(rendered.yaml, { expectedId: rendered.id });
  assert.equal(card.ok, true);
  if (!card.ok) return;
  assert.equal(card.card.status, 'replay-ready');
  assert.equal(isSameFeedback(card.card, 'run-worsened', 1), true);
  assert.equal(isSameFeedback(card.card, 'run-worsened', 2), false);
  assert.equal('records' in card.card.private.interventions, true);
  if ('records' in card.card.private.interventions) assert.equal(card.card.private.interventions.records.length, 1);
  assert.equal(card.card.private.rework && 'status' in card.card.private.rework && card.card.private.rework.status, 'unknown');
  assert.equal(rendered.yaml.includes('count:'), false);

  const durationOnly = renderFeedbackCard({
    source: source.card,
    runId: 'run-slow',
    attempt: 1,
    sideB: 'with-skill',
    worsened: [{ name: 'duration_ms', delta: 5, a: 1, b: 6 }],
    verifyWorsened: false,
  });
  const slow = parseTaskCardYaml(durationOnly.yaml, { expectedId: durationOnly.id });
  assert.equal(slow.ok, true);
  if (!slow.ok) return;
  assert.equal('status' in slow.card.private.interventions && slow.card.private.interventions.status, 'unknown');
  assert.equal(durationOnly.yaml.includes('count:'), false);
});

function writeCard(root: string): void {
  const dir = join(root, 'tasks', 'widget');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'card.yaml'), sourceCard);
}

function writeRun(root: string, runId: string, taskId: string): void {
  const dir = join(root, 'runs', runId);
  mkdirSync(dir, { recursive: true });
  writeJson(join(dir, 'run.json'), { run_id: runId, taskId });
}

function writeAttempt(root: string, input: {
  runId: string;
  taskId: string;
  variant: 'without' | 'with-skill';
  attempt?: number;
  actual: MeasuredNumber;
  rework: MeasuredNumber;
  duration: MeasuredNumber;
  inputTokens: MeasuredNumber;
  outputTokens: MeasuredNumber;
  score: ScoreResult;
  status: 'completed' | 'interrupted' | 'error';
  events?: boolean;
  verify?: boolean;
}): void {
  const dir = input.attempt === undefined
    ? join(root, 'runs', input.runId, 'variants', input.variant)
    : join(root, 'runs', input.runId, 'variants', input.variant, 'attempts', String(input.attempt));
  mkdirSync(dir, { recursive: true });
  const attempt = input.attempt ?? 1;
  writeJson(join(dir, 'metrics.json'), metrics({
    taskId: input.taskId,
    runId: input.runId,
    variant: input.variant,
    attempt,
    actual: input.actual,
    rework: input.rework,
    duration: input.duration,
    inputTokens: input.inputTokens,
    outputTokens: input.outputTokens,
    score: input.score,
  }));
  writeJson(join(dir, 'result.json'), { status: input.status, expected_base: sha, score: 'unavailable' });
  writeJson(join(dir, 'config.json'), {
    adapter: 'cursor-agent',
    entry: 'agent',
    args: ['--print'],
    model: null,
    prompt_sha256: 'abc',
    skills: input.variant === 'with-skill' ? [{ name: 'demo', path: '/tmp/demo' }] : [],
  });
  if (input.events) writeFileSync(join(dir, 'events.jsonl'), '{"type":"result"}\n');
  if (input.verify) {
    mkdirSync(join(dir, 'verify'), { recursive: true });
    writeJson(join(dir, 'verify', 'result.json'), { score: input.score });
  }
}

function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), 'agent-eval-compare-'));
  mkdirSync(join(root, 'runs'), { recursive: true });
  writeCard(root);
  writeRun(root, 'run-worsened', 'widget');
  writeAttempt(root, {
    runId: 'run-worsened',
    taskId: 'widget',
    variant: 'without',
    attempt: 1,
    actual: 1,
    rework: 1,
    duration: 'unknown',
    inputTokens: 'unknown',
    outputTokens: 0,
    score: 'unavailable',
    status: 'completed',
    events: true,
  });
  writeAttempt(root, {
    runId: 'run-worsened',
    taskId: 'widget',
    variant: 'with-skill',
    attempt: 1,
    actual: 3,
    rework: 1,
    duration: 'unknown',
    inputTokens: 5,
    outputTokens: 0,
    score: 'unavailable',
    status: 'completed',
    events: true,
  });
  writeAttempt(root, {
    runId: 'run-worsened',
    taskId: 'widget',
    variant: 'without',
    attempt: 2,
    actual: 1,
    rework: 0,
    duration: 4,
    inputTokens: 1,
    outputTokens: 1,
    score: 'unavailable',
    status: 'completed',
  });
  writeRun(root, 'run-interrupted', 'quiet');
  for (const variant of ['without', 'with-skill'] as const) {
    writeAttempt(root, {
      runId: 'run-interrupted',
      taskId: 'quiet',
      variant,
      actual: 2,
      rework: 0,
      duration: 10,
      inputTokens: 3,
      outputTokens: 4,
      score: 'unavailable',
      status: variant === 'with-skill' ? 'interrupted' : 'completed',
      events: true,
    });
  }
  writeRun(root, 'run-scored', 'scored');
  writeAttempt(root, {
    runId: 'run-scored',
    taskId: 'scored',
    variant: 'without',
    actual: 0,
    rework: 0,
    duration: 5,
    inputTokens: 1,
    outputTokens: 1,
    score: 'pass',
    status: 'completed',
    events: true,
    verify: true,
  });
  writeAttempt(root, {
    runId: 'run-scored',
    taskId: 'scored',
    variant: 'with-skill',
    actual: 0,
    rework: 0,
    duration: 5,
    inputTokens: 1,
    outputTokens: 1,
    score: 'feature fail',
    status: 'completed',
    events: true,
    verify: true,
  });
  return root;
}

test('compare lists per-metric rows, keeps verify unavailable, and links worsening evidence', () => {
  const root = fixture();
  try {
    const result = evalCli(['compare', '--tasks', '*', '--a', 'without', '--b', 'with-skill', '--root', root]);
    assert.equal(result.status, 0, result.stderr);
    const report = JSON.parse(readFileSync(join(root, 'runs', 'comparisons', 'without--with-skill', 'compare.json'), 'utf8')) as CompareReport;
    assert.equal(report.pairs, 4);
    assert.equal(report.pairs, report.rows.length);
    assert.deepEqual(report.summary, summarizeRows(report.rows));
    assert.deepEqual(counts(result.stdout, 'interventions'), report.summary.metrics.interventions);
    assert.deepEqual(counts(result.stdout, 'duration_ms'), report.summary.metrics.duration_ms);
    assert.deepEqual(counts(result.stdout, 'verify'), report.summary.verify);
    assert.equal(report.summary.metrics.interventions.worsened, 1);
    assert.equal(report.summary.metrics.interventions.flat, 1);
    assert.equal(report.summary.metrics.interventions.missing, 1);
    assert.equal(report.summary.metrics.interventions.interrupted, 1);
    assert.equal(report.summary.metrics.interventions.unknown, 0);
    assert.equal(report.summary.verify.unavailable, 3);
    assert.equal(report.summary.verify.worsened, 1);
    assert.equal(report.summary.metrics.duration_ms.flat, 1);
    assert.equal(report.summary.metrics.duration_ms.unknown, 1);
    assert.equal(report.summary.metrics.duration_ms.interrupted, 1);

    const worsened = rowBlock(result.stdout, 'widget', 1, 'run-worsened');
    assert.match(worsened, /config match/);
    assert.match(worsened, /interventions: worsened \+2 \(a 1 → b 3\)/);
    assert.match(worsened, /rework_rounds: flat 0 \(a 1 → b 1\)/);
    assert.match(worsened, /duration_ms: unknown \(a unknown → b unknown\)/);
    assert.match(worsened, /input_tokens: unknown \(a unknown → b 5\)/);
    assert.match(worsened, /output_tokens: flat 0 \(a 0 → b 0\)/);
    assert.match(worsened, /verify: unavailable \(a unavailable → b unavailable\)/);
    assert.doesNotMatch(worsened.split('\n').find(line => line.includes('duration_ms')) ?? '', /flat/);
    assert.doesNotMatch(worsened.split('\n').find(line => line.includes('input_tokens')) ?? '', /flat/);

    const missing = rowBlock(result.stdout, 'widget', 2, 'run-worsened');
    assert.match(missing, /interventions: missing \(a 1 → b missing\)/);
    assert.match(missing, /flags: missing-b/);
    assert.doesNotMatch(missing, /flat/);

    const stopped = rowBlock(result.stdout, 'quiet', 1, 'run-interrupted');
    assert.match(stopped, /duration_ms: interrupted 0 \(a 10 → b 10\)/);
    assert.doesNotMatch(stopped, /flat/);
    assert.match(stopped, /verify: unavailable/);

    const scored = rowBlock(result.stdout, 'scored', 1, 'run-scored');
    assert.match(scored, /interventions: flat 0 \(a 0 → b 0\)/);
    assert.match(scored, /verify: worsened \(a pass → b feature fail\)/);

    const markdownPath = join(root, 'runs', 'comparisons', 'without--with-skill', 'compare.md');
    const markdown = readFileSync(markdownPath, 'utf8');
    assert.deepEqual(counts(markdown, 'interventions'), report.summary.metrics.interventions);
    const sections = markdown.split('\n### ').slice(1);
    const widget = sections.find(section => section.startsWith('widget '));
    assert.ok(widget);
    assert.match(widget, /verify: unavailable/);
    assert.equal(widget.includes('verify/result.json'), false);
    const eventLink = widget.match(/\[b events\]\(([^)]+)\)/);
    assert.ok(eventLink?.[1]);
    assert.equal(existsSync(resolve(dirname(markdownPath), eventLink[1])), true);
    const runLink = widget.match(/\[run-worsened\]\(([^)]+)\)/);
    assert.ok(runLink?.[1]);
    assert.equal(existsSync(resolve(dirname(markdownPath), runLink[1])), true);
    const scoredSection = sections.find(section => section.startsWith('scored '));
    assert.ok(scoredSection);
    const verifyLink = scoredSection.match(/\[b verify\]\(([^)]+)\)/);
    assert.ok(verifyLink?.[1]);
    const verifyPath = resolve(dirname(markdownPath), verifyLink[1]);
    assert.equal(existsSync(verifyPath), true);
    assert.match(readFileSync(verifyPath, 'utf8'), /feature fail/);

    const filtered = evalCli(['compare', '--tasks', 'widget', '--a', 'without', '--b', 'with-skill', '--root', root]);
    assert.equal(filtered.status, 0, filtered.stderr);
    assert.match(filtered.stdout, /pairs: 2/);
    assert.match(filtered.stdout, /missing-b/);
    assert.doesNotMatch(filtered.stdout, /run-interrupted/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('feedback shows the source run in task list and a repeat dedupes', () => {
  const root = fixture();
  try {
    const sourceBefore = readFileSync(join(root, 'tasks', 'widget', 'card.yaml'), 'utf8');
    const args = ['compare', 'feedback', '--task', 'widget', '--run', 'run-worsened', '--attempt', '1', '--a', 'without', '--b', 'with-skill', '--root', root];
    const created = evalCli(args);
    assert.equal(created.status, 0, created.stderr);
    assert.match(created.stdout, /feedback: created/);
    assert.match(created.stdout, /source run: run-worsened/);
    const idLine = created.stdout.split('\n').find(line => line.startsWith('id: '));
    const id = idLine?.slice(4);
    assert.ok(id);
    assert.match(id, /run-worsened/);

    const listed = evalCli(['task', 'list', '--root', root]);
    assert.equal(listed.status, 0, listed.stderr);
    assert.match(listed.stdout, new RegExp(id));
    assert.match(listed.stdout, /run-worsened/);
    const rows = listed.stdout.trim().split('\n').slice(1).map(line => line.split('\t'));
    const feedback = rows.find(row => row[0] === id);
    assert.ok(feedback);
    assert.equal(feedback[1], 'replay-ready');
    assert.equal(feedback[3], 'records:1');
    assert.equal(rows.filter(row => row[0] === id).length, 1);

    const card = parseTaskCardYaml(readFileSync(join(root, 'tasks', id, 'card.yaml'), 'utf8'), { expectedId: id });
    assert.equal(card.ok, true);
    if (card.ok && 'records' in card.card.private.interventions) {
      assert.equal(card.card.private.interventions.records.length, 1);
      assert.match(card.card.private.interventions.records[0]?.source ?? '', /run-worsened/);
    }
    assert.equal(readFileSync(join(root, 'tasks', 'widget', 'card.yaml'), 'utf8'), sourceBefore);

    const again = evalCli(args);
    assert.equal(again.status, 0, again.stderr);
    assert.match(again.stdout, /feedback: unchanged/);
    assert.match(again.stdout, /deduped/);
    assert.match(again.stdout, /source run: run-worsened/);
    const relisted = evalCli(['task', 'list', '--root', root]);
    const againRows = relisted.stdout.trim().split('\n').slice(1).map(line => line.split('\t')).filter(row => row[0] === id);
    assert.equal(againRows.length, 1);
    assert.equal(againRows[0]?.[3], 'records:1');

    const skipped = evalCli(['compare', 'feedback', '--task', 'widget', '--run', 'run-worsened', '--attempt', '2', '--root', root]);
    assert.equal(skipped.status, 2);
    assert.match(skipped.stderr, /no worsened metric/);
    const missing = evalCli(['compare', 'feedback', '--task', 'widget', '--run', 'run-missing', '--root', root]);
    assert.equal(missing.status, 2);
    assert.match(missing.stderr, /run not found/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
