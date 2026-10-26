export type Status = 'pass' | 'fail' | 'agent_error' | 'timeout' | 'verifier_error' | 'environment_error';
export interface Criterion { id: string; type: 'equals'; expected: unknown }
export interface CaseConfig {
  id: string; input: string; fixture: string; acceptance: string; timeout_ms: number;
  inject?: 'agent_error' | 'protocol_error' | 'timeout' | 'verifier_error' | 'environment_error';
}
export interface LoadedCase {
  config: CaseConfig; file: string; input: unknown; fixture: { answer: unknown; delay_ms?: number };
  criteria: Criterion[];
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
}
