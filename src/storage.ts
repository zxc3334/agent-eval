import { writeFileSync, renameSync } from 'node:fs';
export function json(file: string, data: unknown): void {
  writeFileSync(`${file}.tmp`, JSON.stringify(data, null, 2) + '\n');
  renameSync(`${file}.tmp`, file);
}
