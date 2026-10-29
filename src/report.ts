import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { readJson } from './config.ts';
import { json } from './storage.ts';
import type { Result, Status } from './types.ts';

export function generateReport(dir: string) {
  const config = readJson(join(dir, 'config.json'));
  const results: Result[] = config.case_ids.flatMap((id: string) => {
    const file = join(dir, 'cases', id, 'result.json');
    return existsSync(file) ? [readJson(file)] : [];
  });
  const state = existsSync(join(dir, 'state.json')) ? readJson(join(dir, 'state.json')) : {};
  const counts: Record<Status, number> = { pass: 0, fail: 0, agent_error: 0, timeout: 0, verifier_error: 0, environment_error: 0 };
  for (const r of results) counts[r.status]++;
  const attempted = results.length; const scored = counts.pass + counts.fail;
  const notAttempted: string[] = config.case_ids.filter((id: string) => !results.some(r => r.case_id === id));
  const code = state.interrupted || state.error || attempted > scored ? 2 : counts.fail ? 1 : 0;
  const summary = {
    run_id: config.run_id, agent: config.agent, source_run_id: config.source_run_id ?? null,
    config_source: config.config_source, attempted, scored, planned: config.case_ids.length,
    pass_rate: attempted ? counts.pass / attempted : null,
    scoring_coverage: attempted ? scored / attempted : null,
    counts, not_attempted: notAttempted, interrupted: !!state.interrupted, error: state.error ?? null, exit_code: code,
  };
  json(join(dir, 'summary.json'), summary);
  const pct = (v: number | null) => v === null ? 'N/A' : `${(v * 100).toFixed(1)}%`;
  const lines = [`# Run ${config.run_id}`, '', `Agent: ${config.agent} (local stub; not jackson-bot)`, `Configuration: ${config.config_source}`, `Source run: ${config.source_run_id ?? 'none'}`, '',
    `Attempted: ${attempted}/${config.case_ids.length}; scored: ${scored}`, `All-attempt pass rate: ${pct(summary.pass_rate)} (pass / attempted)`, `Scoring coverage: ${pct(summary.scoring_coverage)} ((pass + fail) / attempted)`,
    `Counts: ${JSON.stringify(counts)}`, `Not attempted: ${notAttempted.join(', ') || 'none'}`, `Interrupted: ${summary.interrupted}; exit code: ${code}`, ''];
  if (state.error) lines.push(`Run error: ${state.error}`, '');
  for (const r of results) {
    lines.push(`## ${r.case_id}: ${r.status} (${r.duration_ms}ms)`, '', `Events: ${r.events}`, '');
    if (r.reason) lines.push(`Stage: ${r.stage}; reason: ${r.reason}`, '');
    if (r.verifier_result_dir) lines.push(`Verifier result: ${r.verifier_result_dir}`, '');
    for (const a of r.assertions) lines.push(`- ${a.criterion_id} [${a.mode ?? 'hard'}]: ${a.passed ? 'pass' : 'fail'}; expected=${JSON.stringify(a.expected)}; actual=${JSON.stringify(a.actual)}; artifact: ${a.artifact}${a.reason ? `; reason: ${a.reason}; target=${JSON.stringify(a.target)}; params=${JSON.stringify(a.params)}; evidence=${JSON.stringify(a.evidence)}` : ''}`);
    lines.push('');
  }
  writeFileSync(join(dir, 'report.md'), lines.join('\n'));
  return summary;
}
