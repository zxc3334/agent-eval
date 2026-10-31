import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { test } from 'node:test';
import { identifier, repoPaths, writeJson } from '../packages/core/src/config.ts';
import { reservedEvidenceHooks } from '../packages/core/src/evidence.ts';
import { createRunDir } from '../packages/core/src/runs.ts';

const root = resolve('.');

function walk(dir: string): string[] {
  const files: string[] = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) files.push(...walk(path));
    else files.push(path);
  }
  return files;
}

function importsSpec(source: string, spec: string): boolean {
  const pattern = new RegExp(String.raw`(?:from\s+|import\s*\()\s*['"][^'"]*${spec}[^'"]*['"]`);
  return pattern.test(source);
}

function evalCli(args: string[]) {
  return spawnSync(process.execPath, ['src/eval.ts', ...args], { encoding: 'utf8', cwd: root });
}

test('pnpm eval --help lists the mounted skill command and placeholder tracks', () => {
  const help = evalCli(['--help']);
  assert.equal(help.status, 0, help.stderr);
  assert.match(help.stdout, /pnpm eval --help/);
  assert.match(help.stdout, /pnpm eval <command>/);
  assert.match(help.stdout, /skill —/);
  assert.match(help.stdout, /noop —/);
  assert.match(help.stdout, /agent —/);
  assert.match(help.stdout, /model —/);
  assert.match(help.stdout, /not mounted/);
  assert.match(help.stdout, /skill track only/);
  assert.equal(help.stdout.includes('smoke-pass'), false);
});

test('no args prints help; noop is mounted; unknown commands exit 2', () => {
  const bare = evalCli([]);
  assert.equal(bare.status, 0, bare.stderr);
  assert.match(bare.stdout, /Mounted tracks:/);

  const noop = evalCli(['noop']);
  assert.equal(noop.status, 0, noop.stderr);
  assert.match(noop.stdout, /skill noop: ok/);

  const help = evalCli(['--help']);
  assert.match(help.stdout, /replay —/);

  const unknown = evalCli(['compare']);
  assert.equal(unknown.status, 2);
  assert.match(unknown.stderr, /unknown command: compare/);

  const extra = evalCli(['noop', 'extra']);
  assert.equal(extra.status, 2);
  assert.match(extra.stderr, /noop: no arguments/);
});

test('scaffold directories are present for a clean clone', () => {
  for (const file of [
    'packages/core/package.json',
    'tracks/skill/package.json',
    'tracks/skill/src/index.ts',
    'tracks/agent/README.md',
    'tracks/model/README.md',
    'tasks/README.md',
    'runs/.gitkeep',
    'docs/repo-layout.md',
    'src/eval.ts',
  ]) {
    assert.equal(statSync(join(root, file)).isFile(), true, file);
  }
  const ignored = spawnSync('git', ['check-ignore', 'runs/example.json'], { encoding: 'utf8', cwd: root });
  assert.equal(ignored.status, 0, ignored.stderr);
  const kept = spawnSync('git', ['check-ignore', 'runs/.gitkeep'], { encoding: 'utf8', cwd: root });
  assert.equal(kept.status, 1, kept.stdout);
});

test('agent and model are README placeholders and do not import skill', () => {
  for (const track of ['agent', 'model']) {
    const dir = join(root, 'tracks', track);
    const files = walk(dir).map(file => relative(dir, file));
    assert.deepEqual(files, ['README.md']);
    const text = readFileSync(join(dir, 'README.md'), 'utf8');
    assert.equal(importsSpec(text, 'tracks/skill'), false);
    assert.equal(importsSpec(text, '@agent-eval/skill'), false);
    assert.equal(text.includes('@agent-eval/skill'), true);
  }
});

test('core does not import tracks; skill does not import agent or model', () => {
  const core = walk(join(root, 'packages/core')).filter(file => file.endsWith('.ts'));
  assert.ok(core.length > 0);
  for (const file of core) {
    const text = readFileSync(file, 'utf8');
    assert.equal(importsSpec(text, 'tracks/skill'), false, file);
    assert.equal(importsSpec(text, 'tracks/agent'), false, file);
    assert.equal(importsSpec(text, 'tracks/model'), false, file);
    assert.equal(importsSpec(text, '@agent-eval/skill'), false, file);
  }
  const skill = readFileSync(join(root, 'tracks/skill/src/index.ts'), 'utf8');
  assert.equal(importsSpec(skill, 'tracks/agent'), false);
  assert.equal(importsSpec(skill, 'tracks/model'), false);
  assert.equal(importsSpec(skill, 'packages/core/'), true);
});

test('run directories, reserved evidence hooks, and config primitives', () => {
  const temp = mkdtempSync(join(tmpdir(), 'agent-eval-layout-'));
  try {
    const paths = repoPaths(temp);
    assert.equal(paths.tasksDir, join(temp, 'tasks'));
    assert.equal(paths.runsDir, join(temp, 'runs'));
    assert.equal(identifier('smoke-pass', 'case'), 'smoke-pass');
    assert.throws(() => identifier('../x', 'case'), /invalid identifier/);

    const seen: string[] = [];
    const run = createRunDir(paths.runsDir, [
      ...reservedEvidenceHooks(),
      { name: 'probe', onRunCreated(created) { seen.push(created.id); } },
    ]);
    assert.equal(seen[0], run.id);
    assert.equal(statSync(run.dir).isDirectory(), true);
    assert.deepEqual(readdirSync(run.dir), []);

    writeJson(join(temp, 'sample.json'), { ok: true });
    assert.deepEqual(JSON.parse(readFileSync(join(temp, 'sample.json'), 'utf8')), { ok: true });
    assert.equal(existsSync(join(temp, 'sample.json.tmp')), false);
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});
