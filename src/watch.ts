import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { run } from './runner.ts';
import type { Options } from './types.ts';

// Content polling handles atomic saves, deleted/recreated files and malformed JSON.
// M0 suites are small; a 100ms poll + 150ms quiet period keeps feedback predictable.
function fingerprint(options: Options): string {
  const hash = createHash('sha256');
  const visit = (path: string) => {
    if (resolve(path) === options.runsDir) return;
    hash.update(path);
    try {
      const entries = readdirSync(path, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
      for (const entry of entries) {
        if (entry.isDirectory()) visit(join(path, entry.name));
        else if (entry.isFile()) { hash.update(entry.name); hash.update(readFileSync(join(path, entry.name))); }
      }
    } catch (e) { hash.update(String(e)); }
  };
  const suiteDir = join(options.casesDir, options.suite);
  try { hash.update(readFileSync(join(suiteDir, 'suite.json'))); } catch (e) { hash.update(String(e)); }
  const selected = options.selectedIds ?? (options.caseId ? [options.caseId] : undefined);
  if (selected) selected.forEach(id => visit(join(suiteDir, id)));
  else visit(suiteDir);
  return hash.digest('hex');
}

export async function watch(options: Options, signal: AbortSignal): Promise<number> {
  return new Promise(resolve => {
    let previous = fingerprint(options); let changedAt = 0; let dirty = false;
    let busy = false; let queuedMessage = false; let code = 0; let sourceRunId = options.sourceRunId;
    const finish = () => {
      clearInterval(timer); signal.removeEventListener('abort', stop); resolve(code);
    };
    const execute = async () => {
      busy = true; dirty = false; queuedMessage = false;
      try {
        const result = await run({ ...options, sourceRunId }, signal);
        code = result.code; sourceRunId = result.runId;
      } catch (e) { code = 2; console.error(`environment_error: ${(e as Error).message}\nWatch stays active; fix the file to retry.`); }
      finally { busy = false; if (signal.aborted) finish(); }
    };
    const timer = setInterval(() => {
      if (signal.aborted) return;
      const current = fingerprint(options);
      if (current !== previous) { previous = current; changedAt = Date.now(); dirty = true; }
      if (!dirty || Date.now() - changedAt < 150) return;
      if (busy) {
        if (!queuedMessage) { console.log('Watch: change queued; waiting for active run.'); queuedMessage = true; }
      } else { console.log('Watch: restarting with current files.'); void execute(); }
    }, 100);
    const stop = () => { clearInterval(timer); if (!busy) finish(); };
    signal.addEventListener('abort', stop, { once: true });
    console.log('Watch: serial runs; Ctrl-C to stop.');
    if (signal.aborted) finish(); else void execute();
  });
}
