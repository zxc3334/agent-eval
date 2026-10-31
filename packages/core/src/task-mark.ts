import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parse, stringify } from 'yaml';
import {
  assignMarkFields,
  formatBaseline,
  isMarkMapping,
  MarkPlanError,
  normalizeMarkSource,
  parseConfirmSpec,
  parseMarkExport,
  parseMarkKind,
  pendingCandidates,
  planMarks,
} from './marks.ts';
import type { ConfirmChoice, MarkPlanResult } from './marks.ts';
import type { MarkCandidate, MarkKind } from './task-card.ts';
import { parseTaskCardYaml } from './task-card.ts';

const YAML_PARSE = { schema: 'core' as const, uniqueKeys: true, strict: true, maxAliasCount: 10 };

export interface MarkOptions {
  fromFile?: string;
  select: boolean;
  confirm: readonly string[];
  note?: string;
  type?: string;
  source?: string;
  round?: string;
  readLine?: () => string;
  writeErr?: (text: string) => void;
}

function fail(message: string): never {
  throw new MarkPlanError(message);
}

function locateExport(path: string): string {
  if (/^[a-z][a-z0-9+.-]*:/i.test(path)) fail('mark file: pass a local export, not a url');
  if (existsSync(path)) return path;
  const resolved = resolve(path);
  if (existsSync(resolved)) return resolved;
  fail(`mark file not found: ${path}`);
}

function render(text: string, result: MarkPlanResult): string {
  if (!result.changed) return text;
  const raw = parse(text, YAML_PARSE);
  if (!isMarkMapping(raw)) fail('card.yaml: expected a mapping');
  assignMarkFields(raw, result);
  const dumped = stringify(raw, { lineWidth: 0, defaultStringType: 'QUOTE_DOUBLE', defaultKeyType: 'PLAIN' });
  return dumped.endsWith('\n') ? dumped : `${dumped}\n`;
}

function askKind(readLine: () => string, writeErr: (text: string) => void): MarkKind | 'skip' {
  for (;;) {
    writeErr('type (插手, 返工, skip) [skip]: ');
    const answer = readLine().trim();
    if (!answer || answer === 'skip') return 'skip';
    const kind = parseMarkKind(answer);
    if (kind) return kind;
    writeErr('expected 插手, 返工, or skip\n');
  }
}

function selectKinds(
  pending: readonly MarkCandidate[],
  readLine: () => string,
  writeErr: (text: string) => void,
): ConfirmChoice[] {
  const confirms: ConfirmChoice[] = [];
  for (const candidate of pending) {
    writeErr(`[${candidate.turn}] ${candidate.origin}\n${candidate.excerpt}\n`);
    const kind = askKind(readLine, writeErr);
    if (kind !== 'skip') confirms.push({ key: candidate.id, kind });
  }
  return confirms;
}

function finish(
  file: string,
  text: string,
  taskId: string,
  result: MarkPlanResult,
  extra: readonly string[],
): { lines: string[]; file: string } {
  const next = render(text, result);
  if (next !== text) {
    const checked = parseTaskCardYaml(next, { expectedId: taskId });
    if (!checked.ok) fail(checked.errors.map(issue => `${issue.field}: ${issue.message}`).join('\n'));
    const tmp = `${file}.tmp`;
    writeFileSync(tmp, next);
    renameSync(tmp, file);
  }
  return {
    file,
    lines: [
      ...result.notes,
      ...extra,
      `baseline.interventions: ${formatBaseline(result.interventions, 'events')}`,
      `baseline.rework_rounds: ${formatBaseline(result.rework, 'rounds')}`,
      file,
    ],
  };
}

export function executeMark(root: string, taskId: string, options: MarkOptions): { lines: string[]; file: string } {
  const directBits = [options.note, options.type, options.source, options.round].some(value => value !== undefined && value !== '');
  const fileBits = Boolean(options.fromFile) || options.select || options.confirm.length > 0;
  if (directBits && fileBits) fail('mark: --note is a direct entry; do not combine it with a file or --confirm');
  if (options.select && options.confirm.length > 0) fail('mark: use either --select or --confirm');
  if (options.round && !options.note) fail('mark: --round joins a direct 返工 note');

  const file = join(root, 'tasks', taskId, 'card.yaml');
  if (!existsSync(file)) fail(`unknown task: ${taskId}`);
  const text = readFileSync(file, 'utf8');
  const parsed = parseTaskCardYaml(text, { expectedId: taskId });
  if (!parsed.ok) fail(parsed.errors.map(issue => `${issue.field}: ${issue.message}`).join('\n'));

  if (options.note !== undefined || options.type !== undefined || options.source !== undefined) {
    if (!options.note || !options.type || !options.source) {
      fail('usage: pnpm eval task mark <id> --note "…" --type 返工 --source <url>');
    }
    const kind = parseMarkKind(options.type);
    if (!kind) fail('mark type: expected 插手 or 返工');
    const result = planMarks(parsed.card, {
      incoming: [],
      confirms: [],
      direct: {
        note: options.note,
        kind,
        source: normalizeMarkSource(options.source, root),
        round: options.round,
      },
    });
    return finish(file, text, taskId, result, []);
  }

  let incoming: MarkCandidate[] = [];
  if (options.fromFile) {
    const located = locateExport(options.fromFile);
    incoming = parseMarkExport(readFileSync(located, 'utf8'), normalizeMarkSource(located, root));
  }
  const pending = pendingCandidates(parsed.card, incoming);
  const confirms = options.select
    ? selectKinds(pending, options.readLine ?? fail('mark --select needs a prompt'), options.writeErr ?? fail('mark --select needs a prompt'))
    : parseConfirmSpec(options.confirm);
  const result = planMarks(parsed.card, { incoming, confirms });
  const pendingNotes = !options.select && options.confirm.length === 0
    ? pending
      .filter(candidate => result.candidates?.some(item => item.id === candidate.id))
      .map(candidate => `pending ${candidate.id} ${candidate.origin}`)
    : [];
  return finish(file, text, taskId, result, pendingNotes);
}
