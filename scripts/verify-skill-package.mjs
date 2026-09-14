import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, realpath, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs, promisify } from 'node:util';

const root = fileURLToPath(new URL('..', import.meta.url));
const runFile = promisify(execFile);

export async function verifySkillPackage(directory) {
  const source = await realpath(directory);
  const manifestBytes = await readFile(path.join(source, 'package-manifest.json'));
  const manifest = JSON.parse(manifestBytes);
  assert.equal(manifest.name, 'pdf-editor');
  assert.ok(Array.isArray(manifest.files) && manifest.files.length > 0, 'Package file manifest is required');
  const parent = path.join(root, 'artifacts', 'package-checks');
  await mkdir(parent, { recursive: true });
  const work = await mkdtemp(path.join(parent, 'run-'));
  // Exercise relocation, Unicode and spaces without adding demo files to the distributable package.
  const relocated = path.join(work, '中文 空格', 'pdf-editor');
  const seen = new Set(['package-manifest.json']);
  for (const entry of manifest.files) {
    const file = entry.file;
    assert.ok(typeof file === 'string' && file && !file.includes('\\') && !file.includes(':') &&
      file.split('/').every(part => part && part !== '.' && part !== '..'), 'Invalid manifest path');
    assert.ok(!seen.has(file), `Duplicate manifest path: ${file}`);
    seen.add(file);
    const actual = await realpath(path.join(source, file));
    const relative = path.relative(source, actual);
    assert.ok(!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`),
      `Package source escapes its directory: ${file}`);
    const data = await readFile(actual);
    assert.equal(data.length, entry.bytes, `Package size mismatch: ${file}`);
    assert.equal(createHash('sha256').update(data).digest('hex'), entry.sha256, `Package SHA-256 mismatch: ${file}`);
    const destination = path.join(relocated, file);
    await mkdir(path.dirname(destination), { recursive: true });
    await writeFile(destination, data, { flag: 'wx' });
  }
  await writeFile(path.join(relocated, 'package-manifest.json'), manifestBytes, { flag: 'wx' });
  const project = path.join(relocated, 'project');
  const run = async args => {
    const { stdout } = await runFile(process.execPath, args, {
      cwd: project, windowsHide: true, timeout: 120_000, maxBuffer: 1024 * 1024,
    });
    return JSON.parse(stdout);
  };
  const doctor = await run(['src/cli.mjs', 'doctor', '--deep']);
  assert.equal(doctor.ready, true);
  assert.equal(doctor.version, manifest.version);
  assert.equal(doctor.engine.version, manifest.version);
  assert.equal(path.resolve(doctor.enginePath), path.join(project, 'build', 'bin', 'pdf-engine.exe'));
  const demo = await run(['scripts/demo.mjs']);
  assert.equal(demo.originalUnchanged, true);
  assert.equal(demo.changedPixelsOutside, 0);
  for (const file of [demo.beforePreview, demo.afterPreview]) {
    const png = await readFile(file);
    assert.deepEqual(png.subarray(0, 8), Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  }
  return { directory: relocated, filesVerified: manifest.files.length, doctor, demo };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const { values } = parseArgs({ options: { package: { type: 'string' } } });
    if (!values.package) throw new Error('Usage: node scripts/verify-skill-package.mjs --package <skill-directory>');
    console.log(JSON.stringify(await verifySkillPackage(path.resolve(values.package)), null, 2));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
