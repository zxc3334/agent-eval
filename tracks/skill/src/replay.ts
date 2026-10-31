import { spawn, spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createRunDir } from '../../../packages/core/src/runs.ts';
import { assessCommit } from '../../../packages/core/src/sha.ts';
import { buildAgentInput, loadTaskCard, serializeAgentInput, TaskCardError } from '../../../packages/core/src/task-card.ts';
import type { TaskCard } from '../../../packages/core/src/task-card.ts';
import { writeJson } from '../../../packages/core/src/config.ts';
import {
  CURSOR_AGENT_ENTRY,
  CURSOR_AGENT_FIXED_ARGS,
  CURSOR_AGENT_NAME,
  cursorAgentArgs,
  installSkill,
  parseStreamLine,
  promptSha256,
  summarizeCursorStream,
} from './cursor-agent.ts';
import type { InstalledSkill, StreamEvent } from './cursor-agent.ts';

export interface VariantSpec {
  name: 'without' | 'with-skill';
  skillPath?: string;
}

export interface ReplayPlan {
  taskId: string;
  repoDir: string;
  repeat: number;
  variants: VariantSpec[];
  agentExecutable: string;
  sourceRunId?: string;
}

export interface ReplayOptions {
  root: string;
  runsDir: string;
  taskId: string;
  repoDir?: string;
  variants: VariantSpec[];
  repeat: number;
  caseName?: string;
  resumeRunId?: string;
  failedFrom?: string;
  agentExecutable: string;
}

export interface ReplayOutcome {
  runId: string;
  dir: string;
  code: number;
}

interface AttemptResult {
  adapter: typeof CURSOR_AGENT_NAME;
  variant: string;
  attempt: number;
  status: 'completed' | 'interrupted' | 'error';
  exit_code: number | null;
  head: string | null;
  expected_base: string;
  score: 'unavailable';
  score_reason: string;
  verify: string;
  reason?: string;
}

const SCORE_REASON = 'replay does not score; pnpm eval verify records the score, or unavailable when it cannot';

function git(args: string[], cwd?: string): { ok: true; stdout: string } | { ok: false; message: string } {
  let result;
  try {
    result = spawnSync('git', args, { cwd, encoding: 'utf8', timeout: 30_000 });
  } catch (error) {
    return { ok: false, message: (error as Error).message };
  }
  if (result.error || result.status == null) return { ok: false, message: result.error?.message ?? 'git is unavailable' };
  if (result.status !== 0) return { ok: false, message: (result.stderr || result.stdout || `git ${args[0]} failed`).trim() };
  return { ok: true, stdout: (result.stdout ?? '').trim() };
}

/** Independent checkout of `sha` and its ancestors only. Later commits are not fetched. */
export function checkoutBase(sourceRepo: string, sha: string, dest: string): void {
  mkdirSync(dest, { recursive: true });
  const init = git(['init', '-q'], dest);
  if (!init.ok) throw new Error(init.message);
  const fetched = git(['fetch', '-q', '--no-tags', sourceRepo, sha], dest);
  if (!fetched.ok) throw new Error(fetched.message);
  const checkout = git(['checkout', '-q', '--detach', 'FETCH_HEAD'], dest);
  if (!checkout.ok) throw new Error(checkout.message);
  const head = git(['rev-parse', 'HEAD'], dest);
  if (!head.ok) throw new Error(head.message);
  if (head.stdout !== sha) throw new Error(`checkout HEAD ${head.stdout} is not base ${sha}`);
  const branch = git(['branch', '-f', 'base', 'HEAD'], dest);
  if (!branch.ok) throw new Error(branch.message);
  const remotes = git(['remote'], dest);
  if (!remotes.ok) throw new Error(remotes.message);
  for (const name of remotes.stdout.split('\n').filter(Boolean)) {
    const removed = git(['remote', 'remove', name], dest);
    if (!removed.ok) throw new Error(removed.message);
  }
}

function verifyLabel(card: TaskCard, yamlText: string): string {
  const privateAt = yamlText.indexOf('\nprivate:');
  const body = privateAt === -1 ? yamlText : yamlText.slice(privateAt);
  if (!/\n  verify:/.test(body)) return 'omitted';
  return card.private.verify.status;
}

function attemptDir(variantDir: string, attempt: number, repeat: number): string {
  return repeat === 1 ? variantDir : join(variantDir, 'attempts', String(attempt));
}

function readResult(dir: string): AttemptResult | undefined {
  const file = join(dir, 'result.json');
  if (!existsSync(file)) return undefined;
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as AttemptResult;
  } catch {
    return undefined;
  }
}

function isCompleted(dir: string): boolean {
  return readResult(dir)?.status === 'completed';
}

function archivePartial(dir: string): void {
  if (!existsSync(dir)) return;
  const names = readdirSync(dir).filter(name => name !== 'partials');
  if (names.length === 0) return;
  const dest = join(dir, 'partials', new Date().toISOString().replace(/[:.]/g, '-'));
  mkdirSync(dest, { recursive: true });
  for (const name of names) renameSync(join(dir, name), join(dest, name));
}

function writeText(file: string, text: string): void {
  writeFileSync(file, text);
}

interface AgentRun {
  code: number | null;
  error?: string;
  aborted: boolean;
  spawned: boolean;
  events: StreamEvent[];
  durationMs: number | 'unknown';
}

function runAgent(
  executable: string,
  args: string[],
  workspace: string,
  eventsFile: string,
  stderrFile: string,
  signal: AbortSignal,
): Promise<AgentRun> {
  return new Promise(resolve => {
    const started = performance.now();
    let spawned = false;
    let error: string | undefined;
    let stopping = false;
    const events: StreamEvent[] = [];
    let stdoutBuffer = '';
    const child = spawn(executable, args, {
      cwd: workspace,
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: agentEnv(),
    });
    spawned = child.pid != null;
    const killGroup = (name: NodeJS.Signals) => {
      if (!child.pid) return;
      try {
        process.kill(-child.pid, name);
      } catch (killError) {
        if ((killError as NodeJS.ErrnoException).code !== 'ESRCH') error = (killError as Error).message;
      }
    };
    let escalation: NodeJS.Timeout | undefined;
    const stop = () => {
      if (stopping) return;
      stopping = true;
      killGroup('SIGTERM');
      escalation = setTimeout(() => killGroup('SIGKILL'), 100);
    };
    const onAbort = () => stop();
    signal.addEventListener('abort', onAbort, { once: true });
    if (signal.aborted) stop();
    const takeLines = (flush: boolean) => {
      let nl = stdoutBuffer.indexOf('\n');
      while (nl !== -1) {
        const line = stdoutBuffer.slice(0, nl);
        stdoutBuffer = stdoutBuffer.slice(nl + 1);
        appendFileSync(eventsFile, `${line}\n`);
        const parsed = parseStreamLine(line);
        if (parsed) events.push(parsed);
        nl = stdoutBuffer.indexOf('\n');
      }
      if (flush && stdoutBuffer.length > 0) {
        appendFileSync(eventsFile, `${stdoutBuffer}\n`);
        const parsed = parseStreamLine(stdoutBuffer);
        if (parsed) events.push(parsed);
        stdoutBuffer = '';
      }
    };
    child.stdout.on('data', (chunk: Buffer) => {
      stdoutBuffer += chunk.toString('utf8');
      takeLines(false);
    });
    child.stderr.on('data', (chunk: Buffer) => appendFileSync(stderrFile, chunk));
    child.on('error', (spawnError) => {
      error = spawnError.message;
    });
    child.on('close', (code) => {
      takeLines(true);
      signal.removeEventListener('abort', onAbort);
      clearTimeout(escalation);
      if (child.pid) {
        try { process.kill(-child.pid, 'SIGKILL'); } catch { /* already gone */ }
      }
      const durationMs = spawned ? Math.round(performance.now() - started) : 'unknown';
      resolve({ code, error, aborted: signal.aborted, spawned, events, durationMs });
    });
  });
}

function agentEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  delete env.GIT_DIR;
  delete env.GIT_WORK_TREE;
  return env;
}

function resultBase(variant: string, attempt: number, base: string, verify: string, status: AttemptResult['status']): AttemptResult {
  return {
    adapter: CURSOR_AGENT_NAME,
    variant,
    attempt,
    status,
    exit_code: null,
    head: null,
    expected_base: base,
    score: 'unavailable',
    score_reason: SCORE_REASON,
    verify,
  };
}

async function runAttempt(input: {
  dir: string;
  variant: VariantSpec;
  attempt: number;
  repeat: number;
  sourceRepo: string;
  base: string;
  prompt: string;
  promptHash: string;
  verify: string;
  executable: string;
  resume: boolean;
  signal: AbortSignal;
}): Promise<AttemptResult> {
  if (input.resume && isCompleted(input.dir)) {
    return readResult(input.dir) ?? resultBase(input.variant.name, input.attempt, input.base, input.verify, 'completed');
  }
  if (input.resume) archivePartial(input.dir);
  mkdirSync(input.dir, { recursive: true });
  const workspace = join(input.dir, 'workspace');
  const failed = (status: AttemptResult['status'], reason: string, head: string | null = null): AttemptResult => {
    const result = resultBase(input.variant.name, input.attempt, input.base, input.verify, status);
    result.reason = reason;
    result.head = head;
    writeJson(join(input.dir, 'result.json'), result);
    return result;
  };
  if (input.signal.aborted) return failed('interrupted', 'interrupted before checkout');

  let head: string | null = null;
  try {
    checkoutBase(input.sourceRepo, input.base, workspace);
    const parsedHead = git(['rev-parse', 'HEAD'], workspace);
    head = parsedHead.ok ? parsedHead.stdout : null;
    if (head !== input.base) return failed('error', `start SHA ${head ?? 'missing'} is not base ${input.base}`, head);
  } catch (error) {
    return failed('error', (error as Error).message, head);
  }
  if (input.signal.aborted) return failed('interrupted', 'interrupted after checkout', head);

  let installed: InstalledSkill | undefined;
  try {
    if (input.variant.name === 'with-skill') {
      if (!input.variant.skillPath) return failed('error', 'with-skill needs a skill path', head);
      installed = installSkill(input.variant.skillPath, workspace);
    }
  } catch (error) {
    return failed('error', (error as Error).message, head);
  }

  const config = {
    adapter: CURSOR_AGENT_NAME,
    entry: CURSOR_AGENT_ENTRY,
    executable: input.executable,
    args: [...CURSOR_AGENT_FIXED_ARGS],
    model: null,
    skills: installed ? [{ name: installed.name, path: installed.source }] : [],
    prompt_sha256: input.promptHash,
    answers_questions: false,
  };
  const args = cursorAgentArgs(workspace, input.prompt);
  writeText(join(input.dir, 'agent-input.json'), input.prompt);
  writeText(join(input.dir, 'prompt.txt'), input.prompt);
  writeJson(join(input.dir, 'config.json'), config);
  writeJson(join(input.dir, 'invocation.json'), {
    adapter: CURSOR_AGENT_NAME,
    entry: CURSOR_AGENT_ENTRY,
    executable: input.executable,
    argv: args,
    stdin: 'closed',
    answered_questions: false,
  });
  writeText(join(input.dir, 'events.jsonl'), '');
  writeText(join(input.dir, 'stderr.log'), '');

  const outcome = await runAgent(
    input.executable,
    args,
    workspace,
    join(input.dir, 'events.jsonl'),
    join(input.dir, 'stderr.log'),
    input.signal,
  );
  const summary = summarizeCursorStream(outcome.events, { spawned: outcome.spawned, aborted: outcome.aborted });
  writeJson(join(input.dir, 'interventions.json'), summary.interventions);
  writeJson(join(input.dir, 'usage.json'), {
    input_tokens: summary.usage.input_tokens,
    output_tokens: summary.usage.output_tokens,
    duration_ms: outcome.durationMs,
  });
  const status: AttemptResult['status'] = outcome.aborted ? 'interrupted' : outcome.error || outcome.code !== 0 ? 'error' : 'completed';
  const result = resultBase(input.variant.name, input.attempt, input.base, input.verify, status);
  result.exit_code = outcome.code;
  result.head = head;
  if (outcome.error) result.reason = outcome.error;
  else if (status === 'interrupted') result.reason = 'interrupted by signal';
  else if (status === 'error') result.reason = `Cursor Agent exited with code ${outcome.code}`;
  writeJson(join(input.dir, 'result.json'), result);
  return result;
}

function loadPlan(runsDir: string, runId: string): { dir: string; plan: ReplayPlan } {
  const dir = join(runsDir, runId);
  const file = join(dir, 'run.json');
  if (!existsSync(file)) throw new Error(`run not found: ${runId}`);
  const plan = JSON.parse(readFileSync(file, 'utf8')) as ReplayPlan & { run_id?: string };
  if (!plan.taskId || !plan.repoDir || !Array.isArray(plan.variants)) throw new Error(`run ${runId} has no replay plan`);
  return { dir, plan };
}

function variantKey(variant: VariantSpec, attempt: number): string {
  return `${variant.name}#${attempt}`;
}

function selectVariants(variants: readonly VariantSpec[], caseName: string | undefined): VariantSpec[] {
  if (!caseName) return [...variants];
  const selected = variants.filter(variant => variant.name === caseName);
  if (selected.length === 0) throw new Error(`case: ${caseName} is not a variant in this run`);
  return selected;
}

export async function runReplay(options: ReplayOptions, signal: AbortSignal = new AbortController().signal): Promise<ReplayOutcome> {
  if (process.platform === 'win32') throw new Error('replay process cleanup requires macOS or Linux');
  const cardDir = join(options.root, 'tasks', options.taskId);
  const cardFile = join(cardDir, 'card.yaml');
  let card: TaskCard;
  try {
    card = loadTaskCard(cardDir);
  } catch (error) {
    if (error instanceof TaskCardError) throw new Error(error.message);
    throw error;
  }
  const yamlText = readFileSync(cardFile, 'utf8');
  let agentInput;
  try {
    agentInput = buildAgentInput(card);
  } catch (error) {
    if (error instanceof TaskCardError) throw new Error(error.message);
    throw error;
  }
  const prompt = serializeAgentInput(card);
  const promptHash = promptSha256(prompt);
  if (typeof card.public.base_commit !== 'string') {
    throw new Error('replay needs a concrete base commit');
  }
  const base = agentInput.base_commit;
  const verify = verifyLabel(card, yamlText);

  let plan: ReplayPlan;
  let dir: string;
  let runId: string;
  let selected: VariantSpec[];
  const resume = Boolean(options.resumeRunId);
  if (options.resumeRunId) {
    const loaded = loadPlan(options.runsDir, options.resumeRunId);
    if (loaded.plan.taskId !== options.taskId) throw new Error(`run ${options.resumeRunId} is for task ${loaded.plan.taskId}`);
    dir = loaded.dir;
    runId = options.resumeRunId;
    plan = {
      ...loaded.plan,
      agentExecutable: options.agentExecutable === CURSOR_AGENT_ENTRY ? loaded.plan.agentExecutable : options.agentExecutable,
    };
    selected = selectVariants(plan.variants, options.caseName);
  } else if (options.failedFrom) {
    const loaded = loadPlan(options.runsDir, options.failedFrom);
    if (loaded.plan.taskId !== options.taskId) throw new Error(`run ${options.failedFrom} is for task ${loaded.plan.taskId}`);
    const known = selectVariants(loaded.plan.variants, options.caseName);
    const incomplete = known.filter(variant => {
      const variantDir = join(loaded.dir, 'variants', variant.name);
      for (let attempt = 1; attempt <= loaded.plan.repeat; attempt += 1) {
        if (!isCompleted(attemptDir(variantDir, attempt, loaded.plan.repeat))) return true;
      }
      return false;
    });
    const repoDir = resolve(options.repoDir ?? loaded.plan.repoDir);
    const existence = await assessCommit(base, { repoDir });
    if (!existence.ok) throw new Error(existence.message);
    const created = createRunDir(options.runsDir);
    dir = created.dir;
    runId = created.id;
    plan = {
      taskId: options.taskId,
      repoDir,
      repeat: loaded.plan.repeat,
      variants: incomplete,
      agentExecutable: options.agentExecutable === CURSOR_AGENT_ENTRY ? loaded.plan.agentExecutable : options.agentExecutable,
      sourceRunId: options.failedFrom,
    };
    selected = incomplete;
  } else {
    if (!options.repoDir) throw new Error('replay needs --repo-dir pointing at a local checkout that contains the base commit');
    if (options.variants.length === 0) throw new Error('replay needs --variant without and/or --variant with-skill=<path>');
    selected = selectVariants(options.variants, options.caseName);
    const repoDir = resolve(options.repoDir);
    const existence = await assessCommit(base, { repoDir });
    if (!existence.ok) throw new Error(existence.message);
    const created = createRunDir(options.runsDir);
    dir = created.dir;
    runId = created.id;
    plan = {
      taskId: options.taskId,
      repoDir,
      repeat: options.repeat,
      variants: options.variants,
      agentExecutable: options.agentExecutable,
    };
  }

  const repoDir = plan.repoDir;
  if (resume) {
    const existence = await assessCommit(base, { repoDir });
    if (!existence.ok) throw new Error(existence.message);
  }

  const stored: ReplayPlan = { ...plan, repoDir, variants: plan.variants };
  writeJson(join(dir, 'run.json'), { run_id: runId, ...stored, case: options.caseName ?? null });
  const state = { interrupted: false, current: null as string | null, completed: [] as string[] };
  writeJson(join(dir, 'state.json'), state);
  console.log(`Run ${runId}\nRun directory: ${dir}\nAdapter: ${CURSOR_AGENT_NAME}\nBase: ${base}${stored.sourceRunId ? `\nSource run: ${stored.sourceRunId}` : ''}`);
  if (selected.length === 0) {
    console.log('no incomplete variants');
    return { runId, dir, code: 0 };
  }

  let sawError = false;
  for (const variant of selected) {
    for (let attempt = 1; attempt <= stored.repeat; attempt += 1) {
      if (signal.aborted) {
        state.interrupted = true;
        writeJson(join(dir, 'state.json'), state);
        return { runId, dir, code: 2 };
      }
      const key = variantKey(variant, attempt);
      state.current = key;
      writeJson(join(dir, 'state.json'), state);
      const variantDir = join(dir, 'variants', variant.name);
      const dirForAttempt = attemptDir(variantDir, attempt, stored.repeat);
      const result = await runAttempt({
        dir: dirForAttempt,
        variant,
        attempt,
        repeat: stored.repeat,
        sourceRepo: repoDir,
        base,
        prompt,
        promptHash,
        verify,
        executable: stored.agentExecutable,
        resume,
        signal,
      });
      if (result.status === 'completed') state.completed.push(key);
      if (result.status === 'error') sawError = true;
      if (result.status === 'interrupted') state.interrupted = true;
      state.current = null;
      writeJson(join(dir, 'state.json'), state);
      console.log(`${result.status.toUpperCase()} ${variant.name} attempt ${attempt} head=${result.head ?? 'unknown'} score=${result.score}`);
      if (stored.repeat > 1) writeAttemptSummary(variantDir, variant.name, stored.repeat);
      if (result.status === 'interrupted') return { runId, dir, code: 2 };
    }
  }
  return { runId, dir, code: state.interrupted ? 2 : sawError ? 1 : 0 };
}

function writeAttemptSummary(variantDir: string, name: string, repeat: number): void {
  const attempts = [];
  for (let attempt = 1; attempt <= repeat; attempt += 1) {
    const result = readResult(attemptDir(variantDir, attempt, repeat));
    if (result) attempts.push({ attempt, status: result.status, head: result.head, score: result.score });
  }
  writeJson(join(variantDir, 'result.json'), { variant: name, repeat, score: 'unavailable', attempts });
}
