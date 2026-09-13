import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = fileURLToPath(new URL('..', import.meta.url));
if (process.platform !== 'win32' || process.arch !== 'x64') {
  throw new Error('This release supports Windows x64 only.');
}
const lock = JSON.parse(await readFile(path.join(root, 'dependencies.lock.json'), 'utf8'));
const sha = buffer => createHash('sha256').update(buffer).digest('hex');
await mkdir(path.join(root, 'test pdf'), { recursive: true });
await mkdir(path.join(root, 'vendor', 'downloads'), { recursive: true });
for (const dep of lock.dependencies) {
  const local = path.join(root, 'vendor', dep.file ?? `downloads/${dep.archive}`);
  await mkdir(path.dirname(local), { recursive: true });
  let data;
  try { data = await readFile(local); } catch (e) { if (e.code !== 'ENOENT') throw e; }
  if (!data || sha(data) !== dep.sha256) {
    console.log(`Downloading ${dep.name} ${dep.version} into vendor/`);
    const response = await fetch(dep.url, { signal: AbortSignal.timeout(120_000) });
    if (!response.ok) throw new Error(`HTTP ${response.status}: ${dep.url}`);
    data = Buffer.from(await response.arrayBuffer());
    if (sha(data) !== dep.sha256) throw new Error(`SHA-256 mismatch: ${dep.name}`);
    const temporary = `${local}.tmp`;
    await writeFile(temporary, data);
    await rename(temporary, local);
  }
  if (dep.destination) {
    const destination = path.join(root, 'vendor', dep.destination);
    const marker = path.join(destination, '.verified-source-sha256');
    let previous;
    try { previous = await readFile(marker, 'utf8'); } catch (e) { if (e.code !== 'ENOENT') throw e; }
    if (previous !== dep.sha256) {
      await mkdir(destination, { recursive: true });
      const entries = execFileSync('tar.exe', ['-tf', local], { encoding: 'utf8', windowsHide: true });
      if (entries.split(/\r?\n/).some(item => /(^[/\\]|^[A-Za-z]:|(^|[/\\])\.\.([/\\]|$))/.test(item))) {
        throw new Error(`Unsafe archive entry in ${dep.name}`);
      }
      execFileSync('tar.exe', ['-xf', local, '-C', destination], { stdio: 'inherit', windowsHide: true });
      await writeFile(marker, dep.sha256);
    }
  }
  console.log(`Verified ${dep.name} ${dep.version}`);
}
console.log('Project-local dependencies ready. Next: npm run build');
