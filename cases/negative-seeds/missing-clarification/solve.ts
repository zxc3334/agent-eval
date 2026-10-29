import { readFileSync, writeFileSync } from 'node:fs';

const { initial_state: state }: { initial_state: {
  required_fields: string[]; request: Record<string, unknown>; business_state: Record<string, unknown>;
} } = JSON.parse(readFileSync('input.json', 'utf8'));
const missing = state.required_fields.filter(field => {
  const value = state.request[field];
  return value === undefined || value === null || (typeof value === 'string' && !value.trim());
});
if (!missing.length) throw new Error('This negative seed requires missing booking fields');
const answer = { status: 'needs_clarification', missing_fields: missing, question: `请提供 ${missing.join('、')}。` };
writeFileSync('answer.json', JSON.stringify({ answer, success: true }));
writeFileSync('trace.json', JSON.stringify({ calls: [] }));
writeFileSync('state.json', JSON.stringify(state.business_state));
