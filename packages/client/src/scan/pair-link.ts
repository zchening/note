/**
 * 配对链接 —— 二维码里装什么、扫到后怎么落地
 *
 * 🔴🔴🔴 本模块是**新旧项目唯一的架构性分叉点**，必须讲清楚为什么不能照抄老项目：
 *
 * 老项目（v5.20 起）的二维码装的是**可直接使用的 AES 密钥**：
 *   `https://biji.xuyinji.com.cn/<笔记名>#k=<base64(rawKey)>`
 * 它成立的前提是老项目把 raw key 明文存在 localStorage（`KEY_STORE`），
 * 任何 XSS 都能读走 —— 那条路换取的是"扫码即零输入解锁"。
 *
 * 新项目的密钥是 `extractable:false` 的 CryptoKey，存 IndexedDB
 * （见 @bj/shared-schema 的 key-store.ts），**WebCrypto 层面物理上导不出 raw 字节**。
 * 照抄老项目就必须先把密钥降级成可导出 —— 那等于亲手拆掉新项目最重要的一条安全属性，
 * 为了"少输一次口令"把"XSS 拿到密钥就能离线解开用户全部历史密文"请回来。
 * 严重不对称：省掉的是一次输入，赔进去的是全部历史数据的离线失守。
 *
 * 因此新项目的配对链接装**口令**：
 *   `https://bj.xuyinji.com.cn/<笔记名>#p=<口令>`
 * 扫到之后走**与手输口令完全同一条** `unlock()` 路径 ——
 * 本机派生密钥、验证能否解开远端密文、写 key-store。
 * 口令错 / 数据坏仍返回同一句文案（ARCH 安全不变量，见 sync/unlock.ts）。
 *
 * 为什么口令比密钥更适合当配对载荷：
 *  1. 口令是用户自己选的那串，扫一次省一次输入，收益已经足够；
 *  2. 密钥是不可导出对象，导不出就必然要走派生，而派生只有口令能触发；
 *  3. 二维码明文出现口令，与"口令在用户脑子里"是同一风险等级，
 *     但**不会**在 XSS 时被静默持久化（口令不写 localStorage）；
 *  4. 改口令后旧码自动失效（密钥变了），语义上比"密钥码"更正确。
 *
 * 🔴 载荷放 **fragment**（`#p=`）而不是 query（`?p=`）：
 *   fragment 不会随 HTTP 请求上行，服务器与任何中间日志都看不到它。
 *   这是老项目 `#k=` 就做对的事，照搬。
 *
 * 零 DOM 依赖 —— 可在 node 里单测（landing-logic 同样零 DOM，可直接复用净化器）。
 */

import { sanitizeNoteName } from '../ui/landing-logic.ts';

/** 配对链接的 fragment 前缀 */
export const PAIR_FRAGMENT_KEY = 'p';

/**
 * base64url 编解码。
 *
 * 🔴 为什么不用裸串：口令可以含中文/符号/空格/emoji，
 *   塞进 URL fragment 后浏览器与扫码器的转义行为并不一致
 *   （有的内核原样保留、有的先 decode 一次）。base64url 消掉这层不确定性。
 */
export function b64UrlEncode(s: string): string {
  const bytes = new TextEncoder().encode(s);
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function b64UrlDecode(s: string): string {
  // 🔴 必须补回 padding：base64url 去了 '='，atob 对长度 %4==1 直接抛。
  //   补法是 append (4 - len%4) %4 个 '='，不能无脑加 '==='（多余 padding 同样抛）。
  const pad = (4 - (s.length % 4)) % 4;
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat(pad);
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

export interface PairLink {
  /** 笔记名（原样，未净化） */
  noteId: string;
  /** 口令明文 */
  passphrase: string;
}

/**
 * 造配对链接。origin 显式传入而不是读 location.origin —— 这样可单测。
 * 🔴 不做入参兜底：非法名请让 isPlainNoteName 先挡住（见其注释），
 *   这里"宽容地"出码等于出一张扫得通但指错地方的码。
 */
export function buildPairLink(origin: string, noteId: string, passphrase: string): string {
  const base = origin.replace(/\/+$/, '');
  return `${base}/${encodeURIComponent(noteId)}#${PAIR_FRAGMENT_KEY}=${b64UrlEncode(passphrase)}`;
}

export type ParseResult =
  | { ok: true; link: PairLink }
  /** 域不符 / 无 p= / 笔记名非法 / 口令载荷解不开 */
  | { ok: false; reason: 'not-pair' | 'bad-name' | 'bad-pass' };

/**
 * 解析扫到的原始文本。
 *
 * 🔴 **只信同源**：`origin` 之外的域一律判 not-pair。
 *   不做开放重定向，也不"聪明地"接受任意域 —— 那等于把扫码入口
 *   变成一个任意外站跳转器。老项目用 Caddy 302 中转时代价是小米扫码风控，
 *   新项目直连自身域，判据收紧是净收益。
 */
export function parsePairLink(raw: string, origin: string): ParseResult {
  if (typeof raw !== 'string') return { ok: false, reason: 'not-pair' };
  const text = raw.trim();
  if (text === '') return { ok: false, reason: 'not-pair' };

  let u: URL;
  try {
    u = new URL(text);
  } catch {
    return { ok: false, reason: 'not-pair' };
  }
  const base = origin.replace(/\/+$/, '');
  if (u.origin.replace(/\/+$/, '') !== base) return { ok: false, reason: 'not-pair' };

  const frag = u.hash.startsWith('#') ? u.hash.slice(1) : u.hash;
  if (frag === '') return { ok: false, reason: 'not-pair' };
  // 🔴 只认单个 `p=`。老项目的 `#k=` 属于旧项目载荷（另一把钥匙的字节），
  //   在新项目里绝不能被当口令接受 —— 那是把 A 的钥匙当 B 的口令喂进 PBKDF2，
  //   症状是"扫码后说口令不对"，用户完全想不到真正原因。
  if (!frag.startsWith(PAIR_FRAGMENT_KEY + '=')) return { ok: false, reason: 'not-pair' };
  const payload = frag.slice(PAIR_FRAGMENT_KEY.length + 1);
  if (payload === '') return { ok: false, reason: 'bad-pass' };

  let passphrase: string;
  try {
    passphrase = b64UrlDecode(payload);
  } catch {
    return { ok: false, reason: 'bad-pass' };
  }
  if (passphrase === '') return { ok: false, reason: 'bad-pass' };

  const parts = u.pathname.split('/').filter((p) => p !== '');
  // 🔴 必须恰好一段：多段说明这不是"打开某篇笔记"的链接
  //   （可能是别人的站点路径恰好同域，或手敲错的地址）。
  if (parts.length !== 1) return { ok: false, reason: 'not-pair' };
  const seg = parts[0];
  // noUncheckedIndexedAccess 下 length 判过仍可能是 undefined —— 显式挡一道，
  //   不要靠"理论上不可能"糊过去。
  if (seg === undefined) return { ok: false, reason: 'not-pair' };
  let noteId: string;
  try {
    noteId = decodeURIComponent(seg);
  } catch {
    return { ok: false, reason: 'bad-name' };
  }
  if (!isPlainNoteName(noteId)) return { ok: false, reason: 'bad-name' };
  return { ok: true, link: { noteId, passphrase } };
}

/**
 * 笔记名是否**原样**合法。
 *
 * 🔴 为什么必须是"原样相等"而不是"净化后非空"：
 *   sanitizeNoteName 会**静默删除**非法字符（`/a b` -> `/ab`）。
 *   若只判"净化后非空"，出码时 `a b` 会被悄悄出成指向 `ab` 的码 ——
 *   用户站在 A 篇笔记前，扫出来的码却打开 B 篇，**且全程零报错**。
 *   所以生成侧与解析侧一律用"原样相等"，让非法名在生成侧就被挡住。
 */
export function isPlainNoteName(name: string): boolean {
  if (name.length === 0) return false;
  return sanitizeNoteName(name) === name;
}
