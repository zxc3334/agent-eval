import { cpSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { identifier, loadCase, readJson, suiteCases } from './config.ts';
import { json } from './storage.ts';
import type { Acceptance, CaseConfig } from './types.ts';

export interface FeedbackSource { run_id: string; case_id: string; result_file: string }

export function feedbackSource(runsDir: string, runId: string, caseId: string): { source: FeedbackSource; requirementId: string } {
  identifier(runId, 'run-id'); identifier(caseId, 'source case');
  const runDir = resolve(runsDir, runId);
  const config = readJson(join(runDir, 'config.json'));
  if (config.run_id !== runId || !Array.isArray(config.case_ids) || !config.case_ids.includes(caseId)) throw new Error('source run: case is not in this run');
  if (!existsSync(join(runDir, 'manifest.json'))) throw new Error('source run: expected completed run with manifest');
  const snapshot = Array.isArray(config.cases) ? config.cases.find((c: any) => c?.config?.id === caseId) : undefined;
  const requirementId = identifier(snapshot?.config?.requirement_id, 'source requirement');
  const repeat = config.repeat ?? 1;
  if (!Number.isSafeInteger(repeat) || repeat < 1) throw new Error('source run: invalid repeat');
  for (let trial = 1; trial <= repeat; trial++) {
    const file = repeat === 1 ? join(runDir, 'cases', caseId, 'result.json') : join(runDir, 'cases', caseId, 'trials', String(trial), 'result.json');
    if (!existsSync(file)) continue;
    const result = readJson(file);
    if (result.case_id === caseId && result.status === 'fail') return { source: { run_id: runId, case_id: caseId, result_file: file }, requirementId };
  }
  throw new Error('source case: no failed result in the run');
}

export function createCase(casesDir: string, suite: string, id: string, requirementId: string, source?: FeedbackSource): string {
  identifier(suite, 'suite'); identifier(id, 'case'); identifier(requirementId, 'requirement');
  const suiteDir = resolve(casesDir, suite);
  const dir = join(suiteDir, id);
  const suiteFile = join(suiteDir, 'suite.json');
  mkdirSync(suiteDir, { recursive: true });
  // Serialize scaffold writers so concurrent invocations cannot lose suite entries.
  const lock = join(suiteDir, '.case-new.lock');
  try { writeFileSync(lock, '', { flag: 'wx' }); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new Error(`${lock}: case new is already in progress; retry after it finishes`);
    throw error;
  }
  let created = false;
  try {
    const refs = existsSync(suiteFile) ? suiteCases(casesDir, suite) : [];
    const manifest = existsSync(suiteFile) ? readJson(suiteFile) : { schema_version: 2, cases: [] };
    if (manifest.formal === true) throw new Error(`${suiteFile}: case new creates an unreviewed draft; fix: author and calibrate in a local suite before registering in a formal suite`);
    if (refs.some(ref => ref.id === id) || existsSync(dir)) throw new Error(`case ${id}: already exists in ${suiteDir}; choose a new id`);
    mkdirSync(dir); created = true;
    const config: CaseConfig = {
      schema_version: 2, id, version: '1.0.0', type: 'positive',
      requirement_id: requirementId, brief: 'brief.md',
      input: 'input.json', fixture: 'fixture.json', initial_state: 'initial-state.json',
      acceptance: 'acceptance.json', artifact_allowlist: ['answer.json'],
      budgets: { timeout_ms: 2000, max_steps: 1 },
      ...(source ? { source_evidence: { run_id: source.run_id, case_id: source.case_id, result: 'source-evidence/result.json' } } : {}),
    };
    const acceptance: Acceptance = {
      gold: { answer: 'TODO_EXPECTED_ANSWER' },
      criteria: [{ id: 'answer-equals', type: 'equals', target: { artifact: 'answer.json', field: 'answer' },
        params: { expected: 'TODO_EXPECTED_ANSWER' }, mode: 'hard', reason: 'TODO: 解释此检查对应的需求和失败影响。' }],
      error_examples: [{ expected_failed_criteria: ['answer-equals'], answer: 'TODO_STUB_RESPONSE', reason: 'TODO: 描述此响应如何违反验收标准。' }],
      reviewed: false,
    };
    json(join(dir, 'case.json'), config);
    json(join(dir, 'input.json'), { prompt: 'TODO: 写下公开任务、输入与约束；不要包含私有 Gold 或错误对照。' });
    json(join(dir, 'fixture.json'), { answer: 'TODO_STUB_RESPONSE' });
    json(join(dir, 'initial-state.json'), {});
    json(join(dir, 'acceptance.json'), acceptance);
    if (source) cpSync(dirname(source.result_file), join(dir, 'source-evidence'), { recursive: true });
    writeFileSync(join(dir, 'gold.md'), `# Gold: ${id}

TODO: 根据需求独立编写 solve.ts，解释如何从 initial_state 得到产物。
不要读取 acceptance.json 或导入 verifier 的业务实现。Gold 与 verifier 必须独立实现。
运行 pnpm eval --suite ${suite} --case ${id} --agent oracle，检查 artifacts/ 与 verifier/ 的证据。
当前 solve.ts 故意输出 TODO_REFERENCE_ANSWER，与验收期望不同，Oracle 也应失败。
运行 pnpm eval validate --suite ${suite} 校准 Oracle 与全部错误对照。校准通过并检查证据后设置 reviewed=true；formal suite 会校验内容哈希。
`);
    writeFileSync(join(dir, 'solve.ts'), `import { readFileSync, writeFileSync } from 'node:fs';

const input = JSON.parse(readFileSync('input.json', 'utf8'));
// TODO: use input.initial_state to implement the task independently of acceptance.
void input;
writeFileSync('answer.json', JSON.stringify({ answer: 'TODO_REFERENCE_ANSWER', success: true }));
`);
    writeFileSync(join(dir, 'brief.md'), `# Case brief: ${id}

requirement_id: ${requirementId}
case_id: ${id}
${source ? `\n来源 run: ${source.run_id}; case: ${source.case_id}; [原始失败结果](source-evidence/result.json); [事件](source-evidence/events.jsonl); [产物](source-evidence/artifacts/)\n` : ''}

这是评测者私有的设计材料，不进入 AgentInput。TODO 填完、validate 校准通过并人工检查证据后，才将 acceptance.json 的 reviewed 改为 true。

## 目标行为

- TODO: 在什么前提和输入下，系统应产生什么可观察行为？
- TODO: 写明需求来源（Notion 链接或本地说明），与 requirement_id 对应。

## 退化信号

- TODO: 哪种输出或状态变化表示能力退化？
- TODO: 在 acceptance.json 的 error_examples 中记录错误响应及原因。

## 验收标准

- TODO: 写出可判定的通过条件，并对应 acceptance.json 的 criteria ID（初始为 answer-equals）。
- TODO: 在 acceptance.json 独立填写 gold.answer 和 criteria[].params.expected，不从公开 fixture 推导真值；填写 mode 和 reason。
- 证据：本地运行的 artifacts/answer.json 与 result.json 中的断言；公开任务仅放 input.json。
- TODO: 在 gold.md 解释参考解，并独立实现 solve.ts；使用 --agent oracle 经同一 verifier 验证。

模板中的 stub 响应与期望值故意不同，初次运行应 FAIL（退出码 1），避免把未完成模板误当能力验收通过。
`);
    // Reuse the v2 loader before registering the template; this does not execute an adapter.
    loadCase(casesDir, suite, { id, version: config.version });
    let suiteVersion = manifest.version;
    if (source) {
      if (suiteVersion === undefined) suiteVersion = '1.0.0';
      else {
        const parts = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.exec(suiteVersion);
        if (!parts || !Number.isSafeInteger(Number(parts[2])) || Number(parts[2]) >= Number.MAX_SAFE_INTEGER) throw new Error('suite version: expected incrementable major.minor.patch');
        suiteVersion = `${parts[1]}.${Number(parts[2]) + 1}.0`;
      }
    }
    json(suiteFile, { ...manifest, ...(source ? { version: suiteVersion } : {}), cases: [...manifest.cases, { id, version: config.version }] });
    return dir;
  } catch (error) {
    if (created) rmSync(dir, { recursive: true, force: true });
    throw error;
  } finally { rmSync(lock, { force: true }); }
}
