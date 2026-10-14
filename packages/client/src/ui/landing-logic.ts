/**
 * 落地页的**纯逻辑**部分 —— 不碰 DOM，可在 node --test 里直接单测
 *
 * 🔴 为什么拆出来：`pages.ts` 一 import DOM 就不能在 node 里测（jsdom 已退役，
 *   见 ARCH.md §4.6）。而"输入净化规则"与"彩蛋保留字"恰恰是最该被钉死的行为 ——
 *   用户粘贴一个带空格/中文的笔记名，如果净化规则悄悄变了，
 *   表现是"打不开笔记"，且完全看不出是哪一步坏了。
 *   所以：**能在 node 里测的逻辑一律不许混进 DOM 模块**。
 *
 * 🔴🔴 彩蛋保留字与门牌判定**已迁到 `egg/registry.ts`**（S5-g）。
 *   这里只做 re-export，不再持有第二份字面量 ——
 *   S4 阶段本文件里只有 `{pet}` 一个保留字，导致落地页把 `snake`/`dragon` 等
 *   门牌名当普通笔记名放行：点「打开」进的是空白编辑器，
 *   而用户以为进的是贪吃蛇。**零报错**，只能靠"清单唯一真源"根治。
 */

import { RESERVED_ROUTES, isEggRoute } from '../egg/registry.ts';

export { RESERVED_ROUTES, isEggRoute };

/**
 * 输入净化：只留英文/数字/下划线/短横线，并**归一小写**。
 *
 * 🔴 v3.3.5（用户报障）：服务端 ID_RE 只认小写（^[a-z0-9][a-z0-9_-]{0,63}$），
 *   旧版这里保留大小写，大写名一路进到 GET /api/note/MyNote → 400 bad id →
 *   fetchRemote 把一切非 2xx 当 offline → 用户看到「连不上服务器，请检查网络」
 *   （报错撒谎：不是网络，是名字）。老项目 v10.1.1 的同款规则是"解析处小写"
 *   （index.html:901）；bj 归一放在净化器——落地页输入框/URL 预览行/route()
 *   判定共用本函数，输入即所见即所得，route 的名字判定天然同源。
 *   大小写变体本就是同一篇笔记，归一无损；彩蛋门牌 id 全小写，不受影响
 *   （反而修好"手输 /SNAKE 进不了贪吃蛇"的边角）。
 */
export function sanitizeNoteName(input: string): string {
  return input.replace(/[^A-Za-z0-9_-]/g, '').toLowerCase();
}
