import { parseArgs } from 'node:util';
import { identifier } from './config.ts';

export type CommandResult = number | Promise<number>;

export interface Command {
  name: string;
  summary: string;
  run(args: readonly string[]): CommandResult;
}

export interface Track {
  name: string;
  summary: string;
  commands: readonly Command[];
}

const PLACEHOLDER_TRACKS = [
  { name: 'agent', summary: 'Product-agent loop. Placeholder README only; not mounted.' },
  { name: 'model', summary: 'Model-capability tasks. Placeholder README only; not mounted.' },
] as const;

export function formatHelp(tracks: readonly Track[]): string {
  const mountedNames = new Set(tracks.map(track => track.name));
  const mounted = tracks.map(track => `  ${track.name} — ${track.summary}`).join('\n') || '  (none)';
  const commands = tracks.flatMap(track => track.commands.map(command => `  ${command.name} — ${command.summary}`)).join('\n') || '  (none)';
  const placeholders = PLACEHOLDER_TRACKS
    .filter(track => !mountedNames.has(track.name))
    .map(track => `  ${track.name} — ${track.summary}`)
    .join('\n') || '  (none)';
  return [
    'agent-eval',
    '',
    'Usage:',
    '  pnpm eval --help',
    '  pnpm eval <command>',
    '  pnpm eval task --help',
    '',
    'Mounted tracks:',
    mounted,
    '',
    'Commands:',
    commands,
    '',
    'Placeholder tracks (not mounted):',
    placeholders,
    '',
    'This wave implements the skill track only.',
    'tracks/agent and tracks/model must not import the skill track.',
    'M0 smoke remains available as: pnpm eval:m0 --help',
  ].join('\n');
}

function assertMountable(tracks: readonly Track[]): void {
  const trackNames = new Set<string>();
  const commandNames = new Set<string>();
  for (const track of tracks) {
    identifier(track.name, 'track');
    if (trackNames.has(track.name)) throw new Error(`track: duplicate ${track.name}`);
    trackNames.add(track.name);
    for (const command of track.commands) {
      identifier(command.name, 'command');
      if (commandNames.has(command.name)) throw new Error(`command: duplicate ${command.name}`);
      commandNames.add(command.name);
    }
  }
}

/** Flags before the command stay on the shell. The command receives everything after its name. */
function splitInvocation(argv: readonly string[]): { globalArgs: string[]; commandArgs: string[] } {
  const globalArgs: string[] = [];
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === '--') return { globalArgs, commandArgs: argv.slice(index + 1) };
    if (token.startsWith('-')) {
      globalArgs.push(token);
      continue;
    }
    return { globalArgs, commandArgs: argv.slice(index) };
  }
  return { globalArgs, commandArgs: [] };
}

export function runCli(tracks: readonly Track[], argv: readonly string[] = process.argv.slice(2)): CommandResult {
  try {
    assertMountable(tracks);
    const { globalArgs, commandArgs } = splitInvocation(argv);
    const { values } = parseArgs({
      args: globalArgs,
      allowPositionals: false,
      strict: true,
      options: {
        help: { type: 'boolean', short: 'h', default: false },
      },
    });
    if (values.help || commandArgs.length === 0) {
      console.log(formatHelp(tracks));
      return 0;
    }
    const command = tracks.flatMap(track => [...track.commands]).find(item => item.name === commandArgs[0]);
    if (!command) {
      console.error(`unknown command: ${commandArgs[0]}`);
      console.error('M0 smoke: pnpm eval:m0 --help');
      console.log(formatHelp(tracks));
      return 2;
    }
    return command.run(commandArgs.slice(1));
  } catch (error) {
    console.error(`environment_error: ${(error as Error).message}`);
    console.error('M0 smoke: pnpm eval:m0 --help');
    return 2;
  }
}
