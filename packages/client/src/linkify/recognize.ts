/**
 * 链接识别核心 —— **纯函数**，不碰 DOM、不碰 Lexical、不碰计时器
 *
 * 🔴🔴🔴 本文件的每一条规则都从老项目 `TraeProject/notesync/index.html` **逐字抄出**，
 *   行号标在每段上方。铁律「移植差异不许靠推理定案」的落地方式就在这里：
 *   抄录 → 在 node 里实跑老实现 → 与本实现逐条比对输入输出
 *   （见 test/linkify.test.mjs 的「与老项目实跑对拍」一节）。
 *
 *   本文件与老项目的**唯一结构差异**（刻意且必要）：
 *   老项目 `buildLinkSafe` 直接往 `DocumentFragment` 里塞 `<a>` / `<u>` / `<s>` / 文本节点；
 *   本项目返回 `Part[]` 结构化数组。语义判据完全一致，但结构化输出可深比较、可单测、
 *   且能被 Lexical 层与模型层共用。若判据要变，两边必须一起改。
 *
 * ─────────────────────────────────────────────────────────────────────────
 * 一、为什么不能直接用 `registerAutoLink`（实测结论，非推断）
 *
 *   探针 .probe/probe-c.mjs：`registerAutoLink(editor)` 不传 config 时，
 *   `defaultConfig.matchers` 是**空数组**（LexicalLink.dev.js:1773-1778），
 *   于是它注册的是一个"零匹配器"的节点变换 —— 不报错、不生效、也不留痕。
 *   用户报「网址没有被自动识别」就是这么来的。
 *   而且它内部用的是**另一套** URL 正则（Unicode `\p{L}` + 括号配平），
 *   与老项目的 CJK 字符类方案在中文正文里判据完全不同；它也不认手机号、
 *   不认裸域名 TLD 白名单、不管 ZWSP。它产出 AutoLinkNode，而那个节点
 *   **没注册进 ALL_NODES**（node-registry.ts 只有 LinkNode），
 *   真机上一旦触发就抛 "Attempted to create node AutoLinkNode that was not configured"
 *   —— 症状是整篇文档变空（探针 probe-b.mjs 实测）。
 *
 * ─────────────────────────────────────────────────────────────────────────
 * 二、ZWSP：本项目**默认不插**，这是与老项目的一处刻意分歧
 *
 *   老项目 `buildLinkSafe` 会往长词与链接文本里回插 ZWSP（U+200B）以便换行。
 *   本项目**默认不插**，理由三条，每条都有实测支撑：
 *
 *   1. **CSS 已经做了同一件事，逐字节相同**：
 *        老项目 index.html:340 `#editor{...word-wrap:break-word;
 *          overflow-wrap:anywhere;word-break:break-all;white-space:pre-wrap}`
 *        新项目 styles.css:316-317 `.ns-editor{...word-wrap: break-word;
 *          overflow-wrap: anywhere; word-break: break-all; white-space: pre-wrap}`
 *        链接元素同理：老项目 380 行 `word-break:break-all;overflow-wrap:break-word`
 *        对新项目 styles.css:378。**换行能力完全一致，ZWSP 是冗余的。**
 *   2. 🔴 **本项目的真源是模型 JSON，会跨设备同步**。ZWSP 是不可见字符，
 *      进了真源就会：① 参与 canonicalize 的字节比对（两台设备 zwsp 位置差一个字节
 *      就是一次假冲突）；② 进 merge 的字符级对齐（对齐偏移，全篇错位）；
 *      ③ 让"用户正文里多了看不见的字"—— 用户无法察觉也无法删除。
 *      老项目没有这个问题，因为它的真源是 DOM 而 ZWSP 就在 DOM 里（自洽）。
 *   3. **本项目的出口已经在剥 ZWSP**（export/copy.ts:65、export/card.ts:157、
 *      serialize.ts:362），说明项目早已把它当成"外来字符"而不是"自己产生的内容"。
 *
 *   ⇒ `zwsp: true` 保留**老项目逐字口径**，供对拍与需要复刻老行为的场景；
 *     默认 `false` 是本项目的生产口径。**两者都有单测钉住。**
 *
 *   🔴 但「不插」**不等于「不认」**：读入的文本可能**含** ZWSP
 *     （真源来自老项目迁移，见 export/copy.ts:37 的注释）。
 *     `stripZeroWidth` 保证 ZWSP 不会把 URL 正则的匹配拦腰截断。
 */

// ─────────────────────────────────────────────────────────────────────────
// 一、正则与词表（老项目 index.html:3648-3651, 3858-3864）
// ─────────────────────────────────────────────────────────────────────────

/**
 * 老项目 index.html:3648 `FILE_EXT_DENY`
 *
 * 🔴 白名单来自老项目全仓实测而非常识，逐字抄。语义：裸域名（无 http:// 或 www. 前缀）
 *   的最后一段若落在这张表里，就**不**当网址 —— 否则 README.md、data.json、main.py
 *   全变成链接，正文里全是误判的下划线。
 */
export const FILE_EXT_DENY: ReadonlySet<string> = new Set([
  'md', 'markdown', 'txt', 'csv', 'tsv', 'json', 'jsonl', 'yaml', 'yml', 'toml',
  'xml', 'html', 'htm', 'php', 'js', 'jsx', 'ts', 'tsx', 'css', 'scss', 'less',
  'py', 'rb', 'go', 'rs', 'java', 'c', 'cpp', 'h', 'hpp', 'sh', 'bash', 'zsh',
  'ps1', 'sql', 'db', 'sqlite', 'git', 'log', 'ini', 'cfg', 'conf', 'env', 'dat',
  'bak', 'tmp', 'pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'zip', 'rar',
  '7z', 'tar', 'gz', 'tgz', 'bz2', 'exe', 'dll', 'apk', 'dmg', 'iso', 'img',
  'bin', 'png', 'jpg', 'jpeg', 'gif', 'svg', 'webp', 'bmp', 'ico', 'mp3', 'mp4',
  'mov', 'avi', 'mkv', 'webm', 'wav', 'flac', 'ttf', 'otf', 'woff', 'woff2',
  'eot', 'pem', 'key', 'crt', 'cer', 'lock', 'map',
]);

/**
 * 老项目 index.html:3651 `TLD_ALLOW`
 *
 * 🔴 裸域名必须命中这张表才当网址。**含中文 TLD**（「中国」「公司」「网络」）——
 *   这不是装饰：老项目正文是中文，`例子.中国` 在中文语境里应当是链接。
 *   漏掉这三条会让中文域名在中文笔记里全部失效（用户可见症状：自己的网址不亮）。
 */
export const TLD_ALLOW: ReadonlySet<string> = new Set([
  'com', 'cn', 'net', 'org', 'io', 'co', 'me', 'dev', 'app', 'gov', 'edu',
  'info', 'xyz', 'top', 'vip', 'cc', 'tv', 'ai', 'so', 'biz', 'pro', 'site',
  'online', 'shop', 'club', 'work', 'link', 'live', 'fun', 'store', 'tech',
  'space', 'website', 'email', 'wiki', 'blog', 'news', 'art', 'design', 'group',
  'ltd', 'plus', 'run', 'fit', 'ren', 'red', 'wang', 'xin',
  '中国', '公司', '网络',
]);

/**
 * 老项目 index.html:3858 `CJK` —— 字符类排除 CJK（汉字/中文标点/全角符号）。
 *
 * 🔴 这是老项目「I3」修复的核心：URL 在中文处即停。否则
 *   「看https://baidu.com。很好」里的「。很好」会被吞进链接文本与 href，
 *   用户点进去得到一个不存在的地址。
 */
const CJK = '\u2E80-\u9FFF\uF900-\uFAFF\u3040-\u30FF\uAC00-\uD7AF\uFF01-\uFF60\u3000-\u303F';

/** 老项目 index.html:3859 `urlTest` —— 只判「有没有」，用于早退与筛文本节点（无 g，无捕获组） */
export const urlTest = new RegExp(
  '(?:https?:\\/\\/|www\\.)[^\\s<' + CJK + ']+|(?:[a-z0-9-]+\\.)+[a-z]{2,}',
  'i',
);

/**
 * 老项目 index.html:3860 `urlRegex` —— 实际切分用。
 *
 * 🔴 前置 `(?<![@\w.-])` 排除邮箱域名段（`x@y.com`）与版本号中段（`v1.2.3`）被单独截出。
 * 🔴 裸域名分支额外允许 `(?:\/[^\s<CJK>]*)?` 把路径吃掉，所以 `example.com/a/b` 是**一条**链接。
 */
export const urlRegex = new RegExp(
  '(?<![@\\w.-])((?:https?:\\/\\/|www\\.)[^\\s<' + CJK + ']+' +
    '|(?:[a-z0-9-]+\\.)+[a-z]{2,}(?:\\/[^\\s<' + CJK + ']*)?)',
  'gi',
);

/** 老项目 index.html:3861 `longWordTest` */
export const longWordTest = /\S{15,}/;

/** 老项目 index.html:3862 `phoneTest` */
export const phoneTest = /(?<!\d)1[3-9]\d{9}(?!\d)/;

/** 老项目 index.html:3863 `phoneRegex` */
export const phoneRegex = /(?<!\d)(1[3-9]\d{9})(?!\d)/g;

/** 老项目 index.html:3864 `breakSeparators` */
export const breakSeparators = /([\/.?:=&#_%-])/g;

/**
 * 老项目 index.html:3709 `TIME_GUARD`
 *
 * 🔴🔴 ZWSP 绝不允许插进日期/时刻内部。**这条不能删**：老项目 v7.7.0 的教训是
 *   整串门控会在 `2026-09-15` 的 `-` 之后插 ZWSP，把时间串拦腰截断，
 *   于是时间解析全不命中 → 提醒被误删、正文退化成裸文本（用户报障）。
 */
const TIME_GUARD = /\d{4}[-\/年]\d{1,2}[-\/月]\d{1,2}日?(?:[T ]\d{1,2}[:：]\d{2}(?:[:：]\d{2})?)?|\d{1,2}[:：]\d{2}/g;

// ─────────────────────────────────────────────────────────────────────────
// 二、三个判定小函数（老项目 index.html:3652-3671）
// ─────────────────────────────────────────────────────────────────────────

/** 老项目 index.html:3652 `normalizeHref` —— 无 scheme 前缀则补 https:// */
export function normalizeHref(m: string): string {
  return /^[a-z]+:\/\//i.test(m) ? m : 'https://' + m;
}

/**
 * 老项目 index.html:3658 `denyAsUrl` —— 是否拒绝把这段匹配当链接
 *
 * 🔴🔴 第一条判据是**带 http(s):// 或 www. 前缀的一律不拒绝**，
 *   哪怕路径以 .md/.pdf/.js 结尾。否则 `https://github.com/a/b/README.md`、
 *   `cdn.jsdelivr.net/npm/vue.js` 都不再是链接 —— 用户会明确报「github 地址不亮」。
 *   老项目注释原文：「绝不能因为路径以 .md/.pdf/.js 结尾就毙掉」。
 */
export function denyAsUrl(m: string): boolean {
  if (/^(?:https?:\/\/|www\.)/i.test(m)) return false;
  const host = m.split('/')[0] ?? ''; // 只看 host 段，不看路径
  const tld = host.split('.').pop()?.toLowerCase() ?? '';
  if (FILE_EXT_DENY.has(tld)) return true; // README.md / file.txt 等文件名
  if (!TLD_ALLOW.has(tld)) return true; // 裸域名必须是已知 TLD
  return false;
}

/**
 * 老项目 index.html:3669 `trimUrlTrailing` —— 修剪 URL 尾部中文标点。
 *
 * 🔴 **只修中文标点，绝不动 ASCII 尾部**。保护
 *   `https://zh.wikipedia.org/wiki/条目_(消歧义)` 这类以 `)` 结尾的合法 URL。
 *   主防御是正则的 CJK 字符类（urlRegex），本函数覆盖粘贴旧内容等漏网场景。
 */
export function trimUrlTrailing(u: string): string {
  return u.replace(/[。，、！？；：…·～（）【】《》〈〉「」『』“”‘’—－]+$/, '');
}

// ─────────────────────────────────────────────────────────────────────────
// 三、分段结果
// ─────────────────────────────────────────────────────────────────────────

/** 片段种类。`text` = 普通文本；`url` / `phone` = 自动链接。 */
export type PartKind = 'text' | 'url' | 'phone';

export interface Part {
  kind: PartKind;
  /** 片段文本。`zwsp:true` 时含老项目回插的 ZWSP（与老项目 `<a>.textContent` 逐字一致）。 */
  t: string;
  /**
   * 该片段在**原文**（含零宽字符）里的起点偏移。
   *
   * 🔴🔴🔴 这个字段是**必须**的，不是冗余元数据：
   *   识别是在**剥掉零宽字符之后**的串上做的（否则 ZWSP 会截断 URL 匹配），
   *   于是 `parts[i].t` 的长度与原文里的对应区间**长度不同**。
   *   而 `TextNode.splitText` 切的是**原文**那个节点 ——
   *   拿 `parts[i].t.length` 去累加算切点会**整体错位**。
   *
   *   实测（.probe/probe-i.mjs / probe-g.mjs G7）：
   *     原文 `旧链接 https://exam\u200Bple.com 结束`（27 字）
   *     剥后 `旧链接 https://example.com 结束`（26 字）
   *     用剥后长度算切点 ⇒ 链接段切成 `https://exam\u200Bple.co`、
   *     尾巴 `m 结束` 留在外面，而 href 却是 `https://example.com`。
   *     症状：**链接文字与实际地址不一致**（点开是对的，但显示的地址是错的），
   *     且正文被切坏一截。用户完全看不出问题，只会觉得"这软件有点怪"。
   */
  srcStart: number;
  /** 该片段在原文里的结束偏移（不含）。 */
  srcEnd: number;
  /** kind==='url' 时为 normalizeHref 后的地址；kind==='phone' 时为 `tel:` + 原号。 */
  href?: string;
}

/** 一次识别命中的区间（对齐老项目 matches 数组的形状）。 */
interface Match {
  start: number;
  end: number;
  text: string;
  kind: 'url' | 'phone';
}

/**
 * 剥掉零宽字符。
 *
 * 🔴🔴🔴 **老项目真源就是含 ZWSP 的**：`linkifyEditor`（index.html:3949）在每次
 *   识别前对每个文本节点执行 `nodeValue.replace(/\u200B/g,'')`，而识别后又按
 *   `breakSeparators` 回插。也就是说 ZWSP 是老项目**持久留在正文数据里**的字符。
 *
 *   本项目的真源来自老项目迁移（export/copy.ts:37 的注释明确记了这件事），
 *   所以本函数读到的文本**必然可能含 ZWSP**。若不剥，
 *   `https://exam\u200Bple.com` 这类文本里插在词中的 ZWSP 会**切断** URL 正则的匹配
 *   （`example` 与 `.com` 之间断开），症状是"链接偶尔不亮"，且极难定位。
 *
 *   🔴 字符集与 serialize.ts:362 / export/copy.ts:65 **完全一致**（不只 U+200B）：
 *     少一个就有一类历史数据漏出去。
 */
export function stripZeroWidth(s: string): string {
  return s.replace(ZERO_WIDTH_GLOBAL, '');
}

/** 剥除用的全局正则（带 g，因为要 replace 全部）。 */
const ZERO_WIDTH_GLOBAL = /[\u200B\u200C\uFEFF\u2060]/g;
/** 剥除映射用的逐字符判定（无 g，避免 lastIndex 状态）。字符集与上面**必须一致**。 */
const ZERO_WIDTH_TEST = /[\u200B\u200C\uFEFF\u2060]/;

/** recognizeParts 的选项。 */
export interface RecognizeOptions {
  /**
   * 是否按老项目口径回插 ZWSP 断行符。默认 **false**（本项目生产口径，
   * 理由见文件头「二、ZWSP」）。置 true 得老项目逐字行为，供对拍与复刻老场景。
   */
  zwsp?: boolean;
}

/**
 * 老项目 index.html:3710-3719：按分隔符回插 ZWSP，并保护时间形态子串。
 */
function addZwsp(w: string): string {
  return w.replace(breakSeparators, '$1\u200B');
}

/** 老项目 index.html:3711-3719 `breakLongWords` —— 只在长词（≥15 连续非空白）内插 */
function breakLongWords(str: string): string {
  return str.replace(/\S{15,}/g, (w) => {
    let out = '';
    let last = 0;
    let t: RegExpExecArray | null;
    TIME_GUARD.lastIndex = 0;
    while ((t = TIME_GUARD.exec(w)) !== null) {
      out += addZwsp(w.slice(last, t.index)) + t[0];
      last = t.index + t[0].length;
    }
    return out + addZwsp(w.slice(last));
  });
}

/**
 * 🔴🔴 **核心**：把一段纯文本切成 `Part[]`。
 *
 * 这是老项目 `buildLinkSafe`（index.html:3684-3760）的逐句移植。四条优先级判据：
 *   1. **URL 优先于手机号**（老项目 3692-3697）：重叠时手机号让位。
 *   2. **denyAsUrl 命中的 URL 保持纯文本**（老项目 3740-3741）。
 *   3. **长词回插 ZWSP**（老项目 3720-3725），但时间形态子串内部不插。
 *      —— 仅 `zwsp: true` 时生效，见文件头「二、ZWSP」。
 *   4. **URL 文本可插 ZWSP、href 绝不插**（老项目 3745-3749）：
 *      href 混入 ZWSP 会让 href 变成一个打不开的地址。
 *
 * `remMatches`（提醒时间区间）是老项目 linkify 同轮重建 `<u class="rem-mark">` 的输入。
 * 本项目**不接**这个参数：提醒标记由 `reminder/reconcile.ts` 在**模型层**负责
 * （`span.rem` → ReminderMarkNode，见 nodes.ts），与链接识别是两条独立管线。
 * 混进这里会造出第二份提醒标记来源 —— 那是 reconcile.ts 文件头明令禁止的漂移来源。
 */
export function recognizeParts(text: string, opts: RecognizeOptions = {}): Part[] {
  const useZwsp = opts.zwsp === true;
  // 🔴 第一步剥 ZWSP（理由见 stripZeroWidth 注释）
  const src = stripZeroWidth(text);

  // 🔴🔴 剥除映射：src[i]（剥后串的第 i 个字符）↔ text[]（原文下标）。
  //   识别全在 src 上做（否则 ZWSP 截断 URL 匹配），但 Part 的偏移必须换算回
  //   **原文**坐标 —— 因为 TextNode.splitText 切的是原文那个节点。
  //   少这一步的后果见 Part.srcStart 的注释（链接文字与地址不一致 + 正文切坏）。
  const srcToOrig: number[] = new Array(src.length);
  {
    let si = 0;
    for (let oi = 0; oi < text.length && si < src.length; oi += 1) {
      const ch = text[oi]!;
      if (ZERO_WIDTH_TEST.test(ch)) continue; // 零宽字符在 src 里没有对应位置
      srcToOrig[si] = oi;
      si += 1;
    }
  }
  /** 剥后串的偏移 → 原文偏移。 */
  const toOrig = (i: number): number => (i >= srcToOrig.length ? text.length : (srcToOrig[i] ?? text.length));

  // ---- 收集 URL 命中（老项目 3686-3691）----
  const matches: Match[] = [];
  let m: RegExpExecArray | null;
  const re = new RegExp(urlRegex.source, urlRegex.flags);
  while ((m = re.exec(src)) !== null) {
    if (m[0].length === 0) {
      re.lastIndex++; // 零宽匹配防御（老项目 3688）
      continue;
    }
    const raw = trimUrlTrailing(m[0]);
    if (raw) matches.push({ start: m.index, end: m.index + raw.length, text: raw, kind: 'url' });
  }

  // ---- 收集手机号命中，重叠让位给 URL（老项目 3692-3697）----
  const rePhone = new RegExp(phoneRegex.source, phoneRegex.flags);
  while ((m = rePhone.exec(src)) !== null) {
    const s = m.index;
    const e = s + m[0].length;
    if (!matches.some((u) => s < u.end && e > u.start)) {
      matches.push({ start: s, end: e, text: m[0], kind: 'phone' });
    }
  }

  matches.sort((a, b) => a.start - b.start);

  // ---- 组装片段（老项目 3701-3759）----
  const parts: Part[] = [];
  const addText = (s: string, from: number, to: number): void => {
    if (!s) return;
    // 长词（≥15 连续非空白）在分隔符后插 ZWSP 以便换行（老项目 3722-3723）
    const t = useZwsp && /\S{15,}/.test(s) ? breakLongWords(s) : s;
    parts.push({ kind: 'text', t, srcStart: toOrig(from), srcEnd: toOrig(to) });
  };

  let pos = 0;
  for (const mt of matches) {
    addText(src.slice(pos, mt.start), pos, mt.start);
    if (mt.kind === 'url' && denyAsUrl(mt.text)) {
      addText(mt.text, mt.start, mt.end); // 文件名/未知裸域名：保持纯文本（老项目 3740-3741）
    } else if (mt.kind === 'url') {
      parts.push({
        kind: 'url',
        t: useZwsp ? addZwsp(mt.text) : mt.text,
        srcStart: toOrig(mt.start),
        srcEnd: toOrig(mt.end),
        href: normalizeHref(mt.text),
      });
    } else {
      parts.push({
        kind: 'phone',
        t: mt.text,
        srcStart: toOrig(mt.start),
        srcEnd: toOrig(mt.end),
        href: 'tel:' + mt.text,
      });
    }
    pos = mt.end;
  }
  addText(src.slice(pos), pos, src.length);
  return parts;
}

/**
 * 是否存在可被识别的文本（老项目 index.html:2634-2642 `hasLinkableText`）。
 *
 * 🔴 早退判据。**必须**用它，否则每次延迟到点都会遍历全篇并写一次 editor state：
 *   Lexical 里任何 `editor.update` 都会进 undo 快照，等于每1.5 秒污染一次撤销栈，
 *   用户的 Ctrl+Z 会先撤掉这些"什么都没做"的空转 —— 这是老项目用原生栈时踩过的坑
 *   （index.html:3905-3906 记着他们为此自建了撤销栈）。我们不该重蹈。
 *
 *   注意判据**不含** `denyAsUrl`：老项目同样如此。README.md 命中 urlTest 会让
 *   本轮不早退、进而进到分段里被 denyAsUrl 判为纯文本 —— 结果不变，只是多走一趟。
 *   照抄这个口径，不"优化"。
 */
export function hasLinkableText(parts: readonly string[]): boolean {
  for (const v of parts) {
    if (urlTest.test(v) || phoneTest.test(v) || longWordTest.test(v)) return true;
  }
  return false;
}
