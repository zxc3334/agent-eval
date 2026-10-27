import { isDeepStrictEqual } from 'node:util';
import { record } from './criteria.ts';
import { selectField } from './json-fields.ts';
import type { ToolCall, ToolCriterion } from './types.ts';

interface ToolEvaluation { actual: unknown; passed: boolean; problem?: string }

// Validate the entire trace before filtering so malformed/unrecognized records cannot
// silently disappear. Extra adapter metadata is allowed, but never determines policy.
export function evaluateToolCalls(c: ToolCriterion, value: unknown): ToolEvaluation {
  if (!Array.isArray(value)) return { actual: null, passed: false, problem: 'tool trace must be an array' };
  const calls: ToolCall[] = [];
  for (const [index, call] of value.entries()) {
    if (!record(call) || typeof call.tool !== 'string' || !call.tool.trim() || !record(call.arguments)) {
      return { actual: null, passed: false, problem: `invalid tool call at index ${index}: requires nonempty tool and arguments object` };
    }
    calls.push({ tool: call.tool, arguments: call.arguments });
  }
  if (c.type === 'tool_args') {
    const actual = calls.flatMap((call, index) => {
      if (call.tool !== c.params.tool) return [];
      const selected = selectField(call.arguments, c.params.field);
      return [{ index, found: selected.found, value: selected.value }];
    });
    if (!actual.length) return { actual, passed: false, problem: `required tool was not called: ${c.params.tool}` };
    const failed = actual.filter(item => !item.found || !isDeepStrictEqual(item.value, c.params.expected));
    return { actual, passed: failed.length === 0,
      ...(failed.length ? { problem: `tool arguments mismatch or missing field at call indexes: ${failed.map(item => item.index).join(', ')}` } : {}) };
  }
  if (c.type === 'no_write') {
    const actual = calls.flatMap((call, index) => c.params.read_only_tools.includes(call.tool) ? [] : [{ index, ...call }]);
    return { actual, passed: actual.length === 0,
      ...(actual.length ? { problem: 'calls outside read_only_tools are forbidden' } : {}) };
  }
  const seen: { index: number; call: ToolCall }[] = [];
  const actual: { index: number; first_index: number; tool: string; arguments: Record<string, unknown> }[] = [];
  for (const [index, call] of calls.entries()) {
    if (!c.params.side_effect_tools.includes(call.tool)) continue;
    const first = seen.find(item => item.call.tool === call.tool && isDeepStrictEqual(item.call.arguments, call.arguments));
    if (first) actual.push({ index, first_index: first.index, ...call });
    else seen.push({ index, call });
  }
  return { actual, passed: actual.length === 0,
    ...(actual.length ? { problem: 'repeated side-effect tool calls with equal arguments' } : {}) };
}
