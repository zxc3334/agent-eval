import { parseArgs } from 'node:util';
import { existsSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { run } from './runner.ts';
import { watch } from './watch.ts';
import { generateReport } from './report.ts';
import { identifier, readJson } from './config.ts';
import { createCase, feedbackSource } from './scaffold.ts';
import { validateSchema } from './validation.ts';
import { validateSuite } from './calibration.ts';
import { generateCalibrationReport } from './calibration-report.ts';
import { writeManifest } from './manifest.ts';
import { setBaseline } from './baseline.ts';
import type { Options } from './types.ts';

try {
  const { values, positionals, tokens } = parseArgs({ allowPositionals: true, tokens: true, options: {
    suite: { type: 'string' }, agent: { type: 'string' },
    case: { type: 'string' }, 'cases-dir': { type: 'string' },
    experiment: { type: 'string' }, 'experiment-record': { type: 'string' }, vary: { type: 'string', multiple: true },
    requirement: { type: 'string' }, 'from-run': { type: 'string' }, 'from-trace': { type: 'string' }, trace: { type: 'string' },
    skill: { type: 'string' },
    'schema-only': { type: 'boolean', default: false },
    'runs-dir': { type: 'string', default: 'runs' }, 'failed-from': { type: 'string' },
    rerun: { type: 'string' }, repeat: { type: 'string' },
    'fail-fast': { type: 'boolean', default: false }, watch: { type: 'boolean', default: false },
    help: { type: 'boolean', default: false },
  } });
  if (values.help) {
    console.log('Usage: pnpm eval [--suite smoke] [--agent stub|oracle|container|jackson-bot-pi] [--experiment <json>] [--case <id> | --failed-from <run-id> | --rerun <run-id>] [--repeat N] [--watch] [--fail-fast]\n       pnpm eval report <run-id> [--runs-dir <path>]\n       pnpm eval baseline set <run-id> [--runs-dir <path>]\n       pnpm eval compare <baseline-run> <candidate-run> [--vary model|prompt|product_revision] [--experiment-record <path>] [--runs-dir <path>]\n       pnpm eval case new <id> --requirement <id> [--suite smoke] [--cases-dir <path>]\n       pnpm eval case new <id> --from-run <run-id> --case <source-id> [--suite smoke] [--cases-dir <path>] [--runs-dir <path>]\n       pnpm eval validate --schema-only [--suite smoke] [--cases-dir <path>]\n       pnpm eval validate --suite <name> [--cases-dir <path>] [--runs-dir <path>]\nPaths: --cases-dir <path> --runs-dir <path>\nExit: 0=success/all pass, 1=assertion failure, 2=config/runtime failure (highest priority).');
  } else if (positionals[0] === 'skill-matrix') {
    if (positionals.length !== 2) throw new Error('usage: eval skill-matrix <config-json> [--runs-dir <path>]');
    const { runSkillMatrix } = await import('./skill.ts');
    const cfg = readJson(resolve(positionals[1]));
    const report = await runSkillMatrix(cfg, resolve(values['runs-dir'] ?? 'runs'));
    console.log(`Skill Matrix: ${report.skill} on suite ${report.suite}`);
    console.log(`Cases: ${report.total_cases}; Improved: ${report.improved}, Regressed: ${report.regressed}, Unchanged: ${report.unchanged}`);
    console.log(`Win rate: ${(report.win_rate * 100).toFixed(0)}%`);
    for (const c of report.cases) console.log(`  ${c.case_id}: ${c.classification} (base: ${c.baseline_status} -> cand: ${c.candidate_status})`);
  } else if (positionals[0] === 'baseline') {
    if (positionals.length !== 3 || positionals[1] !== 'set') throw new Error('usage: eval baseline set <run-id> [--runs-dir <path>]');
    for (const token of tokens) {
      if (token.kind === 'option' && token.name !== 'runs-dir') throw new Error(`baseline set: unsupported option --${token.name}`);
    }
    const file = setBaseline(resolve(values['runs-dir']!), positionals[2]);
    console.log(`Baseline: ${positionals[2]}\nSelection history: ${file}`);
  } else if (positionals[0] === 'compare') {
    if (positionals.length !== 3) throw new Error('usage: eval compare <baseline-run> <candidate-run> [--vary model|prompt|product_revision] [--runs-dir <path>]');
    for (const token of tokens) {
      if (token.kind === 'option' && !['runs-dir', 'vary', 'experiment-record'].includes(token.name)) throw new Error(`compare: unsupported option --${token.name}`);
    }
    const { compareRuns } = await import('./compare.ts');
    const comparison = compareRuns(resolve(values['runs-dir']!), positionals[1], positionals[2], values.vary ?? [], values['experiment-record']);
    console.log(`Comparison: ${comparison.compatible ? 'compatible' : 'incompatible'}`);
    for (const reason of comparison.reasons) console.log(`  ${reason}`);
    for (const difference of comparison.differences) console.log(`  ${difference.path} [${difference.derived ? 'derived' : difference.declared ? 'declared variable' : 'undeclared'}]: ${JSON.stringify(difference.baseline)} -> ${JSON.stringify(difference.candidate)}`);
    for (const fault of comparison.run_faults) console.log(`  Run fault: ${fault}`);
    console.log(`Counts: ${Object.entries(comparison.counts).map(([name, count]) => `${name}=${count}`).join(' ')}`);
    for (const item of comparison.cases) console.log(`  ${item.case_id}: ${item.classification}`);
    if (comparison.conclusion) console.log(`Conclusion: ${comparison.conclusion}`);
    console.log(`JSON: ${join(comparison.output_dir, 'compare.json')}\nMarkdown: ${join(comparison.output_dir, 'compare.md')}`);
    if (!comparison.compatible) process.exitCode = 2;
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
  } else if (values['experiment-record'] !== undefined) {
    throw new Error('--experiment-record is only supported by eval compare');
  } else if (values.vary !== undefined) {
    throw new Error('--vary is only supported by eval compare');
  } else if (values['schema-only']) {
    throw new Error('--schema-only is only supported by eval validate');
  } else if (positionals[0] === 'case') {
    if (positionals[1] === 'from-trace') {
      if (positionals.length !== 3 || !values.requirement || (!values.trace && !values['from-trace'])) {
        throw new Error('usage: eval case from-trace <id> --trace <path> --requirement <id> [--suite smoke] [--cases-dir <path>]');
      }
      for (const token of tokens) {
        if (token.kind === 'option' && !['trace', 'from-trace', 'requirement', 'suite', 'cases-dir'].includes(token.name)) throw new Error(`case from-trace: unsupported option --${token.name}`);
      }
      const { scaffoldFromTrace } = await import('./trace.ts');
      const dir = scaffoldFromTrace({
        traceFile: resolve((values.trace ?? values['from-trace'])!),
        casesDir: resolve(values['cases-dir'] ?? 'cases'),
        suite: values.suite ?? 'smoke',
        id: positionals[2],
        requirementId: values.requirement!,
      });
      console.log(`Created case from trace: ${dir}\nBrief: ${join(dir, 'brief.md')}\nRegistered version 1.0.0 in suite ${values.suite ?? 'smoke'}.`);
    } else if (positionals[1] !== 'new' || positionals.length !== 3 || (values['from-run'] ? !values.case || values.requirement !== undefined : !values.requirement || values.case !== undefined)) throw new Error('usage: eval case new <id> --requirement <id> | --from-run <run-id> --case <source-id> [--suite smoke] [--cases-dir <path>] [--runs-dir <path>]');
    else {
      for (const token of tokens) {
        if (token.kind === 'option' && !['requirement', 'suite', 'cases-dir', ...(values['from-run'] ? ['from-run', 'case', 'runs-dir'] : [])].includes(token.name)) throw new Error(`case new: unsupported option --${token.name}`);
      }
      const feedback = values['from-run'] ? feedbackSource(values['runs-dir']!, values['from-run'], values.case!) : undefined;
      const dir = createCase(values['cases-dir'] ?? 'cases', values.suite ?? 'smoke', positionals[2], feedback?.requirementId ?? values.requirement!, feedback?.source);
      console.log(`Created case: ${dir}\nBrief: ${join(dir, 'brief.md')}\nRegistered version 1.0.0 in suite ${values.suite ?? 'smoke'}.\nTODO: fill brief, public inputs, private acceptance, gold.md and solve.ts; reviewed=false. The placeholder intentionally fails (exit 1).`);
    }
  } else if (values.requirement !== undefined) {
    throw new Error('--requirement is only supported by eval case new');
  } else if (values['from-run'] !== undefined) {
    throw new Error('--from-run is only supported by eval case new');
  } else if (positionals[0] === 'report' && positionals.length === 2) {
    const dir = resolve(values['runs-dir']!, identifier(positionals[1], 'run-id'));
    if (existsSync(join(dir, 'compare.json'))) {
      const { regenerateComparison } = await import('./compare.ts'); regenerateComparison(dir);
    } else if (readJson(join(dir, 'config.json')).kind === 'calibration') generateCalibrationReport(dir);
    else {
      generateReport(dir);
      if (existsSync(join(dir, 'manifest.json'))) writeManifest(dir, readJson(join(dir, 'manifest.json')));
    }
    console.log(`Report: ${dir}/${existsSync(join(dir, 'compare.json')) ? 'compare.md' : 'report.md'}`);
  } else {
    if (positionals.length) throw new Error('usage: eval [options] | eval report <run-id> | eval case new <id> --requirement <id>');
    if (values.agent !== undefined && !['stub', 'oracle', 'container', 'jackson-bot-pi', 'replay'].includes(values.agent)) throw new Error('agent: only stub, oracle, container, jackson-bot-pi and replay are supported');
    if ([values.case, values['failed-from'], values.rerun].filter(Boolean).length > 1) throw new Error('case, failed-from and rerun are mutually exclusive');
    if (values.repeat !== undefined && (!/^[1-9]\d*$/.test(values.repeat) || !Number.isSafeInteger(Number(values.repeat)))) throw new Error('repeat: expected positive safe integer');
    const runsDir = resolve(values['runs-dir']!);
    let source: any; let selectedIds: string[] | undefined;
    const sourceRunId = values['failed-from'] || values.rerun ? identifier((values['failed-from'] ?? values.rerun)!, 'source run') : undefined;
    if (sourceRunId) {
      const sourceDir = join(runsDir, sourceRunId);
      source = readJson(join(sourceDir, 'config.json'));
      if (values['failed-from'] && !existsSync(join(sourceDir, 'manifest.json'))) console.log('Source run has no manifest; reproducibility comparison is unavailable.');
      selectedIds = values.rerun ? source.case_ids : source.case_ids.filter((id: string) => {
        identifier(id, 'source case');
        const files = (source.repeat ?? 1) > 1 ? Array.from({ length: source.repeat }, (_, i) => join(sourceDir, 'cases', id, 'trials', String(i + 1), 'result.json')) : [join(sourceDir, 'cases', id, 'result.json')];
        return files.some(file => !existsSync(file) || readJson(file).status !== 'pass');
      });
    }
    const agent = values.agent ?? source?.agent ?? 'stub';
    const options: Options = {
      suite: identifier(values.suite ?? source?.suite ?? 'smoke', 'suite'), agent,
      caseId: values.case ? identifier(values.case, 'case') : undefined,
      casesDir: resolve(values['cases-dir'] ?? source?.cases_dir ?? 'cases'), runsDir,
      experimentFile: resolve(values.experiment ?? (source?.agent === agent ? source?.experiment_file : undefined) ?? `experiments/${agent}.json`),
      watch: values.watch!, failFast: values['fail-fast'] || (values.rerun ? source?.fail_fast ?? false : false), selectedIds, sourceRunId,
      repeat: values.repeat === undefined ? (values.rerun ? source?.repeat ?? 1 : 1) : Number(values.repeat),
      rerunSource: sourceRunId && (values.rerun || existsSync(join(runsDir, sourceRunId, 'manifest.json'))) ? sourceRunId : undefined,
      traceFile: values.trace ? resolve(values.trace) : undefined,
      skill: values.skill ? resolve(values.skill) : undefined,
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
