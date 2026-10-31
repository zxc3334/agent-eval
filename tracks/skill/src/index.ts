import type { Track } from '../../../packages/core/src/cli.ts';
import { taskCommand } from '../../../packages/core/src/task-cli.ts';
import { compareCommand } from './compare-cli.ts';
import { metricsCommand } from './metrics-cli.ts';
import { replayCommand } from './replay-cli.ts';
import { verifyCommand } from './verify-cli.ts';

/** Skill track mount. `noop` proves the shell; `task` records cards; `replay` runs them; `verify` scores them; `compare` reads the metrics. */
export const skillTrack: Track = {
  name: 'skill',
  summary: 'Skill and config workflow eval. The only track implemented this wave.',
  commands: [
    {
      name: 'noop',
      summary: 'No-op. Proves the skill track is mounted on the CLI shell.',
      run(args) {
        if (args.length > 0) {
          console.error('noop: no arguments');
          return 2;
        }
        console.log('skill noop: ok');
        return 0;
      },
    },
    taskCommand,
    replayCommand,
    verifyCommand,
    metricsCommand,
    compareCommand,
  ],
};
