import { spawn, spawnSync } from 'node:child_process';
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, relative, resolve, join } from 'node:path';
import { json } from './storage.ts';
import { outputName } from './artifact-freeze.ts';
import type { AgentInput, ExperimentConfig } from './types.ts';

const capabilities = ['headless', 'fixture_injection', 'mock_tools', 'isolated_storage', 'session_reset', 'jsonl_events'];
const object = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
const limit = 8 * 1024 * 1024;

function product(experiment: ExperimentConfig) {
  const p = experiment.product;
  if (typeof p.path !== 'string' || !isAbsolute(p.path) || typeof p.entry !== 'string' || !p.entry || isAbsolute(p.entry)
      || typeof p.revision !== 'string' || !/^[a-f0-9]{40}$/.test(p.revision) || typeof experiment.model !== 'string' || !experiment.model.trim()) {
    throw new Error('jackson-bot-pi preflight: configure product.path (absolute checkout), product.revision (full commit SHA), product.entry (relative headless entry), and model in experiment JSON');
  }
  let root: string; let entry: string;
  try { root = realpathSync(p.path); entry = realpathSync(resolve(root, p.entry)); }
  catch { throw new Error('jackson-bot-pi preflight: product checkout or headless entry does not exist'); }
  const rel = relative(root, entry);
  if (!rel || rel.startsWith('..') || isAbsolute(rel)) throw new Error('jackson-bot-pi preflight: entry must be inside product checkout');
  const git = spawnSync('git', ['-C', root, 'rev-parse', 'HEAD'], { encoding: 'utf8', timeout: 5000 });
  if (git.status !== 0 || git.stdout.trim() !== p.revision) throw new Error('jackson-bot-pi preflight: product revision does not match checkout HEAD');
  const clean = spawnSync('git', ['-C', root, 'diff', '--quiet', 'HEAD', '--'], { timeout: 5000 });
  const tracked = spawnSync('git', ['-C', root, 'ls-files', '--error-unmatch', '--', rel, 'agent-eval-entry.json'], { timeout: 5000 });
  if (clean.status !== 0 || tracked.status !== 0) throw new Error('jackson-bot-pi preflight: tracked product files must be clean and entry and manifest must be tracked at HEAD');
  let manifest: unknown;
  try { manifest = JSON.parse(readFileSync(join(root, 'agent-eval-entry.json'), 'utf8')); } catch { /* diagnostic below */ }
  const declared = object(manifest) && Array.isArray(manifest.capabilities) ? manifest.capabilities : [];
  if (!object(manifest) || manifest.protocol_version !== 1 || manifest.entry !== p.entry || capabilities.some(c => !declared.includes(c))) {
    throw new Error(`jackson-bot-pi preflight: tracked agent-eval-entry.json must declare the configured entry and capabilities ${capabilities.join(', ')} before launch`);
  }
  return { root, entry };
}

// The entry is a trusted local product executable. A capability declaration is a
// contract, not an OS sandbox; the product must implement its isolation promise.
export async function preflightJacksonBotPi(experiment: ExperimentConfig): Promise<void> {
  const { entry } = product(experiment);
  const temp = mkdtempSync(join(tmpdir(), 'agent-eval-preflight-'));
  try {
    const check = await new Promise<{ code: number | null; output: string }>(done => {
      let output = ''; let stopping = false; let invalid = false;
      const child = spawn(process.execPath, [entry, '--agent-eval-preflight'], { cwd: temp, detached: true, stdio: ['ignore', 'pipe', 'ignore'],
        env: { PATH: process.env.PATH ?? '', HOME: temp, TMPDIR: temp, NODE_NO_WARNINGS: '1' } });
      let escalation: NodeJS.Timeout | undefined;
      const kill = (sig: NodeJS.Signals) => { if (child.pid) try { process.kill(-child.pid, sig); } catch { /* already exited */ } };
      const stop = () => { if (stopping) return; stopping = true; kill('SIGTERM'); escalation = setTimeout(() => kill('SIGKILL'), 100); };
      const timer = setTimeout(() => { invalid = true; stop(); }, 5000);
      child.stdout.on('data', data => { output += data.toString(); if (output.length > 65536) { invalid = true; stop(); } });
      child.on('error', () => stop()); child.on('exit', stop);
      child.on('close', code => { clearTimeout(timer); stop(); setTimeout(() => { clearTimeout(escalation); kill('SIGKILL'); done({ code: invalid ? null : code, output }); }, 120); });
    });
    let value: unknown;
    try { value = JSON.parse(check.output); } catch { /* diagnostic below */ }
    const declared = object(value) && Array.isArray(value.capabilities) ? value.capabilities : [];
    if (check.code !== 0 || !object(value) || value.protocol_version !== 1 || capabilities.some(c => !declared.includes(c))) {
      throw new Error(`jackson-bot-pi preflight: entry must support protocol_version 1 and capabilities ${capabilities.join(', ')}; product needs a headless entry with fixture/mock tool injection, isolated storage, session reset and complete JSONL events`);
    }
  } finally { rmSync(temp, { recursive: true, force: true }); }
}

type Outcome = { code: number | null; timedOut: boolean; error?: string };
export async function invokeJacksonBotPi(args: {
  experiment: ExperimentConfig; input: AgentInput; workspace: string; artifacts: string; temp: string;
  session: { id: string }; signal: AbortSignal;
}): Promise<Outcome> {
  const { experiment, input, workspace, artifacts, temp, session, signal } = args;
  const { entry } = product(experiment);
  const storage = join(temp, 'product-storage'); mkdirSync(storage);
  const request = { protocol_version: 1, session_id: session.id, model: experiment.model, prompt: input.prompt,
    fixture: input.fixture, initial_state: input.initial_state, artifact_allowlist: input.artifact_allowlist,
    budgets: input.budgets, storage_dir: storage, mock_tools: true };
  json(join(artifacts, 'product-request.json'), request);
  const eventFile = join(artifacts, 'product-events.jsonl'); writeFileSync(eventFile, '');
  const outcome = await new Promise<Outcome>(done => {
    let timedOut = false; let error: string | undefined; let stopping = false; let bytes = 0;
    const child = spawn(process.execPath, [entry], { cwd: temp, detached: true, stdio: ['pipe', 'pipe', 'pipe'],
      env: { PATH: process.env.PATH ?? '', HOME: temp, TMPDIR: temp, NODE_NO_WARNINGS: '1' } });
    let escalation: NodeJS.Timeout | undefined;
    const kill = (sig: NodeJS.Signals) => { if (child.pid) try { process.kill(-child.pid, sig); } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ESRCH') error = String(e); } };
    const stop = () => { if (stopping) return; stopping = true; kill('SIGTERM'); escalation = setTimeout(() => kill('SIGKILL'), 100); };
    const timer = setTimeout(() => { timedOut = true; stop(); }, input.budgets.timeout_ms);
    const abort = () => stop(); signal.addEventListener('abort', abort, { once: true }); if (signal.aborted) stop();
    child.stdout.on('data', data => { bytes += data.length; if (bytes > limit) { error = 'product JSONL output exceeds limit'; stop(); } else appendFileSync(eventFile, data); });
    child.stderr.on('data', data => appendFileSync(join(artifacts, 'stderr.log'), data));
    child.stdin.on('error', () => {}); child.stdin.end(JSON.stringify(request) + '\n');
    child.on('error', e => { error = e.message; }); child.on('exit', stop);
    child.on('close', code => { clearTimeout(timer); signal.removeEventListener('abort', abort); stop(); setTimeout(() => {
      clearTimeout(escalation); kill('SIGKILL'); done({ code, timedOut, error });
    }, 120); });
  });
  if (outcome.code !== 0 || outcome.timedOut || outcome.error || signal.aborted) return outcome;
  try {
    const lines = readFileSync(eventFile, 'utf8').split('\n').filter(line => line.trim());
    let final: unknown; let finals = 0; const calls: unknown[] = []; const files = new Set<string>();
    for (const line of lines) {
      const e: unknown = JSON.parse(line);
      if (!object(e) || e.protocol_version !== 1 || typeof e.type !== 'string') throw new Error('invalid event envelope');
      if (e.type === 'final') { if (!Object.hasOwn(e, 'answer') || ++finals !== 1) throw new Error('exactly one final answer required'); final = e.answer; }
      else if (e.type === 'tool_call') {
        if (typeof e.tool !== 'string' || !e.tool.trim() || !object(e.arguments)) throw new Error('invalid tool_call');
        calls.push({ tool: e.tool, arguments: e.arguments });
      } else if (e.type === 'tool_result') {
        if (typeof e.tool !== 'string' || !e.tool.trim() || !Object.hasOwn(e, 'result')) throw new Error('invalid tool_result');
      } else if (e.type === 'artifact') {
        if (!outputName(e.path) || !input.artifact_allowlist.includes(e.path) || ['answer.json', 'tool_calls.json'].includes(e.path)
            || typeof e.content !== 'string' || files.has(e.path)) throw new Error('invalid or duplicate artifact');
        files.add(e.path); writeFileSync(join(workspace, e.path), e.content, { flag: 'wx' });
      } else if (e.type === 'usage') { if (!object(e.usage)) throw new Error('invalid usage'); }
      else if (e.type === 'error') { if (typeof e.message !== 'string' || !e.message.trim()) throw new Error('invalid error'); throw new Error(`product error: ${e.message}`); }
      else throw new Error(`unknown event type: ${e.type}`);
    }
    if (finals !== 1) throw new Error('missing final answer');
    json(join(workspace, 'answer.json'), { answer: final, success: true });
    if (input.artifact_allowlist.includes('tool_calls.json')) json(join(workspace, 'tool_calls.json'), calls);
    return outcome;
  } catch (error) {
    appendFileSync(join(artifacts, 'stderr.log'), `protocol: ${(error as Error).message}\n`);
    return { code: 1, timedOut: false };
  }
}
