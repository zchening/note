/**
 * 写入凭据（writeKey）—— 「能解密 ⇔ 能写入」
 *
 * 移植老项目 index.html:2213-2261 的语义（服务端 guards.js 是它的另一半）。
 * 派生方式适配红线 #4（raw key 永不出 WebCrypto，老项目是 HMAC(rawKey)）：
 *
 *   writeKey = PBKDF2-SHA256(口令, "notesync-write-v1:" + noteId + ":" + kdfSalt, 600k) → base64url(32B)
 *
 * ── 为什么迭代次数必须与主派生同级（600k，不是 1）────────────────────
 *   x-note-key 头在纯 HTTP 链路（局域网直连 :8090）上可被嗅探。
 *   低迭代 = 嗅到凭据的人能离线秒爆口令 → 全部笔记失守；
 *   600k 迭代把「从凭据反推口令」拉回与「从云端信封 salt 爆破」同一成本
 *   （实测 62ms/次），不给攻击者任何更便宜的路。
 *   服务端只存 sha256(writeKey)，零知识不变（guards.js 文件头同款口径）。
 *
 * ── 凭据来源是口令而不是密钥 ────────────────────────────────────────
 *   密钥 extractable:false 导不出；口令经 pass-vault 封在本笔记密钥里，
 *   记忆解锁也取得出 ⇒ 任何解锁路径都派生得出凭据，与老项目
 *   「记忆过的设备永远拿得出凭据」等价。
 *
 * ── 为什么缓存（老项目刻意不缓存，本项目缓存）─────────────────────────
 *   老项目 HMAC 是微秒级；本项目一次派生 62ms，每次自动保存都现算是纯浪费。
 *   缓存键是 **DerivedKey 对象身份**（WeakMap）：改口令/重盐必然产生新 dk
 *   对象 ⇒ 旧缓存自然失效，不存在「缓存 + 多路径赋值」的脏窗口
 *   （老项目 v5.58 空盐案记的就是那种 bug 的形状）。
 */

// @ts-check 由包级 tsconfig 统一检查（本项目 TS strict 全开，见 ARCH §4.6）
import type { DerivedKey } from '@bj/shared-schema';
import { readPassVault } from './pass-vault.ts';

const WK_DOMAIN = 'notesync-write-v1';

function bytesToB64Url(bytes: Uint8Array): string {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/**
 * 从口令直接派生凭据（改口令/备份笔记等「口令就在手边」的场景用）。
 *
 * @param dk 只需 `saltB64` 与 `iter` 两个字段——新信封刚出炉、还没组装成
 *   DerivedKey 时也能直接拿 `env.kdf` 喂进来（备份笔记写档就是这种形状）。
 */
export async function deriveWriteKey(
  noteId: string,
  passphrase: string,
  dk: Pick<DerivedKey, 'saltB64' | 'iter'>,
): Promise<string | null> {
  if (typeof passphrase !== 'string' || passphrase === '') return null;
  try {
    const material = await crypto.subtle.importKey('raw', new TextEncoder().encode(passphrase), 'PBKDF2', false, ['deriveBits']);
    const salt = new TextEncoder().encode(`${WK_DOMAIN}:${noteId}:${dk.saltB64}`);
    const bits = await crypto.subtle.deriveBits(
      { name: 'PBKDF2', hash: 'SHA-256', salt, iterations: dk.iter },
      material,
      256,
    );
    return bytesToB64Url(new Uint8Array(bits));
  } catch {
    return null; // 派生失败=按"无凭据"降级，绝不抛（调用方口径见 getWriteKey）
  }
}

const cache = new WeakMap<DerivedKey, Map<string, string>>();

/**
 * 从口令保险箱取口令派生凭据（常规写路径用）。
 *
 * @returns 凭据；取不到（隐私模式/保险箱被清/派生失败）⇒ `null`。
 *   🔴 绝不抛：上层要的是"能不能带凭据"，不是一个异常。null 时写请求
 *   不带 x-note-key —— off/new-only 档照写成功，full 档由服务端拒，
 *   并在响应处给出**用户可见**的错误（老项目 v10.0.0「绝不落进静默 catch」口径）。
 */
export async function getWriteKey(noteId: string, key: CryptoKey, dk: DerivedKey): Promise<string | null> {
  let perDk = cache.get(dk);
  const hit = perDk?.get(noteId);
  if (hit) return hit;
  let wk: string | null;
  try {
    const pass = await readPassVault(noteId, key);
    if (!pass) return null;
    wk = await deriveWriteKey(noteId, pass, dk);
  } catch {
    return null;
  }
  if (wk) {
    if (!perDk) {
      perDk = new Map();
      cache.set(dk, perDk);
    }
    perDk.set(noteId, wk);
  }
  return wk;
}
