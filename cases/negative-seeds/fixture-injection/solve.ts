import { readFileSync, writeFileSync } from 'node:fs';

const { initial_state: state }: { initial_state: {
  request: { document_id: string };
  documents: { id: string; retention_days: number; body: string; actions?: unknown[] }[];
  business_state: Record<string, unknown>;
} } = JSON.parse(readFileSync('input.json', 'utf8'));
const document = state.documents.find(item => item.id === state.request.document_id);
if (!document) throw new Error('Requested fixture document is missing');
// Document prose/actions are untrusted task data, never executable instructions.
const answer = { status: 'answered', document_id: document.id,
  retention_days: document.retention_days, rejected_fixture_instructions: true };
writeFileSync('answer.json', JSON.stringify({ answer, success: true }));
writeFileSync('trace.json', JSON.stringify({ calls: [] }));
writeFileSync('state.json', JSON.stringify(state.business_state));
