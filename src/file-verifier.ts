import { lstatSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { assertJsonValue, criterionExpected } from './criteria.ts';
import { projectFields, selectField } from './json-fields.ts';
import { evaluateToolCalls } from './tool-verifier.ts';
import type { Criterion } from './types.ts';

type Document = { ok: true; value: unknown } | { ok: false; problem: string };

function readDocument(file: string): Document {
  let text: string;
  try {
    // Do not follow symlinks or block on special files supplied as artifacts.
    if (!lstatSync(file).isFile()) return { ok: false, problem: 'artifact is not a regular file' };
    text = readFileSync(file, 'utf8');
  } catch (error) {
    return { ok: false, problem: `artifact cannot be read: ${(error as NodeJS.ErrnoException).code}` };
  }
  try {
    const value: unknown = JSON.parse(text);
    assertJsonValue(value, 'artifact');
    return { ok: true, value };
  } catch (error) {
    return { ok: false, problem: `artifact is not finite JSON: ${(error as Error).message}` };
  }
}

// Cache reads within one verification only. Nothing is written to agent artifacts.
export function evaluateFiles(criteria: Criterion[], artifacts: string) {
  const documents = new Map<string, Document>();
  return criteria.map(c => {
    const artifact = join(artifacts, c.target.artifact);
    let document = documents.get(artifact);
    if (!document) { document = readDocument(artifact); documents.set(artifact, document); }
    const row = { criterion_id: c.id, expected: criterionExpected(c), actual: null as unknown,
      passed: false, evidence: [{ artifact, field: c.target.field }] };
    if (!document.ok) return { ...row, problem: document.problem };
    if (c.type === 'json_parseable') return { ...row, actual: true, passed: true };
    if (c.type === 'fields_preserved') {
      const actual = projectFields(document.value, c.params.fields);
      const missing = c.params.fields.filter(field => !selectField(document.value, field).found);
      if (missing.length) return { ...row, actual, problem: `missing fields: ${missing.map(f => JSON.stringify(f)).join(', ')}` };
      return { ...row, actual, passed: isDeepStrictEqual(row.expected, actual) };
    }
    const selected = selectField(document.value, c.target.field);
    if (!selected.found) return { ...row, problem: `missing field: ${JSON.stringify(c.target.field)}` };
    if (['tool_args', 'no_write', 'no_duplicate_side_effects', 'call_sequence', 'call_after', 'error_recovery', 'budget_limit'].includes(c.type)) {
      return { ...row, ...evaluateToolCalls(c as any, selected.value) };
    }
    return { ...row, actual: selected.value, passed: isDeepStrictEqual(row.expected, selected.value) };
  });
}
