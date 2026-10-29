# Code Map

Scope: agent-eval repository root
Base revision: 280341b9a059113209ffd998b957504179ee210f
Verified: 2026-10-29
Verification scope: src/cli.ts, src/runner.ts, src/config.ts, src/evaluation.ts, src/verifier.ts, src/criteria.ts, src/artifact-freeze.ts, src/scaffold.ts, src/compare.ts, src/trial.ts, src/calibration.ts, src/validation.ts

## Task routes
| Task cue | Start node | Follow | Covered behavior | Relevant tests |
| --- | --- | --- | --- | --- |
| run test suite | `src/cli.ts::try` | `src/runner.ts::run` | Parses CLI flags, executes test suite across repeat trials, and writes summary report | `tests/smoke.test.ts` |
| validate case schema | `src/config.ts::suiteCases` | `src/config.ts::loadCase` | Validates v2 schema, prevents directory escapes, and separates public input from private acceptance | `tests/validation.test.ts` |
| evaluate case and verify | `src/evaluation.ts::evaluate` | `src/verifier.ts::verify` | Prepares sandbox session, executes agent, freezes artifacts, and validates criteria in worker | `tests/criteria.test.ts` |
| calibrate suite controls | `src/cli.ts::try` | `src/calibration.ts::validateSuite` | Runs Oracle solution and error counterexamples to verify hard criteria before suite review | `tests/calibration.test.ts` |
| compare runs | `src/cli.ts::try` | `src/compare.ts::compareRuns` | Compares baseline vs candidate runs, checking manifest integrity and categorizing regressions | `tests/e10.test.ts` |
| scaffold feedback case | `src/cli.ts::try` | `src/scaffold.ts::createCase` | Creates fresh case draft capturing failure evidence and requirement ID from prior run | `tests/scaffold.test.ts` |
| ingest and replay trace | `src/cli.ts::try` | `src/trace.ts::replayTrace` | Replays captured agent trace trajectory offline into events and workspace files | `tests/e12-trace-replay.test.ts` |
| scaffold case from trace | `src/cli.ts::try` | `src/trace.ts::scaffoldFromTrace` | Converts real-world agent trajectory trace directly into schema v2 test case | `tests/e12-trace-replay.test.ts` |
| run skill SUT matrix | `src/cli.ts::try` | `src/skill.ts::runSkillMatrix` | Decouples skill as subject-under-test and compares baseline vs candidate performance | `tests/e14-skill-sut.test.ts` |

## Nodes
| Node | Kind | Source | Responsibility |
| --- | --- | --- | --- |
| `src/cli.ts::try` | entry | `src/cli.ts:16` | Top-level argument parsing and dispatch for eval, validate, compare, scaffold, trace replay, and skill matrix. |
| `src/runner.ts::run` | implementation | `src/runner.ts:15` | Orchestrates suite execution across cases and repeat trials, capturing signals and generating reports. |
| `src/trace.ts::parseTrace` | implementation | `src/trace.ts:15` | Parses and normalizes trajectory JSON / JSONL into unified step sequence. |
| `src/trace.ts::replayTrace` | implementation | `src/trace.ts:60` | Replays unified trace offline, logging events.jsonl and reconstructing workspace artifacts deterministically. |
| `src/trace.ts::scaffoldFromTrace` | implementation | `src/trace.ts:100` | Auto-scaffolds schema v2 case directory directly from raw trace files. |
| `src/skill.ts::loadSkill` | implementation | `src/skill.ts:10` | Parses SKILL.md frontmatter metadata and markdown instruction body. |
| `src/skill.ts::injectSkill` | implementation | `src/skill.ts:40` | Stages skill into sandbox workspace under .agents/skills/ in full or metadata-only disclosure mode. |
| `src/skill.ts::runSkillMatrix` | implementation | `src/skill.ts:75` | Orchestrates comparative evaluation matrix of baseline vs candidate skill variants. |
| `src/tool-verifier.ts::evaluateToolCalls` | implementation | `src/tool-verifier.ts:10` | Evaluates multi-turn trajectory criteria (sequence, prerequisite, recovery, budget) and skill-centric assertions (activation, avoidance, adherence). |
| `src/config.ts::suiteCases` | implementation | `src/config.ts:40` | Loads suite.json, enforcing v2 schema, unique case IDs, and pinned semantic versions. |
| `src/config.ts::caseFile` | helper | `src/config.ts:61` | Resolves case.json path for a case reference within the configured cases directory. |
| `src/config.ts::loadCase` | implementation | `src/config.ts:70` | Loads case.json, validates budgets/allowlist/brief/skill_intent, and projects public AgentInput across boundary. |
| `src/config.ts::localFile` | guard | `src/config.ts:19` | Resolves relative file paths while preventing path traversal and symlink escapes from owning directory. |
| `src/evaluation.ts::evaluate` | implementation | `src/evaluation.ts:18` | Orchestrates single trial lifecycle: workspace staging, skill injection, agent invocation, artifact freeze, and verification. |
| `src/trial.ts::prepareTrial` | helper | `src/trial.ts:9` | Initializes trial session, clock state, and writes public input and initial state into fresh workspace. |
| `src/artifact-freeze.ts::freezeArtifacts` | guard | `src/artifact-freeze.ts:18` | Freezes and hashes allowlisted output files from workspace into read-only directory and creates manifest. |
| `src/verifier.ts::verify` | implementation | `src/verifier.ts:74` | Runs isolated criteria checks via worker thread and grades hard/diagnostic assertions against artifacts. |
| `src/verifier.ts::validateVerifierOutput` | guard | `src/verifier.ts:21` | Validates untrusted worker output structure, expected values, evidence paths, and completeness. |
| `src/criteria.ts::normalizeCriteria` | implementation | `src/criteria.ts:32` | Normalizes and type-checks criteria definitions, enforcing supported types, targets, and modes. |
| `src/report.ts::generateReport` | implementation | `src/report.ts:11` | Aggregates attempt outcomes, computes pass rates, requirement coverage, and skill metrics (confusion matrix & adherence). |
| `src/calibration.ts::validateSuite` | implementation | `src/calibration.ts:14` | Executes Oracle reference solution and error control counterexamples to calibrate criteria before review. |
| `src/scaffold.ts::createCase` | implementation | `src/scaffold.ts:28` | Scaffolds a new v2 case template and registers it in suite.json under a file lock. |
| `src/scaffold.ts::feedbackSource` | helper | `src/scaffold.ts:9` | Extracts failed trial result and requirement metadata from a previous run as feedback evidence. |
| `src/compare.ts::compareRuns` | implementation | `src/compare.ts:70` | Compares baseline and candidate run manifests, configs, and case attempts to classify improve/regress/flat outcomes. |
| `tests/smoke.test.ts::smoke-eval` | test | `tests/smoke.test.ts:8` | Tests CLI execution of smoke suite, verifier evidence logging, and hard assertion exit code 1. |
| `tests/validation.test.ts::schema-only` | test | `tests/validation.test.ts:13` | Tests schema-only case and suite validation without executing agents or creating runs. |
| `tests/criteria.test.ts::hard-controls-verdict` | test | `tests/criteria.test.ts:40` | Tests that hard criteria alone control verification verdict and adapter self-reports are ignored. |
| `tests/calibration.test.ts::validate-suite-oracle-and-controls` | test | `tests/calibration.test.ts:28` | Tests calibration execution of Oracle and negative controls against hard criteria. |
| `tests/e12-trace-replay.test.ts::trace-ingestion-and-replay` | test | `tests/e12-trace-replay.test.ts:10` | Tests parsing JSON/JSONL traces, offline deterministic replay, and trace-to-case scaffolding. |
| `tests/e13-trajectory-verifier.test.ts::temporal-and-efficiency-criteria` | test | `tests/e13-trajectory-verifier.test.ts:12` | Tests call_sequence, call_after, error_recovery, and budget_limit multi-turn criteria. |
| `tests/e14-skill-sut.test.ts::skill-sut-and-matrix` | test | `tests/e14-skill-sut.test.ts:10` | Tests SKILL.md parsing, workspace skill injection, and comparative baseline vs candidate matrix. |
| `tests/e15-skill-metrics.test.ts::skill-intent-and-metrics` | test | `tests/e15-skill-metrics.test.ts:12` | Tests skill_activated, skill_avoided, runbook_adherence, and report confusion matrix metrics. |

## Edges
| From | Relation | To | Evidence | Status |
| --- | --- | --- | --- | --- |
| `src/cli.ts::try` | calls | `src/runner.ts::run` | `src/cli.ts:135` | verified |
| `src/cli.ts::try` | calls | `src/calibration.ts::validateSuite` | `src/cli.ts:69` | verified |
| `src/cli.ts::try` | calls | `src/scaffold.ts::createCase` | `src/cli.ts:84` | verified |
| `src/cli.ts::try` | calls | `src/scaffold.ts::feedbackSource` | `src/cli.ts:83` | verified |
| `src/cli.ts::try` | calls | `src/compare.ts::compareRuns` | `src/cli.ts:43` | verified |
| `src/runner.ts::run` | calls | `src/config.ts::suiteCases` | `src/runner.ts:24` | verified |
| `src/runner.ts::run` | calls | `src/config.ts::loadCase` | `src/runner.ts:29` | verified |
| `src/runner.ts::run` | calls | `src/evaluation.ts::evaluate` | `src/runner.ts:62` | verified |
| `src/runner.ts::run` | calls | `src/report.ts::generateReport` | `src/runner.ts:73` | verified |
| `src/config.ts::suiteCases` | calls | `src/config.ts::localFile` | `src/config.ts:43` | verified |
| `src/config.ts::loadCase` | calls | `src/config.ts::localFile` | `src/config.ts:84; src/config.ts:109; src/config.ts:114` | verified |
| `src/config.ts::loadCase` | calls | `src/criteria.ts::normalizeCriteria` | `src/config.ts:139` | verified |
| `src/evaluation.ts::evaluate` | calls | `src/trial.ts::prepareTrial` | `src/evaluation.ts:37` | verified |
| `src/evaluation.ts::evaluate` | calls | `src/artifact-freeze.ts::freezeArtifacts` | `src/evaluation.ts:69` | verified |
| `src/evaluation.ts::evaluate` | calls | `src/verifier.ts::verify` | `src/evaluation.ts:91` | verified |
| `src/verifier.ts::verify` | calls | `src/criteria.ts::normalizeCriteria` | `src/verifier.ts:80` | verified |
| `src/verifier.ts::verify` | calls | `src/verifier.ts::validateVerifierOutput` | `src/verifier.ts:82` | verified |
| `src/calibration.ts::validateSuite` | calls | `src/evaluation.ts::evaluate` | `src/calibration.ts:57` | verified |
| `tests/smoke.test.ts::smoke-eval` | tests-behavior | `src/runner.ts::run` | `tests/smoke.test.ts:12-24` | verified |
| `tests/validation.test.ts::schema-only` | tests-behavior | `src/config.ts::loadCase` | `tests/validation.test.ts:24-33` | verified |
| `tests/criteria.test.ts::hard-controls-verdict` | tests-behavior | `src/verifier.ts::verify` | `tests/criteria.test.ts:45-51` | verified |
| `tests/calibration.test.ts::validate-suite-oracle-and-controls` | tests-behavior | `src/calibration.ts::validateSuite` | `tests/calibration.test.ts:37-50` | verified |

## Open questions
- Dynamic agent executor targets in `src/evaluation.ts:53-62` (`container`, `oracle`, `counterexample`, `jackson-bot-pi`): `jackson-bot-pi` adapter communicates via external API transport, which cannot be statically verified without runtime credentials.
- Isolated verification execution in `src/verifier.ts:53`: worker thread boundary (`src/verifier-worker.ts`) executes dynamic criterion checkers asynchronously and communicates verdicts via Node.js IPC messages.
