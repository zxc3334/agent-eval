import { mkdirSync, writeFileSync, appendFileSync, cpSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { loadCase, readJson, suiteIds } from './config.ts';
import { json } from './storage.ts';
import { invokeStub } from './process.ts';
import { generateReport } from './report.ts';
import type { LoadedCase, Options, Result } from './types.ts';

async function evaluate(c: LoadedCase, dir: string, signal: AbortSignal): Promise<Result> {
  const start = performance.now(); const caseDir = join(dir, 'cases', c.config.id);
  const workspace = join(caseDir, 'workspace'); const artifacts = join(caseDir, 'artifacts');
  mkdirSync(workspace, { recursive: true }); mkdirSync(artifacts);
  const events = join(caseDir, 'events.jsonl');
  const event = (type: string, data: unknown) => appendFileSync(events, JSON.stringify({ time: new Date().toISOString(), type, data }) + '\n');
  for (const name of ['stdout.log', 'stderr.log']) writeFileSync(join(artifacts, name), '');
  const result: Result = { case_id: c.config.id, status: 'environment_error', assertions: [], duration_ms: 0, events };
  let stage = 'prepare'; let temp: string | undefined;
  event('case_start', { case_id: c.config.id });
  try {
    json(join(caseDir, 'snapshot.json'), c);
    if (c.config.inject === 'environment_error') throw new Error('injected workspace preparation failure');
    temp = mkdtempSync(join(tmpdir(), 'agent-eval-'));
    json(join(workspace, 'input.json'), c.input); json(join(workspace, 'fixture.json'), c.fixture);
    stage = 'agent'; event('agent_start', { agent: 'stub', timeout_ms: c.config.timeout_ms });
    const outcome = await invokeStub(workspace, artifacts, temp, c.config.timeout_ms, c.config.inject, signal);
    cpSync(workspace, artifacts, { recursive: true });
    if (signal.aborted) { result.status = 'environment_error'; throw new Error('interrupted by signal'); }
    if (outcome.timedOut) { result.status = 'timeout'; throw new Error(`budget exceeded (${c.config.timeout_ms}ms)`); }
    if (outcome.error) { result.status = 'environment_error'; throw new Error(outcome.error); }
    result.status = 'agent_error';
    if (outcome.code !== 0) throw new Error(`stub exited with code ${outcome.code}`);
    stage = 'protocol';
    const response = readJson(join(artifacts, 'answer.json'));
    if (!response || !Object.hasOwn(response, 'answer')) throw new Error('answer.json: answer: required');
    stage = 'verifier'; result.status = 'verifier_error';
    if (c.config.inject === 'verifier_error') throw new Error('injected verifier exception');
    result.assertions = c.criteria.map(criterion => ({ criterion_id: criterion.id, expected: criterion.expected, actual: response.answer, passed: isDeepStrictEqual(criterion.expected, response.answer), artifact: join(artifacts, 'answer.json') }));
    event('verifier', result.assertions);
    result.status = result.assertions.every(a => a.passed) ? 'pass' : 'fail';
  } catch (error) {
    result.stage = stage; result.reason = (error as Error).message;
    event('error', { stage, reason: result.reason });
  } finally {
    if (temp) rmSync(temp, { recursive: true, force: true });
  }
  result.duration_ms = Math.round(performance.now() - start);
  event('case_end', { status: result.status, duration_ms: result.duration_ms });
  json(join(caseDir, 'result.json'), result);
  return result;
}

export async function run(options: Options, signal: AbortSignal = new AbortController().signal): Promise<{ runId: string; code: number }> {
  if (process.platform === 'win32') throw new Error('environment: M0 process-tree cleanup requires macOS or Linux');
  const all = suiteIds(options.casesDir, options.suite);
  const ids = options.selectedIds ?? (options.caseId ? [options.caseId] : all);
  if (ids.some(id => !all.includes(id))) throw new Error(`case: ${ids.filter(id => !all.includes(id)).join(', ')} not in suite ${options.suite}`);
  const cases = ids.map(id => loadCase(options.casesDir, options.suite, id));
  const runId = `${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID()}`;
  const dir = join(options.runsDir, runId); mkdirSync(dir, { recursive: true });
  const configSource = `${options.casesDir} (current files; suite=${options.suite})`;
  json(join(dir, 'config.json'), { run_id: runId, agent: options.agent, suite: options.suite, cases_dir: options.casesDir, case_ids: ids, config_source: configSource, source_run_id: options.sourceRunId ?? null, fail_fast: options.failFast, cases });
  console.log(`Run ${runId}\nRun directory: ${dir}\nConfiguration source: ${configSource}\nSource run: ${options.sourceRunId ?? 'none'}`);
  let error: string | undefined;
  try {
    for (const c of cases) {
      if (signal.aborted) break;
      const result = await evaluate(c, dir, signal);
      console.log(`${result.status.toUpperCase()} ${result.case_id} ${result.duration_ms}ms`);
      for (const a of result.assertions.filter(a => !a.passed)) console.log(`  ${a.criterion_id}: expected=${JSON.stringify(a.expected)} actual=${JSON.stringify(a.actual)}\n  artifact: ${a.artifact}`);
      if (result.reason) console.log(`  stage=${result.stage}: ${result.reason}\n  events: ${result.events}`);
      json(join(dir, 'state.json'), { interrupted: signal.aborted }); generateReport(dir);
      if (options.failFast && result.status !== 'pass') break;
    }
  } catch (e) { error = (e as Error).message; console.error(`environment_error: ${error}`); }
  json(join(dir, 'state.json'), { interrupted: signal.aborted, error });
  const summary = generateReport(dir);
  console.log(`Report: ${join(dir, 'report.md')}\nAttempted ${summary.attempted}, scored ${summary.scored}, exit ${summary.exit_code}`);
  return { runId, code: summary.exit_code };
}
