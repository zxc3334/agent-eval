## Problem & Context
Skill quality cannot be measured solely by whether the agent ultimately produced an answer. A skill can fail in subtle, critical ways:
1. **Activation Failure (Under-triggering)**: In natural user conversations where the skill name is not explicitly mentioned, the agent fails to discover or activate the skill when needed (low recall).
2. **False-Positive Activation (Over-triggering)**: In boundary tasks that seem vaguely related but shouldn't use the skill, the agent mistakenly activates it, leading to wasted budget or wrong tools (low precision).
3. **Runbook Non-Adherence**: The skill is activated, but the agent ignores the prescribed safety guidelines, checklists, or steps in `SKILL.md`.

## Proposed Design
1. **Three-Way Case Classification**:
   - Extend `CaseConfig.type` in `src/types.ts` to support:
     - `trigger_positive`: Ordinary tasks where the skill should naturally activate and succeed.
     - `trigger_negative`: Distractor/adversarial tasks where the skill must NOT activate.
     - `adherence_check`: Structured runbook tasks requiring strict compliance with `SKILL.md` instructions.
2. **Skill Activation Detection**:
   - Instrument trace and tool-call logging to detect skill invocation markers (e.g., skill directory reads, metadata lookups, skill tool dispatch).
3. **Skill Metrics Aggregation in `src/report.ts`**:
   - Compute and present a Skill Confusion Matrix:
     - True Positives (activated on positive tasks)
     - False Positives (activated on negative tasks)
     - True Negatives (avoided on negative tasks)
     - False Negatives (missed on positive tasks)
   - Adherence Score: percentage of required runbook checks verified.
   - Skill Efficiency: additional token/cost overhead introduced by activating the skill.

## Acceptance Criteria
- [ ] Schema v2 supports `trigger_positive` and `trigger_negative` case types.
- [ ] Verifier validates both activation presence and activation absence.
- [ ] Summary report displays Skill Activation Precision, Recall, and Confusion Matrix.
- [ ] Adherence violations explicitly cite the unmet instruction section from `SKILL.md`.
