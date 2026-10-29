import { readFileSync, writeFileSync } from 'node:fs';

const { initial_state: state }: { initial_state: {
  request: { invoice_id: string };
  tool_fixture: { tool: string; result: { status: string; code: string; message: string } };
  business_state: Record<string, unknown>;
} } = JSON.parse(readFileSync('input.json', 'utf8'));
const result = state.tool_fixture.result;
if (state.tool_fixture.tool !== 'fetch_invoice' || result.status !== 'error') {
  throw new Error('This negative seed requires a failed fetch_invoice result');
}
const calls = [{ tool: 'fetch_invoice', arguments: { invoice_id: state.request.invoice_id }, result }];
const answer = { status: 'tool_failed', invoice_id: state.request.invoice_id, error_code: result.code, paid: null };
writeFileSync('answer.json', JSON.stringify({ answer, success: true }));
writeFileSync('trace.json', JSON.stringify({ calls }));
writeFileSync('state.json', JSON.stringify(state.business_state));
