import { runCli } from '../packages/core/src/cli.ts';
import { skillTrack } from '../tracks/skill/src/index.ts';

process.exitCode = runCli([skillTrack]);
