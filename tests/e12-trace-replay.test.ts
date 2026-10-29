import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseTrace, replayTrace, scaffoldFromTrace } from '../src/trace.ts';
import { execute, setup, read, runDirs, write } from './helpers.ts';
import type { UnifiedTrace } from '../src/types.ts';

test('parseTrace handles both standard JSON and JSONL transcripts', () => {
  const dir = mkdtempSync(join(tmpdir(), 'trace-test-'));
  try {
    // 1. Standard JSON trace
    const jsonTrace: UnifiedTrace = {
      schema_version: 1,
      trace_id: 'sample-001',
      task_prompt: 'Count letters in hello',
      initial_state: { word: 'hello' },
      steps: [
        {
          step_index: 1,
          role: 'assistant',
          thought: 'Counting word length',
          tool_calls: [{ tool: 'strlen', arguments: { text: 'hello' } }],
          usage: { input_tokens: 15, output_tokens: 5 },
        },
      ],
      final_answer: '5',
      artifacts: { 'answer.json': { answer: '5', success: true }, 'metrics.txt': 'len=5' },
    };
    const jsonFile = join(dir, 'trace.json');
    writeFileSync(jsonFile, JSON.stringify(jsonTrace, null, 2));
    const parsedJson = parseTrace(jsonFile);
    assert.equal(parsedJson.trace_id, 'sample-001');
    assert.equal(parsedJson.task_prompt, 'Count letters in hello');
    assert.equal(parsedJson.final_answer, '5');
    assert.equal(parsedJson.steps.length, 1);
    assert.equal(parsedJson.steps[0].tool_calls?.[0].tool, 'strlen');

    // 2. JSONL stream transcript
    const jsonlFile = join(dir, 'transcript.jsonl');
    const lines = [
      JSON.stringify({ step_index: 1, role: 'user', content: 'What is 3 * 3?' }),
      JSON.stringify({ step_index: 2, role: 'assistant', thinking: 'Calculate multiplication', tool_calls: [{ tool: 'calc', arguments: { op: '3*3' } }] }),
      JSON.stringify({ step_index: 3, role: 'tool', tool_results: [{ tool: 'calc', result: 9 }] }),
      JSON.stringify({ step_index: 4, role: 'assistant', content: '9', final_answer: 9, usage: { input_tokens: 20, output_tokens: 2 } }),
    ];
    writeFileSync(jsonlFile, lines.join('\n'));
    const parsedJsonl = parseTrace(jsonlFile);
    assert.equal(parsedJsonl.task_prompt, 'What is 3 * 3?');
    assert.equal(parsedJsonl.steps.length, 4);
    assert.equal(parsedJsonl.final_answer, 9);
    assert.equal(parsedJsonl.steps[1].thought, 'Calculate multiplication');
    assert.equal(parsedJsonl.steps[1].tool_calls?.[0].tool, 'calc');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('replayTrace populates workspace, logs events and aggregates token usage', () => {
  const dir = mkdtempSync(join(tmpdir(), 'replay-test-'));
  const workspace = join(dir, 'workspace');
  const artifacts = join(dir, 'artifacts');
  const events = join(dir, 'events.jsonl');
  try {
    writeFileSync(events, '');
    const trace: UnifiedTrace = {
      schema_version: 1,
      trace_id: 'test-replay',
      task_prompt: 'Generate greeting',
      steps: [
        { step_index: 1, role: 'assistant', thought: 'thinking...', usage: { input_tokens: 10, output_tokens: 5 } },
        { step_index: 2, role: 'assistant', content: 'Done', usage: { input_tokens: 5, output_tokens: 10 } },
      ],
      final_answer: 'Hello from trace',
      artifacts: {
        'answer.json': { answer: 'Hello from trace', verified: true },
        'extra.txt': 'side product',
      },
    };

    const outcome = replayTrace(trace, workspace, artifacts, events);
    assert.equal(outcome.code, 0);
    assert.equal(outcome.stepsUsed, 2);
    assert.deepEqual(outcome.usage, { input_tokens: 15, output_tokens: 15 });

    // Assert files materialized
    const answer = JSON.parse(readFileSync(join(workspace, 'answer.json'), 'utf8'));
    assert.equal(answer.answer, 'Hello from trace');
    assert.equal(readFileSync(join(workspace, 'extra.txt'), 'utf8'), 'side product');

    // Assert events appended
    const eventLines = readFileSync(events, 'utf8').trim().split('\n');
    assert.equal(eventLines.length, 2);
    assert.ok(eventLines[0].includes('trace_step'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('scaffoldFromTrace creates valid schema v2 case directory from trace file', () => {
  const t = setup();
  const traceFile = join(t.root, 'sample.trace.json');
  try {
    const sampleTrace: UnifiedTrace = {
      schema_version: 1,
      trace_id: 'prod-run-987',
      task_prompt: 'Process order #1001',
      initial_state: { order_id: 1001, status: 'pending' },
      steps: [
        { step_index: 1, role: 'assistant', tool_calls: [{ tool: 'lookup', arguments: { id: 1001 } }] },
      ],
      final_answer: 'order-processed-1001',
    };
    write(traceFile, sampleTrace);

    const createdDir = scaffoldFromTrace({
      traceFile,
      casesDir: t.cases,
      suite: 'repro',
      id: 'order-case',
      requirementId: 'REQ-ORDER-1',
    });

    assert.ok(existsSync(createdDir));
    assert.ok(existsSync(join(createdDir, 'case.json')));
    assert.ok(existsSync(join(createdDir, 'input.json')));
    assert.ok(existsSync(join(createdDir, 'acceptance.json')));
    assert.ok(existsSync(join(createdDir, 'solve.ts')));

    const input = read(join(createdDir, 'input.json'));
    assert.equal(input.prompt, 'Process order #1001');

    const acceptance = read(join(createdDir, 'acceptance.json'));
    assert.equal(acceptance.gold.answer, 'order-processed-1001');
    assert.equal(acceptance.criteria[0].params.expected, 'order-processed-1001');

    // Schema validation succeeds on the generated case
    const validation = execute(['validate', '--schema-only', '--suite', 'repro', '--cases-dir', t.cases]);
    assert.equal(validation.status, 0, validation.stderr);
    assert.match(validation.stdout, /checked 1 case\(s\), 0 error/);

    // Oracle solve.ts passes evaluation
    const oracleRun = execute(['--suite', 'repro', '--case', 'order-case', '--agent', 'oracle', ...t.args]);
    assert.equal(oracleRun.status, 0, oracleRun.stderr);
    assert.match(oracleRun.stdout, /PASS order-case/);
  } finally {
    rmSync(t.root, { recursive: true, force: true });
  }
});

test('CLI case from-trace subcommands and replay adapter execution', () => {
  const t = setup();
  const traceFile = join(t.root, 'recorded.trace.json');
  try {
    const trace: UnifiedTrace = {
      schema_version: 1,
      trace_id: 'cli-trace-1',
      task_prompt: 'Output hello',
      steps: [{ step_index: 1, role: 'assistant', content: 'hello' }],
      final_answer: 'hello',
    };
    write(traceFile, trace);

    // 1. Test CLI case from-trace creation
    const cmd = execute(['case', 'from-trace', 'trace-case', '--trace', traceFile, '--requirement', 'REQ-TRACE-1', '--suite', 'tracesuite', '--cases-dir', t.cases]);
    assert.equal(cmd.status, 0, cmd.stderr);
    assert.match(cmd.stdout, /Created case from trace/);

    // 2. Test running evaluation with replay adapter
    const replayRun = execute(['--suite', 'tracesuite', '--case', 'trace-case', '--agent', 'replay', '--trace', traceFile, ...t.args]);
    assert.equal(replayRun.status, 0, replayRun.stderr);
    assert.match(replayRun.stdout, /PASS trace-case/);

    const runDir = runDirs(t.runs).at(-1)!;
    const reportMd = readFileSync(join(runDir, 'report.md'), 'utf8');
    assert.match(reportMd, /offline trace replay/);
  } finally {
    rmSync(t.root, { recursive: true, force: true });
  }
});
