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
    calls.push({
      tool: call.tool,
      arguments: call.arguments,
      ...(call.error ? { error: String(call.error) } : {}),
      ...(call.result !== undefined ? { result: call.result } : {}),
    });
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
  if (c.type === 'call_sequence') {
    const toolNames = calls.map(item => item.tool);
    if (c.params.allow_subsequence) {
      let seqIdx = 0;
      for (const name of toolNames) {
        if (name === c.params.sequence[seqIdx]) {
          seqIdx++;
          if (seqIdx === c.params.sequence.length) break;
        }
      }
      const passed = seqIdx === c.params.sequence.length;
      return {
        actual: toolNames,
        passed,
        ...(passed ? {} : { problem: `subsequence [${c.params.sequence.join(', ')}] not found in trace [${toolNames.join(', ')}]` }),
      };
    }
    let passed = false;
    for (let i = 0; i <= toolNames.length - c.params.sequence.length; i++) {
      if (c.params.sequence.every((name, idx) => toolNames[i + idx] === name)) {
        passed = true;
        break;
      }
    }
    return {
      actual: toolNames,
      passed,
      ...(passed ? {} : { problem: `contiguous sequence [${c.params.sequence.join(', ')}] not found in trace [${toolNames.join(', ')}]` }),
    };
  }
  if (c.type === 'call_after') {
    const violations: { index: number; tool: string }[] = [];
    let sawPrerequisite = false;
    for (const [index, call] of calls.entries()) {
      if (call.tool === c.params.prerequisite) sawPrerequisite = true;
      if (call.tool === c.params.successor && !sawPrerequisite) {
        violations.push({ index, tool: call.tool });
      }
    }
    return {
      actual: violations,
      passed: violations.length === 0,
      ...(violations.length ? { problem: `${c.params.successor} called at index ${violations.map(v => v.index).join(', ')} before prerequisite ${c.params.prerequisite}` } : {}),
    };
  }
  if (c.type === 'error_recovery') {
    const failedRecoveries: number[] = [];
    for (let i = 0; i < calls.length; i++) {
      if (calls[i].tool === c.params.failing_tool && Boolean(calls[i].error)) {
        const next = calls[i + 1];
        if (!next || next.tool !== c.params.recovery_tool) {
          failedRecoveries.push(i);
        }
      }
    }
    return {
      actual: failedRecoveries,
      passed: failedRecoveries.length === 0,
      ...(failedRecoveries.length ? { problem: `failed to invoke ${c.params.recovery_tool} immediately after error in ${c.params.failing_tool} at index ${failedRecoveries.join(', ')}` } : {}),
    };
  }
  if (c.type === 'budget_limit') {
    const max = c.params.max_tool_calls;
    const passed = max === undefined || calls.length <= max;
    return {
      actual: calls.length,
      passed,
      ...(passed ? {} : { problem: `exceeded max_tool_calls: limit was ${max}, actual was ${calls.length}` }),
    };
  }
  if (c.type === 'skill_activated') {
    const target = c.params.skill_name.toLowerCase();
    const activated = calls.some(item =>
      item.tool.toLowerCase().includes(target) ||
      String(item.arguments.skill ?? '').toLowerCase() === target ||
      String(item.arguments.name ?? '').toLowerCase() === target
    );
    return {
      actual: { skill_name: c.params.skill_name, activated },
      passed: activated,
      ...(activated ? {} : { problem: `expected skill ${c.params.skill_name} to be activated, but no related tool call was detected` }),
    };
  }
  if (c.type === 'skill_avoided') {
    const target = c.params.skill_name.toLowerCase();
    const found = calls.filter(item =>
      item.tool.toLowerCase().includes(target) ||
      String(item.arguments.skill ?? '').toLowerCase() === target ||
      String(item.arguments.name ?? '').toLowerCase() === target
    );
    const passed = found.length === 0;
    return {
      actual: { skill_name: c.params.skill_name, activated: !passed },
      passed,
      ...(passed ? {} : { problem: `skill ${c.params.skill_name} was unexpectedly activated on negative/distractor case (false positive)` }),
    };
  }
  if (c.type === 'runbook_adherence') {
    const invoked = new Set(calls.map(item => item.tool));
    const missing = c.params.required_steps.filter(step => !invoked.has(step));
    const passed = missing.length === 0;
    return {
      actual: calls.map(item => item.tool),
      passed,
      ...(passed ? {} : { problem: `unmet runbook steps from SKILL.md: ${missing.join(', ')}` }),
    };
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
