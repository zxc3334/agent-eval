import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { verify } from '../src/verifier.ts';
import { normalizeCriteria } from '../src/criteria.ts';
import type { Criterion } from '../src/types.ts';
import { write } from './helpers.ts';

const target = { artifact: 'trace.json', field: '/calls' };
const call = (tool: string, args: Record<string, unknown> = {}, error?: string) => ({
  tool, arguments: args, ...(error ? { error } : {}),
});

function sandbox(t: { after: (fn: () => void) => void }) {
  const dir = mkdtempSync(join(tmpdir(), 'agent-eval-traj-'));
  const artifacts = join(dir, 'artifacts');
  mkdirSync(artifacts);
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return { dir, artifacts, file: join(artifacts, 'trace.json') };
}

test('call_sequence validates contiguous and subsequence tool invocations', async t => {
  const s = sandbox(t);
  const calls = [call('init'), call('search'), call('read'), call('edit'), call('cleanup')];
  write(s.file, { calls });

  // 1. Contiguous match
  const exactCriterion: Criterion = {
    id: 'exact-seq',
    type: 'call_sequence',
    target,
    params: { sequence: ['search', 'read', 'edit'] },
    mode: 'hard',
    reason: 'Must search, read, then edit contiguously.',
  };
  const exactRes = await verify([exactCriterion], s.artifacts, s.dir);
  assert.equal(exactRes.status, 'pass');
  assert.equal(exactRes.assertions[0].passed, true);

  // 2. Contiguous fail (gap exists)
  const brokenContiguous: Criterion = {
    id: 'broken-seq',
    type: 'call_sequence',
    target,
    params: { sequence: ['init', 'read'] },
    mode: 'hard',
    reason: 'Non-contiguous sequence should fail.',
  };
  const brokenRes = await verify([brokenContiguous], s.artifacts, s.dir);
  assert.equal(brokenRes.status, 'fail');
  assert.equal(brokenRes.assertions[0].passed, false);
  assert.match(brokenRes.assertions[0].problem!, /contiguous sequence.*not found/);

  // 3. Subsequence allowed (gap ok)
  const subseqCriterion: Criterion = {
    id: 'subseq',
    type: 'call_sequence',
    target,
    params: { sequence: ['init', 'read', 'cleanup'], allow_subsequence: true },
    mode: 'hard',
    reason: 'Must execute init, read, and cleanup in order.',
  };
  const subseqRes = await verify([subseqCriterion], s.artifacts, s.dir);
  assert.equal(subseqRes.status, 'pass');
  assert.equal(subseqRes.assertions[0].passed, true);
});

test('call_after enforces prerequisite ordering and flags premature calls', async t => {
  const s = sandbox(t);

  const criterion: Criterion = {
    id: 'must-auth-first',
    type: 'call_after',
    target,
    params: { prerequisite: 'auth_login', successor: 'delete_resource' },
    mode: 'hard',
    reason: 'Cannot delete resource before login.',
  };

  // Valid order: login then delete
  write(s.file, { calls: [call('auth_login'), call('get_info'), call('delete_resource')] });
  const passed = await verify([criterion], s.artifacts, s.dir);
  assert.equal(passed.status, 'pass');
  assert.equal(passed.assertions[0].passed, true);

  // Invalid order: delete before login
  write(s.file, { calls: [call('delete_resource'), call('auth_login')] });
  const failed = await verify([criterion], s.artifacts, s.dir);
  assert.equal(failed.status, 'fail');
  assert.equal(failed.assertions[0].passed, false);
  assert.match(failed.assertions[0].problem!, /delete_resource called at index 0 before prerequisite auth_login/);
});

test('error_recovery verifies that tool failure triggers recovery tool', async t => {
  const s = sandbox(t);

  const criterion: Criterion = {
    id: 'recover-on-404',
    type: 'error_recovery',
    target,
    params: { failing_tool: 'fetch_remote', recovery_tool: 'fallback_cache' },
    mode: 'hard',
    reason: 'When remote fetch fails, must invoke fallback cache.',
  };

  // Proper recovery: fetch_remote fails, immediate next tool is fallback_cache
  write(s.file, {
    calls: [
      call('init'),
      call('fetch_remote', { url: 'https://api.example.com' }, 'Network 500 error'),
      call('fallback_cache', { key: 'data' }),
      call('render'),
    ],
  });
  const passed = await verify([criterion], s.artifacts, s.dir);
  assert.equal(passed.status, 'pass');
  assert.equal(passed.assertions[0].passed, true);

  // Failed recovery: fetch_remote fails, but agent immediately gave up or called render
  write(s.file, {
    calls: [
      call('init'),
      call('fetch_remote', { url: 'https://api.example.com' }, 'Network 500 error'),
      call('render'),
    ],
  });
  const failed = await verify([criterion], s.artifacts, s.dir);
  assert.equal(failed.status, 'fail');
  assert.equal(failed.assertions[0].passed, false);
  assert.match(failed.assertions[0].problem!, /failed to invoke fallback_cache immediately after error in fetch_remote/);
});

test('budget_limit caps maximum tool invocations', async t => {
  const s = sandbox(t);

  const criterion: Criterion = {
    id: 'tool-budget',
    type: 'budget_limit',
    target,
    params: { max_tool_calls: 3 },
    mode: 'hard',
    reason: 'Do not exceed 3 tool calls.',
  };

  // 3 calls: pass
  write(s.file, { calls: [call('step1'), call('step2'), call('step3')] });
  const passed = await verify([criterion], s.artifacts, s.dir);
  assert.equal(passed.status, 'pass');
  assert.equal(passed.assertions[0].passed, true);

  // 4 calls: fail
  write(s.file, { calls: [call('step1'), call('step2'), call('step3'), call('step4')] });
  const failed = await verify([criterion], s.artifacts, s.dir);
  assert.equal(failed.status, 'fail');
  assert.equal(failed.assertions[0].passed, false);
  assert.match(failed.assertions[0].problem!, /exceeded max_tool_calls: limit was 3, actual was 4/);
});
