/**
 * 提醒的时间格式化 —— 纯函数，零DOM
 *
 * 为什么要单独一个文件：老项目这些格式是 `fmtRemTime` / `fmtRemInsert` 两个函数，
 * 散在 UI 逻辑里，格式一旦漂移（比如插入用了一种、面板显示另一种），
 * 用户看到的和解析器认的就对不上，而且**不报错**。
 *
 * 🔴🔴 最要紧的一条：**回写正文的格式必须与解析层能认的格式严格同源**。
 *   面板添加提醒后要把「时间　事项」写回正文，之后对账要靠它认出这条提醒。
 *   两边格式不一致 ⇒ 用户加了提醒，正文里却"找不到"它 ⇒ 下次对账判死 ⇒ 提醒自己消失。
 *   实测老项目 v8.1.6 就是为此加了"出处指纹"。
 *
 * 所以本文件同时提供「给人看的」与「给解析器认的」两种，且测试断言它们互逆。
 */

import { collectTimeMatches, type TimeMatch } from './time-parse.ts';

/** 面板/卡片显示用：`2027-3-1 10:00`（无前导零，月日不补零——老项目就是这样，短） */
export function fmtRemTime(at: string | number): string {
  const d = new Date(typeof at === 'number' ? at : Date.parse(at));
  if (Number.isNaN(d.getTime())) return '';
  return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()} ${d.getHours()}:${String(d.getMinutes()).padStart(2, '0')}`;
}

/**
 * 回写正文用：`2027-3-1 10:00` —— 形态与 fmtRemTime 相同。
 *
 * 🔴 这里刻意**不用** `2027-03-01 10:00`（补零）：
 *   解析层的 `reShort` 是 `(\d{1,2})[-/](\d{1,2})[ T\u3000](\d{1,2}):(\d{2})`，
 *   补零形态能解析，但显示上老项目一直是不补零的短形态（用户看惯了这个样子）。
 *   统一成"显示=回写"减少一类对照表的维护成本。
 */
export function fmtRemInsert(at: string | number): string {
  return fmtRemTime(at);
}

/** chip 上的相对日：`今天` / `明天` / `后天` / `3月5日` / `2028年1月2日` */
export function fmtRelDay(at: string | number, now: number = Date.now()): string {
  const d = new Date(typeof at === 'number' ? at : Date.parse(at));
  if (Number.isNaN(d.getTime())) return '';
  const n = new Date(now);
  const startOf = (x: Date): number => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const diffDays = Math.round((startOf(d) - startOf(n)) / 86400000);
  if (diffDays === 0) return '今天';
  if (diffDays === 1) return '明天';
  if (diffDays === 2) return '后天';
  if (diffDays === -1) return '昨天';
  if (d.getFullYear() === n.getFullYear()) return `${d.getMonth() + 1}月${d.getDate()}日`;
  return `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日`;
}

/** 迟到时长：`12 分钟` / `3 小时`（不足 1 分钟按 1 分钟算，与老项目一致） */
export function fmtLate(at: string | number, now: number = Date.now()): string {
  const t = typeof at === 'number' ? at : Date.parse(at);
  const min = Math.max(1, Math.round((now - t) / 60000));
  return min >= 60 ? `${Math.round(min / 60)} 小时` : `${min} 分钟`;
}

/**
 * 找出「光标/选区所在位置」的时间串。
 *
 * 🔴 为什么用"贴住光标"而不是"光标在中间"：用户点一下时间串想加提醒，
 *   光标可能落在任一字符之间。要求严格包含会经常失灵，用户会觉得"有时能加有时不能"。
 *
 * 🔴 老项目 v5.39 铁律：**已过期的时间串不浮 chip**（零打扰）。
 *   过期判定用 time-parse 给的 `expired` 字段（内含 30 秒容差），
 *   这里**不自己重算** —— 两处各算一次必然漂移，漂移的表现是"明明过期还能点添加"。
 */
export function matchAtCaret(
  text: string,
  offset: number,
  now: number = Date.now(),
): TimeMatch | null {
  const all = collectTimeMatches(text, now);
  let best: TimeMatch | null = null;
  for (const m of all) {
    // 含前后沿：正好点在首字之前、或刚输完末字，都算命中
    if (offset < m.index || offset > m.index + m.length) continue;
    if (m.expired) continue;
    // 多个候选时取最短的那个（更贴合用户点的那个具体的串）
    if (!best || m.length < best.length) best = m;
  }
  return best;
}

/**
 * 给一段文本里的某个时间串算出 chip 要显示的「事项」。
 * 与 reconcile.itemOf 同源同串，避免两处切法不同。
 */
export function itemForChip(text: string, m: TimeMatch, now: number = Date.now()): string {
  const all = collectTimeMatches(text, now);
  const next = all.find((x) => x.index > m.index);
  const end = next ? next.index : text.length;
  let s = text.slice(m.index + m.length, end);
  s = s.replace(/^[　\s:：、，,。.\-—]+/, '').trim();
  if (s !== '' && /^[^\p{L}\p{N}]+$/u.test(s)) return '';
  return s;
}
