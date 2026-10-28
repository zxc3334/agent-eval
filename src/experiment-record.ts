import { identifier, readJson } from './config.ts';

/** A human-authored hypothesis and the two run IDs used to evaluate it. */
export interface ExperimentRecord {
  schema_version: 1;
  hypothesis: string;
  requirement_id: string;
  baseline_run_id: string;
  candidate_run_id: string;
  expected_changes: string[];
}

export function readExperimentRecord(file: string): ExperimentRecord {
  const raw = readJson(file);
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) || raw.schema_version !== 1) throw new Error(`${file}: experiment record schema_version must be 1`);
  if (typeof raw.hypothesis !== 'string' || !raw.hypothesis.trim()) throw new Error(`${file}: hypothesis must be nonempty`);
  identifier(raw.requirement_id, `${file}: requirement_id`);
  identifier(raw.baseline_run_id, `${file}: baseline_run_id`);
  identifier(raw.candidate_run_id, `${file}: candidate_run_id`);
  if (!Array.isArray(raw.expected_changes) || !raw.expected_changes.length || raw.expected_changes.some((item: unknown) => typeof item !== 'string' || !item.trim())) throw new Error(`${file}: expected_changes must contain nonempty strings`);
  return { schema_version: 1, hypothesis: raw.hypothesis, requirement_id: raw.requirement_id, baseline_run_id: raw.baseline_run_id, candidate_run_id: raw.candidate_run_id, expected_changes: raw.expected_changes };
}
