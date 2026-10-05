/**
 * 本地信封缓存 —— 断网可读的基础
 *
 * 🔴🔴 为什么要单独一个模块：缓存有**两个**写入方（解锁时从远端拉下来的、
 *   推送成功后自己写上去的），只有一个读取方（解锁）。把写缓存的逻辑塞进
 *   unlock.ts 的后果是 push 侧看不到它，于是"推送成功但不更新本地缓存"——
 *   云端是新内容，本机缓存还是旧的，用户一断网就看到旧正文，
 *   **且没有任何报错**。这是典型的静默降级。
 *
 * 纪律：
 *  1. salt 与 iter **必须**一起存。只存 salt 不存 iter，将来调高 KDF 迭代后
 *     老缓存一律解不开（症状被误报成"缓存坏了"）。
 *  2. 任何异常（隐私模式/配额满/JSON 坏）都当"没有缓存"，绝不抛。
 *     缓存是增强项，为它崩掉整个解锁是本末倒置。
 *  3. 缓存的 AAD 域固定是 'note' —— 与真源同域，才能被同一个密钥解开。
 */

import { decryptString, KDF_ITERATIONS, type Envelope } from '@bj/shared-schema';

export const cacheKeyOf = (noteId: string): string => `notesync_bj_cache_${noteId}`;

export interface CachedEnvelope {
  v: 1;
  iv: string;
  ct: string;
  salt: string;
  /**
   * 当时的 KDF 迭代次数。
   * 🔴 显式含 `| undefined` 而不是靠可选属性：本仓开了 `exactOptionalPropertyTypes`，
   *   `iter?: number` 不接受"显式赋值 undefined"，而老缓存（没有这一项）恰好要这么表达。
   *   两种写法在这里差别很大：写 `?:` 会在readCache 里被迫做条件展开。
   */
  iter: number | undefined;
  savedAt: number;
}

/** 读缓存。任何异常都当"没有缓存"。 */
export function readCache(noteId: string): CachedEnvelope | undefined {
  try {
    const raw = localStorage.getItem(cacheKeyOf(noteId));
    if (raw === null || raw === '') return undefined;
    const o = JSON.parse(raw) as Partial<CachedEnvelope>;
    if (typeof o.iv !== 'string' || typeof o.ct !== 'string' || typeof o.salt !== 'string') {
      return undefined;
    }
    return {
      v: 1,
      iv: o.iv,
      ct: o.ct,
      salt: o.salt,
      iter: typeof o.iter === 'number' ? o.iter : undefined,
      savedAt: typeof o.savedAt === 'number' ? o.savedAt : 0,
    };
  } catch {
    return undefined;
  }
}

/** 写缓存。存不下不抛。 */
export function writeCache(noteId: string, env: Envelope): void {
  try {
    const rec: CachedEnvelope = {
      v: 1,
      iv: env.iv,
      ct: env.ct,
      salt: env.kdf.salt,
      iter: env.kdf.iter,
      savedAt: Date.now(),
    };
    localStorage.setItem(cacheKeyOf(noteId), JSON.stringify(rec));
  } catch {
    /* 忽略：离线能力是增强项，不是前提 */
  }
}

export function clearCache(noteId: string): void {
  try {
    localStorage.removeItem(cacheKeyOf(noteId));
  } catch {
    /* ignore */
  }
}

/** 缓存 → 信封形状。缺 iter 时取当前默认（兼容老缓存）。 */
export function cacheToEnvelope(c: CachedEnvelope, iter: number): Envelope {
  return {
    v: 1,
    alg: 'AES-256-GCM',
    kdf: { name: 'PBKDF2-HMAC-SHA256', iter, salt: c.salt },
    iv: c.iv,
    ct: c.ct,
  };
}

/** 用缓存的迭代数还原信封（老缓存用低迭代时也能解）。 */
export function envelopeOf(c: CachedEnvelope): Envelope {
  return cacheToEnvelope(c, c.iter ?? KDF_ITERATIONS);
}

/**
 * 尝试用缓存解出明文。
 * 🔴 解不开时**顺手清掉这份坏缓存**：留着它会让后续每次解锁都失败，
 *   而用户完全看不出问题（表现就是"这台机器莫名其妙一直要重输口令"）。
 */
export async function openCache(noteId: string, key: CryptoKey): Promise<string | undefined> {
  const c = readCache(noteId);
  if (!c) return undefined;
  try {
    return await decryptString(envelopeOf(c), key, 'note');
  } catch {
    clearCache(noteId);
    return undefined;
  }
}
