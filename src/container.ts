import { spawn } from 'node:child_process';
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { localFile } from './config.ts';
import { clockSource } from './trial.ts';
import { json } from './storage.ts';
import type { Assertion, LoadedCase } from './types.ts';

export class ExecutionError extends Error {
  stage: string;
  constructor(stage: string, reason: string, commands: string[]) {
    super(`${reason}; local troubleshooting: ${commands.join(' ; ')}`);
    this.stage = stage;
  }
}
export interface CommandResult { code: number | null; stdout: string; stderr: string; timedOut: boolean; error?: string }
export type DockerCommand = (args: string[], timeout: number, signal: AbortSignal) => Promise<CommandResult>;
// Kept injectable for lifecycle/command-boundary tests; production always uses Docker CLI.
export const dockerCommand: DockerCommand = async (args, timeout, signal) => new Promise(resolveResult => {
  let stdout = ''; let stderr = ''; let error: string | undefined; let timedOut = false;
  const child = spawn('docker', args, { stdio: ['ignore', 'pipe', 'pipe'] });
  const stop = () => { child.kill('SIGKILL'); };
  const timer = setTimeout(() => { timedOut = true; stop(); }, timeout);
  signal.addEventListener('abort', stop, { once: true });
  if (signal.aborted) stop();
  child.stdout.on('data', b => { stdout = (stdout + b).slice(-1024 * 1024); });
  child.stderr.on('data', b => { stderr = (stderr + b).slice(-1024 * 1024); });
  child.on('error', e => { error = e.message; });
  child.on('close', code => {
    clearTimeout(timer); signal.removeEventListener('abort', stop);
    resolveResult({ code, stdout, stderr, timedOut, error });
  });
});
const freshSignal = () => new AbortController().signal;
export const shellQuote = (s: string) => `'${s.replaceAll("'", "'\\''")}'`;
const failure = (r: CommandResult) => r.error ?? (r.timedOut ? 'Docker command timed out' : r.stderr.trim() || `Docker exited ${r.code}`);
const ok = (r: CommandResult) => r.code === 0 && !r.error && !r.timedOut;

export async function prepareImage(image: string, signal: AbortSignal, command = dockerCommand): Promise<string> {
  const info = await command(['info', '--format', '{{.ServerVersion}}'], 10000, signal);
  if (!ok(info) || signal.aborted) throw new ExecutionError('docker_preflight', signal.aborted ? 'interrupted' : failure(info), ['docker version', 'docker context show', 'docker info']);
  // No implicit pull/build or mutable-tag race between agent and verifier. The
  // operator prepares the image once; both containers then use this image ID.
  const inspected = await command(['image', 'inspect', '--format', '{{.Id}}', image], 10000, signal);
  if (!ok(inspected) || !/^sha256:[a-f0-9]{64}$/.test(inspected.stdout.trim())) throw new ExecutionError('image_prepare', failure(inspected), [`docker image inspect ${shellQuote(image)}`, `docker pull ${shellQuote(image)}`]);
  return inspected.stdout.trim();
}
function mount(source: string, target: string, readOnly: boolean): string {
  const path = resolve(source);
  if (path.includes(',') || path.includes('\n')) throw new ExecutionError('container_prepare', `unsupported bind path ${path}`, ['pwd', 'docker info']);
  return `type=bind,src=${path},dst=${target}${readOnly ? ',readonly' : ''}`;
}

export async function runContainer(options: {
  role: 'agent' | 'verifier'; image: string; workspace?: string; frozen?: string; tests?: string;
  argv: string[]; epoch: number; timeout: number; logDir: string; signal: AbortSignal;
}, command = dockerCommand): Promise<{ code: number | null; timedOut: boolean; name: string }> {
  const { role, signal } = options;
  const name = `agent-eval-${role}-${randomUUID()}`;
  const mounts = role === 'agent'
    ? ['--mount', mount(options.workspace!, '/workspace', false)]
    : ['--mount', mount(options.frozen!, '/artifacts', true), '--mount', mount(options.tests!, '/tests', true)];
  const args = ['create', '--name', name, '--pull=never', '--network=none', '--read-only', '--cap-drop=ALL',
    '--security-opt=no-new-privileges', '--pids-limit=128', '--memory=256m', '--cpus=1',
    '--user', `${process.getuid?.() ?? 1000}:${process.getgid?.() ?? 1000}`,
    '--tmpfs', '/tmp:rw,nosuid,nodev,size=64m,mode=1777', '--workdir', role === 'agent' ? '/workspace' : '/tmp',
    '--env', 'HOME=/tmp', '--env', `AGENT_EVAL_NOW=${options.epoch}`,
    '--env', `NODE_OPTIONS=--require=/${role === 'agent' ? 'workspace' : 'tests'}/clock.cjs`,
    ...mounts, options.image, ...options.argv];
  let created = false;
  let createAttempted = false;
  let outcome: { code: number | null; timedOut: boolean; name: string } | undefined;
  try {
    if (signal.aborted) throw new ExecutionError(`${role}_start`, 'interrupted before create', ['docker ps -a']);
    createAttempted = true;
    const create = await command(args, 10000, signal);
    if (!ok(create)) throw new ExecutionError(`${role}_prepare`, failure(create), ['docker info', `docker inspect ${shellQuote(name)}`]);
    created = true;
    const run = await command(['start', '--attach', name], options.timeout, signal);
    appendFileSync(join(options.logDir, 'stdout.log'), run.stdout);
    appendFileSync(join(options.logDir, 'stderr.log'), run.stderr);
    if (run.timedOut || signal.aborted) {
      outcome = { code: run.code, timedOut: run.timedOut, name };
    } else {
      // CLI exit alone is not a verifier verdict: confirm the actual container
      // terminated, then read its exit status from the daemon.
      const state = await command(['inspect', '--format', '{{json .State}}', name], 10000, signal);
      let parsed;
      try { parsed = JSON.parse(state.stdout); } catch { /* checked below */ }
      if (!ok(state) || !parsed || parsed.Status !== 'exited' || parsed.Running !== false || parsed.OOMKilled || !Number.isInteger(parsed.ExitCode) || run.error || run.code !== parsed.ExitCode) {
        throw new ExecutionError(`${role}_execution`, run.error ?? `cannot confirm clean container termination: ${state.stdout} ${failure(state)}`, [`docker inspect ${shellQuote(name)}`, 'docker info']);
      }
      outcome = { code: parsed.ExitCode, timedOut: false, name };
    }
  } finally {
    if (createAttempted) {
      // Never trust killing `docker start` to kill the container. Wait for forced
      // removal (all container processes) before any artifact collection.
      const removed = await command(['rm', '--force', name], 10000, freshSignal());
      if (!ok(removed) && (created || !/No such container/i.test(removed.stderr))) {
        throw new ExecutionError(`${role}_cleanup`, failure(removed), [`docker rm -f ${shellQuote(name)}`, 'docker ps -a']);
      }
      json(join(options.logDir, 'container.json'), { name, role, image: options.image, removed: true, mounts, outcome });
    }
  }
  return outcome!;
}

export function stagePublicFiles(c: LoadedCase, workspace: string): void {
  for (const [destination, source] of Object.entries(c.config.execution!.public_files)) {
    writeFileSync(join(workspace, destination), readFileSync(localFile(dirname(c.file), source, `execution.public_files.${destination}`)), { flag: 'wx' });
  }
}
export async function verifyContainer(c: LoadedCase, frozen: string, caseDir: string, image: string, epoch: number, signal: AbortSignal, command = dockerCommand) {
  const resultDir = join(caseDir, 'verifier', `container-${randomUUID()}`);
  const tests = join(resultDir, 'private');
  mkdirSync(tests, { recursive: true });
  writeFileSync(join(tests, 'verify.cjs'), readFileSync(localFile(dirname(c.file), c.config.execution!.private_tests, 'execution.private_tests')));
  writeFileSync(join(tests, 'clock.cjs'), clockSource);
  const result = await runContainer({ role: 'verifier', image, frozen, tests, argv: c.config.execution!.verifier_command,
    epoch, timeout: c.input.budgets.timeout_ms, logDir: resultDir, signal }, command);
  if (result.timedOut || signal.aborted || (result.code !== 0 && result.code !== 1)) {
    throw new ExecutionError('verifier_execution', `verifier ${result.timedOut ? 'timed out' : `exited ${result.code}`}`, [`cat ${shellQuote(join(resultDir, 'stderr.log'))}`, 'docker info']);
  }
  const artifact = join(frozen, c.input.artifact_allowlist.find(n => n !== 'answer.json') ?? 'answer.json');
  const assertion: Assertion = { criterion_id: 'container-functional', type: 'equals', mode: 'hard',
    target: { artifact: artifact.split('/').at(-1)!, field: '' }, params: { expected: true }, expected: true,
    actual: result.code === 0, passed: result.code === 0, artifact,
    reason: 'Private functional tests run in a newly created verifier container against frozen artifacts.',
    evidence: [{ artifact, field: '' }] };
  json(join(resultDir, 'result.json'), { status: assertion.passed ? 'pass' : 'fail', assertions: [assertion], container: result.name });
  return { assertion, resultDir };
}
