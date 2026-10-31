import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

const repoRoot = join(import.meta.dirname, '..');
const bundle = join(repoRoot, 'tracks/skill/fixtures/verify-mini');

function git(cwd: string, ...args: string[]): string {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return result.stdout.trim();
}

function readJson(file: string): any {
  return JSON.parse(readFileSync(file, 'utf8'));
}

function evalCli(args: string[], env?: NodeJS.ProcessEnv) {
  return spawnSync(process.execPath, [join(repoRoot, 'src/eval.ts'), ...args], {
    cwd: repoRoot,
    encoding: 'utf8',
    timeout: 20_000,
    env: { ...process.env, ...env },
  });
}

function runDir(stdout: string): string {
  const match = /^Run directory: (.+)$/m.exec(stdout);
  assert.ok(match, stdout);
  return match[1];
}

function scaffold() {
  const root = mkdtempSync(join(tmpdir(), 'agent-eval-verify-'));
  const runs = join(root, 'runs');
  mkdirSync(runs);
  return {
    root,
    runs,
    cleanup() {
      rmSync(root, { recursive: true, force: true });
    },
  };
}

function writeCard(root: string, id: string, body: string, base = 'a'.repeat(40)) {
  const dir = join(root, 'tasks', id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'card.yaml'), `schema_version: 1
id: ${id}
status: replay-ready
public:
  requirement: |
    Add hello.txt that says replayed.
  repo:
    id: example/widget
    host: other
  base_commit: "${base}"
private:
  interventions:
    status: unknown
${body}`);
}

function tree(dir: string, files: Record<string, string>) {
  mkdirSync(dir, { recursive: true });
  for (const [name, text] of Object.entries(files)) {
    const file = join(dir, name);
    mkdirSync(join(file, '..'), { recursive: true });
    writeFileSync(file, text);
  }
}

function verifyArgs(env: { root: string; runs: string }, id: string, extra: string[]) {
  return ['verify', id, '--root', env.root, '--runs-dir', env.runs, '--verify', bundle, ...extra];
}

const verifyPath = `  verify:
    status: path
    path: verify/SENTINEL_verify_entry
`;

test('verify help names the five scores and does not treat unavailable as fail', () => {
  const help = evalCli(['verify', '--help']);
  assert.equal(help.status, 0, help.stderr);
  assert.match(help.stdout, /Launch, Doctor, Drive, Evidence, and Cleanup/);
  assert.match(help.stdout, /feature fail/);
  assert.match(help.stdout, /verifier error/);
  assert.match(help.stdout, /unavailable/);
  assert.match(help.stdout, /interrupted/);
  assert.match(help.stdout, /exit 0/);
  assert.match(help.stdout, /feature fail exits 1/);
  assert.match(help.stdout, /outside the variant workspace/);
});

test('fixture outcomes pass, feature fail, verifier error, unavailable, and interrupted leave evidence', async () => {
  const env = scaffold();
  try {
    writeCard(env.root, 'pass-card', `${verifyPath}  merge:\n    status: "N/A"\n    reason: "Chat-only capture; nothing was merged."\n`);
    writeCard(env.root, 'fail-card', verifyPath);
    writeCard(env.root, 'crash-card', verifyPath);
    writeCard(env.root, 'invalid-card', verifyPath);
    writeCard(env.root, 'none-card', '  verify:\n    status: none\n');
    writeCard(env.root, 'missing-card', '  provenance:\n    kind: file\n    ref: tasks/missing-card/source.md\n');
    writeCard(env.root, 'todo-card', '  verify:\n    status: todo\n    reason: "Verify is not written yet."\n');
    writeCard(env.root, 'sleep-card', verifyPath);

    const passWs = join(env.root, 'pass-ws');
    const failWs = join(env.root, 'fail-ws');
    const crashWs = join(env.root, 'crash-ws');
    const invalidWs = join(env.root, 'invalid-ws');
    const sleepWs = join(env.root, 'sleep-ws');
    const files = { 'README': 'base\n', 'hello.txt': 'replayed\n' };
    tree(passWs, files);
    tree(failWs, { ...files, 'hello.txt': 'broken\n' });
    tree(crashWs, { ...files, '.verify-crash': '1\n' });
    tree(invalidWs, { ...files, '.verify-invalid': '1\n' });
    tree(sleepWs, { ...files, '.verify-sleep': '1\n' });
    tree(join(failWs, 'phases'), { evidence: '#!/bin/sh\necho used-workspace-verify > "$VERIFY_WORKSPACE/used-workspace-verify"\n' });
    chmodSync(join(failWs, 'phases', 'evidence'), 0o755);

    const pass = evalCli(verifyArgs(env, 'pass-card', ['--variant', `without=${passWs}`]));
    assert.equal(pass.status, 0, pass.stderr + pass.stdout);
    const passDir = runDir(pass.stdout);
    const passResult = readJson(join(passDir, 'variants', 'without', 'verify', 'result.json'));
    assert.equal(passResult.score, 'pass');
    assert.equal(passResult.score_reason, 'hard features passed');
    assert.equal(passResult.pin.id, 'verify-mini');
    assert.equal(passResult.pin.version, '1.0.0');
    assert.equal(typeof passResult.pin.digest, 'string');
    for (const phase of ['launch', 'doctor', 'drive', 'evidence', 'cleanup']) {
      assert.equal(readJson(join(passDir, 'variants', 'without', 'verify', 'phases', phase, 'status.json')).status, 'ok', phase);
    }
    assert.equal(existsSync(join(passDir, 'variants', 'without', 'verify', 'evidence', 'skill-result.json')), true);
    assert.equal(existsSync(join(passDir, 'variants', 'without', 'verify', 'evidence', 'validated.json')), true);
    assert.equal(existsSync(join(passDir, 'variants', 'without', 'verify', 'input.json')), true);
    assert.equal(existsSync(join(passDir, 'verify', 'comparison.json')), true);
    assert.equal(existsSync(join(passDir, 'verify', 'pin.json')), true);
    assert.equal(existsSync(join(passDir, 'verify', 'features-map.json')), true);
    assert.equal(existsSync(join(passDir, 'verify', 'bundle', 'phases', 'evidence')), true);
    assert.match(readFileSync(join(passDir, 'variants', 'without', 'verify', 'evidence', 'phases.log'), 'utf8'), /launch\ndoctor\ndrive\ncleanup\n/);
    assert.equal(readJson(join(passDir, 'reference', 'verify', 'result.json')).score, 'unavailable');
    assert.match(pass.stdout, /reference: score=unavailable/);
    assert.equal(existsSync(join(passDir, 'reference', 'workspace')), false);
    const validated = readJson(join(passDir, 'variants', 'without', 'verify', 'evidence', 'validated.json'));
    assert.equal(validated.find((feature: { id: string }) => feature.id === 'hello-file').mode, 'hard');
    assert.equal(validated.find((feature: { id: string }) => feature.id === 'readme-untouched').mode, 'diagnostic');

    const fail = evalCli(verifyArgs(env, 'fail-card', ['--variant', `without=${failWs}`]));
    assert.equal(fail.status, 1, fail.stderr + fail.stdout);
    const failResult = readJson(join(runDir(fail.stdout), 'variants', 'without', 'verify', 'result.json'));
    assert.equal(failResult.score, 'feature fail');
    assert.match(failResult.score_reason, /hello-file/);
    assert.equal(existsSync(join(failWs, 'used-workspace-verify')), false);
    assert.notEqual(fail.status, pass.status);

    const crash = evalCli(verifyArgs(env, 'crash-card', ['--variant', `without=${crashWs}`]));
    assert.equal(crash.status, 2, crash.stderr + crash.stdout);
    const crashResult = readJson(join(runDir(crash.stdout), 'variants', 'without', 'verify', 'result.json'));
    assert.equal(crashResult.score, 'verifier error');
    assert.notEqual(crashResult.score, 'feature fail');
    assert.notEqual(crashResult.score, 'pass');
    assert.match(readFileSync(join(runDir(crash.stdout), 'variants', 'without', 'verify', 'phases', 'evidence', 'stderr.log'), 'utf8'), /verifier blew up/);
    assert.equal(readJson(join(runDir(crash.stdout), 'variants', 'without', 'verify', 'phases', 'cleanup', 'status.json')).status, 'ok');

    const invalid = evalCli(verifyArgs(env, 'invalid-card', ['--variant', `without=${invalidWs}`]));
    assert.equal(invalid.status, 2, invalid.stderr + invalid.stdout);
    const invalidDir = runDir(invalid.stdout);
    assert.equal(readJson(join(invalidDir, 'variants', 'without', 'verify', 'result.json')).score, 'verifier error');
    assert.equal(existsSync(join(invalidDir, 'variants', 'without', 'verify', 'evidence', 'invalid.json')), true);
    assert.equal(existsSync(join(invalidDir, 'variants', 'without', 'verify', 'evidence', 'validated.json')), false);

    for (const [id, kind] of [['none-card', 'none'], ['missing-card', 'missing'], ['todo-card', 'todo']] as const) {
      const unavailable = evalCli(['verify', id, '--root', env.root, '--runs-dir', env.runs, '--verify', bundle, '--variant', `without=${failWs}`]);
      assert.equal(unavailable.status, 0, unavailable.stderr + unavailable.stdout);
      assert.notEqual(unavailable.status, fail.status);
      const result = readJson(join(runDir(unavailable.stdout), 'verify', 'result.json'));
      assert.equal(result.score, 'unavailable');
      assert.match(result.score_reason, new RegExp(`card verify is ${kind}`));
      assert.equal(result.pin, null);
      assert.equal(existsSync(join(runDir(unavailable.stdout), 'variants')), false);
      assert.match(unavailable.stdout, /score=unavailable/);
    }

    const child = spawn(process.execPath, [join(repoRoot, 'src/eval.ts'), ...verifyArgs(env, 'sleep-card', ['--variant', `without=${sleepWs}`])], {
      cwd: repoRoot,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    child.stdout.on('data', (chunk) => { output += chunk; });
    child.stderr.on('data', (chunk) => { output += chunk; });
    const done = new Promise<number | null>((resolve) => child.on('close', resolve));
    const started = Date.now();
    let saw = false;
    while (!saw) {
      if (Date.now() - started > 8000) throw new Error(`drive did not start\n${output}`);
      saw = readdirSync(env.runs).some(id => existsSync(join(env.runs, id, 'variants', 'without', 'verify', 'evidence', 'driving')));
      if (!saw) await new Promise((resolve) => setTimeout(resolve, 25));
    }
    let code: number | null = null;
    try {
      child.kill('SIGINT');
      code = await Promise.race([
        done,
        new Promise<number>((_, reject) => setTimeout(() => reject(new Error(`verify did not stop\n${output}`)), 5000)),
      ]);
    } finally {
      child.kill('SIGKILL');
    }
    assert.equal(code, 3, output);
    const interrupted = readJson(join(runDir(output), 'variants', 'without', 'verify', 'result.json'));
    assert.equal(interrupted.score, 'interrupted');
    assert.match(interrupted.score_reason, /drive/);
    assert.equal(readJson(join(runDir(output), 'variants', 'without', 'verify', 'phases', 'drive', 'status.json')).status, 'interrupted');
    assert.match(readFileSync(join(runDir(output), 'variants', 'without', 'verify', 'evidence', 'phases.log'), 'utf8'), /cleanup/);
    assert.notEqual(code, 1);
  } finally {
    env.cleanup();
  }
});

test('a phase that cannot score stays unavailable when the tree would otherwise fail', () => {
  const env = scaffold();
  try {
    writeCard(env.root, 'doctor-card', verifyPath);
    const workspace = join(env.root, 'doctor-ws');
    tree(workspace, { README: 'base\n', 'hello.txt': 'broken\n', '.verify-unavailable': '1\n' });
    const result = evalCli(verifyArgs(env, 'doctor-card', ['--variant', `without=${workspace}`]));
    assert.equal(result.status, 0, result.stderr + result.stdout);
    assert.notEqual(result.status, 1);
    const dir = runDir(result.stdout);
    const score = readJson(join(dir, 'variants', 'without', 'verify', 'result.json'));
    assert.equal(score.score, 'unavailable');
    assert.match(score.score_reason, /doctor/);
    assert.equal(readJson(join(dir, 'variants', 'without', 'verify', 'phases', 'doctor', 'status.json')).status, 'unavailable');
    assert.equal(readJson(join(dir, 'variants', 'without', 'verify', 'phases', 'drive', 'status.json')).status, 'skipped');
    assert.equal(readJson(join(dir, 'variants', 'without', 'verify', 'phases', 'cleanup', 'status.json')).status, 'ok');
  } finally {
    env.cleanup();
  }
});

test('diagnostic drift does not change a pass, and a pin inside the workspace is a verifier error', () => {
  const env = scaffold();
  try {
    writeCard(env.root, 'drift-card', verifyPath);
    const workspace = join(env.root, 'drift-ws');
    tree(workspace, { 'README': 'changed\n', 'hello.txt': 'replayed\n' });
    const drift = evalCli(verifyArgs(env, 'drift-card', ['--variant', `without=${workspace}`]));
    assert.equal(drift.status, 0, drift.stderr + drift.stdout);
    const result = readJson(join(runDir(drift.stdout), 'variants', 'without', 'verify', 'result.json'));
    assert.equal(result.score, 'pass');
    assert.equal(result.features.find((feature: { id: string }) => feature.id === 'readme-untouched').passed, false);

    writeCard(env.root, 'inside-card', verifyPath);
    const insideWs = join(env.root, 'inside-ws');
    tree(insideWs, { 'README': 'base\n', 'hello.txt': 'replayed\n' });
    cpSync(bundle, join(insideWs, 'bundled-verify'), { recursive: true });
    const inside = evalCli(['verify', 'inside-card', '--root', env.root, '--runs-dir', env.runs, '--verify', join(insideWs, 'bundled-verify'), '--variant', `without=${insideWs}`]);
    assert.equal(inside.status, 2, inside.stderr + inside.stdout);
    const rejected = readJson(join(runDir(inside.stdout), 'variants', 'without', 'verify', 'result.json'));
    assert.equal(rejected.score, 'verifier error');
    assert.match(rejected.score_reason, /outside the variant workspace/);
    assert.notEqual(rejected.score, 'pass');
  } finally {
    env.cleanup();
  }
});

test('a version mismatch is a verifier error, and the sample card without verify does not fail', () => {
  const env = scaffold();
  try {
    const broken = join(env.root, 'broken-pin');
    cpSync(bundle, broken, { recursive: true });
    const map = readJson(join(broken, 'features-map.json'));
    map.version = '9.9.9';
    writeFileSync(join(broken, 'features-map.json'), `${JSON.stringify(map, null, 2)}\n`);
    writeCard(env.root, 'mismatch-card', verifyPath);
    const workspace = join(env.root, 'mismatch-ws');
    tree(workspace, { 'README': 'base\n', 'hello.txt': 'broken\n' });
    const mismatch = evalCli(['verify', 'mismatch-card', '--root', env.root, '--runs-dir', env.runs, '--verify', broken, '--variant', `without=${workspace}`]);
    assert.equal(mismatch.status, 2, mismatch.stderr + mismatch.stdout);
    const result = readJson(join(runDir(mismatch.stdout), 'variants', 'without', 'verify', 'result.json'));
    assert.equal(result.score, 'verifier error');
    assert.match(result.score_reason, /does not match/);
    assert.notEqual(result.score, 'feature fail');

    const runs = mkdtempSync(join(tmpdir(), 'agent-eval-verify-sample-'));
    try {
      const sample = evalCli(['verify', 'e0-e2-stub-smoke', '--root', repoRoot, '--runs-dir', runs]);
      assert.equal(sample.status, 0, sample.stderr + sample.stdout);
      assert.notEqual(sample.status, 1);
      const sampleResult = readJson(join(runDir(sample.stdout), 'verify', 'result.json'));
      assert.equal(sampleResult.score, 'unavailable');
      assert.match(sampleResult.score_reason, /none/);
    } finally {
      rmSync(runs, { recursive: true, force: true });
    }
  } finally {
    env.cleanup();
  }
});

test('merge reference uses the same pin, and chat-only leaves the reference unavailable', () => {
  const env = scaffold();
  const repo = join(env.root, 'widget');
  try {
    mkdirSync(repo);
    git(repo, 'init', '-q');
    git(repo, 'config', 'user.email', 'verify@example.com');
    git(repo, 'config', 'user.name', 'verify');
    writeFileSync(join(repo, 'README'), 'base\n');
    git(repo, 'add', 'README');
    git(repo, 'commit', '-q', '-m', 'base');
    const base = git(repo, 'rev-parse', 'HEAD');
    writeFileSync(join(repo, 'hello.txt'), 'replayed\n');
    writeFileSync(join(repo, 'other.txt'), 'merge\n');
    git(repo, 'add', 'hello.txt', 'other.txt');
    git(repo, 'commit', '-q', '-m', 'merge');
    const merge = git(repo, 'rev-parse', 'HEAD');

    const checkout = (sha: string, dest: string) => {
      mkdirSync(dest, { recursive: true });
      git(dest, 'init', '-q');
      git(dest, 'fetch', '-q', '--no-tags', repo, sha);
      git(dest, 'checkout', '-q', '--detach', 'FETCH_HEAD');
    };
    const failWs = join(env.root, 'fail-ws');
    const passWs = join(env.root, 'pass-ws');
    checkout(base, failWs);
    checkout(base, passWs);
    writeFileSync(join(failWs, 'hello.txt'), 'broken\n');
    writeFileSync(join(passWs, 'hello.txt'), 'replayed\n');

    writeCard(env.root, 'merged-card', `${verifyPath}  merge:\n    sha: "${merge}"\n`, base);
    const scored = evalCli([
      ...verifyArgs(env, 'merged-card', ['--variant', `without=${failWs}`, '--variant', `with-skill=${passWs}`]),
      '--repo-dir', repo,
    ]);
    assert.equal(scored.status, 1, scored.stderr + scored.stdout);
    const dir = runDir(scored.stdout);
    const failed = readJson(join(dir, 'variants', 'without', 'verify', 'result.json'));
    const passed = readJson(join(dir, 'variants', 'with-skill', 'verify', 'result.json'));
    const reference = readJson(join(dir, 'reference', 'verify', 'result.json'));
    assert.equal(failed.score, 'feature fail');
    assert.equal(passed.score, 'pass');
    assert.equal(reference.score, 'pass');
    assert.equal(failed.pin.digest, passed.pin.digest);
    assert.equal(passed.pin.digest, reference.pin.digest);
    assert.equal(readJson(join(dir, 'verify', 'pin.json')).digest, failed.pin.digest);
    const overlap = readJson(join(dir, 'variants', 'without', 'verify', 'overlap.json'));
    assert.equal(overlap.status, 'recorded');
    assert.match(overlap.note, /not a score/);
    assert.equal(overlap.overlap.includes('hello.txt'), true);
    assert.equal(Object.hasOwn(overlap, 'similarity'), false);
    assert.equal(JSON.stringify(overlap).includes('similarity'), false);
    assert.equal(existsSync(join(dir, 'reference', 'workspace', 'hello.txt')), true);

    writeCard(env.root, 'chat-card', `${verifyPath}  merge:\n    status: "N/A"\n    reason: "Chat-only capture; nothing was merged."\n`, base);
    const chat = evalCli(verifyArgs(env, 'chat-card', ['--variant', `without=${passWs}`, '--repo-dir', repo]));
    assert.equal(chat.status, 0, chat.stderr + chat.stdout);
    const chatDir = runDir(chat.stdout);
    assert.equal(readJson(join(chatDir, 'variants', 'without', 'verify', 'result.json')).score, 'pass');
    assert.equal(readJson(join(chatDir, 'reference', 'verify', 'result.json')).score, 'unavailable');
    assert.match(readJson(join(chatDir, 'reference', 'verify', 'result.json')).score_reason, /no merge/);
    assert.equal(existsSync(join(chatDir, 'reference', 'workspace')), false);
    assert.equal(existsSync(join(chatDir, 'variants', 'without', 'verify', 'overlap.json')), false);
    assert.match(chat.stdout, /reference: score=unavailable/);
  } finally {
    env.cleanup();
  }
});

test('verify after replay scores the variant workspace and leaves the replay score unavailable', () => {
  const env = scaffold();
  const repo = join(env.root, 'widget');
  try {
    mkdirSync(repo);
    git(repo, 'init', '-q');
    git(repo, 'config', 'user.email', 'verify@example.com');
    git(repo, 'config', 'user.name', 'verify');
    writeFileSync(join(repo, 'README'), 'base\n');
    git(repo, 'add', 'README');
    git(repo, 'commit', '-q', '-m', 'base');
    const base = git(repo, 'rev-parse', 'HEAD');
    writeFileSync(join(repo, 'hello.txt'), 'replayed\n');
    writeFileSync(join(repo, 'other.txt'), 'merge\n');
    git(repo, 'add', 'hello.txt', 'other.txt');
    git(repo, 'commit', '-q', '-m', 'merge');
    const merge = git(repo, 'rev-parse', 'HEAD');
    const agent = join(env.root, 'agent.mjs');
    writeFileSync(agent, `#!/usr/bin/env node
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
const args = process.argv.slice(2);
const workspace = args[args.indexOf('--workspace') + 1];
writeFileSync(join(workspace, 'hello.txt'), 'replayed\\n');
process.exit(0);
`);
    chmodSync(agent, 0o755);
    const skill = join(env.root, 'focus');
    mkdirSync(skill);
    writeFileSync(join(skill, 'SKILL.md'), '---\nname: focus\n---\nFocus.\n');
    writeCard(env.root, 'replay-card', `${verifyPath}  merge:\n    sha: "${merge}"\n    diff_stats:\n      files: 2\n      additions: 2\n      deletions: 0\n`, base);
    const replay = evalCli([
      'replay', 'replay-card',
      '--root', env.root,
      '--runs-dir', env.runs,
      '--repo-dir', repo,
      '--agent-bin', agent,
      '--variant', 'without',
      '--case', 'without',
    ]);
    assert.equal(replay.status, 0, replay.stderr + replay.stdout);
    const replayed = runDir(replay.stdout);
    assert.equal(readJson(join(replayed, 'variants', 'without', 'result.json')).score, 'unavailable');
    assert.equal(readFileSync(join(replayed, 'variants', 'without', 'prompt.txt'), 'utf8').includes('SENTINEL_verify_entry'), false);

    const scored = evalCli([
      'verify', 'replay-card',
      '--root', env.root,
      '--runs-dir', env.runs,
      '--run', replay.stdout.match(/^Run (\S+)/m)?.[1] ?? '',
      '--verify', bundle,
      '--repo-dir', repo,
    ]);
    assert.equal(scored.status, 0, scored.stderr + scored.stdout);
    assert.equal(readJson(join(replayed, 'variants', 'without', 'result.json')).score, 'unavailable');
    const verifyResult = readJson(join(replayed, 'variants', 'without', 'verify', 'result.json'));
    assert.equal(verifyResult.score, 'pass');
    const reference = readJson(join(replayed, 'reference', 'verify', 'result.json'));
    assert.equal(reference.score, 'pass');
    assert.equal(verifyResult.pin.digest, reference.pin.digest);
    const overlap = readJson(join(replayed, 'variants', 'without', 'verify', 'overlap.json'));
    assert.equal(overlap.overlap.includes('hello.txt'), true);
    assert.equal(JSON.stringify(overlap).includes('similarity'), false);
  } finally {
    env.cleanup();
  }
});
