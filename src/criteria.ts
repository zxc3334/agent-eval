import type { Criterion } from './types.ts';

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

export function normalizeCriteria(value: unknown, source: string): Criterion[] {
  const bad = (field: string, message: string): never => {
    throw new Error(`${source}: ${field}: ${message}; fix: supply unique id, type=equals, target={artifact:"answer.json",field:"answer"}, params={expected}, mode=hard|diagnostic and nonempty reason (or legacy {id,type,expected})`);
  };
  if (!Array.isArray(value) || !value.length) return bad('criteria', 'expected nonempty array');
  const seen = new Set<string>();
  return value.map((raw: unknown, i: number) => {
    const field = `criteria[${i}]`;
    if (!record(raw) || typeof raw.id !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(raw.id) || seen.has(raw.id)) return bad(field, 'requires unique id using letters, digits, _ or -');
    seen.add(raw.id);
    if (raw.type !== 'equals') return bad(`${field}.type`, 'only equals is supported');
    const legacy = !['target', 'params', 'mode', 'reason'].some(key => Object.hasOwn(raw, key));
    let criterion: Criterion;
    if (legacy) {
      if (!Object.hasOwn(raw, 'expected')) return bad(`${field}.expected`, 'required');
      criterion = { id: raw.id, type: 'equals', target: { artifact: 'answer.json', field: 'answer' },
        params: { expected: raw.expected }, mode: 'hard', reason: 'Legacy equals: answer must deeply equal expected.' };
    } else {
      if (Object.hasOwn(raw, 'expected')) return bad(`${field}.expected`, 'use params.expected for the full protocol');
      if (!record(raw.target) || raw.target.artifact !== 'answer.json' || raw.target.field !== 'answer'
        || Object.keys(raw.target).length !== 2) return bad(`${field}.target`, 'only answer.json field answer is supported');
      if (!record(raw.params) || !Object.hasOwn(raw.params, 'expected') || Object.keys(raw.params).length !== 1) return bad(`${field}.params`, 'requires only expected');
      if (raw.mode !== 'hard' && raw.mode !== 'diagnostic') return bad(`${field}.mode`, 'expected hard or diagnostic');
      if (typeof raw.reason !== 'string' || !raw.reason.trim()) return bad(`${field}.reason`, 'expected nonempty reason');
      criterion = { id: raw.id, type: 'equals', target: { artifact: 'answer.json', field: 'answer' },
        params: { expected: raw.params.expected }, mode: raw.mode, reason: raw.reason };
    }
    try { assertJsonValue(criterion.params.expected, `${field}.params.expected`); }
    catch (error) { return bad(`${field}.params.expected`, (error as Error).message); }
    return criterion;
  });
}
