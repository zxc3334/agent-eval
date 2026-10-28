import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, cpSync, mkdtempSync, mkdirSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createManifest, compareManifest, compareSourceFiles, compareUsedImages, writeManifest } from '../src/manifest.ts';
import { loadCase, loadExperiment, suiteCases } from '../src/config.ts';
import type { Options } from '../src/types.ts';

test('manifest tracks input and component hashes and detects a changed fixture before rerun', () => {
  const root = mkdtempSync(join(tmpdir(), 'e9-manifest-'));
  try {
    const casesDir = join(root, 'cases'); cpSync(resolve('cases/smoke'), join(casesDir, 'smoke'), { recursive: true });
    const options: Options = { suite: 'smoke', agent: 'stub', casesDir, runsDir: join(root, 'runs'), experimentFile: resolve('experiments/stub.json'), watch: false, failFast: false };
    const refs = suiteCases(casesDir, 'smoke');
    const caseDir = join(casesDir, 'smoke', refs[0].id);
    renameSync(join(caseDir, 'fixture.json'), join(caseDir, 'fixture-target.json')); symlinkSync('fixture-target.json', join(caseDir, 'fixture.json'));
    const cases = refs.map(ref => loadCase(casesDir, 'smoke', ref));
    const experiment = loadExperiment(options.experimentFile); const runDir = join(root, 'run'); mkdirSync(runDir);
    const initial = createManifest(options, cases, experiment);
    assert.match(initial.suite.sha256, /^[a-f0-9]{64}$/);
    assert.match(initial.cases[0].files['fixture.json'], /^[a-f0-9]{64}$/);
    assert.match(initial.adapter.sha256, /^[a-f0-9]{64}$/);
    assert.match(initial.verifier.sha256, /^[a-f0-9]{64}$/);
    assert.equal(initial.model, 'unknown');
    assert.equal(initial.sampling, 'unknown');
    assert.equal(initial.product_revision, 'unknown');
    mkdirSync(join(caseDir, 'nested-run')); writeFileSync(join(caseDir, 'nested-run', 'changing.log'), 'output');
    assert.equal(compareManifest(initial, createManifest(options, cases, experiment)).length, 0);
    writeFileSync(join(casesDir, 'smoke', cases[0].config.id, 'fixture.json'), '{"answer":"changed"}\n');
    const changed = createManifest(options, cases, experiment);
    assert.ok(compareManifest(initial, changed).some(diff => diff.includes('fixture.json')));
    writeFileSync(join(caseDir, 'fixture.json'), '{broken JSON');
    const rawDiffs = compareSourceFiles(initial, casesDir, 'smoke', refs);
    assert.ok(rawDiffs.some(diff => diff.includes('fixture.json')));
    writeFileSync(join(caseDir, 'case.json'), '{broken JSON');
    assert.ok(compareSourceFiles(initial, casesDir, 'smoke', refs).some(diff => diff.includes('case.json')));
    mkdirSync(join(runDir, 'cases')); writeFileSync(join(runDir, 'cases', 'output.txt'), 'proof');
    mkdirSync(join(runDir, 'cases', 'trial')); const usedDigest = `sha256:${'c'.repeat(64)}`;
    writeFileSync(join(runDir, 'cases', 'trial', 'container.json'), JSON.stringify({ role: 'agent', image: usedDigest }));
    writeManifest(runDir, initial);
    const saved = JSON.parse(readFileSync(join(runDir, 'manifest.json'), 'utf8'));
    assert.match(saved.artifacts['cases/output.txt'], /^[a-f0-9]{64}$/);
    assert.equal(saved.images_used['cases/trial/container.json'], usedDigest);
    assert.equal(saved.artifacts['manifest.json'], undefined);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('rerun comparison identifies a changed local image digest and unavailable image', () => {
  const root = mkdtempSync(join(tmpdir(), 'e9-image-'));
  const oldPath = process.env.PATH; const oldImageFile = process.env.E9_IMAGE_FILE;
  try {
    const bin = join(root, 'bin'); mkdirSync(bin);
    const docker = join(bin, 'docker'); writeFileSync(docker, '#!/bin/sh\ncat "$E9_IMAGE_FILE"\n'); chmodSync(docker, 0o755);
    const imageFile = join(root, 'digest'); process.env.E9_IMAGE_FILE = imageFile; process.env.PATH = `${bin}:${oldPath ?? ''}`;
    const first = `sha256:${'a'.repeat(64)}`; const second = `sha256:${'b'.repeat(64)}`;
    writeFileSync(imageFile, first);
    const casesDir = resolve('cases');
    const options: Options = { suite: 'e7-code', agent: 'container', casesDir, runsDir: join(root, 'runs'), experimentFile: resolve('experiments/container.json'), watch: false, failFast: false };
    const cases = suiteCases(casesDir, options.suite).map(ref => loadCase(casesDir, options.suite, ref)); const experiment = loadExperiment(options.experimentFile);
    const initial = createManifest(options, cases, experiment);
    assert.equal(initial.images['node:24-alpine'], first);
    writeFileSync(imageFile, second);
    const changed = createManifest(options, cases, experiment);
    assert.ok(compareManifest(initial, changed).some(diff => diff.includes('images.node:24-alpine') && diff.includes(second)));
    initial.images_used['cases/code-fix/artifacts/container.json'] = first;
    assert.deepEqual(compareUsedImages(initial), []);
    assert.ok(compareUsedImages(initial, changed.images).some(diff => diff.includes(first) && diff.includes(second)));
    rmSync(imageFile);
    const unavailable = createManifest(options, cases, experiment);
    assert.equal(unavailable.images['node:24-alpine'], 'unknown');
    assert.ok(compareUsedImages(initial, unavailable.images).some(diff => diff.includes('cannot be verified')));
  } finally {
    if (oldPath === undefined) delete process.env.PATH; else process.env.PATH = oldPath;
    if (oldImageFile === undefined) delete process.env.E9_IMAGE_FILE; else process.env.E9_IMAGE_FILE = oldImageFile;
    rmSync(root, { recursive: true, force: true });
  }
});
