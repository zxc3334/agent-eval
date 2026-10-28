import { mkdirSync, writeFileSync, appendFileSync, copyFileSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { readJson } from './config.ts';
import { json } from './storage.ts';
import { invokeStub } from './process.ts';
import { freezeArtifacts } from './artifact-freeze.ts';
import { prepareTrial } from './trial.ts';
import { ExecutionError, prepareImage, runContainer, stagePublicFiles, verifyContainer, shellQuote, dockerCommand } from './container.ts';
import { normalizeCriteria } from './criteria.ts';
import { verify } from './verifier.ts';
import { invokeOracle, oracleInput } from './oracle.ts';
import type { GoldSource } from './oracle.ts';
import type { DockerCommand } from './container.ts';
import type { ErrorExample, LoadedCase, Result } from './types.ts';

export async function evaluate(c: LoadedCase, dir: string, signal: AbortSignal, gold?: GoldSource, counterexample?: ErrorExample, executionMode = 'stub', docker: DockerCommand = dockerCommand): Promise<Result> {
  const start = performance.now(); const caseDir = join(dir, 'cases', c.config.id);
  const workspace = join(caseDir, 'workspace'); const artifacts = join(caseDir, 'artifacts');
  mkdirSync(caseDir, { recursive: true });
  mkdirSync(workspace); mkdirSync(artifacts); // Exclusive creation: never inherit a previous trial.
  const events = join(caseDir, 'events.jsonl');
  const event = (type: string, data: unknown) => appendFileSync(events, JSON.stringify({ time: new Date().toISOString(), type, data }) + '\n');
  for (const name of ['stdout.log', 'stderr.log']) writeFileSync(join(artifacts, name), '');
  const result: Result = { case_id: c.config.id, status: 'environment_error', assertions: [], duration_ms: 0, events };
  let stage = 'prepare'; let temp: string | undefined;
  const executor = counterexample ? 'counterexample' : gold ? 'oracle' : executionMode;
  event('case_start', { case_id: c.config.id });
  try {
    json(join(caseDir, 'snapshot.json'), c);
    if (c.config.inject === 'environment_error') throw new Error('injected workspace preparation failure');
    temp = mkdtempSync(join(tmpdir(), 'agent-eval-'));
    const input = gold || counterexample ? oracleInput(c.input) : c.input;
    const session = prepareTrial(workspace, caseDir, input, c.config.clock);
    result.session_id = session.id;
    result.isolation = executor === 'container' ? 'docker' : 'trusted-local';
    json(join(caseDir, 'session.json'), { ...session, isolation: result.isolation });
    json(join(workspace, 'session.json'), { ...session, isolation: result.isolation });
    if (!!c.config.execution !== (executor === 'container')) throw new Error('container cases require --agent container; container execution requires case.execution (trusted stub/oracle never execute shell tasks)');
    let image: string | undefined;
    if (executor === 'container') {
      image = await prepareImage(c.config.execution!.image, signal, docker);
      stagePublicFiles(c, workspace);
    }
    stage = 'agent'; event('agent_start', { agent: executor, ...c.input.budgets });
    const outcome: { code: number | null; timedOut: boolean; error?: string } = executor === 'container'
      ? await runContainer({ role: 'agent', image: image!, workspace, argv: c.config.execution!.command,
        epoch: session.epoch_ms, timeout: c.input.budgets.timeout_ms, logDir: artifacts, signal }, docker)
      : counterexample
      ? materializeCounterexample(counterexample, workspace)
      : gold
      ? await invokeOracle(gold, input, caseDir, workspace, artifacts, temp, signal)
      : await invokeStub(workspace, artifacts, temp, c.input.budgets.timeout_ms, c.config.inject, signal);
    event('agent_stopped', { agent: executor, outcome });
    stage = 'artifact_handoff';
    const frozen = join(caseDir, 'frozen');
    const manifest = freezeArtifacts(workspace, frozen, c.input.artifact_allowlist, session.id, true);
    result.artifact_manifest = join(caseDir, 'artifact-manifest.json');
    result.handoff_errors = manifest.missing.map(m => `${m.error}; local troubleshooting: ls -la ${shellQuote(workspace)}; cat ${shellQuote(result.artifact_manifest!)}`);
    event('artifacts_frozen', manifest);
    // Preserve existing artifact/report paths for trusted suites. The container
    // verifier receives only `frozen`, never logs or this compatibility directory.
    for (const entry of manifest.files) copyFileSync(join(frozen, entry.path), join(artifacts, entry.path));
    stage = 'agent';
    if (signal.aborted) { result.status = 'environment_error'; throw new Error('interrupted by signal'); }
    if (outcome.timedOut) { result.status = 'timeout'; throw new Error(`budget exceeded (${c.input.budgets.timeout_ms}ms)`); }
    if (outcome.error) { result.status = 'environment_error'; throw new Error(outcome.error); }
    result.status = 'agent_error';
    if (outcome.code !== 0) throw new Error(`${executor} exited with code ${outcome.code}; see artifacts/stderr.log`);
    if (executor === 'container' && manifest.missing.length) {
      result.status = 'environment_error';
      throw new ExecutionError('artifact_handoff', result.handoff_errors.join('; '), [`ls -la ${shellQuote(workspace)}`, `cat ${shellQuote(result.artifact_manifest!)}`]);
    }
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
    if (executor === 'container' && verification.status !== 'verifier_error') {
      result.status = 'verifier_error';
      const functional = await verifyContainer(c, frozen, caseDir, image!, session.epoch_ms, signal, docker);
      result.assertions.push(functional.assertion);
      result.verifier_result_dir = functional.resultDir;
      result.status = verification.status === 'pass' && functional.assertion.passed ? 'pass' : 'fail';
      event('container_verifier', functional);
    }
    if (verification.status === 'verifier_error') throw new Error(`${verification.error_kind}: ${verification.reason}`);
  } catch (error) {
    if (stage === 'artifact_handoff' && !(error instanceof ExecutionError)) error = new ExecutionError(stage, (error as Error).message, [`ls -la ${shellQuote(workspace)}`, `cat ${shellQuote(join(caseDir, 'snapshot.json'))}`]);
    if (error instanceof ExecutionError) {
      stage = error.stage;
      result.status = stage.startsWith('verifier_') ? 'verifier_error' : 'environment_error';
    }
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
