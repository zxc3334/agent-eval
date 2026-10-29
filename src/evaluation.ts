import { mkdirSync, writeFileSync, appendFileSync, copyFileSync, existsSync, lstatSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { readJson } from './config.ts';
import { json } from './storage.ts';
import { invokeStub } from './process.ts';
import { normalizeCriteria } from './criteria.ts';
import { verify } from './verifier.ts';
import { invokeOracle, oracleInput } from './oracle.ts';
import type { GoldSource } from './oracle.ts';
import type { ErrorExample, LoadedCase, Result } from './types.ts';

export async function evaluate(c: LoadedCase, dir: string, signal: AbortSignal, gold?: GoldSource, counterexample?: ErrorExample): Promise<Result> {
  const start = performance.now(); const caseDir = join(dir, 'cases', c.config.id);
  const workspace = join(caseDir, 'workspace'); const artifacts = join(caseDir, 'artifacts');
  mkdirSync(workspace, { recursive: true }); mkdirSync(artifacts);
  const events = join(caseDir, 'events.jsonl');
  const event = (type: string, data: unknown) => appendFileSync(events, JSON.stringify({ time: new Date().toISOString(), type, data }) + '\n');
  for (const name of ['stdout.log', 'stderr.log']) writeFileSync(join(artifacts, name), '');
  const result: Result = { case_id: c.config.id, status: 'environment_error', assertions: [], duration_ms: 0, events };
  let stage = 'prepare'; let temp: string | undefined;
  const executor = counterexample ? 'counterexample' : gold ? 'oracle' : 'stub';
  event('case_start', { case_id: c.config.id });
  try {
    json(join(caseDir, 'snapshot.json'), c);
    if (c.config.inject === 'environment_error') throw new Error('injected workspace preparation failure');
    temp = mkdtempSync(join(tmpdir(), 'agent-eval-'));
    const input = gold || counterexample ? oracleInput(c.input) : c.input;
    json(join(workspace, 'input.json'), input);
    stage = 'agent'; event('agent_start', { agent: executor, ...c.input.budgets });
    const outcome = counterexample
      ? materializeCounterexample(counterexample, workspace)
      : gold
      ? await invokeOracle(gold, input, caseDir, workspace, artifacts, temp, signal)
      : await invokeStub(workspace, artifacts, temp, c.input.budgets.timeout_ms, c.config.inject, signal);
    for (const name of c.input.artifact_allowlist) {
      const file = join(workspace, name);
      if (existsSync(file)) {
        if (!lstatSync(file).isFile()) throw new Error(`artifact ${name}: expected regular file, not a link or directory`);
        copyFileSync(file, join(artifacts, name));
      }
    }
    if (signal.aborted) { result.status = 'environment_error'; throw new Error('interrupted by signal'); }
    if (outcome.timedOut) { result.status = 'timeout'; throw new Error(`budget exceeded (${c.input.budgets.timeout_ms}ms)`); }
    if (outcome.error) { result.status = 'environment_error'; throw new Error(outcome.error); }
    result.status = 'agent_error';
    if (outcome.code !== 0) throw new Error(`${executor} exited with code ${outcome.code}; see artifacts/stderr.log`);
    stage = 'protocol';
    const response = readJson(join(artifacts, 'answer.json'));
    if (!response || !Object.hasOwn(response, 'answer')) throw new Error('answer.json: answer: required');
    stage = 'verifier'; result.status = 'verifier_error';
    const verification = await verify(normalizeCriteria(c.acceptance.criteria, c.file), artifacts, caseDir, c.config.inject, signal);
    result.verifier_result_dir = verification.result_dir;
    result.assertions = verification.assertions;
    event('verifier', verification);
    if (signal.aborted) { result.status = 'environment_error'; throw new Error('interrupted by signal'); }
    result.status = verification.status;
    if (verification.status === 'verifier_error') throw new Error(`${verification.error_kind}: ${verification.reason}`);
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

// Declarative private controls supply outputs, never replace the public fixture or
// inherit Oracle outputs. The ordinary protocol and verifier still judge them.
function materializeCounterexample(example: ErrorExample, workspace: string) {
  for (const [name, content] of Object.entries(example.files ?? {})) writeFileSync(join(workspace, name), content);
  json(join(workspace, 'answer.json'), { answer: example.answer, success: true });
  return { code: 0, timedOut: false, error: undefined };
}
