import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { summarizeCursorStream } from '../tracks/skill/src/cursor-agent.ts';
import type { StreamEvent } from '../tracks/skill/src/cursor-agent.ts';

const repoRoot = join(import.meta.dirname, '..');

function git(cwd: string, ...args: string[]): string {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return result.stdout.trim();
}

function writeAgent(dir: string): string {
  const file = join(dir, 'cursor-agent.mjs');
  writeFileSync(file, `#!/usr/bin/env node
import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const args = process.argv.slice(2);
const workspaceFlag = args.indexOf('--workspace');
if (workspaceFlag === -1 || args[workspaceFlag + 1] === undefined) {
  console.error('missing --workspace');
  process.exit(2);
}
const workspace = args[workspaceFlag + 1];
const prompt = args[args.length - 1];
const format = args.indexOf('--output-format');
if (!args.includes('--print') || format === -1 || args[format + 1] !== 'stream-json' || !args.includes('--trust') || !args.includes('--')) {
  console.error('cursor agent contract mismatch');
  process.exit(2);
}
if (args.includes('--force')) {
  console.error('refusing to auto-approve');
  process.exit(2);
}
const hasSkill = existsSync(join(workspace, '.cursor', 'skills'));
writeFileSync(join(workspace, 'agent-saw.json'), JSON.stringify({ args, prompt, hasSkill, stdin: 'unread' }));
writeFileSync(join(workspace, 'hello.txt'), 'replayed\\n');
const mode = process.env.REPLAY_AGENT_MODE ?? 'ok';
if (mode === 'sleep') {
  setInterval(() => {}, 1000);
} else {
  const events = [
    { type: 'system', subtype: 'init', model: 'composer' },
    { type: 'user', message: { content: [{ type: 'text', text: prompt }] } },
    { type: 'assistant', message: { content: [{ type: 'text', text: 'wrote hello.txt' }] } },
    { type: 'interaction', subtype: 'request', text: 'Which name should the file use?' },
    { type: 'tool_call', subtype: 'completed', tool_call: { writeToolCall: { args: { path: 'hello.txt' } } } },
    { type: 'result', subtype: 'success', result: 'done' },
  ];
  for (const event of events) process.stdout.write(JSON.stringify(event) + '\\n');
  process.exit(mode === 'fail-without' && !hasSkill ? 1 : 0);
}
`);
  chmodSync(file, 0o755);
  return file;
}

function evalCli(args: string[], env?: NodeJS.ProcessEnv) {
  return spawnSync(process.execPath, [join(repoRoot, 'src/eval.ts'), ...args], {
    cwd: repoRoot,
    encoding: 'utf8',
    timeout: 20_000,
    env: { ...process.env, ...env },
  });
}

function readJson(file: string): any {
  return JSON.parse(readFileSync(file, 'utf8'));
}

function runId(stdout: string): string {
  const match = /^Run (\S+)/m.exec(stdout);
  assert.ok(match, stdout);
  return match[1];
}

function collectText(dir: string): string {
  let text = '';
  const pending = [dir];
  while (pending.length > 0) {
    const current = pending.pop();
    if (!current) break;
    for (const name of readdirSync(current)) {
      if (name === '.git') continue;
      const path = join(current, name);
      let info;
      try {
        info = readdirSync(path);
      } catch {
        info = null;
      }
      if (info) pending.push(path);
      else {
        try {
          text += readFileSync(path, 'utf8');
        } catch {
          /* binary evidence stays out of the text scan */
        }
      }
    }
  }
  return text;
}

function prepare(): {
  root: string;
  runs: string;
  repo: string;
  base: string;
  later: string;
  agent: string;
  skill: string;
  taskId: string;
} {
  const root = mkdtempSync(join(tmpdir(), 'agent-eval-replay-'));
  const runs = join(root, 'runs');
  const repo = join(root, 'widget');
  mkdirSync(runs);
  mkdirSync(repo);
  git(repo, 'init', '-q');
  git(repo, 'config', 'user.email', 'replay@example.com');
  git(repo, 'config', 'user.name', 'replay');
  writeFileSync(join(repo, 'README'), 'base\n');
  git(repo, 'add', 'README');
  git(repo, 'commit', '-q', '-m', 'base');
  const base = git(repo, 'rev-parse', 'HEAD');
  writeFileSync(join(repo, 'secret.txt'), 'POST_BASE_SECRET\n');
  writeFileSync(join(repo, 'merged.diff'), 'MERGED_DIFF_SENTINEL\n');
  git(repo, 'add', 'secret.txt', 'merged.diff');
  git(repo, 'commit', '-q', '-m', 'later history');
  const later = git(repo, 'rev-parse', 'HEAD');
  const skill = join(root, 'focus');
  mkdirSync(skill);
  writeFileSync(join(skill, 'SKILL.md'), '---\nname: focus\n---\nSKILL_BODY_FOCUS\n');
  const taskId = 'widget-hello';
  const taskDir = join(root, 'tasks', taskId);
  mkdirSync(taskDir, { recursive: true });
  writeFileSync(join(taskDir, 'card.yaml'), `schema_version: 1
id: ${taskId}
status: replay-ready
public:
  requirement: |
    Add hello.txt that says replayed.
  repo:
    id: example/widget
    host: other
  base_commit: "${base}"
private:
  merge:
    sha: "${later}"
    diff_stats:
      files: 1
      additions: 424242
      deletions: 0
  interventions:
    records:
      - id: secret-fix
        summary: PRIVATE_INTERVENTION_SENTINEL
        confirmation: confirmed
        kind: intervention
`);
  return { root, runs, repo, base, later, agent: writeAgent(root), skill, taskId };
}

function replayArgs(env: ReturnType<typeof prepare>, extra: string[]): string[] {
  return [
    'replay', env.taskId,
    '--root', env.root,
    '--runs-dir', env.runs,
    '--repo-dir', env.repo,
    '--agent-bin', env.agent,
    '--variant', 'without',
    '--variant', `with-skill=${env.skill}`,
    ...extra,
  ];
}

function assertHidden(env: ReturnType<typeof prepare>, variantDir: string): void {
  const leaked = ['POST_BASE_SECRET', 'MERGED_DIFF_SENTINEL', 'PRIVATE_INTERVENTION_SENTINEL', env.later, '424242'];
  for (const file of ['prompt.txt', 'agent-input.json', 'invocation.json']) {
    const text = readFileSync(join(variantDir, file), 'utf8');
    for (const secret of leaked) assert.equal(text.includes(secret), false, `${file} leaked ${secret}`);
  }
  const workspace = join(variantDir, 'workspace');
  const visible = collectText(workspace);
  for (const secret of leaked) assert.equal(visible.includes(secret), false, `workspace leaked ${secret}`);
  const seen = git(workspace, 'rev-list', '--all').split('\n').filter(Boolean);
  assert.deepEqual(seen, [env.base]);
  assert.notEqual(spawnSync('git', ['-C', workspace, 'cat-file', '-e', `${env.later}^{commit}`]).status, 0);
  assert.equal(git(workspace, 'remote'), '');
  assert.equal(git(workspace, 'rev-parse', 'HEAD'), env.base);
  assert.equal(readFileSync(join(workspace, 'hello.txt'), 'utf8'), 'replayed\n');
}

test('cursor agent stream marks requests, actual answers, and unknown usage', () => {
  const request: StreamEvent = {
    type: 'interaction',
    subtype: 'request',
    raw: { type: 'interaction', subtype: 'request', text: 'Need a decision?' },
  };
  const question: StreamEvent = {
    type: 'tool_call',
    subtype: 'started',
    raw: { type: 'tool_call', tool_call: { AskQuestion: { args: { question: 'Rename it?' } } } },
  };
  const echoed: StreamEvent = { type: 'user', raw: { type: 'user', message: { content: 'prompt' } } };
  const human: StreamEvent = { type: 'user', raw: { type: 'user', message: { content: 'use the short name' } } };
  const bare = summarizeCursorStream([{ type: 'result', subtype: 'success', raw: { type: 'result', subtype: 'success' } }], { spawned: true, aborted: false });
  assert.equal(bare.usage.input_tokens, 'unknown');
  assert.equal(bare.usage.output_tokens, 'unknown');
  assert.equal(bare.interventions.intervention_request, 0);
  assert.equal(bare.interventions.actual_intervention, 0);
  const measured = summarizeCursorStream([{
    type: 'result',
    raw: { type: 'result', usage: { input_tokens: 0, outputTokens: 5 } },
  }], { spawned: true, aborted: false });
  assert.equal(measured.usage.input_tokens, 0);
  assert.equal(measured.usage.output_tokens, 5);
  const asked = summarizeCursorStream([echoed, request, question, human], { spawned: true, aborted: false });
  assert.equal(asked.interventions.intervention_request, 2);
  assert.equal(asked.interventions.actual_intervention, 1);
  const unseen = summarizeCursorStream([], { spawned: false, aborted: true });
  assert.equal(unseen.interventions.intervention_request, 'unknown');
  assert.equal(unseen.interventions.actual_intervention, 'unknown');
});

test('replay help names Cursor Agent and does not require verify', () => {
  const help = evalCli(['replay', '--help']);
  assert.equal(help.status, 0, help.stderr);
  assert.match(help.stdout, /Cursor Agent/);
  assert.match(help.stdout, /--variant with-skill=<path>/);
  assert.match(help.stdout, /--variant without/);
  assert.match(help.stdout, /--case/);
  assert.match(help.stdout, /--failed-from/);
  assert.match(help.stdout, /--repeat/);
  assert.match(help.stdout, /unavailable/);
  assert.match(help.stdout, /does not refuse/i);
});

test('dual variants check out the base, hide private history, and differ only by the skill', () => {
  const env = prepare();
  try {
    const result = evalCli(replayArgs(env, []));
    assert.equal(result.status, 0, result.stderr + result.stdout);
    const dir = join(env.runs, runId(result.stdout));
    const withoutDir = join(dir, 'variants', 'without');
    const withDir = join(dir, 'variants', 'with-skill');
    assertHidden(env, withoutDir);
    assertHidden(env, withDir);

    const withoutSaw = readJson(join(withoutDir, 'workspace', 'agent-saw.json'));
    const withSaw = readJson(join(withDir, 'workspace', 'agent-saw.json'));
    assert.equal(withoutSaw.hasSkill, false);
    assert.equal(withSaw.hasSkill, true);
    assert.equal(withoutSaw.prompt, withSaw.prompt);
    assert.equal(existsSync(join(withDir, 'workspace', '.cursor', 'skills', 'focus', 'SKILL.md')), true);
    assert.match(readFileSync(join(withDir, 'workspace', '.cursor', 'skills', 'focus', 'SKILL.md'), 'utf8'), /SKILL_BODY_FOCUS/);
    assert.equal(existsSync(join(withoutDir, 'workspace', '.cursor', 'skills')), false);

    const withoutConfig = readJson(join(withoutDir, 'config.json'));
    const withConfig = readJson(join(withDir, 'config.json'));
    assert.equal(withoutConfig.adapter, 'Cursor Agent');
    assert.equal(withoutConfig.entry, 'agent');
    assert.equal(withConfig.entry, 'agent');
    assert.equal(withoutConfig.model, null);
    assert.equal(withConfig.model, null);
    assert.deepEqual(withoutConfig.args, withConfig.args);
    assert.equal(withoutConfig.prompt_sha256, withConfig.prompt_sha256);
    assert.deepEqual(withoutConfig.skills, []);
    assert.equal(withConfig.skills.length, 1);
    assert.equal(withConfig.answers_questions, false);
    assert.equal(readJson(join(withoutDir, 'invocation.json')).answered_questions, false);
    assert.equal(readJson(join(withoutDir, 'invocation.json')).argv.includes('--force'), false);

    const agentInput = readJson(join(withoutDir, 'agent-input.json'));
    assert.deepEqual(Object.keys(agentInput).sort(), ['base_commit', 'repo', 'requirement', 'task_id']);
    assert.equal(agentInput.base_commit, env.base);

    for (const variantDir of [withoutDir, withDir]) {
      const interventions = readJson(join(variantDir, 'interventions.json'));
      assert.equal(interventions.intervention_request, 1);
      assert.equal(interventions.actual_intervention, 0);
      const usage = readJson(join(variantDir, 'usage.json'));
      assert.equal(usage.input_tokens, 'unknown');
      assert.equal(usage.output_tokens, 'unknown');
      assert.equal(typeof usage.duration_ms, 'number');
      const outcome = readJson(join(variantDir, 'result.json'));
      assert.equal(outcome.status, 'completed');
      assert.equal(outcome.score, 'unavailable');
      assert.equal(outcome.verify, 'omitted');
      assert.equal(outcome.head, env.base);
      assert.match(readFileSync(join(variantDir, 'events.jsonl'), 'utf8'), /"subtype":"request"/);
    }
  } finally {
    rmSync(env.root, { recursive: true, force: true });
  }
});

test('a verify path is not executed and a missing base is not a run', () => {
  const env = prepare();
  try {
    const marker = join(env.root, 'verify-ran');
    const script = join(env.root, 'verify.sh');
    writeFileSync(script, `#!/bin/sh\necho ran > ${JSON.stringify(marker)}\n`);
    chmodSync(script, 0o755);
    const card = join(env.root, 'tasks', env.taskId, 'card.yaml');
    writeFileSync(card, readFileSync(card, 'utf8') + `  verify:\n    status: path\n    path: ${JSON.stringify(script)}\n`);
    const ran = evalCli(replayArgs(env, ['--case', 'without']));
    assert.equal(ran.status, 0, ran.stderr + ran.stdout);
    assert.equal(existsSync(marker), false);
    assert.equal(existsSync(join(env.runs, runId(ran.stdout), 'variants', 'with-skill')), false);
    const outcome = readJson(join(env.runs, runId(ran.stdout), 'variants', 'without', 'result.json'));
    assert.equal(outcome.score, 'unavailable');
    assert.equal(outcome.verify, 'path');

    writeFileSync(card, readFileSync(card, 'utf8').replace(`status: replay-ready`, 'status: draft').replace(
      'private:',
      'private:\n  not_replay_ready:\n    reason: "base is still a note, not a commit."\n',
    ));
    const before = readdirSync(env.runs).length;
    const draft = evalCli(replayArgs(env, []));
    assert.equal(draft.status, 2);
    assert.match(draft.stderr, /not replay-ready/);
    assert.equal(readdirSync(env.runs).length, before);
  } finally {
    rmSync(env.root, { recursive: true, force: true });
  }
});

test('repeat checks out each attempt, and failed-from reruns only the incomplete variant', () => {
  const env = prepare();
  try {
    const repeated = evalCli(replayArgs(env, ['--repeat', '2', '--case', 'without']));
    assert.equal(repeated.status, 0, repeated.stderr + repeated.stdout);
    const repeatedDir = join(env.runs, runId(repeated.stdout));
    assert.equal(existsSync(join(repeatedDir, 'variants', 'with-skill')), false);
    for (const attempt of ['1', '2']) {
      const dir = join(repeatedDir, 'variants', 'without', 'attempts', attempt);
      assert.equal(git(join(dir, 'workspace'), 'rev-parse', 'HEAD'), env.base);
      assert.equal(readFileSync(join(dir, 'workspace', 'hello.txt'), 'utf8'), 'replayed\n');
      assert.equal(readJson(join(dir, 'workspace', 'agent-saw.json')).hasSkill, false);
    }
    assert.equal(readJson(join(repeatedDir, 'variants', 'without', 'result.json')).score, 'unavailable');

    const failed = evalCli(replayArgs(env, []), { REPLAY_AGENT_MODE: 'fail-without' });
    assert.equal(failed.status, 1, failed.stderr + failed.stdout);
    const failedId = runId(failed.stdout);
    const failedDir = join(env.runs, failedId);
    assert.equal(readJson(join(failedDir, 'variants', 'without', 'result.json')).status, 'error');
    assert.equal(readJson(join(failedDir, 'variants', 'without', 'result.json')).score, 'unavailable');
    assert.equal(readJson(join(failedDir, 'variants', 'with-skill', 'result.json')).status, 'completed');
    assert.equal(existsSync(join(failedDir, 'variants', 'without', 'workspace', 'hello.txt')), true);

    const again = evalCli([
      'replay', env.taskId,
      '--root', env.root,
      '--runs-dir', env.runs,
      '--failed-from', failedId,
    ], { REPLAY_AGENT_MODE: 'ok' });
    assert.equal(again.status, 0, again.stderr + again.stdout);
    const againId = runId(again.stdout);
    assert.notEqual(againId, failedId);
    const againDir = join(env.runs, againId);
    assert.equal(existsSync(join(againDir, 'variants', 'with-skill')), false);
    assert.equal(readJson(join(againDir, 'variants', 'without', 'result.json')).status, 'completed');
    assert.equal(git(join(againDir, 'variants', 'without', 'workspace'), 'rev-parse', 'HEAD'), env.base);
    assert.equal(readJson(join(failedDir, 'variants', 'with-skill', 'result.json')).status, 'completed');
    assert.equal(readJson(join(failedDir, 'variants', 'without', 'result.json')).status, 'error');
  } finally {
    rmSync(env.root, { recursive: true, force: true });
  }
});

test('Ctrl-C keeps the partial variant and resume finishes both', async () => {
  const env = prepare();
  const child = spawn(process.execPath, [join(repoRoot, 'src/eval.ts'), ...replayArgs(env, [])], {
    cwd: repoRoot,
    env: { ...process.env, REPLAY_AGENT_MODE: 'sleep' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', (chunk) => { output += chunk; });
  child.stderr.on('data', (chunk) => { output += chunk; });
  const done = new Promise<number | null>((resolve) => child.on('close', resolve));
  try {
    const started = Date.now();
    let saw = false;
    while (!saw) {
      if (Date.now() - started > 8000) throw new Error(`agent did not start\n${output}`);
      saw = readdirSync(env.runs).some((id) => existsSync(join(env.runs, id, 'variants', 'without', 'workspace', 'agent-saw.json')));
      if (!saw) await new Promise((resolve) => setTimeout(resolve, 25));
    }
    child.kill('SIGINT');
    const code = await Promise.race([
      done,
      new Promise<number>((_, reject) => setTimeout(() => reject(new Error(`replay did not stop\n${output}`)), 5000)),
    ]);
    assert.equal(code, 2, output);
    const id = runId(output);
    const variantDir = join(env.runs, id, 'variants', 'without');
    assert.equal(readJson(join(env.runs, id, 'state.json')).interrupted, true);
    assert.equal(existsSync(join(variantDir, 'invocation.json')), true);
    assert.equal(existsSync(join(variantDir, 'workspace', 'agent-saw.json')), true);
    assert.equal(readJson(join(variantDir, 'result.json')).status, 'interrupted');

    const resumed = evalCli([
      'replay', env.taskId,
      '--root', env.root,
      '--runs-dir', env.runs,
      '--resume', id,
    ], { REPLAY_AGENT_MODE: 'ok' });
    assert.equal(resumed.status, 0, resumed.stderr + resumed.stdout);
    assert.equal(readJson(join(variantDir, 'result.json')).status, 'completed');
    assert.equal(git(join(variantDir, 'workspace'), 'rev-parse', 'HEAD'), env.base);
    assert.equal(readJson(join(variantDir, 'workspace', 'agent-saw.json')).hasSkill, false);
    const withDir = join(env.runs, id, 'variants', 'with-skill');
    assert.equal(readJson(join(withDir, 'result.json')).status, 'completed');
    assert.equal(readJson(join(withDir, 'workspace', 'agent-saw.json')).hasSkill, true);
    assert.equal(git(join(withDir, 'workspace'), 'rev-parse', 'HEAD'), env.base);
    const partials = join(variantDir, 'partials');
    assert.equal(existsSync(partials), true);
    const kept = readdirSync(partials);
    assert.ok(kept.length > 0);
    assert.equal(existsSync(join(partials, kept[0], 'workspace', 'agent-saw.json')), true);
    assert.equal(readJson(join(partials, kept[0], 'result.json')).status, 'interrupted');
  } finally {
    child.kill('SIGKILL');
    rmSync(env.root, { recursive: true, force: true });
  }
});
