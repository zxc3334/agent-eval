import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { normalizeCriteria } from '../src/criteria.ts';
import { evaluateToolCalls } from '../src/tool-verifier.ts';
import { loadCase } from '../src/config.ts';
import { generateReport } from '../src/report.ts';
import type { ToolCriterion } from '../src/types.ts';

test('normalizeCriteria validates skill_activated, skill_avoided, and runbook_adherence criteria', () => {
  const criteria = normalizeCriteria([
    {
      id: 'c-activated',
      type: 'skill_activated',
      mode: 'hard',
      reason: 'Skill should be invoked',
      target: { artifact: 'trace.json', field: '' },
      params: { skill_name: 'git-workflow' },
    },
    {
      id: 'c-avoided',
      type: 'skill_avoided',
      mode: 'hard',
      reason: 'Dangerous skill should not be invoked',
      target: { artifact: 'trace.json', field: '' },
      params: { skill_name: 'dangerous-db-drop' },
    },
    {
      id: 'c-adherence',
      type: 'runbook_adherence',
      mode: 'hard',
      reason: 'All runbook steps must be followed',
      target: { artifact: 'trace.json', field: '' },
      params: { required_steps: ['init_repo', 'create_branch', 'commit_changes'] },
    },
  ], 'test-acceptance.json');

  assert.equal(criteria.length, 3);
  assert.equal(criteria[0].type, 'skill_activated');
  assert.equal((criteria[0] as any).params.skill_name, 'git-workflow');
  assert.equal(criteria[1].type, 'skill_avoided');
  assert.equal((criteria[1] as any).params.skill_name, 'dangerous-db-drop');
  assert.equal(criteria[2].type, 'runbook_adherence');
  assert.deepEqual((criteria[2] as any).params.required_steps, ['init_repo', 'create_branch', 'commit_changes']);

  // Validation failures
  assert.throws(() => {
    normalizeCriteria([{
      id: 'c-bad-act',
      type: 'skill_activated',
      mode: 'hard',
      reason: 'test',
      target: { artifact: 'trace.json', field: '' },
      params: { skill_name: '' },
    }], 'test.json');
  }, /skill_activated requires nonempty skill_name/);

  assert.throws(() => {
    normalizeCriteria([{
      id: 'c-bad-steps',
      type: 'runbook_adherence',
      mode: 'hard',
      reason: 'test',
      target: { artifact: 'trace.json', field: '' },
      params: { required_steps: [] },
    }], 'test.json');
  }, /runbook_adherence requires nonempty array of required_steps/);
});

test('evaluateToolCalls enforces skill_activated and skill_avoided', () => {
  const actCriterion: ToolCriterion = {
    id: 'c-act',
    type: 'skill_activated',
    mode: 'hard',
    reason: 'test',
    target: { artifact: 'events.jsonl', field: '' },
    params: { skill_name: 'web-search' },
  };

  // Case 1: Activated via tool name
  const res1 = evaluateToolCalls(actCriterion, [
    { tool: 'web-search', arguments: { query: 'test' } },
  ]);
  assert.equal(res1.passed, true);

  // Case 2: Activated via arguments.skill
  const res2 = evaluateToolCalls(actCriterion, [
    { tool: 'invoke_skill', arguments: { skill: 'web-search' } },
  ]);
  assert.equal(res2.passed, true);

  // Case 3: Not activated
  const res3 = evaluateToolCalls(actCriterion, [
    { tool: 'read_file', arguments: { path: '/tmp/test' } },
  ]);
  assert.equal(res3.passed, false);
  assert.ok(res3.problem?.includes('expected skill web-search to be activated'));

  // Case 4: Avoided check - passes when not invoked
  const avoidCriterion: ToolCriterion = {
    id: 'c-avoid',
    type: 'skill_avoided',
    mode: 'hard',
    reason: 'test',
    target: { artifact: 'events.jsonl', field: '' },
    params: { skill_name: 'db-drop' },
  };
  const res4 = evaluateToolCalls(avoidCriterion, [
    { tool: 'read_file', arguments: { path: '/tmp/test' } },
  ]);
  assert.equal(res4.passed, true);

  // Case 5: Avoided check - fails when invoked (false positive trigger)
  const res5 = evaluateToolCalls(avoidCriterion, [
    { tool: 'db-drop', arguments: { force: true } },
  ]);
  assert.equal(res5.passed, false);
  assert.ok(res5.problem?.includes('was unexpectedly activated'));
});

test('evaluateToolCalls verifies runbook_adherence step completion', () => {
  const adherenceCriterion: ToolCriterion = {
    id: 'c-adherence',
    type: 'runbook_adherence',
    mode: 'hard',
    reason: 'test',
    target: { artifact: 'events.jsonl', field: '' },
    params: { required_steps: ['step_a', 'step_b', 'step_c'] },
  };

  // Case 1: All required steps invoked
  const res1 = evaluateToolCalls(adherenceCriterion, [
    { tool: 'step_a', arguments: {} },
    { tool: 'other_step', arguments: {} },
    { tool: 'step_b', arguments: {} },
    { tool: 'step_c', arguments: {} },
  ]);
  assert.equal(res1.passed, true);

  // Case 2: Missing step_c
  const res2 = evaluateToolCalls(adherenceCriterion, [
    { tool: 'step_a', arguments: {} },
    { tool: 'step_b', arguments: {} },
  ]);
  assert.equal(res2.passed, false);
  assert.ok(res2.problem?.includes('unmet runbook steps from SKILL.md: step_c'));
});

test('loadCase validates skill_intent and target_skill', () => {
  const root = mkdtempSync(join(tmpdir(), 'case-skill-test-'));
  try {
    const suiteDir = join(root, 'cases', 'skill-suite');
    const caseDir = join(suiteDir, 'c1');
    mkdirSync(caseDir, { recursive: true });

    writeFileSync(join(suiteDir, 'suite.json'), JSON.stringify({
      schema_version: 2,
      cases: [{ id: 'c1', version: '1.0.0' }],
    }));

    const validCase = {
      schema_version: 2,
      id: 'c1',
      version: '1.0.0',
      type: 'positive',
      skill_intent: 'trigger_positive',
      target_skill: 'code-review',
      budgets: { timeout_ms: 5000, max_steps: 10 },
      artifact_allowlist: ['answer.json'],
      acceptance: 'acceptance.json',
      input: 'input.json',
      fixture: 'fixture.json',
      initial_state: 'state.json',
    };
    writeFileSync(join(caseDir, 'case.json'), JSON.stringify(validCase));
    writeFileSync(join(caseDir, 'input.json'), JSON.stringify({ prompt: 'test' }));
    writeFileSync(join(caseDir, 'fixture.json'), JSON.stringify({ answer: {} }));
    writeFileSync(join(caseDir, 'state.json'), JSON.stringify({}));
    writeFileSync(join(caseDir, 'acceptance.json'), JSON.stringify({
      criteria: [{ id: 'eq', type: 'equals', mode: 'hard', reason: 'Matches gold', target: { artifact: 'answer.json', field: '' }, params: { expected: {} } }],
      gold: { answer: {} },
      error_examples: [],
      reviewed: true,
    }));

    const loaded = loadCase(join(root, 'cases'), 'skill-suite', { id: 'c1', version: '1.0.0' });
    assert.equal(loaded.config.skill_intent, 'trigger_positive');
    assert.equal(loaded.config.target_skill, 'code-review');

    // Invalid skill_intent
    writeFileSync(join(caseDir, 'case.json'), JSON.stringify({
      ...validCase,
      skill_intent: 'invalid_mode',
    }));
    assert.throws(() => {
      loadCase(join(root, 'cases'), 'skill-suite', { id: 'c1', version: '1.0.0' });
    }, /skill_intent: expected trigger_positive, trigger_negative, or adherence_check/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('generateReport calculates skill_metrics confusion matrix, precision, recall, and adherence', () => {
  const root = mkdtempSync(join(tmpdir(), 'report-skill-metrics-'));
  try {
    const runDir = join(root, 'runs', 'test-run');
    mkdirSync(runDir, { recursive: true });

    const caseIds = ['c-pos-pass', 'c-pos-fail', 'c-neg-pass', 'c-neg-fail', 'c-adh-pass'];
    // Mock suite config with skill intent annotations
    const config = {
      run_id: 'test-run',
      agent: 'stub',
      case_ids: caseIds,
      repeat: 1,
      cases: [
        { config: { id: 'c-pos-pass', skill_intent: 'trigger_positive', target_skill: 'doc-search' } },
        { config: { id: 'c-pos-fail', skill_intent: 'trigger_positive', target_skill: 'doc-search' } },
        { config: { id: 'c-neg-pass', skill_intent: 'trigger_negative', target_skill: 'doc-search' } },
        { config: { id: 'c-neg-fail', skill_intent: 'trigger_negative', target_skill: 'doc-search' } },
        { config: { id: 'c-adh-pass', skill_intent: 'adherence_check', target_skill: 'doc-search' } },
      ],
      requirements: [],
    };
    writeFileSync(join(runDir, 'config.json'), JSON.stringify(config));

    // Mock individual results
    const results = [
      { case_id: 'c-pos-pass', trial: 1, status: 'pass', assertions: [], duration_ms: 100 },
      { case_id: 'c-pos-fail', trial: 1, status: 'fail', assertions: [], duration_ms: 100 },
      { case_id: 'c-neg-pass', trial: 1, status: 'pass', assertions: [], duration_ms: 100 }, // correctly avoided
      { case_id: 'c-neg-fail', trial: 1, status: 'fail', assertions: [], duration_ms: 100 }, // false positive trigger
      { case_id: 'c-adh-pass', trial: 1, status: 'pass', assertions: [], duration_ms: 100 },
    ];
    for (const r of results) {
      const caseDir = join(runDir, 'cases', r.case_id);
      mkdirSync(caseDir, { recursive: true });
      writeFileSync(join(caseDir, 'result.json'), JSON.stringify(r));
    }

    const state = { interrupted: false, error: null };
    writeFileSync(join(runDir, 'state.json'), JSON.stringify(state));

    const summary = generateReport(runDir);
    assert.equal(summary.counts.pass, 3);
    assert.equal(summary.counts.fail, 2);

    const summaryJson = JSON.parse(readFileSync(join(runDir, 'summary.json'), 'utf8'));
    assert.ok(summaryJson.skill_metrics);
    assert.equal(summaryJson.skill_metrics.skill_name, 'doc-search');
    assert.deepEqual(summaryJson.skill_metrics.confusion_matrix, {
      true_positives: 1,
      false_positives: 1,
      true_negatives: 1,
      false_negatives: 1,
    });
    // Precision: TP / (TP + FP) = 1 / 2 = 0.5
    assert.equal(summaryJson.skill_metrics.trigger_precision, 0.5);
    // Recall: TP / (TP + FN) = 1 / 2 = 0.5
    assert.equal(summaryJson.skill_metrics.trigger_recall, 0.5);
    // Adherence: 1 / 1 = 1.0
    assert.equal(summaryJson.skill_metrics.adherence_score, 1);

    const reportMd = readFileSync(join(runDir, 'report.md'), 'utf8');
    assert.ok(reportMd.includes('## Skill Intent & Adherence Metrics'));
    assert.ok(reportMd.includes('True Positives (TP) | 1'));
    assert.ok(reportMd.includes('False Positives (FP) | 1'));
    assert.ok(reportMd.includes('Trigger Precision | 50.0%'));
    assert.ok(reportMd.includes('Trigger Recall | 50.0%'));
    assert.ok(reportMd.includes('Runbook Adherence | 100.0%'));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
