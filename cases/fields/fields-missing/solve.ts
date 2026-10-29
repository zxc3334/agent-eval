import { readFileSync, writeFileSync } from 'node:fs';

const input: { initial_state: { config: Record<string, unknown> } } =
  JSON.parse(readFileSync('input.json', 'utf8'));
// Implement the requested edit directly; do not reconstruct unrelated fields.
const config = structuredClone(input.initial_state.config);
config.theme = 'dark';
writeFileSync('config.json', JSON.stringify(config, null, 2));
writeFileSync('answer.json', JSON.stringify({ answer: 'Applied theme change.', success: true }));
