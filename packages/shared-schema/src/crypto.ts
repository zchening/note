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

/**
 * 口令派生密钥。注意：salt 必须随每次加密重新生成并写进 envelope，
 * 固定 salt 会让"同一口令 + 同一明文"产生同一密钥，丧失 GCM 的语义安全。
 */
export async function deriveKey(passphrase: string, saltB64?: string): Promise<DerivedKey> {
  if (typeof passphrase !== 'string' || passphrase.length === 0) {
    throw new CryptoError('口令为空');
  }
  const salt = saltB64 !== undefined ? b64ToBytes(saltB64) : randomBytes(SALT_LEN);
  if (salt.length < 8) throw new CryptoError('salt 长度异常');
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
  return { key, saltB64: bytesToB64(salt), iter: KDF_ITER };
}

/* ---------------- 加解密 ---------------- */

/**
 * AAD 用途标签：把"这份密文是什么"绑进 GCM 认证。
 * 老项目所有数据用同一把密钥、无 AAD，密文可跨用途重放。
 */
export type AadTag = 'note' | 'meta' | 'rem' | 'egg';

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
