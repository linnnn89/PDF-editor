import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { doctor, openDocument, sha256, version } from '../src/index.mjs';
import { fixture } from './fixtures.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
await mkdir(path.join(root, 'artifacts/tests'), { recursive: true });
const work = await mkdtemp(path.join(root, 'artifacts/tests/runtime-'));
const cli = (project, args) => spawnSync(process.execPath, [path.join(project, 'src/cli.mjs'), ...args], {
  cwd: project, encoding: 'utf8', windowsHide: true, timeout: 15_000,
});
function timings(result, phases) {
  assert.deepEqual(Object.keys(result.timingsMs).sort(), phases.sort());
  assert.ok(Object.values(result.timingsMs).every(ms => Number.isFinite(ms) && ms >= 0));
  assert.ok(Object.values(result.timingsMs).reduce((sum, ms) => sum + ms, 0) <= result.engineMs + .01);
}

test('indexed targets after nested Forms remain distinct across pages and reopening, with bounded phase timings', async () => {
  const input = path.join(work, 'indexed.pdf');
  await fixture(input, { content: 'q\nq 1 0 0 1 30 60 cm /Fm Do Q\n'
    + 'BT /F1 10 Tf 1 0 0 1 30 115 Tm (After A) Tj ET\n'
    + 'BT /F1 10 Tf 1 0 0 1 30 100 Tm (After B) Tj ET\n' });
  const hash = await sha256(input), editor = await openDocument(input);
  try {
    const pages = [];
    for (const page of [0, 1]) {
      const info = await editor.query({ page, text: 'After', fields: ['textSource', 'editable'] });
      assert.deepEqual(info.objects.map(o => [o.id, o.textSource, o.editable]),
        [[`p${page}/1`, 'After A', true], [`p${page}/2`, 'After B', true]]);
      timings(info, ['objectIndex', 'sourceMapping', 'selection']);
      const cached = await editor.query({ page, id: `p${page}/2`, fields: ['textSource'] });
      assert.deepEqual(cached.objects, [{ id: `p${page}/2`, type: 'text', textSource: 'After B' }]);
      pages.push(info);
    }
    const operations = [
      { op: 'text.replace', page: 0, target: 'p0/1', expect: { text: 'After A' }, value: 'After B' },
      { op: 'text.replace', page: 1, target: 'p1/2', expect: { text: 'After B' }, value: 'After A' },
    ];
    const receipt = await editor.apply({ sourceSha256: hash, output: path.join(work, 'indexed-edited.pdf'), operations,
      textBounds: operations.map(op => ({ page: op.page, targets: [op.target],
        withinRectPt: { x: 0, y: 0, width: pages[op.page].widthPt, height: pages[op.page].heightPt } })) });
    timings(receipt, ['prepare', 'sourceMapping', 'patch', 'sourceStreams', 'save', 'reopen', 'verifyObjects', 'verifyPixels']);
    assert.equal(receipt.validation.textBounds.checkedObjects, 2);
    assert.ok(receipt.validation.pixelGates.every(gate => gate.changedPixelsOutside === 0));
    await editor.open(receipt.output);
    for (const op of operations) {
      const after = await editor.query({ page: op.page, id: op.target });
      assert.equal(after.objects[0].textSource, op.value);
    }
    assert.equal((await editor.query({ page: 0, id: 'p0/2' })).objects[0].textSource, 'After B');
    assert.equal((await editor.query({ page: 1, id: 'p1/1' })).objects[0].textSource, 'After A');
    await editor.open(input);
    assert.equal((await editor.query({ id: 'p0/1' })).objects[0].textSource, 'After A');
    assert.equal(await sha256(input), hash);
  } finally { await editor.close(); }
});

test('deep doctor checks real workers, reports missing and mismatched installations, and closes the worker', async () => {
  assert.equal((await doctor()).workerStarted, false);
  const healthy = await doctor({ deep: true });
  assert.equal(healthy.ready, true);
  assert.equal(healthy.workerStarted, true);
  assert.equal(healthy.engine.version, version);
  assert.throws(() => process.kill(healthy.engine.pid, 0), { code: 'ESRCH' });
  for (const options of [null, [], { deep: 'yes' }, { unknown: true }])
    await assert.rejects(doctor(options), { code: 'INVALID_ARGUMENT' });
  const project = path.join(work, '诊断 安装');
  await mkdir(project);
  await cp(path.join(root, 'src'), path.join(project, 'src'), { recursive: true });
  const pkg = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
  await writeFile(path.join(project, 'package.json'), JSON.stringify(pkg));
  const shallow = cli(project, ['doctor']);
  assert.equal(shallow.status, 0, shallow.stderr);
  assert.equal(JSON.parse(shallow.stdout).built, false);
  const missing = cli(project, ['doctor', '--deep']);
  assert.equal(missing.status, 1, missing.stderr);
  assert.equal(JSON.parse(missing.stdout).error.code, 'ENGINE_NOT_FOUND');
  assert.equal(JSON.parse(missing.stdout).workerStarted, false);
  await mkdir(path.join(project, 'build'));
  await cp(path.join(root, 'build/bin'), path.join(project, 'build/bin'), { recursive: true });
  await writeFile(path.join(project, 'package.json'), JSON.stringify({ ...pkg, version: '0.0.0-doctor-test' }));
  const mismatch = cli(project, ['doctor', '--deep']);
  assert.equal(mismatch.status, 1, mismatch.stderr);
  const failed = JSON.parse(mismatch.stdout);
  assert.equal(failed.ready, false);
  assert.equal(failed.workerStarted, true);
  assert.equal(failed.error.code, 'ENGINE_VERSION_MISMATCH');
  const invalid = cli(root, ['query', 'missing.pdf', '--deep']);
  assert.equal(invalid.status, 1);
  assert.equal(JSON.parse(invalid.stderr).error.code, 'INVALID_ARGUMENT');
});
