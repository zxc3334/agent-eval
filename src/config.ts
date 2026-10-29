import { readFileSync } from 'node:fs';
import { resolve, dirname, relative, isAbsolute } from 'node:path';
import type { LoadedCase, CaseConfig, CaseRef, Acceptance, AgentInput, ExperimentConfig } from './types.ts';

export function readJson(file: string): any {
  try { return JSON.parse(readFileSync(file, 'utf8')); }
  catch (error) { throw new Error(`${file}: JSON/read: ${(error as Error).message}`); }
}
export function identifier(value: string, field: string): string {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(value)) throw new Error(`${field}: invalid identifier ${JSON.stringify(value)}`);
  return value;
}
export function localFile(dir: string, value: unknown, field: string): string {
  if (typeof value !== 'string' || !value) throw new Error(`${dir}/case.json: ${field}: expected file path`);
  const file = resolve(dir, value);
  if (isAbsolute(value) || relative(dir, file).startsWith('..')) throw new Error(`${dir}/case.json: ${field}: path must stay inside case directory`);
  return file;
}
function exactVersion(value: unknown, field: string): string {
  if (typeof value !== 'string' || !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(value)) throw new Error(`${field}: expected exact version (e.g. 1.0.0)`);
  return value;
}
function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
export function suiteCases(casesDir: string, suite: string): CaseRef[] {
  const file = resolve(casesDir, identifier(suite, 'suite'), 'suite.json');
  const data = readJson(file);
  if (data?.schema_version !== 2) throw new Error(`${file}: schema_version: expected 2; migrate v1 suite`);
  if (!Array.isArray(data.cases) || !data.cases.length) throw new Error(`${file}: cases: expected nonempty reference array`);
  const refs = data.cases.map((ref: any, i: number): CaseRef => ({
    id: identifier(ref?.id, `${file}: cases[${i}].id`),
    version: exactVersion(ref?.version, `${file}: cases[${i}].version`),
  }));
  if (new Set(refs.map((ref: CaseRef) => ref.id)).size !== refs.length) throw new Error(`${file}: cases: duplicate id`);
  return refs;
}
export function loadCase(casesDir: string, suite: string, ref: CaseRef): LoadedCase {
  const file = resolve(casesDir, identifier(suite, 'suite'), identifier(ref.id, 'case'), 'case.json');
  const raw = readJson(file);
  const bad = (field: string, message: string): never => { throw new Error(`${file}: ${field}: ${message}`); };
  if (raw?.schema_version !== 2) bad('schema_version', 'expected 2; migrate v1 case');
  if (raw.id !== ref.id) bad('id', `expected ${ref.id}`);
  if (raw.requirement_id !== undefined) identifier(raw.requirement_id, `${file}: requirement_id`);
  if (raw.brief !== undefined && !readFileSync(localFile(dirname(file), raw.brief, 'brief'), 'utf8').trim()) bad('brief', 'expected nonempty document');
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
  if (raw.inject !== undefined && !['agent_error', 'protocol_error', 'timeout', 'verifier_error', 'environment_error'].includes(raw.inject)) bad('inject', 'unknown fault');
  const dir = dirname(file);
  const publicInput = readJson(localFile(dir, raw.input, 'input'));
  if (typeof publicInput?.prompt !== 'string' || !publicInput.prompt.trim()) bad('input.prompt', 'expected nonempty string');
  const fixtureFile = localFile(dir, raw.fixture, 'fixture');
  const fixture = readJson(fixtureFile);
  if (!object(fixture) || !Object.hasOwn(fixture, 'answer')) throw new Error(`${fixtureFile}: answer: required`);
  if (fixture.delay_ms !== undefined && (!Number.isInteger(fixture.delay_ms) || (fixture.delay_ms as number) < 0 || (fixture.delay_ms as number) > 300000)) throw new Error(`${fixtureFile}: delay_ms: expected integer 0..300000`);
  const initialState = readJson(localFile(dir, raw.initial_state, 'initial_state'));
  if (!object(initialState)) bad('initial_state', 'expected JSON object');
  const acceptanceFile = localFile(dir, raw.acceptance, 'acceptance');
  const acceptance = readJson(acceptanceFile);
  if (!Array.isArray(acceptance?.criteria) || !acceptance.criteria.length) throw new Error(`${acceptanceFile}: criteria: expected nonempty array`);
  const seen = new Set<string>();
  acceptance.criteria.forEach((c: any, i: number) => {
    if (!c || typeof c.id !== 'string' || !c.id || seen.has(c.id) || c.type !== 'equals' || !Object.hasOwn(c, 'expected')) throw new Error(`${acceptanceFile}: criteria[${i}]: requires unique id, type=equals and expected`);
    seen.add(c.id);
  });
  if (!object(acceptance.gold) || !Object.hasOwn(acceptance.gold, 'answer')) throw new Error(`${acceptanceFile}: gold.answer: required`);
  if (!Array.isArray(acceptance.error_examples) || acceptance.error_examples.some((example: any) => !object(example) || !Object.hasOwn(example, 'answer') || typeof example.reason !== 'string' || !example.reason.trim())) throw new Error(`${acceptanceFile}: error_examples: expected array of { answer, reason }`);
  if (typeof acceptance.reviewed !== 'boolean') throw new Error(`${acceptanceFile}: reviewed: expected boolean`);
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
