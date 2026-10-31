import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  aggregateScoreExit,
  checkSkillEvidence,
  parseFeaturesMap,
  parsePinFile,
  pinnedDigest,
  scoreExitCode,
  scoreFromCheckedEvidence,
  verdictFromFeatures,
} from '../packages/core/src/evidence.ts';
import type { FeaturesMap } from '../packages/core/src/evidence.ts';

const map: FeaturesMap = {
  version: '1.0.0',
  features: [
    { id: 'gate', mode: 'hard', reason: 'This hard row gates the verdict.' },
    { id: 'note', mode: 'diagnostic', reason: 'This diagnostic row does not gate the verdict.' },
  ],
};

function scored(passedGate: boolean, passedNote: boolean) {
  const dir = mkdtempSync(join(tmpdir(), 'agent-eval-evidence-'));
  try {
    writeFileSync(join(dir, 'note.txt'), 'x\n');
    const raw = {
      features: [
        { id: 'note', passed: passedNote, evidence: [{ artifact: 'note.txt', field: 'contents' }] },
        { id: 'gate', passed: passedGate, actual: 'x\n', evidence: [{ artifact: 'note.txt', field: 'contents' }] },
      ],
    };
    return scoreFromCheckedEvidence(checkSkillEvidence(raw, map, dir, dir));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('pinned digest is stable and hard rows gate the verdict', () => {
  const first = pinnedDigest([
    { path: 'b', bytes: Buffer.from('1') },
    { path: 'a', bytes: Buffer.from('2') },
  ]);
  const second = pinnedDigest([
    { path: 'a', bytes: Buffer.from('2') },
    { path: 'b', bytes: Buffer.from('1') },
  ]);
  assert.equal(first, second);
  assert.notEqual(first, pinnedDigest([{ path: 'a', bytes: Buffer.from('3') }]));

  const failed = scored(false, true);
  assert.equal(failed.score, 'feature fail');
  assert.match(failed.reason, /gate/);
  const noted = scored(true, false);
  assert.equal(noted.score, 'pass');
  assert.equal(noted.features.find(feature => feature.id === 'note')?.mode, 'diagnostic');
  assert.equal(noted.features.find(feature => feature.id === 'note')?.passed, false);
  assert.equal(verdictFromFeatures(noted.features), 'pass');
});

test('invalid skill evidence is a verifier error and never a feature fail', () => {
  const dir = mkdtempSync(join(tmpdir(), 'agent-eval-evidence-'));
  try {
    writeFileSync(join(dir, 'note.txt'), 'x\n');
    const missing = checkSkillEvidence({ features: [] }, map, dir, dir);
    assert.equal(missing.ok, false);
    assert.equal(scoreFromCheckedEvidence(missing).score, 'verifier error');
    const smuggled = checkSkillEvidence({
      features: [
        { id: 'gate', passed: false, mode: 'diagnostic', evidence: [{ artifact: 'note.txt', field: 'contents' }] },
        { id: 'note', passed: true, evidence: [{ artifact: 'note.txt', field: 'contents' }] },
      ],
    }, map, dir, dir);
    assert.equal(smuggled.ok, false);
    if (!smuggled.ok) assert.equal(smuggled.kind, 'invalid_result');
    assert.equal(scoreFromCheckedEvidence(smuggled).score, 'verifier error');
    const absent = checkSkillEvidence({
      features: [
        { id: 'gate', passed: false, evidence: [{ artifact: 'missing.txt', field: 'contents' }] },
        { id: 'note', passed: true, evidence: [{ artifact: 'note.txt', field: 'contents' }] },
      ],
    }, map, dir, dir);
    assert.equal(absent.ok, false);
    assert.equal(scoreFromCheckedEvidence(absent).score, 'verifier error');
    const nan = checkSkillEvidence({
      features: [
        { id: 'gate', passed: false, actual: Number.NaN, evidence: [{ artifact: 'note.txt', field: 'contents' }] },
        { id: 'note', passed: true, evidence: [{ artifact: 'note.txt', field: 'contents' }] },
      ],
    }, map, dir, dir);
    assert.equal(nan.ok, false);
    assert.equal(scoreFromCheckedEvidence(nan).score, 'verifier error');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('unavailable exits differently from feature fail, and errors are not collapsed', () => {
  assert.equal(scoreExitCode('pass'), 0);
  assert.equal(scoreExitCode('unavailable'), 0);
  assert.equal(scoreExitCode('feature fail'), 1);
  assert.notEqual(scoreExitCode('unavailable'), scoreExitCode('feature fail'));
  assert.equal(scoreExitCode('verifier error'), 2);
  assert.equal(scoreExitCode('interrupted'), 3);
  assert.equal(aggregateScoreExit(['pass', 'unavailable']), 0);
  assert.equal(aggregateScoreExit(['feature fail', 'pass']), 1);
  assert.equal(aggregateScoreExit(['feature fail', 'verifier error']), 2);
  assert.equal(aggregateScoreExit(['interrupted', 'feature fail']), 3);

  const onlyDiagnostic = parseFeaturesMap({
    version: '1',
    features: [{ id: 'note', mode: 'diagnostic', reason: 'notes only' }],
  });
  assert.equal(onlyDiagnostic.ok, true);
  if (onlyDiagnostic.ok) {
    assert.equal(verdictFromFeatures([{
      id: 'note', mode: 'diagnostic', reason: 'notes only', passed: true, evidence: [],
    }]), 'verifier error');
  }
  assert.equal(parsePinFile({ id: 'verify-mini', version: '1.0.0', extra: true }).ok, false);
  assert.equal(parseFeaturesMap({ version: '1', features: [{ id: 'gate', mode: 'soft', reason: 'no' }] }).ok, false);
});
