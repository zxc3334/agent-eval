import { spawn, spawnSync } from 'node:child_process';
import { cpSync, chmodSync, copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync, appendFileSync } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { createRunDir } from '../../../packages/core/src/runs.ts';
import { writeJson } from '../../../packages/core/src/config.ts';
import {
  aggregateScoreExit,
  checkSkillEvidence,
  parseFeaturesMap,
  parsePinFile,
  pinnedDigest,
  scoreFromCheckedEvidence,
  VERIFY_PHASES,
  VERIFY_UNAVAILABLE_EXIT,
} from '../../../packages/core/src/evidence.ts';
import type {
  FeatureEvidence,
  FeaturesMap,
  PhaseRecord,
  ScoreResult,
  VerifyPhase,
  VerifyPin,
  VerifyResult,
} from '../../../packages/core/src/evidence.ts';
import { loadTaskCard, TaskCardError } from '../../../packages/core/src/task-card.ts';
import type { TaskCard } from '../../../packages/core/src/task-card.ts';
import { checkoutBase } from './replay.ts';

const OVERLAP_NOTE = 'File overlap with the merge is evidence. It is not a score and it is not gold.';

export interface VerifyTargetInput {
  name: string;
  workspace: string;
}

export interface VerifyOptions {
  root: string;
  runsDir: string;
  taskId: string;
  runId?: string;
  targets: VerifyTargetInput[];
  verifyBundle?: string;
  repoDir?: string;
}

export interface VerifyOutcome {
  runId: string;
  dir: string;
  code: number;
}

interface Target {
  name: string;
  workspace: string;
  verifyDir: string;
}

interface LoadedPin {
  root: string;
  pin: VerifyPin;
  map: FeaturesMap;
  featuresMapPath: string;
  phases: Record<VerifyPhase, string>;
}

interface PhaseRun {
  exitCode: number | null;
  aborted: boolean;
  error?: string;
}

export type CardVerifyKind = 'missing' | 'none' | 'todo' | 'unavailable' | 'path';

function cardVerifyKind(card: TaskCard, yamlText: string): CardVerifyKind {
  const privateAt = yamlText.indexOf('\nprivate:');
  const body = privateAt === -1 ? yamlText : yamlText.slice(privateAt);
  if (!/\n  verify:/.test(body)) return 'missing';
  return card.private.verify.status;
}

function mergeSha(card: TaskCard): string | undefined {
  const merge = card.private.merge;
  if (!merge || !('sha' in merge)) return undefined;
  return merge.sha;
}

function isInside(parent: string, child: string): boolean {
  const rel = relative(resolve(parent), resolve(child));
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

function gitRaw(args: string[], cwd: string): { ok: true; stdout: string } | { ok: false; message: string } {
  let result;
  try {
    result = spawnSync('git', args, { cwd, encoding: 'utf8', timeout: 30_000 });
  } catch (error) {
    return { ok: false, message: (error as Error).message };
  }
  if (result.error || result.status == null) return { ok: false, message: result.error?.message ?? 'git is unavailable' };
  if (result.status !== 0) return { ok: false, message: (result.stderr || result.stdout || `git ${args[0]} failed`).trim() };
  return { ok: true, stdout: result.stdout ?? '' };
}

function uniquePaths(payload: string): string[] {
  return [...new Set(payload.split('\0').map(item => item.trim()).filter(Boolean))].sort();
}

function walkFiles(dir: string): { path: string; bytes: Uint8Array }[] {
  const entries: { path: string; bytes: Uint8Array }[] = [];
  const pending = [dir];
  while (pending.length > 0) {
    const current = pending.pop();
    if (!current) break;
    for (const name of readdirSync(current)) {
      const path = join(current, name);
      if (statSync(path).isDirectory()) pending.push(path);
      else entries.push({ path: relative(dir, path).split(sep).join('/'), bytes: readFileSync(path) });
    }
  }
  return entries;
}

export function loadPinnedBundle(dir: string): { ok: true; pin: LoadedPin } | { ok: false; reason: string } {
  const root = resolve(dir);
  if (!existsSync(root) || !statSync(root).isDirectory()) {
    return { ok: false, reason: `pinned verify not found outside the workspace: ${root}` };
  }
  const pinPath = join(root, 'pin.json');
  const mapPath = join(root, 'features-map.json');
  if (!existsSync(pinPath) || !existsSync(mapPath)) {
    return { ok: false, reason: 'pinned verify is missing pin.json or features-map.json' };
  }
  let pinJson: unknown;
  let mapJson: unknown;
  try {
    pinJson = JSON.parse(readFileSync(pinPath, 'utf8'));
    mapJson = JSON.parse(readFileSync(mapPath, 'utf8'));
  } catch (error) {
    return { ok: false, reason: `pinned verify is not valid JSON: ${(error as Error).message}` };
  }
  const pin = parsePinFile(pinJson);
  if (!pin.ok) return pin;
  const map = parseFeaturesMap(mapJson);
  if (!map.ok) return map;
  if (pin.pin.version !== map.map.version) {
    return { ok: false, reason: `pin version ${pin.pin.version} does not match features-map version ${map.map.version}` };
  }
  const phases = {} as Record<VerifyPhase, string>;
  for (const phase of VERIFY_PHASES) {
    const file = join(root, 'phases', phase);
    if (!existsSync(file) || !statSync(file).isFile()) return { ok: false, reason: `pinned verify is missing phases/${phase}` };
    phases[phase] = file;
  }
  return {
    ok: true,
    pin: {
      root,
      pin: { ...pin.pin, digest: pinnedDigest(walkFiles(root)) },
      map: map.map,
      featuresMapPath: mapPath,
      phases,
    },
  };
}

function resolveBundle(root: string, taskId: string, card: TaskCard, flag: string | undefined): string | undefined {
  if (flag) return resolve(flag);
  if (card.private.verify.status !== 'path') return undefined;
  const cardPath = card.private.verify.path;
  if (isAbsolute(cardPath)) return cardPath;
  const candidates = [join(root, 'tasks', taskId, cardPath), join(root, cardPath)];
  return candidates.find(candidate => existsSync(candidate));
}

function cleanEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  delete env.GIT_DIR;
  delete env.GIT_WORK_TREE;
  return env;
}

function runPhase(
  script: string,
  phase: VerifyPhase,
  workspace: string,
  evidenceDir: string,
  pin: LoadedPin,
  signal: AbortSignal,
  logDir: string,
): Promise<PhaseRun> {
  return new Promise(resolvePhase => {
    const stdoutFile = join(logDir, 'stdout.log');
    const stderrFile = join(logDir, 'stderr.log');
    writeFileSync(stdoutFile, '');
    writeFileSync(stderrFile, '');
    let error: string | undefined;
    const child = spawn(script, [], {
      cwd: workspace,
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...cleanEnv(),
        VERIFY_WORKSPACE: workspace,
        VERIFY_EVIDENCE: evidenceDir,
        VERIFY_FEATURES_MAP: pin.featuresMapPath,
        VERIFY_PHASE: phase,
        VERIFY_PIN_VERSION: pin.pin.version,
        VERIFY_PIN_ID: pin.pin.id,
      },
    });
    const killGroup = (name: NodeJS.Signals) => {
      if (!child.pid) return;
      try {
        process.kill(-child.pid, name);
      } catch (killError) {
        if ((killError as NodeJS.ErrnoException).code !== 'ESRCH') error = (killError as Error).message;
      }
    };
    let escalation: NodeJS.Timeout | undefined;
    let stopping = false;
    const stop = () => {
      if (stopping) return;
      stopping = true;
      killGroup('SIGTERM');
      escalation = setTimeout(() => killGroup('SIGKILL'), 100);
    };
    const onAbort = () => stop();
    signal.addEventListener('abort', onAbort, { once: true });
    if (signal.aborted) stop();
    child.stdout?.on('data', (chunk: Buffer) => appendFileSync(stdoutFile, chunk));
    child.stderr?.on('data', (chunk: Buffer) => appendFileSync(stderrFile, chunk));
    child.on('error', (spawnError) => {
      error = spawnError.message;
    });
    child.on('close', (code) => {
      signal.removeEventListener('abort', onAbort);
      clearTimeout(escalation);
      if (child.pid) {
        try { process.kill(-child.pid, 'SIGKILL'); } catch { /* already gone */ }
      }
      resolvePhase({ exitCode: code, aborted: signal.aborted, error });
    });
  });
}

function cleanupSignal(): { signal: AbortSignal; done: () => void } {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 3000);
  timer.unref();
  return { signal: controller.signal, done: () => clearTimeout(timer) };
}

function phaseStatus(outcome: PhaseRun): PhaseRecord['status'] {
  if (outcome.aborted) return 'interrupted';
  if (outcome.exitCode === 0) return 'ok';
  if (outcome.exitCode === VERIFY_UNAVAILABLE_EXIT) return 'unavailable';
  return 'error';
}

async function scoreWorkspace(input: {
  name: string;
  workspace: string;
  verifyDir: string;
  pin: LoadedPin;
  signal: AbortSignal;
}): Promise<VerifyResult> {
  const evidenceDir = join(input.verifyDir, 'evidence');
  mkdirSync(evidenceDir, { recursive: true });
  writeJson(join(input.verifyDir, 'input.json'), {
    workspace: input.workspace,
    pin: input.pin.pin,
    features: input.pin.map.features.map(feature => feature.id),
  });
  const phases: PhaseRecord[] = [];
  let verdict: { score: ScoreResult; reason: string; features: FeatureEvidence[] } | null = null;

  const remember = (phase: VerifyPhase, status: PhaseRecord['status'], exitCode: number | null) => {
    phases.push({ phase, status, exit_code: exitCode });
    writeJson(join(input.verifyDir, 'phases', phase, 'status.json'), { phase, status, exit_code: exitCode });
  };

  for (const phase of VERIFY_PHASES) {
    const logDir = join(input.verifyDir, 'phases', phase);
    mkdirSync(logDir, { recursive: true });
    if (verdict && phase !== 'cleanup') {
      remember(phase, 'skipped', null);
      continue;
    }
    if (input.signal.aborted && phase !== 'cleanup') {
      verdict = { score: 'interrupted', reason: `interrupted before ${phase}`, features: [] };
      remember(phase, 'skipped', null);
      continue;
    }
    const cleanup = phase === 'cleanup' && input.signal.aborted ? cleanupSignal() : undefined;
    const outcome = await runPhase(
      input.pin.phases[phase],
      phase,
      input.workspace,
      evidenceDir,
      input.pin,
      cleanup?.signal ?? input.signal,
      logDir,
    );
    cleanup?.done();
    if (phase === 'cleanup') {
      remember(phase, phaseStatus(outcome), outcome.exitCode);
      if (outcome.aborted) verdict = { score: 'interrupted', reason: 'interrupted during cleanup', features: verdict?.features ?? [] };
      continue;
    }
    if (outcome.aborted || input.signal.aborted) {
      remember(phase, 'interrupted', outcome.exitCode);
      verdict = { score: 'interrupted', reason: `interrupted during ${phase}`, features: [] };
      continue;
    }
    if (outcome.exitCode === VERIFY_UNAVAILABLE_EXIT) {
      remember(phase, 'unavailable', outcome.exitCode);
      verdict = { score: 'unavailable', reason: `verify phase ${phase} reported unavailable`, features: [] };
      continue;
    }
    if (outcome.exitCode !== 0) {
      remember(phase, 'error', outcome.exitCode);
      const detail = outcome.error ? `: ${outcome.error}` : '';
      verdict = {
        score: 'verifier error',
        reason: `verify phase ${phase} exited ${outcome.exitCode ?? 'unknown'}${detail}`,
        features: [],
      };
      continue;
    }
    remember(phase, 'ok', 0);
    if (phase !== 'evidence') continue;
    const skillFile = join(evidenceDir, 'skill-result.json');
    if (!existsSync(skillFile)) {
      verdict = { score: 'verifier error', reason: 'skill result is missing features', features: [] };
      writeJson(join(evidenceDir, 'invalid.json'), { reason: verdict.reason });
      continue;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(skillFile, 'utf8'));
    } catch (error) {
      verdict = { score: 'verifier error', reason: `skill result is not JSON: ${(error as Error).message}`, features: [] };
      writeJson(join(evidenceDir, 'invalid.json'), { reason: verdict.reason });
      continue;
    }
    const checked = checkSkillEvidence(parsed, input.pin.map, input.workspace, evidenceDir);
    const scored = scoreFromCheckedEvidence(checked);
    if (!checked.ok) writeJson(join(evidenceDir, 'invalid.json'), { kind: checked.kind, reason: checked.reason });
    else writeJson(join(evidenceDir, 'validated.json'), scored.features);
    verdict = { score: scored.score, reason: scored.reason, features: scored.features };
  }

  if (!verdict) verdict = { score: 'verifier error', reason: 'verify finished without a score', features: [] };
  const result: VerifyResult = {
    name: input.name,
    score: verdict.score,
    score_reason: verdict.reason,
    pin: input.pin.pin,
    features: verdict.features,
    phases,
  };
  writeJson(join(input.verifyDir, 'result.json'), result);
  return result;
}

function writeSimple(verifyDir: string, result: VerifyResult): void {
  mkdirSync(verifyDir, { recursive: true });
  writeJson(join(verifyDir, 'result.json'), result);
}

function targetsFromRun(runDir: string): Target[] {
  const variantsDir = join(runDir, 'variants');
  if (!existsSync(variantsDir)) return [];
  const targets: Target[] = [];
  for (const name of readdirSync(variantsDir).sort()) {
    const dir = join(variantsDir, name);
    if (!statSync(dir).isDirectory()) continue;
    const attempts = join(dir, 'attempts');
    if (existsSync(attempts) && statSync(attempts).isDirectory()) {
      for (const attempt of readdirSync(attempts).sort()) {
        const workspace = join(attempts, attempt, 'workspace');
        if (!existsSync(workspace) || !statSync(workspace).isDirectory()) continue;
        targets.push({
          name: `${name}#${attempt}`,
          workspace,
          verifyDir: join(attempts, attempt, 'verify'),
        });
      }
      continue;
    }
    const workspace = join(dir, 'workspace');
    if (!existsSync(workspace) || !statSync(workspace).isDirectory()) continue;
    targets.push({ name, workspace, verifyDir: join(dir, 'verify') });
  }
  return targets;
}

function writeOverlap(file: string, workspace: string, repoDir: string, base: string, merge: string): void {
  const diff = gitRaw(['diff', '--name-only', '-z', '--relative', 'HEAD'], workspace);
  const untracked = gitRaw(['ls-files', '--others', '-z', '--exclude-standard'], workspace);
  const merged = gitRaw(['diff', '--name-only', '-z', '--relative', base, merge], repoDir);
  if (!diff.ok || !untracked.ok || !merged.ok) {
    writeJson(file, { status: 'unavailable', note: OVERLAP_NOTE, reason: 'could not list changed files' });
    return;
  }
  const variantFiles = uniquePaths(`${diff.stdout}\0${untracked.stdout}`);
  const mergeFiles = uniquePaths(merged.stdout);
  const overlap = variantFiles.filter(name => mergeFiles.includes(name));
  writeJson(file, {
    status: 'recorded',
    note: OVERLAP_NOTE,
    base,
    merge,
    variant_files: variantFiles,
    merge_files: mergeFiles,
    overlap,
    variant_file_count: variantFiles.length,
    merge_file_count: mergeFiles.length,
    overlap_file_count: overlap.length,
  });
}

function comparison(dir: string, kind: CardVerifyKind, pin: VerifyPin | null, results: readonly VerifyResult[], reference: { score: ScoreResult; reason: string }, code: number): void {
  mkdirSync(join(dir, 'verify'), { recursive: true });
  writeJson(join(dir, 'verify', 'comparison.json'), {
    card_verify: kind,
    pin,
    variants: results.map(result => ({ name: result.name, score: result.score })),
    reference,
    exit_code: code,
  });
}

export async function runVerify(options: VerifyOptions, signal: AbortSignal = new AbortController().signal): Promise<VerifyOutcome> {
  if (process.platform === 'win32') throw new Error('verify process cleanup requires macOS or Linux');
  const cardDir = join(options.root, 'tasks', options.taskId);
  const cardFile = join(cardDir, 'card.yaml');
  let card: TaskCard;
  try {
    card = loadTaskCard(cardDir);
  } catch (error) {
    if (error instanceof TaskCardError) throw new Error(error.message);
    throw error;
  }
  const kind = cardVerifyKind(card, readFileSync(cardFile, 'utf8'));
  let dir: string;
  let runId: string;
  let repoDir = options.repoDir ? resolve(options.repoDir) : undefined;
  if (options.runId) {
    dir = join(options.runsDir, options.runId);
    if (!existsSync(dir) || !statSync(dir).isDirectory()) throw new Error(`run not found: ${options.runId}`);
    runId = options.runId;
    const planFile = join(dir, 'run.json');
    if (existsSync(planFile)) {
      const plan = JSON.parse(readFileSync(planFile, 'utf8')) as { taskId?: string; repoDir?: string };
      if (plan.taskId && plan.taskId !== options.taskId) throw new Error(`run ${options.runId} is for task ${plan.taskId}`);
      if (!repoDir && plan.repoDir) repoDir = resolve(plan.repoDir);
    }
  } else {
    const created = createRunDir(options.runsDir);
    dir = created.dir;
    runId = created.id;
    writeJson(join(dir, 'run.json'), { run_id: runId, kind: 'verify', taskId: options.taskId });
  }

  console.log(`Run ${runId}\nRun directory: ${dir}`);
  if (kind !== 'path') {
    const reason = `card verify is ${kind}; cannot score`;
    const result: VerifyResult = { name: options.taskId, score: 'unavailable', score_reason: reason, pin: null, features: [], phases: [] };
    writeSimple(join(dir, 'verify'), result);
    comparison(dir, kind, null, [], { score: 'unavailable', reason: 'card has no verify' }, 0);
    console.log('score=unavailable\nreference: score=unavailable');
    return { runId, dir, code: 0 };
  }

  if (options.runId && options.targets.length > 0) throw new Error('verify: --run and --variant are mutually exclusive');
  const targets: Target[] = options.runId
    ? targetsFromRun(dir)
    : options.targets.map(target => ({
      name: target.name,
      workspace: resolve(target.workspace),
      verifyDir: join(dir, 'variants', target.name, 'verify'),
    }));
  if (!options.runId && targets.length === 0) {
    throw new Error('verify needs --run or --variant <name>=<workspace> when the card has a verify path');
  }
  if (targets.length === 0) throw new Error('verify found no variant workspace');
  for (const target of targets) {
    if (!existsSync(target.workspace) || !statSync(target.workspace).isDirectory()) {
      throw new Error(`workspace does not exist: ${target.workspace}`);
    }
  }

  const bundlePath = resolveBundle(options.root, options.taskId, card, options.verifyBundle);
  const inside = bundlePath ? targets.find(target => isInside(target.workspace, bundlePath)) : undefined;
  let loaded: LoadedPin | undefined;
  let pinError: string | undefined;
  if (!bundlePath) pinError = 'pinned verify not found outside the workspace';
  else if (inside) pinError = 'pinned verify must be supplied from outside the variant workspace';
  else {
    const bundle = loadPinnedBundle(bundlePath);
    if (!bundle.ok) pinError = bundle.reason;
    else {
      const snapshot = join(dir, 'verify', 'bundle');
      cpSync(bundle.pin.root, snapshot, { recursive: true });
      const frozen = loadPinnedBundle(snapshot);
      if (!frozen.ok || frozen.pin.pin.digest !== bundle.pin.pin.digest) {
        pinError = 'pinned verify snapshot does not match the source digest';
      } else {
        for (const phase of VERIFY_PHASES) chmodSync(frozen.pin.phases[phase], 0o755);
        loaded = frozen.pin;
        mkdirSync(join(dir, 'verify'), { recursive: true });
        writeJson(join(dir, 'verify', 'pin.json'), { ...bundle.pin.pin, source: bundle.pin.root });
        copyFileSync(bundle.pin.featuresMapPath, join(dir, 'verify', 'features-map.json'));
      }
    }
  }

  const sha = mergeSha(card);
  const base = typeof card.public.base_commit === 'string' ? card.public.base_commit : undefined;
  if (!loaded) {
    const reason = pinError ?? 'pinned verify could not be loaded';
    const results = targets.map(target => {
      const result: VerifyResult = { name: target.name, score: 'verifier error', score_reason: reason, pin: null, features: [], phases: [] };
      writeSimple(target.verifyDir, result);
      console.log(`${target.name}: score=verifier error`);
      return result;
    });
    const reference = {
      score: sha ? 'verifier error' as const : 'unavailable' as const,
      reason: sha ? reason : 'no merge; reference line is unavailable',
    };
    writeSimple(join(dir, 'reference', 'verify'), {
      name: 'reference',
      score: reference.score,
      score_reason: reference.reason,
      pin: null,
      features: [],
      phases: [],
    });
    const code = aggregateScoreExit(results.map(result => result.score));
    comparison(dir, kind, null, results, reference, code);
    console.log(`reference: score=${reference.score}`);
    return { runId, dir, code };
  }

  const pin = loaded;
  const results: VerifyResult[] = [];
  for (const target of targets) {
    if (signal.aborted) {
      const result: VerifyResult = {
        name: target.name,
        score: 'interrupted',
        score_reason: 'interrupted before verify',
        pin: pin.pin,
        features: [],
        phases: [],
      };
      writeSimple(target.verifyDir, result);
      results.push(result);
      console.log(`${target.name}: score=interrupted`);
      continue;
    }
    const result = await scoreWorkspace({ ...target, pin, signal });
    results.push(result);
    if (sha && repoDir && base) writeOverlap(join(target.verifyDir, 'overlap.json'), target.workspace, repoDir, base, sha);
    console.log(`${target.name}: score=${result.score}`);
  }

  const referenceDir = join(dir, 'reference', 'verify');
  let reference: { score: ScoreResult; reason: string };
  if (!sha) {
    reference = { score: 'unavailable', reason: 'no merge; reference line is unavailable' };
    writeSimple(referenceDir, { name: 'reference', score: 'unavailable', score_reason: reference.reason, pin: null, features: [], phases: [] });
  } else if (signal.aborted) {
    reference = { score: 'interrupted', reason: 'interrupted before reference verify' };
    writeSimple(referenceDir, { name: 'reference', score: 'interrupted', score_reason: reference.reason, pin: pin.pin, features: [], phases: [] });
  } else if (!repoDir) {
    reference = { score: 'unavailable', reason: 'merge commit was not checked out; reference line is unavailable' };
    writeSimple(referenceDir, { name: 'reference', score: 'unavailable', score_reason: reference.reason, pin: null, features: [], phases: [] });
  } else {
    const referenceWorkspace = join(dir, 'reference', 'workspace');
    try {
      checkoutBase(repoDir, sha, referenceWorkspace);
      if (isInside(referenceWorkspace, pin.root)) {
        reference = { score: 'verifier error', reason: 'pinned verify must be supplied from outside the variant workspace' };
        writeSimple(referenceDir, { name: 'reference', score: 'verifier error', score_reason: reference.reason, pin: pin.pin, features: [], phases: [] });
      } else {
        const result = await scoreWorkspace({
          name: 'reference',
          workspace: referenceWorkspace,
          verifyDir: referenceDir,
          pin,
          signal,
        });
        reference = { score: result.score, reason: result.score_reason };
      }
    } catch (error) {
      reference = { score: 'unavailable', reason: `merge tree is unavailable: ${(error as Error).message}` };
      writeSimple(referenceDir, { name: 'reference', score: 'unavailable', score_reason: reference.reason, pin: null, features: [], phases: [] });
    }
  }
  console.log(`reference: score=${reference.score}`);
  const code = aggregateScoreExit(results.map(result => result.score));
  comparison(dir, kind, pin.pin, results, reference, code);
  return { runId, dir, code };
}
