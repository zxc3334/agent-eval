import { parseArgs } from 'node:util';
import { existsSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { run } from './runner.ts';
import { watch } from './watch.ts';
import { generateReport } from './report.ts';
import { identifier, readJson } from './config.ts';
import { createCase } from './scaffold.ts';
import { validateSchema } from './validation.ts';
import { validateSuite } from './calibration.ts';
import { generateCalibrationReport } from './calibration-report.ts';
import type { Options } from './types.ts';

try {
  const { values, positionals, tokens } = parseArgs({ allowPositionals: true, tokens: true, options: {
    suite: { type: 'string' }, agent: { type: 'string' },
    case: { type: 'string' }, 'cases-dir': { type: 'string' },
    experiment: { type: 'string' },
    requirement: { type: 'string' },
    'schema-only': { type: 'boolean', default: false },
    'runs-dir': { type: 'string', default: 'runs' }, 'failed-from': { type: 'string' },
    'fail-fast': { type: 'boolean', default: false }, watch: { type: 'boolean', default: false },
    help: { type: 'boolean', default: false },
  } });
  if (values.help) {
    console.log('Usage: pnpm eval [--suite smoke] [--agent stub|oracle|container|jackson-bot-pi] [--experiment <json>] [--case <id> | --failed-from <run-id>] [--watch] [--fail-fast]\n       pnpm eval report <run-id> [--runs-dir <path>]\n       pnpm eval case new <id> --requirement <id> [--suite smoke] [--cases-dir <path>]\n       pnpm eval validate --schema-only [--suite smoke] [--cases-dir <path>]\n       pnpm eval validate --suite <name> [--cases-dir <path>] [--runs-dir <path>]\nPaths: --cases-dir <path> --runs-dir <path>\nExit: 0=success/all pass, 1=assertion failure, 2=config/runtime failure (highest priority).');
  } else if (positionals[0] === 'validate') {
    if (positionals.length !== 1 || (!values['schema-only'] && !values.suite)) throw new Error('usage: eval validate --suite <name> [--schema-only] [--cases-dir <path>] [--runs-dir <path>]');
    const allowed = values['schema-only'] ? ['schema-only', 'suite', 'cases-dir'] : ['suite', 'cases-dir', 'runs-dir'];
    for (const token of tokens) {
      if (token.kind === 'option' && !allowed.includes(token.name)) throw new Error(`validate: unsupported option --${token.name}`);
    }
    const suite = values.suite ?? 'smoke';
    const casesDir = resolve(values['cases-dir'] ?? 'cases');
    if (values['schema-only']) {
      const result = validateSchema(casesDir, suite);
      for (const error of result.errors) console.error(`schema_error: ${error}`);
      console.log(`Schema-only ${suite}: checked ${result.checked} case(s), ${result.errors.length} error(s).`);
      process.exitCode = result.errors.length ? 2 : 0;
    } else {
      const controller = new AbortController(); const stop = () => controller.abort();
      process.on('SIGINT', stop); process.on('SIGTERM', stop);
      try { process.exitCode = (await validateSuite(casesDir, suite, resolve(values['runs-dir']!), controller.signal)).code; }
      finally { process.off('SIGINT', stop); process.off('SIGTERM', stop); }
    }
  } else if (values['schema-only']) {
    throw new Error('--schema-only is only supported by eval validate');
  } else if (positionals[0] === 'case') {
    if (positionals[1] !== 'new' || positionals.length !== 3 || !values.requirement) throw new Error('usage: eval case new <id> --requirement <id> [--suite smoke] [--cases-dir <path>]');
    for (const token of tokens) {
      if (token.kind === 'option' && !['requirement', 'suite', 'cases-dir'].includes(token.name)) throw new Error(`case new: unsupported option --${token.name}`);
    }
    const dir = createCase(values['cases-dir'] ?? 'cases', values.suite ?? 'smoke', positionals[2], values.requirement);
    console.log(`Created case: ${dir}\nBrief: ${join(dir, 'brief.md')}\nRegistered version 1.0.0 in suite ${values.suite ?? 'smoke'}.\nTODO: fill brief, public inputs, private acceptance, gold.md and solve.ts; reviewed=false. The placeholder intentionally fails (exit 1).`);
  } else if (values.requirement !== undefined) {
    throw new Error('--requirement is only supported by eval case new');
  } else if (positionals[0] === 'report' && positionals.length === 2) {
    const dir = resolve(values['runs-dir']!, identifier(positionals[1], 'run-id'));
    if (readJson(join(dir, 'config.json')).kind === 'calibration') generateCalibrationReport(dir);
    else generateReport(dir);
    console.log(`Report: ${dir}/report.md`);
  } else {
    if (positionals.length) throw new Error('usage: eval [options] | eval report <run-id> | eval case new <id> --requirement <id>');
    if (values.agent !== undefined && !['stub', 'oracle', 'container', 'jackson-bot-pi'].includes(values.agent)) throw new Error('agent: only stub, oracle, container and jackson-bot-pi are supported');
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
    const agent = values.agent ?? source?.agent ?? 'stub';
    const options: Options = {
      suite: identifier(values.suite ?? source?.suite ?? 'smoke', 'suite'), agent,
      caseId: values.case ? identifier(values.case, 'case') : undefined,
      casesDir: resolve(values['cases-dir'] ?? source?.cases_dir ?? 'cases'), runsDir,
      experimentFile: resolve(values.experiment ?? (source?.agent === agent ? source?.experiment_file : undefined) ?? `experiments/${agent}.json`),
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
