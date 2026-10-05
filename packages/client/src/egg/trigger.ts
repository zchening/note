/**
 * 彩蛋词表触发 —— **纯逻辑层**（正则 / 剥零宽 / 光标上下文 / 会话闩锁）
 *
 * 🔴🔴 本文件的每一条判据都是从老项目 `index.html` **逐字抽出**的，
 *   并且在 node 里实跑比对过（见交付说明「移植验证」）。
 *   **不许凭推理「顺手优化」** —— 下面每条非显然的结论都标了老项目行号与实跑结果。
 *
 * 🔴🔴 为什么名单要**从 registry 生成**而不是抄一份字面量：
 *   老项目 `NS_EGG_RE`（:10943）把 10 个 id 硬编码进正则 alternatives。
 *   新项目若照抄那份字面量，就出现**两份清单**—— 门牌表加一个 id，
 *   正则不认识它（用户敲 `/newEgg` 永远不弹，图鉴里却多了一项）。
 *   这类漂移零报错，正是本项目反复踩的坑。故从 `EGG_DOORS` 生成，
 *   并由单测钉住「生成结果与老项目字面正则**逐案例等价**」。
 *
 * 🔴 实跑确认的六条边界（**与直觉相反，故必须记下来**）：
 *
 *  1. **大小写敏感**：`NS_EGG_RE` 无 `i` 标志 ⇒ `/DRAGON` **不弹**。
 *     而 hover/caret 通道那条 `NS_EGG_HOVER_RE` 同样无 `i`。
 *     「用户一定会打小写」是错的假设 —— 照抄，不加 `i`。
 *
 *  2. **`okNext` 只在一种情况下起作用**：光标正卡在
 *     「蛋 id 是某个更长词的前缀」处（如 `/pet|shop`）。
 *     实跑：`/pet|shop` → `blocked-by-post`；`/dra|gon` → `no-regex-match`
 *     （`pre` 是 `/dra`，正则本身就匹配不上，压根走不到 okNext）。
 *     即 `okNext` 真正兜住的只有 `/petshop` 这类 —— 正是老项目注释
 *     「防止 `/petshop` 误触」所指的那一个。
 *
 *  3. **判据优先级：先正则，后 okNext**（老项目 `if (!m || !okNext) return;` :10966）。
 *     所以 `/fooshop` 的失败原因是 `no-regex-match` 而**不是** `blocked-by-post`。
 *
 *  4. **`//dragon` 会弹**：`[^A-Za-z0-9_\-]` 吃掉第二个斜杠。
 *     实跑确认。这看着像 bug，但老项目就是这样，放宽它= 复刻失败。
 *
 *  5. **剥零宽（`nsStripZW` :10944）发生在匹配之前**，所以它**不能**让
 *     词边界变松：`a\u200B/dragon` 剥后是 `a/dragon`，`a` 仍是字母数字 → 仍不弹。
 *     它的真实作用是认出「零宽插在词中间」的 `/dra\u200Bgon`（linkify 断行所插）。
 *
 *  6. **`asked[id]` 的粒度是 id，不是词次**（:10970）。进过一次即`delete`
 *     （:11014re-arm），点「✕」则保持置位（:11015）。
 *     而 **caret 通道完全不看 `asked`**（:11108 注释明写「不受 asked[] 会话抑制」）——
 *     那是用户主动把光标移回词上，属主动行为。
 */

import { EGG_DOORS } from './registry.ts';

/** 正则里要转义的字符（id 本身只有小写字母，但别让加 id 的人踩坑）。 */
function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * 由门牌清单生成「词尾正好落在光标处」的正则。
 *
 * 🔴 逐字对应老项目 :10943：
 *   `/(^|[^A-Za-z0-9_\-])\/(mirror|snake|...)$/`
 *   - `^` 在这里是**24 字窗口的开头**，不是段首 —— 老项目v9.2.0 放宽后的关键。
 *   - 斜杠前**不许**是字母数字/下划线/连字符（`看/mirror` 中，要）、
 *     但中文等非 ASCII 皆可。
 *   - `$` 要求词尾= 光标位，且**不吃尾随标点**
 *     （`/dragon.` 不弹；这是与 hover 通道的实质量Difference，见下）。
 *   - **无 `i` 标志**（见文件头实跑结论 1）。
 */
export function buildEggWordRe(ids: readonly string[] = EGG_DOORS): RegExp {
  return new RegExp('(^|[^A-Za-z0-9_\\-])/(' + ids.map(escapeRe).join('|') + ')$');
}

/** 打字通道正则。 */
export const EGG_WORD_RE = buildEggWordRe();

/**
 * 光标落位 / 触屏点词通道的正则（老项目 `NS_EGG_HOVER_RE` :11060）。
 *
 * 🔴🔴 与打字通道的**实质量差异**（照抄，不许合并成一条）：
 *   -尾随用 `(?![A-Za-z0-9])` 而非 `$` ⇒ `/dragon.`、`(/dragon)`、
 *     `/pet，` **都算命中**；打字通道一律不认。
 *   - 斜杠前**允许**连字符（`[^A-Za-z0-9_]`，比打字通道少一个 `-`），
 *     因为它判的是「词」而不是「词尾= 光标」。
 *   - 同样**无 `i`**。
 */
export const EGG_TOKEN_RE =
  /(^|[^A-Za-z0-9_])\/(mirror|snake|dragon|brick|satoshi|bitcoin|tank|spacex|tesla|pet)(?![A-Za-z0-9])/;

/** 剥 ZWSP / ZWNJ / BOM（老项目 `nsStripZW` :10944）。linkify 插的零宽不该挡住词边界。 */
export function stripZW(s: string): string {
  return s.replace(/[\u200B\u200C\uFEFF]/g, '');
}

/**
 * `pre` 只保留后24 字（老项目 :10953 `pre.slice(-24)`）。
 *
 * 🔴 24 是老项目定的窗口。太小的后果是长前缀把词挤出窗口而不弹；
 *   太大的后果是扫到上一段落的字而误弹。**不许改**。
 */
export const PRE_WINDOW = 24;

/** 光标所在块的前文/ 后文。`pre` 已剥零宽且已截窗。 */
export interface CaretCtx {
  pre: string;
  post: string;
}

/**
 * 由「块纯文本 + 块内偏移 + 是否有选区」构造光标上下文。
 *
 * 这是老项目 `nsCaretCtx`（:10946）的**纯函数化**：
 * 老项目用 `document.createRange()` 取pre/post，jsdom 下不可测；
 * 这里把「怎么取」交给调用方，只把「取到之后怎么处理」钉死。
 *
 * 🔴 有选区时返回 `pre: "\u0000SEL"`（老项目原样）——
 *   `\u0000` 永不匹配门牌正则，于是框选时**绝不误弹**。哨兵不能换成空串：
 *   空串会让「框选着一段恰好以 /pet 结尾的文字」弹出确认层。
 */
export function caretCtxOf(
  blockText: string,
  offsetInBlock: number,
  hasSelection: boolean,
): CaretCtx {
  if (hasSelection) return { pre: '\u0000SEL', post: '' };
  const off = Math.max(0, Math.min(offsetInBlock, blockText.length));
  const pre = stripZW(blockText.slice(0, off));
  const post = stripZW(blockText.slice(off));
  return { pre: pre.length > PRE_WINDOW ? pre.slice(-PRE_WINDOW) : pre, post };
}

/**
 * 直接由「已取到的前文/ 后文」构造上下文。
 *
 * 🔴 这是DOM 侧（`word-trigger.ts`）的入口：那边用 `document.createRange()`
 *   分别取pre/post，与老项目 :10950-10952 同构，故不该假装成「块文本 + 偏移」
 *   再切一刀（那会把「块内偏移」的换算责任塞进调用方，易错）。
 *
 * @param pre  光标前的块内文本（**未剥零宽、未截窗**，本函数负责处理）
 */
export function caretCtxFromParts(pre: string, post: string): CaretCtx {
  const p = stripZW(pre);
  return { pre: p.length > PRE_WINDOW ? p.slice(-PRE_WINDOW) : p, post: stripZW(post) };
}

/** 判定失败的原因。**只为让单测能钉住「到底哪个判据挡的」**，不参与 UI。 */
export type EggMiss = 'no-regex-match' | 'blocked-by-post' | 'already-asked';

export type EggVerdict = { hit: true; id: string } | { hit: false; why: EggMiss };

/**
 * 会话闩锁（老项目 `var asked = {}` :10942）。
 *
 * 🔴 粒度是**id**（实跑确认：先敲 dragon 再敲 pet，pet照弹）。
 *   置位语义有两档，方向相反，别弄反：
 *   - `arm(id)`  = 弹过一次 / 用户点了「✕」⇒ **抑制**后续打字触发。
 *   - `rearm(id)` = 用户点了「进入」⇒ `delete`，让这个词**还能再弹**。
 */
export interface AskLatch {
  isAsked: (id: string) => boolean;
  arm: (id: string) => void;
  rearm: (id: string) => void;
}

export function buildAskLatch(): AskLatch {
  const asked: Record<string, 1> = {};
  return {
    isAsked: (id) => asked[id] === 1,
    arm: (id) => {
      asked[id] = 1;
    },
    rearm: (id) => {
      delete asked[id];
    },
  };
}

/**
 * 打字通道判定（老项目 `nsWordTriggerAtCaret` :10958-10970 的纯逻辑部分）。
 *
 * 🔴 判据顺序**逐字照抄**：`if (!m || !okNext) return;` —— 正则先，okNext 后。
 *   顺序换了，`/fooshop` 的失败原因会从 `no-regex-match` 变成 `blocked-by-post`，
 *   而调用方（单测）正是靠这个原因码钉判据的。
 *
 * @param ctx  光标上下文；`null` 表示**拿不到光标**（老项目退化为全文尾部扫描）
 * @param latch 会话闩锁
 * @param fallbackText 仅在 `ctx === null` 时使用（老项目的 `editor.textContent`）
 */
export function eggVerdictAtCaret(ctx: CaretCtx | null, latch: AskLatch, fallbackText = ''): EggVerdict {
  let pre: string;
  let okNext: boolean;
  if (ctx) {
    pre = ctx.pre;
    //🔴 光标后紧跟字母数字/下划线/连字符 = 用户还在打更长的词，不弹。
    okNext = !/^[A-Za-z0-9_\-]/.test(ctx.post);
  } else {
    // 🔴 无光标环境（jsdom 守护等）退回尾部扫描，且**不判okNext**（老项目 :10963）。
    const all = stripZW(fallbackText);
    pre = all.length > PRE_WINDOW ? all.slice(-PRE_WINDOW) : all;
    okNext = true;
  }
  const m = EGG_WORD_RE.exec(pre);
  if (!m) return { hit: false, why: 'no-regex-match' };
  if (!okNext) return { hit: false, why: 'blocked-by-post' };
  const id = (m[2] ?? '').toLowerCase();
  if (latch.isAsked(id)) return { hit: false, why: 'already-asked' };
  return { hit: true, id };
}

/**
 * 光标落位 / 触屏点词通道判定（老项目 `nsEggTokenAtCaret` :11075与
 * `nsEggHit` :11062 共用的那条正则）。
 *
 * 🔴 与打字通道的实质量差异见 `EGG_TOKEN_RE` 的注释（尾随标点、连字符边界）。
 *   **不能拿 `eggVerdictAtCaret` 顶替** —— 那会让 `/dragon.` 这类命中消失，
 *   而老项目点词是要弹的。
 *
 * @param word  已截到「词」范围的那一段文本（老项目用空白切出 i..j 再 exec）
 */
export function eggIdInWord(word: string): string {
  const m = EGG_TOKEN_RE.exec(stripZW(word));
  return m && m[2] ? m[2].toLowerCase() : '';
}

/** 空白判定。老项目 :11079 逐个列字符码，理由是「不用反斜杠正则」。 */
export function isWordSpace(code: number): boolean {
  // 32 空格 / 9 制表 / 10 换行 / 13 回车 / 12288 全角空格
  return code === 32 || code === 9 || code === 10 || code === 13 || code === 12288;
}

/**
 * 由「一个文本节点的内容 + 节点内偏移」取光标所在词（老项目 :11075-11089）。
 *
 * @returns `{ id: '',rectless: true }` 形态简化为空串 = 未命中
 */
export function eggTokenAtNode(data: string, offsetInNode: number): string {
  const off = Math.max(0, Math.min(offsetInNode, data.length));
  let i = off;
  while (i > 0 && !isWordSpace(data.charCodeAt(i - 1))) i -= 1;
  let j = off;
  while (j < data.length && !isWordSpace(data.charCodeAt(j))) j += 1;
  return eggIdInWord(data.slice(i, j));
}
