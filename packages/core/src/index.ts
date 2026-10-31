export { formatHelp, runCli } from './cli.ts';
export type { Command, CommandResult, Track } from './cli.ts';
export { taskCommand } from './task-cli.ts';
export {
  MARK_UNITS,
  baselineLabelFromRaw,
  countRounds,
  dedupeKey,
  formatBaseline,
  normalizeMarkSource,
  parseMarkExport,
  parseMarkKind,
  planMarks,
  resolveProvenance,
  sharedBaseline,
} from './marks.ts';
export type {
  BaselineCount,
  ConfirmChoice,
  DirectMark,
  MarkPlan,
  MarkPlanResult,
  ResolvedProvenance,
  SharedBaseline,
} from './marks.ts';
export { identifier, repoPaths, writeJson } from './config.ts';
export type { RepoPaths } from './config.ts';
export { reservedEvidenceHooks } from './evidence.ts';
export type { EvidenceHook, RunRef } from './evidence.ts';
export { createRunDir } from './runs.ts';
export type { RunDir } from './runs.ts';
export { assessCommit, canonicalSha, SHA_FORMAT_MESSAGE } from './sha.ts';
export type { AssessOptions, CommitLookupState, ShaAssessment } from './sha.ts';
export {
  AGENT_INPUT_ALLOWLIST,
  buildAgentInput,
  exportCardJson,
  loadTaskCard,
  loadTaskCards,
  parseTaskCardJson,
  parseTaskCardYaml,
  PRIVATE_FIELD_ROLES,
  projectAgentInput,
  PUBLIC_FIELD_ROLES,
  SCHEMA_VERSION,
  serializeAgentInput,
  TaskCardError,
  validateTaskCard,
} from './task-card.ts';
export type {
  AgentInput,
  CardIssue,
  CardResult,
  DiffStats,
  InterventionRecord,
  Interventions,
  MarkBoundary,
  MarkCandidate,
  MarkKind,
  MarkOrigin,
  MergeValue,
  OptionalGap,
  PullRequestValue,
  RepoHost,
  RepoValue,
  RequiredGap,
  SourceKind,
  SourceRef,
  TaskCard,
  VerifyState,
} from './task-card.ts';
