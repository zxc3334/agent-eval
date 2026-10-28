import { lstatSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, resolve } from 'node:path';
import { json } from './storage.ts';

export const RESERVED_FILES = ['input.json', 'stdout.log', 'stderr.log', 'session.json', 'fixture.json', 'initial-state.json', 'clock.cjs', 'artifact-manifest.json', 'product-request.json', 'product-events.jsonl'];
export function outputName(name: unknown): name is string {
  return typeof name === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(name) && !RESERVED_FILES.includes(name);
}
export interface ArtifactManifest {
  schema_version: 1; session_id: string; agent_stopped: true;
  files: { path: string; bytes: number; sha256: string }[];
  missing: { path: string; error: string }[];
}

// Caller must await termination (including descendants) before entering this
// boundary. A fresh directory is published only after all paths are checked.
export function freezeArtifacts(workspace: string, destination: string, allowlist: string[], sessionId: string, stopped: boolean): ArtifactManifest {
  if (!stopped) throw new Error('artifact_handoff: agent has not stopped');
  if (!allowlist.every(outputName) || new Set(allowlist).size !== allowlist.length) throw new Error('artifact_handoff: invalid or duplicate allowlisted output path');
  try { lstatSync(destination); throw new Error('artifact_handoff: frozen destination already exists'); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  const root = realpathSync(workspace);
  const staging = `${destination}.staging`;
  mkdirSync(staging); // Never merge with a previous trial or partial handoff.
  const manifest: ArtifactManifest = { schema_version: 1, session_id: sessionId, agent_stopped: true, files: [], missing: [] };
  try {
    for (const name of [...allowlist].sort()) {
      const file = join(root, name);
      let info;
      try { info = lstatSync(file); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        manifest.missing.push({ path: name, error: `artifact_handoff: missing declared artifact ${name}` });
        continue;
      }
      // Stricter than allowing in-list links: all links are rejected, including
      // dangling links. No follow/resolve race and no directory traversal.
      if (info.isSymbolicLink() || !info.isFile() || info.nlink !== 1 || realpathSync(file) !== resolve(root, name)) {
        throw new Error(`artifact_handoff: ${name}: expected a regular, unlinked file; symlinks, hardlinks and directories are rejected`);
      }
      const bytes = readFileSync(file);
      writeFileSync(join(staging, name), bytes, { flag: 'wx', mode: 0o444 });
      manifest.files.push({ path: name, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') });
    }
    renameSync(staging, destination);
    // Manifest lives outside the agent/verifier input mount.
    json(join(destination, '..', 'artifact-manifest.json'), manifest);
    return manifest;
  } catch (error) {
    rmSync(staging, { recursive: true, force: true });
    throw error;
  }
}
