import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

// This deliberately small fake product is a protocol peer, not evidence of a
// real jackson-bot run. It records what the adapter actually sent it.
function setup(mode: 'normal' | 'missing-capability' | 'invalid-event' | 'error-event' | 'missing-manifest' | 'missing-final') {
  const root = mkdtempSync(join(tmpdir(), 'agent-eval-e8-test-'));
  const product = join(root, 'product'); const runs = join(root, 'runs'); mkdirSync(product);
  const source = `
const fs = require('node:fs');
const mode = ${JSON.stringify(mode)};
fs.writeFileSync(${JSON.stringify(join(root, 'entry-executed'))}, 'executed');
if (process.argv.includes('--agent-eval-preflight')) {
  const capabilities = ['headless','fixture_injection','mock_tools','isolated_storage','session_reset','jsonl_events'];
  console.log(JSON.stringify({protocol_version:1, capabilities:mode === 'missing-capability' ? capabilities.filter(x => x !== 'fixture_injection') : capabilities}));
} else {
  const req = JSON.parse(fs.readFileSync(0, 'utf8'));
  const send = event => console.log(JSON.stringify({protocol_version:1, ...event}));
  if (mode === 'invalid-event') { send({type:'unknown'}); process.exit(0); }
  if (mode === 'error-event') { send({type:'error', message:'mock tool unavailable'}); process.exit(0); }
  if (mode === 'missing-final') { send({type:'usage', usage:{input_tokens:1}}); process.exit(0); }
  const prior = fs.existsSync(req.storage_dir + '/sentinel');
  fs.writeFileSync(req.storage_dir + '/sentinel', 'present');
  send({type:'tool_call', tool:'mock_lookup', arguments:{query:'fixture'}});
  send({type:'tool_result', tool:'mock_lookup', result:req.fixture.answer});
  send({type:'artifact', path:'resource.json', content:JSON.stringify({request:req, prior})});
  send({type:'usage', usage:{input_tokens:1,output_tokens:1}});
  send({type:'final', answer:req.fixture.answer});
}
`;
  writeFileSync(join(product, 'entry.cjs'), source);
  if (mode !== 'missing-manifest') {
    const capabilities = ['headless', 'fixture_injection', 'mock_tools', 'isolated_storage', 'session_reset', 'jsonl_events'];
    writeFileSync(join(product, 'agent-eval-entry.json'), JSON.stringify({ protocol_version: 1, entry: 'entry.cjs', capabilities: mode === 'missing-capability' ? capabilities.filter(x => x !== 'fixture_injection') : capabilities }));
  }
  const git = (...args: string[]) => {
    const result = spawnSync('git', args, { cwd: product, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr); return result.stdout.trim();
  };
  git('init', '-q'); git('add', '.');
  git('-c', 'user.name=E8 Test', '-c', 'user.email=e8-test@example.invalid', 'commit', '-qm', 'fixture');
  const revision = git('rev-parse', 'HEAD');
  const experiment = join(root, 'experiment.json');
  writeFileSync(experiment, JSON.stringify({adapter:'jackson-bot-pi', model:'test-model', product:{path:product,revision,entry:'entry.cjs'}}));
  return { root, product, runs, experiment };
}
function run(experiment: string, runs: string, cases?: string) {
  return spawnSync(process.execPath, [resolve('src/cli.ts'), '--suite', 'smoke', '--agent', 'jackson-bot-pi', '--experiment', experiment, '--runs-dir', runs, ...(cases ? ['--cases-dir', cases] : [])], { encoding:'utf8', timeout: 20000 });
}
function json(path: string): any { return JSON.parse(readFileSync(path, 'utf8')); }

test('product protocol reaches verifier, preserves events, and resets session and isolated storage', () => {
  const t = setup('normal');
  try {
    const result = run(t.experiment, t.runs);
    assert.equal(result.status, 1, result.stderr); // smoke includes an intentional failing assertion
    const dir = join(t.runs, readdirSync(t.runs)[0]);
    const cases = ['smoke-pass', 'smoke-fail'].map(id => join(dir, 'cases', id));
    assert.deepEqual(cases.map(d => json(join(d, 'result.json')).status), ['pass', 'fail']);
    const proof = cases.map(d => json(join(d, 'artifacts/resource.json')));
    assert.notEqual(proof[0].request.session_id, proof[1].request.session_id);
    assert.notEqual(proof[0].request.storage_dir, proof[1].request.storage_dir);
    for (const [index, p] of proof.entries()) {
      assert.equal(p.prior, false); assert.equal(p.request.protocol_version, 1);
      assert.equal(p.request.model, 'test-model'); assert.equal(p.request.mock_tools, true);
      assert.equal(p.request.fixture.answer, index === 0 ? 'hello' : 'wrong');
      assert.equal(Object.hasOwn(p.request, 'acceptance'), false);
      assert.equal(existsSync(p.request.storage_dir), false);
      assert.equal(json(join(cases[index], 'artifacts/answer.json')).answer, p.request.fixture.answer);
      const events = readFileSync(join(cases[index], 'artifacts/product-events.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line));
      assert.deepEqual(events.map(e => e.type), ['tool_call', 'tool_result', 'artifact', 'usage', 'final']);
      assert.ok(json(join(cases[index], 'result.json')).assertions.length > 0);
      assert.ok(readFileSync(join(cases[index], 'events.jsonl'), 'utf8').includes('verifier'));
    }
  } finally { rmSync(t.root, { recursive:true, force:true }); }
});

test('preflight fails closed when fixture injection is absent', () => {
  const t = setup('missing-capability');
  try {
    const result = run(t.experiment, t.runs);
    assert.equal(result.status, 2);
    assert.match(result.stdout + result.stderr, /fixture_injection/);
    assert.equal(existsSync(join(t.root, 'entry-executed')), false);
    if (existsSync(t.runs)) for (const dir of readdirSync(t.runs)) {
      const runDir = join(t.runs, dir);
      if (existsSync(join(runDir, 'cases'))) for (const id of readdirSync(join(runDir, 'cases'))) {
        const file = join(runDir, 'cases', id, 'result.json');
        if (existsSync(file)) assert.notEqual(json(file).status, 'pass');
      }
    }
  } finally { rmSync(t.root, { recursive:true, force:true }); }
});

test('missing static capability manifest never executes the product entry', () => {
  const t = setup('missing-manifest');
  try {
    const result = run(t.experiment, t.runs);
    assert.equal(result.status, 2);
    assert.match(result.stdout + result.stderr, /manifest|agent-eval-entry\.json/i);
    assert.equal(existsSync(join(t.root, 'entry-executed')), false);
  } finally { rmSync(t.root, { recursive:true, force:true }); }
});

test('revision mismatch and dirty tracked checkout fail before executing the entry', () => {
  for (const mode of ['revision', 'dirty'] as const) {
    const t = setup('normal');
    try {
      if (mode === 'revision') {
        const experiment = json(t.experiment);
        experiment.product.revision = '0'.repeat(40);
        writeFileSync(t.experiment, JSON.stringify(experiment));
      } else {
        writeFileSync(join(t.product, 'entry.cjs'), readFileSync(join(t.product, 'entry.cjs'), 'utf8') + '\n// dirty\n');
      }
      const result = run(t.experiment, t.runs);
      assert.equal(result.status, 2, result.stdout + result.stderr);
      assert.match(result.stdout + result.stderr, mode === 'revision' ? /revision/i : /clean|dirty/i);
      assert.equal(existsSync(join(t.root, 'entry-executed')), false);
    } finally { rmSync(t.root, { recursive:true, force:true }); }
  }
});

test('harness protocol evidence filenames cannot be declared as case outputs', () => {
  const t = setup('normal');
  try {
    const cases = join(t.root, 'cases'); cpSync('cases', cases, { recursive: true });
    const configFile = join(cases, 'smoke/smoke-pass/case.json');
    const original = json(configFile);
    for (const name of ['product-request.json', 'product-events.jsonl']) {
      writeFileSync(configFile, JSON.stringify({ ...original, artifact_allowlist: [...original.artifact_allowlist, name] }));
      const result = run(t.experiment, t.runs, cases);
      assert.equal(result.status, 2, result.stdout + result.stderr);
      assert.match(result.stdout + result.stderr, /artifact_allowlist|output path/);
      assert.equal(existsSync(join(t.root, 'entry-executed')), false);
    }
  } finally { rmSync(t.root, { recursive:true, force:true }); }
});

test('unknown event and missing final cannot be scored as a successful protocol response', () => {
  const t = setup('invalid-event');
  try {
    const result = run(t.experiment, t.runs);
    assert.equal(result.status, 2);
    const dir = join(t.runs, readdirSync(t.runs)[0]);
    for (const id of ['smoke-pass', 'smoke-fail']) {
      const outcome = json(join(dir, 'cases', id, 'result.json'));
      assert.notEqual(outcome.status, 'pass'); assert.notEqual(outcome.status, 'fail');
    }
  } finally { rmSync(t.root, { recursive:true, force:true }); }
});

test('a valid JSONL stream without a final event cannot be scored', () => {
  const t = setup('missing-final');
  try {
    const result = run(t.experiment, t.runs);
    assert.equal(result.status, 2);
    const dir = join(t.runs, readdirSync(t.runs)[0]);
    for (const id of ['smoke-pass', 'smoke-fail']) {
      const caseDir = join(dir, 'cases', id);
      assert.equal(json(join(caseDir, 'result.json')).status, 'agent_error');
      assert.match(readFileSync(join(caseDir, 'artifacts/stderr.log'), 'utf8'), /missing final/i);
      assert.equal(existsSync(join(caseDir, 'artifacts/answer.json')), false);
    }
  } finally { rmSync(t.root, { recursive:true, force:true }); }
});

test('product error events retain evidence and do not become scored answers', () => {
  const t = setup('error-event');
  try {
    const result = run(t.experiment, t.runs);
    assert.equal(result.status, 2);
    const dir = join(t.runs, readdirSync(t.runs)[0]);
    for (const id of ['smoke-pass', 'smoke-fail']) {
      const caseDir = join(dir, 'cases', id);
      assert.equal(json(join(caseDir, 'result.json')).status, 'agent_error');
      const event = JSON.parse(readFileSync(join(caseDir, 'artifacts/product-events.jsonl'), 'utf8'));
      assert.equal(event.type, 'error'); assert.equal(event.message, 'mock tool unavailable');
      assert.equal(existsSync(join(caseDir, 'artifacts/answer.json')), false);
    }
  } finally { rmSync(t.root, { recursive:true, force:true }); }
});
