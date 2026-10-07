/**
 * 时间识别 —— 从正文里认出「什么时候该提醒」
 *
 * 🔴🔴 本文件是**逐行移植**老项目 v8.1.5 的 collectTimeMatches / collectRelTimeMatches。
 *   行为契约一字不改，因为用户已经用这套规则养成了书写习惯（"明天下午三点"、
 *   "下周五 10:30"、"12月3日晚上8点"），改判据等于让他的笔记集体失效。
 *
 *   移植时**不改**的三件事（每条都有对应测试）：
 *   1. 短格式（无年份）一律按今年解析，**已过就是过期**，不给"顺延明年"的兜底。
 *      老项目 v6.3 拿掉了那条兜底：它把「8-30 9:00」判成明年同刻的未来时间，
 *      于是过期提醒照样弹"添加提醒"入口，点了就多出一条明年的（用户实测 P1）。
 *   2. 「上/本周X」**刻意不解析**。解析它就会让裸「周五 18:00」被抢走，产生幽灵提醒。
 *   3. 全角空格 U+3000 之前的内容算「事项区」，不再命中 —— 面板回写格式是
 *      「YYYY-M-D H:MM　事项」，不防就会把事项里的数字当成又一个时间。
 *
 *   **可测性**：本文件零 DOM 依赖，`now` 一律可注入。所以整套时间规则能在 node 里测，
 *   而不必开浏览器。老项目的实现埋在 index.html 里，只能靠 e2e 间接覆盖。
 */

export interface TimeMatch {
  /** 毫秒时间戳 */
  at: number;
  /** 在原文里的起始下标（**基于归一后的文本**，全角归一等长所以与原文对齐） */
  index: number;
  /** 匹配串长度 */
  length: number;
  /** 已过期（含 30 秒容差：正好到点的那一分钟内仍算"还能提醒"） */
  expired: boolean;
}

/** 4000 字符上限：超限直接返回空。老项目 v7.4.0 加的，防止长文卡死正则。 */
export const TIME_SCAN_LIMIT = 4000;
/** 到点容差 30 秒 —— 正好在提醒时刻那一分钟内仍应可提醒 */
const EXPIRY_SLACK_MS = 30_000;

/**
 * 全角 → 半角归一（数字 ０-９ / ：－／）。
 * 🔴 U+3000 全角空格**刻意不归一**：相对时间组靠它识别事项区边界。
 *   全角与半角同为 UTF-16 单码元，归一不改变长度 ⇒ index/length 与原文逐位对齐。
 */
export function normFullWidth(text: string): string {
  return text.replace(/[０-９：－／]/g, (c) => {
    const code = c.charCodeAt(0);
    if (code >= 0xff10 && code <= 0xff19) return String.fromCharCode(code - 0xfee0);
    if (c === '：') return ':';
    if (c === '－') return '-';
    return '/';
  });
}

/** 年月日时分 → 时间戳。非法返回 null（不抛，调用方当作"不命中"）。 */
export function resolveTimeAt(y: number, mo: number, d: number, h: number, mi: number): number | null {
  if (mo < 1 || mo > 12 || h > 23 || mi > 59) return null;
  // new Date 原生进位：2 月 30 日会变成 3 月 2 日，所以必须先查当月天数
  if (d < 1 || d > new Date(y, mo, 0).getDate()) return null;
  return new Date(y, mo - 1, d, h, mi).getTime();
}

/** 中文数字 → 阿拉伯。非法返回 NaN。 */
export function cnNum(s: string | undefined | null): number {
  if (s === undefined || s === null) return NaN;
  s = String(s);
  if (/^\d+$/.test(s)) return Number(s);
  const U: Record<string, number> = {
    零: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9,
  };
  if (s === '十') return 10;
  const mm = s.match(/^([1-9]|[一二两三四五六七八九])?十([一二三四五六七八九])?$/);
  if (mm) {
    // 🔴 noUncheckedIndexedAccess 下 mm[1] 是 string | undefined。
    //   显式收窄而不是 `!` —— 断言会把"以后改了正则"变成静默的 NaN。
    const tens = mm[1];
    const ones = mm[2];
    const t = tens === undefined ? 1 : (U[tens] ?? 1);
    const o = ones === undefined ? 0 : (U[ones] ?? 0);
    return t * 10 + o;
  }
  if (s.length === 1) {
    const v = U[s];
    if (v !== undefined) return v;
  }
  return NaN;
}

const WD_CH = '[一二三四五六日天]';
const WD_W = '(周|星期|礼拜)';
// 🔴 (这|下) 必须带 `?`。老项目原文就是 `(?:(这|下)?\s?...`：
//   少了问号，裸「周三 10:00」就匹配不上分支 A，退化到分支 B 只捞到裸时刻「10:00」，
//   于是「周五/周日/礼拜五」统统返回"今天"（实测 2026-10-05 周一基准下全错成周一）。
//   症状极隐蔽：带前缀的「这周三」全对，只有裸周几错 —— 像是"随机 bug"。
const WD_SEG = '(?:(这|下)?\\s?(?:个\\s?)?' + WD_W + '\\s?(' + WD_CH + '))';
/** 刻意不解析的「上/本 + 周/星期/礼拜 + X」。放在交替最前占位。 */
const WD_UP = '(?:[上本]\\s?(?:个\\s?)?(?:周|星期|礼拜)\\s?[一二三四五六日天])';
const WD_UP_RE = new RegExp('^' + WD_UP);
/** 分支 B 幽灵防护：裸时刻若紧跟「上/本周X」不得单独命中。 */
const UNSUP_WD_LB = '(?<![上本]\\s?(?:个\\s?)?(?:周|星期|礼拜)\\s?[一二三四五六日天])';
const HOUR = '(\\d{1,2}|二十[一二三]?|十[一二三四五六七八九]?|[一二两三四五六七八九])';
const MIN = '(\\d{1,2}|(?:[一二三四五]?十[一二三四五六七八九]?)|[一二三四五六七八九])';
const MH = '(?:(?:' + MIN + ')分|' + MIN + '|(半))?';
const TIME_SEG = '(?:(\\d{1,2}):(\\d{2})|' + HOUR + '点(?:钟' + MH + '|' + MH + ')?)';
const reTimeSeg = new RegExp('^' + TIME_SEG);

/** 相对时间匹配：「明天 下午三点」「下周五 10:30」「本月12号 晚上8点半」 */
export function collectRelTimeMatches(text: string, now: number | Date): TimeMatch[] {
  if (!text || typeof text !== 'string') return [];
  text = normFullWidth(text);
  const n = now instanceof Date ? now : new Date(now == null ? Date.now() : Number(now));
  const res: TimeMatch[] = [];
  const taken: Array<[number, number]> = [];
  const WD = '一二三四五六日天';
  const reRel = new RegExp(
    // 分支 A：显式日期段 + 时段词? + 时刻
    //   🔴 「N月N日」是 2026-10-08 用户拍板的**新增扩展**（老项目 :6188 没有）：
    //     「10月18日下午两点 喝水」此前两头落空 —— 分支 A 无此形态、分支 B 被
    //     (?<![年月日号:]) 挡住，更糟的是漏捞成裸「两点」算成今天 02:00。
    //     必须放在 (?:这个月|本月)/(?:下个月|下月) 之后，互不抢占。
    '(?:大后天|后天|明天|今天|' + WD_UP + '|' + WD_SEG + '|(?:这个月|本月)\\d{1,2}[日号]|(?:下个月|下月)\\d{1,2}[日号]|\\d{1,2}月\\d{1,2}[日号])' +
      '[\\s]*(?:凌晨|早上|上午|中午|下午|傍晚|晚上|夜里)?[\\s]*' + TIME_SEG + '(?!\\d)' +
      '|' +
      // 分支 B：裸时刻。
      // 🔴 时段词前用 [^\S\u3000]*（不含全角空格）：若吞掉 U+3000，
      //   匹配起点会落在事项区分隔符上，事项里的「9:30」会被二次命中（幽灵提醒）。
      '(?<!第)(?<!\\d)(?<![年月日号:])' + UNSUP_WD_LB +
      '(?:凌晨|早上|上午|中午|下午|傍晚|晚上|夜里)?[^\\S\\u3000]*(?<![零一二两三四五六七八九十])' +
      TIME_SEG + '(?!\\d)',
    'g',
  );
  const reDateSeg = new RegExp(
    '^(大后天|后天|明天|今天|' + WD_UP + '|' + WD_SEG + '|(?:这个月|本月)(\\d{1,2})[日号]|(?:下个月|下月)(\\d{1,2})[日号]|(\\d{1,2})月(\\d{1,2})[日号])',
  );
  const rePartSeg = /^(凌晨|早上|上午|中午|下午|傍晚|晚上|夜里)/;
  let m: RegExpExecArray | null;
  while ((m = reRel.exec(text)) !== null) {
    const start = m.index;
    const len = m[0].length;
    // 🔴 无效 match 也占位：否则「本月31日 10点」判无效后，同串里的裸「10点」会二次命中
    taken.push([start, start + len]);
    if (text.slice(0, start).indexOf('　') !== -1) continue;
    let seg = m[0];
    const dm = seg.match(reDateSeg);
    if (dm) seg = seg.slice(dm[0].length);
    seg = seg.replace(/^\s+/, '');
    let part: string | null = null;
    const pm = seg.match(rePartSeg);
    if (pm && pm[1] !== undefined) {
      part = pm[1];
      seg = seg.slice(pm[0].length).replace(/^\s+/, '');
    }
    const tm = seg.match(reTimeSeg);
    if (!tm) continue;
    let H: number;
    let Mi: number;
    let extraDay = 0;
    if (tm[1] !== undefined && tm[2] !== undefined) {
      // 冒号形态直用，时段词不参与换算（老项目行为：「晚上 18:00」就是 18:00）
      H = Number(tm[1]);
      Mi = Number(tm[2]);
    } else {
      H = cnNum(tm[3]);
      const minCap = tm[4] !== undefined ? tm[4] : tm[5] !== undefined ? tm[5] : tm[7] !== undefined ? tm[7] : tm[8] !== undefined ? tm[8] : undefined;
      Mi = tm[6] !== undefined || tm[9] !== undefined ? 30 : minCap !== undefined ? cnNum(minCap) : 0;
      if (Number.isNaN(H) || Number.isNaN(Mi)) continue;
      if (part === '晚上' || part === '夜里') {
        if (H >= 1 && H <= 5) extraDay = 1;
        else if (H >= 6 && H <= 11) H += 12;
        else if (H === 12) { H = 0; extraDay = 1; }
      } else if (part === '下午' || part === '傍晚') {
        if (H >= 1 && H <= 11) H += 12;
      } else if (part === '中午') {
        if (H >= 1 && H <= 5) H += 12;
      } else if (part === '凌晨') {
        if (H === 12) H = 0;
      }
    }
    if (H > 23 || Mi > 59) continue;
    const y0 = n.getFullYear();
    const mo0 = n.getMonth();
    const d0 = n.getDate();
    let MO = mo0;
    let D = d0;
    if (dm) {
      if (WD_UP_RE.test(dm[0])) continue;
      if (dm[1] === '今天') { /* 保持 */ }
      else if (dm[1] === '明天') D = d0 + 1;
      else if (dm[1] === '后天') D = d0 + 2;
      else if (dm[1] === '大后天') D = d0 + 3;
      else if (dm[3] !== undefined) {
        const wd = dm[4];
        if (wd === undefined) continue;
        const idx = WD.indexOf(wd);
        if (idx < 0) continue;
        // 周一=0 体系；日/天 → 6（本周第 7 天）
        const dayIdx = idx <= 5 ? idx : 6;
        D = d0 - ((n.getDay() + 6) % 7) + dayIdx + (dm[2] === '下' ? 7 : 0);
      } else if (dm[7] !== undefined && dm[8] !== undefined) {
        // 🔴 「N月N日」（用户拍板扩展）：无年份按今年，已过即过期（红线 2，不顺延明年）。
        //   MO 是 0-based（getMonth 体系），与下方 new Date(y0, MO, ...) 对齐。
        const MO2 = Number(dm[7]);
        const D2 = Number(dm[8]);
        if (MO2 < 1 || MO2 > 12) continue;
        if (D2 < 1 || D2 > new Date(y0, MO2, 0).getDate()) continue;
        MO = MO2 - 1;
        D = D2;
      } else {
        const N = Number(dm[5] || dm[6]);
        if (N < 1 || N > 31) continue;
        if (dm[5] !== undefined) {
          if (N > new Date(y0, mo0 + 1, 0).getDate()) continue;
          D = N;
        } else {
          if (N > new Date(y0, mo0 + 2, 0).getDate()) continue;
          MO = mo0 + 1;
          D = N;
        }
      }
    }
    const at = new Date(y0, MO, D + extraDay, H, Mi).getTime();
    if (Number.isNaN(at)) continue;
    res.push({ at, index: start, length: len, expired: at <= n.getTime() + EXPIRY_SLACK_MS });
  }
  return res;
}

/** 绝对时间 + 相对时间的总入口。`nowArg` 可注入（MCP 与测试需要两端同源）。 */
export function collectTimeMatches(text: string, nowArg?: number | Date): TimeMatch[] {
  text = normFullWidth(text);
  const nowMs = nowArg == null ? Date.now() : nowArg instanceof Date ? nowArg.getTime() : Number(nowArg);
  const nowDate = new Date(nowMs);
  const res: TimeMatch[] = [];
  /** 所有「带年份」形态命中的区间（无论时间是否有效都占位），短格式一律避让 */
  const spans: Array<[number, number]> = [];
  let m: RegExpExecArray | null;

  const reFull = /(\d{4})[-/](\d{1,2})[-/](\d{1,2})[ T　](\d{1,2}):(\d{2})/g;
  while ((m = reFull.exec(text)) !== null) {
    spans.push([m.index, m.index + m[0].length]);
    const at = resolveTimeAt(Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4]), Number(m[5]));
    if (at === null) continue;
    res.push({ at, index: m.index, length: m[0].length, expired: at <= nowMs + EXPIRY_SLACK_MS });
  }

  const reFullCn = /(\d{4})年(\d{1,2})月(\d{1,2})日\s*(\d{1,2}):(\d{2})/g;
  while ((m = reFullCn.exec(text)) !== null) {
    spans.push([m.index, m.index + m[0].length]);
    const at = resolveTimeAt(Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4]), Number(m[5]));
    if (at === null) continue;
    res.push({ at, index: m.index, length: m[0].length, expired: at <= nowMs + EXPIRY_SLACK_MS });
  }

  const overlaps = (i: number): boolean => spans.some((s) => i >= s[0] && i < s[1]);
  const pushShort = (mm: RegExpExecArray): void => {
    if (overlaps(mm.index)) return;
    // 🔴🔴 短格式一律按今年解析，**不做**"本年已过就顺延明年"的兜底（老项目 v6.3 移除）。
    //   那条兜底把过去的日期判成明年同刻的未来时间 → 过期提醒照样能点"添加提醒"
    //   → 用户莫名多出一条明年的提醒（用户实测 P1）。
    const at = resolveTimeAt(
      nowDate.getFullYear(), Number(mm[1]), Number(mm[2]), Number(mm[3]), Number(mm[4]),
    );
    if (at === null) return;
    res.push({ at, index: mm.index, length: mm[0].length, expired: at <= nowMs + EXPIRY_SLACK_MS });
  };

  const reShort = /(\d{1,2})[-/](\d{1,2})[ T　](\d{1,2}):(\d{2})/g;
  while ((m = reShort.exec(text)) !== null) pushShort(m);
  const reCn = /(\d{1,2})月(\d{1,2})日\s*(\d{1,2}):(\d{2})/g;
  while ((m = reCn.exec(text)) !== null) pushShort(m);

  // 相对时间组最后跑，避让已有命中区间
  try {
    const relAll = collectRelTimeMatches(text, nowMs);
    const relOverlap = (r: TimeMatch): boolean =>
      spans.some((s) => r.index >= s[0] && r.index < s[1]) ||
      res.some((x) => r.index >= x.index && r.index < x.index + x.length);
    for (const r of relAll) if (!relOverlap(r)) res.push(r);
  } catch {
    /* 相对时间组是"锦上添花"，它挂了不许影响绝对时间的识别 */
  }
  return res.sort((a, b) => a.index - b.index);
}

/** 有 4000 字上限的入口。超限返回空（与老项目一致）。 */
export function parseTimeMatches(text: string): TimeMatch[] {
  if (!text || typeof text !== 'string' || text.length > TIME_SCAN_LIMIT) return [];
  return collectTimeMatches(text);
}

/**
 * 长文版：按行分段扫描再聚合，index 加段偏移。
 * 🔴 不能简单地"分段解析后丢弃偏移" —— 事项文本的切分依赖 index+length，
 *   偏移错了会把 A 行的事项接到 B 行的时间上。
 */
export function parseTimeMatchesLong(text: string, now?: number | Date): TimeMatch[] {
  const s = String(text || '');
  if (s.length <= TIME_SCAN_LIMIT) return collectTimeMatches(s, now);
  const out: TimeMatch[] = [];
  let base = 0;
  for (const seg of s.split('\n')) {
    for (const m of collectTimeMatches(seg, now)) {
      out.push({ at: m.at, index: m.index + base, length: m.length, expired: m.expired });
    }
    base += seg.length + 1;
  }
  return out;
}

/** 光标偏移处是否落在某个时间串上（含前后沿：点首字/刚输完末字都要算命中）。 */
export function matchTimeAt(text: string, offset: number, now?: number | Date): TimeMatch | null {
  const all = collectTimeMatches(text, now);
  return all.find((r) => offset >= r.index && offset <= r.index + r.length) ?? null;
}
