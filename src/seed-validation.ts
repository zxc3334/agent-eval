import { cpSync, mkdirSync, mkdtempSync, readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { json } from './storage.ts';
import type { CaseRef } from './types.ts';

// E6a authoring check only: no persistent suite registration or runtime changes.
export function stageSeeds(source: string, casesDir: string): CaseRef[] {
  const suiteDir = join(casesDir, 'e6a');
  mkdirSync(suiteDir, { recursive: true });
  const refs = readdirSync(source, { withFileTypes: true }).filter(entry => entry.isDirectory())
    .map(entry => {
      const config = JSON.parse(readFileSync(join(source, entry.name, 'case.json'), 'utf8'));
      if (config.id !== entry.name) throw new Error(`Seed directory/id mismatch: ${entry.name}`);
      cpSync(join(source, entry.name), join(suiteDir, entry.name), { recursive: true });
      return { id: config.id as string, version: config.version as string };
    }).sort((a, b) => a.id.localeCompare(b.id));
  json(join(suiteDir, 'suite.json'), { schema_version: 2, formal: false, cases: refs });
  return refs;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const repo = fileURLToPath(new URL('../', import.meta.url));
  const output = resolve(process.argv[2] ?? join(repo, '_codex_out/e6a-validation'));
  mkdirSync(output, { recursive: true });
  const root = mkdtempSync(join(output, 'check-'));
  const casesDir = join(root, 'cases');
  const refs = stageSeeds(join(repo, 'cases/seeds'), casesDir);
  if (refs.length !== 5) throw new Error(`E6a requires exactly five seeds, found ${refs.length}`);
  const args = ['eval', 'validate', '--suite', 'e6a', '--cases-dir', casesDir, '--runs-dir', join(root, 'runs')];
  console.log(`Temporary authoring suite: ${casesDir}\npnpm ${args.join(' ')}`);
  const result = spawnSync('pnpm', args, { cwd: repo, stdio: 'inherit' });
  if (result.error) console.error(result.error.message);
  process.exitCode = result.status ?? 2;
  console.log(`Evidence and calibration receipts retained at ${root}; source reviewed flags unchanged.`);
}
