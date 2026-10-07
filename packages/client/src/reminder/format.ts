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

/**
 * 回写正文用：`2027-3-1 10:00` —— **绝对**形态。
 *
 * 🔴🔴 这里必须与 `fmtChipTime` **分开**，绝不能合并：
 *   显示要的是「今天 09:44」/「10月14日 09:44」（老项目 fmtRemTime），
 *   而回写正文必须能被解析层的 `reShort`（`(\d{1,2})[-/](\d{1,2})[ T\u3000](\d{1,2}):(\d{2})`）
 *   认出来。若图省事让回写也走显示格式，正文里落下的会是「今天 09:44」，
 *   `reShort` **认不出** ⇒ 提醒被 reconcile 判死 ⇒ 用户刚加的提醒自己消失。
 *   老项目 display 与 insert 本来就是两个函数（fmtRemTime / 写回另有形态），照抄这个分层。
 */
export function fmtRemInsert(at: string | number): string {
  const d = new Date(typeof at === 'number' ? at : Date.parse(at));
  if (Number.isNaN(d.getTime())) return '';
  return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()} ${d.getHours()}:${String(d.getMinutes()).padStart(2, '0')}`;
}

/**
 * chip/卡片**显示**用（老项目 `index.html:6047` fmtRemTime 逐字）：
 *   今天 → `今天 09:44`；否则 → `10月14日 09:44`（**不带年**、月日不补零）。
 *
 * 🔴 老项目就是「有今天前缀就不带年、没今天前缀才带月日」的二选一，
 *   bj 此前恒 `YYYY-M-D HH:mm`（带年、无今天前缀）⇒ 两个分支都不对。
 */
export function fmtChipTime(at: string | number, now: number = Date.now()): string {
  const d = new Date(typeof at === 'number' ? at : Date.parse(at));
  if (Number.isNaN(d.getTime())) return '';
  const hm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  const sameDay = d.toDateString() === new Date(now).toDateString();
  return sameDay ? `今天 ${hm}` : `${d.getMonth() + 1}月${d.getDate()}日 ${hm}`;
}

/**
 * chip 首行右上角相对日（老项目 `index.html:6053` `chipDayLabel` 逐字）：
 *   同日 → `''`（**不挂标签**）/ 明天 / 后天 / `n<7` → `周X` / 否则 → `n天后`。
 *
 * 🔴🔴 同日必须返回空串而不是「今天」：老项目注释写明「fmtRemTime 已带「今天」前缀，
 *   再挂标签是重复」。bj 此前同日返回「今天」⇒ 首行右侧多一个冗余标签。
 *   且老项目**没有「昨天」分支**（过期时间串压根不浮 chip，见 matchAtCaret）。
 */
export function fmtChipDay(at: string | number, now: number = Date.now()): string {
  const d = new Date(typeof at === 'number' ? at : Date.parse(at));
  if (Number.isNaN(d.getTime())) return '';
  // 🔴 按**日历天**（本地零点差）取整，避开 23:59→00:01 这类跨分钟误差（老项目注释原话）。
  const target = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const today = new Date(new Date(now).getFullYear(), new Date(now).getMonth(), new Date(now).getDate()).getTime();
  const n = Math.round((target - today) / 86400000);
  if (n <= 0) return '';
  if (n === 1) return '明天';
  if (n === 2) return '后天';
  if (n < 7) return '周' + '日一二三四五六'.charAt(d.getDay());
  return n + '天后';
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
