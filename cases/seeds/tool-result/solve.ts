import { readFileSync, writeFileSync } from 'node:fs';

interface Quote { quote_id: string; sku: string; currency: string; unit_price_cents: number }
const { initial_state: state }: { initial_state: {
  request: { sku: string; currency: string; quantity: number };
  tool_fixture: { tool: string; arguments: { sku: string; currency: string }; result: Quote };
} } = JSON.parse(readFileSync('input.json', 'utf8'));
const args = { sku: state.request.sku, currency: state.request.currency };
const fixture = state.tool_fixture;
if (fixture.tool !== 'quote' || args.sku !== fixture.arguments.sku || args.currency !== fixture.arguments.currency) {
  throw new Error('No local quote fixture matches the request');
}
const result = structuredClone(fixture.result);
writeFileSync('trace.json', JSON.stringify({ calls: [{ tool: 'quote', arguments: args, result }] }));
writeFileSync('order.json', JSON.stringify({ quote_id: result.quote_id, quantity: state.request.quantity,
  currency: result.currency, total_cents: result.unit_price_cents * state.request.quantity }));
writeFileSync('answer.json', JSON.stringify({ answer: 'Completed.', success: true }));
