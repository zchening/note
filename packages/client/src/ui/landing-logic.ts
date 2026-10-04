/**
 * 落地页的**纯逻辑**部分 —— 不碰 DOM，可在 node --test 里直接单测
 *
 * 🔴 为什么拆出来：`pages.ts` 一 import DOM 就不能在 node 里测（jsdom 已退役，
 *   见ARCH.md §4.6）。而"输入净化规则"与"彩蛋保留字"恰恰是最该被钉死的行为 ——
 *   用户粘贴一个带空格/中文的笔记名，如果净化规则悄悄变了，
 *   表现是"打不开笔记"，且完全看不出是哪一步坏了。
 *   所以：**能在 node 里测的逻辑一律不许混进 DOM 模块**。
 */

/**
 * 彩蛋保留字：命中则按钮变「打开彩蛋」且不新建笔记。
 *
 * 🔴 S4 只放老项目已确认存在的入口（桌宠 pet）。完整清单在 S8 接彩蛋层时补齐，
 *   补的时候必须同步更新 `S4-N2` 那条用例的断言（它钉住了这份清单）。
 */
export const RESERVED_ROUTES: ReadonlySet<string> = new Set([
  'pet',
  'draw',
  'game',
  'admin',
  'about',
  'help',
  'api',
  'www',
]);

/** 输入净化：只留英文/数字/下划线/短横线。老项目原文 `replace(/[^A-Za-z0-9_-]/g, '')`。 */
export function sanitizeNoteName(input: string): string {
  return input.replace(/[^A-Za-z0-9_-]/g, '');
}

/** 该名字是否指向彩蛋而非新笔记。 */
export function isEggRoute(name: string): boolean {
  return name !== '' && RESERVED_ROUTES.has(name.toLowerCase());
}
