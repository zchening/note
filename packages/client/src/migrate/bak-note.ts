/**
 * 换机备份·甲案 —— 清单写进云端一篇专用「备份笔记」，二维码只装它的链接
 *
 * ══════════════════════════════════════════════════════════════════════════
 * 🔴🔴🔴 本模块解决的正是用户报障第 2 条：
 *   「你确定扫码换机备份全部收藏夹，备份的逻辑和老版本一样，
 *     我看现在的版本生成的二维码密度要比老版本密度大得多，我担心太密不容易识别出来」
 *
 * ── 为什么必须做（老项目 index.html:8940-8947 的血泪，原文抄）───────────────
 *   「旧路线把『收藏 + 全部密钥』整包塞进一张二维码：每篇固定约 80 字节
 *    （32 字节 AES 钥的 base64 不可压缩），篇数一多格子数线性涨，
 *    而 drawQrTo 弹窗态把显示宽锁在 260px —— 第 3~4 篇起每格已掉到 0.6mm 以下，
 *    手机屏对手机屏物理上解不出（用户实锤：收藏 6 篇，微信能扫、app 扫半天没反应）。」
 *   「新路线：二维码退回它一直好扫的那张形态（笔记名 + #k= 密钥，
 *    恒定约 86 字节 / 41 格，与单篇配对码同档），清单本体写进一篇专用『备份笔记』——
 *    随机档名不可猜、密钥由口令派生（口令随时能重开这篇）、服务器只见密文
 *    （零知识不变）。篇数与码密度彻底解耦：100 篇也还是一张码。」
 *
 * 🔴🔴 **bj 旧路线的实测数据**（本仓 tools 量化，2026-10-07，见 BAK-NOTE-00）：
 *   清单直接进码时，1 篇就已经 299 字节（老项目甲案 86 字节的 **1.7 倍**），
 *   100 篇 2043 字节（**4.1 倍**）。envelope 的 salt + iv + authTag 在小清单时占了大头，
 *   所以"哪怕只收藏 1 篇也偏密"——这与用户的直觉一致，且比预想更严重。
 *   ⇒ 甲案不是"锦上添花"，是这条功能**能不能用**的问题。
 *
 * ── 与老项目的**架构性分叉**（必须写清楚，否则后人会"补成老项目那样"）────────
 *   老项目清单装 `[[笔记名, rawKeyB64], …]` —— **装的是密钥本身**，
 *   因为它的 raw key 明文躺在 localStorage（KEY_STORE），导出来零成本。
 *   bj 的密钥是 `extractable:false` 的 CryptoKey（shared-schema/key-store.ts:26），
 *   **WebCrypto 层面物理上导不出 raw 字节**。要照抄就得先把它降级成可导出，
 *   那是亲手拆掉本项目最重要的一条安全属性（XSS 拿到密钥 = 离线解开全部历史密文）。
 *
 *   ⇒ 本模块的清单装 **[篇名]**，不装密钥。
 *   这比老项目**更强**，不是更弱：
 *     老项目：扫到码 = 拿到密钥 = 拿到全部笔记的明文（且密钥永不变，改口令也救不回来）
 *     bj：扫到码 = 只拿到一串篇名（用户在菜单收藏视图里就能看到同一份），
 *         备份笔记本身由用户口令派生密钥加密，服务器只见密文（零知识不变）。
 *   恢复端每篇的密钥按 `PBKDF2(口令, 该篇信封里的 salt)` 现派生
 *   —— 与 sync/unlock.ts:174 同一条路，salt 本来就在服务端信封里（非机密）。
 *
 * ── 二维码载荷为什么是**配对链接**而不是老项目的 `#k=` 密钥链接 ──────────────
 *   老项目 `#k=<base64(rawKey)>`：扫到即零输入解锁。
 *   bj 导不出 raw 字节 ⇒ 唯一能装进码的是**口令** ⇒ 载荷形态自然落到
 *   `https://<origin>/nsbak-xxxxxx#p=<base64url(口令)>`，
 *   也就是 scan/pair-link.ts 的 `buildPairLink` 原样。
 *
 *   🔴🔴 **这是本模块最重要的一条接线约束**：载荷必须是配对链接，
 *   因为落地页「扫码打开笔记」那条路**只认 `#p=`**（pair-link.ts:116 硬判）。
 *   若另造一种形状，就得在 main.ts 里再开一条扫码分流 ——
 *   而"另开一条"正是历史上"扫不出来"的根源（见 pair-link.ts 文件头）。
 *   ⇒ 本模块**复用** buildPairLink，不自己拼 URL。
 *
 * ── 误编辑三闸（老项目 :8947，逐条承接）────────────────────────────────────
 *   ① 解密后进**只读恢复卡**，清单绝不进 contenteditable（`enterBakMode`）
 *   ② `saveLocal` 硬拒写（编辑态根本不挂载，见 main.ts 的 bakMode 分支）
 *   ③ 服务端**没有删除接口** + 每次覆盖都由 sync 的历史版本环存档可回滚
 *      （sync/client.ts:533 onArchive，与正文同一条判据）
 *
 * ── 零 DOM 依赖 ────────────────────────────────────────────────────────────
 * 与 fav-backup.ts / code.ts 同款纪律：纯计算，可 `node --test` 直跑。
 */

import { buildPairLink, parsePairLink } from '../scan/pair-link.ts';
import { blockText, type Doc } from '@bj/shared-schema';

/* ------------------------------------------------------------------ *
 * 篇名形状（老项目 :8950-8951 逐字）
 * ------------------------------------------------------------------ */

export const BAK_ID_PREFIX = 'nsbak-';
export const BAK_ID_RE = /^nsbak-[a-z0-9]{6}$/;

/**
 * 字码表。老项目 index.html:8966-8968 原文：
 *   `const A = 'abcdefghijkmnpqrstuvwxyz23456789'; // 去掉 l/o/1/0：手输档名兜底时不歧义`
 * 逐字照抄，包括去掉的四个字符。
 */
const BAK_ALPHABET = 'abcdefghijkmnpqrstuvwxyz23456789';

/** 随机新篇名。6 位取自 BAK_ALPHABET。 */
export function newBakId(): string {
  const bytes = new Uint8Array(6);
  crypto.getRandomValues(bytes);
  let s = '';
  for (let i = 0; i < 6; i++) s += BAK_ALPHABET[(bytes[i] as number) % BAK_ALPHABET.length];
  return BAK_ID_PREFIX + s;
}

/* ------------------------------------------------------------------ *
 * 备份槽（老项目 BAK_SLOT_KEY=:8949）
 * ------------------------------------------------------------------ */

/**
 * 🔴 键名沿用老项目的 `notesync_bak_slot`，**不是** bj 的 `notesync_bj_*` 前缀。
 *
 * 理由不是"统一风格"，而是**它记的是服务端篇名**：跨项目共用的那份状态
 * 换机器时靠人工搬运（localStorage 不会跟着走），键名一致时用户/脚本
 * 手工搬一次就够。改成 bj 自己的前缀只会在"手工迁移本机状态"这件事上多一次转换，
 * 而那件事没有一次是能自动的。
 */
export const BAK_SLOT_KEY = 'notesync_bak_slot';

export interface BakSlot {
  id: string;
  /** 建档时落的盐（非机密，与离线缓存同口径）。null = 没记着。 */
  salt: string | null;
}

/** localStorage 的最小形状（注入便于单测，也避免测试写真实存储）。 */
export interface SlotStore {
  getItem(k: string): string | null;
  setItem(k: string, v: string): void;
}

function defaultStore(): SlotStore | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    // 隐私模式下访问 localStorage 本身就抛
    return null;
  }
}

/**
 * 读备份槽。老项目 readBakSlot（:8958-8962）同款：
 *   形状不对一律当"没有"，绝不返回半个对象。
 */
export function readBakSlot(store: SlotStore | null = defaultStore()): BakSlot | null {
  if (!store) return null;
  let raw: string | null;
  try {
    raw = store.getItem(BAK_SLOT_KEY);
  } catch {
    return null;
  }
  if (!raw) return null;
  try {
    const o = JSON.parse(raw) as Partial<BakSlot>;
    if (!o || typeof o.id !== 'string' || !BAK_ID_RE.test(o.id)) return null;
    return { id: o.id, salt: typeof o.salt === 'string' ? o.salt : null };
  } catch {
    return null;
  }
}

/**
 * 写备份槽。
 *
 * 🔴 **写不进去不许抛**：老项目 nsStoreFail（:8963）是"提示一句 + 继续"，
 *   因为槽只是**加速器**（下次生成少问一次口令），不是数据的必要条件。
 *   在这里抛会把"生成备份码"整个失败掉 —— 那是拿一个可选状态去否决一次真备份。
 */
export function writeBakSlot(id: string, salt: string | null, store: SlotStore | null = defaultStore()): void {
  if (!store) return;
  try {
    store.setItem(BAK_SLOT_KEY, JSON.stringify({ id, salt }));
  } catch {
    /* 写不进去就下次问一次口令：不影响本次备份 */
  }
}

/* ------------------------------------------------------------------ *
 * 清单正文（老项目 BAK_PREFIX=:8949 / encodeBakDoc :8975-8978）
 * ------------------------------------------------------------------ */

/**
 * 清单正文前缀。老项目 `BAK_PREFIX = 'notesync-bak:1:'`（:8949）逐字。
 *
 * 🔴 它同时是**备份笔记的判别标记**：正文以它开头 ⇒ 这篇是备份笔记。
 *   老项目用整段正则 `BAK_DOC_RE` 判（:8953），bj 用"正文唯一块 + 本前缀"判，
 *   机制不同但**取向逐字一致**（见下面 isBakNoteDoc 的注释）。
 */
export const BAK_TEXT_PREFIX = 'notesync-bak:1:';

/**
 * 清单容量上限。老项目 `BAK_MAX = 100`（:8952，注释「100 篇 ≈ 8KB 明文；
 * 服务端 PUT 上限 1MB」）逐字。
 *
 * 🔴 与 bj 收藏夹上限 FAVS_MAX 同值（都是 100）⇒ 收藏夹里的**每一篇都必然能被备份**，
 *   一个都不漏。老项目的 BAK_MAX 与 FAVS_MAX 是两个独立数字，收藏超过 100 时
 *   会出现"收藏夹里有、但备份装不下"的静默缺口 —— bj 这里天然没有。
 */
export const BAK_MAX = 100;

/** 笔记名合法性。与服务端 ID_RE（server.js:57）同族但**放宽首字符**。
 *
 *  🔴 为什么放宽：服务端要求首字符 `[a-z0-9]`，而 bj 客户端允许 `[A-Za-z0-9_-]`
 *    （landing-logic.ts:23 只删非法字符，不改大小写）。
 *    用服务端那条去剔，会把 "Note1" 这类**本机明明能打开**的条目静默剔出备份 ——
 *    而服务端 PUT 时它自己会被 400 拒掉。两种失败里，剔掉更隐蔽（用户以为备份全了）。
 *    所以出码侧按客户端口径收（能进清单），由**写入时报错**告知，
 *    而不是在这里悄悄吞掉。
 */
const NOTE_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

/** 清单明文结构。键序固定，compact 序列化（同 fav-backup.ts 的口径）。 */
interface BakManifest {
  v: 1;
  ts: number;
  /** 篇名，保序去重。**只有篇名，没有密钥**（见文件头）。 */
  f: string[];
}

function manifestJson(m: BakManifest): string {
  return '{"v":' + m.v + ',"ts":' + m.ts + ',"f":[' + m.f.map((s) => JSON.stringify(s)).join(',') + ']}';
}

/**
 * 清单明文 → 正文（`notesync-bak:1:` + base64url）。
 *
 * 🔴🔴 **超限返回 null，绝不静默截断**（老项目 :8952 的 BAK_MAX 语义同款）。
 *   截断 = 用户以为全备份了、实际丢了收藏，且他不会知道 —— 最坏的一种失败。
 *   调用方必须把这个 null 变成一句明说的话（"收藏太多装不下"）。
 */
export function encodeBakText(ids: readonly string[], ts: number): string | null {
  if (!Array.isArray(ids)) return null;
  const out: string[] = [];
  const seen = new Set<string>();
  for (const id of ids) {
    if (typeof id !== 'string' || id === '') continue;
    if (!NOTE_ID_RE.test(id)) continue;
    if (seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  if (out.length === 0) return null;
  if (out.length > BAK_MAX) return null;
  const json = manifestJson({ v: 1, ts, f: out });
  return BAK_TEXT_PREFIX + b64ToB64Url(btoa(json));
}

/**
 * 正文 → 清单明文。**任何一项不满足返回 null**，绝不返回半个清单。
 *
 * 🔴 与 fav-backup.ts 的 parseManifest 同款纪律：失败路径上没有任何部分结果出口，
 *   调用方据此**不写收藏夹**。「恢复失败但收藏夹被清空」比直接报错糟糕得多。
 */
export function decodeBakText(text: string): { ids: string[]; ts: number } | null {
  if (typeof text !== 'string') return null;
  const raw = text.trim();
  if (!raw.startsWith(BAK_TEXT_PREFIX)) return null;
  const payload = raw.slice(BAK_TEXT_PREFIX.length);
  if (payload === '') return null;
  let json: string;
  try {
    json = atob(b64UrlToB64(payload));
  } catch {
    return null;
  }
  let o: unknown;
  try {
    o = JSON.parse(json);
  } catch {
    return null;
  }
  if (typeof o !== 'object' || o === null) return null;
  const m = o as Partial<BakManifest>;
  if (m.v !== 1) return null;
  if (!Array.isArray(m.f) || m.f.length === 0) return null;
  const out: string[] = [];
  const seen = new Set<string>();
  for (const it of m.f) {
    // 🔴 项必须是**字符串**。这里放数字/对象进来一律拒收整份 ——
    //   "尽量抢救几篇"会让用户拿到一份与出码时不一致的清单，
    //   而清单不一致意味着"备份里的东西和你以为的不一样"，那比失败更糟。
    if (typeof it !== 'string') return null;
    if (!NOTE_ID_RE.test(it)) return null;
    if (seen.has(it)) continue;
    seen.add(it);
    out.push(it);
  }
  if (out.length === 0) return null;
  return { ids: out, ts: typeof m.ts === 'number' ? m.ts : 0 };
}

/* ------------------------------------------------------------------ *
 * 备份笔记的判别（老项目 parseBakDoc :8994-8997 的等价物）
 * ------------------------------------------------------------------ */

/**
 * 这篇笔记是不是备份笔记。
 *
 * 🔴🔴 **判据取向逐字承接老项目**（:8976-8977）：
 *   「用户手打不出这个形状，也不会与任何真实正文相撞
 *    （宁可漏判走正常编辑，绝不误判把普通笔记锁成只读）」
 *
 * 为什么 bj 用"正文唯一块 + 前缀"而老项目用整段正则：
 *   bj 的真源是 Doc（块树），不是 HTML —— 没有 innerHTML 可正则。
 *   等价条件是"整篇正文**只有**清单那一个块，且该块是 code 且带 BAK_TEXT_PREFIX"。
 *   多一个块（用户手敲了字）⇒ 判 false ⇒ 走正常编辑。
 *   这与老项目"整段正则严格匹配"的严格程度一致：**宁可漏判，绝不误判**。
 *
 * 🔴 误判的代价（为什么值得写这么多注释）：备份笔记是**只读**的，
 *   误判 = 用户的一篇正常笔记被锁成只读、拒绝保存，且**没有任何提示**。
 *   那比"少一个备份入口"严重得多。
 */
export function isBakNoteDoc(doc: Doc | null | undefined): boolean {
  if (!doc || typeof doc !== 'object') return false;
  const blocks = doc.blocks;
  if (!Array.isArray(blocks) || blocks.length !== 1) return false;
  const b = blocks[0];
  if (!b || b.t !== 'code') return false;
  // 🔴 lang 必须也是标记：只靠 text 前缀的话，用户粘贴一段以该前缀开头的
  //   代码进普通笔记就会被锁成只读。加 lang 是第二道闸（两道都过才判备份）。
  if (b.lang !== 'nsbak') return false;
  return typeof b.text === 'string' && b.text.trim().startsWith(BAK_TEXT_PREFIX);
}

/** 备份笔记 → 清单。不是备份笔记或清单解不开，一律返回 null。 */
export function readBakManifest(doc: Doc | null | undefined): { ids: string[]; ts: number } | null {
  if (!isBakNoteDoc(doc)) return null;
  const b = (doc as Doc).blocks?.[0];
  if (!b) return null;
  return decodeBakText(b.text ?? '');
}

/** 造一篇备份笔记的真源（生产与判据共用同一条路，见 BAK-NOTE-12）。 */
export function buildBakDoc(ids: readonly string[], ts: number): Doc | null {
  const text = encodeBakText(ids, ts);
  if (text === null) return null;
  return { v: 1, blocks: [{ t: 'code', text, lang: 'nsbak' }] };
}

/* ------------------------------------------------------------------ *
 * 二维码载荷：配对链接（与 scan/pair-link.ts 同一套）
 * ------------------------------------------------------------------ */

/**
 * 造二维码载荷 —— 就是那篇备份笔记的**配对链接**。
 *
 * 🔴🔴 为什么必须复用 buildPairLink 而不是自己拼 URL：
 *   落地页「扫码打开笔记」→ handleScanRaw → parsePairLink（pair-link.ts:116 硬判 `#p=`）。
 *   自己拼一个形状就必须在 main.ts 里另开一条扫码分流，而"另开一条分流"
 *   正是历史上"扫了半天没反应"的根源（pair-link.ts 文件头第 3 条）。
 *   ⇒ 造码与解码**必须**用同一个函数，不许两处各写一遍 URL 拼法。
 *
 * @param origin站点origin（显式传入，不读 location.origin —— 这样可单测）
 * @param bakId  备份篇名（`nsbak-xxxxxx`）
 * @param passphrase 生成时用的口令。新设备扫到后用它派生密钥解开这篇备份笔记。
 */
export function buildBakLink(origin: string, bakId: string, passphrase: string): string {
  return buildPairLink(origin, bakId, passphrase);
}

/**
 * 这个配对链接是不是**备份笔记**的链接。
 *
 * 🔴 与 parsePairLink 的关系：先让 pair-link 判"这是不是一个能解的配对链接"，
 *   再判"它指向的篇名是不是备份笔记"。
 *   顺序反了会把非法输入先喂进篇名正则，报出来的原因与病因对不上。
 */
export function parseBakLink(
  raw: string,
  origin: string,
): { ok: true; noteId: string; passphrase: string } | { ok: false; reason: string } {
  const parsed = parsePairLink(raw, origin);
  if (!parsed.ok) return { ok: false, reason: parsed.reason };
  if (!BAK_ID_RE.test(parsed.link.noteId)) return { ok: false, reason: 'not-bak' };
  return { ok: true, noteId: parsed.link.noteId, passphrase: parsed.link.passphrase };
}

/* ------------------------------------------------------------------ *
 * 收集清单（老项目 collectBackupEntries :9001-9019 的等价物）
 * ------------------------------------------------------------------ */

/**
 * 该备份哪些篇名。
 *
 * 🔴 三条排除（老项目 :9010-9016）：
 *   ① 备份槽自身（老项目原话「密钥套密钥死循环」；bj 清单里没有密钥，
 *      但备份槽若进了清单，恢复端会把它当普通收藏塞回去 ——
 *      用户收藏夹里凭空多出一个自己从没收藏过的条目，同样要剔）
 *   ② 篇名不合法（与老项目同款剔而不失败）
 *   ③ 去重保序
 *
 * 🔴🔴 **这里绝不按 BAK_MAX 截断**（与 fav-backup.ts 同款纪律）：
 *   截断的职责在 encodeBakText（返回 null → 调用方明说"装不下"）。
 *   在这里悄悄砍尾，"用户以为 101 篇全备份了、实际丢了 1 篇且永远不会知道"。
 */
export function collectBakEntries(favs: readonly string[], slotId: string | null): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const id of favs) {
    if (typeof id !== 'string' || id === '') continue;
    if (!NOTE_ID_RE.test(id)) continue;
    if (seen.has(id)) continue;
    seen.add(id);
    if (slotId && id === slotId) continue;
    out.push(id);
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * base64url（与 fav-backup.ts / code.ts 同一套最小实现）
 * ------------------------------------------------------------------ */

function b64ToB64Url(b64: string): string {
  return b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function b64UrlToB64(s: string): string {
  // 🔴 padding 必须按 `(4 - len%4)%4` 精确补：无脑补 '===' 会让 atob 抛
  //   （对长度 %4==1 直接抛，那是非法长度，补不回来）。
  const pad = (4 - (s.length % 4)) % 4;
  return s.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat(pad);
}

export { blockText };
