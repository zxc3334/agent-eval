import { mkdirSync, mkdtempSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { stageSeeds } from './seed-validation.ts';

const repo = fileURLToPath(new URL('../', import.meta.url));
const output = resolve(process.argv[2] ?? join(repo, '_codex_out/e6b-validation'));
mkdirSync(output, { recursive: true });
const root = mkdtempSync(join(output, 'check-'));
const casesDir = join(root, 'cases');
const refs = stageSeeds(join(repo, 'cases/negative-seeds'), casesDir, 'e6b');
if (refs.length !== 3) throw new Error(`E6b requires exactly three seeds, found ${refs.length}`);
const args = ['eval', 'validate', '--suite', 'e6b', '--cases-dir', casesDir, '--runs-dir', join(root, 'runs')];
console.log(`Temporary authoring suite: ${casesDir}\npnpm ${args.join(' ')}`);
const result = spawnSync('pnpm', args, { cwd: repo, stdio: 'inherit' });
if (result.error) console.error(result.error.message);
process.exitCode = result.status ?? 2;
console.log(`Evidence and calibration receipts retained at ${root}; source reviewed flags unchanged.`);
