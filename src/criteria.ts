import type { Criterion } from './types.ts';
import { projectFields, selectField, validField } from './json-fields.ts';

export function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

// Check before JSON serialization: JSON.stringify silently turns NaN/Infinity into null.
export function assertJsonValue(value: unknown, field: string, ancestors = new Set<unknown>()): void {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return;
  if (typeof value === 'number' && Number.isFinite(value)) return;
  if (typeof value !== 'object' || ancestors.has(value)) throw new Error(`${field}: expected finite JSON value`);
  if (!Array.isArray(value) && Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) {
    throw new Error(`${field}: expected plain JSON object`);
  }
  ancestors.add(value);
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) assertJsonValue(value[i], `${field}[${i}]`, ancestors);
  } else {
    for (const [key, item] of Object.entries(value)) assertJsonValue(item, `${field}.${key}`, ancestors);
  }
  ancestors.delete(value);
}

export function criterionExpected(c: Criterion): unknown {
  if (c.type === 'json_parseable') return true;
  if (c.type === 'fields_preserved') return projectFields(c.params.baseline, c.params.fields);
  if (c.type === 'no_write' || c.type === 'no_duplicate_side_effects') return [];
  return c.params.expected;
}

export function normalizeCriteria(value: unknown, source: string): Criterion[] {
  const bad = (field: string, message: string): never => {
    throw new Error(`${source}: ${field}: ${message}; fix: supply unique id, supported type, target={artifact:"output.json",field:"/path"}, type-specific params, mode=hard|diagnostic and nonempty reason (or legacy {id,type:"equals",expected})`);
  };
  if (!Array.isArray(value) || !value.length) return bad('criteria', 'expected nonempty array');
  const seen = new Set<string>();
  return value.map((input: unknown, i: number): Criterion => {
    const field = `criteria[${i}]`;
    if (!record(input) || typeof input.id !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(input.id) || seen.has(input.id)) return bad(field, 'requires unique id using letters, digits, _ or -');
    seen.add(input.id);
    if (typeof input.type !== 'string' || !['equals', 'json_parseable', 'fields_preserved', 'tool_args', 'no_write', 'no_duplicate_side_effects'].includes(input.type)) return bad(`${field}.type`, 'expected equals, json_parseable, fields_preserved, tool_args, no_write or no_duplicate_side_effects');
    const legacy = input.type === 'equals' && !['target', 'params', 'mode', 'reason'].some(key => Object.hasOwn(input, key));
    if (legacy && !Object.hasOwn(input, 'expected')) return bad(`${field}.expected`, 'required');
    const raw = legacy ? { id: input.id, type: 'equals', target: { artifact: 'answer.json', field: 'answer' },
      params: { expected: input.expected }, mode: 'hard', reason: 'Legacy equals: answer must deeply equal expected.' } : input;
    if (Object.hasOwn(raw, 'expected')) return bad(`${field}.expected`, 'use params.expected for the full protocol');
    if (!record(raw.target) || typeof raw.target.artifact !== 'string'
      || !/^[a-zA-Z0-9][a-zA-Z0-9_.-]*\.json$/.test(raw.target.artifact) || raw.target.artifact === 'input.json'
      || !validField(raw.target.field) || Object.keys(raw.target).length !== 2) return bad(`${field}.target`, 'requires single JSON output filename and a JSON Pointer or top-level field name');
    if (!record(raw.params)) return bad(`${field}.params`, 'expected object');
    if (raw.mode !== 'hard' && raw.mode !== 'diagnostic') return bad(`${field}.mode`, 'expected hard or diagnostic');
    if (typeof raw.reason !== 'string' || !raw.reason.trim()) return bad(`${field}.reason`, 'expected nonempty reason');
    const base: Pick<Criterion, 'id' | 'target' | 'mode' | 'reason'> = { id: input.id, target: { artifact: raw.target.artifact, field: raw.target.field }, mode: raw.mode, reason: raw.reason };
    try { assertJsonValue(raw.params, `${field}.params`); }
    catch (error) { return bad(`${field}.params`, (error as Error).message); }
    if (raw.type === 'equals') {
      if (!Object.hasOwn(raw.params, 'expected') || Object.keys(raw.params).length !== 1) return bad(`${field}.params`, 'requires only expected');
      return { ...base, type: 'equals', params: { expected: raw.params.expected } };
    }
    if (raw.type === 'tool_args') {
      const { tool, field: argumentField, expected } = raw.params;
      if (typeof tool !== 'string' || !tool.trim() || !validField(argumentField)
        || !Object.hasOwn(raw.params, 'expected') || Object.keys(raw.params).length !== 3) {
        return bad(`${field}.params`, 'tool_args requires nonempty tool, field (JSON Pointer or top-level name), and expected');
      }
      return { ...base, type: 'tool_args', params: { tool, field: argumentField, expected } };
    }
    if (raw.type === 'no_write' || raw.type === 'no_duplicate_side_effects') {
      const key = raw.type === 'no_write' ? 'read_only_tools' : 'side_effect_tools';
      const names = raw.params[key];
      if (Object.keys(raw.params).length !== 1 || !Array.isArray(names)
        || names.some(name => typeof name !== 'string' || !name.trim()) || new Set(names).size !== names.length
        || (raw.type === 'no_duplicate_side_effects' && !names.length)) {
        return bad(`${field}.params`, `${raw.type} requires only ${key}, a unique array of nonempty tool names${raw.type === 'no_duplicate_side_effects' ? ' (nonempty)' : ''}`);
      }
      return raw.type === 'no_write'
        ? { ...base, type: 'no_write', params: { read_only_tools: names } }
        : { ...base, type: 'no_duplicate_side_effects', params: { side_effect_tools: names } };
    }
    if (raw.target.field !== '') return bad(`${field}.target.field`, 'file assertions require the document root (empty string)');
    if (raw.type === 'json_parseable') {
      if (Object.keys(raw.params).length !== 0) return bad(`${field}.params`, 'json_parseable requires empty params');
      return { ...base, type: 'json_parseable', params: {} };
    }
    const { baseline, fields } = raw.params;
    if (!Object.hasOwn(raw.params, 'baseline') || Object.keys(raw.params).length !== 2
      || !Array.isArray(fields) || !fields.length || fields.some(f => !validField(f))
      || new Set(fields).size !== fields.length) return bad(`${field}.params`, 'fields_preserved requires baseline and nonempty unique fields');
    for (const path of fields) {
      if (!selectField(baseline, path).found) return bad(`${field}.params.baseline`, `preserved field ${JSON.stringify(path)} is missing`);
    }
    return { ...base, type: 'fields_preserved', params: { baseline, fields } };
  });
}
