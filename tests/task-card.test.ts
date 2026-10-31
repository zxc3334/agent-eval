import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  AGENT_INPUT_ALLOWLIST,
  assessCommit,
  buildAgentInput,
  exportCardJson,
  loadTaskCard,
  loadTaskCards,
  parseTaskCardJson,
  parseTaskCardYaml,
  projectAgentInput,
  serializeAgentInput,
  TaskCardError,
} from '../packages/core/src/index.ts';

const root = join(import.meta.dirname, '..');
const baseSha = 'bf2477ff55037527d23582830e7fffbae0a0a738';
const mergeSha = 'ed4b70c0fc8b93d02fd2d8b770b141ae88eb1004';
const missingSha = '0123456789abcdef0123456789abcdef01234567';

const smokeRequirement = [
  '在 main 上做本地确定性 stub 冒烟：一条命令跑 smoke，预期有通过也有硬断言失败。',
  '失败要能定位；中断时清理进程组，故障状态不要写成通过。',
  '支持单例重跑，以及按上一轮失败集重跑。',
  '不接模型，不需要 API key、Docker 或 bot。',
  '',
].join('\n');

function broken(name: string) {
  return parseTaskCardYaml(readFileSync(join(root, 'tests/fixtures/task-cards/broken', name), 'utf8'));
}

function assertIssues(name: string, errors: { field: string; message: string }[]) {
  const result = broken(name);
  assert.equal(result.ok, false, JSON.stringify(result));
  assert.deepEqual(result.ok ? [] : result.errors, errors);
}

function numstat(from: string, to: string) {
  const diff = spawnSync('git', ['diff', '--numstat', from, to], { cwd: root, encoding: 'utf8' });
  assert.equal(diff.status, 0, diff.stderr);
  let files = 0;
  let additions = 0;
  let deletions = 0;
  for (const line of diff.stdout.split('\n')) {
    if (!line) continue;
    const [added, deleted] = line.split('\t');
    assert.notEqual(added, '-', `binary file in ${from}..${to}`);
    files += 1;
    additions += Number(added);
    deletions += Number(deleted);
  }
  return { files, additions, deletions };
}

test('merged PR #1 sample is replay-ready and its AgentInput keeps the merge out', () => {
  const file = join(root, 'tasks/e0-e2-stub-smoke/card.yaml');
  const yaml = readFileSync(file, 'utf8');
  const card = loadTaskCard(join(root, 'tasks/e0-e2-stub-smoke'));
  assert.equal(card.id, 'e0-e2-stub-smoke');
  assert.equal(card.status, 'replay-ready');
  assert.equal(card.public.requirement, smokeRequirement);
  assert.deepEqual(card.public.repo, { id: 'zxc3334/agent-eval', host: 'github' });
  assert.equal(card.public.base_commit, baseSha);
  assert.deepEqual(card.private.pr, { number: 1, url: 'https://github.com/zxc3334/agent-eval/pull/1' });
  assert.deepEqual(card.private.merge, {
    sha: mergeSha,
    diff_stats: numstat(baseSha, mergeSha),
  });
  assert.deepEqual(card.private.interventions, { status: 'unknown' });
  assert.equal(yaml.includes('count:'), false);
  assert.deepEqual(card.private.verify, { status: 'none' });

  const input = buildAgentInput(card);
  assert.deepEqual(Object.keys(input), [...AGENT_INPUT_ALLOWLIST]);
  assert.deepEqual(input, {
    task_id: 'e0-e2-stub-smoke',
    requirement: smokeRequirement,
    repo: { id: 'zxc3334/agent-eval', host: 'github' },
    base_commit: baseSha,
  });
  const serialized = serializeAgentInput(card);
  assert.equal(yaml.includes(mergeSha), true);
  assert.equal(yaml.includes('pull/1'), true);
  assert.equal(serialized.includes(mergeSha), false);
  assert.equal(serialized.includes('pull/1'), false);
  assert.equal(serialized.includes('"additions": 873'), false);
  assert.equal(serialized.includes(baseSha), true);

  const exported = exportCardJson(card);
  assert.equal(exported.includes(mergeSha), true);
  const again = parseTaskCardJson(exported);
  assert.equal(again.ok, true, JSON.stringify(again));
  assert.deepEqual(again.ok ? again.card : undefined, card);
});

test('chat-only draft saves N/A merge data and refuses an AgentInput', () => {
  const card = loadTaskCard(join(root, 'tasks/chat-only-draft'));
  const source = readFileSync(join(root, 'tasks/chat-only-draft/source.md'), 'utf8').trim();
  assert.equal(card.status, 'draft');
  assert.equal(card.public.requirement, source);
  assert.deepEqual(card.public.base_commit, { status: 'todo', reason: 'Not pinned to a commit yet.' });
  assert.deepEqual(card.private.pr, { status: 'N/A', reason: 'Chat-only capture; no pull request was opened.' });
  assert.deepEqual(card.private.merge, { status: 'N/A', reason: 'Chat-only capture; nothing was merged.' });
  assert.deepEqual(card.private.interventions, { status: 'unknown' });
  assert.deepEqual(card.private.verify, { status: 'none' });
  assert.equal(card.private.not_replay_ready?.reason, 'Chat-only capture has no pinned base commit yet, so this card is not replay-ready.');

  assert.throws(() => buildAgentInput(card), (error: unknown) => {
    assert.ok(error instanceof TaskCardError);
    assert.match(error.message, /no pinned base commit/);
    assert.equal(error.message.includes('nothing was merged'), false);
    assert.equal(error.message.includes('no pull request'), false);
    return true;
  });
  assert.throws(() => serializeAgentInput(card), TaskCardError);
});

test('tasks/ loads both samples and no other cards', () => {
  const cards = loadTaskCards(join(root, 'tasks'));
  assert.deepEqual(cards.map(card => card.id), ['chat-only-draft', 'e0-e2-stub-smoke']);
  assert.deepEqual(cards.map(card => card.status), ['draft', 'replay-ready']);
});

test('broken samples report the defect they were written to hit', () => {
  assertIssues('bad-sha.yaml', [
    { field: 'public.base_commit', message: 'not a full 40- or 64-character hex SHA' },
  ]);
  assertIssues('intervention-count-zero.yaml', [
    { field: 'private.interventions.count', message: 'do not store a count; missing history is status unknown, not 0' },
  ]);
  assertIssues('intervention-bare-zero.yaml', [
    { field: 'private.interventions', message: 'expected a status or a list of records, not a count' },
  ]);
  assertIssues('replay-ready-requirement-todo.yaml', [
    { field: 'status', message: 'replay-ready requires a concrete public.requirement' },
  ]);
  assertIssues('requirement-na.yaml', [
    { field: 'public.requirement.status', message: 'N/A is not allowed on a required field' },
  ]);
  assertIssues('base-none.yaml', [
    { field: 'public.base_commit.status', message: 'none is not allowed on a required field' },
  ]);
  assertIssues('draft-missing-reason.yaml', [
    { field: 'private.not_replay_ready.reason', message: 'draft cards must say why they are not replay-ready' },
  ]);
  assertIssues('gold-field.yaml', [
    { field: 'private.gold', message: 'gold and expected output are out of scope for a task card' },
  ]);
  assertIssues('missing-requirement.yaml', [
    { field: 'public.requirement', message: 'required field is missing' },
  ]);
  assertIssues('repo-token.yaml', [
    { field: 'public.repo.token', message: 'unknown field' },
  ]);
  assertIssues('replay-ready-has-blocker.yaml', [
    { field: 'private.not_replay_ready', message: 'replay-ready cards cannot include not_replay_ready' },
  ]);
  assertIssues('two-defects.yaml', [
    { field: 'public.base_commit', message: 'not a full 40- or 64-character hex SHA' },
    { field: 'private.interventions.count', message: 'do not store a count; missing history is status unknown, not 0' },
  ]);
});

test('verify none, todo, unavailable, and a path are legal, and the path stays out of AgentInput', () => {
  const omitted = parseTaskCardYaml(`
schema_version: 1
id: verify-omitted
status: replay-ready
public:
  requirement: "做一件具体的事。"
  repo:
    id: zxc3334/agent-eval
    host: github
  base_commit: "${baseSha}"
`);
  assert.equal(omitted.ok, true, JSON.stringify(omitted));
  if (omitted.ok) {
    assert.deepEqual(omitted.card.private.verify, { status: 'none' });
    assert.deepEqual(omitted.card.private.interventions, { status: 'unknown' });
    assert.equal(JSON.stringify(omitted.card).includes('"count"'), false);
    assert.equal(buildAgentInput(omitted.card).requirement, '做一件具体的事。');
  }

  const todo = parseTaskCardYaml(`
schema_version: 1
id: verify-todo
status: replay-ready
public:
  requirement: "做一件具体的事。"
  repo:
    id: zxc3334/agent-eval
    host: github
  base_commit: "${baseSha}"
private:
  verify:
    status: todo
    reason: "SENTINEL_verify_todo"
`);
  assert.equal(todo.ok, true, JSON.stringify(todo));
  if (todo.ok) {
    assert.deepEqual(todo.card.private.verify, { status: 'todo', reason: 'SENTINEL_verify_todo' });
    assert.equal(serializeAgentInput(todo.card).includes('SENTINEL_verify_todo'), false);
  }

  const unavailable = parseTaskCardYaml(`
schema_version: 1
id: verify-unavailable
status: draft
public:
  requirement: "做一件具体的事。"
  repo:
    id: zxc3334/agent-eval
    host: github
  base_commit: "${baseSha}"
private:
  verify:
    status: unavailable
    reason: "verify 入口这台机器上打不开。"
  not_replay_ready:
    reason: "先把 verify 的缺口记下来，卡本身先以草稿保存。"
`);
  assert.equal(unavailable.ok, true, JSON.stringify(unavailable));
  if (unavailable.ok) {
    assert.equal(unavailable.card.private.verify.status, 'unavailable');
  }

  const withPath = parseTaskCardYaml(`
schema_version: 1
id: verify-path
status: replay-ready
public:
  requirement: "公开的需求原文。"
  repo:
    id: zxc3334/agent-eval
    host: github
  base_commit: "${baseSha}"
private:
  pr:
    number: 77
    url: https://example.invalid/pull/77
  merge:
    sha: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
    diff_stats:
      files: 1
      additions: 99991
      deletions: 0
  interventions:
    records:
      - id: fixup-1
        summary: "SENTINEL_intervention_note"
  verify:
    status: path
    path: verify/SENTINEL_verify_entry.sh
`);
  assert.equal(withPath.ok, true, JSON.stringify(withPath));
  if (withPath.ok) {
    const serialized = serializeAgentInput(withPath.card);
    for (const hidden of [
      'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      '99991',
      'SENTINEL_intervention_note',
      'SENTINEL_verify_entry',
      'example.invalid/pull/77',
    ]) {
      assert.equal(exportCardJson(withPath.card).includes(hidden), true, hidden);
      assert.equal(serialized.includes(hidden), false, hidden);
    }
    assert.deepEqual(buildAgentInput(withPath.card), {
      task_id: 'verify-path',
      requirement: '公开的需求原文。',
      repo: { id: 'zxc3334/agent-eval', host: 'github' },
      base_commit: baseSha,
    });
  }
});

test('replay-ready allows unknown interventions and verify none', () => {
  const result = parseTaskCardYaml(`
schema_version: 1
id: q5-minimum
status: replay-ready
public:
  requirement: "只要原文、仓库和 base。"
  repo:
    id: zhang-chuan-dev/jackson-bot
    host: origin
  base_commit: "${baseSha}"
private:
  provenance:
    status: unknown
  interventions:
    status: unknown
  verify: none
`);
  assert.equal(result.ok, true, JSON.stringify(result));
  if (result.ok) {
    assert.equal(result.card.private.provenance && 'status' in result.card.private.provenance && result.card.private.provenance.status, 'unknown');
    assert.equal(buildAgentInput(result.card).task_id, 'q5-minimum');
    assert.equal(serializeAgentInput(result.card).includes('unknown'), false);
  }
});

test('projectAgentInput drops merge, diff, interventions, and extra repo keys', () => {
  const projected = projectAgentInput({
    task_id: 'e0-e2-stub-smoke',
    requirement: 'public text',
    repo: { id: 'zxc3334/agent-eval', host: 'github', token: 'SENTINEL_repo_token' },
    base_commit: baseSha.toUpperCase(),
    merge: { sha: mergeSha },
    interventions: { records: [{ summary: 'SENTINEL_intervention' }] },
    diff_stats: { additions: 873 },
    pr: { number: 1, url: 'https://github.com/zxc3334/agent-eval/pull/1' },
    verify: { path: 'SENTINEL_verify' },
    status: 'replay-ready',
  });
  assert.deepEqual(projected, {
    task_id: 'e0-e2-stub-smoke',
    requirement: 'public text',
    repo: { id: 'zxc3334/agent-eval', host: 'github' },
    base_commit: baseSha,
  });
  assert.deepEqual(Object.keys(projected.repo), ['id', 'host']);
  const body = JSON.stringify(projected);
  for (const hidden of ['SENTINEL_repo_token', mergeSha, 'SENTINEL_intervention', '873', 'pull/1', 'SENTINEL_verify']) {
    assert.equal(body.includes(hidden), false, hidden);
  }
});

test('directory name must match the card id', () => {
  const dir = mkdtempSync(join(tmpdir(), 'task-card-'));
  const taskDir = join(dir, 'other-id');
  try {
    spawnSync('mkdir', ['-p', taskDir]);
    writeFileSync(join(taskDir, 'card.yaml'), `
schema_version: 1
id: card-id
status: replay-ready
public:
  requirement: "做一件具体的事。"
  repo:
    id: zxc3334/agent-eval
    host: github
  base_commit: "${baseSha}"
`);
    assert.throws(() => loadTaskCard(taskDir), (error: unknown) => {
      assert.ok(error instanceof TaskCardError);
      assert.match(error.message, /directory name "other-id" does not match card id "card-id"/);
      return true;
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('SHA format, missing object, and offline lookup stay distinct', async () => {
  let probes = 0;
  const format = await assessCommit('abc', {
    repoDir: root,
    probe() {
      probes += 1;
      return 'found';
    },
  });
  assert.deepEqual(format, { ok: false, kind: 'format', sha: 'abc', message: 'not a full 40- or 64-character hex SHA' });
  assert.equal(probes, 0);

  const shortReal = await assessCommit(baseSha.slice(0, 7), { repoDir: root });
  assert.equal(shortReal.ok, false);
  if (!shortReal.ok) assert.equal(shortReal.kind, 'format');

  const found = await assessCommit(baseSha, { repoDir: root });
  assert.deepEqual(found, { ok: true, sha: baseSha });
  const upper = await assessCommit(baseSha.toUpperCase(), { repoDir: root });
  assert.deepEqual(upper, { ok: true, sha: baseSha });

  const missing = await assessCommit(missingSha, { repoDir: root });
  assert.deepEqual(missing, { ok: false, kind: 'missing', sha: missingSha, message: 'commit is not in the repository' });
  const sha256 = 'a'.repeat(64);
  const missingLong = await assessCommit(sha256, { repoDir: root });
  assert.equal(missingLong.ok, false);
  if (!missingLong.ok) assert.equal(missingLong.kind, 'missing');

  const schemaOnly = parseTaskCardYaml(`
schema_version: 1
id: sha-not-in-repo
status: replay-ready
public:
  requirement: "格式对即可保存，存在性另查。"
  repo:
    id: zxc3334/agent-eval
    host: github
  base_commit: "${missingSha}"
`);
  assert.equal(schemaOnly.ok, true, JSON.stringify(schemaOnly));
  if (schemaOnly.ok) assert.equal(schemaOnly.card.public.base_commit, missingSha);

  let offlineProbes = 0;
  const offline = await assessCommit(baseSha, {
    offline: true,
    repoDir: root,
    probe() {
      offlineProbes += 1;
      throw new Error('lookup should not run');
    },
  });
  assert.deepEqual(offline, {
    ok: false,
    kind: 'unavailable',
    sha: baseSha,
    message: 'existence was not checked because the lookup is offline',
  });
  assert.equal(offlineProbes, 0);

  const unconfigured = await assessCommit(baseSha);
  assert.deepEqual(unconfigured, {
    ok: false,
    kind: 'unavailable',
    sha: baseSha,
    message: 'no commit store was configured',
  });

  const empty = mkdtempSync(join(tmpdir(), 'not-a-repo-'));
  try {
    const unreachable = await assessCommit(baseSha, { repoDir: empty });
    assert.equal(unreachable.ok, false);
    if (!unreachable.ok) {
      assert.equal(unreachable.kind, 'unavailable');
      assert.match(unreachable.message, /unreachable/);
    }
  } finally {
    rmSync(empty, { recursive: true, force: true });
  }

  const probed = await assessCommit(baseSha, { probe: () => 'unavailable' });
  assert.equal(probed.ok, false);
  if (!probed.ok) assert.equal(probed.kind, 'unavailable');
  const thrown = await assessCommit(baseSha, {
    probe() {
      throw new Error('ENETUNREACH');
    },
  });
  assert.equal(thrown.ok, false);
  if (!thrown.ok) assert.equal(thrown.kind, 'unavailable');
});

test('task card doc states the allowlist, unknown interventions, and unavailable scoring', () => {
  const doc = readFileSync(join(root, 'docs/task-card.md'), 'utf8');
  assert.match(doc, /tasks\/<id>\/card\.yaml/);
  assert.match(doc, /scoring 可以是 unavailable/);
  assert.match(doc, /不得把缺失的插手写成 `0`/);
  for (const key of AGENT_INPUT_ALLOWLIST) assert.match(doc, new RegExp(key));
  assert.match(doc, /不含 merge SHA、合入 diff、PR、插手记录/);
  assert.match(doc, /存在性失败：`missing`/);
  assert.match(doc, /`unavailable`。这不是「commit 不存在」/);
});

test('task validate is not a CLI command yet', () => {
  const result = spawnSync(process.execPath, ['src/eval.ts', 'task', 'validate'], { cwd: root, encoding: 'utf8' });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /unknown command: task/);
});
