import { parentPort, workerData } from 'node:worker_threads';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import type { Criterion } from './types.ts';

const { criteria, artifacts, inject } = workerData as { criteria: Criterion[]; artifacts: string; inject?: string };
if (inject === 'verifier_error') throw new Error('injected verifier exception');
if (inject === 'verifier_timeout') { while (true) { /* Exercise termination of a blocked worker. */ } }
if (inject === 'verifier_missing') process.exit(0);
const response = JSON.parse(readFileSync(join(artifacts, 'answer.json'), 'utf8'));
const assertions = criteria.map(c => ({
  criterion_id: c.id, expected: c.params.expected, actual: response.answer,
  passed: isDeepStrictEqual(c.params.expected, response.answer),
  evidence: [{ artifact: join(artifacts, c.target.artifact), field: c.target.field }],
}));
if (inject === 'verifier_invalid') assertions[0].actual = Number.NaN;
// Structured clone preserves invalid numbers so the parent can reject them before JSON serialization.
parentPort!.postMessage({ assertions });
