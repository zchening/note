/**
 * P0-4：把 600k 次 PBKDF2 挪出主线程（Web Worker）
 *
 * 🔴🔴 为什么必须挪：实测单次派生 ~130ms（代码注释曾自称 62ms，实际翻倍）。
 *   换机恢复是 `for` 串行逐篇自证 —— 100 篇就是 **13~26 秒主线程完全冻结**：
 *   出/入 pump 卡死、输入法掉帧、低端安卓直接 ANR，而且**没有任何进度反馈**。
 *   PBKDF2 是纯 CPU 计算，没有任何理由占着 UI 线程。
 *
 * 🔴🔴 设计边界（三条，不许突破）：
 *  1. **只搬计算，不搬密钥语义**：Worker 只回 32 字节原始位，最终的 AES-GCM
 *     `CryptoKey` 仍在主线程 `importKey` 且维持 `extractable:false`
 *     —— 与既有"raw key 永不出 WebCrypto"逐字一致。
 *  2. **失败一律回落**：Worker 不可用 / CSP 拦 `blob:` / 老 WebView 不支持 /
 *     单次超时，全部只是"回到原来的慢"，**绝不能变成解锁失败**。
 *     卸载器抛错 ⇒ `deriveKey` 内部 catch 后走主线程同一套 WebCrypto。
 *  3. **绝不引入新依赖**：Worker 源码以字符串内联，不新增产物文件
 *     （产物是 esbuild 单文件 app.js，多一个 worker 文件就要改部署清单与 CSP）。
 *
 * 🔴 Worker 内不 import 任何东西：它是**字符串**，不受打包器处理，
 *   只能用标准 Web API（crypto.subtle / atob / TextEncoder 在 worker 全局都有）。
 */

import { setPbkdf2Offload } from '@bj/shared-schema';

/** Worker 源码（字符串，打包器不解析）。 */
const WORKER_SRC = `
self.onmessage = async (e) => {
  var d = e.data || {};
  var id = d.id;
  try {
    var km = await crypto.subtle.importKey(
      'raw', new TextEncoder().encode(d.p), 'PBKDF2', false, ['deriveBits']
    );
    var bin = atob(d.s);
    var salt = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) salt[i] = bin.charCodeAt(i);
    var raw = await crypto.subtle.deriveBits(
      { name: 'PBKDF2', hash: 'SHA-256', salt: salt, iterations: d.i }, km, 256
    );
    var bits = new Uint8Array(raw);
    self.postMessage({ id: id, ok: true, bits: bits }, [bits.buffer]);
  } catch (err) {
    self.postMessage({ id: id, ok: false, error: String((err && err.message) || err) });
  }
};
`;

/** 单次派生的兜底超时：Worker 卡死时宁可慢，也不能把解锁挂死。 */
const KDF_TIMEOUT_MS = 15_000;

interface Pending {
  resolve: (bits: Uint8Array) => void;
  reject: (e: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

let worker: Worker | undefined = undefined;
let workerBroken = false;
let seq = 0;
const pending = new Map<number, Pending>();

/** 全挂：把还在等的都 reject（它们会各自回落主线程）。 */
function failAll(msg: string): void {
  for (const [, p] of pending) {
    clearTimeout(p.timer);
    p.reject(new Error(msg));
  }
  pending.clear();
}

function ensureWorker(): Worker | undefined {
  if (workerBroken) return undefined;
  if (worker) return worker;
  if (typeof Worker === 'undefined' || typeof Blob === 'undefined') {
    workerBroken = true;
    return undefined;
  }
  try {
    const url = URL.createObjectURL(new Blob([WORKER_SRC], { type: 'text/javascript' }));
    const w = new Worker(url);
    URL.revokeObjectURL(url);
    w.onmessage = (e: MessageEvent) => {
      const d = e.data as { id: number; ok: boolean; bits?: Uint8Array; error?: string };
      const p = pending.get(d.id);
      if (!p) return;
      pending.delete(d.id);
      clearTimeout(p.timer);
      if (d.ok && d.bits) p.resolve(d.bits);
      else p.reject(new Error(d.error || 'kdf worker 失败'));
    };
    w.onerror = () => {
      // 🔴 Worker 运行期崩了：标记不可用并让后续调用直接回落，
      //   本次挂着的也要 reject（否则调用方永远等不到）。
      workerBroken = true;
      failAll('kdf worker 崩溃');
      try {
        w.terminate();
      } catch {
        /* 忽略 */
      }
      worker = undefined;
    };
    worker = w;
    return w;
  } catch {
    workerBroken = true;
    return undefined;
  }
}

/**
 * 卸载一次 PBKDF2。返回 32 字节原始密钥位。
 * 任何异常都抛给调用方（`deriveKey` 会 catch 并回落主线程）。
 */
export async function kdfWorkerOffload(
  passphrase: string,
  saltB64: string,
  iter: number,
): Promise<Uint8Array> {
  const w = ensureWorker();
  if (!w) throw new Error('kdf worker 不可用');
  seq += 1;
  const id = seq;
  return new Promise<Uint8Array>((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      // 🔴 超时不判"Worker 坏了"（可能只是这一篇特别慢），只让本次回落。
      reject(new Error('kdf worker 超时'));
    }, KDF_TIMEOUT_MS);
    pending.set(id, { resolve, reject, timer });
    try {
      w.postMessage({ id, p: passphrase, s: saltB64, i: iter });
    } catch (e) {
      pending.delete(id);
      clearTimeout(timer);
      reject(e instanceof Error ? e : new Error(String(e)));
    }
  });
}

/** Worker 当前是否已装上（诊断面板用）。 */
export function kdfWorkerReady(): boolean {
  return worker !== undefined && !workerBroken;
}

/**
 * 装上 Worker 卸载器。
 * @returns 是否真的装上；false ⇒ 环境不支持，调用方无需处理（`deriveKey` 照旧走主线程）。
 */
export function installKdfWorker(): boolean {
  const w = ensureWorker();
  if (!w) return false;
  return setPbkdf2Offload(kdfWorkerOffload);
}

/** 摘除卸载器（测试 / 锁屏清理用）。 */
export function uninstallKdfWorker(): void {
  setPbkdf2Offload(undefined);
  try {
    worker?.terminate();
  } catch {
    /* 忽略 */
  }
  worker = undefined;
  workerBroken = false;
}
