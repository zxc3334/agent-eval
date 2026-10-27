import { readFileSync, writeFileSync } from 'node:fs';

interface State { destination: string; date: string; travelers: number; preferences: { seat: string; language: string } }
const { initial_state: input }: { initial_state: {
  state: State; turns: { id: number; changes: Partial<State> }[];
} } = JSON.parse(readFileSync('input.json', 'utf8'));
const state = structuredClone(input.state);
const snapshots: { turn_id: number; state: State }[] = [];
for (const turn of input.turns) {
  Object.assign(state, turn.changes);
  snapshots.push({ turn_id: turn.id, state: structuredClone(state) });
}
writeFileSync('state.json', JSON.stringify(state));
writeFileSync('history.json', JSON.stringify({ snapshots }));
writeFileSync('answer.json', JSON.stringify({ answer: 'Completed.', success: true }));
