import { cpSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
export const cli = resolve('src/cli.ts');
export function setup() {
  const root = mkdtempSync(join(tmpdir(), 'agent-eval-integration-'));
  const cases = join(root, 'cases'); const runs = join(root, 'runs');
  cpSync('cases', cases, { recursive: true });
  const args = ['--cases-dir', cases, '--runs-dir', runs];
  return { root, cases, runs, args };
}
export function read(file: string) { return JSON.parse(readFileSync(file, 'utf8')); }
export function write(file: string, data: unknown) { writeFileSync(file, JSON.stringify(data)); }
export function writeSuite(cases: string, ids: string[]) {
  write(join(cases, 'smoke/suite.json'), { schema_version: 2, cases: ids.map(id => ({ id, version: '1.0.0' })) });
}
export function execute(args: string[], cwd?: string) { return spawnSync(process.execPath, [cli, ...args], { cwd, encoding: 'utf8', timeout: 15000 }); }
export function runDirs(runs: string): string[] { try { return readdirSync(runs).sort().map(id => join(runs, id)); } catch { return []; } }
export function addCase(cases: string, id: string, inject?: string, delay = 0) {
  const dir = join(cases, 'smoke', id);
  cpSync(join(cases, 'smoke/smoke-pass'), dir, { recursive: true });
  const config = read(join(dir, 'case.json'));
  write(join(dir, 'case.json'), { ...config, id, inject,
    artifact_allowlist: [...config.artifact_allowlist, 'descendant.json', 'partial.txt'],
    budgets: { ...config.budgets, timeout_ms: inject === 'timeout' ? 500 : 5000 } });
  write(join(dir, 'fixture.json'), { answer: 'hello', delay_ms: delay });
}
export function launch(args: string[]) {
  const child = spawn(process.execPath, [cli, ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
  let output = ''; child.stdout.on('data', b => output += b); child.stderr.on('data', b => output += b);
  const done = new Promise<number | null>(resolve => child.on('close', resolve));
  return { child, done, output: () => output };
}
export async function until(predicate: () => boolean, timeout = 7000) {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeout) throw new Error('condition timed out');
    await new Promise(resolve => setTimeout(resolve, 25));
  }
}
