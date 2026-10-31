import { existsSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import type { Command } from '../../../packages/core/src/cli.ts';
import { identifier } from '../../../packages/core/src/config.ts';
import { findRepoRoot } from '../../../packages/core/src/task-cli.ts';
import { runVerify } from './verify.ts';
import type { VerifyTargetInput } from './verify.ts';

const VERIFY_HELP = [
  'verify — score replayed workspaces with a pinned verify-<app> skill',
  '',
  'Usage:',
  '  pnpm eval verify <task-id> --run <run-id> [--verify <bundle>] [--repo-dir <dir>]',
  '  pnpm eval verify <task-id> --variant <name>=<workspace> [--verify <bundle>] [--repo-dir <dir>]',
  '',
  'Replay does not score. This command runs after a replay, or on fixture workspaces.',
  'It runs Launch, Doctor, Drive, Evidence, and Cleanup from one pinned bundle.',
  'The bundle and its features-map come from outside the variant workspace.',
  'Every variant in the comparison uses that same pin.',
  '',
  'Scores are only: pass, feature fail, verifier error, unavailable, interrupted.',
  'A verifier error or unavailable is never stored as pass or feature fail.',
  'none, a missing verify, and todo cannot be scored: score=unavailable, exit 0.',
  'feature fail exits 1. verifier error exits 2. interrupted exits 3.',
  '',
  'A phase exits 75 when it cannot score. Any other non-zero phase exit is a',
  'verifier error. Hard features in the pinned map gate the verdict. Diagnostic',
  'features are evidence and do not change the score. The harness does not',
  'replace the verify skill with its own assertions.',
  '',
  'When the card has a merge SHA, the same pin is run on that tree as a',
  'reference line. File overlap with the merge is recorded and is not a score',
  'and not gold. Chat-only cards and other cards without a merge SHA record',
  'reference score=unavailable.',
  '',
  '--verify supplies the pinned bundle. Without it, the card path is resolved',
  'from the task directory or the repo root, never from a variant workspace.',
].join('\n');

class VerifyCliError extends Error {
  readonly exitCode: number;

  constructor(message: string, exitCode = 2) {
    super(message);
    this.name = 'VerifyCliError';
    this.exitCode = exitCode;
  }
}

function parseTarget(token: string): VerifyTargetInput {
  const eq = token.indexOf('=');
  if (eq <= 0 || eq === token.length - 1) {
    throw new VerifyCliError('variant: expected <name>=<workspace>');
  }
  const name = identifier(token.slice(0, eq), 'variant');
  return { name, workspace: token.slice(eq + 1) };
}

function directory(path: string, label: string): string {
  const resolved = resolve(path);
  if (!existsSync(resolved) || !statSync(resolved).isDirectory()) {
    throw new VerifyCliError(`${label} does not exist: ${resolved}`);
  }
  return resolved;
}

export const verifyCommand: Command = {
  name: 'verify',
  summary: 'Score variant workspaces with a pinned verify skill, or unavailable when the card has none.',
  run(args) {
    return runVerifyCommand(args);
  },
};

async function runVerifyCommand(args: readonly string[]): Promise<number> {
  const controller = new AbortController();
  const stop = () => controller.abort();
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  try {
    return await dispatch(args, controller.signal);
  } catch (error) {
    if (error instanceof VerifyCliError) {
      console.error(error.message);
      return error.exitCode;
    }
    console.error(`environment_error: ${(error as Error).message}`);
    return 2;
  } finally {
    process.off('SIGINT', stop);
    process.off('SIGTERM', stop);
  }
}

async function dispatch(args: readonly string[], signal: AbortSignal): Promise<number> {
  let values;
  let positionals: string[];
  try {
    const parsed = parseArgs({
      args: [...args],
      allowPositionals: true,
      strict: true,
      options: {
        help: { type: 'boolean', short: 'h', default: false },
        run: { type: 'string' },
        variant: { type: 'string', multiple: true },
        verify: { type: 'string' },
        root: { type: 'string' },
        'runs-dir': { type: 'string' },
        'repo-dir': { type: 'string' },
      },
    });
    values = parsed.values;
    positionals = parsed.positionals;
  } catch (error) {
    throw new VerifyCliError(`verify: ${(error as Error).message}`);
  }
  if (values.help || positionals.length === 0) {
    console.log(VERIFY_HELP);
    return 0;
  }
  if (positionals.length !== 1) throw new VerifyCliError('usage: pnpm eval verify <task-id>');
  const taskId = identifier(positionals[0], 'task-id');
  const targets = (values.variant ?? []).map(parseTarget);
  const names = new Set<string>();
  for (const target of targets) {
    if (names.has(target.name)) throw new VerifyCliError(`verify: duplicate variant ${target.name}`);
    names.add(target.name);
  }
  if (values.run && targets.length > 0) throw new VerifyCliError('verify: --run and --variant are mutually exclusive');
  const root = directory(values.root ?? findRepoRoot(process.cwd()), 'root');
  const runsDir = directory(values['runs-dir'] ?? resolve(root, 'runs'), 'runs-dir');
  const repoDir = values['repo-dir'] ? directory(values['repo-dir'], 'repo-dir') : undefined;
  const outcome = await runVerify({
    root,
    runsDir,
    taskId,
    runId: values.run ? identifier(values.run, 'run') : undefined,
    targets,
    verifyBundle: values.verify,
    repoDir,
  }, signal);
  return outcome.code;
}
