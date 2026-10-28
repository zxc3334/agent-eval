import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { loadCase, suiteCases } from '../src/config.ts';
import { evaluate } from '../src/evaluation.ts';

const json = (path: string) => JSON.parse(readFileSync(path, 'utf8'));
test('separate trials keep fresh workspaces and identify their results', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'e9-trials-'));
  try {
    const casesDir = resolve('cases');
    const c = loadCase(casesDir, 'smoke', suiteCases(casesDir, 'smoke')[0]);
    const a = await evaluate(c, dir, new AbortController().signal, undefined, undefined, 'stub', undefined, undefined, 1);
    const b = await evaluate(c, dir, new AbortController().signal, undefined, undefined, 'stub', undefined, undefined, 2);
    assert.equal(a.trial, 1); assert.equal(b.trial, 2);
    assert.notEqual(a.session_id, b.session_id);
    assert.equal(json(join(dir, 'cases', c.config.id, 'trials', '1', 'result.json')).trial, 1);
    assert.equal(json(join(dir, 'cases', c.config.id, 'trials', '2', 'result.json')).trial, 2);
    assert.equal(a.steps_used, 1);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('product tool calls over budget stop execution with an explicit reason', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'e9-budget-'));
  try {
    const product = join(dir, 'product'); mkdirSync(product);
    writeFileSync(join(product, 'entry.cjs'), `const send = e => console.log(JSON.stringify({protocol_version:1,...e}));\nprocess.stdin.resume(); process.stdin.on('end',()=>{send({type:'tool_call',tool:'x',arguments:{}});send({type:'tool_call',tool:'x',arguments:{}});setInterval(()=>{},1000)});`);
    writeFileSync(join(product, 'agent-eval-entry.json'), JSON.stringify({protocol_version:1, entry:'entry.cjs', capabilities:['headless','fixture_injection','mock_tools','isolated_storage','session_reset','jsonl_events']}));
    for (const args of [['init','-q'],['add','.'],['-c','user.name=Test','-c','user.email=test@example.invalid','commit','-qm','fixture']]) assert.equal(spawnSync('git', args, {cwd:product}).status, 0);
    const revision = spawnSync('git', ['rev-parse','HEAD'], {cwd:product,encoding:'utf8'}).stdout.trim();
    const casesDir = resolve('cases');
    const c = loadCase(casesDir, 'smoke', suiteCases(casesDir, 'smoke')[0]);
    c.input.budgets.max_steps = 1;
    const result = await evaluate(c, dir, new AbortController().signal, undefined, undefined, 'jackson-bot-pi', undefined, {adapter:'jackson-bot-pi',model:'test',product:{path:product,entry:'entry.cjs',revision,sampling:{temperature:0.2}}});
    assert.deepEqual(json(join(dir, 'cases', c.config.id, 'artifacts', 'product-request.json')).sampling, {temperature:0.2});
    assert.equal(result.status, 'agent_error');
    assert.match(result.stop_reason!, /step budget/i);
    assert.equal(result.steps_used, 2);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('product usage and steps in a final JSONL line without a newline are retained', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'e9-tail-'));
  try {
    const product = join(dir, 'product'); mkdirSync(product);
    writeFileSync(join(product, 'entry.cjs'), `process.stdin.resume(); process.stdin.on('end',()=>{console.log(JSON.stringify({protocol_version:1,type:'final',answer:'hello'})); console.log(JSON.stringify({protocol_version:1,type:'usage',usage:{input_tokens:4,cost:0}})); process.stdout.write(JSON.stringify({protocol_version:1,type:'tool_call',tool:'x',arguments:{}}))});`);
    writeFileSync(join(product, 'agent-eval-entry.json'), JSON.stringify({protocol_version:1, entry:'entry.cjs', capabilities:['headless','fixture_injection','mock_tools','isolated_storage','session_reset','jsonl_events']}));
    for (const args of [['init','-q'],['add','.'],['-c','user.name=Test','-c','user.email=test@example.invalid','commit','-qm','fixture']]) assert.equal(spawnSync('git', args, {cwd:product}).status, 0);
    const revision = spawnSync('git', ['rev-parse','HEAD'], {cwd:product,encoding:'utf8'}).stdout.trim();
    const casesDir = resolve('cases');
    const c = loadCase(casesDir, 'smoke', suiteCases(casesDir, 'smoke')[0]);
    const result = await evaluate(c, dir, new AbortController().signal, undefined, undefined, 'jackson-bot-pi', undefined, {adapter:'jackson-bot-pi',model:'test',product:{path:product,entry:'entry.cjs',revision}});
    assert.deepEqual(result.usage, {input_tokens:4,cost:0});
    assert.equal(result.steps_used, 1);
    assert.equal(result.status, 'pass');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
