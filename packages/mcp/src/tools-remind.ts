/**
 * 提醒工具。
 *
 * 🔴🔴 时间解析**直接复用网页端那份**（packages/client/src/reminder/time-parse.ts），
 *   一个字不改。理由不是省代码，是**规则必须一致**：
 *   用户（和 AI）打的一句"明天下午三点"，网页端与 MCP 若各认各的，
 *   就会出现"MCP 说设了 15:00、网页端把这条当普通文字"或反过来 ——
 *   症状是"提醒时有时无"，而两处代码都测过自己那份，都觉得自己对。
 *   老项目把这段规则逐行从 index.html 搬过来并锁死行为契约，本项目沿用同一纪律。
 *
 *   那个文件刻意是零 DOM 依赖、now 可注入的纯函数，就是为了能在这里复用。
 */
import { emptyDoc } from '@bj/shared-schema';
import type { Doc, Reminder } from '@bj/shared-schema';
import { collectRelTimeMatches, matchTimeAt } from '../../client/src/reminder/time-parse.ts';
import { makeRemId } from '../../client/src/reminder/reconcile.ts';
import { assertId } from './config.ts';
import { plainOf } from './tools-doc.ts';
import type { ToolCtx } from './tools-doc.ts';

/** 未来提醒上限，与网页端一致（老项目同名常量 REM_MAX=10）。 */
export const REM_MAX = 10;

export interface RemindArgs {
  name?: string;
  op?: 'add' | 'list' | 'cancel' | 'clear' | 'done';
  /** add: 中文时间句（"明天下午三点"）或 ISO 串；cancel: 提醒 id */
  at?: string;
  text?: string;
  id?: string;
}

function nowMs(): number {
  return Date.now();
}

function isoOf(at: number): string {
  // 🔴 真源要求存"完整 ISO 带偏移"，绝不存裸本地时间戳 ——
  //   换设备/跨时区时裸时间会整体偏移，提醒在别的设备上就指错点了。
  const d = new Date(at);
  const off = -d.getTimezoneOffset();
  const sign = off >= 0 ? '+' : '-';
  const hh = String(Math.floor(Math.abs(off) / 60)).padStart(2, '0');
  const mm = String(Math.abs(off) % 60).padStart(2, '0');
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}T${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}${sign}${hh}:${mm}`;
}

function atOf(iso: string): number {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) throw new Error('提醒时间无法解析为有效时刻：' + iso);
  return t;
}

/** 把一句中文时间解析成时刻。**复用网页端规则**，认不出就报"认不出"而不是猜。 */
export function resolveAt(text: string, now: number): number {
  const s = String(text ?? '').trim();
  if (s === '') throw new Error('at 为空');
  // ① 先当完整 ISO/可解析串试一次
  const direct = Date.parse(s);
  if (!Number.isNaN(direct) && /\d{4}-\d{2}-\d{2}/.test(s)) return direct;
  // ② 走网页端那套中文相对时间
  const m = collectRelTimeMatches(s, now);
  if (m.length === 0) {
    throw new Error(
      `认不出这句话里的时间：${JSON.stringify(s)}。` +
        '可写「明天下午三点」「下周五 10:30」「2026-12-03 20:00」这类。',
    );
  }
  if (m.length > 1) {
    // 🔴 TimeMatch 只有 {at,index,length,expired}，**没有 text** ——
    //   要给人看的"认出了哪几个时间"必须自己按 index/length 切原文。
    //   凭印象写 m.text 会静默变成 undefined，错误信息就变成 "undefined / undefined"，
    //   恰好在最需要它说人话的时候说不清。
    const words = m.map((x) => JSON.stringify(s.slice(x.index, x.index + x.length))).join(' / ');
    throw new Error(`这句话里认出 ${m.length} 个时间（${words}），请只保留要提醒的那一个。`);
  }
  return m[0].at;
}

export async function toolRemind(ctx: ToolCtx, args: RemindArgs): Promise<unknown> {
  const name = assertId(args.name || ctx.defaultNote);
  const op = args.op ?? 'add';
  const note = await ctx.vault.load(name);
  const doc: Doc = note === null ? emptyDoc() : note.doc;
  const list: Reminder[] = [...(doc.reminders ?? [])];
  const now = nowMs();

  switch (op) {
    case 'add': {
      const at = resolveAt(String(args.at ?? ''), now);
      if (at <= now + 30_000) {
        // 🔴 30 秒红线与网页端一致。放过"刚刚"的时间 = 立刻弹一个用户没预期的通知。
        throw new Error('提醒时间必须是将来的（至少 30 秒之后）');
      }
      const future = list.filter((r) => !r.done && atOf(r.at) >= now);
      const text = String(args.text ?? '').trim().slice(0, 20);
      //🔴🔴 覆盖判据是"**同一时刻**"，不是"同一时刻同一事项"。
      //   网页端的 makeRemId 把事项文本也混进 id（那是为了"重载后下划线还在"），
      //   所以同一个时刻、不同事项在网页端是**两条独立提醒**。
      //   但本工具 description 承诺的是"同一时刻再设一次 = 更新文案"
      //   （与老项目 MCP 的 op=add 语义一致）——
      //   那就必须按时刻匹配，否则用户让 AI"改一下这条提醒的内容"会攒出两条，
      //   到点连着弹两次，而且两条都"看起来对"。
      //
      //   找齐所有同刻的提醒：有则改第一条、无则建。
      //   （留多条同刻是历史数据可能有的形态，不在这里合并 ——
      //     合并会静默删掉用户可能有意义的"同一时刻两件事"。）
      const sameAt = future.filter((r) => atOf(r.at) === at);
      const id = sameAt.length > 0 ? sameAt[0].id : makeRemId(at, text);
      if (sameAt.length > 0) {
        //🔴🔴 取消"已完成"必须**删掉 done 这个键**，不能写 done: undefined。
        //   canonical 规则 2 是"省略默认值"，而 done: undefined 并不等于省略：
        //   它会一路走到 validator 被判 E_REMINDER_SHAPE 拒掉。
        //   症状极具迷惑性 —— 用户看到的是"改一下提醒内容"报"结构不合法"，
        //   而那行代码看起来完全正常。
        //   （这正是新架构与老项目的一处差异：老项目提醒没有 done 字段。）
        const next: Doc = {
          ...doc,
          reminders: list.map((r) => {
            if (r.id !== id) return r;
            const cleared: Reminder = { id: r.id, at: r.at, text };
            return cleared;
          }),
        };
        await ctx.vault.save(name, next);
        return {
          ok: true,
          name,
          op: 'add',
          at: isoOf(at),
          id,
          text,
          overwrote: true,
          futureCount: future.length,
        };
      }
      if (future.length >= REM_MAX) {
        throw new Error(`未来提醒已达上限 ${REM_MAX} 条（与网页端一致）。请先取消旧的再加。`);
      }
      const rem: Reminder = { id, at: isoOf(at), text };
      const next: Doc = { ...doc, reminders: [...list, rem].sort((a, b) => atOf(a.at) - atOf(b.at)) };
      await ctx.vault.save(name, next);
      return {
        ok: true,
        name,
        op: 'add',
        at: isoOf(at),
        id,
        text,
        futureCount: future.length + 1,
      };
    }
    case 'list': {
      return {
        name,
        op: 'list',
        list: list.map((r) => ({
          id: r.id,
          at: r.at,
          atLocal: isoOf(atOf(r.at)).slice(0, 16).replace('T', ' '),
          text: r.text,
          fired: !r.done && atOf(r.at) <= now,
          expired: atOf(r.at) < now,
          done: r.done === true,
        })),
        futureCount: list.filter((r) => !r.done && atOf(r.at) >= now).length,
      };
    }
    case 'cancel': {
      const id = String(args.id ?? args.at ?? '').trim();
      if (id === '') throw new Error('cancel 必须给 id（先用 op=list 拿）');
      const hit = list.find((r) => r.id === id);
      if (!hit) throw new Error(`没有这条提醒：${id}`);
      // 🔴🔴 cancel **只删提醒，不动正文** —— 与网页端一致。
      //   新项目的提醒不依附正文（真源里是独立数组），所以这里本来就不会动正文；
      //   写这条注释是因为老项目是从正文行反解的，删提醒会留下孤儿文字行，
      //   而新项目不该继承那个副作用。
      const next: Doc = { ...doc, reminders: list.filter((r) => r.id !== id) };
      await ctx.vault.save(name, next);
      return { ok: true, name, op: 'cancel', removed: hit };
    }
    case 'done': {
      const id = String(args.id ?? args.at ?? '').trim();
      if (id === '') throw new Error('done 必须给 id');
      if (!list.some((r) => r.id === id)) throw new Error(`没有这条提醒：${id}`);
      const next: Doc = {
        ...doc,
        reminders: list.map((r) => (r.id === id ? { ...r, done: true as const } : r)),
      };
      await ctx.vault.save(name, next);
      return { ok: true, name, op: 'done', id };
    }
    case 'clear': {
      // 🔴 clear 只清"已过期或已触发"的，**不动未来的**。
      //   不加这个限定的话，一句"清理一下提醒"会连带删掉还没响的提醒，
      //   而用户往往是只想让列表干净一点。
      const keep = list.filter((r) => !r.done && atOf(r.at) >= now);
      const cleared = list.length - keep.length;
      if (cleared === 0) {
        // 🔴 没有要清的就不写远端。空写一次会换新盐 + 触发 SSE 广播，
        //   让所有设备重拉一遍，而内容一个字没变。
        return { ok: true, name, op: 'clear', cleared: 0, futureCount: keep.length };
      }
      const next: Doc = { ...doc, reminders: keep };
      await ctx.vault.save(name, next);
      return { ok: true, name, op: 'clear', cleared, futureCount: keep.length };
    }
    default:
      throw new Error('op 只支持 add | list | cancel | done | clear');
  }
}

export { plainOf, matchTimeAt };
