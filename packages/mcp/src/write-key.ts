/**
 * 写入凭据（writeKey）—— 「能解密 ⇔ 能写入」
 *
 * 🔴🔴 与 `packages/client/src/sync/write-key.ts` **逐字节同算法**：
 *   writeKey = PBKDF2-SHA256(口令, utf8("notesync-write-v1:"+noteId+":"+saltB64), iter) → 32 字节 → base64url(去 pad)
 *   服务端 `guards.js` 只认 sha256(writeKey)，两种派生法对它完全同形。
 *
 * 为什么这里用 `node:crypto.pbkdf2Sync` 而不是 WebCrypto：
 *   MCP 跑在 Node，没有 `crypto.subtle` 的浏览器语义差异；pbkdf2Sync 的
 *   PBKDF2-HMAC-SHA256 与 WebCrypto deriveBits 输出**完全相同**（同一算法、
 *   同一 salt 字符串、同一迭代、同一输出长度），所以两端算出的 wk 一致，
 *   服务端存的 wkHash 才对得上（否则 full 档下永远 403）。
 *
 * 为什么用 note 的 kdf.salt 而不是每次生新 salt：见 `vault.ts` 的 save() 注释 ——
 * salt 漂移会让 wk 漂移，第二次保存起就 403。
 */
import { pbkdf2Sync } from 'node:crypto';

const WK_DOMAIN = 'notesync-write-v1';

/**
 * 从口令 + 笔记的 kdf.salt/iter 派生写入凭据。
 * @returns 凭据（base64url 去 pad）；口令/盐缺失 ⇒ null（调用方按"无凭据"降级）。绝不抛。
 */
export function deriveWriteKey(
  noteId: string,
  passphrase: string,
  saltB64: string,
  iter: number,
): string | null {
  if (typeof passphrase !== 'string' || passphrase === '') return null;
  if (typeof saltB64 !== 'string' || saltB64 === '') return null;
  if (!Number.isInteger(iter) || iter < 100_000) return null;
  try {
    const salt = Buffer.from(`${WK_DOMAIN}:${noteId}:${saltB64}`, 'utf8');
    const bits = pbkdf2Sync(passphrase, salt, iter, 32, 'sha256');
    return bits
      .toString('base64')
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '');
  } catch {
    return null;
  }
}
