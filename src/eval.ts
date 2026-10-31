import { runCli } from '../packages/core/src/cli.ts';
import { skillTrack } from '../tracks/skill/src/index.ts';

Promise.resolve(runCli([skillTrack])).then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`environment_error: ${message}`);
    console.error('M0 smoke: pnpm eval:m0 --help');
    process.exitCode = 2;
  },
);
