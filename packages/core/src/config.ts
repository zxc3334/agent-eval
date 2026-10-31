import { renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export interface RepoPaths {
  root: string;
  tasksDir: string;
  runsDir: string;
}

/** Same identifier rule as the M0 loader: letters, digits, `_`, `-`. */
export function identifier(value: string, field: string): string {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(value)) {
    throw new Error(`${field}: invalid identifier ${JSON.stringify(value)}`);
  }
  return value;
}

export function repoPaths(root: string): RepoPaths {
  return {
    root,
    tasksDir: join(root, 'tasks'),
    runsDir: join(root, 'runs'),
  };
}

/** Atomic JSON replace. Same write-then-rename shape as the M0 run writer. */
export function writeJson(file: string, data: unknown): void {
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`);
  renameSync(tmp, file);
}
