import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { EvidenceHook, RunRef } from './evidence.ts';

export type RunDir = RunRef;

/** Create `runs/<timestamp-uuid>/`. Does not write evidence files. */
export function createRunDir(runsDir: string, hooks: readonly EvidenceHook[] = [], now = new Date()): RunDir {
  const id = `${now.toISOString().replace(/[:.]/g, '-')}-${randomUUID()}`;
  const dir = join(runsDir, id);
  mkdirSync(dir, { recursive: true });
  const run: RunDir = { id, dir };
  for (const hook of hooks) hook.onRunCreated?.(run);
  return run;
}
