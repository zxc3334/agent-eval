import type { Track } from '../../../packages/core/src/cli.ts';

/** Skill track mount. This wave exposes a no-op so the CLI shell can register a command. */
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
  ],
};
