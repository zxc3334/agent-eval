import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { loadCase, localFile, readJson } from './config.ts';
import type { CaseRef } from './types.ts';

export const RECEIPT = '.calibration.json';

// Content, not mtime/version, binds review to the task and the implementation that
// judged it. reviewed is a human decision; toggling it does not change the task.
export function contentHash(caseFile: string): string {
  const dir = dirname(caseFile); const config = readJson(caseFile);
  const hash = createHash('sha256');
  const add = (label: string, content: string) => hash.update(JSON.stringify([label, content]));
  add('case', readFileSync(caseFile, 'utf8'));
  for (const field of ['input', 'fixture', 'initial_state', 'acceptance', 'brief']) {
    if (field === 'brief' && config.brief === undefined) continue;
    const file = localFile(dir, config[field], field);
    if (field === 'acceptance') {
      const { reviewed: _reviewed, ...acceptance } = readJson(file);
      add(field, JSON.stringify(acceptance));
    } else add(field, readFileSync(file, 'utf8'));
  }
  for (const name of ['gold.md', 'solve.ts']) add(name, readFileSync(localFile(dir, name, `oracle.${name}`), 'utf8'));
  for (const name of ['review', 'calibration', 'evaluation', 'oracle', 'process', 'config', 'criteria', 'verifier', 'verifier-worker', 'file-verifier', 'tool-verifier', 'json-fields']) {
    add(`engine/${name}`, readFileSync(new URL(`./${name}.ts`, import.meta.url), 'utf8'));
  }
  return `sha256:${hash.digest('hex')}`;
}

// Local suites remain useful for drafts and fault injection. Formal suites check
// every member, even when the requested execution selects just one case.
export function requireReviewedSuite(casesDir: string, suite: string, refs: CaseRef[]): void {
  if (readJson(join(casesDir, suite, 'suite.json')).formal !== true) return;
  for (const ref of refs) {
    const c = loadCase(casesDir, suite, ref);
    const fail = (reason: string): never => {
      throw new Error(`${c.file}: reviewed gate: ${reason}; fix: run pnpm eval validate --suite ${suite} --cases-dir ${casesDir}, inspect evidence, then set reviewed=true`);
    };
    if (!c.acceptance.reviewed) fail('formal suite requires reviewed=true');
    let receipt;
    try { receipt = readJson(localFile(dirname(c.file), RECEIPT, 'calibration')); }
    catch { fail('missing or unreadable calibration receipt'); }
    if (receipt?.schema_version !== 1 || receipt?.status !== 'passed' || receipt?.oracle_passed !== true
      || !c.acceptance.error_examples.length || receipt?.controls_rejected !== c.acceptance.error_examples.length) fail('Oracle and every declared control must pass calibration');
    if (receipt.content_hash !== contentHash(c.file)) fail('content hash changed; recalibration required');
  }
}
