import { existsSync, readFileSync, writeFileSync, appendFileSync, mkdirSync } from 'node:fs';
import { resolve, join, basename } from 'node:path';
import { json } from './storage.ts';
import { createCase } from './scaffold.ts';
import type { ToolCall, UnifiedTrace, UnifiedTraceStep, Result } from './types.ts';

export function parseTrace(input: string | Record<string, unknown>): UnifiedTrace {
  let raw: any;
  if (typeof input === 'string') {
    const file = resolve(input);
    if (!existsSync(file)) throw new Error(`trace file not found: ${file}`);
    const content = readFileSync(file, 'utf8').trim();
    if (file.endsWith('.jsonl') || (!content.startsWith('{') && content.includes('\n'))) {
      const lines = content.split('\n').filter(Boolean);
      const parsedLines = lines.map(line => {
        try { return JSON.parse(line); } catch { return null; }
      }).filter(Boolean);
      return parseJsonlTrace(parsedLines, basename(file, '.jsonl'));
    }
    try { raw = JSON.parse(content); }
    catch (e) { throw new Error(`invalid trace JSON ${file}: ${(e as Error).message}`); }
  } else {
    raw = input;
  }

  if (raw?.schema_version !== 1 && raw?.trace_id === undefined && raw?.steps === undefined) {
    throw new Error('trace format error: expected schema_version 1 or trace object with steps');
  }

  const steps: UnifiedTraceStep[] = Array.isArray(raw.steps) ? raw.steps.map((s: any, idx: number) => ({
    step_index: typeof s.step_index === 'number' ? s.step_index : idx + 1,
    timestamp: s.timestamp,
    role: s.role ?? 'assistant',
    thought: s.thought,
    content: s.content,
    tool_calls: Array.isArray(s.tool_calls) ? s.tool_calls : undefined,
    tool_results: Array.isArray(s.tool_results) ? s.tool_results : undefined,
    usage: s.usage,
  })) : [];

  return {
    schema_version: 1,
    trace_id: raw.trace_id ?? `trace-${Date.now()}`,
    session_id: raw.session_id,
    task_prompt: typeof raw.task_prompt === 'string' ? raw.task_prompt : raw.prompt ?? '',
    initial_state: raw.initial_state ?? {},
    steps,
    final_answer: raw.final_answer ?? (raw.artifacts?.['answer.json']?.answer ?? raw.answer),
    artifacts: raw.artifacts ?? {},
    metadata: raw.metadata ?? {},
  };
}

function parseJsonlTrace(lines: any[], fallbackId: string): UnifiedTrace {
  let prompt = '';
  let finalAnswer: unknown;
  const steps: UnifiedTraceStep[] = [];
  const artifacts: Record<string, unknown> = {};

  for (let i = 0; i < lines.length; i++) {
    const entry = lines[i];
    if (!prompt && (entry.type === 'USER_INPUT' || entry.role === 'user')) {
      prompt = entry.content ?? entry.prompt ?? '';
    }
    if (entry.final_answer !== undefined) finalAnswer = entry.final_answer;
    if (entry.artifacts && typeof entry.artifacts === 'object') {
      Object.assign(artifacts, entry.artifacts);
    }
    const toolCalls: ToolCall[] = [];
    if (Array.isArray(entry.tool_calls)) {
      for (const call of entry.tool_calls) {
        if (call && typeof call.tool === 'string' && typeof call.arguments === 'object') {
          toolCalls.push({ tool: call.tool, arguments: call.arguments });
        }
      }
    }
    steps.push({
      step_index: typeof entry.step_index === 'number' ? entry.step_index : i + 1,
      timestamp: entry.timestamp ?? entry.created_at,
      role: entry.role ?? (entry.type === 'USER_INPUT' ? 'user' : 'assistant'),
      thought: entry.thought ?? entry.thinking,
      content: entry.content,
      tool_calls: toolCalls.length ? toolCalls : undefined,
      tool_results: Array.isArray(entry.tool_results) ? entry.tool_results : undefined,
      usage: entry.usage,
    });
  }

  if (finalAnswer === undefined && artifacts['answer.json']) {
    finalAnswer = (artifacts['answer.json'] as any)?.answer;
  }
  if (finalAnswer === undefined) {
    const lastAssistant = [...steps].reverse().find(s => s.role === 'assistant' && s.content);
    if (lastAssistant) finalAnswer = lastAssistant.content;
  }

  return {
    schema_version: 1,
    trace_id: fallbackId,
    task_prompt: prompt,
    steps,
    final_answer: finalAnswer,
    artifacts,
  };
}

export function replayTrace(
  traceSource: string | UnifiedTrace,
  workspace: string,
  artifacts: string,
  eventsPath: string
): { code: number; timedOut: boolean; error?: string; stepsUsed: number; usage?: Result['usage'] } {
  mkdirSync(workspace, { recursive: true });
  mkdirSync(artifacts, { recursive: true });
  const trace = typeof traceSource === 'string' ? parseTrace(traceSource) : traceSource;

  // Append steps to events.jsonl
  for (const step of trace.steps) {
    appendFileSync(
      eventsPath,
      JSON.stringify({ time: step.timestamp ?? new Date().toISOString(), type: 'trace_step', data: step }) + '\n'
    );
  }

  // Materialize answer.json
  const answerPayload = trace.artifacts?.['answer.json'] !== undefined
    ? trace.artifacts['answer.json']
    : { answer: trace.final_answer, success: true };

  json(join(workspace, 'answer.json'), answerPayload);

  // Materialize any other artifacts declared in trace
  if (trace.artifacts) {
    for (const [name, content] of Object.entries(trace.artifacts)) {
      if (name === 'answer.json') continue;
      const target = join(workspace, name);
      if (typeof content === 'string') writeFileSync(target, content);
      else json(target, content);
    }
  }

  // Calculate token usage
  let inputTokens = 0;
  let outputTokens = 0;
  for (const step of trace.steps) {
    if (step.usage?.input_tokens) inputTokens += step.usage.input_tokens;
    if (step.usage?.output_tokens) outputTokens += step.usage.output_tokens;
  }

  return {
    code: 0,
    timedOut: false,
    stepsUsed: trace.steps.length || 1,
    usage: (inputTokens || outputTokens) ? { input_tokens: inputTokens, output_tokens: outputTokens } : undefined,
  };
}

export function scaffoldFromTrace(options: {
  traceFile: string;
  casesDir: string;
  suite: string;
  id: string;
  requirementId: string;
}): string {
  const trace = parseTrace(options.traceFile);
  const dir = createCase(options.casesDir, options.suite, options.id, options.requirementId);

  // Populate input.json with real prompt
  json(join(dir, 'input.json'), { prompt: trace.task_prompt || `Task derived from trace ${trace.trace_id}` });

  // Populate initial-state.json
  json(join(dir, 'initial-state.json'), trace.initial_state ?? {});

  // Populate fixture.json
  const expectedAnswer = trace.final_answer ?? 'TODO_EXPECTED_ANSWER';
  json(join(dir, 'fixture.json'), { answer: expectedAnswer });

  // Populate acceptance.json
  const acceptance = {
    gold: { answer: expectedAnswer },
    criteria: [
      {
        id: 'answer-equals',
        type: 'equals',
        target: { artifact: 'answer.json', field: 'answer' },
        params: { expected: expectedAnswer },
        mode: 'hard',
        reason: `Generated from trace ${trace.trace_id}: output must match trace final answer.`,
      },
    ],
    error_examples: [
      {
        expected_failed_criteria: ['answer-equals'],
        answer: typeof expectedAnswer === 'string' ? `${expectedAnswer}_INCORRECT_CONTROL` : 'INCORRECT_CONTROL',
        reason: 'Counterexample: incorrect response must fail answer-equals criterion.',
      },
    ],
    reviewed: false,
  };
  json(join(dir, 'acceptance.json'), acceptance);

  // Populate solve.ts
  writeFileSync(
    join(dir, 'solve.ts'),
    `import { writeFileSync } from 'node:fs';\n// Ground truth answer derived from trace ${trace.trace_id}\nwriteFileSync('answer.json', JSON.stringify({ answer: ${JSON.stringify(expectedAnswer)}, success: true }));\n`
  );

  // Update brief.md
  writeFileSync(
    join(dir, 'brief.md'),
    `# Case brief: ${options.id}\n\nrequirement_id: ${options.requirementId}\ncase_id: ${options.id}\nSource trace: ${options.traceFile} (trace_id: ${trace.trace_id})\n\n## Task Prompt\n${trace.task_prompt}\n\n## Acceptance\nGround truth derived from trace: ${JSON.stringify(expectedAnswer)}\n`
  );

  return dir;
}
