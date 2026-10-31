import { existsSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import type { Command } from '../../../packages/core/src/cli.ts';
import { identifier } from '../../../packages/core/src/config.ts';
import { findRepoRoot } from '../../../packages/core/src/task-cli.ts';
import { CURSOR_AGENT_ENTRY, CURSOR_AGENT_NAME } from './cursor-agent.ts';
import { runReplay } from './replay.ts';
import type { VariantSpec } from './replay.ts';

const REPLAY_HELP = [
  'replay — run one task from its base commit, with a skill and without',
  '',
  'Usage:',
  '  pnpm eval replay <task-id> --variant with-skill=<path> --variant without --repo-dir <dir>',
  '  pnpm eval replay <task-id> --case <without|with-skill> --variant ... --repo-dir <dir>',
  '  pnpm eval replay <task-id> --failed-from <run-id> [--case <variant>]',
  '  pnpm eval replay <task-id> --resume <run-id> [--case <variant>]',
  '  pnpm eval replay <task-id> --repeat <N> --variant ... --repo-dir <dir>',
  '',
  `Adapter: ${CURSOR_AGENT_NAME}. The entry is \`${CURSOR_AGENT_ENTRY}\` with a fixed`,
  'stream-json event contract. with-skill and without differ only by the skill',
  'installed in that variant. The model, flags, and prompt stay the same.',
  '',
  'Each variant gets its own checkout of the card base commit. The agent is given',
  'only the public AgentInput. Merge SHAs, merged diffs, and private interventions',
  'are not part of that input. History after the base commit is not in the checkout.',
  '',
  'Evidence is written to runs/<run-id>/variants/<name>/. Ctrl-C keeps that evidence.',
  '--resume continues the same run. --failed-from starts a new run for variants that',
  'did not complete. --case reruns one variant. --repeat <N> checks out a fresh',
  'workspace for each attempt.',
  '',
  'An intervention-request is the agent asking a person. An actual-intervention is',
  'a person answering. This command does not answer questions. Token usage that the',
  'agent does not report is unknown, not 0.',
  '',
  'A card without verify still replays. Score stays unavailable; scoring is not done here.',
  'Missing verify is not a failure and does not refuse the replay.',
  'Replay does not execute a verify path. Score it afterwards with `pnpm eval verify`.',
  '',
  '--agent-bin replaces the executable path only. It does not change the arguments',
  'or the event contract. --root and --runs-dir choose where cards and runs live.',
].join('\n');

class ReplayCliError extends Error {
  readonly exitCode: number;

  constructor(message: string, exitCode = 2) {
    super(message);
    this.name = 'ReplayCliError';
    this.exitCode = exitCode;
  }
}

function parseVariant(token: string): VariantSpec {
  if (token === 'without') return { name: 'without' };
  const prefix = 'with-skill=';
  if (token.startsWith(prefix)) {
    const skillPath = token.slice(prefix.length).trim();
    if (!skillPath) throw new ReplayCliError('variant: with-skill needs a path');
    return { name: 'with-skill', skillPath };
  }
  throw new ReplayCliError(`variant: expected without or with-skill=<path>, got ${JSON.stringify(token)}`);
}

function parseRepeat(value: string | undefined): number {
  if (value === undefined) return 1;
  if (!/^[1-9][0-9]*$/.test(value)) throw new ReplayCliError('repeat: expected a positive integer');
  return Number(value);
}

function directory(path: string, label: string): string {
  const resolved = resolve(path);
  if (!existsSync(resolved) || !statSync(resolved).isDirectory()) throw new ReplayCliError(`${label} does not exist: ${resolved}`);
  return resolved;
}

export const replayCommand: Command = {
  name: 'replay',
  summary: 'Replay a task from its base commit with and without a skill, using Cursor Agent.',
  run(args) {
    return runReplayCommand(args);
  },
};

async function runReplayCommand(args: readonly string[]): Promise<number> {
  const controller = new AbortController();
  const stop = () => controller.abort();
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  try {
    return await dispatch(args, controller.signal);
  } catch (error) {
    if (error instanceof ReplayCliError) {
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
        variant: { type: 'string', multiple: true },
        case: { type: 'string' },
        'failed-from': { type: 'string' },
        resume: { type: 'string' },
        repeat: { type: 'string' },
        root: { type: 'string' },
        'runs-dir': { type: 'string' },
        'repo-dir': { type: 'string' },
        'agent-bin': { type: 'string' },
      },
    });
    values = parsed.values;
    positionals = parsed.positionals;
  } catch (error) {
    throw new ReplayCliError(`replay: ${(error as Error).message}`);
  }
  if (values.help || positionals.length === 0) {
    console.log(REPLAY_HELP);
    return 0;
  }
  if (positionals.length !== 1) throw new ReplayCliError('usage: pnpm eval replay <task-id>');
  const taskId = identifier(positionals[0], 'task-id');
  if (values.resume && values['failed-from']) throw new ReplayCliError('replay: --resume and --failed-from are mutually exclusive');
  const variants = (values.variant ?? []).map(parseVariant);
  const names = new Set<string>();
  for (const variant of variants) {
    if (names.has(variant.name)) throw new ReplayCliError(`replay: duplicate variant ${variant.name}`);
    names.add(variant.name);
  }
  if (values.case && values.case !== 'without' && values.case !== 'with-skill') {
    throw new ReplayCliError('case: expected without or with-skill');
  }
  const repeat = parseRepeat(values.repeat);
  const root = directory(values.root ?? findRepoRoot(process.cwd()), 'root');
  const runsDir = directory(values['runs-dir'] ?? resolve(root, 'runs'), 'runs-dir');
  const repoDir = values['repo-dir'] ? directory(values['repo-dir'], 'repo-dir') : undefined;
  if (!values.resume && !values['failed-from'] && variants.length === 0) {
    throw new ReplayCliError('usage: pnpm eval replay <task-id> --variant with-skill=<path> --variant without --repo-dir <dir>');
  }
  if (!values.resume && !values['failed-from'] && !repoDir) {
    throw new ReplayCliError('replay needs --repo-dir pointing at a local checkout that contains the base commit');
  }
  const outcome = await runReplay({
    root,
    runsDir,
    taskId,
    repoDir,
    variants,
    repeat,
    caseName: values.case,
    resumeRunId: values.resume ? identifier(values.resume, 'resume') : undefined,
    failedFrom: values['failed-from'] ? identifier(values['failed-from'], 'failed-from') : undefined,
    agentExecutable: values['agent-bin'] ?? CURSOR_AGENT_ENTRY,
  }, signal);
  return outcome.code;
}
