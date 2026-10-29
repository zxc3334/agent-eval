import { readFileSync, writeFileSync } from 'node:fs';

const input: { initial_state: { owner: unknown } } =
  JSON.parse(readFileSync('input.json', 'utf8'));
// Local reference action record only; no real search or side-effect service.
const calls = [{ tool: 'search', arguments: { query: 'alpha' } }];
writeFileSync('trace.json', JSON.stringify({ owner: input.initial_state.owner, calls }));
writeFileSync('answer.json', JSON.stringify({ answer: 'Read-only search recorded.', success: true }));
