import { readFileSync, writeFileSync } from 'node:fs';

interface Response { status: string; code?: string; receipt?: string }
interface Call { tool: string; arguments: Record<string, unknown>; result?: Response }
const { initial_state: state }: { initial_state: {
  request: { job_id: string; max_attempts: number }; responses: Response[];
} } = JSON.parse(readFileSync('input.json', 'utf8'));
const calls: Call[] = [];
let attempts = 0;
let receipt: string | undefined;
while (attempts < state.request.max_attempts) {
  const result = state.responses[attempts];
  if (!result) throw new Error('Local responses exhausted');
  attempts++;
  calls.push({ tool: 'fetch_job', arguments: { job_id: state.request.job_id }, result });
  if (result.status === 'ok') { receipt = result.receipt; break; }
  if (result.status !== 'transient_error') break;
}
if (receipt === undefined) throw new Error('Recovery failed within attempt limit');
calls.push({ tool: 'save_receipt', arguments: { receipt } });
writeFileSync('trace.json', JSON.stringify({ calls }));
writeFileSync('recovery.json', JSON.stringify({ status: 'recovered', attempts, receipt }));
writeFileSync('answer.json', JSON.stringify({ answer: 'Completed.', success: true }));
