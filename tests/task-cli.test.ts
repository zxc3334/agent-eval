import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { test } from 'node:test';
import { parseTaskCardYaml } from '../packages/core/src/task-card.ts';

const root = join(import.meta.dirname, '..');
const baseSha = 'bf2477ff55037527d23582830e7fffbae0a0a738';
const missingSha = '0123456789abcdef0123456789abcdef01234567';

function evalCli(args: string[], input?: string, env?: NodeJS.ProcessEnv) {
  const started = Date.now();
  const result = spawnSync(process.execPath, [join(root, 'src/eval.ts'), ...args], {
    cwd: root,
    encoding: 'utf8',
    input,
    timeout: 20_000,
    env: env ?? process.env,
  });
  return { ...result, elapsed: Date.now() - started };
}

function freshRoot(): string {
  return mkdtempSync(join(tmpdir(), 'agent-eval-task-'));
}

function script(lines: readonly string[]): string {
  return `${lines.join('\n')}\n`;
}

function parseList(stdout: string): Record<string, string>[] {
  const lines = stdout.trim().split('\n');
  const header = lines[0].split('\t');
  assert.deepEqual(header, ['id', 'status', 'base', 'intervention', 'verify', 'missing_required']);
  return lines.slice(1).filter(line => line.length > 0).map(line => {
    const cells = line.split('\t');
    assert.equal(cells.length, header.length, line);
    return Object.fromEntries(header.map((key, index) => [key, cells[index]]));
  });
}

function errorMarks(text: string): string[] {
  return text.split('\n').filter(line => {
    const splitAt = line.indexOf(': ');
    return splitAt !== -1 && line.slice(splitAt + 2).startsWith('error');
  });
}

function add(dir: string, lines: readonly string[], env?: NodeJS.ProcessEnv) {
  const result = evalCli(['task', 'add', '--root', dir], script(lines), env);
  assert.equal(result.status, 0, result.stderr);
  const id = lines[0];
  const file = join(dir, 'tasks', id, 'card.yaml');
  assert.equal(result.stdout.trim(), file);
  assert.equal(existsSync(file), true);
  assert.ok(result.elapsed < 15_000, `add took ${result.elapsed}ms`);
  return { ...result, file };
}

test('task help lists add, list, show, validate, import, and mark', () => {
  for (const args of [['task'], ['task', '--help'], ['task', 'add', '--help']]) {
    const help = evalCli(args);
    assert.equal(help.status, 0, help.stderr);
    assert.match(help.stdout, /pnpm eval task add/);
    assert.match(help.stdout, /pnpm eval task list/);
    assert.match(help.stdout, /pnpm eval task show <id>/);
    assert.match(help.stdout, /pnpm eval task validate \[id\]/);
    assert.match(help.stdout, /pnpm eval task import --pr <owner\/repo#N>/);
    assert.match(help.stdout, /--from-file/);
    assert.match(help.stdout, /pnpm eval task mark <id>/);
    assert.match(help.stdout, /missing verify is not an error/i);
    assert.match(help.stdout, /does not block the card/i);
  }

  const imported = evalCli(['task', 'import']);
  assert.equal(imported.status, 2);
  assert.match(imported.stderr, /usage: pnpm eval task import --pr/);

  const marked = evalCli(['task', 'mark']);
  assert.equal(marked.status, 2);
  assert.match(marked.stderr, /usage: pnpm eval task mark <id>/);
});

test('the shell rejects leading unknown flags and forwards task flags', () => {
  const rejected = evalCli(['--suite', 'smoke']);
  assert.equal(rejected.status, 2);
  assert.match(rejected.stderr, /Unknown option '--suite'/);

  const offline = evalCli(['task', 'validate', '--offline']);
  assert.equal(offline.status, 0, offline.stderr + offline.stdout);
  assert.match(offline.stdout, /public\.base_commit\.existence: unavailable/);
  assert.match(offline.stdout, /result: ok/);
  assert.deepEqual(errorMarks(offline.stdout), []);
});

test('sample cards list draft apart from replay-ready, and validate', () => {
  const list = evalCli(['task', 'list']);
  assert.equal(list.status, 0, list.stderr);
  assert.equal(list.stdout.includes('error'), false);
  const rows = Object.fromEntries(parseList(list.stdout).map(row => [row.id, row]));
  assert.deepEqual(rows['chat-only-draft'], {
    id: 'chat-only-draft',
    status: 'draft',
    base: 'todo',
    intervention: 'unknown',
    verify: 'none',
    missing_required: '1',
  });
  assert.deepEqual(rows['e0-e2-stub-smoke'], {
    id: 'e0-e2-stub-smoke',
    status: 'replay-ready',
    base: baseSha.slice(0, 7),
    intervention: 'unknown',
    verify: 'none',
    missing_required: '0',
  });

  const show = evalCli(['task', 'show', 'chat-only-draft', '--offline']);
  assert.equal(show.status, 0, show.stderr);
  assert.match(show.stdout, /public\.base_commit: status todo/);
  assert.match(show.stdout, /private\.pr: status N\/A/);
  assert.match(show.stdout, /private\.merge: status N\/A/);
  assert.match(show.stdout, /private\.interventions: status unknown/);
  assert.match(show.stdout, /private\.verify: status none/);
  assert.match(show.stdout, /public\.base_commit\.existence: N\/A/);
  assert.match(show.stdout, /schema: ok/);
  assert.deepEqual(errorMarks(show.stdout), []);

  const validate = evalCli(['task', 'validate']);
  assert.equal(validate.status, 0, validate.stderr + validate.stdout);
  assert.match(validate.stdout, /task chat-only-draft/);
  assert.match(validate.stdout, /task e0-e2-stub-smoke/);
  assert.match(validate.stdout, /public\.base_commit\.existence: found/);
  assert.equal(validate.stdout.includes('existence: missing'), false);
  assert.deepEqual(errorMarks(validate.stdout), []);

  const missing = evalCli(['task', 'show', 'not-a-card']);
  assert.equal(missing.status, 2);
  assert.match(missing.stderr, /unknown task: not-a-card/);
});

test('multiline add writes a replay-ready verify=none card and checks the base SHA', () => {
  const dir = freshRoot();
  try {
    const created = add(dir, [
      'ready-none',
      'replay-ready',
      'multiline',
      'Say "hello" and stop.',
      '.',
      'value',
      'zxc3334/agent-eval',
      'github',
      'sha',
      missingSha,
      'unknown',
      'none',
      'omit',
      'omit',
      'omit',
    ]);
    const parsed = parseTaskCardYaml(readFileSync(created.file, 'utf8'), { expectedId: 'ready-none' });
    assert.equal(parsed.ok, true, JSON.stringify(parsed));
    if (parsed.ok) {
      assert.equal(parsed.card.status, 'replay-ready');
      assert.equal(parsed.card.public.requirement, 'Say "hello" and stop.');
      assert.equal(parsed.card.public.base_commit, missingSha);
      assert.deepEqual(parsed.card.private.interventions, { status: 'unknown' });
      assert.deepEqual(parsed.card.private.verify, { status: 'none' });
    }

    const listed = parseList(evalCli(['task', 'list', '--root', dir]).stdout);
    assert.equal(listed[0].status, 'replay-ready');
    assert.equal(listed[0].intervention, 'unknown');
    assert.equal(listed[0].verify, 'none');
    assert.equal(listed[0].missing_required, '0');
    assert.equal(listed[0].base, missingSha.slice(0, 7));

    const offline = evalCli(['task', 'validate', 'ready-none', '--root', dir, '--offline', '--repo-dir', root]);
    assert.equal(offline.status, 0, offline.stderr + offline.stdout);
    assert.match(offline.stdout, /private\.verify: status none/);
    assert.match(offline.stdout, /public\.base_commit\.existence: unavailable/);
    assert.match(offline.stdout, /result: ok/);
    assert.equal(offline.stdout.includes('existence: missing'), false);
    assert.deepEqual(errorMarks(offline.stdout), []);

    const absent = evalCli(['task', 'validate', 'ready-none', '--root', dir, '--repo-dir', root]);
    assert.notEqual(absent.status, 0);
    assert.match(absent.stdout, /schema: ok/);
    assert.match(absent.stdout, /public\.base_commit\.existence: missing/);
    assert.match(absent.stdout, /result: failed/);
    assert.deepEqual(errorMarks(absent.stdout), []);

    const show = evalCli(['task', 'show', 'ready-none', '--root', dir, '--offline']);
    assert.equal(show.status, 0, show.stderr);
    assert.match(show.stdout, /private\.interventions: status unknown/);
    assert.match(show.stdout, /public\.base_commit\.existence: unavailable/);
    assert.deepEqual(errorMarks(show.stdout), []);

    writeFileSync(created.file, readFileSync(created.file, 'utf8').replace(/\n {2}base_commit:.*(?:\n|$)/, '\n'));
    assert.equal(readFileSync(created.file, 'utf8').includes('base_commit'), false);
    const deleted = evalCli(['task', 'validate', 'ready-none', '--root', dir, '--repo-dir', root]);
    assert.notEqual(deleted.status, 0);
    assert.match(deleted.stdout, /public\.base_commit: error required field is missing/);
    assert.match(deleted.stdout, /result: failed/);
    assert.equal(deleted.stdout.includes('existence:'), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('file, clipboard, and omitted verify cards add, list, show, and validate', () => {
  const dir = freshRoot();
  const bin = join(dir, 'bin');
  try {
    writeFileSync(join(dir, 'need.txt'), '把问候改短。\n先不要开 PR。\n');
    const chat = add(dir, [
      'chat-only',
      'draft',
      'file',
      join(dir, 'need.txt'),
      'value',
      'zhang-chuan-dev/jackson-bot',
      'origin',
      'gap',
      'todo',
      'Not pinned to a commit yet.',
      'unknown',
      'none',
      'N/A',
      'Chat-only capture; no pull request was opened.',
      'N/A',
      'Chat-only capture; nothing was merged.',
      'omit',
      'Chat-only capture has no pinned base commit yet.',
    ]);
    const chatCard = parseTaskCardYaml(readFileSync(chat.file, 'utf8'), { expectedId: 'chat-only' });
    assert.equal(chatCard.ok, true, JSON.stringify(chatCard));
    if (chatCard.ok) {
      assert.equal(chatCard.card.public.requirement, '把问候改短。\n先不要开 PR。');
      assert.deepEqual(chatCard.card.public.base_commit, { status: 'todo', reason: 'Not pinned to a commit yet.' });
      assert.deepEqual(chatCard.card.private.pr, { status: 'N/A', reason: 'Chat-only capture; no pull request was opened.' });
      assert.deepEqual(chatCard.card.private.verify, { status: 'none' });
    }

    const partial = add(dir, [
      'partial-card',
      'draft',
      'gap',
      'unknown',
      'Requirement text is not final.',
      'gap',
      'todo',
      'Repo not chosen yet.',
      'gap',
      'unavailable',
      'Offline, base was not checked.',
      'unknown',
      'omit',
      'omit',
      'omit',
      'omit',
      'Requirement, repo, and base are still open.',
    ]);
    assert.equal(readFileSync(partial.file, 'utf8').includes('verify:'), false);

    const withPath = add(dir, [
      'with-path',
      'replay-ready',
      'multiline',
      'Run the local verifier.',
      '.',
      'value',
      'zxc3334/agent-eval',
      'github',
      'sha',
      baseSha,
      'unknown',
      'path',
      'scripts/verify.sh',
      'omit',
      'omit',
      'omit',
    ]);
    assert.match(readFileSync(withPath.file, 'utf8'), /scripts\/verify\.sh/);

    const rows = Object.fromEntries(parseList(evalCli(['task', 'list', '--root', dir]).stdout).map(row => [row.id, row]));
    assert.equal(rows['chat-only'].status, 'draft');
    assert.equal(rows['chat-only'].base, 'todo');
    assert.equal(rows['chat-only'].intervention, 'unknown');
    assert.equal(rows['chat-only'].verify, 'none');
    assert.equal(rows['chat-only'].missing_required, '1');
    assert.equal(rows['partial-card'].status, 'draft');
    assert.equal(rows['partial-card'].verify, 'missing');
    assert.equal(rows['partial-card'].intervention, 'unknown');
    assert.equal(rows['partial-card'].missing_required, '3');
    assert.equal(rows['with-path'].status, 'replay-ready');
    assert.equal(rows['with-path'].verify, 'scripts/verify.sh');
    assert.equal(rows['with-path'].base, baseSha.slice(0, 7));
    assert.equal(rows['with-path'].missing_required, '0');
    for (const row of Object.values(rows)) assert.notEqual(row.verify, 'error');

    const shown = evalCli(['task', 'show', 'chat-only', '--root', dir]);
    assert.equal(shown.status, 0, shown.stderr);
    assert.match(shown.stdout, /status todo/);
    assert.match(shown.stdout, /status N\/A/);
    assert.match(shown.stdout, /status unknown/);
    assert.match(shown.stdout, /status none/);
    assert.match(shown.stdout, /existence: N\/A/);
    assert.deepEqual(errorMarks(shown.stdout), []);

    const partialShow = evalCli(['task', 'show', 'partial-card', '--root', dir]);
    assert.equal(partialShow.status, 0, partialShow.stderr);
    assert.match(partialShow.stdout, /private\.verify: missing/);
    assert.match(partialShow.stdout, /public\.requirement: status unknown/);
    assert.match(partialShow.stdout, /public\.repo: status todo/);
    assert.match(partialShow.stdout, /public\.base_commit: status unavailable/);
    assert.deepEqual(errorMarks(partialShow.stdout), []);

    const checked = evalCli(['task', 'validate', '--root', dir, '--repo-dir', root]);
    assert.equal(checked.status, 0, checked.stderr + checked.stdout);
    assert.match(checked.stdout, /task partial-card[\s\S]*private\.verify: missing[\s\S]*result: ok/);
    assert.match(checked.stdout, /task with-path[\s\S]*private\.verify: path scripts\/verify\.sh[\s\S]*existence: found[\s\S]*result: ok/);
    assert.deepEqual(errorMarks(checked.stdout), []);

    mkdirSync(bin);
    writeFileSync(join(bin, 'pbpaste'), '#!/bin/sh\nprintf "%s\\n" \'从剪贴板贴上的需求原文\'\n');
    chmodSync(join(bin, 'pbpaste'), 0o755);
    const clipped = add(dir, [
      'from-clip',
      'replay-ready',
      'clipboard',
      'value',
      'zxc3334/agent-eval',
      'github',
      'sha',
      baseSha,
      'unknown',
      'omit',
      'omit',
      'omit',
      'omit',
    ], { ...process.env, PATH: `${bin}${delimiter}${process.env.PATH ?? ''}` });
    assert.match(clipped.stderr, /requirement from clipboard: 从剪贴板贴上的需求原文/);
    const clipCard = parseTaskCardYaml(readFileSync(clipped.file, 'utf8'), { expectedId: 'from-clip' });
    assert.equal(clipCard.ok, true, JSON.stringify(clipCard));
    if (clipCard.ok) assert.equal(clipCard.card.public.requirement, '从剪贴板贴上的需求原文');
    assert.equal(readFileSync(clipped.file, 'utf8').includes('verify:'), false);
    const clipRow = parseList(evalCli(['task', 'list', '--root', dir]).stdout).find(row => row.id === 'from-clip');
    assert.equal(clipRow?.verify, 'missing');
    assert.equal(clipRow?.status, 'replay-ready');
    const clipValidate = evalCli(['task', 'validate', 'from-clip', '--root', dir, '--offline']);
    assert.equal(clipValidate.status, 0, clipValidate.stderr + clipValidate.stdout);
    assert.match(clipValidate.stdout, /private\.verify: missing/);
    assert.match(clipValidate.stdout, /existence: unavailable/);
    assert.match(clipValidate.stdout, /result: ok/);
    assert.deepEqual(errorMarks(clipValidate.stdout), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('replay-ready with a gap is saved as draft, and a bad SHA is re-asked', () => {
  const dir = freshRoot();
  try {
    const drafted = add(dir, [
      'forced-draft',
      'replay-ready',
      'multiline',
      'Text is here.',
      '.',
      'value',
      'owner/name',
      'origin',
      'gap',
      'unknown',
      'Base is not known.',
      'unknown',
      'none',
      'omit',
      'omit',
      'omit',
      'Base is still unknown, so this stays a draft.',
    ]);
    assert.match(drafted.stderr, /saving as draft/);
    const row = parseList(evalCli(['task', 'list', '--root', dir]).stdout)[0];
    assert.equal(row.status, 'draft');
    assert.equal(row.base, 'unknown');
    assert.equal(row.verify, 'none');
    assert.equal(row.missing_required, '1');
    const validated = evalCli(['task', 'validate', 'forced-draft', '--root', dir]);
    assert.equal(validated.status, 0, validated.stderr + validated.stdout);
    assert.match(validated.stdout, /public\.base_commit: status unknown/);
    assert.match(validated.stdout, /existence: N\/A/);

    const retried = add(dir, [
      'retry-sha',
      'replay-ready',
      'multiline',
      'Fix the sha.',
      '.',
      'value',
      'zxc3334/agent-eval',
      'github',
      'sha',
      'abc',
      baseSha,
      'none',
      'none',
      'omit',
      'omit',
      'omit',
    ]);
    assert.match(retried.stderr, /not a full 40- or 64-character hex SHA/);
    const again = parseList(evalCli(['task', 'list', '--root', dir]).stdout).find(item => item.id === 'retry-sha');
    assert.equal(again?.intervention, 'none');
    assert.notEqual(again?.intervention, '0');
    assert.equal(again?.status, 'replay-ready');
    const found = evalCli(['task', 'validate', 'retry-sha', '--root', dir, '--repo-dir', root]);
    assert.equal(found.status, 0, found.stderr + found.stdout);
    assert.match(found.stdout, /existence: found/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('an existing id is rejected and the next id is written', () => {
  const dir = freshRoot();
  try {
    add(dir, [
      'ready-none',
      'replay-ready',
      'multiline',
      'First card.',
      '.',
      'value',
      'zxc3334/agent-eval',
      'github',
      'sha',
      baseSha,
      'unknown',
      'omit',
      'omit',
      'omit',
      'omit',
    ]);
    const second = evalCli(['task', 'add', '--root', dir], script([
      'ready-none',
      'second-card',
      'draft',
      'multiline',
      'Second card.',
      '.',
      'value',
      'zxc3334/agent-eval',
      'github',
      'sha',
      baseSha,
      'unknown',
      'omit',
      'omit',
      'omit',
      'omit',
      'Kept as a draft on purpose.',
    ]));
    assert.equal(second.status, 0, second.stderr);
    assert.match(second.stderr, /task already exists: ready-none/);
    assert.equal(second.stdout.trim(), join(dir, 'tasks', 'second-card', 'card.yaml'));
    assert.ok(second.elapsed < 15_000, `add took ${second.elapsed}ms`);
    const ended = evalCli(['task', 'add', '--root', dir], '');
    assert.equal(ended.status, 2);
    assert.match(ended.stderr, /unexpected end of input/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('hand-written cards: missing verify passes, illegal verify and a bad SHA fail', () => {
  const dir = freshRoot();
  try {
    writeCard(dir, 'bare-ready', `
schema_version: 1
id: bare-ready
status: replay-ready
public:
  requirement: "Do one concrete thing."
  repo:
    id: zxc3334/agent-eval
    host: github
  base_commit: "${baseSha}"
`);
    writeCard(dir, 'bad-verify', `
schema_version: 1
id: bad-verify
status: replay-ready
public:
  requirement: "Do one concrete thing."
  repo:
    id: zxc3334/agent-eval
    host: github
  base_commit: "${baseSha}"
private:
  interventions:
    status: unknown
  verify:
    status: bogus
`);
    writeCard(dir, 'bad-sha', `
schema_version: 1
id: bad-sha
status: replay-ready
public:
  requirement: "Do one concrete thing."
  repo:
    id: zxc3334/agent-eval
    host: github
  base_commit: "abc"
private:
  interventions:
    status: unknown
`);

    const rows = Object.fromEntries(parseList(evalCli(['task', 'list', '--root', dir]).stdout).map(row => [row.id, row]));
    assert.equal(rows['bare-ready'].verify, 'missing');
    assert.equal(rows['bare-ready'].intervention, 'unknown');
    assert.equal(rows['bare-ready'].status, 'replay-ready');
    assert.equal(rows['bare-ready'].missing_required, '0');
    assert.equal(rows['bad-verify'].verify, 'bogus');
    assert.notEqual(rows['bad-verify'].verify, 'error');
    assert.equal(rows['bad-sha'].base, 'invalid');

    const bare = evalCli(['task', 'validate', 'bare-ready', '--root', dir, '--repo-dir', root]);
    assert.equal(bare.status, 0, bare.stderr + bare.stdout);
    assert.match(bare.stdout, /private\.verify: missing/);
    assert.match(bare.stdout, /existence: found/);
    assert.match(bare.stdout, /result: ok/);
    assert.deepEqual(errorMarks(bare.stdout), []);

    const illegal = evalCli(['task', 'validate', 'bad-verify', '--root', dir, '--offline']);
    assert.notEqual(illegal.status, 0);
    assert.match(illegal.stdout, /private\.verify: error/);
    assert.match(illegal.stdout, /result: failed/);
    assert.equal(illegal.stdout.includes('existence:'), false);

    const shown = evalCli(['task', 'show', 'bad-verify', '--root', dir]);
    assert.equal(shown.status, 1);
    assert.match(shown.stdout, /private\.verify: error/);
    assert.match(shown.stdout, /schema: failed/);

    const format = evalCli(['task', 'validate', 'bad-sha', '--root', dir, '--repo-dir', root]);
    assert.notEqual(format.status, 0);
    assert.match(format.stdout, /public\.base_commit: error not a full 40- or 64-character hex SHA/);
    assert.equal(format.stdout.includes('existence:'), false);
    assert.equal(format.stdout.includes('unavailable'), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('task card doc describes the entry commands and the verify column', () => {
  const doc = readFileSync(join(root, 'docs/task-card.md'), 'utf8');
  assert.match(doc, /pnpm eval task add/);
  assert.match(doc, /pnpm eval task list/);
  assert.match(doc, /pnpm eval task show <id>/);
  assert.match(doc, /pnpm eval task validate \[id\]/);
  assert.match(doc, /pnpm eval task import --pr <owner\/repo#N>/);
  assert.match(doc, /都不是 error/);
  assert.match(doc, /存在性是 `unavailable`，退出码是 0/);
});

function writeCard(dir: string, id: string, yaml: string): void {
  const taskDir = join(dir, 'tasks', id);
  mkdirSync(taskDir, { recursive: true });
  writeFileSync(join(taskDir, 'card.yaml'), `${yaml.trim()}\n`);
}
