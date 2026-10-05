/**
 * 彩蛋层 —— **纯逻辑层**（注册表 / 发现记录 / 门牌解析 / 正文词表）
 *
 * 🔴 为什么不碰 DOM 的部分单独放：跟 landing-logic.ts 同源纪律。
 *   彩蛋里最容易出静默 bug 的是**清单与计数对不上**（图鉴写 17 个、
 *   实际注册 16 个 → 计数永远差 1，用户一眼看穿），以及
 *   **已发现记录被写坏后整层崩**。这两类都必须在 node 里钉死。
 *
 * 🔴🔴 门牌清单是**唯一真源**，四个地方复用它，任何地方都不许再写一份字面量：
 *   1. 路由判定（isEggRoute）
 *   2. 落地页按钮文案（打开彩蛋 / 打开）
 *   3. 落地页「新建笔记」禁用
 *   4. 彩蛋图鉴的条目清单
 *   早期 S4 只放了一个 pet，导致落地页把 pet 当普通笔记名放行 ——
 *   点「打开」进的是空编辑器，而用户以为进的是桌宠。**零报错**。
 */

import { COPY } from '../ui/copy.ts';

/** 一个彩蛋的元数据。`dom` 型（镜像/桌宠）自带画面，不走 canvas 外壳。 */
export interface EggMeta {
  id: string;
  /** 图鉴上的名字。未发现时显示 ???，所以它只是已发现后的展示。 */
  name: string;
  /** 怎么撞见的（也是已发现后的提示）。 */
  hint: string;
  /** 是否是 URL 门牌（老项目分「URL 门牌」与「条件触发」两类）。 */
  door: boolean;
  /**
   * 是否可replay（图鉴里可点「再玩一次」）。
   * 🔴 条件触发类的badge 没有 replay —— 它是"节日/深夜自己冒出来"，
   *   没法主动复现。老项目就是 `replay: null`。
   */
  replayable: boolean;
}

/**
 * 全部彩蛋 —— **17 条，与老项目 NS_EGG_LIST 同长**。
 *
 * 🔴🔴 改动本表必须同步：图鉴计数（EGG_TOTAL 是推导值，不另写死）、
 *   门牌判定、落地页文案。老项目历史上就是靠
 *   `const NS_EGG_TOTAL = 17; // 与 NS_EGG_LIST 同长；新增条目必同版改此数（单测硬钉）`
 *   人工兜底 —— 那种做法迟早漏。本项目改成**推导**，从根上消掉这类漂移。
 */
export const EGGS: readonly EggMeta[] = [
  // ── 条件触发 7枚 ──
  { id: 'skin', name: '复古皮肤', hint: '连点左上角logo 七次', door: false, replayable: true },
  { id: 'rain', name: '节日雨', hint: '过节那天打开笔记', door: false, replayable: true },
  { id: 'badge', name: '节日徽章', hint: '节日或深夜自己冒出来', door: false, replayable: false },
  { id: 'num', name: '数字梗粒子', hint: '打一串 666 / 520', door: false, replayable: true },
  { id: 'fw', name: 'Notesync 烟花', hint: '在笔记里敲出 notesync', door: false, replayable: true },
  { id: 'type', name: '打字机音', hint: '复古皮肤里敲键盘', door: false, replayable: true },
  { id: 'diag', name: '诊断面板', hint: '关于弹窗标题连点四次', door: false, replayable: true },
  // ── URL 门牌 10 枚 ──
  { id: 'mirror', name: '镜像模式', hint: '访问 /mirror', door: true, replayable: true },
  { id: 'snake', name: '贪吃蛇', hint: '访问 /snake 或正文敲 /snake', door: true, replayable: true },
  { id: 'dragon', name: '断网恐龙', hint: '访问 /dragon', door: true, replayable: true },
  { id: 'brick', name: '打砖块', hint: '访问 /brick · 砖是正文里的词', door: true, replayable: true },
  { id: 'satoshi', name: '聪合币', hint: '访问 /satoshi · 合到 1 亿聪', door: true, replayable: true },
  { id: 'bitcoin', name: '黄金矿工', hint: '访问 /bitcoin · 越深越肥', door: true, replayable: true },
  { id: 'tank', name: '坦克大战', hint: '访问 /tank · 保卫记事本', door: true, replayable: true },
  { id: 'spacex', name: '垂直着陆', hint: '访问 /spacex · 按住是推力', door: true, replayable: true },
  { id: 'tesla', name: '轨道巡航', hint: '访问 /tesla · 撞碎飘过的标题', door: true, replayable: true },
  { id: 'pet', name: '桌宠', hint: '访问 /pet 或正文敲 /pet', door: true, replayable: true },
] as const;

/** 彩蛋总数。**推导值**，不是手写常量（见文件头「改动本表必须同步」）。 */
export const EGG_TOTAL = EGGS.length;

/** 全部 URL 门牌（命中即不新建笔记）。老项目 `NS_RESERVED_ROUTES` 同款。 */
export const EGG_DOORS: readonly string[] = EGGS.filter((e) => e.door).map((e) => e.id);

/**
 * 路由保留字全集 = 门牌+ 伪路由（老项目另有一批 404/工具字面）。
 *
 * 🔴 为什么门牌之外的字（about/help/api/www）也要保留：
 *   它们是应用自身的路由/工具入口，若被当成笔记名放行，
 *   用户访问 /about 会得到一个空白编辑器 —— 与"笔记打不开"无法区分。
 *   老项目把这些也放进保留字，行为一致。
 */
export const RESERVED_ROUTES: ReadonlySet<string> = new Set<string>([
  ...EGG_DOORS,
  'about',
  'help',
  'admin',
  'api',
  'www',
  'backup',
  'pet2',
]);

/** 该名字是否指向彩蛋而非新笔记。 */
export function isEggRoute(name: string): boolean {
  return name !== '' && RESERVED_ROUTES.has(name.toLowerCase());
}

/** 取门牌 id（大小写不敏感）；不是门牌返回空串。老项目 `nsEggRouteId` 同款。 */
export function doorOf(name: string): string {
  const p = name.toLowerCase();
  return EGG_DOORS.indexOf(p) >= 0 ? p : '';
}

export function eggById(id: string): EggMeta | undefined {
  return EGGS.find((e) => e.id === id);
}

/* ------------------------------------------------------------------ *
 * 发现记录（本机键，与老项目 notesync_eggs 同语义、独立前缀）
 * ------------------------------------------------------------------ */

/** 发现记录键。**独立前缀**，不复用老项目的 notesync_eggs。 */
export const EGG_KEY = 'notesync_bj_eggs';

/** 发现记录的最小存储接口。 */
export interface EggStore {
  getItem(k: string): string | null;
  setItem(k: string, v: string): void;
}

export function eggBrowserStore(): EggStore {
  try {
    const ls = window.localStorage;
    ls.getItem(EGG_KEY);
    return ls;
  } catch {
    return { getItem: () => null, setItem: () => {} };
  }
}

/**
 * 读已发现 id 集合。
 *
 * 🔴🔴 只保留**注册表里真有的** id：
 *   老项目的 `nsEggMap()` 读回来直接用，于是"某次版本删了一个彩蛋"之后，
 *   老记录里那个 id 仍会让计数虚高 —— 图鉴显示 `12 / 11 FOUND`，
 *   数字大于分母，用户一眼看出坏了，而且**永远自愈不了**
 *   （记录只会累加，从不清理）。这里在读取侧就按注册表过滤。
 */
export function readDiscovered(store: EggStore): Set<string> {
  const known = new Set(EGGS.map((e) => e.id));
  const out = new Set<string>();
  let raw: unknown;
  try {
    raw = JSON.parse(store.getItem(EGG_KEY) ?? '{}');
  } catch {
    return out;
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (!known.has(k)) continue; // 已下架的彩蛋不计数
    if (v === 1 || v === true) out.add(k);
  }
  return out;
}

/** 计数行文案：`{got} / {total} FOUND`。 */
export function eggCountText(got: number): string {
  return COPY.eggCount(got, EGG_TOTAL);
}

/**
 * 记一次发现。**已发现则不写**（老项目同款 `if (map[id]) return`）。
 *
 * 🔴 为什么要这个幂等：某些触发点会在**每次** update/每次按键都调
 *   （比如正文里打字时扫词表）。不判重就等于每秒写一次 localStorage，
 *   移动端主线程会明显卡 —— 而症状是"打几个字就卡"，极难归因。
 */
export function markDiscovered(store: EggStore, id: string, hit: boolean): boolean {
  if (!hit) return false;
  if (eggById(id) === undefined) return false; // 未注册的门牌不许进记录
  const cur = readDiscovered(store);
  if (cur.has(id)) return false;
  const next: Record<string, 1> = {};
  for (const k of cur) next[k] = 1;
  next[id] = 1;
  try {
    store.setItem(EGG_KEY, JSON.stringify(next));
  } catch {
    // 写不下就算了：发现记录是**装饰性**数据，丢了不影响任何功能
  }
  return true;
}

/* ------------------------------------------------------------------ *
 * 正文词表（游戏砖面/蛇身/坦克基地的素材来源）
 * ------------------------------------------------------------------ */

/** 数字梗。命中则记num 蛋并撒粒子。 */
export const NUM_GAGS: readonly number[] = [666, 520, 1314, 888, 6666];

/**
 * 正文纯文本里的数字串。
 *
 * 🔴 必须提**独立数字串**而不是子串匹配：
 *   正文"1666"里含"666"，若按子串判就误报（用户只是写了个年份）。
 *   反过来"6 6 6"（带空格）老项目是当梗的，提取时天然分成三段 —— 这里靠
 *   调用方决定要不要 join，但**判定按完整串**，避免"第 666 天"这种误报。
 */
export function numGagsIn(text: string): number[] {
  const out: number[] = [];
  // 连续数字（含小数点），边界用非数字，避免 1666 命中 666
  for (const m of text.matchAll(/(?<![\d.])(\d{3,})(?![\d.])/g)) {
    const n = Number(m[1]);
    if (NUM_GAGS.indexOf(n) >= 0 && out.indexOf(n) < 0) out.push(n);
  }
  return out;
}

/** `notesync` 的大小写与形态变体（老项目 WORDS 同款）。 */
const FW_WORDS: readonly string[] = ['NoteSync', 'NOTE-SYNC.EXE', 'N O T E S Y N C'];

/** 正文里是否敲出了 notesync（不分大小写）。命中则放烟花。 */
export function hasFireworkWord(text: string): boolean {
  const t = text.toLowerCase();
  return FW_WORDS.some((w) => t.indexOf(w.toLowerCase()) >= 0);
}

/**
 * 从正文里抽词，给砖块/蛇身/基地当素材。
 *
 * 🔴 口径来自老项目 `bodyWords()`：优先取**正文里的词**，
 *   词不足时回退到收藏/待办 —— 游戏要的是"你的东西出现在游戏里"这件事。
 * @param minWords 少于这个数就算"不足"（老项目对 brick/dragon 用 8）
 */
export function bodyWords(text: string, minWords = 8): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  //中文按 2 字一词切，英文数字按空白切。老项目同样思路。
  for (const seg of text.split(/[\s，。！？、；：,.!?;:]+/)) {
    const s = seg.trim();
    if (s === '') continue;
    const words: string[] = [];
    if (/[一-龥]/.test(s)) {
      for (let i = 0; i < s.length; i += 2) words.push(s.slice(i, i + 2));
    } else {
      words.push(s);
    }
    for (const w of words) {
      if (w.length < 2) continue;
      if (seen.has(w)) continue;
      seen.add(w);
      out.push(w);
      if (out.length >= 64) return out;
    }
  }
  return out.length >= minWords ? out : [];
}
