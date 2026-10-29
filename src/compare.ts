import { cpSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { identifier, readJson } from './config.ts';
import { json } from './storage.ts';
import { localLink, requirementCoverage, type RequirementCoverage } from './coverage.ts';
import { readExperimentRecord, type ExperimentRecord } from './experiment-record.ts';

type Classification = 'improve' | 'regress' | 'flat' | 'error-change';
type Difference = { path: string; baseline: unknown; candidate: unknown; declared: boolean; derived?: boolean };
type Attempt = { trial: number; status: string; assertions: unknown[]; result: string | null; events: string | null; artifacts: string | null };
type CaseComparison = { case_id: string; classification: Classification; baseline: Attempt[]; candidate: Attempt[] };
export interface CompareReport {
  baseline_run: string; candidate_run: string; output_dir: string; variables: string[];
  compatible: boolean; reasons: string[]; differences: Difference[]; cases: CaseComparison[];
  counts: Record<Classification, number>; conclusion: string | null; scope: string; run_faults: string[];
  requirement_coverage: RequirementCoverage[]; uncovered_cases: string[]; experiment: ExperimentRecord | null; experiment_conclusion: string | null; experiment_evidence: string[];
}

const allowed = ['model', 'prompt', 'product_revision'];
function declaredPath(path: string, variables: string[]): boolean {
  if (variables.includes('model') && ['model', 'effective_config.experiment.model', 'config.experiment.model', 'experiment_source.model'].includes(path)) return true;
  if (variables.includes('prompt') && ['effective_config.experiment.product.prompt', 'config.experiment.product.prompt', 'experiment_source.product.prompt'].includes(path)) return true;
  return variables.includes('product_revision') && ['product_revision', 'effective_config.experiment.product.revision', 'config.experiment.product.revision', 'experiment_source.product.revision'].includes(path);
}
function diffs(path: string, a: unknown, b: unknown, variables: string[], out: Difference[]): void {
  if (JSON.stringify(a) === JSON.stringify(b)) return;
  if (a && b && typeof a === 'object' && typeof b === 'object' && !Array.isArray(a) && !Array.isArray(b)) {
    const left = a as Record<string, unknown>; const right = b as Record<string, unknown>;
    for (const key of [...new Set([...Object.keys(left), ...Object.keys(right)])].sort()) diffs(path ? `${path}.${key}` : key, left[key], right[key], variables, out);
  } else out.push({ path, baseline: a ?? null, candidate: b ?? null, declared: declaredPath(path, variables), ...(path === 'experiment_sha256' ? { derived: true } : {}) });
}
function readAttempt(dir: string, caseId: string, trial: number, repeat: number): Attempt {
  const trialDir = repeat === 1 ? join(dir, 'cases', caseId) : join(dir, 'cases', caseId, 'trials', String(trial));
  const file = join(trialDir, 'result.json');
  const events = join(trialDir, 'events.jsonl'); const artifacts = join(trialDir, 'artifacts');
  if (!existsSync(file)) return { trial, status: 'not_attempted', assertions: [], result: null, events: existsSync(events) ? events : null, artifacts: existsSync(artifacts) ? artifacts : null };
  try {
    const r = readJson(file);
    const valid = r.case_id === caseId && ['pass', 'fail', 'agent_error', 'timeout', 'verifier_error', 'environment_error'].includes(r.status) && Array.isArray(r.assertions);
    return { trial, status: valid ? r.status : 'invalid_result', assertions: valid ? r.assertions : [], result: file, events: existsSync(events) ? events : null, artifacts: existsSync(artifacts) ? artifacts : null };
  } catch { return { trial, status: 'invalid_result', assertions: [], result: file, events: existsSync(events) ? events : null, artifacts: existsSync(artifacts) ? artifacts : null }; }
}
function link(path: string | null, label: string): string {
  if (!path) return `${label}: unavailable`;
  const target = path.split('/').map(encodeURIComponent).join('/');
  return `[${label}](${target})`;
}
function markdown(report: CompareReport): string {
  const lines = [`# Compare ${report.baseline_run} → ${report.candidate_run}`, '', `Compatible: ${report.compatible ? 'yes' : 'no'}`, `Scope: ${report.scope}`, `Declared variables: ${report.variables.join(', ') || 'none'}`, `Conclusion: ${report.conclusion ?? 'unavailable'}`, '', '## Compatibility reasons', '', ...(report.reasons.length ? report.reasons.map(reason => `- ${reason}`) : ['- none']), '', '## Configuration differences', ''];
  if (report.run_faults.length) lines.splice(lines.indexOf('## Configuration differences'), 0, '## Run faults', '', ...report.run_faults.map(fault => `- ${fault}`), '');
  lines.push(...(report.differences.length ? report.differences.map(d => `- ${d.path} (${d.derived ? 'derived' : d.declared ? 'declared variable' : 'undeclared'}): ${JSON.stringify(d.baseline)} → ${JSON.stringify(d.candidate)}`) : ['- none']), '', '## Requirement coverage', '');
  for (const c of report.requirement_coverage ?? []) lines.push(`- ${c.requirement_id}: ${c.covered ? (c.scored ? 'covered and scored' : 'attempted, not scored') : 'uncovered'}; cases: ${c.case_ids.join(', ')}; not attempted: ${c.uncovered_case_ids.join(', ') || 'none'}; not scored: ${c.unscored_case_ids.join(', ') || 'none'}; ${c.evidence.map(p => localLink(p, 'result')).join(', ') || 'no evidence'}`);
  if (!report.requirement_coverage?.length) lines.push('- No requirement mappings recorded.');
  lines.push(`Unmapped cases: ${(report.uncovered_cases ?? []).join(', ') || 'none'}`, '', '## Experiment', '');
  if (report.experiment) lines.push(`Hypothesis: ${report.experiment.hypothesis}`, `Requirement: ${report.experiment.requirement_id}`, `Expected changes: ${report.experiment.expected_changes.join('; ')}`, `Conclusion: ${report.experiment_conclusion ?? 'unavailable'}`, `Record: ${localLink('experiment.json', 'experiment.json')}`, `Evidence: ${report.experiment_evidence.map(p => localLink(p, 'result')).join(', ') || 'none'}`, '');
  else lines.push('No experiment record supplied.', '');
  lines.push('## Cases', '');
  for (const c of report.cases) {
    lines.push(`### ${c.case_id}: ${c.classification}`, '');
    for (const [side, attempts] of [['baseline', c.baseline], ['candidate', c.candidate]] as const) {
      for (const a of attempts) {
        lines.push(`- ${side} trial ${a.trial}: ${a.status}; ${link(a.result, 'assertions / result')}; ${link(a.events, 'trace / events')}; ${link(a.artifacts, 'artifacts')}`);
      }
    }
    lines.push('');
  }
  return lines.join('\n');
}

export function compareRuns(runsDir: string, baselineId: string, candidateId: string, variables: string[] = [], experimentFile?: string): CompareReport {
  identifier(baselineId, 'baseline run'); identifier(candidateId, 'candidate run');
  if (variables.some(v => !allowed.includes(v)) || new Set(variables).size !== variables.length) throw new Error(`vary: expected unique values from ${allowed.join(', ')}`);
  const experiment = experimentFile ? readExperimentRecord(experimentFile) : null;
  if (experiment && (experiment.baseline_run_id !== baselineId || experiment.candidate_run_id !== candidateId)) throw new Error('experiment record run IDs do not match comparison');
  const root = resolve(runsDir); const dirs = [join(root, baselineId), join(root, candidateId)];
  const configs = dirs.map(dir => readJson(join(dir, 'config.json')));
  const reasons: string[] = []; const differences: Difference[] = []; const run_faults: string[] = [];
  const manifests = dirs.map((dir, i) => {
    try { return readJson(join(dir, 'manifest.json')); }
    catch { reasons.push(`${i ? 'candidate' : 'baseline'} manifest unavailable or invalid`); return null; }
  });
  for (let i = 0; i < 2; i++) {
    const c = configs[i], m = manifests[i], side = i ? 'candidate' : 'baseline';
    if (!Array.isArray(c.case_ids) || c.case_ids.some((id: unknown) => typeof id !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(id)) || !Number.isSafeInteger(c.repeat ?? 1) || (c.repeat ?? 1) < 1) throw new Error(`${side} config: invalid case_ids or repeat`);
    if (c.run_id !== (i ? candidateId : baselineId)) reasons.push(`${side} config run_id does not match requested run`);
    const stateFile = join(dirs[i], 'state.json');
    if (existsSync(stateFile)) {
      try { const state = readJson(stateFile); if (state.interrupted || state.error) run_faults.push(`${side} run ${state.interrupted ? 'interrupted' : 'failed'}${state.error ? `: ${state.error}` : ''}`); }
      catch { run_faults.push(`${side} run state is unreadable`); }
    }
    if (!m) continue;
    const present = (x: unknown) => typeof x === 'string' && x.length > 0 && x !== 'unknown';
    const validFiles = (files: unknown) => !!files && typeof files === 'object' && !Array.isArray(files) && Object.keys(files).length > 0 && Object.values(files).every(present);
    // Legacy suite manifests can lack a declared version, but their content hash is mandatory.
    if (m.schema_version !== 1 || !present(m.suite?.name) || !present(m.suite?.sha256) || !Number.isInteger(m.suite?.schema_version)
      || !Array.isArray(m.cases) || !m.cases.length || m.cases.some((v: any) => !present(v.id) || !present(v.version) || !validFiles(v.files) || !present(v.files?.['case.json']))
      || !present(m.verifier?.version) || !present(m.verifier?.sha256) || !present(m.adapter?.name) || !present(m.adapter?.version) || !present(m.adapter?.sha256)
      || !present(m.harness?.version) || !present(m.harness?.sha256) || !present(m.experiment_sha256) || !m.effective_config
      || !['os', 'release', 'arch', 'node'].every(key => present(m.platform?.[key])) || !m.images || typeof m.images !== 'object') reasons.push(`${side} manifest missing required identity or content hashes`);
    if (m.effective_config) {
      for (const [key, value] of Object.entries({ suite: c.suite, case_ids: c.case_ids, repeat: c.repeat ?? 1, fail_fast: c.fail_fast, experiment: c.experiment })) {
        if (JSON.stringify(value) !== JSON.stringify(m.effective_config[key])) reasons.push(`${side} config and manifest disagree on ${key}`);
      }
      if (c.agent !== m.adapter?.name || c.agent !== c.experiment?.adapter) reasons.push(`${side} adapter identity is inconsistent`);
      if (JSON.stringify(c.case_ids) !== JSON.stringify(m.cases?.map((v: { id: string }) => v.id))) reasons.push(`${side} case identities disagree with manifest`);
    }
    if (c.agent === 'jackson-bot-pi' && (!m.product_revision || m.product_revision === 'unknown' || !m.model || m.model === 'unknown')) reasons.push(`${side} product revision or model is unknown; identity cannot be verified`);
    for (const [image, digest] of Object.entries(m.images ?? {})) if (!digest || digest === 'unknown') reasons.push(`${side} image ${image} digest unknown`);
    for (const [path, digest] of Object.entries(m.images_used ?? {})) {
      const id = /^cases\/([^/]+)\//.exec(path)?.[1];
      const image = m.cases?.find((v: { id: string }) => v.id === id)?.image;
      if (!image || !digest || m.images?.[image] !== digest) reasons.push(`${side} ${path}: image used does not match recorded image digest`);
    }
    for (const path of Object.keys(m.artifacts ?? {})) {
      if (path.startsWith('cases/') && path.endsWith('/container.json') && !m.images_used?.[path]) reasons.push(`${side} ${path}: actual image digest was not recorded`);
    }
  }
  if (manifests[0] && manifests[1]) {
    const clean = (m: any) => { const { artifacts: _artifacts, images_used: _images, ...inputs } = m; return inputs; };
    diffs('', clean(manifests[0]), clean(manifests[1]), variables, differences);
  }
  for (const key of ['agent', 'suite', 'case_ids', 'repeat', 'fail_fast', 'experiment']) diffs(`config.${key}`, configs[0][key], configs[1][key], variables, differences);
  for (const d of differences) if (!d.declared && !d.derived) reasons.push(`${d.path}: ${JSON.stringify(d.baseline)} → ${JSON.stringify(d.candidate)} (undeclared difference)`);
  // The experiment file digest is derived from the configuration; if the content changed
  // without any declared experiment field changing, the difference is unexplained.
  if (differences.some(d => d.path === 'experiment_sha256') && (manifests[0]?.experiment_extra_fields === undefined || manifests[1]?.experiment_extra_fields === undefined)) reasons.push('experiment file changed but its extra-field snapshot is unavailable; declared changes cannot be verified');
  const ids: string[] = [...new Set<string>([...configs[0].case_ids, ...configs[1].case_ids])];
  const cases: CaseComparison[] = ids.map(caseId => {
    const sides = configs.map((c, i) => Array.from({ length: c.repeat ?? 1 }, (_, n) => readAttempt(dirs[i], caseId, n + 1, c.repeat ?? 1)));
    const [baseline, candidate] = sides;
    const hasFault = [...baseline, ...candidate].some(a => !['pass', 'fail'].includes(a.status));
    const delta = candidate.filter(a => a.status === 'pass').length - baseline.filter(a => a.status === 'pass').length;
    const classification: Classification = hasFault ? 'error-change' : delta > 0 ? 'improve' : delta < 0 ? 'regress' : 'flat';
    return { case_id: caseId, classification, baseline, candidate };
  });
  const counts: Record<Classification, number> = { improve: 0, regress: 0, flat: 0, 'error-change': 0 };
  cases.forEach(c => counts[c.classification]++);
  const compatible = !reasons.length; const scope = configs[0].agent === 'jackson-bot-pi' && configs[1].agent === 'jackson-bot-pi' ? 'product adapter' : 'local evaluation pipeline only; not product ability';
  const conclusion = compatible && !counts['error-change'] && !run_faults.length ? `${scope}: ${counts.improve} improved, ${counts.regress} regressed, ${counts.flat} flat cases (pass counts across repeated trials)` : null;
  const output_dir = join(root, 'comparisons', `${baselineId}--${candidateId}`);
  mkdirSync(output_dir, { recursive: true });
  const evidenceDir = join(output_dir, 'evidence'); rmSync(evidenceDir, { recursive: true, force: true });
  for (let i = 0; i < dirs.length; i++) cpSync(dirs[i], join(evidenceDir, i ? 'candidate' : 'baseline'), { recursive: true });
  for (const c of cases) for (const [side, attempts] of [['baseline', c.baseline], ['candidate', c.candidate]] as const) for (const a of attempts) {
    const original = side === 'baseline' ? dirs[0] : dirs[1];
    for (const key of ['result', 'events', 'artifacts'] as const) if (a[key]) a[key] = `evidence/${side}/${relative(original, a[key]!).replaceAll('\\', '/')}`;
  }
  const coverage = requirementCoverage(dirs[1], configs[1]);
  for (const c of coverage.requirement_coverage) c.evidence = c.evidence.map(path => `evidence/candidate/${path}`);
  const selected = experiment && coverage.requirement_coverage.find(c => c.requirement_id === experiment.requirement_id);
  const targetCases = selected ? cases.filter(c => selected.case_ids.includes(c.case_id)) : [];
  const experiment_evidence = targetCases.flatMap(c => [...c.baseline, ...c.candidate].flatMap(a => a.result ? [a.result] : []));
  const experiment_conclusion = experiment ? (!compatible || run_faults.length || !targetCases.length || targetCases.length !== selected?.case_ids.length || selected.unscored_case_ids.length > 0 || targetCases.some(c => c.classification === 'error-change') ? 'unavailable: incompatible comparison or missing scored evidence for this requirement' : `${experiment.requirement_id}: ${targetCases.filter(c => c.classification === 'improve').length} improved, ${targetCases.filter(c => c.classification === 'regress').length} regressed, ${targetCases.filter(c => c.classification === 'flat').length} flat cases; review expected changes against the evidence`) : null;
  const report: CompareReport = { baseline_run: baselineId, candidate_run: candidateId, output_dir, variables, compatible, reasons, differences, cases, counts, conclusion, scope, run_faults, ...coverage, experiment, experiment_conclusion, experiment_evidence };
  if (experiment) json(join(output_dir, 'experiment.json'), experiment);
  else rmSync(join(output_dir, 'experiment.json'), { force: true });
  json(join(output_dir, 'compare.json'), { ...report, output_dir: '.' }); writeFileSync(join(output_dir, 'compare.md'), markdown(report));
  return report;
}

/** Re-render a saved comparison without reading the original runs or invoking an agent. */
export function regenerateComparison(dir: string): void {
  const report = readJson(join(dir, 'compare.json')) as CompareReport;
  writeFileSync(join(dir, 'compare.md'), markdown(report));
}
