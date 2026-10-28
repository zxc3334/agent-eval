import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { resolve, dirname, relative, isAbsolute, sep, win32 } from 'node:path';
import type { LoadedCase, CaseConfig, CaseRef, Acceptance, AgentInput, ExperimentConfig } from './types.ts';
import { outputName, RESERVED_FILES } from './artifact-freeze.ts';
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
  if (data.formal !== undefined && typeof data.formal !== 'boolean') throw new Error(`${file}: formal: expected boolean; fix: set formal=true for a reviewed suite or false for local iteration`);
  if (!Array.isArray(data.cases) || !data.cases.length) throw new Error(`${file}: cases: expected nonempty reference array; fix: add at least one {id, version} reference`);
  const refs = data.cases.map((ref: any, i: number): CaseRef => ({
    id: identifier(ref?.id, `${file}: cases[${i}].id`),
    version: exactVersion(ref?.version, `${file}: cases[${i}].version`),
    ...(ref?.source === undefined ? {} : { source: identifier(ref.source, `${file}: cases[${i}].source`) }),
  }));
  const seen = new Set<string>();
  refs.forEach((ref: CaseRef, i: number) => {
    if (seen.has(ref.id)) throw new Error(`${file}: cases[${i}].id: duplicate id ${ref.id}; fix: remove the repeated reference or assign a distinct case ID`);
    seen.add(ref.id);
  });
  return refs;
}
// A source is a sibling collection under casesDir, never an arbitrary path.
export function caseFile(casesDir: string, suite: string, ref: CaseRef): string {
  const suiteFile = resolve(casesDir, suite, 'suite.json');
  identifier(suite, `${suiteFile}: suite`); identifier(ref.id, `${suiteFile}: cases.id`);
  const source = ref.source === undefined ? suite : identifier(ref.source, `${suiteFile}: cases.source`);
  const file = localFile(casesDir, `${source}/${ref.id}/case.json`, `cases[${ref.id}]`, suiteFile);
  localFile(resolve(casesDir, source), `${ref.id}/case.json`, `cases[${ref.id}]`, suiteFile);
  localFile(dirname(file), 'case.json', 'case', file);
  return file;
}
export function loadCase(casesDir: string, suite: string, ref: CaseRef): LoadedCase {
  const file = caseFile(casesDir, suite, ref);
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
    || raw.artifact_allowlist.some((name: unknown) => !outputName(name))
    || new Set(raw.artifact_allowlist).size !== raw.artifact_allowlist.length) bad('artifact_allowlist', 'expected unique output filenames including answer.json; input/log filenames are reserved');
  if (raw.inject !== undefined && !['agent_error', 'protocol_error', 'timeout', 'verifier_error', 'verifier_timeout', 'verifier_missing', 'verifier_invalid', 'environment_error'].includes(raw.inject)) bad('inject', 'unknown fault');
  const dir = dirname(file);
  if (raw.clock !== undefined && (typeof raw.clock !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(raw.clock) || !Number.isFinite(Date.parse(raw.clock)) || new Date(raw.clock).toISOString() !== raw.clock)) bad('clock', 'expected fixed ISO UTC timestamp');
  const execution = raw.execution;
  let privateTest: string | undefined;
  if (execution !== undefined) {
    if (!object(execution)) bad('execution', 'expected container configuration');
    if (typeof execution.image !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_./:@-]*$/.test(execution.image)) bad('execution.image', 'expected local Docker image reference');
    for (const key of ['command', 'verifier_command']) {
      if (!Array.isArray(execution[key]) || !execution[key].length || execution[key].some((v: unknown) => typeof v !== 'string' || !v || v.includes('\0'))) bad(`execution.${key}`, 'expected nonempty argv array');
    }
    if (!object(execution.public_files) || Object.keys(execution.public_files).some(name => !/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(name) || RESERVED_FILES.includes(name))) bad('execution.public_files', 'expected public destination filename to case-local source mapping; metadata names reserved');
    privateTest = localFile(dir, execution.private_tests, 'execution.private_tests');
  }
  const acceptanceFile = localFile(dir, raw.acceptance, 'acceptance');
  const goldFiles = ['gold.md', 'solve.ts'].filter(name => existsSync(resolve(dir, name)))
    .map(name => localFile(dir, name, `oracle.${name}`));
  const privateFiles = [acceptanceFile, ...(privateTest ? [privateTest] : []), ...(briefFile ? [briefFile] : []), ...goldFiles].map(path => statSync(path));
  const publicFile = (field: 'input' | 'fixture' | 'initial_state'): string => {
    const path = localFile(dir, raw[field], field);
    const info = statSync(path);
    if (privateFiles.some(privateInfo => privateInfo.dev === info.dev && privateInfo.ino === info.ino)) bad(field, 'public reference aliases private acceptance/brief/gold; use a separate public file');
    return path;
  };
  if (execution) {
    for (const [name, source] of Object.entries(execution.public_files)) {
      const path = localFile(dir, source, `execution.public_files.${name}`);
      const info = statSync(path);
      if (privateFiles.some(p => p.dev === info.dev && p.ino === info.ino)) bad('execution.public_files', 'public reference aliases private data');
    }
  }
  const publicInput = readJson(publicFile('input'));
  if (typeof publicInput?.prompt !== 'string' || !publicInput.prompt.trim()) bad('input.prompt', 'expected nonempty string');
  const fixtureFile = publicFile('fixture');
  const fixture = readJson(fixtureFile);
  if (!object(fixture) || !Object.hasOwn(fixture, 'answer')) throw new Error(`${fixtureFile}: answer: required; fix: add a public stub answer`);
  if (fixture.delay_ms !== undefined && (!Number.isInteger(fixture.delay_ms) || (fixture.delay_ms as number) < 0 || (fixture.delay_ms as number) > 300000)) throw new Error(`${fixtureFile}: delay_ms: expected integer 0..300000; fix: set an integer in range or omit delay_ms`);
  if (fixture.files !== undefined && (!object(fixture.files) || Object.entries(fixture.files).some(([name, content]) =>
    !raw.artifact_allowlist.includes(name) || ['answer.json', 'resource.json'].includes(name) || typeof content !== 'string'))) {
    throw new Error(`${fixtureFile}: files: expected output filename to text mapping; fix: use allowlisted filenames other than answer.json/resource.json and string contents`);
  }
  const initialState = readJson(publicFile('initial_state'));
  if (!object(initialState)) bad('initial_state', 'expected JSON object');
  const acceptance = readJson(acceptanceFile);
  const criteria = normalizeCriteria(acceptance?.criteria, acceptanceFile);
  for (const [i, criterion] of criteria.entries()) {
    if (!raw.artifact_allowlist.includes(criterion.target.artifact)) throw new Error(`${acceptanceFile}: criteria[${i}].target.artifact: not in artifact_allowlist; fix: allowlist ${criterion.target.artifact} in case.json`);
  }
  if (!object(acceptance.gold) || !Object.hasOwn(acceptance.gold, 'answer')) throw new Error(`${acceptanceFile}: gold.answer: required; fix: add the private gold answer`);
  if (!Array.isArray(acceptance.error_examples) || acceptance.error_examples.some((example: any) => !object(example) || !Object.hasOwn(example, 'answer') || typeof example.reason !== 'string' || !example.reason.trim())) throw new Error(`${acceptanceFile}: error_examples: expected array of { answer, reason }; fix: provide counterexamples with an answer and nonempty reason, or []`);
  for (const [i, example] of acceptance.error_examples.entries()) {
    const expected = example.expected_failed_criteria;
    if (expected !== undefined && (!Array.isArray(expected) || !expected.length
      || expected.some((id: unknown) => typeof id !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(id))
      || new Set(expected).size !== expected.length)) {
      throw new Error(`${acceptanceFile}: error_examples[${i}].expected_failed_criteria: expected nonempty unique criterion IDs; fix: declare exactly the hard criteria this control must fail`);
    }
    if (example.files !== undefined && (!object(example.files) || Object.entries(example.files).some(([name, content]) =>
      !raw.artifact_allowlist.includes(name) || ['answer.json', 'resource.json'].includes(name) || typeof content !== 'string'))) {
      throw new Error(`${acceptanceFile}: error_examples[${i}].files: expected allowlisted output filename to text mapping; fix: use output filenames other than answer.json/resource.json and string contents`);
    }
  }
  if (typeof acceptance.reviewed !== 'boolean') throw new Error(`${acceptanceFile}: reviewed: expected boolean; fix: set true or false`);
  // Explicit projection is the public/private boundary; no case/acceptance/experiment spread.
  const input: AgentInput = {
    prompt: publicInput.prompt,
    fixture: { answer: fixture.answer, ...(fixture.files === undefined ? {} : { files: fixture.files as Record<string, string> }), ...(fixture.delay_ms === undefined ? {} : { delay_ms: fixture.delay_ms as number }) },
    initial_state: initialState,
    artifact_allowlist: [...raw.artifact_allowlist],
    budgets: { timeout_ms: raw.budgets.timeout_ms, max_steps: raw.budgets.max_steps },
  };
  return { config: raw as CaseConfig, file, input, acceptance: acceptance as Acceptance };
}
export function loadExperiment(file: string): ExperimentConfig {
  const raw = readJson(file);
  if (!['stub', 'oracle', 'container'].includes(raw?.adapter)) throw new Error(`${file}: adapter: only stub, oracle and container are supported`);
  if (raw.model !== null && (typeof raw.model !== 'string' || !raw.model.trim())) throw new Error(`${file}: model: expected string or null`);
  if (!object(raw.product)) throw new Error(`${file}: product: expected JSON object`);
  return { adapter: raw.adapter, model: raw.model, product: raw.product };
}
