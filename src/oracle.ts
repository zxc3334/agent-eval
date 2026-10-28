import { mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { localFile } from './config.ts';
import { invokeNode } from './process.ts';
import { json } from './storage.ts';
import type { AgentInput, OracleInput } from './types.ts';

export interface GoldSource { notes: string; solve: string }

// Loading the reference is opt-in: old v2 cases remain usable with the stub.
export function loadGold(caseFile: string): GoldSource {
  const read = (name: string) => {
    const file = localFile(dirname(caseFile), name, `oracle.${name}`, caseFile);
    const content = readFileSync(file, 'utf8');
    if (!content.trim()) throw new Error(`${file}: oracle: expected nonempty ${name}; fix: author a reference solution and explanation`);
    return content;
  };
  return { notes: read('gold.md'), solve: read('solve.ts') };
}

export function oracleInput(input: AgentInput): OracleInput {
  return structuredClone({ prompt: input.prompt, initial_state: input.initial_state,
    artifact_allowlist: input.artifact_allowlist, budgets: input.budgets });
}

export async function invokeOracle(gold: GoldSource, input: OracleInput, caseDir: string, workspace: string, artifacts: string, temp: string, signal: AbortSignal) {
  const referenceDir = join(caseDir, 'oracle');
  mkdirSync(referenceDir);
  writeFileSync(join(referenceDir, 'gold.md'), gold.notes);
  const solve = join(referenceDir, 'solve.ts');
  writeFileSync(solve, gold.solve);
  json(join(referenceDir, 'input.json'), input);
  // The staged reference can read its input/outputs and itself, and write only its
  // fresh workspace. Acceptance, verifier code/results and original cases are not
  // filesystem capabilities of the reference process. This is not an OS sandbox.
  // Resolve aliases before applying Node permissions (e.g. macOS /var -> /private/var).
  const work = realpathSync(workspace); const entry = realpathSync(solve);
  return invokeNode(work, artifacts, temp, input.budgets.timeout_ms, [
    '--permission', `--allow-fs-read=${fileURLToPath(new URL('./clock.cjs', import.meta.url))}`, `--allow-fs-read=${work}`, `--allow-fs-read=${entry}`,
    `--allow-fs-write=${work}`, entry,
  ], signal);
}
