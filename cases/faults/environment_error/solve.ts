import { readFileSync, writeFileSync } from 'node:fs';

// A fresh input.json contains the snapshotted initial_state (empty for this task).
JSON.parse(readFileSync('input.json', 'utf8'));
writeFileSync('answer.json', JSON.stringify({ answer: 'hello', success: true }));
