import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';

export const enginePath = fileURLToPath(new URL('../build/bin/pdf-engine.exe', import.meta.url));
export class PdfError extends Error {
  constructor(code, message, details) { super(message); this.name = 'PdfError'; this.code = code; this.details = details; }
}

export class Engine {
  #child;
  #pending = new Map();
  #exited;
  #dead = false;
  #closing = false;
  #stderr = '';
  constructor() {
    this.#child = spawn(enginePath, ['--parent-pid', String(process.pid)], {
      shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.#child.stderr.setEncoding('utf8');
    this.#child.stderr.on('data', chunk => { this.#stderr = (this.#stderr + chunk).slice(-8192); });
    this.#child.stdin.on('error', error => this.#fail(new PdfError('ENGINE_IO', error.message)));
    createInterface({ input: this.#child.stdout, crlfDelay: Infinity }).on('line', line => {
      let response;
      try { response = JSON.parse(line); } catch {
        this.#fail(new PdfError('ENGINE_PROTOCOL', 'Native worker returned invalid JSON'));
        this.#child.kill(); return;
      }
      const pending = this.#pending.get(response.id);
      if (!pending) return;
      this.#pending.delete(response.id);
      pending.dispose();
      if (response.ok) pending.resolve({ ...response.result, engineMs: response.engineMs });
      else pending.reject(new PdfError(response.error.code, response.error.message));
    });
    this.#exited = new Promise(resolve => {
      this.#child.once('error', error => {
        this.#dead = true;
        this.#fail(new PdfError('ENGINE_START_FAILED', `${error.message}. Run npm run setup and npm run build.`));
        resolve();
      });
      this.#child.once('close', (code, signal) => {
        this.#dead = true;
        this.#fail(new PdfError('ENGINE_EXITED', `Native worker exited (${signal ?? code})`, this.#stderr));
        resolve();
      });
    });
  }
  get pid() { return this.#child.pid; }
  #fail(error) {
    for (const pending of this.#pending.values()) { pending.dispose(); pending.reject(error); }
    this.#pending.clear();
  }
  request(method, params = {}, { timeoutMs = 30_000, signal } = {}) {
    if (this.#dead || this.#closing) return Promise.reject(new PdfError('SESSION_CLOSED', 'The worker session is closed'));
    if (signal?.aborted) return Promise.reject(new PdfError('CANCELLED', 'Request was cancelled before dispatch', { workerStopping: false }));
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return Promise.reject(new PdfError('INVALID_ARGUMENT', 'timeoutMs must be positive'));
    const id = randomUUID();
    const data = JSON.stringify({ id, method, params });
    if (Buffer.byteLength(data) > 4 * 1024 * 1024) return Promise.reject(new PdfError('RESOURCE_LIMIT', 'Request exceeds 4 MiB'));
    return new Promise((resolve, reject) => {
      const terminate = code => {
        this.#closing = true;
        this.#fail(new PdfError(code, code === 'TIMEOUT' ? 'Native operation timed out; session stopping' : 'Request cancelled; session stopping', { workerStopping: true }));
        this.#child.kill();
      };
      const timer = setTimeout(() => terminate('TIMEOUT'), timeoutMs);
      const onAbort = () => terminate('CANCELLED');
      const dispose = () => { clearTimeout(timer); signal?.removeEventListener('abort', onAbort); };
      this.#pending.set(id, { resolve, reject, dispose });
      signal?.addEventListener('abort', onAbort, { once: true });
      this.#child.stdin.write(`${data}\n`);
    });
  }
  async close() {
    this.#closing = true;
    if (!this.#dead) this.#child.stdin.end();
    const timer = setTimeout(() => this.#child.kill(), 3000);
    try { await this.#exited; } finally { clearTimeout(timer); }
  }
  async waitForExit() { await this.#exited; }
}
