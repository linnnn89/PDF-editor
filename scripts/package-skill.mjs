import { mkdir, readFile, realpath, stat, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { verifySkillPackage } from './verify-skill-package.mjs';

const root = await realpath(fileURLToPath(new URL('..', import.meta.url)));
const sha = data => createHash('sha256').update(data).digest('hex');
const runtimeFiles = [
  'pdf-engine.exe', 'pdfium.dll', 'qpdf30.dll', 'concrt140.dll', 'msvcp140.dll',
  'msvcp140_1.dll', 'msvcp140_2.dll', 'msvcp140_atomic_wait.dll',
  'msvcp140_codecvt_ids.dll', 'vcruntime140.dll', 'vcruntime140_1.dll'
];
const skillFiles = ['SKILL.md', 'references/setup.md', 'references/operations.md', 'references/rules.md'];
const pdfiumNotices = [
  'abseil.txt', 'agg23.txt', 'fast_float.txt', 'freetype.txt', 'icu.txt', 'lcms.txt',
  'libjpeg_turbo.ijg', 'libjpeg_turbo.md', 'libopenjpeg.txt', 'libpng.txt',
  'llvm-libc.txt', 'pdfium.txt', 'simdutf.txt', 'zlib.txt'
];

function relativeFile(value) {
  if (typeof value !== 'string' || !value || value.includes('\\') || value.includes(':') ||
      value.split('/').some(part => !part || part === '.' || part === '..')) {
    throw new Error(`Invalid package-relative file: ${value}`);
  }
  return value;
}

async function exists(file) {
  try { await stat(file); return true; }
  catch (error) { if (error.code === 'ENOENT') return false; throw error; }
}

async function readWithin(base, relative) {
  const actual = await realpath(path.join(base, relativeFile(relative)));
  const fromBase = path.relative(base, actual);
  if (path.isAbsolute(fromBase) || fromBase === '..' || fromBase.startsWith(`..${path.sep}`)) {
    throw new Error(`Source escapes its package directory: ${relative}`);
  }
  return readFile(actual);
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length && (args.length !== 2 || args[0] !== '--output' || !path.isAbsolute(args[1]))) {
    throw new Error('Usage: node scripts/package-skill.mjs [--output <new-absolute-directory>]');
  }
  const output = args.length ? path.resolve(args[1]) :
    path.join(root, 'artifacts', 'skill-packages', new Date().toISOString().replace(/[:.]/g, '-'), 'pdf-editor');
  if (await exists(output)) throw new Error(`Output already exists: ${output}`);

  // A packed project reuses its enclosing skill, avoiding a second discoverable SKILL.md.
  const template = path.join(root, 'skills', 'pdf-editor');
  const skillRoot = await realpath(await exists(path.join(template, 'SKILL.md')) ? template : path.dirname(root));
  const projectFiles = JSON.parse(await readFile(path.join(root, 'skills/project-files.json'), 'utf8'));
  if (!Array.isArray(projectFiles) || !projectFiles.length || new Set(projectFiles).size !== projectFiles.length) {
    throw new Error('Public project file manifest must be a nonempty list without duplicates');
  }
  const files = new Map();
  const add = (file, data) => {
    relativeFile(file);
    if (files.has(file)) throw new Error(`Duplicate package destination: ${file}`);
    files.set(file, data);
  };
  for (const file of skillFiles) add(file, await readWithin(skillRoot, file));
  for (const file of projectFiles) add(`project/${relativeFile(file)}`, await readWithin(root, file));
  for (const file of runtimeFiles) add(`project/build/bin/${file}`, await readWithin(root, `build/bin/${file}`));
  const notices = [
    ['vendor/pdfium/LICENSE', 'licenses/pdfium-binaries-LICENSE'],
    ['vendor/json/LICENSE.MIT', 'licenses/nlohmann-json-LICENSE.MIT'],
    ...pdfiumNotices.map(file => [`vendor/pdfium/licenses/${file}`, `licenses/pdfium/${file}`])
  ];
  for (const [source, destination] of notices) {
    // Repackaging an installed project uses the notices already shipped with it.
    add(`project/${destination}`, await readWithin(root, await exists(path.join(root, source)) ? source : destination));
  }

  // Starting the built worker catches missing DLLs and JS/native version mismatch before publication.
  const { PdfEditor, version } = await import('../src/index.mjs');
  const editor = await PdfEditor.create();
  try {
    if (editor.engineInfo.version !== version) throw new Error('Native worker version does not match JavaScript');
  } finally { await editor.close(); }
  const manifest = {
    name: 'pdf-editor', version, platform: 'win32-x64', node: '>=24 <25',
    files: [...files].map(([file, data]) => ({ file, bytes: data.length, sha256: sha(data) }))
  };
  add('package-manifest.json', Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`));
  await mkdir(path.dirname(output), { recursive: true });
  await mkdir(output); // Deliberately non-recursive: a concurrent existing destination must also fail.
  for (const [file, data] of files) {
    const destination = path.join(output, file);
    await mkdir(path.dirname(destination), { recursive: true });
    await writeFile(destination, data, { flag: 'wx' });
  }
  const bytes = [...files.values()].reduce((total, data) => total + data.length, 0);
  const verification = await verifySkillPackage(output);
  console.log(JSON.stringify({ output, version, files: files.size, bytes, sizeMiB: +(bytes / 1048576).toFixed(3), verification }, null, 2));
}

main().catch(error => { console.error(error.message); process.exitCode = 1; });
