import { randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { json } from './storage.ts';
import type { AgentInput, OracleInput } from './types.ts';

export const FIXED_NOW = '2026-01-01T00:00:00.000Z';
export const clockSource = readFileSync(new URL('./clock.cjs', import.meta.url), 'utf8');
export function prepareTrial(workspace: string, caseDir: string, input: AgentInput | OracleInput, clock = FIXED_NOW) {
  const session = { id: randomUUID(), clock, epoch_ms: Date.parse(clock), isolation: 'trusted-local' };
  json(join(caseDir, 'session.json'), session);
  json(join(workspace, 'session.json'), session);
  json(join(workspace, 'input.json'), structuredClone(input));
  json(join(workspace, 'initial-state.json'), input.initial_state);
  if ('fixture' in input) json(join(workspace, 'fixture.json'), input.fixture);
  writeFileSync(join(workspace, 'clock.cjs'), clockSource);
  return session;
}
