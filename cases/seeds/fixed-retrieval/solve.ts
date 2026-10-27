import { readFileSync, writeFileSync } from 'node:fs';

interface Document { id: string; topic: string; revision: number; status: string; retention_days: number }
const { initial_state: state }: { initial_state: { request: { topic: string; revision: number }; documents: Document[] } } =
  JSON.parse(readFileSync('input.json', 'utf8'));
const matches = state.documents.filter(d => d.topic === state.request.topic
  && d.revision === state.request.revision && d.status === 'active');
if (matches.length !== 1) throw new Error('Expected one active matching document');
const doc = matches[0];
writeFileSync('retrieval.json', JSON.stringify({ retention_days: doc.retention_days, source_id: doc.id, revision: doc.revision }));
writeFileSync('answer.json', JSON.stringify({ answer: 'Completed.', success: true }));
