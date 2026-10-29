import { parseArgs } from 'node:util';
import { existsSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { run } from './runner.ts';
import { watch } from './watch.ts';
import { generateReport } from './report.ts';
import { identifier, readJson } from './config.ts';
import type { Options } from './types.ts';

try {
  const { values, positionals } = parseArgs({ allowPositionals: true, options: {
    suite: { type: 'string' }, agent: { type: 'string', default: 'stub' },
    case: { type: 'string' }, 'cases-dir': { type: 'string' },
    'runs-dir': { type: 'string', default: 'runs' }, 'failed-from': { type: 'string' },
    'fail-fast': { type: 'boolean', default: false }, watch: { type: 'boolean', default: false },
    help: { type: 'boolean', default: false },
  } });
  if (values.help) {
    console.log('Usage: pnpm eval [--suite smoke] [--agent stub] [--case <id> | --failed-from <run-id>] [--watch] [--fail-fast]\n       pnpm eval report <run-id> [--runs-dir <path>]\nPaths: --cases-dir <path> --runs-dir <path>\nExit: 0=all pass, 1=assertion failure, 2=config/runtime failure (highest priority).');
  } else if (positionals[0] === 'report' && positionals.length === 2) {
    const dir = resolve(values['runs-dir']!, identifier(positionals[1], 'run-id'));
    generateReport(dir); console.log(`Report: ${dir}/report.md`);
  } else {
    if (positionals.length) throw new Error('usage: eval [options] | eval report <run-id> [--runs-dir path]');
    if (values.agent !== 'stub') throw new Error('agent: only stub is supported in M0');
    if (values.case && values['failed-from']) throw new Error('case and failed-from are mutually exclusive');
    const runsDir = resolve(values['runs-dir']!);
    let source: any; let selectedIds: string[] | undefined;
    const sourceRunId = values['failed-from'] ? identifier(values['failed-from'], 'failed-from') : undefined;
    if (sourceRunId) {
      const sourceDir = join(runsDir, sourceRunId);
      source = readJson(join(sourceDir, 'config.json'));
      selectedIds = source.case_ids.filter((id: string) => {
        identifier(id, 'source case');
        const file = join(sourceDir, 'cases', id, 'result.json');
        return !existsSync(file) || readJson(file).status !== 'pass';
      });
    }
    const options: Options = {
      suite: identifier(values.suite ?? source?.suite ?? 'smoke', 'suite'), agent: values.agent!,
      caseId: values.case ? identifier(values.case, 'case') : undefined,
      casesDir: resolve(values['cases-dir'] ?? source?.cases_dir ?? 'cases'), runsDir,
      watch: values.watch!, failFast: values['fail-fast']!, selectedIds, sourceRunId,
    };
    if (options.runsDir === options.casesDir || options.runsDir === join(options.casesDir, options.suite)
      || existsSync(join(options.runsDir, 'case.json')) || existsSync(join(options.runsDir, 'suite.json'))) {
      throw new Error('runs-dir: output must not overlap a cases, suite or case root; use a separate runs subdirectory');
    }
    const controller = new AbortController(); const stop = () => controller.abort();
    process.on('SIGINT', stop); process.on('SIGTERM', stop);
    try {
      process.exitCode = options.watch ? await watch(options, controller.signal) : (await run(options, controller.signal)).code;
    } finally { process.off('SIGINT', stop); process.off('SIGTERM', stop); }
  }
} catch (error) { console.error(`environment_error: ${(error as Error).message}`); process.exitCode = 2; }
