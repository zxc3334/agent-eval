import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { buildAgentInput, loadTaskCard, parseTaskCardYaml } from '../packages/core/src/index.ts';
import { countRounds, parseMarkExport, resolveProvenance, sharedBaseline } from '../packages/core/src/marks.ts';

const root = join(import.meta.dirname, '..');
const baseSha = 'bf2477ff55037527d23582830e7fffbae0a0a738';
const chatExport = join(root, 'tests/fixtures/marks/chat-12.json');
const prExport = join(root, 'tests/fixtures/marks/pr-review.json');
const r3Export = join(root, 'tests/fixtures/marks/r3-candidates.json');

function evalCli(args: string[], input?: string) {
  const started = Date.now();
  const result = spawnSync(process.execPath, [join(root, 'src/eval.ts'), ...args], {
    cwd: root,
    encoding: 'utf8',
    input,
    timeout: 20_000,
  });
  return { ...result, elapsed: Date.now() - started };
}

function freshRoot(): string {
  return mkdtempSync(join(tmpdir(), 'agent-eval-mark-'));
}

function writeCard(dir: string, id: string, yaml: string): string {
  const taskDir = join(dir, 'tasks', id);
  mkdirSync(taskDir, { recursive: true });
  const file = join(taskDir, 'card.yaml');
  writeFileSync(file, yaml.trim().endsWith('\n') ? `${yaml.trim()}\n` : `${yaml.trim()}\n`);
  return file;
}

function readyCard(id: string): string {
  return `
schema_version: 1
id: ${id}
status: replay-ready
public:
  requirement: "把问候改短。先不要开 PR。"
  repo:
    id: zhang-chuan-dev/jackson-bot
    host: origin
  base_commit: "${baseSha}"
`;
}

function load(dir: string, id: string) {
  return loadTaskCard(join(dir, 'tasks', id));
}

test('missing history is unknown and not a confirmed zero', () => {
  for (const id of ['chat-only-draft', 'e0-e2-stub-smoke']) {
    const card = loadTaskCard(join(root, 'tasks', id));
    const baseline = sharedBaseline(card);
    assert.equal(baseline.interventions, 'unknown');
    assert.equal(baseline.rework_rounds, 'unknown');
    assert.notEqual(baseline.interventions, 0);
    assert.notEqual(baseline.rework_rounds, 0);
    const show = evalCli(['task', 'show', id, '--offline']);
    assert.equal(show.status, 0, show.stderr);
    assert.match(show.stdout, /baseline\.interventions: unknown/);
    assert.match(show.stdout, /baseline\.rework_rounds: unknown/);
    assert.doesNotMatch(show.stdout, /baseline\.interventions: 0/);
    assert.doesNotMatch(show.stdout, /baseline\.rework_rounds: 0/);
    assert.equal(readFileSync(join(root, 'tasks', id, 'card.yaml'), 'utf8').includes('count:'), false);
  }

  const dir = freshRoot();
  try {
    writeCard(dir, 'confirmed-empty', `
schema_version: 1
id: confirmed-empty
status: replay-ready
public:
  requirement: "做一件具体的事。"
  repo:
    id: zxc3334/agent-eval
    host: github
  base_commit: "${baseSha}"
private:
  interventions:
    status: none
  rework:
    status: none
`);
    const baseline = sharedBaseline(load(dir, 'confirmed-empty'));
    assert.equal(baseline.interventions, 0);
    assert.equal(baseline.rework_rounds, 0);
    const show = evalCli(['task', 'show', 'confirmed-empty', '--root', dir, '--offline']);
    assert.match(show.stdout, /baseline\.interventions: none/);
    assert.match(show.stdout, /baseline\.rework_rounds: none/);
    assert.doesNotMatch(show.stdout, /baseline\.interventions: 0/);
    assert.doesNotMatch(show.stdout, /baseline\.rework_rounds: 0/);
    const listed = evalCli(['task', 'list', '--root', dir]).stdout;
    assert.match(listed, /confirmed-empty\treplay-ready\t/);
    assert.equal(listed.includes('\t0\t'), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a 12-turn chat export marks in one pass, show matches, and a second read does not duplicate', () => {
  const turns = JSON.parse(readFileSync(chatExport, 'utf8')).turns as unknown[];
  assert.ok(turns.length >= 10);
  const candidates = parseMarkExport(readFileSync(chatExport, 'utf8'), chatExport);
  assert.equal(candidates.length, 6);
  assert.equal(candidates.some(item => item.excerpt.includes('欢迎使用 Jackson')), false);

  const dir = freshRoot();
  try {
    const file = writeCard(dir, 'greeting', readyCard('greeting'));
    const original = readFileSync(file, 'utf8');
    const bad = evalCli(['task', 'mark', 'greeting', '--root', dir, '--confirm', 'nope:插手']);
    assert.equal(bad.status, 2, bad.stderr);
    assert.match(bad.stderr, /unknown candidate: nope/);
    assert.equal(readFileSync(file, 'utf8'), original);

    const loaded = evalCli(['task', 'mark', 'greeting', '--root', dir, '--from-file', chatExport]);
    assert.equal(loaded.status, 0, loaded.stderr);
    assert.match(loaded.stdout, /baseline\.interventions: unknown/);
    assert.match(loaded.stdout, /baseline\.rework_rounds: unknown/);
    assert.doesNotMatch(loaded.stdout, /baseline\.interventions: 0/);
    const staged = load(dir, 'greeting');
    assert.equal(sharedBaseline(staged).interventions, 'unknown');
    assert.equal(sharedBaseline(staged).rework_rounds, 'unknown');
    assert.equal(staged.private.candidates?.length, 6);
    assert.equal(JSON.stringify(staged).includes('欢迎使用 Jackson'), false);
    assert.equal(readFileSync(file, 'utf8').includes('count:'), false);

    const marked = evalCli([
      'task', 'mark', 'greeting', '--root', dir,
      '--from-file', chatExport,
      '--confirm', 't03:插手,t05:返工,t09:返工,t11:返工',
    ]);
    assert.equal(marked.status, 0, marked.stderr);
    assert.ok(marked.elapsed < 15_000, `mark took ${marked.elapsed}ms`);
    assert.ok(marked.elapsed < 180_000);
    assert.match(marked.stdout, /baseline\.interventions: 1/);
    assert.match(marked.stdout, /baseline\.rework_rounds: 2/);

    const card = load(dir, 'greeting');
    assert.deepEqual(sharedBaseline(card), { interventions: 1, rework_rounds: 2 });
    assert.equal(card.private.candidates?.map(item => item.id).join(','), 't01,t07');
    const interventions = 'records' in card.private.interventions ? card.private.interventions.records : [];
    assert.equal(interventions.length, 1);
    assert.equal(interventions[0].excerpt, '太长了。只要「你好」。');
    assert.equal(interventions[0].confirmation, 'confirmed');
    assert.equal(interventions[0].origin, 'chat');
    const provenance = resolveProvenance(interventions[0]);
    assert.ok(provenance);
    assert.equal(provenance?.kind, 'chat');
    assert.equal(provenance?.turn, 't03');
    assert.equal(provenance?.dedupe_key.includes('t03'), true);
    const rework = card.private.rework && 'records' in card.private.rework ? card.private.rework.records : [];
    assert.equal(rework.length, 3);
    assert.equal(countRounds(rework), 2);
    assert.equal(rework[0].round, 't05');
    assert.equal(rework[1].round, 't05');
    assert.equal(rework[1].boundary, 'human-confirm');
    assert.equal(rework[2].round, 't11');
    assert.equal(card.private.verify.status, 'none');
    assert.equal(buildAgentInput(card).requirement.includes('太长了'), false);

    const show = evalCli(['task', 'show', 'greeting', '--root', dir, '--offline']);
    assert.equal(show.status, 0, show.stderr);
    assert.match(show.stdout, /baseline\.interventions: 1/);
    assert.match(show.stdout, /baseline\.rework_rounds: 2/);
    assert.match(show.stdout, /太长了。只要「你好」。/);
    assert.match(show.stdout, /按钮文案也要一起改，你漏了。/);
    assert.match(show.stdout, /检查挂了，你没看输出。我手动改了断言。/);
    assert.match(show.stdout, /这版可以。先这样，不要再扩范围。/);
    assert.match(show.stdout, /private\.verify: missing/);
    assert.match(show.stdout, /schema: ok/);
    const listed = evalCli(['task', 'list', '--root', dir]).stdout;
    assert.match(listed, /greeting\treplay-ready\t.*\trecords:1\t/);

    const saved = readFileSync(file, 'utf8');
    const again = evalCli([
      'task', 'mark', 'greeting', '--root', dir,
      '--from-file', chatExport,
      '--confirm', 't03:插手,t05:返工,t09:返工,t11:返工',
    ]);
    assert.equal(again.status, 0, again.stderr);
    assert.match(again.stdout, /unchanged/);
    assert.equal(readFileSync(file, 'utf8'), saved);
    assert.deepEqual(sharedBaseline(load(dir, 'greeting')), { interventions: 1, rework_rounds: 2 });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('--select confirms the same chat export without a model', () => {
  const dir = freshRoot();
  try {
    writeCard(dir, 'picked', readyCard('picked'));
    const selected = evalCli(
      ['task', 'mark', 'picked', '--root', dir, '--from-file', chatExport, '--select'],
      ['skip', '插手', '返工', 'skip', '返工', '返工'].join('\n') + '\n',
    );
    assert.equal(selected.status, 0, selected.stderr);
    assert.match(selected.stderr, /type \(插手, 返工, skip\)/);
    assert.deepEqual(sharedBaseline(load(dir, 'picked')), { interventions: 1, rework_rounds: 2 });
    const show = evalCli(['task', 'show', 'picked', '--root', dir, '--offline']);
    assert.match(show.stdout, /baseline\.interventions: 1/);
    assert.match(show.stdout, /baseline\.rework_rounds: 2/);
    assert.match(show.stdout, /太长了。只要「你好」。/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('R3 fixup and review candidates count only after confirmation', () => {
  const dir = freshRoot();
  try {
    const file = writeCard(dir, 'fixups', readyCard('fixups'));
    const staged = evalCli(['task', 'mark', 'fixups', '--root', dir, '--from-file', r3Export]);
    assert.equal(staged.status, 0, staged.stderr);
    assert.match(staged.stdout, /baseline\.interventions: unknown/);
    assert.match(staged.stdout, /pending fixup-rename fixup/);
    const waiting = load(dir, 'fixups');
    assert.equal(sharedBaseline(waiting).interventions, 'unknown');
    assert.equal(waiting.private.candidates?.length, 2);
    assert.equal(waiting.private.candidates?.[0].suggested, 'intervention');
    assert.equal(JSON.stringify(waiting.private.interventions).includes('fixup'), false);

    const confirmed = evalCli([
      'task', 'mark', 'fixups', '--root', dir,
      '--from-file', r3Export,
      '--confirm', 'fixup-rename:插手',
    ]);
    assert.equal(confirmed.status, 0, confirmed.stderr);
    assert.match(confirmed.stdout, /baseline\.interventions: 1/);
    assert.match(confirmed.stdout, /baseline\.rework_rounds: unknown/);
    const card = load(dir, 'fixups');
    assert.deepEqual(sharedBaseline(card), { interventions: 1, rework_rounds: 'unknown' });
    assert.equal(card.private.candidates?.map(item => item.id).join(','), 'review-copy');
    const show = evalCli(['task', 'show', 'fixups', '--root', dir, '--offline']);
    assert.match(show.stdout, /baseline\.interventions: 1/);
    assert.match(show.stdout, /手动把 helper 重命名了/);
    assert.match(show.stdout, /unconfirmed review/);
    assert.match(show.stdout, /这句文案不对/);

    const saved = readFileSync(file, 'utf8');
    const again = evalCli([
      'task', 'mark', 'fixups', '--root', dir,
      '--from-file', r3Export,
      '--confirm', 'fixup-rename:插手',
    ]);
    assert.equal(again.status, 0, again.stderr);
    assert.equal(readFileSync(file, 'utf8'), saved);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a pull-request review file is marked only for the chosen comment', () => {
  const dir = freshRoot();
  try {
    const file = writeCard(dir, 'review', readyCard('review'));
    const marked = evalCli([
      'task', 'mark', 'review', '--root', dir,
      '--from-file', prExport,
      '--confirm', 'rev-greeting:插手',
    ]);
    assert.equal(marked.status, 0, marked.stderr);
    assert.match(marked.stdout, /baseline\.interventions: 1/);
    const card = load(dir, 'review');
    assert.equal(sharedBaseline(card).interventions, 1);
    assert.equal(card.private.candidates?.map(item => item.id).join(','), 'cmt-button');
    const record = 'records' in card.private.interventions ? card.private.interventions.records[0] : undefined;
    assert.equal(record?.origin, 'pr-review');
    assert.equal(record?.excerpt, '问候还是太长，按需求收成「你好」。');
    assert.equal(resolveProvenance(record ?? {})?.kind, 'pr');
    const saved = readFileSync(file, 'utf8');
    const again = evalCli([
      'task', 'mark', 'review', '--root', dir,
      '--from-file', prExport,
      '--confirm', 'rev-greeting:插手',
    ]);
    assert.equal(again.status, 0, again.stderr);
    assert.equal(readFileSync(file, 'utf8'), saved);
    const clash = evalCli([
      'task', 'mark', 'review', '--root', dir,
      '--confirm', 'rev-greeting:返工',
    ]);
    assert.equal(clash.status, 2, clash.stderr);
    assert.match(clash.stderr, /already recorded as intervention/);
    assert.equal(readFileSync(file, 'utf8'), saved);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a direct note appends one confirmed rework and a repeat is a no-op', () => {
  const dir = freshRoot();
  try {
    writeCard(dir, 'chat-only', `
schema_version: 1
id: chat-only
status: draft
public:
  requirement: "把问候改短。先不要开 PR。"
  repo:
    id: zhang-chuan-dev/jackson-bot
    host: origin
  base_commit:
    status: todo
    reason: "Not pinned to a commit yet."
private:
  pr:
    status: "N/A"
    reason: "Chat-only capture; no pull request was opened."
  merge:
    status: "N/A"
    reason: "Chat-only capture; nothing was merged."
  interventions:
    status: unknown
  not_replay_ready:
    reason: "Chat-only capture has no pinned base commit yet."
`);
    const marked = evalCli([
      'task', 'mark', 'chat-only', '--root', dir,
      '--note', '按钮也要改',
      '--type', '返工',
      '--source', 'https://github.com/zhang-chuan-dev/jackson-bot/pull/8',
    ]);
    assert.equal(marked.status, 0, marked.stderr);
    assert.match(marked.stdout, /baseline\.interventions: unknown/);
    assert.match(marked.stdout, /baseline\.rework_rounds: 1/);
    const card = load(dir, 'chat-only');
    assert.deepEqual(sharedBaseline(card), { interventions: 'unknown', rework_rounds: 1 });
    assert.deepEqual(card.private.pr, { status: 'N/A', reason: 'Chat-only capture; no pull request was opened.' });
    assert.equal(card.private.verify.status, 'none');
    assert.equal(card.status, 'draft');
    const rework = card.private.rework && 'records' in card.private.rework ? card.private.rework.records : [];
    assert.equal(rework.length, 1);
    assert.equal(rework[0].excerpt, '按钮也要改');
    assert.equal(rework[0].origin, 'manual');
    assert.equal(resolveProvenance(rework[0])?.kind, 'pr');
    const show = evalCli(['task', 'show', 'chat-only', '--root', dir, '--offline']);
    assert.equal(show.status, 0, show.stderr);
    assert.match(show.stdout, /private\.pr: status N\/A/);
    assert.match(show.stdout, /private\.verify: missing/);
    assert.match(show.stdout, /baseline\.rework_rounds: 1/);
    assert.match(show.stdout, /按钮也要改/);
    assert.match(show.stdout, /schema: ok/);
    const validated = evalCli(['task', 'validate', 'chat-only', '--root', dir, '--offline']);
    assert.equal(validated.status, 0, validated.stderr + validated.stdout);

    const file = join(dir, 'tasks', 'chat-only', 'card.yaml');
    const saved = readFileSync(file, 'utf8');
    const again = evalCli([
      'task', 'mark', 'chat-only', '--root', dir,
      '--note', '按钮也要改',
      '--type', '返工',
      '--source', 'https://github.com/zhang-chuan-dev/jackson-bot/pull/8',
    ]);
    assert.equal(again.status, 0, again.stderr);
    assert.match(again.stdout, /unchanged/);
    assert.equal(readFileSync(file, 'utf8'), saved);
    assert.equal(readFileSync(file, 'utf8').includes('count:'), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('export parsers keep human rows only and reject a duplicate turn', () => {
  const jsonl = parseMarkExport([
    JSON.stringify({ role: 'user', content: '停一下', step_index: 1 }),
    JSON.stringify({ role: 'assistant', content: '好' }),
  ].join('\n'), 'trace.jsonl');
  assert.equal(jsonl.length, 1);
  assert.equal(jsonl[0].turn, 't01');
  assert.equal(jsonl[0].excerpt, '停一下');

  const steps = parseMarkExport(JSON.stringify({
    steps: [
      { role: 'user', content: '改短', step_index: 1 },
      { type: 'USER_INPUT', content: '再改' },
      { role: 'assistant', content: 'done' },
    ],
  }), 'trace.json');
  assert.deepEqual(steps.map(item => item.excerpt), ['改短', '再改']);

  const markdown = parseMarkExport('User: 把问候改短\n\nAssistant: 好\n', 'chat.md');
  assert.equal(markdown.length, 1);
  assert.equal(markdown[0].excerpt, '把问候改短');

  assert.throws(
    () => parseMarkExport(JSON.stringify({
      turns: [
        { id: 't01', role: 'user', text: 'a' },
        { id: 't01', role: 'user', text: 'b' },
      ],
    }), 'dup.json'),
    /duplicate turn/,
  );

  const roundTrip = parseTaskCardYaml(`
schema_version: 1
id: marked
status: replay-ready
public:
  requirement: "做一件具体的事。"
  repo:
    id: zxc3334/agent-eval
    host: github
  base_commit: "${baseSha}"
private:
  interventions:
    records:
      - id: t03
        summary: "太长了。"
        source: "chat.json"
        turn: "t03"
        kind: intervention
        confirmation: confirmed
        excerpt: "太长了。"
        origin: chat
        provenance:
          kind: chat
          ref: "chat.json"
`);
  assert.equal(roundTrip.ok, true, JSON.stringify(roundTrip));
  if (roundTrip.ok) {
    assert.equal(sharedBaseline(roundTrip.card).interventions, 1);
    assert.equal(buildAgentInput(roundTrip.card).requirement, '做一件具体的事。');
    assert.equal(JSON.stringify(buildAgentInput(roundTrip.card)).includes('太长了'), false);
  }
});
