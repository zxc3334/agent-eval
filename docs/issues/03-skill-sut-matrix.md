## Problem & Context
Currently, `agent-eval` treats the **Agent** as the Subject Under Test (SUT) via `--agent stub|container|oracle|jackson-bot-pi`. When evaluating agent skills (modular procedures, prompt packages, tool runbooks), the Skill is relegated to an ambient environment configuration.

To rigorously determine whether a Skill is high-quality:
1. **The Skill must be the independent variable (SUT)**, while the Agent runtime and LLM foundation models are the environment matrix.
2. We need to evaluate whether adding or updating a Skill provides a net capability lift compared to a clean baseline (without the skill) across multiple underlying models (e.g., Claude, Gemini, GPT-4o).
3. We need to evaluate progressive disclosure overhead (e.g. metadata-only in prompt vs. full text injection) and its impact on context window utilization and latency.

## Proposed Design
1. **Skill Evaluation Configuration in `src/types.ts`**:
   - Introduce `SkillExperimentConfig`:
     ```json
     {
       "sut": { "type": "skill", "path": "path/to/skill", "version": "1.0.0" },
       "baselines": [
         { "label": "no-skill", "skill": null },
         { "label": "v0.9-skill", "skill": "path/to/prev" }
       ],
       "matrix": {
         "models": ["gemini-pro", "claude-sonnet"],
         "disclosure_modes": ["metadata", "full"]
       }
     }
     ```
2. **Matrix Runner**:
   - Extend `src/runner.ts` to execute combinatorial runs across models and skill versions in parallel or serial batches.
3. **Comparative Analysis Report**:
   - Extend `src/compare.ts` to generate Skill-centric diffs showing win/loss rates, capability improvement, regression rate, and per-model performance breakdown.

## Acceptance Criteria
- [ ] Supports `--skill <path>` CLI option to mount and evaluate a specific skill package.
- [ ] Supports running matrix evaluations comparing baseline vs. candidate skill across at least two model adapters.
- [ ] Outputs comparative diff report classifying cases into `improve`, `regress`, `flat` attributed to the skill.
