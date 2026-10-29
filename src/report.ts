import { existsSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { readJson } from './config.ts';
import { json } from './storage.ts';
import { compareUsedImages } from './manifest.ts';
import type { Result, Status } from './types.ts';

export const LOCAL_EVALUATION_NOTICE = '只验证评测链路（仅验评测链路），不代表产品/模型质量；未运行真实 jackson-bot adapter 或外网模型。';

export function generateReport(dir: string) {
  const config = readJson(join(dir, 'config.json'));
  const repeat: number = config.repeat ?? 1;
  type ReportResult = Result & { trial?: number; steps_used?: number; stop_reason?: string; usage?: { input_tokens?: number | null; output_tokens?: number | null; cost?: number | null } };
  const attempts: { id: string; trial: number; result?: ReportResult }[] = config.case_ids.flatMap((id: string) =>
    Array.from({ length: repeat }, (_, index) => {
      const trial = index + 1;
      const file = repeat === 1 ? join(dir, 'cases', id, 'result.json') : join(dir, 'cases', id, 'trials', String(trial), 'result.json');
      return { id, trial, result: existsSync(file) ? readJson(file) as ReportResult : undefined };
    }));
  const results = attempts.flatMap(a => a.result ? [a.result] : []);
  const state = existsSync(join(dir, 'state.json')) ? readJson(join(dir, 'state.json')) : {};
  const counts: Record<Status, number> = { pass: 0, fail: 0, agent_error: 0, timeout: 0, verifier_error: 0, environment_error: 0 };
  for (const r of results) counts[r.status]++;
  const attempted = results.length; const scored = counts.pass + counts.fail;
  const realResults = config.agent === 'jackson-bot-pi' ? results.filter(r => r.agent_started) : [];
  const scopeNote = config.agent === 'jackson-bot-pi'
    ? '配置为 jackson-bot-pi 的本地评测；产品入口和断言结果需结合配置、trace 与 verifier 证据审阅。'
    : LOCAL_EVALUATION_NOTICE;
  const notAttempted: string[] = config.case_ids.filter((id: string) => !results.some(r => r.case_id === id));
  const caseCounts = config.case_ids.map((id: string) => ({ case_id: id, passed: results.filter(r => r.case_id === id && r.status === 'pass').length, attempted: results.filter(r => r.case_id === id).length, planned: repeat }));
  const missingAttempts = attempts.filter(a => !a.result).map(a => ({ case_id: a.id, trial: a.trial }));
  const code = state.interrupted || state.error || attempted > scored ? 2 : counts.fail ? 1 : 0;
  const summary = {
    run_id: config.run_id, agent: config.agent, source_run_id: config.source_run_id ?? null,
    evaluation_scope: config.agent === 'jackson-bot-pi' ? 'product_adapter' : 'pipeline_only', scope_note: scopeNote,
    real_agent_attempted: realResults.length, real_agent_pass_rate: realResults.length ? realResults.filter(r => r.status === 'pass').length / realResults.length : null,
    config_source: config.config_source, attempted, scored, planned: config.case_ids.length * repeat, repeat, case_counts: caseCounts, not_attempted_trials: missingAttempts,
    pass_rate: attempted ? counts.pass / attempted : null,
    scoring_coverage: attempted ? scored / attempted : null,
    counts, not_attempted: notAttempted, interrupted: !!state.interrupted, error: state.error ?? null, exit_code: code,
  };
  json(join(dir, 'summary.json'), summary);
  const pct = (v: number | null) => v === null ? 'N/A' : `${(v * 100).toFixed(1)}%`;
  const agentDescription = config.agent === 'jackson-bot-pi' ? 'jackson-bot product adapter' : `${config.agent === 'oracle' ? 'local reference solution' : config.agent === 'container' ? 'local scripted container fixture' : 'local stub'}; not jackson-bot`;
  const quote = (value: string) => `'${value.replace(/'/g, `'"'"'`)}'`;
  const rerun = `pnpm eval --rerun ${quote(config.run_id)} --runs-dir ${quote(dirname(resolve(dir)))}`;
  const lines = [`# Run ${config.run_id}`, '', `> ${scopeNote}`, '', `Agent: ${config.agent} (${agentDescription})`, `Configuration: ${config.config_source}`, `Source run: ${config.source_run_id ?? 'none'}`, '',
    `Attempted: ${attempted}/${summary.planned}; scored: ${scored}`, `All-attempt pass rate: ${pct(summary.pass_rate)} (pass / attempted)`, `Scoring coverage: ${pct(summary.scoring_coverage)} ((pass + fail) / attempted)`,
    `Counts: ${JSON.stringify(counts)}`, `Not attempted: ${notAttempted.join(', ') || 'none'}`, `Interrupted: ${summary.interrupted}; exit code: ${code}`, ''];
  lines.push(`Configuration snapshot: ${join(resolve(dir), 'config.json')}`, `Manifest: ${join(resolve(dir), 'manifest.json')}`, `Rerun: ${rerun}`, 'Model output is not guaranteed to be identical on rerun.', '', '## Per-case pass counts', '');
  if (existsSync(join(dir, 'manifest.json'))) {
    const warnings = compareUsedImages(readJson(join(dir, 'manifest.json')));
    if (warnings.length) lines.push(...warnings.map(warning => `Image mismatch: ${warning}`), '');
  }
  for (const c of caseCounts) lines.push(`- ${c.case_id}: ${c.passed}/${c.planned} passed (${c.attempted} attempted)`);
  lines.push('');
  if (state.error) lines.push(`Run error: ${state.error}`, '');
  for (const attempt of attempts) {
    const r = attempt.result;
    if (!r) { lines.push(`## ${attempt.id} trial ${attempt.trial}: not attempted`, ''); continue; }
    const value = (n: number | null | undefined) => n === null || n === undefined ? 'unknown' : String(n);
    lines.push(`## ${r.case_id} trial ${attempt.trial}: ${r.status} (${value(r.duration_ms)}ms)`, '', `Events: ${r.events}`, '', `Input tokens: ${value(r.usage?.input_tokens)}; output tokens: ${value(r.usage?.output_tokens)}; cost: ${value(r.usage?.cost)}`, `Steps used: ${value(r.steps_used)}; stop reason: ${r.stop_reason ?? 'unknown'}`, '');
    if (r.reason) lines.push(`Stage: ${r.stage}; reason: ${r.reason}`, '');
    lines.push(`Isolation: ${r.isolation ?? 'trusted-local'}${r.isolation === 'docker' ? '' : ' (no security sandbox)'}; session: ${r.session_id ?? 'legacy'}`, '');
    if (r.artifact_manifest) lines.push(`Artifact manifest: ${r.artifact_manifest}`, '');
    for (const error of r.handoff_errors ?? []) lines.push(`Handoff diagnostic: ${error}`, '');
    if (r.verifier_result_dir) lines.push(`Verifier result: ${r.verifier_result_dir}`, '');
    for (const a of r.assertions) lines.push(`- ${a.criterion_id} [${a.mode ?? 'hard'}]: ${a.passed ? 'pass' : 'fail'}; expected=${JSON.stringify(a.expected)}; actual=${JSON.stringify(a.actual)}; artifact: ${a.artifact}${a.reason ? `; reason: ${a.reason}; target=${JSON.stringify(a.target)}; params=${JSON.stringify(a.params)}; evidence=${JSON.stringify(a.evidence)}${a.problem ? `; problem: ${a.problem}` : ''}` : ''}`);
    lines.push('');
  }
  writeFileSync(join(dir, 'report.md'), lines.join('\n'));
  return summary;
}
