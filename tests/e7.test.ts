import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { freezeArtifacts } from '../src/artifact-freeze.ts';
import { loadCase } from '../src/config.ts';
import { evaluate } from '../src/evaluation.ts';
import { ExecutionError, prepareImage, runContainer, verifyContainer } from '../src/container.ts';
import type { CommandResult, DockerCommand } from '../src/container.ts';
import { read, setup, write } from './helpers.ts';

const signal = () => new AbortController().signal;
const temporary = () => mkdtempSync(join(tmpdir(), 'agent-eval-e7-'));
const image = `sha256:${'a'.repeat(64)}`;
const success = (stdout = ''): CommandResult => ({ code: 0, stdout, stderr: '', timedOut: false });
const failure = (stderr: string): CommandResult => ({ ...success(), code: 1, stderr });

function fakeDocker(exitCode = 0) {
  const calls: string[][] = [];
  const command: DockerCommand = async args => {
    calls.push(args);
    if (args[0] === 'inspect') return success(JSON.stringify({ Status: 'exited', Running: false, OOMKilled: false, ExitCode: exitCode }));
    if (args[0] === 'start') return { ...success(), code: exitCode };
    if (args[0] === 'image') return success(image);
    return success('fake');
  };
  return { command, calls };
}

test('freeze requires stopped agent, records exact bytes/hash, excludes undeclared inputs and snapshots independently', () => {
  const root = temporary(); const work = join(root, 'workspace'); mkdirSync(work);
  try {
    writeFileSync(join(work, 'answer.json'), '{"answer":"hello"}\n');
    writeFileSync(join(work, 'private-looking.txt'), 'not declared');
    const frozen = join(root, 'frozen');
    assert.throws(() => freezeArtifacts(work, frozen, ['answer.json'], 's1', false), /not stopped/);
    assert.equal(existsSync(frozen), false);
    const manifest = freezeArtifacts(work, frozen, ['answer.json', 'missing.json'], 's1', true);
    assert.deepEqual(manifest.files, [{ path: 'answer.json', bytes: 19, sha256: createHash('sha256').update('{"answer":"hello"}\n').digest('hex') }]);
    assert.equal(manifest.session_id, 's1'); assert.equal(manifest.agent_stopped, true);
    assert.match(manifest.missing[0].error, /missing declared artifact missing.json/);
    assert.equal(existsSync(join(frozen, 'private-looking.txt')), false);
    writeFileSync(join(work, 'answer.json'), 'later mutation');
    assert.equal(readFileSync(join(frozen, 'answer.json'), 'utf8'), '{"answer":"hello"}\n');
    assert.deepEqual(read(join(root, 'artifact-manifest.json')), manifest);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('freeze rejects traversal, reserved paths, links outside/inside allowlist, dangling links, hardlinks and directories', () => {
  const root = temporary(); const work = join(root, 'workspace'); mkdirSync(work);
  try {
    writeFileSync(join(root, 'secret'), 'secret'); writeFileSync(join(work, 'ok.json'), 'ok');
    for (const path of ['../secret', '/etc/passwd', 'C:\\secret', 'sub/file', 'input.json', 'artifact-manifest.json', 'a\0b']) {
      assert.throws(() => freezeArtifacts(work, join(root, 'frozen'), [path], 's', true), /output path/);
    }
    for (const target of [join(root, 'secret'), 'ok.json', 'does-not-exist']) {
      symlinkSync(target, join(work, 'bad.json'));
      assert.throws(() => freezeArtifacts(work, join(root, 'frozen'), ['ok.json', 'bad.json'], 's', true), /symlinks/);
      assert.equal(existsSync(join(root, 'frozen')), false);
      rmSync(join(work, 'bad.json'));
    }
    linkSync(join(root, 'secret'), join(work, 'bad.json'));
    assert.throws(() => freezeArtifacts(work, join(root, 'frozen'), ['bad.json'], 's', true), /hardlinks/);
    rmSync(join(work, 'bad.json')); mkdirSync(join(work, 'bad.json'));
    assert.throws(() => freezeArtifacts(work, join(root, 'frozen'), ['bad.json'], 's', true), /directories/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('trials restore fixture/state/clock, use unique sessions and reject workspace reuse without Docker', async () => {
  const root = temporary();
  const c = loadCase(resolve('cases'), 'smoke', { id: 'smoke-pass', version: '1.0.0' });
  c.input.artifact_allowlist.push('proof.json'); c.input.initial_state = { count: 0 };
  c.config.clock = '2030-04-05T06:07:08.000Z';
  const gold = { notes: 'E7 trial reset test', solve: `
    import { readFileSync, writeFileSync, existsSync } from 'node:fs';
    const state = JSON.parse(readFileSync('initial-state.json', 'utf8'));
    writeFileSync('proof.json', JSON.stringify({ state, now: Date.now(), date: new Date().toISOString(), leaked: existsSync('leak.txt') }));
    writeFileSync('initial-state.json', '{"count":99}'); writeFileSync('leak.txt', 'old');
    writeFileSync('answer.json', '{"answer":"hello"}');
  ` };
  try {
    const a = await evaluate(c, join(root, 'a'), signal(), gold);
    const b = await evaluate(c, join(root, 'b'), signal(), gold);
    assert.equal(a.status, 'pass', a.reason); assert.equal(b.status, 'pass', b.reason);
    assert.notEqual(a.session_id, b.session_id); assert.equal(a.isolation, 'trusted-local');
    const aDir = join(root, 'a/cases/smoke-pass'); const bDir = join(root, 'b/cases/smoke-pass');
    assert.deepEqual(read(join(aDir, 'frozen/proof.json')), read(join(bDir, 'frozen/proof.json')));
    assert.deepEqual(read(join(bDir, 'frozen/proof.json')), { state: { count: 0 }, now: Date.parse(c.config.clock), date: c.config.clock, leaked: false });
    assert.deepEqual(c.input.initial_state, { count: 0 });
    const stub = await evaluate(c, join(root, 'stub'), signal());
    assert.equal(stub.status, 'pass', stub.reason);
    assert.deepEqual(read(join(root, 'stub/cases/smoke-pass/workspace/fixture.json')), c.input.fixture);
    await assert.rejects(evaluate(c, join(root, 'a'), signal(), gold), /EEXIST/);
    const events = readFileSync(join(aDir, 'events.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l).type);
    assert.ok(events.indexOf('agent_stopped') < events.indexOf('artifacts_frozen'));
    assert.ok(events.indexOf('artifacts_frozen') < events.indexOf('verifier'));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('Docker/image preparation errors carry stage, reason and local troubleshooting; image ID is pinned', async () => {
  await assert.rejects(prepareImage('node:24-alpine', signal(), async () => failure('socket denied')), (e: unknown) => {
    assert.ok(e instanceof ExecutionError); assert.equal(e.stage, 'docker_preflight');
    assert.match(e.message, /socket denied.*docker version.*docker info/); return true;
  });
  await assert.rejects(prepareImage('node:24-alpine', signal(), async args => args[0] === 'info' ? success() : failure('image missing')), (e: unknown) => {
    assert.ok(e instanceof ExecutionError); assert.equal(e.stage, 'image_prepare');
    assert.match(e.message, /image missing.*docker image inspect.*docker pull/); return true;
  });
  const fake = fakeDocker(); assert.equal(await prepareImage('node:24-alpine', signal(), fake.command), image);
  assert.equal(fake.calls.some(args => args[0] === 'pull'), false);
});

test('agent is removed before return; a distinct verifier receives only frozen outputs and private tests', async () => {
  const root = temporary(); const fake = fakeDocker(); const work = join(root, 'public'); mkdirSync(work);
  try {
    const agent = await runContainer({ role: 'agent', image, workspace: work, argv: ['sh', '-c', 'node agent.cjs'], epoch: 0, timeout: 1000, logDir: root, signal: signal() }, fake.command);
    assert.deepEqual(fake.calls.at(-1), ['rm', '--force', agent.name]);
    const c = loadCase(resolve('cases'), 'e7-code', { id: 'code-fix', version: '1.0.0' });
    const frozen = join(root, 'frozen'); mkdirSync(frozen);
    const verification = await verifyContainer(c, frozen, root, image, 0, signal(), fake.command);
    assert.equal(verification.assertion.passed, true);
    const creates = fake.calls.filter(args => args[0] === 'create'); assert.equal(creates.length, 2);
    const names = creates.map(args => args[args.indexOf('--name') + 1]); assert.notEqual(names[0], names[1]);
    const mounts = creates.map(args => args.flatMap((a, i) => a === '--mount' ? [args[i + 1]] : []));
    assert.deepEqual(mounts[0], [`type=bind,src=${work},dst=/workspace`]);
    assert.equal(mounts[1].length, 2);
    assert.equal(mounts[1][0], `type=bind,src=${frozen},dst=/artifacts,readonly`);
    assert.match(mounts[1][1], /dst=\/tests,readonly$/);
    assert.equal(mounts[1].some(m => m.includes(work) || m.includes(resolve('cases'))), false);
    for (const args of creates) for (const flag of ['--network=none', '--read-only', '--cap-drop=ALL', '--security-opt=no-new-privileges', '--pull=never']) assert.ok(args.includes(flag));
    assert.equal(fake.calls.some(args => ['exec', 'commit'].includes(args[0])), false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('timeout/abort force-removes container; cleanup failure prevents returning a stopped outcome', async () => {
  const root = temporary();
  try {
    for (const mode of ['timeout', 'abort', 'cleanup-error', 'running', 'create-error']) {
      const controller = new AbortController(); const calls: string[][] = [];
      const command: DockerCommand = async args => {
        calls.push(args);
        if (args[0] === 'create' && mode === 'create-error') return failure('create failed');
        if (args[0] === 'start') {
          if (mode === 'abort') controller.abort();
          if (mode === 'timeout') return { ...success(), timedOut: true, code: null };
        }
        if (args[0] === 'rm' && mode === 'cleanup-error') return failure('daemon disconnected');
        if (args[0] === 'inspect') return success(JSON.stringify({ Status: 'exited', Running: mode === 'running', OOMKilled: false, ExitCode: 0 }));
        return success();
      };
      const run = runContainer({ role: 'agent', image, workspace: root, argv: ['node', 'x'], epoch: 0, timeout: 50, logDir: root, signal: controller.signal }, command);
      if (['cleanup-error', 'running', 'create-error'].includes(mode)) await assert.rejects(run, /local troubleshooting/);
      else { const result = await run; assert.equal(result.timedOut, mode === 'timeout'); }
      assert.equal(calls.at(-1)![0], 'rm');
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('private functional nonzero rejects fake public success and verifier runtime errors cannot pass', async () => {
  const root = temporary();
  try {
    const c = loadCase(resolve('cases'), 'e7-code', { id: 'code-tamper', version: '1.0.0' });
    const fake = fakeDocker(1);
    const result = await verifyContainer(c, root, root, image, 0, signal(), fake.command);
    assert.equal(result.assertion.passed, false);
    await assert.rejects(verifyContainer(c, root, root, image, 0, signal(), fakeDocker(137).command), /verifier exited 137.*local troubleshooting/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('schema rejects public aliases of private tests, invalid clocks/commands, and metadata overwrites', () => {
  const t = setup();
  try {
    const file = join(t.cases, 'e7-code/code-fix/case.json'); const original = read(file);
    const load = () => loadCase(t.cases, 'e7-code', { id: 'code-fix', version: '1.0.0' });
    for (const change of [
      { clock: 'today' },
      { execution: { ...original.execution, command: [] } },
      { execution: { ...original.execution, public_files: { 'leak.cjs': 'verify.cjs' } } },
      { execution: { ...original.execution, public_files: { 'input.json': 'add.cjs' } } },
      { execution: { ...original.execution, private_tests: '../secret' } },
    ]) { write(file, { ...original, ...change }); assert.throws(load); }
  } finally { rmSync(t.root, { recursive: true, force: true }); }
});

test('container evaluator gates handoff and verification on confirmed stop; missing/link failures expose actionable stages', async () => {
  const root = temporary();
  try {
    for (const mode of ['pass', 'fail', 'missing', 'link', 'cleanup-error', 'private-staging-error']) {
      const c = loadCase(resolve('cases'), 'e7-code', { id: 'code-fix', version: '1.0.0' });
      if (mode === 'private-staging-error') c.config.execution!.private_tests = 'missing-private-test.cjs';
      const dir = join(root, mode); const work = join(dir, 'cases/code-fix/workspace');
      const calls: string[][] = []; let role = 'agent';
      const command: DockerCommand = async args => {
        calls.push(args);
        if (args[0] === 'image') return success(image);
        if (args[0] === 'create') {
          role = args[args.indexOf('--name') + 1].includes('-verifier-') ? 'verifier' : 'agent';
          if (role === 'agent') {
            assert.equal(existsSync(join(dir, 'cases/code-fix/frozen')), false);
            assert.equal(existsSync(join(work, 'verify.cjs')), false);
          } else assert.equal(existsSync(join(dir, 'cases/code-fix/artifact-manifest.json')), true);
        }
        if (args[0] === 'start' && role === 'agent') {
          writeFileSync(join(work, 'answer.json'), '{"answer":"done"}');
          writeFileSync(join(work, 'proof.json'), '{}');
          if (mode === 'missing') rmSync(join(work, 'add.cjs'));
          if (mode === 'link') { rmSync(join(work, 'add.cjs')); symlinkSync('/etc/passwd', join(work, 'add.cjs')); }
        }
        if (args[0] === 'rm' && mode === 'cleanup-error') return failure('cannot confirm removal');
        const code = role === 'verifier' && mode === 'fail' ? 1 : 0;
        if (args[0] === 'start') return { ...success(), code };
        if (args[0] === 'inspect') return success(JSON.stringify({ Status: 'exited', Running: false, OOMKilled: false, ExitCode: code }));
        return success();
      };
      const result = await evaluate(c, dir, signal(), undefined, undefined, 'container', command);
      if (mode === 'pass' || mode === 'fail') {
        assert.equal(result.status, mode, result.reason);
        assert.equal(calls.filter(c => c[0] === 'create').length, 2);
      } else if (mode === 'private-staging-error') {
        assert.equal(result.status, 'verifier_error', result.reason);
        assert.equal(result.stage, 'verifier');
        assert.match(result.reason!, /missing-private-test/);
        assert.equal(calls.filter(c => c[0] === 'create').length, 1);
      } else {
        assert.equal(result.status, 'environment_error', result.reason);
        assert.equal(result.stage, mode === 'cleanup-error' ? 'agent_cleanup' : 'artifact_handoff');
        assert.match(result.reason!, /local troubleshooting/);
        assert.equal(calls.filter(c => c[0] === 'create').length, 1);
        assert.equal(existsSync(join(dir, 'cases/code-fix/verifier')), false);
        if (mode === 'cleanup-error') assert.equal(existsSync(join(dir, 'cases/code-fix/frozen')), false);
      }
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});
