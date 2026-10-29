import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { caseFile, loadCase, loadExperiment, suiteCases } from './config.ts';
import { json } from './storage.ts';
import { generateReport, LOCAL_EVALUATION_NOTICE } from './report.ts';
import { loadGold } from './oracle.ts';
import { evaluate } from './evaluation.ts';
import { requireFeedbackReview, requireReviewedSuite } from './review.ts';
import { preflightJacksonBotPi } from './jackson-bot-pi.ts';
import { createManifest, compareManifest, compareSourceFiles, compareUsedImages, writeManifest } from './manifest.ts';
import { readJson } from './config.ts';
import type { Options } from './types.ts';

export async function run(options: Options, signal: AbortSignal = new AbortController().signal): Promise<{ runId: string; code: number }> {
  if (process.platform === 'win32') throw new Error('environment: M0 process-tree cleanup requires macOS or Linux');
  if (options.rerunSource) {
    const sourceDir = join(options.runsDir, options.rerunSource);
    const previous = readJson(join(sourceDir, 'manifest.json'));
    const config = readJson(join(sourceDir, 'config.json'));
    const differences = compareSourceFiles(previous, options.casesDir, options.suite, config.case_refs);
    if (differences.length) console.log(`Rerun source differences before validation:\n${differences.map(d => `  ${d}`).join('\n')}`);
  }
  const refs = suiteCases(options.casesDir, options.suite);
  requireReviewedSuite(options.casesDir, options.suite, refs);
  const all = refs.map(ref => ref.id);
  const ids = options.selectedIds ?? (options.caseId ? [options.caseId] : all);
  if (ids.some(id => !all.includes(id))) throw new Error(`case: ${ids.filter(id => !all.includes(id)).join(', ')} not in suite ${options.suite}`);
  const cases = ids.map(id => loadCase(options.casesDir, options.suite, refs.find(ref => ref.id === id)!));
  cases.forEach(requireFeedbackReview);
  const requirement_catalog = refs.map(ref => {
    try { const meta = readJson(caseFile(options.casesDir, options.suite, ref)); return { case_id: ref.id, requirement_id: typeof meta.requirement_id === 'string' ? meta.requirement_id : null }; }
    catch { return { case_id: ref.id, requirement_id: null }; }
  });
  const experiment = loadExperiment(options.experimentFile);
  if (options.traceFile) experiment.trace_file = options.traceFile;
  if (options.agent !== experiment.adapter) throw new Error(`agent: ${options.agent} does not match experiment adapter ${experiment.adapter}`);
  const manifest = createManifest(options, cases, experiment);
  if (options.rerunSource) {
    const previous = readJson(join(options.runsDir, options.rerunSource, 'manifest.json'));
    const differences = [...compareManifest(previous, manifest), ...compareUsedImages(previous, manifest.images)];
    console.log(differences.length ? `Rerun input differences:\n${differences.map(d => `  ${d}`).join('\n')}` : 'Rerun input comparison: no differences detected.');
    for (const [image, digest] of Object.entries(manifest.images)) if (digest === 'unknown') console.log(`Rerun image ${image}: digest unknown; match cannot be verified.`);
    if (manifest.product_revision === 'unknown' && options.agent === 'jackson-bot-pi') console.log('Rerun product revision unknown; match cannot be verified.');
    console.log('Model output is not guaranteed to be identical.');
  }
  if (options.agent === 'jackson-bot-pi') await preflightJacksonBotPi(experiment);
  // Snapshot all selected reference sources before starting any execution.
  const golds = options.agent === 'oracle' ? cases.map(c => loadGold(c.file)) : [];
  const runId = `${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID()}`;
  const dir = join(options.runsDir, runId); mkdirSync(dir, { recursive: true });
  const configSource = `${options.casesDir} (current files; suite=${options.suite})`;
  const repeat = options.repeat ?? 1;
  json(join(dir, 'config.json'), { run_id: runId, agent: options.agent, experiment, experiment_file: options.experimentFile, suite: options.suite, cases_dir: options.casesDir, case_ids: ids, case_refs: ids.map(id => refs.find(ref => ref.id === id)!), config_source: configSource, source_run_id: options.sourceRunId ?? null, fail_fast: options.failFast, repeat, cases, requirement_catalog });
  if (options.agent !== 'jackson-bot-pi') console.log(LOCAL_EVALUATION_NOTICE);
  console.log(options.agent === 'container' ? 'Isolation: Docker agent + fresh verifier; local scripted fixture, not a product adapter.' : 'Isolation: trusted-local; no Docker and no security sandbox.');
  console.log(`Run ${runId}\nRun directory: ${dir}\nConfiguration source: ${configSource}\nSource run: ${options.sourceRunId ?? 'none'}`);
  let error: string | undefined;
  try {
    outer: for (const [index, c] of cases.entries()) {
      for (let trial = 1; trial <= repeat; trial++) {
      if (signal.aborted) break outer;
      const result = await evaluate(c, dir, signal, golds[index], undefined, options.agent, undefined, experiment, repeat > 1 ? trial : undefined, options.skill);
      console.log(`${result.status.toUpperCase()} ${result.case_id} ${result.duration_ms}ms`);
      for (const a of result.assertions.filter(a => !a.passed)) console.log(`  ${a.criterion_id} [${a.mode}]: expected=${JSON.stringify(a.expected)} actual=${JSON.stringify(a.actual)}\n  reason: ${a.reason}${a.problem ? `\n  problem: ${a.problem}` : ''}\n  artifact: ${a.artifact}`);
      for (const error of result.handoff_errors ?? []) console.log(`  ${error}; see ${result.artifact_manifest}`);
      if (result.reason) console.log(`  stage=${result.stage}: ${result.reason}\n  events: ${result.events}`);
      json(join(dir, 'state.json'), { interrupted: signal.aborted }); generateReport(dir);
      if (options.failFast && result.status !== 'pass') break outer;
      }
    }
  } catch (e) { error = (e as Error).message; console.error(`environment_error: ${error}`); }
  json(join(dir, 'state.json'), { interrupted: signal.aborted, error });
  const summary = generateReport(dir);
  writeManifest(dir, manifest);
  generateReport(dir);
  writeManifest(dir, manifest);
  console.log(`Report: ${join(dir, 'report.md')}\nAttempted ${summary.attempted}, scored ${summary.scored}, exit ${summary.exit_code}`);
  return { runId, code: summary.exit_code };
}
