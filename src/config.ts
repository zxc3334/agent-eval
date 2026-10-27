import { readFileSync, realpathSync, statSync } from 'node:fs';
import { resolve, dirname, relative, isAbsolute, sep, win32 } from 'node:path';
import type { LoadedCase, CaseConfig, CaseRef, Acceptance, AgentInput, ExperimentConfig } from './types.ts';
import { normalizeCriteria } from './criteria.ts';

export function readJson(file: string): any {
  try { return JSON.parse(readFileSync(file, 'utf8')); }
  catch (error) { throw new Error(`${file}: JSON/read: ${(error as Error).message}; fix: provide a readable, valid JSON file`); }
}
export function identifier(value: string, field: string): string {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(value)) throw new Error(`${field}: invalid identifier ${JSON.stringify(value)}; fix: use a letter/digit followed by letters, digits, _ or -`);
  return value;
}
function outside(dir: string, file: string): boolean {
  const path = relative(dir, file);
  return path === '..' || path.startsWith(`..${sep}`) || isAbsolute(path);
}
export function localFile(dir: string, value: unknown, field: string, source = resolve(dir, 'case.json')): string {
  const bad = (message: string, hint: string): never => { throw new Error(`${source}: ${field}: ${message}; fix: ${hint}`); };
  if (typeof value !== 'string' || !value || value.includes('\0')) return bad('expected file path', 'set a nonempty relative file path');
  const file = resolve(dir, value);
  if (isAbsolute(value) || win32.isAbsolute(value) || outside(dir, file)) return bad('path must stay inside case directory or selected cases root', 'use a relative path within the owning directory');
  try {
    if (outside(realpathSync(dir), realpathSync(file))) return bad('symlink path escapes owning directory', 'replace the link with a file inside the owning directory');
    if (!statSync(file).isFile()) return bad(`expected regular file: ${file}`, 'point this field to a file, not a directory');
  } catch (error) {
    if (!(error as NodeJS.ErrnoException).code) throw error;
    return bad(`cannot read referenced file ${file}: ${(error as NodeJS.ErrnoException).code}`, 'create the missing file or correct this reference and its permissions');
  }
  return file;
}
function exactVersion(value: unknown, field: string): string {
  if (typeof value !== 'string' || !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(value)) throw new Error(`${field}: expected exact version (e.g. 1.0.0); fix: pin the case's exact major.minor.patch version`);
  return value;
}
function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
export function suiteCases(casesDir: string, suite: string): CaseRef[] {
  const source = resolve(casesDir, 'suite.json');
  identifier(suite, `${source}: suite`);
  const file = localFile(casesDir, `${suite}/suite.json`, 'suite', resolve(casesDir, suite, 'suite.json'));
  const data = readJson(file);
  if (data?.schema_version !== 2) throw new Error(`${file}: schema_version: expected 2; migrate v1 suite; fix: use schema_version=2 and {id, version} references`);
  if (!Array.isArray(data.cases) || !data.cases.length) throw new Error(`${file}: cases: expected nonempty reference array; fix: add at least one {id, version} reference`);
  const refs = data.cases.map((ref: any, i: number): CaseRef => ({
    id: identifier(ref?.id, `${file}: cases[${i}].id`),
    version: exactVersion(ref?.version, `${file}: cases[${i}].version`),
  }));
  const seen = new Set<string>();
  refs.forEach((ref: CaseRef, i: number) => {
    if (seen.has(ref.id)) throw new Error(`${file}: cases[${i}].id: duplicate id ${ref.id}; fix: remove the repeated reference or assign a distinct case ID`);
    seen.add(ref.id);
  });
  return refs;
}
export function loadCase(casesDir: string, suite: string, ref: CaseRef): LoadedCase {
  const suiteFile = resolve(casesDir, suite, 'suite.json');
  identifier(suite, `${suiteFile}: suite`); identifier(ref.id, `${suiteFile}: cases.id`);
  const file = localFile(casesDir, `${suite}/${ref.id}/case.json`, `cases[${ref.id}]`, suiteFile);
  localFile(resolve(casesDir, suite), `${ref.id}/case.json`, `cases[${ref.id}]`, suiteFile);
  localFile(dirname(file), 'case.json', 'case', file);
  const raw = readJson(file);
  const bad = (field: string, message: string): never => { throw new Error(`${file}: ${field}: ${message}; fix: update ${field} to satisfy this requirement`); };
  if (raw?.schema_version !== 2) bad('schema_version', 'expected 2; migrate v1 case');
  if (raw.id !== ref.id) bad('id', `expected ${ref.id}`);
  if (raw.requirement_id !== undefined) identifier(raw.requirement_id, `${file}: requirement_id`);
  const briefFile = raw.brief === undefined ? undefined : localFile(dirname(file), raw.brief, 'brief');
  if (briefFile && !readFileSync(briefFile, 'utf8').trim()) bad('brief', 'expected nonempty document');
  exactVersion(ref.version, `${file}: suite version`);
  exactVersion(raw.version, `${file}: version`);
  if (raw.version !== ref.version) bad('version', `suite pins ${ref.version}, found ${raw.version}`);
  if (!['positive', 'negative'].includes(raw.type)) bad('type', 'expected positive or negative');
  if (!Number.isInteger(raw.budgets?.timeout_ms) || raw.budgets.timeout_ms < 1 || raw.budgets.timeout_ms > 300000) bad('budgets.timeout_ms', 'expected integer 1..300000');
  if (!Number.isSafeInteger(raw.budgets?.max_steps) || raw.budgets.max_steps < 1) bad('budgets.max_steps', 'expected positive safe integer');
  if (!Array.isArray(raw.artifact_allowlist) || !raw.artifact_allowlist.includes('answer.json')
    || raw.artifact_allowlist.some((name: unknown) => typeof name !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(name)
      || ['input.json', 'stdout.log', 'stderr.log'].includes(name))
    || new Set(raw.artifact_allowlist).size !== raw.artifact_allowlist.length) bad('artifact_allowlist', 'expected unique output filenames including answer.json; input/log filenames are reserved');
  if (raw.inject !== undefined && !['agent_error', 'protocol_error', 'timeout', 'verifier_error', 'verifier_timeout', 'verifier_missing', 'verifier_invalid', 'environment_error'].includes(raw.inject)) bad('inject', 'unknown fault');
  const dir = dirname(file);
  const acceptanceFile = localFile(dir, raw.acceptance, 'acceptance');
  const privateFiles = [acceptanceFile, ...(briefFile ? [briefFile] : [])].map(path => statSync(path));
  const publicFile = (field: 'input' | 'fixture' | 'initial_state'): string => {
    const path = localFile(dir, raw[field], field);
    const info = statSync(path);
    if (privateFiles.some(privateInfo => privateInfo.dev === info.dev && privateInfo.ino === info.ino)) bad(field, 'public reference aliases private acceptance/brief; use a separate public file');
    return path;
  };
  const publicInput = readJson(publicFile('input'));
  if (typeof publicInput?.prompt !== 'string' || !publicInput.prompt.trim()) bad('input.prompt', 'expected nonempty string');
  const fixtureFile = publicFile('fixture');
  const fixture = readJson(fixtureFile);
  if (!object(fixture) || !Object.hasOwn(fixture, 'answer')) throw new Error(`${fixtureFile}: answer: required; fix: add a public stub answer`);
  if (fixture.delay_ms !== undefined && (!Number.isInteger(fixture.delay_ms) || (fixture.delay_ms as number) < 0 || (fixture.delay_ms as number) > 300000)) throw new Error(`${fixtureFile}: delay_ms: expected integer 0..300000; fix: set an integer in range or omit delay_ms`);
  const initialState = readJson(publicFile('initial_state'));
  if (!object(initialState)) bad('initial_state', 'expected JSON object');
  const acceptance = readJson(acceptanceFile);
  normalizeCriteria(acceptance?.criteria, acceptanceFile);
  if (!object(acceptance.gold) || !Object.hasOwn(acceptance.gold, 'answer')) throw new Error(`${acceptanceFile}: gold.answer: required; fix: add the private gold answer`);
  if (!Array.isArray(acceptance.error_examples) || acceptance.error_examples.some((example: any) => !object(example) || !Object.hasOwn(example, 'answer') || typeof example.reason !== 'string' || !example.reason.trim())) throw new Error(`${acceptanceFile}: error_examples: expected array of { answer, reason }; fix: provide counterexamples with an answer and nonempty reason, or []`);
  if (typeof acceptance.reviewed !== 'boolean') throw new Error(`${acceptanceFile}: reviewed: expected boolean; fix: set true or false`);
  // Explicit projection is the public/private boundary; no case/acceptance/experiment spread.
  const input: AgentInput = {
    prompt: publicInput.prompt,
    fixture: { answer: fixture.answer, ...(fixture.delay_ms === undefined ? {} : { delay_ms: fixture.delay_ms as number }) },
    initial_state: initialState,
    artifact_allowlist: [...raw.artifact_allowlist],
    budgets: { timeout_ms: raw.budgets.timeout_ms, max_steps: raw.budgets.max_steps },
  };
  return { config: raw as CaseConfig, file, input, acceptance: acceptance as Acceptance };
}
export function loadExperiment(file: string): ExperimentConfig {
  const raw = readJson(file);
  if (raw?.adapter !== 'stub') throw new Error(`${file}: adapter: only stub is supported`);
  if (raw.model !== null && (typeof raw.model !== 'string' || !raw.model.trim())) throw new Error(`${file}: model: expected string or null`);
  if (!object(raw.product)) throw new Error(`${file}: product: expected JSON object`);
  return { adapter: raw.adapter, model: raw.model, product: raw.product };
}
