export interface RunRef {
  id: string;
  dir: string;
}

/**
 * Reserved evidence hook. Later tickets may persist run evidence.
 * This wave registers none and writes no scores, metrics, or verify results.
 */
export interface EvidenceHook {
  readonly name: string;
  onRunCreated?(run: RunRef): void;
}

export function reservedEvidenceHooks(): readonly EvidenceHook[] {
  return [];
}
