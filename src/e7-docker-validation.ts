// Explicit real-Docker acceptance. Never silently skip or fall back to host code.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { run } from './runner.ts';
import { readJson } from './config.ts';
import { json } from './storage.ts';
import { ExecutionError, prepareImage } from './container.ts';

mkdirSync('runs', { recursive: true });
const root = mkdtempSync(resolve('runs/e7-validation-'));
const checks: string[] = [];
const controller = new AbortController();
const stop = () => controller.abort(); process.on('SIGINT', stop); process.on('SIGTERM', stop);
try {
  await prepareImage('node:24-alpine', controller.signal);
  const casesDir = join(root, 'cases');
  cpSync('cases/e7-code', join(casesDir, 'e7-code'), { recursive: true });
  const sessions = new Set<string>(); const names = new Set<string>();
  const options = { suite: 'e7-code', agent: 'container', casesDir, runsDir: join(root, 'trials'),
    watch: false, failFast: false, experimentFile: resolve('experiments/container.json') };
  for (let round = 0; round < 2; round++) {
    const result = await run(options, controller.signal);
    assert.equal(result.code, 1, 'fixed code must pass and fake-test-only tamper must fail, with no runtime error');
    for (const id of ['code-fix', 'code-tamper']) {
      const dir = join(options.runsDir, result.runId, 'cases', id);
      const verdict = readJson(join(dir, 'result.json'));
      assert.equal(verdict.status, id === 'code-fix' ? 'pass' : 'fail', verdict.reason);
      assert.equal(verdict.assertions.find((a: any) => a.criterion_id === 'container-functional').passed, id === 'code-fix');
      assert.equal(sessions.has(verdict.session_id), false); sessions.add(verdict.session_id);
      assert.equal(readFileSync(join(dir, 'workspace/public-test.cjs'), 'utf8'), 'process.exit(0);\n');
      const proof = readJson(join(dir, 'frozen/proof.json'));
      assert.equal(proof.now, 1767225600000); assert.equal(proof.initial_visits, 0);
      assert.equal(proof.session, verdict.session_id); assert.equal(proof.public_test_passed, true);
      const manifest = readJson(join(dir, 'artifact-manifest.json'));
      assert.deepEqual(manifest.missing, []);
      assert.deepEqual(readdirSync(join(dir, 'frozen')).sort(), ['add.cjs', 'answer.json', 'proof.json']);
      for (const entry of manifest.files) {
        const bytes = readFileSync(join(dir, 'frozen', entry.path));
        assert.equal(entry.bytes, bytes.length); assert.equal(entry.sha256, createHash('sha256').update(bytes).digest('hex'));
      }
      for (const receipt of [join(dir, 'artifacts/container.json'), join(verdict.verifier_result_dir, 'container.json')]) {
        const metadata = readJson(receipt); assert.equal(metadata.removed, true);
        assert.equal(names.has(metadata.name), false); names.add(metadata.name);
      }
      const events = readFileSync(join(dir, 'events.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l).type);
      assert.ok(events.indexOf('agent_stopped') < events.indexOf('artifacts_frozen'));
      assert.ok(events.indexOf('artifacts_frozen') < events.indexOf('container_verifier'));
    }
  }
  checks.push('two rounds: unique sessions and 8 distinct removed containers; initial state/fixture/clock restored; frozen hashes exact; public fake tests cannot alter hidden pass/fail');
  const file = join(casesDir, 'e7-code/code-fix/case.json'); const original = readJson(file);
  for (const [name, shell, timeout, status, stage] of [
    ['missing', 'node agent.cjs; rm add.cjs', 10000, 'environment_error', 'artifact_handoff'],
    ['symlink', 'node agent.cjs; rm add.cjs; ln -s /etc/passwd add.cjs', 10000, 'environment_error', 'artifact_handoff'],
    ['timeout', 'node agent.cjs; sleep 30', 1500, 'timeout', 'agent'],
  ] as const) {
    json(file, { ...original, budgets: { ...original.budgets, timeout_ms: timeout }, execution: { ...original.execution, command: ['sh', '-c', shell] } });
    const result = await run({ ...options, caseId: 'code-fix' }, controller.signal);
    assert.equal(result.code, 2);
    const dir = join(options.runsDir, result.runId, 'cases/code-fix'); const verdict = readJson(join(dir, 'result.json'));
    assert.equal(verdict.status, status, verdict.reason); assert.equal(verdict.stage, stage);
    assert.equal(existsSync(join(dir, 'verifier')), false);
    assert.equal(readJson(join(dir, 'artifacts/container.json')).removed, true);
    if (stage === 'artifact_handoff') assert.match(verdict.reason, /local troubleshooting/);
    checks.push(`${name}: ${status}/${stage}; agent removed and verifier never started`);
  }
  json(file, original);
  json(join(root, 'validation.json'), { status: 'passed', checks });
  console.log(`E7 Docker acceptance passed. Evidence: ${root}`);
} catch (error) {
  const reason = error instanceof Error ? error.message : String(error);
  const stage = error instanceof ExecutionError ? error.stage : 'docker_acceptance';
  json(join(root, 'validation.json'), { status: 'failed', stage, reason, checks });
  console.error(`E7 Docker acceptance FAILED stage=${stage}: ${reason}\nEvidence: ${root}`);
  process.exitCode = 2;
} finally {
  process.off('SIGINT', stop); process.off('SIGTERM', stop);
}
