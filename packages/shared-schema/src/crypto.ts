/**
 * 加密层 —— PBKDF2-HMAC-SHA256 600,000 次 + AES-256-GCM，自描述 envelope
 *
 * 与老项目的六个关键差异（ARCH.md §4.2）：
 *  1. 迭代 200,000 → 600,000（OWASP 2023 现行线；老项目的值已低于门槛）
 *  2. 密钥不再 base64 明文落 localStorage（老项目 6 处），改存 IndexedDB 的
 *     extractable:false CryptoKey —— raw key 永不出 WebCrypto，XSS 也偷不到长期密钥
 *  3. envelope 自描述 {v,alg,kdf:{name,iter,salt},iv,ct}：以后换算法/KDF 次数
 *     老数据照样能解，不做破坏性升级
 *  4. 每次加密随机新 salt+iv（老项目 iv 复用 = 同密钥下密文可对比，这是真漏洞）
 *  5. 附加认证数据 AAD 绑定用途标签，防止把"A 的密文"当"B 的密文"解
 *  6. 零依赖：全用浏览器原生 WebCrypto，不引 libsodium wasm
 *     （wasm 会让 App 冷启动多 1-2s，而实测已 15-20s，不能再叠）
 *
 * 运行环境：浏览器 / Node >= 18（Node 有 globalThis.crypto.webcrypto）。
 * 绝不在 Node 里 require('crypto') —— 那会让两端算法分叉。
 */

const KDF_ITER = 600_000;
const KDF_NAME = 'PBKDF2-HMAC-SHA256';
const KEY_LEN_BITS = 256;
const SALT_LEN = 16;
const IV_LEN = 12; // GCM 标准 96bit，唯一无推荐的组合

export interface KdfParams {
  name: string;
  iter: number;
  salt: string; // base64
}

export interface Envelope {
  /** envelope 版本，用于将来加字段 */
  v: 1;
  alg: 'AES-256-GCM';
  kdf: KdfParams;
  /** base64 */
  iv: string;
  /** base64 */
  ct: string;
}

export class CryptoError extends Error {
  constructor(msg: string) {
    super(msg);
    this.name = 'CryptoError';
  }
}

function subtle(): SubtleCrypto {
  const c = globalThis.crypto;
  if (!c || !c.subtle) {
    throw new CryptoError('当前环境无 WebCrypto（需 HTTPS 或 localhost）');
  }
  return c.subtle;
}

/* ---------------- base64 <-> bytes ---------------- */

export function bytesToB64(b: Uint8Array): string {
  let s = '';
  const CH = 0x8000;
  for (let i = 0; i < b.length; i += CH) {
    s += String.fromCharCode(...b.subarray(i, i + CH));
  }
  return btoa(s);
}

export function b64ToBytes(s: string): Uint8Array {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function randomBytes(n: number): Uint8Array {
  const out = new Uint8Array(n);
  globalThis.crypto.getRandomValues(out);
  return out;
}

const enc = new TextEncoder();
const dec = new TextDecoder();

/* ---------------- 口令 -> 密钥 ---------------- */

export interface DerivedKey {
  key: CryptoKey;
  saltB64: string;
  iter: number;
}

/* ---------------- P0-4：派生卸载（Web Worker）+ 同盐记忆化 ---------------- */

/**
 * PBKDF2 卸载器的形状：给定口令/salt/迭代，返回 **32 字节原始密钥位**。
 *
 * 🔴🔴 返回原始位而不是 `CryptoKey`：最终的 AES-GCM `CryptoKey` 仍然在主线程
 *   `importKey` 出来并维持 `extractable:false`，与既有安全语义**逐字一致**
 *   （raw key 依旧永不出 WebCrypto）。传位不传钥匙也避免了跨线程传递
 *   CryptoKey 在不同 WebView 上的实现差异。
 */
export type Pbkdf2Offload = (
  passphrase: string,
  saltB64: string,
  iter: number,
) => Promise<Uint8Array>;

/**
 * 由宿主（client）注入的卸载器；未注入 ⇒ 走主线程同一套 WebCrypto。
 * 🔴 卸载器**抛错一律回落**主线程路径（见 deriveKey）：Worker 不可用 /
 *   CSP 拦 blob: / 老 WebView 不支持，都只是变慢，**绝不能变成解锁失败**。
 */
let pbkdf2Offload: Pbkdf2Offload | undefined = undefined;

/** 装卸载器；返回 true 表示已装上。传 undefined 表示摘除（测试用）。 */
export function setPbkdf2Offload(fn: Pbkdf2Offload | undefined): boolean {
  pbkdf2Offload = fn;
  return fn !== undefined;
}

/**
 * 同 (口令, salt, 迭代) 的派生记忆化。
 *
 * 🔴🔴 为什么必须有：换机恢复 / 收藏批量导入会对**同一篇**反复派生
 *   （自证一次、开信封一次、失败再回落一次 —— 实测同一 salt 会被算 2~3 遍）。
 *   600k 次 PBKDF2 单次 ~130ms，白算两遍就是 0.26s 的纯浪费，而且是**串行**
 *   堆在主线程上。缓存把第二次及以后降到 ~0。
 *
 * 🔴 存的是 Promise 而不是结果：并发调用同一 key 时共享同一次计算
 *   （否则 N 个并发仍会算 N 遍，缓存形同虚设）。
 * 🔴 有上限（防无界增长）：换机扫 100 篇会产生 100 个条目，不设上限就是泄漏。
 */
const DERIVE_CACHE_MAX = 64;
const deriveCache = new Map<string, Promise<DerivedKey>>();

/** 缓存键。口令原文进键是不可避免的（要区分不同口令）——与 `sessionPass`
 *  常驻内存同一风险级别，且提供 `clearDerivedKeyCache()` 供锁屏/换笔记调用。 */
const cacheKeyOf = (p: string, s: string, i: number): string => `${i}:${s}:${p}`;

/** 清空派生缓存（锁屏 / 换笔记 / 退出时调）。 */
export function clearDerivedKeyCache(): void {
  deriveCache.clear();
}

/** 当前缓存条目数（测试用）。 */
export function derivedKeyCacheSize(): number {
  return deriveCache.size;
}

/**
 * 口令派生密钥。注意：salt 必须随每次加密重新生成并写进 envelope，
 * 固定 salt 会让"同一口令 + 同一明文"产生同一密钥，丧失 GCM 的语义安全。
 */
export async function deriveKey(passphrase: string, saltB64?: string): Promise<DerivedKey> {
  if (typeof passphrase !== 'string' || passphrase.length === 0) {
    throw new CryptoError('口令为空');
  }
  // 🔴 salt 未给 ⇒ 现生成，**绝不进缓存**（每次都是新钥匙，缓存只会白白占坑）。
  const fresh = saltB64 === undefined;
  const salt = fresh ? randomBytes(SALT_LEN) : b64ToBytes(saltB64);
  if (salt.length < 8) throw new CryptoError('salt 长度异常');
  const saltKey = bytesToB64(salt);
  if (!fresh) {
    const hit = deriveCache.get(cacheKeyOf(passphrase, saltKey, KDF_ITER));
    if (hit) return hit;
  }
  const task = deriveKeyUncached(passphrase, salt, saltKey);
  if (!fresh) {
    deriveCache.set(cacheKeyOf(passphrase, saltKey, KDF_ITER), task);
    // 🔴 失败了别把 rejected promise 留在缓存里（否则同一错误会被永久缓存，
    //   换口令重试也永远失败）。
    task.catch(() => {
      deriveCache.delete(cacheKeyOf(passphrase, saltKey, KDF_ITER));
    });
    // 超限丢最旧（Map 的插入顺序即访问顺序的近似，够用且零成本）。
    while (deriveCache.size > DERIVE_CACHE_MAX) {
      const oldest = deriveCache.keys().next();
      if (oldest.done) break;
      deriveCache.delete(oldest.value);
    }
  }
  return task;
}

async function deriveKeyUncached(
  passphrase: string,
  salt: Uint8Array,
  saltKey: string,
): Promise<DerivedKey> {
  // 🔴🔴 P0-4：能卸载就卸载 —— 600k 次 PBKDF2 在主线程是 ~130ms 的硬冻结
  //   （换机恢复 100 篇 = 13~26 秒主线程全冻，低端安卓直接 ANR）。
  //   Worker 里算完只把 32 字节送回来，主线程 importKey 得到同一把钥匙。
  // 🔴 卸载失败**一律回落**：CSP 拦 blob: / WebView 不支持 / Worker 崩，
  //   都只是"回到原来的慢"，绝不能变成"解锁失败"。
  const off = pbkdf2Offload;
  if (off) {
    try {
      const bits = await off(passphrase, saltKey, KDF_ITER);
      if (bits && bits.length * 8 === KEY_LEN_BITS) {
        const key = await subtle().importKey('raw', bits as unknown as BufferSource, 'AES-GCM', false, [
          'encrypt',
          'decrypt',
        ]);
        return { key, saltB64: saltKey, iter: KDF_ITER };
      }
    } catch {
      /* 回落主线程 */
    }
  }
  const base = await subtle().importKey('raw', enc.encode(passphrase), 'PBKDF2', false, [
    'deriveKey',
  ]);
  const key = await subtle().deriveKey(
    {
      name: 'PBKDF2',
      // 浏览器可省略 hash，Node 的 WebCrypto 强制要求 —— 显式写上两端都吃
      hash: 'SHA-256',
      salt: salt as unknown as BufferSource,
      iterations: KDF_ITER,
    },
    base,
    { name: 'AES-GCM', length: KEY_LEN_BITS },
    false, // extractable=false —— 派生出的就是最终密钥，不许再导出
    ['encrypt', 'decrypt'],
  );
  return { key, saltB64: saltKey, iter: KDF_ITER };
}

/* ---------------- 加解密 ---------------- */

/**
 * AAD 用途标签：把"这份密文是什么"绑进 GCM 认证。
 * 老项目所有数据用同一把密钥、无 AAD，密文可跨用途重放。
 */
/**
 * 'pass' = 本机「口令保险箱」用的标签（client/sync/pass-vault.ts）。
 * 单独一个标签而不是复用 'note'：口令与正文是**两种不同用途**的明文，
 * 共用 AAD 就等于允许跨用途重放（把一段正密文当口令保险箱喂进去也能通过认证）。
 */
export type AadTag = 'note' | 'meta' | 'rem' | 'egg' | 'pass';

export async function encryptString(
  plaintext: string,
  key: CryptoKey,
  aad: AadTag,
  dk: DerivedKey,
): Promise<Envelope> {
  const iv = randomBytes(IV_LEN);
  const buf = await subtle().encrypt(
    {
      name: 'AES-GCM',
      iv: iv as unknown as BufferSource,
      additionalData: enc.encode(aad) as unknown as BufferSource,
      tagLength: 128,
    },
    key,
    enc.encode(plaintext) as unknown as BufferSource,
  );
  return {
    v: 1,
    alg: 'AES-256-GCM',
    kdf: { name: KDF_NAME, iter: dk.iter, salt: dk.saltB64 },
    iv: bytesToB64(iv),
    ct: bytesToB64(new Uint8Array(buf)),
  };
}

export async function decryptString(env: Envelope, key: CryptoKey, aad: AadTag): Promise<string> {
  if (env.v !== 1) throw new CryptoError(`envelope 版本不支持：${String(env.v)}`);
  if (env.alg !== 'AES-256-GCM') throw new CryptoError(`算法不支持：${String(env.alg)}`);
  const kdf = env.kdf;
  if (kdf.name !== KDF_NAME) throw new CryptoError(`KDF 不支持：${kdf.name}`);
  if (!Number.isInteger(kdf.iter) || kdf.iter < 100_000) {
    throw new CryptoError(`KDF 迭代次数异常：${String(kdf.iter)}`);
  }
  let buf: ArrayBuffer;
  try {
    buf = await subtle().decrypt(
      {
        name: 'AES-GCM',
        iv: b64ToBytes(env.iv) as unknown as BufferSource,
        additionalData: enc.encode(aad) as unknown as BufferSource,
        tagLength: 128,
      },
      key,
      b64ToBytes(env.ct) as unknown as BufferSource,
    );
  } catch {
    // GCM 校验失败：口令错 / 密文被改 / AAD 不匹配，三者不可区分，也不该区分
    throw new CryptoError('解密失败：口令不正确或数据已损坏');
  }
  return dec.decode(buf);
}

/* ---------------- 口令校验（登录判定） ---------------- */

/**
 * 校验口令是否正确：解开一个固定的哨兵串。
 * 不存"口令哈希"（离线爆破面），而是靠 GCM 认证天然完成校验。
 */
export const SENTINEL_PLAINTEXT = 'notesync.bj.v1';

export async function makeSentinel(passphrase: string): Promise<Envelope> {
  const dk = await deriveKey(passphrase);
  return encryptString(SENTINEL_PLAINTEXT, dk.key, 'meta', dk);
}

export async function checkPassphrase(passphrase: string, env: Envelope): Promise<boolean> {
  // 空口令返 false 而不是抛错：登录框每次点按钮都会调它，抛错会让 UI 弹异常栈。
  // 这里与 openWithPassphrase 的"空口令早拒绝"是有意的差异，别统一。
  if (typeof passphrase !== 'string' || passphrase.length === 0) return false;
  try {
    const dk = await deriveKey(passphrase, env.kdf.salt);
    const pt = await decryptString(env, dk.key, 'meta');
    return pt === SENTINEL_PLAINTEXT;
  } catch {
    return false;
  }
}

/* ---------------- 便捷：口令直通加解密（少用，多一个中间层） ---------------- */

export async function sealWithPassphrase(
  plaintext: string,
  passphrase: string,
  aad: AadTag,
): Promise<Envelope> {
  const dk = await deriveKey(passphrase);
  return encryptString(plaintext, dk.key, aad, dk);
}

export async function openWithPassphrase(
  env: Envelope,
  passphrase: string,
  aad: AadTag,
): Promise<string> {
  const dk = await deriveKey(passphrase, env.kdf.salt);
  return decryptString(env, dk.key, aad);
}

/** KDF 迭代次数导出给设置页展示（让用户知道强度） */
export const KDF_ITERATIONS = KDF_ITER;
