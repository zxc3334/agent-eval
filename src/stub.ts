// One-step adapter protocol: read public AgentInput, write { answer, success }.
// success only reports that the adapter produced an answer; it is never a grade.
import { readFileSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import type { AgentInput } from './types.ts';
const input: AgentInput = JSON.parse(readFileSync('input.json', 'utf8'));
const fixture = input.fixture;
console.log('stub: reading local input and fixture');
const mode = process.argv[2];
writeFileSync('resource.json', JSON.stringify({ path: process.env.AGENT_EVAL_TEMP }));
if (mode === 'timeout') {
  const child = spawn(process.execPath, ['-e', 'process.on("SIGTERM", () => {}); setInterval(() => {}, 1000)'], { stdio: 'ignore' });
  writeFileSync('descendant.json', JSON.stringify({ pid: child.pid }));
  writeFileSync(join(process.env.AGENT_EVAL_TEMP!, 'scratch.txt'), 'temporary execution resource');
  writeFileSync('partial.txt', 'started, no final answer yet');
  console.error('stub: waiting for cancellation');
  await new Promise(() => {});
}
if (mode === 'agent_error') { console.error('stub: injected agent crash'); process.exit(17); }
if (mode === 'protocol_error') { writeFileSync('answer.json', '{broken protocol'); process.exit(0); }
if (fixture.delay_ms) await new Promise(resolve => setTimeout(resolve, fixture.delay_ms));
for (const [name, content] of Object.entries(fixture.files ?? {})) writeFileSync(name, content);
writeFileSync('answer.json', JSON.stringify({ answer: fixture.answer, success: true }));
console.log('stub: answer written');
