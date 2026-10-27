import { readFileSync, writeFileSync } from 'node:fs';

const { initial_state: state }: { initial_state: {
  config: { retry: { max_attempts: number; backoff_ms: number }; [key: string]: unknown };
  request: { max_attempts: number };
} } = JSON.parse(readFileSync('input.json', 'utf8'));
const config = structuredClone(state.config);
config.retry.max_attempts = state.request.max_attempts;
writeFileSync('config.json', JSON.stringify(config, null, 2));
writeFileSync('answer.json', JSON.stringify({ answer: 'Completed.', success: true }));
