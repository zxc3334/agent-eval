import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { loadCase, loadExperiment, suiteCases } from './config.ts';
import { json } from './storage.ts';
import { generateReport } from './report.ts';
import { loadGold } from './oracle.ts';
import { evaluate } from './evaluation.ts';
import { requireReviewedSuite } from './review.ts';
import type { Options } from './types.ts';

export async function run(options: Options, signal: AbortSignal = new AbortController().signal): Promise<{ runId: string; code: number }> {
  if (process.platform === 'win32') throw new Error('environment: M0 process-tree cleanup requires macOS or Linux');
  const refs = suiteCases(options.casesDir, options.suite);
  requireReviewedSuite(options.casesDir, options.suite, refs);
  const all = refs.map(ref => ref.id);
  const ids = options.selectedIds ?? (options.caseId ? [options.caseId] : all);
  if (ids.some(id => !all.includes(id))) throw new Error(`case: ${ids.filter(id => !all.includes(id)).join(', ')} not in suite ${options.suite}`);
  const cases = ids.map(id => loadCase(options.casesDir, options.suite, refs.find(ref => ref.id === id)!));
  const experiment = loadExperiment(options.experimentFile);
  if (options.agent !== experiment.adapter) throw new Error(`agent: ${options.agent} does not match experiment adapter ${experiment.adapter}`);
  // Snapshot all selected reference sources before starting any execution.
  const golds = options.agent === 'oracle' ? cases.map(c => loadGold(c.file)) : [];
  const runId = `${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID()}`;
  const dir = join(options.runsDir, runId); mkdirSync(dir, { recursive: true });
  const configSource = `${options.casesDir} (current files; suite=${options.suite})`;
  json(join(dir, 'config.json'), { run_id: runId, agent: options.agent, experiment, experiment_file: options.experimentFile, suite: options.suite, cases_dir: options.casesDir, case_ids: ids, case_refs: cases.map(c => ({ id: c.config.id, version: c.config.version })), config_source: configSource, source_run_id: options.sourceRunId ?? null, fail_fast: options.failFast, cases });
  console.log(`Run ${runId}\nRun directory: ${dir}\nConfiguration source: ${configSource}\nSource run: ${options.sourceRunId ?? 'none'}`);
  let error: string | undefined;
  try {
    for (const [index, c] of cases.entries()) {
      if (signal.aborted) break;
      const result = await evaluate(c, dir, signal, golds[index]);
      console.log(`${result.status.toUpperCase()} ${result.case_id} ${result.duration_ms}ms`);
      for (const a of result.assertions.filter(a => !a.passed)) console.log(`  ${a.criterion_id} [${a.mode}]: expected=${JSON.stringify(a.expected)} actual=${JSON.stringify(a.actual)}\n  reason: ${a.reason}${a.problem ? `\n  problem: ${a.problem}` : ''}\n  artifact: ${a.artifact}`);
      if (result.reason) console.log(`  stage=${result.stage}: ${result.reason}\n  events: ${result.events}`);
      json(join(dir, 'state.json'), { interrupted: signal.aborted }); generateReport(dir);
      if (options.failFast && result.status !== 'pass') break;
    }
  } catch (e) { error = (e as Error).message; console.error(`environment_error: ${error}`); }
  json(join(dir, 'state.json'), { interrupted: signal.aborted, error });
  const summary = generateReport(dir);
  console.log(`Report: ${join(dir, 'report.md')}\nAttempted ${summary.attempted}, scored ${summary.scored}, exit ${summary.exit_code}`);
  return { runId, code: summary.exit_code };
}
