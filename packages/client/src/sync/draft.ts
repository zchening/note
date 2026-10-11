/**
 * 离线草稿 —— 纯本地加密的"最后一道底线"
 *
 * ═══════════════════════════════════════════════════════════════════════
 * 这个模块守的是什么
 * ═══════════════════════════════════════════════════════════════════════
 *
 * 编辑器里的正文在**推送成功之前**只活在这一份草稿里：断电、被系统杀掉后台、
 * 断网一小时、推到一半失败——这些场景全都由它兜住。所以它有三条不能退的红线：
 *
 *  1. **正文永不出 WebCrypto**：草稿用**同一把会话密钥**加密后才落 localStorage。
 *     落在盘上的只有密文，零知识性质与真信封同一档（见 DR-16）。
 *  2. **任何存储异常都不许冒泡**：配额满、隐私模式、密文损坏 ⋯ 全都静默降级。
 *     为"存草稿"这件增强项崩掉编辑主流程是本末倒置（local-cache.ts 同款纪律）。
 *  3. **草稿条挂起期间绝不清草稿**：用户还没在「保留本机 / 使用云端」里做选择，
 *     任何代码路径都不许把记录删掉。这条由 `clearDraft` 的**形状**保证（下面）。
 *
 * ═══════════════════════════════════════════════════════════════════════
 * 为什么 bj 不需要独立的 REM_DRAFT
 * ═══════════════════════════════════════════════════════════════════════
 *
 * 老项目的提醒是 DOM 里的 `<rem>` 标记，正文是 HTML，两套东西各自有草稿，
 * 于是才有 REM_DRAFT 与正文草稿同步的额外复杂度。bj 的**提醒是真源的一部分**
 * （`doc.reminders`，见 shared-schema/types.ts），所以：
 *
 *     一份加密的 canonical 草稿 = 正文 + 提醒，一起兜住。
 *
 * 判据 DR-05 专门钉这一条：只改提醒也必须判冲突。
 *
 * ═══════════════════════════════════════════════════════════════════════
 * 🔴 密钥策略：本模块**不持有** CryptoKey，每次调用显式传进来
 * ═══════════════════════════════════════════════════════════════════════
 *
 * 理由：`main.ts:2990` 的 `currentDk` 注释记的就是这个坑——模块级长期持有密钥时，
 * 切笔记的 `await` 间隙里任何一次操作都可能拿着**上一篇的密钥**去加密这一篇，
 * 症状是"云端再也解不开，且零报错"。
 *
 * 本模块把所有调用收成 `DraftCtx = { noteId, dk }`，密钥**用完即走**，
 * 不进任何模块级变量。于是"用哪把钥匙"永远只有一个来源：调用现场的那一行。
 *
 * ═══════════════════════════════════════════════════════════════════════
 * 🔴🔴 为什么 `clearDraft()` 只在"未挂起"时生效
 * ═══════════════════════════════════════════════════════════════════════
 *
 * 推送成功的回调是在 **SSE/poll 线程**上跑的，它不知道屏幕上正挂着一条
 * 「保留本机 / 使用云端」。如果 `clearDraft()` 无条件删，就出现：
 *   推送成功（推的是**云端版**）→ 草稿被删 → 用户点「保留本机」→ 内容已经没了。
 * 这是老项目踩过的丢失红线，且**零报错**。
 *
 * 所以这里用 **API 形状**而不是"调用方记得先检查"来兜：
 *   - `restoreDraftIfNeeded()` 返回 conflict 时把该笔记置为 `pending`；
 *   - `pending` 期间 `clearDraft()` 返回 `false` 且**什么都不做**；
 *   - 只有 `applyDraft()`（保留本机）/ `discardDraft()`（使用云端）能解除 pending；
 *   - 真要强删必须显式写 `clearDraft(id, { force: true })` —— 写这个词的时候
 *     人会被迫想一遍"我真的可以丢吗"。
 *
 * `isDraftPending()` 是给调用方查状态的只读钩子（决定要不要显示那条草稿条）。
 *
 * ═══════════════════════════════════════════════════════════════════════
 * ⚠️ baseRev 的口径（诚实边界）
 * ═══════════════════════════════════════════════════════════════════════
 *
 * 老项目用自增的 `localVer`（HTML 版本号）当草稿的 base。
 * **bj 没有这个东西**：`diag/lines.ts:69` 写得很明白——
 * "bj 真源只有 schema 版本 Doc.v，没有本地内容版本号（三方合并靠 base 文档而非
 * localVer 自增）"。SyncClient 判"内容是不是真变了"用的是
 * `canonicalize(prev) !== canonicalize(doc)`（sync/client.ts:1337）。
 *
 * 所以本模块**不对 baseRev 的语义做任何假设**：原样存档、原样带出、只做往返保真。
 * 它到底代表什么（本地提交计数 / 时间戳 / something else）由调用方决定，
 * 接线示例见本仓交付说明。模块能保证的只有一件事：写进去的那个数会被原样读出来。
 */

import {
  canonicalize,
  decryptString,
  encryptString,
  normalize,
  parseDoc,
  type DerivedKey,
  type Doc,
  type Envelope,
  type KdfParams,
} from '@bj/shared-schema';

/* ---------------- 键名 ---------------- */

/** localStorage 键。按 noteId 隔离——一份草稿只对一篇笔记有意义。 */
export const draftKeyOf = (noteId: string): string => `notesync_bj_draft_${noteId}`;

/* ---------------- 落盘形态 ---------------- */

/**
 * 盘上的一条草稿记录。
 *
 * 只有五个字段是刻意的：`ct`/`iv`/`kdf` 是信封的三件套（缺一样将来就没法换算法），
 * `baseRev` 见顶部口径说明，`at` 给"这份草稿多老了"的判断留依据（目前不参与决策）。
 *
 * 🔴 `kdf` 里带的是**该笔记密钥派生时的 salt**。它同时也存在于服务端信封与本地缓存
 *   （`local-cache.ts` 的 `CachedEnvelope.salt`），所以写进草稿**不新增暴露面**。
 */
export interface DraftRecord {
  ct: string;
  iv: string;
  kdf: KdfParams;
  baseRev: number;
  at: number;
}

/* ---------------- 会话态 ---------------- */

/**
 * 调用现场。**每次调用都显式传**，模块不缓存 `dk`（见顶部"密钥策略"）。
 */
export interface DraftCtx {
  /** 笔记 id —— 草稿按它隔离 */
  noteId: string;
  /** 本次会话这一篇的派生密钥（含不可导出的 CryptoKey） */
  dk: DerivedKey;
}

/** 解出来的草稿内容。 */
export interface DraftContent {
  doc: Doc;
  baseRev: number;
  at: number;
}

/**
 * 恢复结果。
 *  - `none`：没有草稿 / 草稿已无意义 / 草稿解不开（都已被静默清掉）
 *  - `conflict`：草稿与云端不同，需要用户选「保留本机 / 使用云端」
 */
export type RestoreResult = { kind: 'none' } | { kind: 'conflict'; doc: Doc; baseRev: number };

/**
 * 每篇笔记的内存会话态。
 *
 * 🔴 为什么不放在模块级单个变量：那样"切笔记忘了 reset"就会让下一篇读到上一篇的
 *   `lastCanonical`，于是"这篇的第一句话恰好和上一篇草稿一样"⇒ 判定未变 ⇒ 不写盘，
 *   且零报错。按 noteId 存 Map 让这个 bug 形状**不可能发生**：
 *   不调 `resetDraftSession()` 也只是多占一点内存，不会串味。
 */
interface NoteDraftState {
  /** 上一次真正写盘的 canonical；用于"内容真变了才写"的短路 */
  lastCanonical: string | undefined;
  /** 上一次记账的内容，`flushDraft()` 靠它在零实参的情况下重写一次 */
  lastDoc: Doc | undefined;
  lastBaseRev: number | undefined;
  /** 🔴 草稿条是否在位（用户在「保留本机/使用云端」上还没选） */
  pending: boolean;
}

const states = new Map<string, NoteDraftState>();

function newState(): NoteDraftState {
  return { lastCanonical: undefined, lastDoc: undefined, lastBaseRev: undefined, pending: false };
}

function stateOf(noteId: string): NoteDraftState {
  const hit = states.get(noteId);
  if (hit !== undefined) return hit;
  const made = newState();
  states.set(noteId, made);
  return made;
}

function forget(st: NoteDraftState): void {
  st.lastCanonical = undefined;
  st.lastDoc = undefined;
  st.lastBaseRev = undefined;
  st.pending = false;
}

/* ---------------- localStorage 读写（全部静默降级） ---------------- */

function lsRead(noteId: string): string | undefined {
  try {
    const raw = localStorage.getItem(draftKeyOf(noteId));
    return raw === null || raw === '' ? undefined : raw;
  } catch {
    return undefined;
  }
}

/** 删。删不掉（隐私模式 SecurityError）也不抛——顶多下次多留一份已经没用的记录。 */
function lsRemove(noteId: string): void {
  try {
    localStorage.removeItem(draftKeyOf(noteId));
  } catch {
    /* ignore */
  }
}

/* ---------------- 内部：加密/解密 ---------------- */

/**
 * canonical → 密文记录 → 写盘。
 *
 * @param force true 时绕过"与上次相同就不写"的短路（给 `flushDraft()` 用）。
 * @returns 是否真的落了盘。任何异常（配额满 / WebCrypto 异常 / 归一失败）都返回 false。
 */
async function persist(
  ctx: DraftCtx,
  doc: Doc,
  baseRev: number,
  st: NoteDraftState,
  force: boolean,
): Promise<boolean> {
  let canonical: string;
  try {
    // 🔴 归一后再 canonical：同一份内容必须只有一种字节形态，
    //   否则"分段粒度不同"会让短路失效（每次按键都重新加密一遍）。
    canonical = canonicalize(normalize(doc));
  } catch {
    // 连归一都过不了的不是合法真源，宁可不存 —— 存了也是一份恢复不出来的垃圾。
    return false;
  }
  if (!force && st.lastCanonical === canonical) return false;

  try {
    // 🔴 AAD 用 'note'：草稿的明文就是这篇笔记的 canonical 真源，
    //   与真实信封同一个明文域；共用标签等价于"这是同一件东西的两种副本"。
    //   独立的 'draft' 标签需要改 crypto.ts 的 AadTag 联合，本改动不越那条线。
    const env = await encryptString(canonical, ctx.dk.key, 'note', ctx.dk);
    const rec: DraftRecord = {
      ct: env.ct,
      iv: env.iv,
      kdf: env.kdf,
      baseRev,
      at: Date.now(),
    };
    localStorage.setItem(draftKeyOf(ctx.noteId), JSON.stringify(rec));
  } catch {
    return false;
  }

  st.lastCanonical = canonical;
  st.lastDoc = doc;
  st.lastBaseRev = baseRev;
  return true;
}

/** 读盘并解密。解不开（坏 JSON / 密钥不对 / 密文被改 / 非 canonical）一律 undefined，不抛。 */
async function resolve(noteId: string, dk: DerivedKey): Promise<DraftContent | undefined> {
  const raw = lsRead(noteId);
  if (raw === undefined) return undefined;
  try {
    const rec = JSON.parse(raw) as Partial<DraftRecord>;
    if (typeof rec.ct !== 'string' || typeof rec.iv !== 'string' || !rec.kdf) return undefined;
    // 还原成标准信封形状交给 crypto 层，本模块不自己调 WebCrypto
    const env: Envelope = { v: 1, alg: 'AES-256-GCM', kdf: rec.kdf, iv: rec.iv, ct: rec.ct };
    // 🔴 parseDoc 而不是裸 JSON.parse：它要求"当且仅当 canonical"，
    //   顺手把"密文被改花但 GCM 恰好通过"之外的非法结构挡住。
    const doc = parseDoc(await decryptString(env, dk.key, 'note'));
    return {
      doc,
      baseRev: typeof rec.baseRev === 'number' ? rec.baseRev : 0,
      at: typeof rec.at === 'number' ? rec.at : 0,
    };
  } catch {
    return undefined;
  }
}

/* ================================================================== *
 * 对外 API
 * ================================================================== */

/**
 * 记草稿：**内容真变了才写盘**。
 *
 * 可以在每次按键后调用（写一次只有一次 AES-GCM + 一次 setItem）；
 * 内容没变时直接短路返回 false，不做任何加解密。
 *
 * 🔴 草稿条挂起期间一律不写：那份草稿正等着用户裁决，被后来的编辑盖掉的话，
 *   用户点「保留本机」拿到的是他没见过的版本。
 *
 * @returns 是否真的落了盘
 */
export async function saveDraft(ctx: DraftCtx, doc: Doc, baseRev: number): Promise<boolean> {
  const st = stateOf(ctx.noteId);
  if (st.pending) return false;
  return persist(ctx, doc, baseRev, st, false);
}

/**
 * 强制落一次盘（`visibilitychange → hidden` / `pagehide` 时调）。
 *
 * 与 `saveDraft` 的差别只有一点：**绕过"内容与上次相同"的短路**。
 * 存在的理由是关页那一刻没人能保证上一次记账还在盘上——
 * 另一 Tab 可能刚删过、上一次写入可能因为配额满静默失败了。
 * 不带 doc 实参是为了让 `pagehide` 处理器不必再去 `getDoc()` 抓一次全文。
 *
 * @returns 是否真的落了盘
 */
export async function flushDraft(ctx: DraftCtx): Promise<boolean> {
  const st = stateOf(ctx.noteId);
  if (st.pending) return false;
  if (st.lastDoc === undefined || st.lastBaseRev === undefined) return false;
  return persist(ctx, st.lastDoc, st.lastBaseRev, st, true);
}

/**
 * 读草稿（不改任何状态）。
 *
 * @returns 解出来的内容；没有草稿、解不开、结构非法都返回 undefined。
 */
export async function readDraft(ctx: DraftCtx): Promise<DraftContent | undefined> {
  return resolve(ctx.noteId, ctx.dk);
}

/**
 * 盘上有没有这份草稿（**不需要密钥**，纯 grep 记录存在性）。
 *
 * 给调用方做"要不要显示草稿条"用；真正的裁决交给 `restoreDraftIfNeeded`。
 */
export function hasDraft(noteId: string): boolean {
  return lsRead(noteId) !== undefined;
}

/**
 * 恢复：解锁 / 打开笔记时调，决定"要不要弹那一条「保留本机 / 使用云端」"。
 *
 * - 没有草稿 ⇒ `none`
 * - 草稿与云端内容一致 ⇒ 草稿已无意义，静默清掉，返回 `none`
 * - 草稿解不开（换密钥 / 密文损坏 / 非 canonical）⇒ 视为陈旧，**静默清除**并返回 `none`
 *   （对齐精神：解不开即清，不弹错打扰用户）
 * - 草稿与云端不一致 ⇒ 返回 `conflict`，并把该笔记置为 **pending**
 *   （pending 期间 `clearDraft()` 会被挡住，见 `clearDraft`）
 *
 * 🔴 全程不抛：任何异常都按"没有有效草稿"处理。
 */
export async function restoreDraftIfNeeded(
  ctx: DraftCtx,
  cloudDoc: Doc,
): Promise<RestoreResult> {
  const st = stateOf(ctx.noteId);
  if (lsRead(ctx.noteId) === undefined) {
    forget(st);
    return { kind: 'none' };
  }

  const got = await resolve(ctx.noteId, ctx.dk);
  if (got === undefined) {
    // 解不开 = 陈旧。留着它会让之后每次打开都白解一遍，且用户看不出任何提示。
    lsRemove(ctx.noteId);
    forget(st);
    return { kind: 'none' };
  }

  let sameAsCloud = false;
  try {
    // 🔴 两边都过 canonical(归一)：比的是字节，不是"看起来差不多的对象"。
    sameAsCloud = canonicalize(normalize(got.doc)) === canonicalize(normalize(cloudDoc));
  } catch {
    sameAsCloud = false;
  }
  if (sameAsCloud) {
    lsRemove(ctx.noteId);
    forget(st);
    return { kind: 'none' };
  }

  st.pending = true;
  // 记账沿用草稿内容：这样紧接着的 `flushDraft()` 不会重复写同一份东西
  st.lastCanonical = canonicalize(normalize(got.doc));
  st.lastDoc = got.doc;
  st.lastBaseRev = got.baseRev;
  return { kind: 'conflict', doc: got.doc, baseRev: got.baseRev };
}

/** 草稿条是不是还挂着（用户在「保留本机 / 使用云端」上还没做选择）。 */
export function isDraftPending(noteId: string): boolean {
  return states.get(noteId)?.pending === true;
}

/**
 * 用户选了「**保留本机**」：把草稿内容交给调用方回灌。
 *
 * 🔴 **不删盘上的草稿**：此刻内容还没推上去，推失败了它仍是唯一的底线。
 *   真正删除由调用方在**推送成功后**调 `clearDraft()` 完成。
 *
 * @returns 待回灌的内容与它对应的 baseRev；没有可用草稿时返回 undefined。
 */
export function applyDraft(noteId: string): { doc: Doc; baseRev: number } | undefined {
  const st = states.get(noteId);
  if (st === undefined || st.lastDoc === undefined || st.lastBaseRev === undefined) {
    return undefined;
  }
  const out = { doc: st.lastDoc, baseRev: st.lastBaseRev };
  st.pending = false;
  return out;
}

/** 用户选了「**使用云端**」：丢弃草稿。 */
export function discardDraft(noteId: string): void {
  lsRemove(noteId);
  const st = states.get(noteId);
  if (st !== undefined) forget(st);
}

/**
 * 删草稿：**推送成功之后**调。
 *
 * 🔴🔴 挂起（用户还没做选择）期间 **什么都不做**并返回 false —— 理由见文件头，
 *   这是本模块守的数据丢失红线，由这个形状保证，不靠调用方记性。
 *
 * @param opts.force 唯一的破例通道。写它的时候必须能回答"为什么现在可以丢"。
 * @returns 是否真的删了
 */
export function clearDraft(noteId: string, opts?: { force?: boolean }): boolean {
  const st = states.get(noteId);
  if (st !== undefined && st.pending && opts?.force !== true) return false;
  lsRemove(noteId);
  if (st !== undefined) forget(st);
  return true;
}

/**
 * 清空**内存会话态**：切笔记 / 解锁另一篇之前调。
 *
 * 🔴 只清内存，**绝不动 localStorage 里的草稿记录** ——
 *   切到 B 笔记不该把 A 笔记还没推送的离线草稿毁掉（DR-13 钉这条）。
 *   进程被杀、刷新页面之后草稿依然在盘上，靠 `restoreDraftIfNeeded` 找回。
 */
export function resetDraftSession(): void {
  states.clear();
}
