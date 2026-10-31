import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { buildAgentInput, parseTaskCardYaml } from '../packages/core/src/task-card.ts';
import { CANDIDATE_DISCLAIMER, baseWarning, buildImportedCard } from '../packages/core/src/task-import.ts';
import { readOriginPull } from '../packages/core/src/task-import-origin.ts';
import { loadImportFile, snapshotFromUnknown } from '../packages/core/src/task-import-snapshot.ts';

const root = join(import.meta.dirname, '..');
const fixtures = join(root, 'tests/fixtures/task-import');
const jacksonExport = join(fixtures, 'jackson-bot-pr8.export.json');
const jacksonMarkdown = join(fixtures, 'jackson-bot-pr8.export.md');
const jacksonOrigin = join(fixtures, 'jackson-bot-pr8.origin-view.json');
const jacksonRepo = join(fixtures, 'jackson-bot-repo.origin-view.json');
const syntheticExport = join(fixtures, 'synthetic-non-default-base.export.json');
const githubExport = join(fixtures, 'agent-eval-pr1.github.json');
const baseSha = '32c3a9a588e3ac831d57d423c3b707558380d70a';
const headSha = '557e9701706e03f205e5c31375dbddf2b3193130';

function evalCli(args: string[], input?: string, env?: NodeJS.ProcessEnv) {
  return spawnSync(process.execPath, [join(root, 'src/eval.ts'), ...args], {
    cwd: root,
    encoding: 'utf8',
    input,
    timeout: 20_000,
    env: env ?? process.env,
  });
}

function freshRoot(): string {
  return mkdtempSync(join(tmpdir(), 'agent-eval-import-'));
}

function script(lines: readonly string[]): string {
  return `${lines.join('\n')}\n`;
}

function errorMarks(text: string): string[] {
  return text.split('\n').filter(line => {
    const splitAt = line.indexOf(': ');
    return splitAt !== -1 && line.slice(splitAt + 2).startsWith('error');
  });
}

function originBin(dir: string): { bin: string; log: string } {
  const bin = join(dir, 'origin-view.js');
  const log = join(dir, 'origin.log');
  writeFileSync(bin, `#!/usr/bin/env node
const { appendFileSync, readFileSync } = require('node:fs');
const args = process.argv.slice(2);
appendFileSync(process.env.LOG, args.join(' ') + '\\n');
const words = args.filter(arg => !arg.startsWith('-'));
const head = words.slice(0, 2).join(' ');
if (head !== 'repo view' && head !== 'pr view') {
  console.error('refused ' + head);
  process.exit(97);
}
if (head === 'repo view') {
  process.stdout.write(readFileSync(process.env.REPO_JSON, 'utf8'));
  process.exit(0);
}
if (words[2] === '8') {
  process.stdout.write(readFileSync(process.env.PR_JSON, 'utf8'));
  process.exit(0);
}
console.error('Error: Not authenticated. Stored logins are disabled');
process.exit(1);
`);
  chmodSync(bin, 0o755);
  return { bin, log };
}

test('recorded jackson-bot #8 export keeps measured fields and candidate discipline', () => {
  const [snap] = loadImportFile(jacksonExport);
  assert.equal(snap.repo, 'zhang-chuan-dev/jackson-bot');
  assert.equal(snap.host, 'origin');
  assert.equal(snap.number, 8);
  assert.equal(snap.baseRef, 'main');
  assert.equal(snap.defaultBranch, 'main');
  assert.equal(snap.baseSha, baseSha);
  assert.equal(snap.headSha, headSha);
  assert.equal(snap.mergeSha, undefined);
  assert.equal(snap.changedFiles, 15);
  assert.equal(snap.additions, 502);
  assert.equal(snap.deletions, 80);
  assert.equal(snap.verify.kind, 'none');
  assert.equal(snap.stacked, false);
  assert.equal(baseWarning(snap), undefined);
  assert.equal(snap.requirementCandidates[0]?.kind, 'linked_issue');
  assert.match(snap.requirementCandidates[0]?.text ?? '', /matchPhrase/);
  assert.equal(snap.comments[0]?.kind, 'review');
  assert.match(snap.url ?? '', /jackson-bot\/pull\/8$/);

  const accepted = buildImportedCard(snap, { id: 'jackson-bot-pr-8', requirement: 'accept', base: 'accept' });
  const parsed = parseTaskCardYaml(accepted, { expectedId: 'jackson-bot-pr-8' });
  assert.equal(parsed.ok, true, JSON.stringify(parsed));
  if (!parsed.ok) return;
  assert.equal(parsed.card.status, 'replay-ready');
  assert.equal(parsed.card.public.base_commit, baseSha);
  assert.match(String(parsed.card.public.requirement), /matchPhrase/);
  assert.equal(parsed.card.private.verify.status, 'none');
  assert.equal('records' in parsed.card.private.interventions, false);
  if ('status' in parsed.card.private.interventions) assert.equal(parsed.card.private.interventions.status, 'todo');
  assert.equal('sha' in (parsed.card.private.merge ?? {}), false);
  const merge = parsed.card.private.merge;
  assert.ok(merge && 'reason' in merge && merge.reason);
  assert.match(merge.reason, /15 files, \+502, -80/);
  const provenance = parsed.card.private.provenance;
  assert.ok(provenance && 'note' in provenance && provenance.note?.includes(CANDIDATE_DISCLAIMER));
  assert.match(provenance && 'note' in provenance ? provenance.note ?? '' : '', /not a separately recorded user utterance/);
  assert.match(provenance && 'note' in provenance ? provenance.note ?? '' : '', /not a separately recorded original start commit/);
  const agent = buildAgentInput(parsed.card);
  assert.deepEqual(Object.keys(agent).sort(), ['base_commit', 'repo', 'requirement', 'task_id']);
  assert.equal(JSON.stringify(agent).includes('unconfirmed'), false);
  assert.equal(JSON.stringify(agent).includes(headSha), false);

  const held = buildImportedCard(snap, { id: 'jackson-bot-pr-8', requirement: 'todo', base: 'todo' });
  const draft = parseTaskCardYaml(held, { expectedId: 'jackson-bot-pr-8' });
  assert.equal(draft.ok, true, JSON.stringify(draft));
  if (!draft.ok) return;
  assert.equal(draft.card.status, 'draft');
  assert.equal(typeof draft.card.public.requirement, 'object');
  assert.equal(JSON.stringify(draft.card.public.requirement).includes('matchPhrase'), false);
  assert.match(JSON.stringify(draft.card.public.base_commit), new RegExp(baseSha));
  assert.equal(typeof draft.card.public.base_commit, 'object');
  assert.match(JSON.stringify(draft.card.private.sources), /matchPhrase/);
});

test('import jackson-bot #8 from the export without GitHub and without a verify gate', () => {
  const dir = freshRoot();
  try {
    const created = evalCli(
      ['task', 'import', '--from-file', jacksonExport, '--root', dir],
      script(['write', '', 'accept', 'accept']),
    );
    assert.equal(created.status, 0, created.stderr);
    const file = join(dir, 'tasks', 'jackson-bot-pr-8', 'card.yaml');
    assert.equal(created.stdout.trim(), file);
    assert.match(created.stderr, /requirement candidates:/);
    assert.match(created.stderr, /base candidate: 32c3a9a588e3ac831d57d423c3b707558380d70a/);
    assert.match(created.stderr, new RegExp(CANDIDATE_DISCLAIMER.replace(/[.]/g, '\\.')));
    const parsed = parseTaskCardYaml(readFileSync(file, 'utf8'), { expectedId: 'jackson-bot-pr-8' });
    assert.equal(parsed.ok, true, JSON.stringify(parsed));
    if (!parsed.ok) return;
    assert.equal(parsed.card.public.repo && 'id' in parsed.card.public.repo && parsed.card.public.repo.id, 'zhang-chuan-dev/jackson-bot');
    assert.equal(parsed.card.public.repo && 'host' in parsed.card.public.repo && parsed.card.public.repo.host, 'origin');
    assert.equal(parsed.card.private.verify.status, 'none');
    assert.equal('records' in parsed.card.private.interventions, false);

    const listed = evalCli(['task', 'list', '--root', dir]);
    assert.equal(listed.status, 0, listed.stderr);
    assert.match(listed.stdout, new RegExp(`jackson-bot-pr-8\\treplay-ready\\t${baseSha.slice(0, 7)}\\ttodo\\tnone\\t0`));
    const validated = evalCli(['task', 'validate', 'jackson-bot-pr-8', '--root', dir, '--offline']);
    assert.equal(validated.status, 0, validated.stderr + validated.stdout);
    assert.match(validated.stdout, /private\.verify: status none/);
    assert.match(validated.stdout, /existence: unavailable/);
    assert.match(validated.stdout, /result: ok/);
    assert.deepEqual(errorMarks(validated.stdout), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('markdown export and a rejected candidate write no partial card', () => {
  const dir = freshRoot();
  try {
    const rejected = evalCli(
      ['task', 'import', '--from-file', jacksonMarkdown, '--root', dir],
      script(['reject']),
    );
    assert.equal(rejected.status, 0, rejected.stderr);
    assert.equal(rejected.stdout.trim(), '');
    assert.match(rejected.stderr, /rejected: no card written for zhang-chuan-dev\/jackson-bot#8/);
    assert.equal(existsSync(join(dir, 'tasks')), false);

    const imported = evalCli(
      ['task', 'import', '--from-file', jacksonMarkdown, '--root', dir],
      script(['write', '', 'todo', 'accept']),
    );
    assert.equal(imported.status, 0, imported.stderr);
    const parsed = parseTaskCardYaml(readFileSync(join(dir, 'tasks', 'jackson-bot-pr-8', 'card.yaml'), 'utf8'), { expectedId: 'jackson-bot-pr-8' });
    assert.equal(parsed.ok, true, JSON.stringify(parsed));
    if (!parsed.ok) return;
    assert.equal(parsed.card.public.base_commit, baseSha);
    assert.equal(typeof parsed.card.public.requirement, 'object');
    assert.equal(JSON.stringify(parsed.card.public.requirement).includes('matchPhrase'), false);
    assert.match(JSON.stringify(parsed.card.private.sources), /matchPhrase/);
    assert.equal(parsed.card.private.verify.status, 'none');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('non-default base prompts, and no means no file', () => {
  const dir = freshRoot();
  try {
    const declined = evalCli(
      ['task', 'import', '--from-file', syntheticExport, '--root', dir],
      script(['no']),
    );
    assert.equal(declined.status, 0, declined.stderr);
    assert.match(declined.stderr, /is not the default branch/);
    assert.match(declined.stderr, /Stacked pull requests were not split/);
    assert.match(declined.stderr, /rejected: no card written/);
    assert.equal(declined.stdout.trim(), '');
    assert.equal(existsSync(join(dir, 'tasks')), false);

    const kept = evalCli(
      ['task', 'import', '--from-file', syntheticExport, '--root', dir],
      script(['yes', 'write', 'stacked-child', 'todo', 'todo']),
    );
    assert.equal(kept.status, 0, kept.stderr);
    const file = join(dir, 'tasks', 'stacked-child', 'card.yaml');
    assert.equal(existsSync(file), true);
    const text = readFileSync(file, 'utf8');
    assert.equal(text.includes('records:'), false);
    const parsed = parseTaskCardYaml(text, { expectedId: 'stacked-child' });
    assert.equal(parsed.ok, true, JSON.stringify(parsed));
    if (!parsed.ok) return;
    assert.equal(parsed.card.status, 'draft');
    assert.equal(typeof parsed.card.public.base_commit, 'object');
    const provenance = parsed.card.private.provenance;
    assert.match(provenance && 'note' in provenance ? provenance.note ?? '' : '', /is not the default branch/);
    assert.equal('records' in parsed.card.private.interventions, false);
    if ('status' in parsed.card.private.interventions) assert.equal(parsed.card.private.interventions.status, 'todo');
    assert.equal(readdirSync(join(dir, 'tasks')).length, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a batch can write one item and reject the next without a half-written card', () => {
  const dir = freshRoot();
  try {
    const batchFile = join(dir, 'batch.json');
    writeFileSync(batchFile, JSON.stringify({
      items: [
        JSON.parse(readFileSync(jacksonExport, 'utf8')),
        JSON.parse(readFileSync(syntheticExport, 'utf8')),
      ],
    }));
    const snaps = loadImportFile(batchFile);
    assert.equal(snaps.length, 2);
    assert.equal(snaps[0]?.number, 8);
    assert.equal(snaps[1]?.baseRef, 'feature/parent');

    const batch = evalCli(
      ['task', 'import', '--from-file', jacksonExport, '--from-file', syntheticExport, '--root', dir],
      script(['write', '', 'todo', 'todo', 'no']),
    );
    assert.equal(batch.status, 0, batch.stderr);
    assert.equal(existsSync(join(dir, 'tasks', 'jackson-bot-pr-8', 'card.yaml')), true);
    assert.equal(existsSync(join(dir, 'tasks', 'stacked-pr-4')), false);
    assert.equal(existsSync(join(dir, 'tasks', 'jackson-bot-pr-8', 'card.yaml.tmp')), false);
    const names = readdirSync(join(dir, 'tasks'));
    assert.deepEqual(names, ['jackson-bot-pr-8']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('offline and unreadable exports fail before any card file exists', () => {
  const dir = freshRoot();
  const { bin, log } = originBin(dir);
  const env = {
    ...process.env,
    AGENT_EVAL_ORIGIN_BIN: bin,
    LOG: log,
    REPO_JSON: jacksonRepo,
    PR_JSON: jacksonOrigin,
  };
  try {
    const offline = evalCli(
      ['task', 'import', '--offline', '--pr', 'zhang-chuan-dev/jackson-bot#8', '--root', dir],
      undefined,
      env,
    );
    assert.equal(offline.status, 2, offline.stderr);
    assert.match(offline.stderr, /Offline: cannot read zhang-chuan-dev\/jackson-bot#8 from Origin/);
    assert.match(offline.stderr, /No card was written/);
    assert.equal(existsSync(log), false);
    assert.equal(existsSync(join(dir, 'tasks')), false);

    const missing = evalCli(['task', 'import', '--from-file', join(dir, 'missing.json'), '--root', dir]);
    assert.equal(missing.status, 2);
    assert.match(missing.stderr, /export file not found/);
    assert.match(missing.stderr, /No card was written/);
    assert.equal(existsSync(join(dir, 'tasks')), false);

    const broken = join(dir, 'broken.json');
    writeFileSync(broken, '{');
    const invalid = evalCli(['task', 'import', '--from-file', broken, '--root', dir]);
    assert.notEqual(invalid.status, 0);
    assert.match(invalid.stderr, /cannot parse export/);
    assert.match(invalid.stderr, /No card was written/);
    assert.equal(existsSync(join(dir, 'tasks')), false);

    const badSha = join(dir, 'bad-sha.json');
    writeFileSync(badSha, '{"repo":"a/b","host":"origin","number":1,"base_sha":"abc"}\n');
    const sha = evalCli(['task', 'import', '--from-file', badSha, '--root', dir]);
    assert.notEqual(sha.status, 0);
    assert.match(sha.stderr, /not a full 40- or 64-character hex SHA/);
    assert.equal(existsSync(join(dir, 'tasks')), false);

    writeFileSync(join(dir, 'tasks'), 'not-a-directory\n');
    const failedWrite = evalCli(
      ['task', 'import', '--from-file', jacksonExport, '--root', dir],
      script(['write', '', 'accept', 'accept']),
    );
    assert.equal(failedWrite.status, 1, failedWrite.stderr);
    assert.match(failedWrite.stderr, /No card was written/);
    assert.equal(readFileSync(join(dir, 'tasks'), 'utf8'), 'not-a-directory\n');
    assert.equal(existsSync(join(dir, 'tasks', 'jackson-bot-pr-8', 'card.yaml')), false);
    assert.equal(existsSync(join(dir, 'tasks', 'jackson-bot-pr-8', 'card.yaml.tmp')), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('Origin read uses only view commands and a recorded pull view', () => {
  const dir = freshRoot();
  const { bin, log } = originBin(dir);
  try {
    assert.throws(
      () => readOriginPull('zhang-chuan-dev/jackson-bot', 8, { offline: true, bin }),
      /Offline: cannot read zhang-chuan-dev\/jackson-bot#8/,
    );
    const created = evalCli(
      ['task', 'import', '--pr', 'zhang-chuan-dev/jackson-bot#8', '--root', dir],
      script(['write', '', 'accept']),
      {
        ...process.env,
        AGENT_EVAL_ORIGIN_BIN: bin,
        LOG: log,
        REPO_JSON: jacksonRepo,
        PR_JSON: jacksonOrigin,
      },
    );
    assert.equal(created.status, 0, created.stderr);
    const lines = readFileSync(log, 'utf8').trim().split('\n');
    assert.deepEqual(lines.map(line => line.split(' ').slice(0, 2).join(' ')), ['repo view', 'pr view']);
    assert.match(lines[1], /pr view 8 -R zhang-chuan-dev\/jackson-bot/);
    const parsed = parseTaskCardYaml(readFileSync(join(dir, 'tasks', 'jackson-bot-pr-8', 'card.yaml'), 'utf8'), { expectedId: 'jackson-bot-pr-8' });
    assert.equal(parsed.ok, true, JSON.stringify(parsed));
    if (!parsed.ok) return;
    assert.equal(parsed.card.public.base_commit, baseSha);
    assert.equal(typeof parsed.card.public.requirement, 'object');
    assert.equal(parsed.card.private.verify.status, 'todo');
    if ('status' in parsed.card.private.interventions) assert.equal(parsed.card.private.interventions.status, 'unknown');
    const validated = evalCli(['task', 'validate', 'jackson-bot-pr-8', '--root', dir, '--offline']);
    assert.equal(validated.status, 0, validated.stderr + validated.stdout);
    assert.match(validated.stdout, /private\.verify: status todo/);
    assert.match(validated.stdout, /result: ok/);
    assert.deepEqual(errorMarks(validated.stdout), []);

    const second = join(dir, 'second');
    mkdirSync(second);
    const unauth = evalCli(
      ['task', 'import', '--pr', 'zhang-chuan-dev/jackson-bot#5', '--root', second],
      undefined,
      {
        ...process.env,
        AGENT_EVAL_ORIGIN_BIN: bin,
        LOG: log,
        REPO_JSON: jacksonRepo,
        PR_JSON: jacksonOrigin,
      },
    );
    assert.equal(unauth.status, 2, unauth.stderr);
    assert.match(unauth.stderr, /not authenticated/i);
    assert.match(unauth.stderr, /No card was written for zhang-chuan-dev\/jackson-bot#5/);
    assert.equal(existsSync(join(dir, 'second', 'tasks')), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('recorded GitHub agent-eval #1 matches the sample card base and merge', () => {
  const sample = parseTaskCardYaml(readFileSync(join(root, 'tasks/e0-e2-stub-smoke/card.yaml'), 'utf8'), { expectedId: 'e0-e2-stub-smoke' });
  assert.equal(sample.ok, true, JSON.stringify(sample));
  if (!sample.ok) return;
  const dir = freshRoot();
  const ghLog = join(dir, 'gh.log');
  const ghBin = join(dir, 'gh.js');
  writeFileSync(ghBin, '#!/usr/bin/env node\nrequire("node:fs").appendFileSync(process.env.GH_LOG, process.argv.slice(2).join(" ") + "\\n");\nprocess.exit(99);\n');
  chmodSync(ghBin, 0o755);
  try {
    const created = evalCli(
      ['task', 'import', '--from-file', githubExport, '--root', dir],
      script(['write', 'agent-eval-pr-1', 'accept', 'accept']),
      { ...process.env, AGENT_EVAL_GH_BIN: ghBin, GH_LOG: ghLog, AGENT_EVAL_ORIGIN_BIN: ghBin },
    );
    assert.equal(created.status, 0, created.stderr);
    assert.equal(existsSync(ghLog), false);
    const parsed = parseTaskCardYaml(readFileSync(join(dir, 'tasks', 'agent-eval-pr-1', 'card.yaml'), 'utf8'), { expectedId: 'agent-eval-pr-1' });
    assert.equal(parsed.ok, true, JSON.stringify(parsed));
    if (!parsed.ok) return;
    assert.equal(parsed.card.public.base_commit, sample.card.public.base_commit);
    assert.deepEqual(parsed.card.private.merge, sample.card.private.merge);
    assert.equal(parsed.card.public.repo && 'host' in parsed.card.public.repo && parsed.card.public.repo.host, 'github');
    assert.match(String(parsed.card.public.requirement), /E0/);
    const provenance = parsed.card.private.provenance;
    assert.match(provenance && 'note' in provenance ? provenance.note ?? '' : '', /candidates only/);
    if ('status' in parsed.card.private.interventions) assert.equal(parsed.card.private.interventions.status, 'unknown');
    const agent = buildAgentInput(parsed.card);
    const merge = parsed.card.private.merge;
    const mergeSha = merge && 'sha' in merge ? merge.sha : '';
    assert.equal(agent.base_commit, parsed.card.public.base_commit);
    assert.notEqual(agent.base_commit, mergeSha);
    assert.equal(JSON.stringify(agent).includes(mergeSha), false);
    assert.deepEqual(Object.keys(agent).sort(), ['base_commit', 'repo', 'requirement', 'task_id']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('review text stays an unconfirmed candidate', () => {
  const snap = snapshotFromUnknown({
    repo: 'zhang-chuan-dev/jackson-bot',
    host: 'origin',
    number: 8,
    reviews: [{ state: 'CHANGES_REQUESTED', body: 'Bind the approval id before the second confirm.' }],
    threads: [{ comments: [{ body: 'nit: name the helper' }] }],
    verify: 'none',
  });
  assert.equal(snap.comments.some(comment => comment.kind === 'fixup'), true);
  const yaml = buildImportedCard(snap, { id: 'review-candidate', requirement: 'todo', base: 'todo' });
  const parsed = parseTaskCardYaml(yaml, { expectedId: 'review-candidate' });
  assert.equal(parsed.ok, true, JSON.stringify(parsed));
  if (!parsed.ok) return;
  assert.equal('records' in parsed.card.private.interventions, false);
  if ('status' in parsed.card.private.interventions) assert.equal(parsed.card.private.interventions.status, 'todo');
  assert.equal(yaml.includes('records:'), false);
  assert.equal(yaml.includes('\n  count:'), false);
  assert.equal(parsed.card.private.verify.status, 'none');
});
