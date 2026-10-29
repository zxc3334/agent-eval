import { parentPort, workerData } from 'node:worker_threads';
import { evaluateFiles } from './file-verifier.ts';
import type { Criterion } from './types.ts';

const { criteria, artifacts, inject } = workerData as { criteria: Criterion[]; artifacts: string; inject?: string };
if (inject === 'verifier_error') throw new Error('injected verifier exception');
if (inject === 'verifier_timeout') { while (true) { /* Exercise termination of a blocked worker. */ } }
if (inject === 'verifier_missing') process.exit(0);
const assertions = evaluateFiles(criteria, artifacts);
if (inject === 'verifier_invalid') assertions[0].actual = Number.NaN;
// Structured clone preserves invalid numbers so the parent can reject them before JSON serialization.
parentPort!.postMessage({ assertions });
