/**
 * 复制到剪贴板 —— 双 MIME（text/plain + text/html）纯读操作
 *
 * 🔴 移植依据：老项目 index.html:2826-2851（copyBtn handler）。
 *
 * ─────────────────────────────────────────────────────────────────────────
 * 一、为什么**读模型**而不是读 DOM（与老项目最本质的一条差异）
 *
 *   老项目的复制是 `editor.innerHTML` / `editor.innerText` —— 读 DOM。
 *   而折叠块的收起态是靠 CSS `display:none` 实现的（styles.css:299），于是
 *   收起态下 `innerText` **取不到正文**。老项目为此在复制前把 `.ns-fold-hide`
 *   全摘掉，读完再 `applyFolds()` 还原（v9.1.1 注释写得很清楚：
 *   「折叠是纯显示层，复制不得丢字」）。
 *
 *   本项目**不需要这套 gymnastics**：`lexicalToDoc` 产出的是真源模型 JSON，
 *   折叠块的 children 在模型里**恒定完整**，`__open` 只是 DOM 上的
 *   `data-open` 属性 + 一个 ephemeral 字段（nodes.ts:154），压根不参与模型。
 *   所以从模型读，天然就是「收起态也能复制到完整正文」。
 *
 *   这不只是省事，是**修掉了一整类事故**：
 *     - 临时改 DOM 展开 → 若中途抛错/被打断，用户的折叠块就**永久留在展开态**；
 *     - 展开/还原发生在 await 之间 → 用户看得见**闪一下**；
 *     - 折叠开合是 ephemeral UI 态（ARCH 红线 R3），临时去改它就是在一个
 *       「纯读操作」里写UI 状态，性质上离「污染真源」只隔一层。
 *   模型读取让复制成为**结构上的纯读**：不碰 DOM、不碰 ephemeral 态、
 *   不碰真源，因此也**不需要还原**—— 没有可还原的东西。
 *
 *   语义上与老项目完全一致（收起态也得复制到完整正文），机制上更 strict。
 *
 * ─────────────────────────────────────────────────────────────────────────
 * 二、其余四条语义的落点
 *
 *   1. **纯文本优先**：`text/plain` 由模型 spans 直接拼，**不做** HTML 降级
 *      （老项目是 innerText，浏览器自己的降级规则不可控）。
 *   2. **ZWSP 剥离**：U+200B/200C/FEFF/2060 是编辑器内断行/选区锚点用的
 *      不可见字符，粘到别的编辑器里就是乱码。本项目**不插入**它们，
 *      但真源可能来自老项目迁移（老项目 linkify 会往长词里插 ZWSP），
 *      所以复制口必须剥。与 serialize.ts:362 同一套字符集。
 *   3. **双 MIME**：`text/plain` 给纯文本目的地，`text/html` 给 Word /
 *      富文本编辑器 —— 只写 plain 的话，粘进 Word 所有格式全丢。
 *   4. **可见反馈**：成功/降级/失败三档都给状态条（老项目 showUploadStatus
 *      同款）。**失败必须说人话**，静默失败 = 用户以为功能坏了。
 *
 * ─────────────────────────────────────────────────────────────────────────
 * 三、双 MIME 的文本一致性是**结构保证**，不是巧合
 *
 *   `text/html` 的 textContent 必须逐字等于 `text/plain`（e2e 有断言）。
 *   做法：每个块**一次遍历同时产出** plain 与 html 两份片段，且
 *   **块之间一律用 '\n' 连接**（html 里也是真换行文本节点，不是排版缩进）。
 *   于是"剥掉标签 = 原文本"恒成立，不会因为以后加一种块就漂。
 *   唯一要盯的是 `<pre>` 里的换行来自文本自身，不能再补缩进。
 */

import type { Block, Doc, Span } from '@bj/shared-schema';
import { escapeHtml } from '../ui/escape.ts';
import { COPY } from '../ui/copy.ts';

/**
 * 零宽字符集。
 *
 * 🔴 与 serialize.ts:362 用**同一套**字符（不只 U+200B）：
 *   少一个就有一类历史数据漏出去，且症状是"粘到别处偶尔多出看不见的字符"，
 *   那种问题用户根本报不出来（他看到的是别人的编辑器乱码）。
 */
const ZERO_WIDTH = /[\u200B\u200C\uFEFF\u2060]/g;

/** 剥掉零宽字符。 */
export function stripZeroWidth(s: string): string {
  return s.replace(ZERO_WIDTH, '');
}

/* ─────────────────────────────────────────────────────────────────────────
 * 块 → {plain, html}
 * ───────────────────────────────────────────────────────────────────────── */

interface Frag {
  /** 纯文本片段（已剥零宽）。 */
  plain: string;
  /** HTML 片段，其 textContent 恒等于 plain。 */
  html: string;
}

/** span 行内内容。格式标记按 b→i→u→s→c 顺序套，href 包在最外层。 */
function spansToFrag(ss: readonly Span[] | undefined): Frag {
  let plain = '';
  let html = '';
  for (const s of ss ?? []) {
    // 🔴 空 span 直接跳过：模型层允许它（承载纯标记的锚点），但复制出去的文本里
    //   留一个空 <a>/<b> 标签，粘到别处会变成一个空链接或空下划线
    const raw = stripZeroWidth(s.t);
    if (raw === '') continue;
    plain += raw;
    let h = escapeHtml(raw);
    // 🔴 顺序即嵌套顺序，与 CSS 盒模型无关，只影响Word 里的呈现层级
    if (s.c === true) h = `<code>${h}</code>`;
    if (s.s === true) h = `<s>${h}</s>`;
    if (s.u === true) h = `<u>${h}</u>`;
    if (s.i === true) h = `<i>${h}</i>`;
    if (s.b === true) h = `<b>${h}</b>`;
    // 🔴 提醒在编辑器里是下划线（rem-mark），复制出去同样给下划线，
    //   否则粘到别处"提醒"这个信息就凭空丢了
    if ((s.rem ?? '') !== '') h = `<u>${h}</u>`;
    if ((s.href ?? '') !== '') h = `<a href="${escapeHtml(s.href ?? '')}">${h}</a>`;
    html += h;
  }
  return { plain, html };
}

function textFrag(t: string, html: string): Frag {
  return { plain: stripZeroWidth(t), html };
}

/**
 * 一组块 → 一个片段。
 *
 * 🔴 连接符恒为 '\n'（html 侧是真换行文本节点），这是「双 MIME 文本一致」
 *   的唯一依据，见文件头第三节。
 */
function fragsJoin(fs: readonly Frag[]): Frag {
  return {
    plain: fs.map((f) => f.plain).join('\n'),
    html: fs.map((f) => f.html).join('\n'),
  };
}

function blockToFrag(b: Block): Frag {
  switch (b.t) {
    // 行内块。🔴 顶层裸 li 在这里与 p 同处理（不给用户孤立 <li>），
    //   与 serialize.ts 导入侧的降级口径一致（ListItemNode 不能挂 root）
    case 'p':
    case 'li':
    case 'h1':
    case 'h2':
    case 'h3':
    case 'quote':
      return spansToFrag(b.spans);
    case 'code': {
      const t = b.text ?? '';
      return textFrag(t, `<pre><code>${escapeHtml(stripZeroWidth(t))}</code></pre>`);
    }
    case 'hr':
      //分隔线没有文字。html 侧留<hr>（粘进 Word 仍是分隔线），
      // 两侧都是空串，所以连接符带来的换行仍然对称
      return textFrag('', '<hr>');
    case 'img': {
      const src = b.src ?? '';
      const alt = b.imgAlt ?? '';
      const html =
        src === ''
          ? ''
          : `<img src="${escapeHtml(src)}" alt="${escapeHtml(alt)}">`;
      return textFrag('', html);
    }
    case 'fold': {
      // 🔴 标题在前，正文在后，与 FoldNode.getTextContent（nodes.ts:238）同序。
      //   标题在 html 里加粗，粘进 Word 还看得出这是折叠块的把手。
      const head = spansToFrag(b.title);
      const body = (b.children ?? []).map(blockToFrag);
      const all = fragsJoin([head, ...body]);
      return { plain: all.plain, html: `<div class="ns-fold-copy">${all.html}</div>` };
    }
    case 'ul':
    case 'ol': {
      const tag = b.t;
      const items = (b.children ?? []).map(blockToFrag);
      const inner = fragsJoin(items);
      return { plain: inner.plain, html: `<${tag}>${inner.html}</${tag}>` };
    }
  }
  // validator 保证块类型封闭；真出现未知类型时返回空片段而不是崩复制
  return textFrag('', '');
}

/** 真源模型 → 双 MIME 载荷。 */
export function docToClipboardPayload(doc: Doc): { plain: string; html: string } {
  const f = fragsJoin((doc.blocks ?? []).map(blockToFrag));
  return { plain: f.plain, html: f.html };
}

/* ─────────────────────────────────────────────────────────────────────────
 * 交付
 * ───────────────────────────────────────────────────────────────────────── */

export interface CopyDeps {
  /** 取当前真源。读模型而不是读 DOM —— 见文件头第一节。 */
  getDoc: () => Doc;
  /** 触屏收键盘（main.ts 注入，内部已判平台）。老项目 v7.5.1 口径。 */
  dismissKeyboard: () => void;
  /** 状态提示（与 export 同款签名）。 */
  onStatus: (kind: 'doing' | 'ok' | 'bad', text: string, autoHideMs: number) => void;
  /** 成功/失败驻留毫秒。老项目两种都是 2000（index.html:2850）。 */
  okMs: number;
  failMs: number;
}

/**
 * 复制结果的四种态。
 *
 * 🔴 必须**返回成败**而不能让调用方"看提示条现在是什么态"反推 ——
 *   那是把数据藏在副作用里（与 export/index.ts 同一条纪律）。
 * - 'ok'      双 MIME 写成功
 * - 'text'    降级：只写成了纯文本（无 ClipboardItem 或被拒）
 * - 'fail'    两档都失败
 * - 'noeditor' 顶栏还在但笔记已卸载（与 exportImg 同款守卫）
 */
export type CopyResult = 'ok' | 'text' | 'fail' | 'noeditor';

export async function copyNoteToClipboard(deps: CopyDeps): Promise<CopyResult> {
  deps.dismissKeyboard();

  const { plain, html } = docToClipboardPayload(deps.getDoc());

  // ① 双 MIME。老项目用 ClipboardItem + Blob，不是 writeText。
  if (typeof navigator.clipboard?.write === 'function' && typeof ClipboardItem !== 'undefined') {
    try {
      await navigator.clipboard.write([
        new ClipboardItem({
          'text/plain': new Blob([plain], { type: 'text/plain' }),
          'text/html': new Blob([html], { type: 'text/html' }),
        }),
      ]);
      deps.onStatus('ok', COPY.copyOk, deps.okMs);
      return 'ok';
    } catch {
      // 无 ClipboardItem 权限 / 旧内核只认 text/plain → 落到 ②
    }
  }

  // ② 降级纯文本。文案与①不同：用户要知道自己丢了格式（老项目同款区分）。
  try {
    await navigator.clipboard.writeText(plain);
    deps.onStatus('ok', COPY.copyTextOnly, deps.okMs);
    return 'text';
  } catch {
    deps.onStatus('bad', COPY.copyFail, deps.failMs);
    return 'fail';
  }
}