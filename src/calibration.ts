import { mkdirSync, readFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, sep } from 'node:path';
import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { caseFile, loadCase, suiteCases } from './config.ts';
import { loadGold } from './oracle.ts';
import { evaluate } from './evaluation.ts';
import { normalizeCriteria } from './criteria.ts';
import { contentHash, RECEIPT } from './review.ts';
import { json } from './storage.ts';
import { generateCalibrationReport } from './calibration-report.ts';
import type { CalibrationResult } from './calibration-report.ts';

export async function validateSuite(casesDir: string, suite: string, runsDir: string, signal = new AbortController().signal) {
  const output = relative(casesDir, runsDir);
  if (output === '' || (!isAbsolute(output) && output !== '..' && !output.startsWith(`..${sep}`))) throw new Error('runs-dir: calibration output must be outside the cases directory');
  const refs = suiteCases(casesDir, suite);
  const runId = `${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID()}`;
  const dir = join(runsDir, runId); mkdirSync(dir, { recursive: true });
  // Revoke all old receipts before loading or executing calibration inputs.
  // A malformed case or interrupted calibration must never retain prior success.
  for (const ref of refs) {
    const file = caseFile(casesDir, suite, ref);
    json(join(dirname(file), RECEIPT), { schema_version: 1, status: 'pending', run_id: runId });
  }
  // Snapshot the complete suite before running any reference solution/control.
  const snapshots = refs.map(ref => {
    try {
      const file = caseFile(casesDir, suite, ref);
      const hash = contentHash(file);
      const c = loadCase(casesDir, suite, ref); const gold = loadGold(c.file);
      if (c.config.source_evidence && /TODO/i.test(JSON.stringify({ gold: c.acceptance.gold, criteria: c.acceptance.criteria, controls: c.acceptance.error_examples }) + readFileSync(join(dirname(c.file), 'gold.md'), 'utf8') + readFileSync(join(dirname(c.file), 'solve.ts'), 'utf8'))) {
        throw new Error('feedback case: replace TODO placeholders in Gold, criteria and error controls before calibration');
      }
      const criteria = normalizeCriteria(c.acceptance.criteria, c.file);
      for (const [index, example] of c.acceptance.error_examples.entries()) {
        if (example.expected_failed_criteria?.some(id => !criteria.some(c => c.id === id && c.mode === 'hard'))) {
          throw new Error(`${c.file}: error_examples[${index}].expected_failed_criteria: unknown or diagnostic criterion; fix: declare hard criterion IDs from the current acceptance`);
        }
      }
      if (hash !== contentHash(file)) throw new Error('case changed while loading; retry calibration');
      return { ref, c, gold, hash };
    } catch (error) { return { ref, error: (error as Error).message }; }
  });
  json(join(dir, 'config.json'), { kind: 'calibration', run_id: runId, suite, cases_dir: casesDir,
    case_ids: refs.map(r => r.id), controls_planned: snapshots.every(s => s.c) ? snapshots.reduce((sum, s) => sum + s.c!.acceptance.error_examples.length, 0) : null });
  console.log(`Calibration ${runId}\nCalibration directory: ${dir}`);
  let error: string | undefined;
  try {
    for (const s of snapshots) {
      if (signal.aborted) break;
      const result: CalibrationResult = { case_id: s.ref.id, content_hash: s.hash ?? null, calibrated: false, controls: [], errors: [] };
      const caseDir = join(dir, 'cases', s.ref.id); mkdirSync(caseDir, { recursive: true });
      if (!s.c || !s.gold) result.errors.push(s.error ?? 'could not load calibration inputs');
      else {
        const c = s.c;
        result.oracle = await evaluate(c, join(caseDir, 'oracle'), signal, s.gold);
        console.log(`Oracle ${c.config.id}: ${result.oracle.status}`);
        if (!c.acceptance.error_examples.length) result.errors.push('error_examples: at least one declared control is required');
        for (const [index, example] of c.acceptance.error_examples.entries()) {
          if (signal.aborted) break;
          const actual = await evaluate(c, join(caseDir, 'controls', String(index + 1)), signal, undefined, example);
          const expected = [...(example.expected_failed_criteria ?? [])].sort();
          const failed = actual.assertions.filter(a => a.mode === 'hard' && !a.passed).map(a => a.criterion_id).sort();
          const calibrated = expected.length > 0 && actual.status === 'fail' && isDeepStrictEqual(expected, failed);
          const reason = !expected.length ? 'missing expected_failed_criteria declaration'
            : actual.status === 'pass' ? 'unexpected pass'
            : actual.status !== 'fail' ? `execution error: ${actual.status}: ${actual.reason}`
            : !calibrated ? 'failure criterion IDs do not match declaration' : example.reason;
          if (!expected.length) result.errors.push(`error_examples[${index}]: ${reason}`);
          result.controls.push({ index, expected_failed_criteria: expected, actual_failed_criteria: failed, calibrated, reason, result: actual });
          console.log(`Control ${c.config.id}/${index + 1}: ${calibrated ? 'rejected as declared' : `calibration_failed: ${reason}`}`);
        }
        try { if (s.hash !== contentHash(c.file)) result.errors.push('content changed during calibration; rerun required'); }
        catch (e) { result.errors.push(`content changed during calibration: ${(e as Error).message}`); }
        result.calibrated = !signal.aborted && !result.errors.length && result.oracle.status === 'pass'
          && result.controls.length === c.acceptance.error_examples.length && result.controls.every(r => r.calibrated);
        json(join(dirname(c.file), RECEIPT), { schema_version: 1, status: result.calibrated ? 'passed' : 'failed',
          content_hash: s.hash, oracle_passed: result.oracle.status === 'pass',
          controls_rejected: result.controls.filter(r => r.calibrated).length, run_id: runId,
          evidence: join(caseDir, 'calibration.json'), calibrated_at: new Date().toISOString() });
      }
      for (const message of result.errors) console.error(`calibration_error: ${result.case_id}: ${message}`);
      json(join(caseDir, 'calibration.json'), result);
      json(join(dir, 'state.json'), { interrupted: signal.aborted });
      generateCalibrationReport(dir);
    }
  } catch (e) { error = (e as Error).message; console.error(`calibration_error: ${error}`); }
  json(join(dir, 'state.json'), { interrupted: signal.aborted, error });
  const summary = generateCalibrationReport(dir);
  console.log(`Solvability: ${summary.solvability.passed}/${summary.solvability.total}; detection: ${summary.detection.rejected}/${summary.detection.total ?? 'unknown'}\nReport: ${join(dir, 'report.md')}\nCalibration exit ${summary.exit_code}; excluded from real agent pass rates.`);
  return { runId, code: summary.exit_code };
}
