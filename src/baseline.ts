import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { identifier, readJson } from './config.ts';
import { json } from './storage.ts';

type Selection = { run_id: string; selected_at: string };

/** Select a completed run explicitly; running or reporting never changes this file. */
export function setBaseline(runsDir: string, runId: string): string {
  identifier(runId, 'run-id');
  const dir = join(runsDir, runId);
  const config = readJson(join(dir, 'config.json'));
  if (config?.run_id !== runId) throw new Error(`baseline: config run_id does not match ${runId}`);
  const manifest = readJson(join(dir, 'manifest.json'));
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest) || manifest.schema_version !== 1) {
    throw new Error('baseline: expected completed run with a supported manifest');
  }
  const file = join(runsDir, 'baseline.json');
  let history: Selection[] = [];
  if (existsSync(file)) {
    const previous = readJson(file);
    if (previous?.schema_version !== 1 || typeof previous.run_id !== 'string' || !Array.isArray(previous.history)
      || previous.history.some((item: Selection) => !item || typeof item.run_id !== 'string' || typeof item.selected_at !== 'string')) {
      throw new Error('baseline: invalid baseline history; restore or repair baseline.json before selecting a run');
    }
    history = previous.history;
  }
  history.push({ run_id: runId, selected_at: new Date().toISOString() });
  json(file, { schema_version: 1, run_id: runId, history });
  return file;
}
