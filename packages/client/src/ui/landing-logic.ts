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

/** 输入净化：只留英文/数字/下划线/短横线。老项目原文 `replace(/[^A-Za-z0-9_-]/g, '')`。 */
export function sanitizeNoteName(input: string): string {
  return input.replace(/[^A-Za-z0-9_-]/g, '');
}
