import { readFileSync } from 'node:fs';
import { resolve, dirname, relative, isAbsolute } from 'node:path';
import type { LoadedCase, CaseConfig, Criterion } from './types.ts';

export function readJson(file: string): any {
  try { return JSON.parse(readFileSync(file, 'utf8')); }
  catch (error) { throw new Error(`${file}: JSON/read: ${(error as Error).message}`); }
}
export function identifier(value: string, field: string): string {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(value)) throw new Error(`${field}: invalid identifier ${JSON.stringify(value)}`);
  return value;
}
export function localFile(dir: string, value: unknown, field: string): string {
  if (typeof value !== 'string' || !value) throw new Error(`${dir}/case.json: ${field}: expected file path`);
  const file = resolve(dir, value);
  if (isAbsolute(value) || relative(dir, file).startsWith('..')) throw new Error(`${dir}/case.json: ${field}: path must stay inside case directory`);
  return file;
}
export function suiteIds(casesDir: string, suite: string): string[] {
  const file = resolve(casesDir, identifier(suite, 'suite'), 'suite.json');
  const data = readJson(file);
  if (!Array.isArray(data?.cases) || !data.cases.length || data.cases.some((v: unknown) => typeof v !== 'string')) throw new Error(`${file}: cases: expected nonempty string array`);
  const ids = data.cases.map((id: string) => identifier(id, `${file}: cases`));
  if (new Set(ids).size !== ids.length) throw new Error(`${file}: cases: duplicate id`);
  return ids;
}
export function loadCase(casesDir: string, suite: string, id: string): LoadedCase {
  const file = resolve(casesDir, suite, identifier(id, 'case'), 'case.json');
  const raw = readJson(file);
  const bad = (field: string, message: string): never => { throw new Error(`${file}: ${field}: ${message}`); };
  if (raw?.id !== id) bad('id', `expected ${id}`);
  if (!Number.isInteger(raw.timeout_ms) || raw.timeout_ms < 1 || raw.timeout_ms > 300000) bad('timeout_ms', 'expected integer 1..300000');
  if (raw.inject !== undefined && !['agent_error', 'protocol_error', 'timeout', 'verifier_error', 'environment_error'].includes(raw.inject)) bad('inject', 'unknown fault');
  const dir = dirname(file);
  const input = readJson(localFile(dir, raw.input, 'input'));
  const fixtureFile = localFile(dir, raw.fixture, 'fixture');
  const fixture = readJson(fixtureFile);
  if (!fixture || !Object.hasOwn(fixture, 'answer')) throw new Error(`${fixtureFile}: answer: required`);
  if (fixture.delay_ms !== undefined && (!Number.isInteger(fixture.delay_ms) || fixture.delay_ms < 0 || fixture.delay_ms > 300000)) throw new Error(`${fixtureFile}: delay_ms: expected integer 0..300000`);
  const acceptanceFile = localFile(dir, raw.acceptance, 'acceptance');
  const acceptance = readJson(acceptanceFile);
  if (!Array.isArray(acceptance?.criteria) || !acceptance.criteria.length) throw new Error(`${acceptanceFile}: criteria: expected nonempty array`);
  const seen = new Set<string>();
  acceptance.criteria.forEach((c: any, i: number) => {
    if (!c || typeof c.id !== 'string' || !c.id || seen.has(c.id) || c.type !== 'equals' || !Object.hasOwn(c, 'expected')) throw new Error(`${acceptanceFile}: criteria[${i}]: requires unique id, type=equals and expected`);
    seen.add(c.id);
  });
  return { config: raw as CaseConfig, file, input, fixture, criteria: acceptance.criteria as Criterion[] };
}
