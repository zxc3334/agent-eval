import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

type CatalogEntry = { case_id: string; requirement_id?: string };
export type RequirementCoverage = { requirement_id: string; case_ids: string[]; covered: boolean; scored: boolean; uncovered_case_ids: string[]; unscored_case_ids: string[]; evidence: string[] };

/** Coverage is derived from the run snapshot and existing results, never from a new agent call. */
export function requirementCoverage(dir: string, config: any): { requirement_coverage: RequirementCoverage[]; uncovered_cases: string[] } {
  const catalog: CatalogEntry[] = Array.isArray(config.requirement_catalog) ? config.requirement_catalog : (config.cases ?? []).map((c: any) => ({ case_id: c.config?.id, requirement_id: c.config?.requirement_id }));
  const entries = new Map<string, RequirementCoverage>();
  const unmapped = new Set<string>();
  for (const entry of catalog) {
    if (!entry.case_id) continue;
    if (!entry.requirement_id) { unmapped.add(entry.case_id); continue; }
    let item = entries.get(entry.requirement_id);
    if (!item) { item = { requirement_id: entry.requirement_id, case_ids: [], covered: false, scored: false, uncovered_case_ids: [], unscored_case_ids: [], evidence: [] }; entries.set(entry.requirement_id, item); }
    item.case_ids.push(entry.case_id);
    let attempted = false; let scored = false;
    if (config.case_ids.includes(entry.case_id)) for (let trial = 1; trial <= (config.repeat ?? 1); trial++) {
      const path = (config.repeat ?? 1) === 1 ? `cases/${entry.case_id}/result.json` : `cases/${entry.case_id}/trials/${trial}/result.json`;
      if (!existsSync(join(dir, path))) continue;
      attempted = true; item.covered = true; item.evidence.push(path);
      try { const result = JSON.parse(readFileSync(join(dir, path), 'utf8')); if (result.case_id === entry.case_id && Array.isArray(result.assertions) && (result.status === 'pass' || result.status === 'fail')) { scored = true; item.scored = true; } } catch { /* malformed evidence is not scored */ }
    }
    if (!attempted) item.uncovered_case_ids.push(entry.case_id);
    if (!scored) item.unscored_case_ids.push(entry.case_id);
  }
  for (const id of config.case_ids) if (!catalog.some(c => c.case_id === id && c.requirement_id)) unmapped.add(id);
  return { requirement_coverage: [...entries.values()], uncovered_cases: [...unmapped] };
}
export function localLink(path: string, label: string): string { return `[${label}](${path.split('/').map(encodeURIComponent).join('/')})`; }
