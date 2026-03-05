/**
 * Fixed-size worker thread pool. Workers load face-api models once at startup
 * and stay alive for the lifetime of the process, accepting jobs via postMessage.
 *
 * Pool size: min(cpuCount, 4) — caps memory at ~4 × 50 MB for loaded models.
 */

const { Worker } = require('worker_threads');
const path = require('path');
const os = require('os');

const WORKER_SCRIPT = path.join(__dirname, 'photoWorker.js');
const POOL_SIZE = Math.min(os.cpus().length, 4);

class WorkerPool {
  constructor() {
    this._workers = [];
    this._queue = [];
    this._readyPromise = this._init();
  }

  async _init() {
    const readyPromises = this._workers.map(() => {});
    const ps = [];

    for (let i = 0; i < POOL_SIZE; i++) {
      const { worker, ready } = this._spawnWorker(i);
      this._workers.push(worker);
      ps.push(ready);
    }

    await Promise.all(ps);
    console.log(`[pool] ${POOL_SIZE} workers ready`);
  }

  _spawnWorker(id) {
    const worker = new Worker(WORKER_SCRIPT);
    worker._idle = false;
    worker._resolve = null;
    worker._reject = null;

    let readyResolve;
    const ready = new Promise(r => (readyResolve = r));

    worker.on('message', msg => {
      if (msg.ready) {
        worker._idle = true;
        readyResolve();
        this._drain();
        return;
      }
      // Task result
      const resolve = worker._resolve;
      const reject = worker._reject;
      worker._resolve = null;
      worker._reject = null;
      worker._idle = true;
      this._drain();

      if (msg.success) {
        resolve(msg);
      } else {
        reject(new Error(msg.error));
      }
    });

    worker.on('error', err => {
      const reject = worker._reject;
      worker._resolve = null;
      worker._reject = null;
      worker._idle = true;
      this._drain();
      if (reject) reject(err);
      else console.error(`[pool] worker ${id} error:`, err.message);
    });

    return { worker, ready };
  }

  _drain() {
    if (this._queue.length === 0) return;
    const idle = this._workers.find(w => w._idle);
    if (!idle) return;

    const { data, resolve, reject } = this._queue.shift();
    idle._idle = false;
    idle._resolve = resolve;
    idle._reject = reject;
    idle.postMessage(data);
  }

  /**
   * Dispatch a job to an idle worker (or queue it until one is free).
   * Returns a promise that resolves with the worker's response message.
   */
  async run(data) {
    await this._readyPromise;
    return new Promise((resolve, reject) => {
      this._queue.push({ data, resolve, reject });
      this._drain();
    });
  }

  /** Call on graceful shutdown. */
  terminate() {
    return Promise.all(this._workers.map(w => w.terminate()));
  }
}

// Export a single shared pool instance
module.exports = new WorkerPool();
