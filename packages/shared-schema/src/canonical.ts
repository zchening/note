/**
 * canonical 序列化 —— 真源唯一性由本文件保证，不靠人守纪律
 *
 * 四条规则（ARCH.md §4.1）：
 *  1. 键顺序按 schema 定义顺序（BLOCK_KEY_ORDER 等），不是字典序
 *  2. 值为默认值的字段一律省略（false/undefined/空数组不写）
 *  3. 无空格无缩进，UTF-8，数组顺序即文档顺序
 *  4. 序列化结果进密文
 *
 * 为什么必须是代码保证：老项目 44% 的 bug 来自"同一份内容有 N 种字符串表示"，
 * 被迫写 5 个等价性补丁函数逐个兜。canonical 化把这个 N 压回 1。
 */

import {
  BLOCK_KEY_ORDER,
  DOC_KEY_ORDER,
  REMINDER_KEY_ORDER,
  SPAN_KEY_ORDER,
  type Block,
  type Doc,
  type Reminder,
  type Span,
} from './types.ts';
import { ValidateError, validateDoc } from './validate.ts';

type Json = null | boolean | number | string | Json[] | { [k: string]: Json };

/** 拒绝类：一切"这份数据不可信"的信号。调用方只需 catch 这一个类型 */
export class NotCanonicalError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NotCanonicalError';
  }
}


/** 标记字段：只存 true，false 与 undefined 一律省略 */
function mark(v: boolean | undefined): true | undefined {
  return v === true ? true : undefined;
}

function str(v: string | undefined): string | undefined {
  return typeof v === 'string' && v !== '' ? v : undefined;
}

function spansJson(ss: Span[] | undefined): Json[] | undefined {
  if (!ss || ss.length === 0) return undefined;
  return ss.map(canonSpan);
}

function canonSpan(s: Span): Json {
  const o: Record<string, Json> = { t: s.t };
  for (const k of SPAN_KEY_ORDER) {
    if (k === 't') continue;
    const v = s[k];
    if (k === 'b' || k === 'i' || k === 'u' || k === 's' || k === 'c') {
      const m = mark(v as boolean | undefined);
      if (m !== undefined) o[k] = m;
    } else if (k === 'rem' || k === 'href') {
      const t = str(v as string | undefined);
      if (t !== undefined) o[k] = t;
    }
  }
  return o;
}

function blocksJson(bs: Block[] | undefined): Json[] | undefined {
  if (!bs || bs.length === 0) return undefined;
  return bs.map(canonBlock);
}

function canonBlock(b: Block): Json {
  const o: Record<string, Json> = { t: b.t };
  for (const k of BLOCK_KEY_ORDER) {
    if (k === 't') continue;
    switch (k) {
      case 'spans': {
        const v = spansJson(b.spans);
        if (v !== undefined) o.spans = v;
        break;
      }
      case 'title': {
        const v = spansJson(b.title);
        if (v !== undefined) o.title = v;
        break;
      }
      case 'text':
      case 'lang':
      case 'src':
      case 'imgAlt': {
        const v = str(b[k] as string | undefined);
        if (v !== undefined) o[k] = v;
        break;
      }
      case 'children': {
        const v = blocksJson(b.children);
        if (v !== undefined) o.children = v;
        break;
      }
    }
  }
  return o;
}

function canonReminder(r: Reminder): Json {
  const o: Record<string, Json> = { id: r.id, at: r.at, text: r.text };
  const d = mark(r.done);
  if (d !== undefined) o.done = d;
  return o;
}

/**
 * 文档 → canonical 字符串（无空格、UTF-8、键序固定）
 *
 * 输入允许稀疏（blocks / reminders 缺失或 undefined）—— canonicalize 同时是
 * "归一入口"，前端从任何地方拼出来的半成品对象都能安全过一遍。缺省即空数组。
 * 空数组在输出里一律省略（规则 2），所以 `{"v":1}` 就是空文档的唯一表示。
 */
export function canonicalize(doc: Doc): string {
  const o: Record<string, Json> = { v: doc.v };
  const bs = doc.blocks ?? [];
  const rs = doc.reminders ?? [];
  if (bs.length > 0) o.blocks = bs.map(canonBlock);
  if (rs.length > 0) o.reminders = rs.map(canonReminder);
  return JSON.stringify(o);
}

/**
 * 解析并要求"当且仅当 canonical"：
 *  1. 结构合法（validateDoc 负责，含引用完整性、深度上限、未知键拒绝）
 *  2. **normalize 之后**重新序列化与输入逐字节相等 —— 这条同时钉住键顺序、
 *     默认值省略、无空白，以及两条归一规则（相邻同格式 span 合并、空 p 块剔除）
 * 这是"接受当且仅当 canonical"的实现方式：不比较语义，比较字节。
 *
 * 🔴 判据必须走 normalize 而不是裸 canonicalize：归一规则是 canonical 的一部分，
 *   "未合并相邻 span" 的字节表示和 "已合并" 的语义相同但不是合法真源形态。
 *   早先这里用裸 canonicalize，于是 normalize 产出的文档反被 parseDoc 拒收 ——
 *   自己写的归一自己都不认，测试直接红两条。
 *
 * 顺序很重要：先 validate 再比字节。反过来的话，非法结构可能被"恰好字节相等"
 * 蒙混过关（例如 blocks 缺失时 canonicalize 输出 {"v":1}，与非法输入字节相同）。
 */
export function parseDoc(input: string): Doc {
  let raw: unknown;
  try {
    raw = JSON.parse(input);
  } catch {
    throw new NotCanonicalError('不是合法 JSON');
  }
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new NotCanonicalError('顶层必须是对象');
  }
  // validate 抛的是 ValidateError，不是 NotCanonicalError —— 统一包装，
  // 让调用方只需 catch 一种异常（"这份数据不可信"），错误码仍从 cause 里拿
  let doc: Doc;
  try {
    doc = validateDoc(raw);
  } catch (e) {
    if (e instanceof ValidateError) {
      throw new NotCanonicalError(`结构非法：${e.code} @ ${e.path}`);
    }
    throw e;
  }
  if (canonicalize(normalize(doc)) !== input) {
    throw new NotCanonicalError('非 canonical 表示（键顺序、默认值省略或空白不符合规范）');
  }
  return doc;
}

/**
 * 便捷：任意 Doc 归一（调用方手上若是从别处构造的对象，先过一遍）。
 *
 * 输出与 parseDoc 同构：blocks / reminders 一定是数组（空文档得到 [] 而非 undefined）。
 * 这一点必须与 parseDoc 一致，否则"同一份内容有两种内存形态"的老问题会在
 * 测试断言里反复咬人（第一版就因为这里不一致白红了两轮）。
 *
 * 🔴 归一还负责压掉"同一内容多种表示"（canonical 存在的唯一理由就在这里）：
 *
 *  1. **相邻同格式 span 合并**。`[{t:'A',b:true},{t:'B',b:true}]` 与 `[{t:'AB',b:true}]`
 *     逐字符读出来完全一样，但字节不同。两台设备只要在同一段文字上的切分粒度差一点
 *     （一个是从服务器拉来的、一个是本地重排过的），blockSig 就不同 → 判"这段两边都改过"
 *     → 一次纯噪音冲突。编辑器（Lexical）一定会把连续同格式 TextNode 合成一个，
 *     所以真源层不合并的话，**客户端导出的永远是合并后的、服务器存的可能没合并**，
 *     两端永远对不上。这条不是洁癖，是 S3-21 用例逼出来的。
 *
 *  2. **剔除空 `p` 块**（含 children 里的）。空段落 `{"t":"p"}` 在真源里"存在但没内容"，
 *     而编辑器永远需要多一个空段落当光标落点 —— 两边对"空段"的理解天生不一致：
 *     用户敲三个回车留下两个空行，服务端存了两个空 `p`，编辑器导出时那两个是"占位段落"
 *     会被丢，回来就少了两行。这与 ARCH §4.6「跨块退格 100 次无残留空块」是同一条纪律：
 *     空段落是**渲染层的落点**，不是**真源层的内容**。真源里表达"空"只有一个办法：
 *     整篇没有 `p` 块。
 *
 *  3. **合并相邻同类型列表**。Lexical 的 ListNode 有 transform 会把紧邻的同类型
 *     ul/ol 合成一个（源码里明确写了 "merges adjacent same-type lists"），
 *     所以编辑器侧结构上装不下"两个独立空列表"。真源层跟着合并，
 *     两端才对得上。这也是 S3-21 用例逼出来的：随机生成两个相邻空 ol 就会红。
 */
export function normalize(doc: Doc): Doc {
  const base = validateDoc(JSON.parse(canonicalize(doc)));
  // 🔴🔴 顺序铁律：**先合并相邻列表**（`dropEmptyChildArrays` 现在只做"删空 children 数组"，
  //   不再剔空 p，所以没有"剔掉中间空 p 让两个 ul 变相邻"这一步了）。
  //
  //   🔴 历史：这里曾是 `mergeAdjacentLists(stripEmptyParas(...))`，理由是
  //   "[ul[], p(空), ul] 剔掉中间的空 p 之后两个 ul 就变成相邻了"——
  //   顺序反过来会导致幂等性破掉。那条推理在"空 p 被剔除"的前提下成立；
  //   用户拍板方案 A（空段落进真源）后前提没了，而**两条路径曾经不一致**：
  //     canonicalize({v:1,blocks:[A, {t:'p'}, B]}) → **三块**（保留）
  //     normalize(同一份)                        → **两块**（剔掉）
  //   实锤症状：编辑器里 DOM 有 3 个 `<p>`（探针 probe-empty-para 实测），
  //   而真源只有 2 块 —— 因为 main.ts:1299 走的是 `normalize(lexicalToDoc(...))`。
  //   **同一份数据的"归一"与"规范化"给出两种答案**，本身就是 bug 的形状。
  //
  //   现在两边都保留空段落，于是顺序不再敏感：合并只在"真的相邻"时发生，
  //   中间隔着空 p 的两个 ul 保持分开（这正是用户敲那一行空行的意义）。
  const blocks = mergeAdjacentLists(dropEmptyChildArrays(base.blocks ?? []));
  const reminders = base.reminders ?? [];
  // 🔴 归一后的 `blocks` 可能是空数组，而 canonical 规则 2 要求空数组整个键不出现。
  //   这里必须用条件展开而不是 `blocks: [...]`：后者会产出一个"带空数组键"的非法真源
  //   （`parseDoc` 会拒它自己normalize 的输出，幂等性当场破掉）。
  //   `exactOptionalPropertyTypes` 下也不能写 `blocks: maybeEmpty`，那会留下 `undefined` 键。
  //
  // 🔴🔴 blocks 与 reminders 必须**各自独立判断**，不能合成一个三元。
  //   实锤：写成 `blocks.length || reminders.length ? {v, blocks, reminders} : {v}` 时，
  //   「blocks 非空 + reminders 为空」会产出一个**把空 reminders 塞回去**的形态 ——
  //   于是 normalize 的输出自己就不是 canonical 了（e2e 实测捕到：
  //   页面里的 JSON 带 `"reminders":[]`，判据 red）。
  //   这类"两个维度被捆在一起判断"的 bug 只在**恰好一个维度非空**时暴露，
  //   定向用例容易漏，必须靠 e2e 真数据兜住。
  const out: Doc = { v: base.v };
  if (blocks.length > 0) out.blocks = blocks;
  if (reminders.length > 0) out.reminders = reminders;
  return out;
}

/**
 * 递归**删空 children 数组**（canonical 规则 2：`{"t":"ul","children":[]}` 与 `{"t":"ul"}` 同形）。
 *
 * 🔴🔴 这里是原 `stripEmptyParas` 的**一半**，另一半（剔除空 p 块）已经删掉。
 *   历史与真因见 `normalize` 上面那段注释：`canonicalize` 一直保留空段落，
 *   只有 `normalize` 在剔，两条路径不一致 ⇒ 编辑器导出时丢空行（用户报障）。
 *   方案 A（用户拍板）落地后，两边统一为"保留"。
 *
 * 🔴 为什么"删空 children"这一半必须留着：它不是内容判断，是**形态归一**。
 *   与"空 p 是不是内容"完全无关 —— 空 children 是同一内容的两种写法，
 *   留着它就会出现同一内容两种合法字节，往返与冲突判定全乱。
 */
function dropEmptyChildArrays(bs: readonly Block[]): Block[] {
  const out: Block[] = [];
  for (const b of bs) {
    if (b.children !== undefined) {
      const kids = dropEmptyChildArrays(b.children);
      if (kids.length > 0) b.children = kids;
      else delete b.children;
    }
    out.push(b);
  }
  return out;
}

/**
 * 合并相邻同类型列表（ul 接ul、ol 接 ol），children 直接接起来。
 *
 * 🔴 只合并**同类型**：ul 紧邻 ol 在真源里是合法的两段（用户先列项目符号再列编号），
 *   Lexical 的 transform 也不合并异类型，所以不能顺手一起并 —— 那会改用户内容。
 * 递归处理 children：fold 里、li 里同样会撞上这个 transform。
 */
function mergeAdjacentLists(bs: readonly Block[]): Block[] {
  const out: Block[] = [];
  for (const b0 of bs) {
    // 先就地归一（fields 规范化 + 子树递归合并），再拿归一后的结果参与相邻合并。
    // 🔴 顺序不能反：第一版先把原样块 push 进 out 再合并，得到
    //   `ul[ol, ol]`（内层两个相邻 ol 没被合并），
    //   第二轮 normalize 才把内层合掉 —— 于是 normalize 不幂等，
    //   parseDoc(canonicalize(normalize(d))) 与 normalize(d) 深比较当场红。
    //   归一必须**一轮到位**：任何一层都在同一次调用里被合并干净。
    const b = normalizeBlock(b0);
    const prev = out[out.length - 1];
    if (prev !== undefined && prev.t === b.t && (prev.t === 'ul' || prev.t === 'ol')) {
      // 🔴 合并 children 后必须**就地再扫一遍**：join 本身会造出新的相邻同类型列表
      //   （两个 ul 各带一个 ol → join 后变成 ul[ol, ol]），而这两个 ol 从没一起走过
      //   合并判定。只 push 不重扫的话，normalize 第一轮留下 ul[ol, ol]，
      //   第二轮才合掉 —— 幂等性破掉，且 parseDoc 会拒收自己刚产出的形态。
      const joined = [...(prev.children ?? []), ...(b.children ?? [])];
      const mergedKids = mergeAdjacentLists(dropEmptyChildArrays(joined));
      if (mergedKids.length > 0) prev.children = mergedKids;
      else delete prev.children;
      continue;
    }
    out.push(b);
  }
  return out;
}

/** 合并 span 数组里相邻且格式完全相同的项（格式含 rem/href，两者不同就不能合） */
function coalesceSpans(ss: readonly Span[]): Span[] {
  if (ss.length < 2) return ss.slice();
  const out: Span[] = [];
  for (const s of ss) {
    const last = out[out.length - 1];
    if (last !== undefined && sameSpanFormat(last, s)) {
      last.t += s.t;
      continue;
    }
    out.push({ ...s });
  }
  return out;
}

function sameSpanFormat(a: Span, b: Span): boolean {
  if ((a.rem ?? '') !== (b.rem ?? '')) return false;
  if ((a.href ?? '') !== (b.href ?? '')) return false;
  for (const k of SPAN_KEY_ORDER) {
    if (k === 't' || k === 'rem' || k === 'href') continue;
    if ((a[k] === true) !== (b[k] === true)) return false;
  }
  return true;
}

/**
 * 🔴 溯源：这里原有 `isEmptyPara(b)`（`t==='p'` 且无任何非空 span），配合
 *   `stripEmptyParas` 在 `normalize` 里递归剔除空段落。
 *
 *   用户拍板方案 A（空段落进真源）后**已删除**，理由与影响：
 *   - 缺陷：只有 `normalize` 剔、`canonicalize` 不剔 ⇒ 同一份数据两种归一结果，
 *     而编辑器导出走的正是 `normalize(lexicalToDoc(...))` ⇒ **用户敲的空行永久消失**
 *     （探针 probe-empty-para 实锤：DOM 三个 `<p>`、真源两个块）。
 *   - 删除理由不是"不再需要判断空段落"，而是**这个判断本身是错的**：
 *     它把"用户敲出来的空行"与"编辑器为了落光标而存在的空占位"当成同一件事，
 *     而后者要靠 `serialize.ts` 的 `trimTrailingEmptyParas` 在**导出侧**处理，
 *     不能在真源层做 —— 真源层分不清"这一行是用户留的"还是"占位"。
 *   - 附带的"只认 p，h3/quote 的空壳是合法块"这条洞察仍然成立，
 *     但现在它体现在 `dropEmptyChildArrays` 只动 children、不动块本身。
 *
 *   ⚠️ 别把这段溯源当成"可以重新引入空段落剔除"的许可：
 *   若将来又要剔，判据必须落在导出侧且只剔尾部，不能回到真源层递归剔。
 */

function normalizeBlock(b: Block): Block {
  const out: Block = { t: b.t };
  for (const k of BLOCK_KEY_ORDER) {
    if (k === 't') continue;
    const v = b[k];
    switch (k) {
      case 'spans': {
        // 空数组省略：与 children 同理，normalize 不负责凭空造空数组，也不留下空数组
        if (v !== undefined) {
          const ss = coalesceSpans(v as Span[]);
          if (ss.length > 0) out.spans = ss;
        }
        break;
      }
      case 'title': {
        if (v !== undefined) {
          const ss = coalesceSpans(v as Span[]);
          if (ss.length > 0) out.title = ss;
        }
        break;
      }
      case 'text':
      case 'lang':
      case 'src':
      case 'imgAlt': {
        if (typeof v === 'string' && v !== '') (out as unknown as Record<string, unknown>)[k] = v;
        break;
      }
      case 'children': {
        // 与顶层同一套顺序：先剔空 p，再合并相邻列表。空数组省略 ——
        // 真源里"没有这个字段"只有一种表示：键不存在。
        if (v !== undefined) {
          const kids = mergeAdjacentLists(dropEmptyChildArrays(v as Block[]));
          if (kids.length > 0) out.children = kids;
        }
        break;
      }
    }
  }
  return out;
}

/**
 * 块签名（合并对齐用）= 该块自身的 canonical JSON。
 *
 * 为什么不用「类型 + 纯文本」这种摘要：img 块纯文本是空串，两张不同的图摘要相同，
 * 会被误判成「这块没变」而静默丢掉一边的改动。直接用 canonical 是唯一无损的做法，
 * 代价只是签名长一点（合并只在本地跑，不在渲染热路径上）。
 */
export function blockSig(b: Block): string {
  return JSON.stringify(canonBlock(b));
}
