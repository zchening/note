/**
 * 口令保险箱 —— 让「本机已记住」等价于「本机拿得出口令」
 *
 * ═══════════════════════════════════════════════════════════════════════
 * 为什么要有这个模块（用户报障：点「扫码配对」/「扫码换机」还要输口令）
 * ═══════════════════════════════════════════════════════════════════════
 *
 * 老项目把 **raw key 明文**写在 localStorage（`KEY_STORE`），所以任何时刻都拿得出
 * "另一台设备需要的那件东西" ⇒ 记忆过的设备点配对/换机**永远免输口令**。
 *
 * 新项目的密钥是 `extractable:false` 的 CryptoKey，**物理上导不出 raw 字节**，
 * 于是配对码里装的是**口令**（见 scan/pair-link.ts 的架构分叉说明）。
 * 此前口令只活在 `main.ts` 的 `sessionPass` 里（仅内存）⇒
 * 只有"本次会话手输过口令"才出得了码；
 * 而绝大多数用户是**记忆解锁**进来的（刷新/下次打开），sessionPass 为空 ⇒
 * 配对弹窗只能显示「本机未保留口令，无法生成配对码」——
 * 用户看到的就是"每次点都要输口令"，与老项目体验不一致。
 *
 * ═══════════════════════════════════════════════════════════════════════
 * 安全口径（必须在代码里讲清楚，不能含糊）
 * ═══════════════════════════════════════════════════════════════════════
 *
 * 本模块把口令**用本笔记的密钥加密**后存 localStorage。三条性质：
 *
 *  1. **没有密钥，这团密文什么都不是**。密钥是 extractable:false 的 CryptoKey，
 *     存在 IndexedDB 里，不落 localStorage ⇒ 只读 localStorage 的人（扩展、
 *     备份、devtools 扫一眼）拿到的是一团解不开的字节。
 *     这是与"老项目明文 raw key"的本质区别。
 *
 *  2. **锁定即失效，与密钥同生共死**。lockNote() 删密钥，本模块同时删密文；
 *     密钥没了（清 IndexedDB、换浏览器）密文也必然解不开。
 *     所以"锁定后点配对码还是能出"这条老 bug 不会复活。
 *
 *  3. **不跨用途**：AAD 用独立的 'pass' 标签（见 crypto.ts），
 *     一段正文密文不会被当成口令保险箱通过认证。
 *
 * 🔴 必须诚实写下的边界：能在本页面执行 JS 的攻击者（XSS）仍然可以用
 *    `resolveKey()` + `readPassVault()` 取回口令 —— 因为密钥在同源 IndexedDB 里，
 *    这在本架构下无法避免。所以这条**不是**"XSS 也拿不到"的保证，
 *    它的作用是：把暴露面从"任何能读 localStorage 的东西"
 *    收窄到"能在同源执行 JS 的东西"。与老项目（明文密钥躺 localStorage）
 *    相比是**净改善**，不是净退化。真正堵死 XSS 只能靠 CSP，与本模块无关。
 */

import { decryptString, encryptString, type DerivedKey, type Envelope } from '@bj/shared-schema';

/** localStorage 键（与 local-cache 同款命名前缀，便于一眼看出是本机态）。 */
const vaultKeyOf = (noteId: string): string => `notesync_bj_pass_${noteId}`;

/**
 * 存：用本笔记密钥把口令封起来。
 *
 * 🔴 存失败（隐私模式 / 配额满）**不抛**。保险箱是增强项：
 *   存不下最多退化成"这次要输一次口令"，不该让解锁整个失败。
 */
export async function savePassVault(
  noteId: string,
  passphrase: string,
  dk: DerivedKey,
): Promise<void> {
  if (passphrase === '') return;
  try {
    const env = await encryptString(passphrase, dk.key, 'pass', dk);
    localStorage.setItem(vaultKeyOf(noteId), JSON.stringify(env));
  } catch {
    /* 存不下就算了，本次会话内仍可用 */
  }
}

/**
 * 读：拿密钥解开口令。解不开（换了口令、密钥没了、数据被改）一律返回 undefined，
 * **绝不抛** —— 上层要的是"能不能免输口令"，不是一个异常。
 */
export async function readPassVault(noteId: string, key: CryptoKey): Promise<string | undefined> {
  let raw: string | null;
  try {
    raw = localStorage.getItem(vaultKeyOf(noteId));
  } catch {
    return undefined;
  }
  if (!raw) return undefined;
  let env: Envelope;
  try {
    env = JSON.parse(raw) as Envelope;
  } catch {
    return undefined;
  }
  try {
    const pass = await decryptString(env, key, 'pass');
    return pass === '' ? undefined : pass;
  } catch {
    return undefined;
  }
}

/** 删：锁定 / 改口令前必须调，否则"锁定后还能出码"。 */
export function dropPassVault(noteId: string): void {
  try {
    localStorage.removeItem(vaultKeyOf(noteId));
  } catch {
    /* ignore */
  }
}
