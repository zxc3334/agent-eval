export type Status = 'pass' | 'fail' | 'agent_error' | 'timeout' | 'verifier_error' | 'environment_error';
export interface LegacyCriterion { id: string; type: 'equals'; expected: unknown }
export interface EvidenceRef { artifact: string; field: string }
interface CriterionBase {
  id: string; target: { artifact: string; field: string };
  mode: 'hard' | 'diagnostic'; reason: string;
}
export type Criterion = CriterionBase & (
  | { type: 'equals'; params: { expected: unknown } }
  | { type: 'json_parseable'; params: Record<string, never> }
  | { type: 'fields_preserved'; params: { baseline: unknown; fields: string[] } }
  | { type: 'tool_args'; params: { tool: string; field: string; expected: unknown } }
  | { type: 'no_write'; params: { read_only_tools: string[] } }
  | { type: 'no_duplicate_side_effects'; params: { side_effect_tools: string[] } }
);
export type ToolCriterion = Extract<Criterion, { type: 'tool_args' | 'no_write' | 'no_duplicate_side_effects' }>;
// One entry per attempted invocation; outcome/id metadata does not erase an attempt.
export interface ToolCall { tool: string; arguments: Record<string, unknown> }
export type VerifierFault = 'verifier_error' | 'verifier_timeout' | 'verifier_missing' | 'verifier_invalid';
export interface Budgets { timeout_ms: number; max_steps: number }
export interface Fixture { answer: unknown; delay_ms?: number; files?: Record<string, string> }
// The complete adapter-facing payload. Never spread a LoadedCase into this object.
export interface AgentInput {
  prompt: string;
  fixture: Fixture;
  initial_state: Record<string, unknown>;
  artifact_allowlist: string[];
  budgets: Budgets;
}
// Reference solutions receive the fixed task state, never stub responses or acceptance.
export type OracleInput = Omit<AgentInput, 'fixture'>;
export interface ErrorExample {
  answer: unknown; reason: string;
  // Optional for legacy local v2 cases, required by calibration.
  expected_failed_criteria?: string[];
  files?: Record<string, string>;
}
export interface Acceptance {
  gold: { answer: unknown };
  criteria: (Criterion | LegacyCriterion)[];
  error_examples: ErrorExample[];
  reviewed: boolean;
}
export interface CaseRef { id: string; version: string; source?: string }
// Local scripted container fixture, not a product adapter.
export interface ContainerExecution {
  image: string; command: string[]; public_files: Record<string, string>;
  private_tests: string; verifier_command: string[];
}
export interface CaseConfig {
  schema_version: 2; id: string; version: string; type: 'positive' | 'negative';
  // Optional for existing v2 cases; authoring metadata never enters AgentInput.
  requirement_id?: string; brief?: string;
  input: string; fixture: string; initial_state: string; acceptance: string;
  artifact_allowlist: string[]; budgets: Budgets;
  clock?: string; execution?: ContainerExecution;
  inject?: 'agent_error' | 'protocol_error' | 'timeout' | VerifierFault | 'environment_error';
}
export interface LoadedCase {
  config: CaseConfig; file: string; input: AgentInput; acceptance: Acceptance;
}
// Execution choices belong to the harness, not to the task presented to the agent.
export interface ExperimentConfig {
  adapter: 'stub' | 'oracle' | 'container'; model: string | null; product: Record<string, unknown>;
}
export interface Assertion {
  criterion_id: string; expected: unknown; actual: unknown; passed: boolean; artifact: string;
  type: Criterion['type']; target: Criterion['target']; params: Criterion['params'];
  mode: Criterion['mode']; reason: string; evidence: EvidenceRef[]; problem?: string;
}
export interface Result {
  case_id: string; status: Status; duration_ms: number; assertions: Assertion[];
  stage?: string; reason?: string; events: string; verifier_result_dir?: string;
  session_id?: string; isolation?: 'trusted-local' | 'docker'; artifact_manifest?: string; handoff_errors?: string[];
}
export interface Options {
  suite: string; agent: string; casesDir: string; runsDir: string; caseId?: string;
  failedFrom?: string; watch: boolean; failFast: boolean;
  selectedIds?: string[]; sourceRunId?: string;
  experimentFile: string;
}
