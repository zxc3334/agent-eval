export type Status = 'pass' | 'fail' | 'agent_error' | 'timeout' | 'verifier_error' | 'environment_error';
export interface Criterion { id: string; type: 'equals'; expected: unknown }
export interface Budgets { timeout_ms: number; max_steps: number }
export interface Fixture { answer: unknown; delay_ms?: number }
// The complete adapter-facing payload. Never spread a LoadedCase into this object.
export interface AgentInput {
  prompt: string;
  fixture: Fixture;
  initial_state: Record<string, unknown>;
  artifact_allowlist: string[];
  budgets: Budgets;
}
export interface Acceptance {
  gold: { answer: unknown };
  criteria: Criterion[];
  error_examples: { answer: unknown; reason: string }[];
  reviewed: boolean;
}
export interface CaseRef { id: string; version: string }
export interface CaseConfig {
  schema_version: 2; id: string; version: string; type: 'positive' | 'negative';
  input: string; fixture: string; initial_state: string; acceptance: string;
  artifact_allowlist: string[]; budgets: Budgets;
  inject?: 'agent_error' | 'protocol_error' | 'timeout' | 'verifier_error' | 'environment_error';
}
export interface LoadedCase {
  config: CaseConfig; file: string; input: AgentInput; acceptance: Acceptance;
}
// Execution choices belong to the harness, not to the task presented to the agent.
export interface ExperimentConfig {
  adapter: 'stub'; model: string | null; product: Record<string, unknown>;
}
export interface Assertion {
  criterion_id: string; expected: unknown; actual: unknown; passed: boolean; artifact: string;
}
export interface Result {
  case_id: string; status: Status; duration_ms: number; assertions: Assertion[];
  stage?: string; reason?: string; events: string;
}
export interface Options {
  suite: string; agent: string; casesDir: string; runsDir: string; caseId?: string;
  failedFrom?: string; watch: boolean; failFast: boolean;
  selectedIds?: string[]; sourceRunId?: string;
  experimentFile: string;
}
