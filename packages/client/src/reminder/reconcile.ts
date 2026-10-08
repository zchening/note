/**
 * 提醒对账 —— 从正文 + 既有 reminders 算出「最终应该是哪一组提醒」
 *
 * 🔴🔴 本文件是整个提醒功能的**唯一真源**。UI（下划线、删除线、响铃图标）、
 *   通知、列表，全都必须读这里算出的结果。各处自己算一遍必然漂移，
 *   而漂移的症状极其隐蔽：界面上还有下划线但通知不响，或反过来。
 *
 * 三条用户拍过板的红线（老项目 v5.46 / v6.3，移植时一字不改）：
 *
 *  1. **没主动加过的日期绝不动**。正文里写「3月1日开会」不会自动变提醒 ——
 *     必须用户在时间串上点「添加提醒」才进列表。否则笔记里每提一次日期
 *     就多一条闹钟，用两天就烦了。
 *  2. 短格式（无年份）**已过就是过期**，不给"顺延明年"兜底。
 *  3. 提醒的 `at` 存**完整带偏移的 ISO**，绝不存裸本地时间 ——
 *     换设备/跨时区时裸本地时间会静默偏移一小时。
 *
 * 另有一条我自己加的纪律：
 *  🔴 **删除要联动正文下划线**。用户删掉一条提醒，正文里那个下划线必须同时消失；
 *     反过来正文里删掉时间串，对应提醒也必须消失。任一方向漏掉，
 *     用户都会看到"删了还在"或"下划线没了但通知还响"。
 */

import { normalize, type Doc, type Reminder, type Span, type Block } from '@bj/shared-schema';
import { collectTimeMatches, parseTimeMatchesLong, type TimeMatch } from './time-parse.ts';

/** 提醒 id 生成：稳定、可排序、不依赖随机数。 */
export function makeRemId(at: number, seed: string): string {
  // 用时间戳 + 事项摘要的短哈希。同一时间同一事项 → 同一 id，
  // 于是"重载后下划线还在"是自然结果，而不是靠另存一份映射表。
  let h = 5381;
  for (let i = 0; i < seed.length; i += 1) h = ((h << 5) + h + seed.charCodeAt(i)) | 0;
  return `r${at.toString(36)}${(h >>> 0).toString(36)}`;
}

/** 从一段纯文本里取"事项"：时间串之后到下一个时间串之前的文字。 */
export function itemOf(text: string, m: TimeMatch, all: readonly TimeMatch[]): string {
  const next = all.find((x) => x.index > m.index);
  const end = next ? next.index : text.length;
  let s = text.slice(m.index + m.length, end);
  // 事项区以全角空格分隔（面板回写格式「YYYY-M-D H:MM　事项」），
  // 也允许普通空格/冒号/顿号 —— 但**只吃前导分隔符**，不砍中间的正文。
  s = s.replace(/^[　\s:：、，,。.\-—]+/, '').trim();
  // 🔴 剥离后如果只剩引号/括号一类**纯符号**，那不是事项，是代码/引文里的收尾。
  //   实测：`at = "3月1日10:00"` 会切出 `"\""` 这种碎片，出现在提醒列表里很难看。
  //   判据用"全是标点"而不是列举符号 —— 列举永远漏，且漏一个就复现。
  //   🔴 只在**整段都**是符号时丢弃：正文里"（改线上）"这种带字的是合法事项，不能误杀。
  if (s !== '' && /^[^\p{L}\p{N}]+$/u.test(s)) return '';
  return s;
}

/** 整篇文档的纯文本 + 每个块在全文里的偏移。 */
function flatten(doc: Doc): { text: string; blocks: Array<{ block: Block; start: number; end: number }> } {
  const parts: string[] = [];
  const blocks: Array<{ block: Block; start: number; end: number }> = [];
  let pos = 0;
  const walk = (list: readonly Block[] | undefined): void => {
    if (!list) return;
    for (const b of list) {
      const own = blockText(b);
      const start = pos;
      parts.push(own);
      pos += own.length + 1; // +1 是块间换行，与 flatten 的口径一致
      blocks.push({ block: b, start, end: start + own.length });
      walk(b.children);
    }
  };
  walk(doc.blocks);
  return { text: parts.join('\n'), blocks };
}

/** 一个块自己的纯文本。 */
export function blockText(b: Block): string {
  if (typeof b.text === 'string') return b.text;
  if (Array.isArray(b.spans)) return b.spans.map((s) => s.t).join('');
  if (Array.isArray(b.title)) return b.title.map((s) => s.t).join('');
  return '';
}

/** 全文所有 span。 */
function allSpans(doc: Doc): Span[] {
  const out: Span[] = [];
  const walk = (list: readonly Block[] | undefined): void => {
    if (!list) return;
    for (const b of list) {
      if (Array.isArray(b.spans)) out.push(...b.spans);
      if (Array.isArray(b.title)) out.push(...b.title);
      walk(b.children);
    }
  };
  walk(doc.blocks);
  return out;
}

export interface ReconcileOut {
  doc: Doc;
  /** 本次新增的提醒（用于弹通知） */
  added: Reminder[];
  /** 本次该判定为"已过期"的提醒 id */
  fired: string[];
  /** 本次因正文改动而消失的提醒 id */
  removed: string[];
}

/**
 * 对账：给定「本地真源」，算出该有的 reminders 与正文标记。
 *
 * @param now 可注入的时间（测试与"重放"用）
 */
export function reconcileReminders(doc: Doc, now: number = Date.now()): ReconcileOut {
  const existing = doc.reminders ?? [];
  const { text } = flatten(doc);

  // 全文所有时间串（含 index）。长文走分段版。
  const all = parseTimeMatchesLong(text, now);

  /* ---- 第一步：既有提醒里，哪些在正文里还找得到对应的时间串 ---- */
  const alive: Reminder[] = [];
  const removed: string[] = [];
  for (const r of existing) {
    const at = Date.parse(r.at);
    if (Number.isNaN(at)) {
      // 🔴 at 非法（数据坏了）→ 判死。留着它会让通知每次都 NaN 而静默不响，
      //   而用户完全看不出"有条提醒坏掉了"。
      removed.push(r.id);
      continue;
    }
    const still = all.some((m) => Math.abs(m.at - at) <= 1000);
    if (still) alive.push(r);
    else removed.push(r.id);
  }

  /* ---- 第二步：正文里已加过提醒的时间串，要挂上 rem 标记 ---- */
  // 🔴 span.rem 是**真源字段**（见 shared-schema/src/types.ts 的 Span.rem），
  //   不是派生视图。派生视图只在"由 reminders 反查该在哪画下划线"时才成立；
  //   而"哪段文字被标记了"这件事必须落在真源里，否则：
  //     - 换个客户端实现（老项目/MCP）就对不上位置
  //     - 合并时无法比较（两端的标记不一致会被当成内容差异，制造假冲突）
  const byAt = new Map<number, { id: string; done: boolean }>();
  for (const r of alive) {
    const at = Date.parse(r.at);
    // 🔴 done 判据 = **时间过了就画**（用户拍板 2026-10-08，不依赖是否推送成功）。
    //   老项目 v5.54 同款实时判断（index.html:3765「按时间实时判断，REM_DONE 已确认
    //   标记退役」）——「fired 要推送过才画」的旧口径随 REM_DONE 一起退役。
    byAt.set(at, { id: r.id, done: at <= now });
  }

  const nextDoc = structuredClone(doc) as Doc;
  markAll(nextDoc.blocks ?? [], 0, all, byAt);

  /* ---- 第三步：到点的提醒 ---- */
  const fired = alive.filter((r) => Date.parse(r.at) <= now).map((r) => r.id);

  /* ---- 第四步：提醒事项文本刷新（正文改了事项要跟着改） ---- */
  for (const r of alive) {
    const at = Date.parse(r.at);
    const m = all.find((x) => Math.abs(x.at - at) <= 1000);
    if (!m) continue;
    const it = itemOf(text, m, all);
    if (it !== '') r.text = it;
  }

  const out: Doc = { ...nextDoc };
  if (alive.length > 0) out.reminders = alive;
  else delete out.reminders;

  return {
    doc: normalize(out),
    added: [],
    fired,
    removed,
  };
}

/**
 * 给命中时间串的 span 打 rem 标记（就地改，作用于 cloned 文档）。
 *
 * 🔴 切分 span 是这里唯一 tricky 的地方：rem 标记落在**恰好覆盖时间串**的那段文字上，
 *   而一个 span 可能只被时间串盖住中间一部分（比如「会议 3月1日10:00 开始」里
 *   时间串跨了两个 span）。所以要按 [start,end) 把 spans 切开：
 *   前段留原样、中段挂 rem、后段另起一个。
 *
 * 标记**必须重新生成**而不是只补：正文改了以后原来的下标全错位，
 * 而残留的旧标记会让"这一段有下划线"出现在没有提醒的地方。
 */
function markAll(
  list: readonly Block[],
  baseOffset: number,
  all: readonly TimeMatch[],
  byAt: Map<number, { id: string; done: boolean }>,
): void {
  let off = baseOffset;
  for (const b of list) {
    const own = blockText(b);
    // 🔴🔴 时间串**必须完整落在本块内**才允许挂标记。
    //   flatten 用 '\n' 拼块，而中文日期正则里的 `\s*` 会吃掉换行 ——
    //   于是「3月1日」+ 换行 + 「10:00」两块会被拼成一段跨块时间串（index 0, length 10）。
    //   若只按 index 落在本块就标，结果是**第一块整段被划下划线**，而提醒文案却取自第二块。
    //   老项目没有这层"按块回填下划线"，直接对整段文本处理，所以它压根不存在这个问题；
    //   这是 flatten 引入的新风险，必须在这里显式挡住。
    //   判据用「起点在本块 且 终点也在本块」，而不是只看起点。
    const blockEnd = off + own.length;
    const inBlock = all.filter((m) => m.index >= off && m.index < blockEnd && m.index + m.length <= blockEnd);
    if (Array.isArray(b.spans) && inBlock.length > 0) {
      b.spans = markSpans(
        b.spans,
        inBlock.map((m) => {
          const ent = byAt.get(m.at);
          let end = m.index - off + m.length;
          // 🔴 老项目 v6.3（remMatchesFor，index.html:3779-3785）逐字口径：
          //   已过期 → 删除线覆盖「时间串 + 分隔符 + 事项（≤20 字）」**整段**，
          //   不只是时间串；未来 → 只包时间串。done 段与事项同进退，
          //   用户编辑事项文本后下次对账重算（markAll 每次全量重算，天然幂等）。
          if (ent?.done) {
            const tail = own.slice(end);
            const lead = (tail.match(/^[·\s\u3000]+/) || [''])[0].length;
            if (lead < tail.length) end += lead + Math.min(20, tail.length - lead);
          }
          return { start: m.index - off, end: Math.min(end, own.length), rem: ent?.id };
        }),
      );
    }
    off = blockEnd + 1;
    if (Array.isArray(b.children)) markAll(b.children, off, all, byAt);
  }
}

/** 把 cuts 位置切开并挂 rem。返回新数组（不改原数组）。 */
function markSpans(
  spans: readonly Span[],
  cuts: ReadonlyArray<{ start: number; end: number; rem: string | undefined }>,
): Span[] {
  const out: Span[] = [];
  let pos = 0;
  for (const s of spans) {
    const text = s.t;
    if (text.length === 0) {
      // 空 span 若是纯标记锚点，无处可挂 —— 直接丢（导出时 isEmptySpan 也会丢）
      continue;
    }
    // 本 span 内的切点（绝对 → 相对）
    const mine = cuts
      .map((c) => ({
        start: Math.max(0, c.start - pos),
        end: Math.min(text.length, c.end - pos),
        rem: c.rem,
      }))
      .filter((c) => c.end > c.start);
    if (mine.length === 0) {
      out.push({ ...s });
      pos += text.length;
      continue;
    }
    // 🔴 覆盖不全（本 span 有部分没被任何切点盖住）→ 保持原样不挂标记。
    //   把整段都挂上会让"会议 3月1日10:00 开始"整句都变下划线。
    const covered = mine.reduce((acc, c) => acc + (c.end - c.start), 0);
    if (covered < text.length) {
      // 只在切点范围内挂，其余原样
      let p = 0;
      for (const c of mine.sort((a, b) => a.start - b.start)) {
        if (c.start > p) out.push({ ...s, t: text.slice(p, c.start) });
        if (c.rem) out.push({ ...s, t: text.slice(c.start, c.end), rem: c.rem });
        else out.push({ ...s, t: text.slice(c.start, c.end) });
        p = c.end;
      }
      if (p < text.length) out.push({ ...s, t: text.slice(p) });
      pos += text.length;
      continue;
    }
    let p = 0;
    for (const c of mine.sort((a, b) => a.start - b.start)) {
      if (c.start > p) out.push({ ...s, t: text.slice(p, c.start) });
      if (c.rem) out.push({ ...s, t: text.slice(c.start, c.end), rem: c.rem });
      else out.push({ ...s, t: text.slice(c.start, c.end) });
      p = c.end;
    }
    if (p < text.length) out.push({ ...s, t: text.slice(p) });
    pos += text.length;
  }
  return out;
}

/**
 * 加一条提醒（用户在时间串上点了"添加提醒"）。
 * 🔴 只有这里能新增。理由：红线 1 说"没主动加过的绝不动"，
 *   而"主动"的唯一证据就是走过这个函数。
 */
export function addReminder(doc: Doc, atMs: number, text: string): { doc: Doc; rem: Reminder; rejected?: boolean } {
  // 🔴🔴 兜底闸门：任何入口的过去时间一律不设（老项目 index.html:7297-7299）。
  //   原注释「兜底闸门：任何入口的过去时间一律不设（chip/面板已各自拦，这里防漏网）」——
  //   chip 与面板各自拦只是 UI 层，**函数本身必须再拦一次**：
  //   chip 的时间串来自正文解析，正文里完全可以写一个昨天的时间再点它，
  //   那条路径不经过面板的 Date.now 校验。此前这道闸门整个漏了，
  //   于是点一下就能加出一条已过期的提醒，它会立刻进 dueReminders 触发响铃。
  //   🔴 rejected 显式回传而不是靠 id 哨兵值：UI 要靠它决定说哪句话
  //     （老项目那边是 showUploadStatus('已过去的时间不能设提醒') 后 return false），
  //     靠"返回的 rem.id 是空的"去推断，调用方迟早会漏判。
  if (atMs <= Date.now()) {
    return { doc, rem: { id: '', at: new Date(atMs).toISOString(), text }, rejected: true };
  }
  const at = new Date(atMs).toISOString();
  const rem: Reminder = { id: makeRemId(atMs, text), at, text };
  const list = [...(doc.reminders ?? [])];
  // 同一时刻的提醒不重复加（用户可能连点两下）
  if (list.some((r) => r.at === at)) {
    return { doc, rem: list.find((r) => r.at === at) as Reminder };
  }
  list.push(rem);
  list.sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  const out: Doc = { ...doc };
  if (list.length > 0) out.reminders = list;
  return { doc: normalize(out), rem };
}

/** 删一条提醒。🔴 必须同时清掉正文里引用它的标记。 */
export function removeReminder(doc: Doc, id: string): Doc {
  const list = (doc.reminders ?? []).filter((r) => r.id !== id);
  const out: Doc = structuredClone(doc) as Doc;
  const strip = (blocks: Block[] | undefined): void => {
    if (!blocks) return;
    for (const b of blocks) {
      if (Array.isArray(b.spans)) {
        // 🔴🔴 清**标记**，不是清**文字**。
        //   `rem` 是挂在 span 上的一个字段，而 span 本身承载的是"3月1日10:00"这段真实正文。
        //   正确做法：复制一份 span、只摘掉 rem 字段，文字必须原样留下。
        //   我第一版写成 `filter((s) => s.rem !== id)` —— 那是把整段文字删掉。
        //   症状：用户删一条提醒，正文里对应的时间串**永久消失**，而 canonical 一切正常、
        //   界面无任何报错（R5 实测捕到）—— 最坏的一类静默数据丢失。
        b.spans = b.spans
          .filter((s) => s.t !== '')            // 空壳锚点本来就该丢
          .map((s) => {
            if (s.rem !== id) return { ...s };
            const { rem: _dropped, ...rest } = s;
            return rest;
          });
      }
      strip(b.children);
    }
  };
  strip(out.blocks);
  if (list.length > 0) out.reminders = list;
  else delete out.reminders;
  return normalize(out);
}

/**
 * 按时刻删一条提醒（chip 确认卡上的「删除」钮走这条，老项目 index.html:6492 `removeReminder(at)`）。
 *
 * 🔴🔴 为什么需要它而不是复用 `removeReminder(doc, id)`：
 *   chip 上的删除钮手里只有 **at**（`chipDeleteAt = m.at`，老项目 :6384），
 *   没有 id —— id 是 `makeRemId(at, text)` 算出来的，而 chip 卡上不保存 text
 *   （text 是从正文时间串后面现算的 itemAfterMatch，与建提醒时用的 text 不一定同源）。
 *   拿不准 id 就不能删，否则会出现"点了删除但删不掉"或"删掉另一条"。
 *   判据：**at 精确相等**（都是 ISO 毫秒精度，同一时刻唯一）。
 *
 * 🔴 找不到就**原样返回 doc**：不抛错、不返回半成品。
 *   这是"删除"动作，重复点两次必须幂等 —— 抛错会让第二次点击把编辑器搞挂。
 */
export function removeReminderAt(doc: Doc, atMs: number): Doc {
  const at = new Date(atMs).toISOString();
  const hit = (doc.reminders ?? []).find((r) => r.at === at);
  if (!hit) return doc;
  return removeReminder(doc, hit.id);
}

/** 标记完成。done 不影响 at，也不影响正文。 */
export function completeReminder(doc: Doc, id: string): Doc {
  const list = (doc.reminders ?? []).map((r) => (r.id === id ? { ...r, done: true as const } : r));
  const out: Doc = { ...doc };
  if (list.length > 0) out.reminders = list;
  return normalize(out);
}

/** 到点或已过、且未完成的提醒（用来弹通知 / 列表打勾）。 */
export function dueReminders(doc: Doc, now: number = Date.now()): Reminder[] {
  return (doc.reminders ?? [])
    .filter((r) => r.done !== true && Date.parse(r.at) <= now)
    .sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
}

/** 未到点的提醒。 */
export function upcomingReminders(doc: Doc, now: number = Date.now()): Reminder[] {
  return (doc.reminders ?? [])
    .filter((r) => r.done !== true && Date.parse(r.at) > now)
    .sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
}

/** 重新导出以便外部直接用（测试与工具链用）。 */
export { collectTimeMatches };
