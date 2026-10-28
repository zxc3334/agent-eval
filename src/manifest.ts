import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, readFileSync, readdirSync } from 'node:fs';
import { arch, platform, release } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { json } from './storage.ts';
import { identifier, localFile } from './config.ts';
import type { CaseRef, ExperimentConfig, LoadedCase, Options } from './types.ts';

const hash = (bytes: string | Buffer) => createHash('sha256').update(bytes).digest('hex');
const fileHash = (path: string) => hash(readFileSync(path));
const root = resolve(import.meta.dirname, '..');

// Symlinks are deliberately not followed when recording produced files.
function files(dir: string, base = dir): Record<string, string> {
  const entries: Record<string, string> = {};
  for (const name of readdirSync(dir).sort()) {
    const path = join(dir, name); const info = lstatSync(path);
    if (info.isDirectory()) Object.assign(entries, files(path, base));
    else if (info.isFile()) entries[relative(base, path).replaceAll('\\', '/')] = fileHash(path);
  }
  return entries;
}
function component(paths: string[], version: string) {
  const hashes = Object.fromEntries(paths.map(path => [path, fileHash(join(root, path))]));
  return { version, sha256: hash(JSON.stringify(hashes)), files: hashes };
}
function caseFiles(c: LoadedCase): Record<string, string> {
  const config = c.config;
  const names = new Set(['case.json', config.input, config.fixture, config.initial_state, config.acceptance]);
  if (config.brief) names.add(config.brief);
  if (config.execution) {
    names.add(config.execution.private_tests);
    for (const file of Object.values(config.execution.public_files)) names.add(file);
  }
  for (const name of ['gold.md', 'solve.ts']) if (existsSync(join(dirname(c.file), name))) names.add(name);
  return Object.fromEntries([...names].sort().map(name => [name, fileHash(join(dirname(c.file), name))]));
}
function imageDigest(image: string): string {
  const result = spawnSync('docker', ['image', 'inspect', '--format', '{{.Id}}', image], { encoding: 'utf8', timeout: 10000 });
  return result.status === 0 && /^sha256:[a-f0-9]{64}$/.test(result.stdout.trim()) ? result.stdout.trim() : 'unknown';
}
function productRevision(experiment: ExperimentConfig): string {
  const path = experiment.product.path;
  if (typeof path !== 'string' || !path) return 'unknown';
  const result = spawnSync('git', ['-C', path, 'rev-parse', 'HEAD'], { encoding: 'utf8', timeout: 5000 });
  return result.status === 0 && /^[a-f0-9]{40}$/.test(result.stdout.trim()) ? result.stdout.trim() : 'unknown';
}
export function createManifest(options: Options, cases: LoadedCase[], experiment: ExperimentConfig) {
  const version = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version as string;
  const suiteFile = join(options.casesDir, options.suite, 'suite.json');
  const suite = JSON.parse(readFileSync(suiteFile, 'utf8'));
  const adapterFiles: Record<string, string[]> = {
    stub: ['src/process.ts', 'src/stub.ts'], oracle: ['src/oracle.ts'],
    container: ['src/container.ts'], 'jackson-bot-pi': ['src/jackson-bot-pi.ts'],
  };
  const images = [...new Set(cases.flatMap(c => c.config.execution ? [c.config.execution.image] : []))].sort();
  return {
    schema_version: 1,
    suite: { name: options.suite, version: suite.version ?? 'unknown', schema_version: suite.schema_version, sha256: fileHash(suiteFile) },
    cases: cases.map(c => ({ id: c.config.id, version: c.config.version, image: c.config.execution?.image ?? null, files: caseFiles(c) })),
    adapter: { name: options.agent, ...component(adapterFiles[options.agent] ?? [], version) },
    verifier: component(['src/verifier.ts', 'src/verifier-worker.ts', 'src/criteria.ts', 'src/file-verifier.ts', 'src/tool-verifier.ts'], version),
    harness: component(readdirSync(join(root, 'src')).filter(name => name.endsWith('.ts') || name.endsWith('.cjs')).sort().map(name => `src/${name}`), version),
    product_revision: productRevision(experiment),
    effective_config: { experiment, suite: options.suite, case_ids: cases.map(c => c.config.id), fail_fast: options.failFast, repeat: (options as Options & { repeat?: number }).repeat ?? 1 },
    experiment_sha256: fileHash(options.experimentFile),
    // loadExperiment projects known fields. Hash any additional top-level fields
    // without copying potentially secret values into another run artifact.
    experiment_extra_fields: Object.fromEntries(Object.entries(JSON.parse(readFileSync(options.experimentFile, 'utf8')))
      .filter(([key]) => !['adapter', 'model', 'product'].includes(key))
      .map(([key, value]) => [key, hash(JSON.stringify(value))])),
    model: experiment.model ?? 'unknown', sampling: experiment.product.sampling ?? 'unknown',
    platform: { os: platform(), release: release(), arch: arch(), node: process.version },
    images: Object.fromEntries(images.map(image => [image, imageDigest(image)])),
    images_used: {} as Record<string, string>,
    artifacts: {} as Record<string, string>,
  };
}
export type RunManifest = ReturnType<typeof createManifest>;

// Inspect the recorded files before parsing current suite/case JSON, so even a
// malformed or version-mismatched input produces a useful reproducibility diff.
export function compareSourceFiles(expected: RunManifest, casesDir: string, suite: string, refs: CaseRef[]): string[] {
  const differences: string[] = [];
  function check(label: string, base: string, name: string, recorded: string): void {
    try {
      const current = fileHash(localFile(base, name, label));
      if (recorded !== current) differences.push(`${label}: recorded=${recorded} current=${current}`);
    } catch (error) { differences.push(`${label}: recorded=${recorded} current=unavailable (${(error as Error).message})`); }
  }
  identifier(suite, 'suite');
  check('suite.sha256', casesDir, `${suite}/suite.json`, expected.suite.sha256);
  for (const c of expected.cases) {
    const ref = refs.find(item => item.id === c.id);
    if (!ref) { differences.push(`case ${c.id}: recorded reference missing`); continue; }
    identifier(ref.id, 'case'); const source = identifier(ref.source ?? suite, 'case source');
    const base = join(casesDir, source, ref.id);
    for (const [name, digest] of Object.entries(c.files)) check(`case ${c.id} ${name}`, base, name, digest);
  }
  return differences;
}

// Comparison covers all reproducibility inputs, not output hashes or run paths.
export function compareManifest(expected: RunManifest, actual: RunManifest): string[] {
  const differences: string[] = [];
  function walk(path: string, a: unknown, b: unknown): void {
    if (a && b && typeof a === 'object' && typeof b === 'object') {
      const left = a as Record<string, unknown>; const right = b as Record<string, unknown>;
      for (const key of [...new Set([...Object.keys(left), ...Object.keys(right)])].sort()) walk(path ? `${path}.${key}` : key, left[key], right[key]);
    } else if (JSON.stringify(a) !== JSON.stringify(b)) differences.push(`${path}: recorded=${JSON.stringify(a) ?? 'missing'} current=${JSON.stringify(b) ?? 'missing'}`);
  }
  const { artifacts: _before, images_used: _beforeImages, ...before } = expected;
  const { artifacts: _after, images_used: _afterImages, ...after } = actual;
  walk('', before, after);
  return differences;
}

// Compare the digest actually used for each trial to a preflight inspection,
// either of the original run or of the local image at rerun time.
export function compareUsedImages(manifest: RunManifest, images: Record<string, string> = manifest.images): string[] {
  const differences: string[] = [];
  for (const [path, used] of Object.entries(manifest.images_used ?? {})) {
    const caseId = /^cases\/([^/]+)\//.exec(path)?.[1];
    const image = manifest.cases.find(c => c.id === caseId)?.image;
    const current = image ? images[image] ?? 'unknown' : 'unknown';
    if (current === 'unknown') differences.push(`${path}: used=${used}, image ${image ?? 'unknown'} current digest unknown; match cannot be verified`);
    else if (used !== current) differences.push(`${path}: image ${image} used=${used} current=${current}`);
  }
  return differences;
}

export function writeManifest(dir: string, manifest: RunManifest): void {
  const artifacts = files(dir); delete artifacts['manifest.json']; delete artifacts['manifest.json.tmp'];
  const imagesUsed: Record<string, string> = {};
  for (const path of Object.keys(artifacts)) {
    if (!path.startsWith('cases/') || !path.endsWith('/container.json')) continue;
    try {
      const data = JSON.parse(readFileSync(join(dir, path), 'utf8'));
      if ((data.role === 'agent' || data.role === 'verifier') && typeof data.image === 'string' && /^sha256:[a-f0-9]{64}$/.test(data.image)) imagesUsed[path] = data.image;
    } catch { /* Preserve a malformed log as an artifact without inventing a digest. */ }
  }
  json(join(dir, 'manifest.json'), { ...manifest, images_used: imagesUsed, artifacts });
}
