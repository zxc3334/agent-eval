import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { identifier, loadCase, readJson, suiteCases } from './config.ts';
import { json } from './storage.ts';
import type { Acceptance, CaseConfig } from './types.ts';

export function createCase(casesDir: string, suite: string, id: string, requirementId: string): string {
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
    if (refs.some(ref => ref.id === id) || existsSync(dir)) throw new Error(`case ${id}: already exists in ${suiteDir}; choose a new id`);
    mkdirSync(dir); created = true;
    const config: CaseConfig = {
      schema_version: 2, id, version: '1.0.0', type: 'positive',
      requirement_id: requirementId, brief: 'brief.md',
      input: 'input.json', fixture: 'fixture.json', initial_state: 'initial-state.json',
      acceptance: 'acceptance.json', artifact_allowlist: ['answer.json'],
      budgets: { timeout_ms: 2000, max_steps: 1 },
    };
    const acceptance: Acceptance = {
      gold: { answer: 'TODO_EXPECTED_ANSWER' },
      criteria: [{ id: 'answer-equals', type: 'equals', target: { artifact: 'answer.json', field: 'answer' },
        params: { expected: 'TODO_EXPECTED_ANSWER' }, mode: 'hard', reason: 'TODO: 解释此检查对应的需求和失败影响。' }],
      error_examples: [{ answer: 'TODO_STUB_RESPONSE', reason: 'TODO: 描述此响应如何违反验收标准。' }],
      reviewed: false,
    };
    json(join(dir, 'case.json'), config);
    json(join(dir, 'input.json'), { prompt: 'TODO: 写下公开任务、输入与约束；不要包含私有 Gold 或错误对照。' });
    json(join(dir, 'fixture.json'), { answer: 'TODO_STUB_RESPONSE' });
    json(join(dir, 'initial-state.json'), {});
    json(join(dir, 'acceptance.json'), acceptance);
    writeFileSync(join(dir, 'brief.md'), `# Case brief: ${id}

requirement_id: ${requirementId}
case_id: ${id}

这是评测者私有的设计材料，不进入 AgentInput。TODO 填完并人工确认后，才将 acceptance.json 的 reviewed 改为 true。

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

模板中的 stub 响应与期望值故意不同，初次运行应 FAIL（退出码 1），避免把未完成模板误当能力验收通过。
`);
    // Reuse the v2 loader before registering the template; this does not execute an adapter.
    loadCase(casesDir, suite, { id, version: config.version });
    json(suiteFile, { ...manifest, cases: [...manifest.cases, { id, version: config.version }] });
    return dir;
  } catch (error) {
    if (created) rmSync(dir, { recursive: true, force: true });
    throw error;
  } finally { rmSync(lock, { force: true }); }
}
