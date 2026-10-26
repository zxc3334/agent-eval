import { spawn } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export async function invokeStub(workspace: string, artifacts: string, temp: string, timeout: number, inject: string | undefined, signal: AbortSignal): Promise<{ code: number | null; timedOut: boolean; error?: string }> {
  return new Promise(resolve => {
    let timedOut = false; let error: string | undefined; let stopping = false;
    const child = spawn(process.execPath, [fileURLToPath(new URL('./stub.ts', import.meta.url)), inject ?? 'normal'], {
      cwd: workspace, detached: true, stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, AGENT_EVAL_TEMP: temp },
    });
    const killGroup = (name: NodeJS.Signals) => {
      if (child.pid) { try { process.kill(-child.pid, name); } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ESRCH') error = String(e); } }
    };
    let escalation: NodeJS.Timeout | undefined;
    const stop = () => {
      if (stopping) return; stopping = true;
      killGroup('SIGTERM'); escalation = setTimeout(() => killGroup('SIGKILL'), 100);
    };
    const timer = setTimeout(() => { timedOut = true; stop(); }, timeout);
    const abort = () => stop();
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) stop();
    child.stdout.on('data', data => appendFileSync(join(artifacts, 'stdout.log'), data));
    child.stderr.on('data', data => appendFileSync(join(artifacts, 'stderr.log'), data));
    child.on('error', e => { error = e.message; });
    // Clean the process group even after a normal parent exit.
    child.on('exit', stop);
    child.on('close', code => {
      clearTimeout(timer); signal.removeEventListener('abort', abort); stop();
      setTimeout(() => {
        clearTimeout(escalation); killGroup('SIGKILL');
        resolve({ code, timedOut, error });
      }, 120);
    });
  });
}
