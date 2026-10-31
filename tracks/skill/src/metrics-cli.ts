import { existsSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import type { Command } from '../../../packages/core/src/cli.ts';
import { identifier } from '../../../packages/core/src/config.ts';
import { findRepoRoot } from '../../../packages/core/src/task-cli.ts';
import { collectRunMetrics } from './metrics.ts';

const METRICS_HELP = [
  'metrics — collect per-variant metrics after a replay',
  '',
  'Usage:',
  '  pnpm eval metrics <task-id> --run <run-id> [--root <dir>] [--runs-dir <dir>]',
  '',
  'Writes variants/<name>/metrics.json. With --repeat, each attempt gets its own',
  'file under attempts/<n>/metrics.json. A missing verify does not refuse the',
  'file. Evidence completeness is N/A when the score is unavailable.',
  '',
  'intervention_request and actual_human_intervention are separate columns.',
  'Only an answered intervention counts as actual. An unanswered request does not.',
  'The two columns are not added together.',
  '',
  'Rework rounds close on human confirm, on a later reverify, or, when verify',
  'cannot score, on a user-driven modify round. The definition is in docs/metrics.md.',
  '',
  'Duration, token, and cost stay unknown when the stream did not report them.',
  'unknown is not 0. A measured 0 stays 0. History that was not marked stays',
  'unknown, and the comparison delta stays unknown.',
  '',
  'task show <id> --run <run-id> prints these files. It does not count the stream again.',
].join('\n');

class MetricsCliError extends Error {
  readonly exitCode: number;

  constructor(message: string, exitCode = 2) {
    super(message);
    this.name = 'MetricsCliError';
    this.exitCode = exitCode;
  }
}

function directory(path: string, label: string): string {
  const resolved = resolve(path);
  if (!existsSync(resolved) || !statSync(resolved).isDirectory()) {
    throw new MetricsCliError(`${label} does not exist: ${resolved}`);
  }
  return resolved;
}

export const metricsCommand: Command = {
  name: 'metrics',
  summary: 'Collect per-variant intervention, rework, evidence, and token metrics from a replay.',
  run(args) {
    return runMetricsCommand(args);
  },
};

function runMetricsCommand(args: readonly string[]): number {
  try {
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
          root: { type: 'string' },
          'runs-dir': { type: 'string' },
        },
      });
      values = parsed.values;
      positionals = parsed.positionals;
    } catch (error) {
      throw new MetricsCliError(`metrics: ${(error as Error).message}`);
    }
    if (values.help || positionals.length === 0) {
      console.log(METRICS_HELP);
      return 0;
    }
    if (positionals.length !== 1) throw new MetricsCliError('usage: pnpm eval metrics <task-id> --run <run-id>');
    if (!values.run) throw new MetricsCliError('usage: pnpm eval metrics <task-id> --run <run-id>');
    const taskId = identifier(positionals[0], 'task-id');
    const runId = identifier(values.run, 'run');
    const root = directory(values.root ?? findRepoRoot(process.cwd()), 'root');
    const runsDir = directory(values['runs-dir'] ?? resolve(root, 'runs'), 'runs-dir');
    const collected = collectRunMetrics({ root, runsDir, taskId, runId });
    process.stdout.write(`${collected.lines.join('\n')}\n`);
    return 0;
  } catch (error) {
    if (error instanceof MetricsCliError) {
      console.error(error.message);
      return error.exitCode;
    }
    console.error(`environment_error: ${(error as Error).message}`);
    return 2;
  }
}
