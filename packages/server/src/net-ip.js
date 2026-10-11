/**
 * 客户端 IP 判定 —— P1-10
 *
 * 🔴🔴 为什么单独成文件：`server.js` 一 import 就会 `listen()`（它是入口脚本），
 *   测试没法把它 import 进来单测。而"限流用哪个 IP"这件事**必须**有判据 ——
 *   它决定了 `failmap` / `wkLimited` / `scanMap` 三个桶能不能被客户端一句话绕过。
 *   抽成纯函数后判据可以直接 import 生产代码（纪律：抄进测试的判据恒绿）。
 *
 * 🔴 老项目与本项目的既有语义（不许改）：Caddy 把真实 IP **追加在 XFF 末尾**，
 *   首段是客户端可伪造的 ⇒ 取**末段**。
 */

/** 回环地址（= 前置代理就在本机，线上 Caddy 即此拓扑）。 */
const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

/**
 * 该远端地址是否可信前置代理。
 *
 * @param {string} addr socket 远端地址
 * @param {string} [extra] `NS_BJ_TRUSTED_PROXY` 的原始值（逗号分隔，可空）
 */
export function isTrustedProxy(addr, extra) {
  if (LOOPBACK.has(addr)) return true;
  if (!extra) return false;
  return extra
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .includes(addr);
}

/**
 * 取客户端 IP。
 *
 * 🔴 顺序不能反：**先证明来者可信，再看 XFF**。反了就是把限流桶交给客户端写
 *   —— 任何人换一个 XFF 就换一个桶，还能伪造受害者 IP 把他锁死 10 分钟。
 *
 * @param {Record<string, string | string[] | undefined>} headers
 * @param {string | undefined} remoteAddr
 * @param {string} [extra]
 * @returns {string} 永不返回空串/undefined（限流桶的键要靠它，空了就全挤一个桶）
 */
export function clientIpFrom(headers, remoteAddr, extra) {
  const ra = remoteAddr || 'unknown';
  const xff = headers ? headers['x-forwarded-for'] : undefined;
  if (typeof xff === 'string' && xff.length > 0 && isTrustedProxy(ra, extra)) {
    const parts = xff.split(',').map((s) => s.trim()).filter(Boolean);
    // 🔴 显式判空而不是直接下标返回：`noUncheckedIndexedAccess` 下下标取值带
    //   `undefined`，会让整个函数返回 `string | undefined` ⇒ 下游限流桶的键
    //   有可能是 undefined（所有桶挤成一个）。
    const last = parts.length ? parts[parts.length - 1] : undefined;
    if (last) return last;
  }
  return ra;
}
