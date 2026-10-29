## Problem & Context
The current tool verification in `src/tool-verifier.ts::evaluateToolCalls` only checks static tool properties:
- `tool_args`: single-call argument deep equality.
- `no_write`: checking if non-whitelisted write tools were invoked.
- `no_duplicate_side_effects`: simple repeated call detection.

However, real-world Agent behavior and Skill execution require validating complex multi-turn dynamics:
1. **Temporal Ordering & Step Sequences**: Verifying that an agent follows strict procedural dependencies (e.g., must call `search` or `read` before calling `edit` or `commit`).
2. **State Machine & Error Recovery**: Verifying that if a tool fails (e.g., returns 404 or syntax error), the agent takes the expected recovery/fallback path instead of hallucinating or aborting.
3. **Efficiency & Budget Guards**: Enforcing step-level token limits, preventing infinite thought loops, and capping unproductive tool retry counts.

## Proposed Design
1. **Extend Criterion Protocol in `src/types.ts`**:
   - `call_sequence`: checks regex/FSM-like order of tool invocations (e.g. `["search", "read+", "write"]`).
   - `call_after` / `call_before`: relational constraints between two tool events.
   - `error_recovery`: asserts that an error event at index `i` is followed by an expected remedial tool call at index `i+1`.
   - `step_budget` / `token_budget`: assertions on token usage and step counts per sub-goal.
2. **Worker-Level Isolation**:
   - Implement these checks inside `src/verifier-worker.ts` so that trajectory verification remains isolated with a strict 2-second timeout.
   - Report granular mismatch details including matched indices, violation steps, and unexpected transitions in `Assertion.problem`.

## Acceptance Criteria
- [ ] Supports declarative temporal sequence checks (`call_sequence`) in `acceptance.json`.
- [ ] Supports error recovery assertions when mock tools return simulated errors.
- [ ] Failed trajectory assertions pinpoint the exact violation index and step description in `result.json`.
- [ ] Maintains the invariant that `hard` criteria strictly govern the pass/fail outcome.
