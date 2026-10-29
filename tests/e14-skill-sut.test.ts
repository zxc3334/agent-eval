import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadSkill, injectSkill, runSkillMatrix } from '../src/skill.ts';
import { setup, execute, write } from './helpers.ts';
import type { SkillMatrixConfig } from '../src/types.ts';

test('loadSkill parses frontmatter and markdown body correctly', () => {
  const dir = mkdtempSync(join(tmpdir(), 'skill-test-'));
  try {
    const skillContent = `---
name: code-analyzer
description: Analyzes code structure and symbol references
version: 2.1.0
---

# Code Analyzer Skill

Use this skill when you need to parse AST and find symbols.
`;
    const skillFile = join(dir, 'SKILL.md');
    writeFileSync(skillFile, skillContent);

    const loaded = loadSkill(dir);
    assert.equal(loaded.name, 'code-analyzer');
    assert.equal(loaded.description, 'Analyzes code structure and symbol references');
    assert.equal(loaded.version, '2.1.0');
    assert.ok(loaded.body.includes('# Code Analyzer Skill'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('injectSkill stages skill into workspace with progressive disclosure modes', () => {
  const dir = mkdtempSync(join(tmpdir(), 'inject-test-'));
  const workspace = join(dir, 'workspace');
  mkdirSync(workspace);
  try {
    const loaded = {
      name: 'git-helper',
      description: 'Helps with git branch management',
      body: 'Detailed steps for branch rebasing...',
      version: '1.0.0',
      path: dir,
    };

    // Full injection
    injectSkill(loaded, workspace, 'full');
    const targetFile = join(workspace, '.agents/skills/git-helper/SKILL.md');
    assert.ok(existsSync(targetFile));
    const fullText = readFileSync(targetFile, 'utf8');
    assert.ok(fullText.includes('Detailed steps for branch rebasing...'));

    // Metadata-only injection (progressive disclosure)
    const metaWorkspace = join(dir, 'meta-workspace');
    mkdirSync(metaWorkspace);
    injectSkill(loaded, metaWorkspace, 'metadata');
    const metaText = readFileSync(join(metaWorkspace, '.agents/skills/git-helper/SKILL.md'), 'utf8');
    assert.ok(metaText.includes('name: git-helper'));
    assert.ok(!metaText.includes('Detailed steps for branch rebasing'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('runSkillMatrix executes baseline vs candidate comparison and reports win rate', async () => {
  const t = setup();
  const skillDir = join(t.root, 'skills', 'test-skill');
  mkdirSync(skillDir, { recursive: true });
  try {
    writeFileSync(
      join(skillDir, 'SKILL.md'),
      `---
name: test-skill
description: A mock skill for matrix testing
version: 1.0.0
---
Instruction content.
`
    );

    const matrixConfig: SkillMatrixConfig = {
      sut: { name: 'test-skill', path: skillDir, version: '1.0.0' },
      baseline: null,
      suite: 'smoke',
      cases_dir: t.cases,
      runs_dir: t.runs,
    };

    const report = await runSkillMatrix(matrixConfig, t.runs);
    assert.equal(report.skill, 'test-skill');
    assert.equal(report.suite, 'smoke');
    assert.equal(report.total_cases, 2); // smoke has smoke-pass and smoke-fail
    assert.ok(Array.isArray(report.cases));
    assert.equal(report.cases.length, 2);
    assert.ok(typeof report.win_rate === 'number');
  } finally {
    rmSync(t.root, { recursive: true, force: true });
  }
});

test('CLI skill-matrix subcommand executes cleanly and outputs summary', () => {
  const t = setup();
  const skillDir = join(t.root, 'skills', 'my-skill');
  mkdirSync(skillDir, { recursive: true });
  const configFile = join(t.root, 'matrix.json');
  try {
    writeFileSync(
      join(skillDir, 'SKILL.md'),
      `---
name: my-skill
description: CLI matrix mock skill
version: 1.0.0
---
Instructions
`
    );

    write(configFile, {
      sut: { name: 'my-skill', path: skillDir },
      baseline: null,
      suite: 'smoke',
      cases_dir: t.cases,
      runs_dir: t.runs,
    });

    const res = execute(['skill-matrix', configFile, '--runs-dir', t.runs]);
    assert.equal(res.status, 0, res.stderr);
    assert.match(res.stdout, /Skill Matrix: my-skill on suite smoke/);
    assert.match(res.stdout, /Win rate:/);
  } finally {
    rmSync(t.root, { recursive: true, force: true });
  }
});
