import { existsSync, readFileSync, writeFileSync, mkdirSync, cpSync } from 'node:fs';
import { resolve, join, basename } from 'node:path';
import { run } from './runner.ts';
import { readJson } from './config.ts';
import type { LoadedSkill, SkillMatrixConfig, SkillMatrixReport, SkillMatrixComparison, Options, Status } from './types.ts';

export function loadSkill(skillPath: string): LoadedSkill {
  const target = resolve(skillPath);
  if (!existsSync(target)) throw new Error(`skill path does not exist: ${target}`);

  const skillFile = existsSync(join(target, 'SKILL.md')) ? join(target, 'SKILL.md') : target;
  if (!existsSync(skillFile) || !skillFile.endsWith('.md')) {
    throw new Error(`expected SKILL.md file or directory containing SKILL.md at ${target}`);
  }

  const raw = readFileSync(skillFile, 'utf8');
  let name = basename(target, '.md');
  let description = '';
  let version = '1.0.0';
  let body = raw;

  if (raw.startsWith('---')) {
    const end = raw.indexOf('---', 3);
    if (end !== -1) {
      const frontmatter = raw.slice(3, end);
      body = raw.slice(end + 3).trim();
      for (const line of frontmatter.split('\n')) {
        const colon = line.indexOf(':');
        if (colon !== -1) {
          const key = line.slice(0, colon).trim();
          const val = line.slice(colon + 1).trim();
          if (key === 'name') name = val;
          if (key === 'description') description = val;
          if (key === 'version') version = val;
        }
      }
    }
  }

  return { name, description, body, path: target, version };
}

export function injectSkill(skill: LoadedSkill, workspace: string, mode: 'metadata' | 'full' = 'full'): void {
  const skillDir = join(workspace, '.agents', 'skills', skill.name);
  mkdirSync(skillDir, { recursive: true });

  const content = mode === 'metadata'
    ? `---\nname: ${skill.name}\ndescription: ${skill.description}\nversion: ${skill.version}\n---\n`
    : `---\nname: ${skill.name}\ndescription: ${skill.description}\nversion: ${skill.version}\n---\n\n${skill.body}`;

  writeFileSync(join(skillDir, 'SKILL.md'), content);

  // If skill source is a directory with additional resources, copy them
  if (existsSync(skill.path) && existsSync(join(skill.path, 'SKILL.md')) && mode === 'full') {
    for (const sub of ['scripts', 'references', 'resources']) {
      const subPath = join(skill.path, sub);
      if (existsSync(subPath)) {
        cpSync(subPath, join(skillDir, sub), { recursive: true });
      }
    }
  }
}

export async function runSkillMatrix(matrix: SkillMatrixConfig, baseRunsDir: string): Promise<SkillMatrixReport> {
  const casesDir = resolve(matrix.cases_dir ?? 'cases');
  const runsDir = resolve(matrix.runs_dir ?? baseRunsDir);
  const agent = matrix.agent ?? (matrix as any).adapter ?? 'stub';
  const sut = matrix.sut ?? (matrix.candidate_skill_dir ? { name: matrix.skill ?? 'candidate-skill', path: matrix.candidate_skill_dir } : undefined);
  if (!sut) throw new Error('SkillMatrixConfig requires sut: { name, path } or candidate_skill_dir');
  const baseline = matrix.baseline !== undefined ? matrix.baseline : (matrix.baseline_skill_dir ? { name: `${sut.name}-baseline`, path: matrix.baseline_skill_dir } : null);

  const experimentFile = existsSync(resolve(`experiments/${agent}.json`))
    ? resolve(`experiments/${agent}.json`)
    : resolve('experiments/stub.json');

  // 1. Run baseline (without candidate skill or using baseline skill)
  const baselineOptions: Options = {
    suite: matrix.suite,
    agent,
    casesDir,
    runsDir,
    experimentFile,
    watch: false,
    failFast: false,
    skill: baseline?.path,
  };
  const baselineRun = await run(baselineOptions);
  const baselineRunDir = join(runsDir, baselineRun.runId);

  // 2. Run candidate with SUT skill
  const candidateOptions: Options = {
    suite: matrix.suite,
    agent,
    casesDir,
    runsDir,
    experimentFile,
    watch: false,
    failFast: false,
    skill: sut.path,
  };
  const candidateRun = await run(candidateOptions);
  const candidateRunDir = join(runsDir, candidateRun.runId);

  const baselineConfig = readJson(join(baselineRunDir, 'config.json'));
  const candidateConfig = readJson(join(candidateRunDir, 'config.json'));
  const allCaseIds: string[] = [...new Set([...baselineConfig.case_ids, ...candidateConfig.case_ids])];

  const comparisons: SkillMatrixComparison[] = [];
  let improved = 0;
  let regressed = 0;
  let unchanged = 0;

  for (const caseId of allCaseIds) {
    const baseFile = join(baselineRunDir, 'cases', caseId, 'result.json');
    const candFile = join(candidateRunDir, 'cases', caseId, 'result.json');

    const baseStatus: Status | 'unattempted' = existsSync(baseFile) ? readJson(baseFile).status : 'unattempted';
    const candStatus: Status = existsSync(candFile) ? readJson(candFile).status : 'environment_error';

    let classification: SkillMatrixComparison['classification'] = 'flat';
    if (baseStatus !== 'pass' && candStatus === 'pass') {
      classification = 'improve';
      improved++;
    } else if (baseStatus === 'pass' && candStatus !== 'pass') {
      classification = 'regress';
      regressed++;
    } else if (candStatus === 'agent_error' || candStatus === 'verifier_error' || candStatus === 'environment_error') {
      classification = 'error';
      unchanged++;
    } else {
      classification = 'flat';
      unchanged++;
    }

    comparisons.push({
      case_id: caseId,
      baseline_status: baseStatus,
      candidate_status: candStatus,
      classification,
    });
  }

  const winRate = allCaseIds.length > 0 ? (improved + comparisons.filter(c => c.candidate_status === 'pass').length) / (allCaseIds.length * 2) : 0;

  return {
    skill: sut.name,
    suite: matrix.suite,
    total_cases: allCaseIds.length,
    improved,
    regressed,
    unchanged,
    win_rate: Number(winRate.toFixed(2)),
    cases: comparisons,
  };
}
