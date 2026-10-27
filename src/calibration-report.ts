import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { readJson } from './config.ts';
import { json } from './storage.ts';
import type { Result } from './types.ts';

export interface ControlResult {
  index: number; expected_failed_criteria: string[]; actual_failed_criteria: string[];
  calibrated: boolean; reason: string; result: Result;
}
export interface CalibrationResult {
  case_id: string; content_hash: string | null; calibrated: boolean;
  oracle?: Result; controls: ControlResult[]; errors: string[];
}

export function generateCalibrationReport(dir: string) {
  const config = readJson(join(dir, 'config.json'));
  const results: CalibrationResult[] = config.case_ids.flatMap((id: string) => {
    const file = join(dir, 'cases', id, 'calibration.json');
    return existsSync(file) ? [readJson(file)] : [];
  });
  const state = existsSync(join(dir, 'state.json')) ? readJson(join(dir, 'state.json')) : {};
  const controls = results.flatMap(r => r.controls);
  const notAttempted: string[] = config.case_ids.filter((id: string) => !results.some(r => r.case_id === id));
  const calibrated = results.filter(r => r.calibrated).length;
  const plannedControls = config.controls_planned;
  const summary = {
    kind: 'calibration', run_id: config.run_id, suite: config.suite,
    real_agent_attempted: 0, real_agent_pass_rate: null,
    planned: config.case_ids.length, attempted: results.length, calibrated,
    solvability: { passed: results.filter(r => r.oracle?.status === 'pass').length, total: config.case_ids.length },
    detection: { rejected: controls.filter(c => c.calibrated).length, attempted: controls.length, total: plannedControls },
    not_attempted: notAttempted, interrupted: !!state.interrupted, error: state.error ?? null,
    exit_code: state.interrupted || state.error || notAttempted.length || results.some(r => r.errors.length
      || (r.oracle && !['pass', 'fail'].includes(r.oracle.status))
      || r.controls.some(c => !['pass', 'fail'].includes(c.result.status))) ? 2 : calibrated === config.case_ids.length ? 0 : 1,
  };
  json(join(dir, 'summary.json'), summary);
  const lines = [`# Calibration ${config.run_id}`, '',
    `Suite: ${config.suite}`, 'Kind: calibration; excluded from real agent pass rates (real_agent_attempted=0).', '',
    `Solvability / 可解性: ${summary.solvability.passed}/${summary.solvability.total} Oracle cases passed (hard criteria).`,
    `Detection / 检出: ${summary.detection.rejected}/${plannedControls ?? 'unknown'} controls rejected at exactly the declared hard criterion IDs; attempted ${controls.length}.`,
    `Calibrated: ${calibrated}/${config.case_ids.length}; exit code: ${summary.exit_code}`, `Interrupted: ${summary.interrupted}`, ''];
  if (state.error) lines.push(`Run error: ${state.error}`, '');
  for (const r of results) {
    lines.push(`## ${r.case_id}: ${r.calibrated ? 'calibrated' : 'calibration_failed'}`, '', `Content hash: ${r.content_hash ?? 'unavailable'}`);
    if (r.oracle) lines.push(`Oracle: ${r.oracle.status}; events: ${r.oracle.events}; verifier: ${r.oracle.verifier_result_dir ?? 'none'}${r.oracle.reason ? `; ${r.oracle.reason}` : ''}`);
    for (const c of r.controls) lines.push(`- Control ${c.index + 1}: ${c.calibrated ? 'rejected as declared' : 'calibration_failed'}; ${c.reason}; status=${c.result.status}; expected=${JSON.stringify(c.expected_failed_criteria)}; actual=${JSON.stringify(c.actual_failed_criteria)}; events: ${c.result.events}; verifier: ${c.result.verifier_result_dir ?? 'none'}`);
    for (const error of r.errors) lines.push(`Error: ${error}`);
    lines.push('');
  }
  writeFileSync(join(dir, 'report.md'), lines.join('\n'));
  return summary;
}
