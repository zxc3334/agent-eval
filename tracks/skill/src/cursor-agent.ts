import { createHash } from 'node:crypto';
import { cpSync, copyFileSync, existsSync, mkdirSync, statSync } from 'node:fs';
import { basename, dirname, extname, join, resolve } from 'node:path';

/** Named adapter for this wave. There is no second adapter. */
export const CURSOR_AGENT_NAME = 'Cursor Agent';

/**
 * Hard-coded Cursor Agent CLI entry. `--agent-bin` may replace the executable
 * path in tests; it does not change these arguments or the event contract.
 */
export const CURSOR_AGENT_ENTRY = 'agent';

/**
 * Flags that are identical for with-skill and without. The prompt is a separate
 * final argument. `--force` is intentionally absent: this adapter does not
 * approve actions or answer questions for the human.
 */
export const CURSOR_AGENT_FIXED_ARGS = [
  '--print',
  '--output-format',
  'stream-json',
  '--trust',
  '--mode',
  'agent',
] as const;

const QUESTION_TOOLS = new Set(['AskQuestion', 'ask_question', 'AskUserQuestion']);

export interface StreamEvent {
  type: string;
  subtype?: string;
  raw: Record<string, unknown>;
}

export interface CountOrUnknown {
  intervention_request: number | 'unknown';
  actual_intervention: number | 'unknown';
  requests: { text: string }[];
  actuals: { text: string }[];
}

export interface TokenUsage {
  input_tokens: number | 'unknown';
  output_tokens: number | 'unknown';
}

export interface InstalledSkill {
  name: string;
  source: string;
  dest: string;
}

export function promptSha256(prompt: string): string {
  return createHash('sha256').update(prompt).digest('hex');
}

/** Argv after the executable. The prompt is last, behind `--`, and is not a flag. */
export function cursorAgentArgs(workspace: string, prompt: string): string[] {
  return [...CURSOR_AGENT_FIXED_ARGS, '--workspace', workspace, '--', prompt];
}

export function parseStreamLine(line: string): StreamEvent | undefined {
  const trimmed = line.trim();
  if (!trimmed) return undefined;
  let value: unknown;
  try {
    value = JSON.parse(trimmed);
  } catch {
    return undefined;
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  const raw = value as Record<string, unknown>;
  return {
    type: typeof raw.type === 'string' ? raw.type : 'unknown',
    subtype: typeof raw.subtype === 'string' ? raw.subtype : undefined,
    raw,
  };
}

function eventText(raw: Record<string, unknown>): string {
  if (typeof raw.text === 'string') return raw.text;
  if (typeof raw.result === 'string') return raw.result;
  const message = raw.message;
  if (typeof message === 'object' && message !== null) {
    const content = (message as Record<string, unknown>).content;
    if (typeof content === 'string') return content;
    if (Array.isArray(content)) {
      const parts = content.map(part => {
        if (typeof part === 'string') return part;
        if (typeof part === 'object' && part !== null && typeof (part as Record<string, unknown>).text === 'string') {
          return (part as Record<string, unknown>).text as string;
        }
        return '';
      });
      return parts.filter(Boolean).join('\n');
    }
  }
  return '';
}

function toolName(raw: Record<string, unknown>): string | undefined {
  const call = raw.tool_call ?? raw.tool;
  if (typeof call === 'string') return call;
  if (typeof call !== 'object' || call === null) return undefined;
  const obj = call as Record<string, unknown>;
  if (typeof obj.name === 'string') return obj.name;
  const keys = Object.keys(obj);
  if (keys.length === 1) return keys[0];
  return undefined;
}

function tokenField(usage: Record<string, unknown>, snake: string, camel: string): number | 'unknown' {
  const value = usage[snake] ?? usage[camel];
  return typeof value === 'number' && Number.isFinite(value) ? value : 'unknown';
}

/**
 * Cursor Agent stream-json contract this adapter records.
 *
 * - `interaction` / `request`, or a question tool (`AskQuestion`), is an
 *   intervention-request. The adapter does not write an answer.
 * - `interaction` / `response`, or a `user` event after the initial prompt
 *   echo, is an actual-intervention.
 * - Token counts come only from `result.usage`. A missing field is `unknown`,
 *   not 0. A measured 0 stays 0.
 * - If the process never started, or it was interrupted before any event,
 *   intervention counts are `unknown`.
 */
export function summarizeCursorStream(events: readonly StreamEvent[], observed: { spawned: boolean; aborted: boolean }): {
  interventions: CountOrUnknown;
  usage: TokenUsage;
} {
  const requests: { text: string }[] = [];
  const actuals: { text: string }[] = [];
  let userEvents = 0;
  let usage: TokenUsage = { input_tokens: 'unknown', output_tokens: 'unknown' };

  for (const event of events) {
    if (event.type === 'interaction' && event.subtype === 'request') {
      requests.push({ text: eventText(event.raw) });
    } else if (event.type === 'interaction' && event.subtype === 'response') {
      actuals.push({ text: eventText(event.raw) });
    } else if (event.type === 'user') {
      userEvents += 1;
      if (userEvents > 1) actuals.push({ text: eventText(event.raw) });
    } else if (event.type === 'tool_call' && QUESTION_TOOLS.has(toolName(event.raw) ?? '')) {
      requests.push({ text: eventText(event.raw) || (toolName(event.raw) ?? 'question') });
    }
    if (event.type === 'result') {
      const rawUsage = event.raw.usage;
      if (typeof rawUsage === 'object' && rawUsage !== null) {
        const obj = rawUsage as Record<string, unknown>;
        usage = {
          input_tokens: tokenField(obj, 'input_tokens', 'inputTokens'),
          output_tokens: tokenField(obj, 'output_tokens', 'outputTokens'),
        };
      }
    }
  }

  const unseen = !observed.spawned || (observed.aborted && events.length === 0);
  return {
    interventions: {
      intervention_request: unseen ? 'unknown' : requests.length,
      actual_intervention: observed.spawned ? actuals.length : 'unknown',
      requests,
      actuals,
    },
    usage,
  };
}

function sanitizeSkillName(name: string): string {
  const cleaned = name.replace(/[^a-zA-Z0-9_-]/g, '-').replace(/^-+/, '').replace(/-+$/, '');
  if (!cleaned || !/^[a-zA-Z0-9]/.test(cleaned)) return 'skill';
  return cleaned;
}

export function skillDirectoryName(skillPath: string): string {
  const resolved = resolve(skillPath);
  if (statSync(resolved).isDirectory()) return sanitizeSkillName(basename(resolved));
  if (basename(resolved).toLowerCase() === 'skill.md') return sanitizeSkillName(basename(dirname(resolved)));
  return sanitizeSkillName(basename(resolved, extname(resolved)));
}

/** Copy a skill into the variant workspace. without does not call this. */
export function installSkill(skillPath: string, workspace: string): InstalledSkill {
  const source = resolve(skillPath);
  if (!existsSync(source)) throw new Error(`skill path does not exist: ${source}`);
  const name = skillDirectoryName(source);
  const dest = join(workspace, '.cursor', 'skills', name);
  mkdirSync(join(workspace, '.cursor', 'skills'), { recursive: true });
  if (statSync(source).isDirectory()) cpSync(source, dest, { recursive: true });
  else {
    mkdirSync(dest, { recursive: true });
    copyFileSync(source, join(dest, basename(source)));
  }
  return { name, source, dest };
}
