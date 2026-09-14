import { access, mkdir, realpath, stat, link, mkdtemp, rm, readFile } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import path from 'node:path';
import { Engine, PdfError, enginePath } from './engine.mjs';

export { PdfError } from './engine.mjs';
export { summarizeReceipt } from './receipt.mjs';
export { planTextReplacements } from './text-replacements.mjs';
const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
export const version = pkg.version;
function checkedEngineInfo(info) {
  if (info.version !== version || info.protocol !== 1) throw new PdfError('ENGINE_VERSION_MISMATCH', 'Native build does not match this JavaScript version. Run npm run build.');
  return info;
}
export async function sha256(file) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}
export async function sourceInfo(file) {
  if (typeof file !== 'string' || !file) throw new PdfError('INVALID_ARGUMENT', 'An input PDF path is required');
  const absolute = await realpath(path.resolve(file));
  const info = await stat(absolute);
  if (!info.isFile()) throw new PdfError('INPUT_UNREADABLE', 'Input must be a file');
  if (info.size > 256 * 1024 * 1024) throw new PdfError('RESOURCE_LIMIT', 'This alpha accepts PDFs up to 256 MiB');
  return { file: absolute, sha256: await sha256(absolute), bytes: info.size };
}
async function unchanged(sources) {
  for (const source of sources) {
    if (await sha256(source.file) !== source.sha256) throw new PdfError('STALE_SOURCE', 'The input changed since it was opened', { file: source.file });
  }
}
async function publish(output, sources, action) {
  if (typeof output !== 'string' || !path.isAbsolute(output)) throw new PdfError('INVALID_ARGUMENT', 'output must be an absolute path');
  const resolved = path.resolve(output);
  await mkdir(path.dirname(resolved), { recursive: true });
  const destination = path.join(await realpath(path.dirname(resolved)), path.basename(resolved));
  if (sources.some(source => source.file.toLowerCase() === destination.toLowerCase())) throw new PdfError('SOURCE_OVERWRITE', 'Output cannot replace an input');
  try { await access(destination); throw new PdfError('OUTPUT_EXISTS', 'Output already exists; choose a new name'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  const temporary = await mkdtemp(path.join(path.dirname(destination), '.pdfedit-'));
  try {
    const candidate = path.join(temporary, path.extname(destination).toLowerCase() === '.png' ? 'candidate.png' : 'candidate.pdf');
    const details = await action(candidate);
    await unchanged(sources);
    const outputHash = await sha256(candidate);
    // Same-volume hard-link publication is atomic and refuses an existing destination on NTFS.
    try { await link(candidate, destination); }
    catch (error) { throw new PdfError(error.code === 'EEXIST' ? 'OUTPUT_EXISTS' : 'OUTPUT_PUBLISH_FAILED', 'Could not publish without replacing an existing file; an NTFS destination is required', { cause: error.code }); }
    return { ...details, output: destination, outputSha256: outputHash };
  } finally { await rm(temporary, { recursive: true, force: true }); }
}
function extension(file, expected) {
  if (typeof file !== 'string' || path.extname(file).toLowerCase() !== expected) throw new PdfError('INVALID_ARGUMENT', `output must use the ${expected} extension`);
}
function snapshotPlan(plan) {
  try { return structuredClone(plan); }
  catch { throw new PdfError('INVALID_ARGUMENT', 'Plan must contain cloneable JSON data'); }
}

export class PdfEditor {
  #engine;
  #source;
  #queue = Promise.resolve();
  #closed = false;
  #receipts = new Map();
  #info;
  static async create() {
    const editor = new PdfEditor();
    editor.#engine = new Engine();
    try {
      editor.#info = checkedEngineInfo(await editor.#engine.request('hello'));
      return editor;
    } catch (error) { await editor.#engine.close(); throw error; }
  }
  get engineInfo() { return { ...this.#info }; }
  get source() { return this.#source ? { ...this.#source } : null; }
  #run(fn) {
    const job = this.#queue.then(() => {
      if (this.#closed) throw new PdfError('SESSION_CLOSED', 'This session has been closed');
      return fn();
    });
    this.#queue = job.catch(() => {});
    return job;
  }
  #requireSource() {
    if (!this.#source) throw new PdfError('NO_DOCUMENT', 'Open a PDF first');
    return this.#source;
  }
  open(file, options = {}) {
    return this.#run(async () => {
      const source = await sourceInfo(file);
      const result = await this.#engine.request('open', source, options);
      this.#source = { ...source, pageCount: result.pageCount, documentId: `sha256:${source.sha256}`, revision: 0 };
      return { ...result, ...this.#source };
    });
  }
  inspect(params = {}, options = {}) {
    return this.#run(async () => {
      const source = this.#requireSource();
      return { ...await this.#engine.request('inspect', params, options), source: { ...source }, capabilities: this.#info.capabilities };
    });
  }
  stats(params = {}, options = {}) {
    return this.#run(async () => {
      if (!params || typeof params !== 'object' || Array.isArray(params)) throw new PdfError('INVALID_ARGUMENT', 'stats parameters must be an object');
      const unknown = Object.keys(params).find(key => key !== 'page');
      if (unknown) throw new PdfError('INVALID_ARGUMENT', `Unknown stats parameter: ${unknown}`);
      const source = this.#requireSource();
      return { ...await this.#engine.request('stats', params, options), source: { ...source }, capabilities: this.#info.capabilities };
    });
  }
  query(params = {}, options = {}) { return this.inspect(params, options); }
  render({ output, ...params }, options = {}) {
    return this.#run(async () => {
      extension(output, '.png');
      const source = this.#requireSource();
      await unchanged([source]);
      return publish(output, [source], async candidate => {
        try { return await this.#engine.request('render', { ...params, output: candidate }, options); }
        catch (error) { if (error.details?.workerStopping) await this.#engine.waitForExit(); throw error; }
      });
    });
  }
  async apply(plan, options = {}) {
    // Capture before entering the queue: signing and dispatch must use the same
    // data even when the caller reuses its plan object for the next operation.
    plan = snapshotPlan(plan);
    options = { ...options };
    return this.#run(async () => {
      extension(plan.output, '.pdf');
      const source = this.#requireSource();
      if (plan.sourceSha256 !== source.sha256) throw new PdfError('STALE_SOURCE', 'plan.sourceSha256 must match the inspected source');
      const requestId = plan.requestId ?? randomUUID();
      const signature = createHash('sha256').update(JSON.stringify(plan)).digest('hex');
      const previous = this.#receipts.get(requestId);
      if (previous) {
        if (previous.signature !== signature) throw new PdfError('REQUEST_ID_CONFLICT', 'requestId was used for a different plan');
        await unchanged([source]);
        if (await sha256(previous.receipt.output) !== previous.receipt.outputSha256) throw new PdfError('OUTPUT_CHANGED', 'Previously committed output was changed');
        return { ...structuredClone(previous.receipt), replayed: true };
      }
      await unchanged([source]);
      const start = performance.now();
      const receipt = await publish(plan.output, [source], async candidate => {
        const request = { operations: plan.operations, output: candidate };
        if (Object.hasOwn(plan, 'textBounds')) request.textBounds = plan.textBounds;
        try { return await this.#engine.request('apply', request, options); }
        catch (error) { if (error.details?.workerStopping) await this.#engine.waitForExit(); throw error; }
      });
      Object.assign(receipt, { requestId, sourceSha256: source.sha256, version, totalMs: performance.now() - start, replayed: false });
      this.#receipts.set(requestId, { signature, receipt: structuredClone(receipt) });
      return receipt;
    });
  }
  async compose(plan, options = {}) {
    plan = snapshotPlan(plan);
    options = { ...options };
    return this.#run(async () => {
      extension(plan.output, '.pdf');
      if (!Array.isArray(plan.panels) || !plan.panels.length) throw new PdfError('INVALID_ARGUMENT', 'panels must be a nonempty array');
      const sources = new Map(); const panels = [];
      for (const panel of plan.panels) {
        if (panel.fit !== undefined && panel.fit !== 'contain') throw new PdfError('INVALID_ARGUMENT', 'Only fit: contain is supported');
        const key = path.resolve(panel.file);
        if (!sources.has(key)) sources.set(key, await sourceInfo(key));
        const source = sources.get(key);
        if (panel.sourceSha256 && panel.sourceSha256 !== source.sha256) throw new PdfError('STALE_SOURCE', 'A panel source changed since inspection');
        panels.push({ ...panel, ...source });
      }
      const start = performance.now();
      const receipt = await publish(plan.output, [...sources.values()], async candidate => {
        try { return await this.#engine.request('compose', { ...plan, panels, output: candidate }, options); }
        catch (error) { if (error.details?.workerStopping) await this.#engine.waitForExit(); throw error; }
      });
      return { ...receipt, sources: [...sources.values()], version, totalMs: performance.now() - start };
    });
  }
  async close() { this.#closed = true; await this.#engine.close(); await this.#queue; }
  async [Symbol.asyncDispose]() { await this.close(); }
}
export async function openDocument(file, options = {}) {
  const editor = await PdfEditor.create();
  try { await editor.open(file, options); return editor; } catch (error) { await editor.close(); throw error; }
}
export async function composeFigure(plan, options = {}) {
  const editor = await PdfEditor.create();
  try { return await editor.compose(plan, options); } finally { await editor.close(); }
}
export async function doctor(options = {}) {
  if (!options || typeof options !== 'object' || Array.isArray(options) ||
      Object.keys(options).some(key => key !== 'deep') ||
      (options.deep !== undefined && typeof options.deep !== 'boolean')) {
    throw new PdfError('INVALID_ARGUMENT', 'doctor accepts only an optional boolean deep');
  }
  let built = false;
  try { await access(enginePath); built = true; } catch {}
  const result = { version, platform: process.platform, arch: process.arch, node: process.version, supported: process.platform === 'win32' && process.arch === 'x64' && Number(process.versions.node.split('.')[0]) === 24, enginePath, built, workerStarted: false };
  if (!options.deep) return result;
  result.ready = false;
  let engine;
  try {
    if (!result.supported) throw new PdfError('UNSUPPORTED_RUNTIME', 'Windows x64 and Node.js 24 are required');
    if (!built) throw new PdfError('ENGINE_NOT_FOUND', 'Native engine is missing. Run npm run setup and npm run build.');
    engine = new Engine();
    const info = await engine.request('hello', {}, { timeoutMs: 5000 });
    result.workerStarted = true;
    result.engine = checkedEngineInfo(info);
    result.ready = true;
  } catch (error) {
    result.error = { code: error.code ?? 'ERROR', message: error.message, details: error.details };
  } finally { if (engine) await engine.close(); }
  return result;
}
