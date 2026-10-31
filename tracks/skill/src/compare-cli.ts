import { existsSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import type { Command } from '../../../packages/core/src/cli.ts';
import { identifier } from '../../../packages/core/src/config.ts';
import { findRepoRoot } from '../../../packages/core/src/task-cli.ts';
import { applyFeedback, CompareError, writeCompareReport } from './compare.ts';

const COMPARE_HELP = [
  'compare — same tasks with and without a skill',
  '',
  'Usage:',
  '  pnpm eval compare --tasks <filter> --a without --b with-skill [--root <dir>] [--runs-dir <dir>] [--out <dir>]',
  '  pnpm eval compare feedback --task <id> --run <run-id> [--attempt N] [--a without] [--b with-skill]',
  '',
  'Pairs one run by task, base, config, run id, and repeat. A missing side is',
  'shown as missing. It is not a 0 and it is not flat.',
  '',
  'Each row reports interventions, rework, duration, and input/output tokens',
  'separately. There is no single improve/regress label. Verify is compared',
  'when both sides have a score; otherwise the column is unavailable.',
  '',
  'unknown is a missing measurement. interrupted, failed, and unscored stay',
  'visible. A measured 0 can be flat only when both attempts completed.',
  '',
  'Worsening rows link to the replay run and, when it exists, verify/result.json.',
  'feedback writes a replayable task card for one worsening pair. The card id',
  'includes the source run id. Running it again is a no-op, not an error.',
  '',
  '--tasks accepts a comma-separated list. * matches every task id.',
  'Config pairing ignores the skill list. A prompt, model, or args mismatch',
  'is conflict on each numeric metric, not a win for either side.',
].join('\n');

const FEEDBACK_HELP = [
  'compare feedback — record a worsening pair as a replayable task card',
  '',
  'Usage:',
  '  pnpm eval compare feedback --task <id> --run <run-id> [--attempt N]',
  '  pnpm eval compare feedback --task <id> --run <run-id> --a without --b with-skill',
  '',
  'The new card copies the source requirement, repo, and base commit so it can',
  'be replayed. A worsened intervention or rework round is a confirmed mark.',
  'Other metrics stay unknown rather than 0. The source run id is on the card',
  'and in the task id, so task list shows it.',
  '',
  'The same task, run, and attempt again does not add a second card or a second',
  'mark. Dedupe exits 0.',
].join('\n');

function directory(path: string, label: string): string {
  const resolved = resolve(path);
  if (!existsSync(resolved) || !statSync(resolved).isDirectory()) {
    throw new CompareError(`${label} does not exist: ${resolved}`);
  }
  return resolved;
}

function positive(value: string, field: string): number {
  if (!/^[1-9][0-9]*$/.test(value)) throw new CompareError(`${field}: expected a positive integer`);
  return Number(value);
}

export const compareCommand: Command = {
  name: 'compare',
  summary: 'Compare with and without skill on the same tasks. Terminal and markdown; verify may be unavailable.',
  run(args) {
    if (args[0] === 'feedback') return runFeedback(args.slice(1));
    return runCompare(args);
  },
};

function runCompare(args: readonly string[]): number {
  try {
    let parsed;
    try {
      parsed = parseArgs({
        args: [...args],
        allowPositionals: true,
        strict: true,
        options: {
          help: { type: 'boolean', short: 'h', default: false },
          tasks: { type: 'string' },
          a: { type: 'string', default: 'without' },
          b: { type: 'string', default: 'with-skill' },
          root: { type: 'string' },
          'runs-dir': { type: 'string' },
          out: { type: 'string' },
        },
      });
    } catch (error) {
      throw new CompareError(`compare: ${(error as Error).message}`);
    }
    if (parsed.values.help || args.length === 0) {
      console.log(COMPARE_HELP);
      return 0;
    }
    if (parsed.positionals.length > 0) throw new CompareError(`compare: unexpected argument ${parsed.positionals[0]}`);
    if (!parsed.values.tasks) throw new CompareError('usage: pnpm eval compare --tasks <filter> --a without --b with-skill');
    const a = identifier(parsed.values.a, 'a');
    const b = identifier(parsed.values.b, 'b');
    if (a === b) throw new CompareError('compare: --a and --b must be different variants');
    const root = directory(parsed.values.root ?? findRepoRoot(process.cwd()), 'root');
    const runsDir = directory(parsed.values['runs-dir'] ?? resolve(root, 'runs'), 'runs-dir');
    const outDir = parsed.values.out
      ? resolve(parsed.values.out)
      : resolve(runsDir, 'comparisons', `${a}--${b}`);
    const written = writeCompareReport({ root, runsDir, tasks: parsed.values.tasks, a, b, outDir });
    process.stdout.write(written.terminal);
    return 0;
  } catch (error) {
    return fail(error);
  }
}

function runFeedback(args: readonly string[]): number {
  try {
    let parsed;
    try {
      parsed = parseArgs({
        args: [...args],
        allowPositionals: true,
        strict: true,
        options: {
          help: { type: 'boolean', short: 'h', default: false },
          task: { type: 'string' },
          run: { type: 'string' },
          attempt: { type: 'string' },
          a: { type: 'string', default: 'without' },
          b: { type: 'string', default: 'with-skill' },
          root: { type: 'string' },
          'runs-dir': { type: 'string' },
        },
      });
    } catch (error) {
      throw new CompareError(`compare feedback: ${(error as Error).message}`);
    }
    if (parsed.values.help || args.length === 0) {
      console.log(FEEDBACK_HELP);
      return 0;
    }
    if (parsed.positionals.length > 0) throw new CompareError(`compare feedback: unexpected argument ${parsed.positionals[0]}`);
    if (!parsed.values.task || !parsed.values.run) {
      throw new CompareError('usage: pnpm eval compare feedback --task <id> --run <run-id> [--attempt N]');
    }
    const taskId = identifier(parsed.values.task, 'task');
    const runId = identifier(parsed.values.run, 'run');
    const attempt = parsed.values.attempt ? positive(parsed.values.attempt, 'attempt') : 1;
    const a = identifier(parsed.values.a, 'a');
    const b = identifier(parsed.values.b, 'b');
    if (a === b) throw new CompareError('compare: --a and --b must be different variants');
    const root = directory(parsed.values.root ?? findRepoRoot(process.cwd()), 'root');
    const runsDir = directory(parsed.values['runs-dir'] ?? resolve(root, 'runs'), 'runs-dir');
    const result = applyFeedback({ root, runsDir, taskId, runId, attempt, a, b });
    const lines = [
      `feedback: ${result.status} ${result.file}`,
      `source run: ${result.runId}`,
      `id: ${result.id}`,
    ];
    if (result.status === 'unchanged') lines.push('deduped');
    process.stdout.write(`${lines.join('\n')}\n`);
    return 0;
  } catch (error) {
    return fail(error);
  }
}

function fail(error: unknown): number {
  if (error instanceof CompareError) {
    console.error(error.message);
    return error.exitCode;
  }
  const message = error instanceof Error ? error.message : String(error);
  if (message.startsWith('compare feedback:') || message.startsWith('compare:')) {
    console.error(message);
    return 2;
  }
  console.error(`environment_error: ${message}`);
  return 2;
}
