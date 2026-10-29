const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
// Do not import submitted code into the test process. Its child has access to
// frozen outputs only, cannot read private tests or spawn additional processes.
try {
  assert.equal(Date.now(), 1767225600000);
  for (const [a, b] of [[2, 3], [-4, 7], [0, 0], [1.5, 2.25], [100, -20]]) {
    const child = spawnSync(process.execPath, ['--permission', '--allow-fs-read=/artifacts', '-e',
      'const add = require("/artifacts/add.cjs"); process.stdout.write(JSON.stringify(add(Number(process.argv[1]), Number(process.argv[2]))));',
      '--', String(a), String(b)], { encoding: 'utf8', timeout: 1000, maxBuffer: 65536, env: { PATH: process.env.PATH } });
    assert.equal(child.status, 0, child.stderr);
    assert.equal(JSON.parse(child.stdout), a + b);
  }
  console.log('private functional checks passed');
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
