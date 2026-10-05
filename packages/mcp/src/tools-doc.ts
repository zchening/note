/**
 * 文档操作工具 —— locate / read / edit / search。
 *
 * 🔴🔴 这里的编辑对象是**模型 JSON（Doc）**，不是 HTML。
 *   老项目那些"按纯文本偏移插删""删除区间不许跨结构边界""先转义再在HTML 源串里找
 *   锚点"的规则，**一条都不适用于模型 JSON** —— 那套规则存在的原因是
 *   HTML 是无结构的字符串，插一行要重新拼字符串、切偏移还得担心切坏标签。
 *   模型 JSON 里正文是块数组，追加就是 push 一个 {t:'p'}，定位就是找块的索引，
 *   没有"切坏标签"这种失败模式。
 *
 *   代价是**行为与老项目不同**：老项目 `position` 是"纯文本可见字符偏移"，
 *   新项目按块操作（block 序号）。这属于用户不可见层的实现差异，
 *   但它会体现在 MCP 的入参上，所以工具 description 里写清楚。
 */
import { canonicalize, blockText, emptyDoc } from '@bj/shared-schema';
import type { Block, Doc, Span } from '@bj/shared-schema';
import type { Vault } from './vault.ts';
import { assertId } from './config.ts';

export interface ToolCtx {
  vault: Vault;
  defaultNote: string;
  /** 列出全部已知笔记名（注册表） */
  listNames: () => string[];
  /** 搜索用：按名字取纯文本 */
  plainTextOf: (id: string) => Promise<{ text: string } | null>;
}

/* ---------------- note_locate ---------------- */

export interface LocateArgs {
  name?: string;
  verify_decrypt?: boolean;
}

export async function toolLocate(ctx: ToolCtx, args: LocateArgs): Promise<unknown> {
  const name = assertId(args.name || ctx.defaultNote);
  const note = await ctx.vault.load(name).catch((e: unknown) => ({ err: e }));
  if (note && 'err' in note) {
    // 🔴 locate 是**唯一**的软失败工具：查不到不是错，要把状态说出来。
    //   老项目同款。用户（AI）拿到 exists:false 会去建新笔记，
    //   拿到报错则会以为服务坏了。
    return { exists: false, name, error: note.err instanceof Error ? note.err.message : String(note.err) };
  }
  if (note === null) return { exists: false, name };
  return {
    exists: true,
    name,
    chars: canonicalize(note.doc).length,
    blocks: (note.doc.blocks ?? []).length,
    reminders: (note.doc.reminders ?? []).length,
    //🔴 没有版本号可报：新服务端 last-write-wins，不返回 v。
    //   报一个编造的"v"会让调用方拿它做条件判断，然后莫名其妙地跳过写入。
    bytes: note.bytes,
  };
}

/* ---------------- note_read ---------------- */

export interface ReadArgs {
  name?: string;
  format?: 'text' | 'json' | 'markdown';
}

export function plainOf(doc: Doc): string {
  const out: string[] = [];
  const walk = (list: readonly Block[] | undefined, depth: number): void => {
    if (!list) return;
    for (const b of list) {
      switch (b.t) {
        case 'hr':
          out.push('---');
          break;
        case 'img':
          out.push(b.src ? `![${b.imgAlt ?? ''}](${b.src})` : '');
          break;
        case 'code':
          out.push('    ' + String(b.text ?? '').replace(/\n/g, '\n    '));
          break;
        case 'fold':
          out.push('▸ ' + spansText(b.title));
          walk(b.children, depth + 1);
          break;
        case 'ul':
        case 'ol':
          walk(b.children, depth);
          break;
        case 'li':
          out.push('  '.repeat(Math.max(0, depth)) + '- ' + spansText(b.spans));
          walk(b.children, depth + 1);
          break;
        default:
          out.push(spansText(b.spans));
      }
    }
  };
  walk(doc.blocks, 0);
  return out.join('\n');
}

function spansText(ss: readonly Span[] | undefined): string {
  if (!ss) return '';
  let s = '';
  for (const sp of ss) s += sp.t === 'br' ? '\n' : sp.t;
  return s;
}

export async function toolRead(ctx: ToolCtx, args: ReadArgs): Promise<unknown> {
  const name = assertId(args.name || ctx.defaultNote);
  const format = args.format ?? 'text';
  if (format !== 'text' && format !== 'json' && format !== 'markdown') {
    throw new Error('format 只支持 text | json | markdown');
  }
  const note = await ctx.vault.load(name);
  if (note === null) throw new Error(`笔记不存在：${name}（可先用 note_locate 确认）`);
  if (format === 'json') {
    return { name, format, doc: note.doc, canonical: canonicalize(note.doc) };
  }
  const text = plainOf(note.doc);
  if (format === 'markdown') {
    return { name, format, markdown: text, reminders: (note.doc.reminders ?? []).map(remLine) };
  }
  return { name, format, text, reminders: (note.doc.reminders ?? []).map(remLine) };
}

function remLine(r: { at: string; text: string; done?: true }): string {
  return `${r.at.replace('T', ' ').slice(0, 16)}${r.done ? '（已完成）' : ''}${r.text ? ' ' + r.text : ''}`;
}

/* ---------------- note_edit ---------------- */

export interface EditArgs {
  name?: string;
  op: 'append' | 'insert_before' | 'insert_after' | 'replace' | 'delete' | 'prepend';
  /** append/prepend/insert_*: 要写入的纯文本（一行）。会转成 p 块 */
  text?: string;
  /** 锚点：insert_before / insert_after / delete 用，纯文本子串 */
  match?: string;
  /** replace: 整篇新正文（一行一段） */
  body?: string;
  /** 标题级别：写入时用 h1/h2/h3，默认 p */
  heading?: 'p' | 'h1' | 'h2' | 'h3';
}

/**
 * 编辑正文。
 *
 * 🔴 定位用**纯文本子串**而不是字符偏移 —— 字符偏移在模型 JSON 里没有稳定含义
 *   （改一段话，后面所有偏移全变），而子串锚点是用户/AI 真正说得出口的东西。
 *   命中多处时**报错并列出处数**，绝不猜第一个：猜错的后果是改到了别的地方，
 *   而 AI 会以为成功了。
 */
export async function toolEdit(ctx: ToolCtx, args: EditArgs): Promise<unknown> {
  const name = assertId(args.name || ctx.defaultNote);
  const ops = ['append', 'prepend', 'insert_before', 'insert_after', 'replace', 'delete'];
  if (!ops.includes(args.op)) throw new Error('op 只支持 ' + ops.join(' | '));
  const note = await ctx.vault.load(name);
  if (note === null && args.op !== 'append' && args.op !== 'prepend' && args.op !== 'replace') {
    throw new Error(`笔记不存在：${name}，无法在它里面插入或删除`);
  }
  const doc: Doc = note === null ? emptyDoc() : note.doc;
  const blocks = [...(doc.blocks ?? [])];

  const mkBlock = (text: string): Block => {
    const t = args.heading ?? 'p';
    return { t, spans: text === '' ? [] : [{ t: text }] } as Block;
  };

  switch (args.op) {
    case 'append':
    case 'prepend': {
      const text = String(args.text ?? '').replace(/\r/g, '');
      if (text === '') throw new Error('text 为空，没有可写入的内容');
      const parts = text.split('\n').map(mkBlock);
      blocks.splice(args.op === 'prepend' ? 0 : blocks.length, 0, ...parts);
      break;
    }
    case 'replace': {
      const body = String(args.body ?? '').replace(/\r/g, '');
      blocks.splice(0, blocks.length, ...(body === '' ? [] : body.split('\n').map(mkBlock)));
      break;
    }
    case 'insert_before':
    case 'insert_after':
    case 'delete': {
      const anchor = String(args.match ?? '');
      if (anchor === '') throw new Error('这类操作必须给 match（锚点纯文本子串）');
      const flat = blocks.map((b) => blockText(b));
      const hits: number[] = [];
      for (let i = 0; i < flat.length; i += 1) {
        if (flat[i].includes(anchor)) hits.push(i);
      }
      if (hits.length === 0) {
        throw new Error(`锚点未命中任何一行：${JSON.stringify(anchor)}`);
      }
      if (hits.length > 1) {
        //🔴 歧义必须拒。猜第一个 = 改错地方还报成功，这类"静默改错"最难自查。
        throw new Error(
          `锚点在 ${hits.length} 行里都出现（块序号 ${hits.join(', ')}），无法确定改哪一处。` +
            '请给更长的锚点文本，或先用 note_read 看清结构。',
        );
      }
      const i = hits[0];
      if (args.op === 'delete') blocks.splice(i, 1);
      else {
        const text = String(args.text ?? '').replace(/\r/g, '');
        if (text === '') throw new Error('text 为空，没有可写入的内容');
        blocks.splice(args.op === 'insert_before' ? i : i + 1, 0, ...text.split('\n').map(mkBlock));
      }
      break;
    }
  }

  const next: Doc = { ...doc, blocks };
  const r = await ctx.vault.save(name, next);
  return {
    ok: true,
    name,
    op: args.op,
    blocks: next.blocks?.length ?? 0,
    chars: r.chars,
    preview: plainOf(next).slice(0, 160),
  };
}

/* ---------------- note_search ---------------- */

export interface SearchArgs {
  query: string;
  names?: string[];
  limit?: number;
}

/**
 * 全文检索。
 *
 * 🔴🔴 与老项目最刺眼的差别：**不再有"本机加密倒排索引"**。
 *   老项目每次 search 对 N 篇笔记要发 2N 个 HTTP，且落一份索引到磁盘 ——
 *   那套东西要处理"索引过期""增量重建""索引密钥与笔记盐不同"三类问题，
 *   而它的唯一收益是省 HTTP。
 *   新项目服务端零索引、笔记数量在个人使用量级（几十篇），
 *   所以直接"每篇拉一次 + 内存比对"，结果永远与远端一致，
 *   不存在索引过期这个失败模式。**用"可能陈旧"换"一定正确"是对的取舍。**
 *
 *   顺带解决老项目的一个真 bug：`indexed = names.length - fresh - stale`
 *   在计数不对称时会是负数。
 */
export async function toolSearch(ctx: ToolCtx, args: SearchArgs): Promise<unknown> {
  const q = String(args.query ?? '').trim();
  if (q === '') throw new Error('query 为空');
  const names = (Array.isArray(args.names) && args.names.length > 0 ? args.names : ctx.listNames())
    .map((n) => assertId(n));
  if (names.length === 0) {
    throw new Error('没有可检索的笔记：注册表是空的。用 note_read / note_edit 打开过某篇后它会自动入册。');
  }
  const limit = Math.min(20, Math.max(1, Math.floor(Number(args.limit ?? 5))));

  const terms = tokenize(q);
  const results: Array<{ name: string; hits: number; snippets: Array<{ offset: number; text: string }> }> = [];
  let failed = 0;
  for (const name of names) {
    let text: string;
    try {
      const r = await ctx.plainTextOf(name);
      if (r === null) continue;
      text = r.text;
    } catch {
      // 🔴 单篇失败（多半是口令不对）**不中断整批** ——
      //   中断的话，一次坏笔记会让"搜任何东西"都失败。
      failed += 1;
      continue;
    }
    const lower = text.toLowerCase();
    let all = true;
    let hits = 0;
    const offsets: number[] = [];
    for (const t of terms) {
      const from = 0;
      let pos = lower.indexOf(t, from);
      let n = 0;
      while (pos >= 0) {
        n += 1;
        if (offsets.length < 200) offsets.push(pos);
        pos = lower.indexOf(t, pos + Math.max(1, t.length));
        if (n > 999) break;
      }
      if (n === 0) {
        all = false;
        break;
      }
      hits += n;
    }
    if (!all) continue;
    //🔴🔴 二元组只是**粗筛**，必须再做子串校验才能算命中。
    //   "会议" 的二元组是 "会议"，但"协商"里也有"商会"… 反过来更常见：
    //   搜"会议"会命中"协同会议纪要"（对）也会命中"商会协议"（错）——
    //   只要任一粗筛词元命中就算all，而二元组天然会跨词误命中。
    //   真正的判据是**用户自己打的那串字**是否原样出现在纯文本里。
    //   老项目也做二次校验，但它校验的是"任一 CJK 连续段/词元"，
    //   我们这里更严：直接校验 query 原串（空格分隔时任一段即可）。
    if (!queryHit(lower, q)) continue;
    const at = lower.indexOf(q);
    const first = at >= 0 ? at : Math.min(...offsets);
    const start = Math.max(0, first - 30);
    const end = Math.min(text.length, first + q.length + 40);
    results.push({
      name,
      hits,
      snippets: [
        {
          offset: first,
          text: (start > 0 ? '…' : '') + text.slice(start, end) + (end < text.length ? '…' : ''),
        },
      ],
    });  }
  results.sort((a, b) => (b.hits - a.hits) || a.name.localeCompare(b.name));
  return { results: results.slice(0, limit), scanned: names.length, failed };
}

/**
 * 命中判据：query 按空格分成若干段，**任一段原样出现**即算命中。
 *
 * 🔴 为什么是"原样"而不是"词元"：二元组/词元是为**缩小候选集**设计的粗筛，
 *   它一定会误命中（搜"会议"会撞上"商会协议"）。真判据必须是用户自己打的那串字。
 *   代价是搜"会议纪要 2026"这种多词时要求任一段命中即可（OR 语义），
 *   这与老项目 description 里承诺的"空格分隔多词任一命中即返回"一致。
 */
export function queryHit(lowerText: string, q: string): boolean {
  const parts = q.split(/\s+/).filter((s) => s !== '');
  if (parts.length === 0) return false;
  return parts.some((p) => lowerText.includes(p.toLowerCase()));
}

/** 分词：中文按二元组、拉丁按整词。空格分隔的多词是 OR（任一命中即返回）。 */
export function tokenize(q: string): string[] {
  const out: string[] = [];
  const segs = q.match(/[一-鿿]+|[A-Za-z0-9_]+/g) ?? [];
  for (const seg of segs) {
    if (/^[一-鿿]/.test(seg)) {
      if (seg.length === 1) out.push(seg);
      else for (let i = 0; i + 1 < seg.length; i += 1) out.push(seg.slice(i, i + 2));
    } else {
      out.push(seg.toLowerCase());
    }
  }
  // 🔴 单个二元组不足以判命中（"会议"会命中"协商"），
  //   真正判命中的是下面plainOf 之后的子串校验—— 这里只做粗筛。
  return [...new Set(out)];
}
