/**
 * Lexical 补丁：组字期 DOM 零宽后缀剥离（v3.2.6 实验）
 *
 * 🔴🔴🔴 背景（真机取证，见 memory 2026-10-13 条目）：
 *   Lexical 的 `$setTextContent` 在组字期每次 DOM 写入都追加 COMPOSITION_SUFFIX
 *   （Android/Chromium = U+200B 零宽字符）——源码 dist/Lexical.dev.js:11220：
 *     const suffix = isComposing ? COMPOSITION_SUFFIX : '';
 *     const text = nextText + suffix;
 *   真机 tree:frag 取证：组字全程 DOM 比模型恒多 1 字（div=+1），且塌方发生在
 *   **完全正常的组字帧**上（输入法数据与文档吻合，浏览器应用后文档随机腰斩）。
 *   假设：DOM 与模型的恒定 +1 分歧是浏览器组字应用随机失败的诱因之一。
 *
 * 🔴 本补丁 = 让 Lexical 不写这个后缀（DOM 恒等于模型，div=+0）。
 *   与 v3.2.2 失败的「DOM 剥离」实验本质不同：那个是写完之后改 DOM（浏览器
 *   察觉 DOM 变化 ⇒ 触发补偿事件 ⇒ 与守卫打架，WD-E2E-05/COMPOSE-E2E-01 红）；
 *   本补丁是让后缀从不被写入，浏览器从未见过零宽字符，无需任何补偿。
 *
 * 🔴 补丁点（lexical 0.52.0，esbuild 打包走 production 条件 ⇒ 打 prod 文件）：
 *   dist/Lexical.prod.js 的压缩函数 ai(t,e,n)（= $setTextContent）：
 *     const o=n.isComposing(),r=t+(o?M:""),i=Eu(),...
 *   M = COMPOSITION_SUFFIX。把 r=t+(o?M:"") 改为 r=t（后缀永不写入）。
 *   其余读取点（endsWith(M) 剥离、textContent===M 检查）在 DOM 无后缀时
 *   自然不命中，无需改动。
 *
 * 🔴 幂等 + 失效即响：已打过则跳过；找不到补丁点 ⇒ exit 1（Lexical 升级后
 *   模式漂移时**必须**让构建失败，绝不能静默发未打补丁的包）。
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const TARGET = join(ROOT, 'node_modules', 'lexical', 'dist', 'Lexical.prod.js');
const MARKER = 'NS_ZSP_PATCH';
/** 补丁点：$setTextContent 压缩版的后缀拼接（含后面的 i=Eu() 锚定，防误伤）。 */
const OLD = 'r=t+(o?M:""),i=Eu()';
const NEW = 'r=t/*' + MARKER + '*/,i=Eu()';

if (!existsSync(TARGET)) {
  console.error('[patch-lexical] node_modules/lexical 不存在——先 npm ci');
  process.exit(1);
}
const src = readFileSync(TARGET, 'utf8');
if (src.includes(MARKER)) {
  console.log('[patch-lexical] 已打过，跳过');
} else if (!src.includes(OLD)) {
  console.error('[patch-lexical] 🔴 找不到补丁点（Lexical 版本已变？）——拒绝构建');
  process.exit(1);
} else {
  writeFileSync(TARGET, src.replace(OLD, NEW), 'utf8');
  console.log('[patch-lexical] 组字零宽后缀补丁已应用（DOM 恒等于模型）');
}
