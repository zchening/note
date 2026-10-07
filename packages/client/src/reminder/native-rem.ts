/**
 * 原生闹钟桥适配层（零 DOM，可单测）
 *
 * 🔴🔴🔴 **本文件存在的唯一理由：老项目在这里栽过一条 P0，而且症状是"测试永远绿"。**
 *
 *   老项目 v5.55 P0 修复注释原文（notesync/www/index.html:7002-7005）：
 *   「Capacitor 7 把原生插件挂在 `window.Capacitor.Plugins` 下，**从不挂 `window.RemBridge`** ——
 *     此前只读 `window.RemBridge`，**真机上恒为 null**，原生闹钟从未注册、通知从未发出
 *     （v5.51 起隐藏断点；**jsdom mock 恰好叫 `window.RemBridge`，测试永远绿测不出**）。」
 *
 *   那条 bug 的杀伤力在于它**四重隐身**：
 *     ① 不抛错（`rb.sync` 取到 undefined，调用被 `if (!rb)` 静静短路）；
 *     ② 不影响页内定时器（提醒在 App 开着的时候照常弹卡、照常响铃）；
 *     ③ 只有"退后台/ 杀进程后到点"这一条路独有 —— 开发时永远撞不到；
 *     ④ mock 名字恰好就叫 `window.RemBridge`，于是单测 100% 绿。
 *   ⇒ 所以本文件的桥探测**顺序**本身就是被判据钉住的东西（见 test/rem-native.test.mjs）。
 *
 * ── 桥形态（逐字对齐 RemPlugin.kt :32）────────────────────────────────────
 *   `@CapacitorPlugin(name = "RemBridge")` ⇒ 运行时挂在 `window.Capacitor.Plugins.RemBridge`。
 *   MainActivity.java:165 用 `registerPlugin(RemPlugin.class)` 显式注册。
 *
 * ── 方法签名（**读 Kotlin 源码抄下来的，不是照老项目猜的**）───────────────
 *
 *   RemPlugin.kt:255-293  `@PluginMethod fun sync(call: PluginCall)`
 *     · 入参：`call.getArray("list")`（:258）→ 逐项 `o.optLong("at") / o.optString("text")`（:266-267）
 *            `call.getString("noteId")`（:261）→ **按笔记分区**（partCipher(noteId)）
 *     · 成功：`ret.put("scheduled", n)` / `ret.put("failed", 0)`（:286-289）→ resolve
 *     · 失败：`call.reject("sync error: ${e.message}", e)`（:291）→ **reject**
 *   ⚠️ `at` 在 Kotlin 侧是 **Long（epoch 毫秒）**，不是 ISO 串。
 *      bj 真源里 `Reminder.at` 是**完整 ISO 带偏移**（shared-schema/types.ts:61，
 *      铁律：绝不存裸本地时间）⇒ 桥这一层**必须**做 ISO → epoch 转换。
 *      漏这一步的后果是 `optLong` 拿到 0，全部条目被 :268 的
 *      `if (at > now - 60_000L)` 判死 ⇒ `scheduled=0` ⇒ **闹钟一条都不排，且零报错**。
 *
 *   RemPlugin.kt:351-370  `@PluginMethod fun requestExactAlarm(call: PluginCall)`
 *     · 入参：无
 *     · 成功：`ret.put("canScheduleExactAlarms", canExact)`（:362-366）→ resolve
 *     · 失败：`call.reject("requestExactAlarm error: ...")`（:368）→ reject
 *     · 未授权时它会 `startActivity` 跳系统设置页（:356-361），所以**只能引导一次**。
 *
 * ── 为什么 `sync` 的 `noteId` 不能空─────────────────────────────────────
 *   RemPlugin.kt:274 `for (r in readPartition(context, nid)) cancelAlarm(context, r)`
 *   —— 传空串会**只清空"" 分区**（首页），而真源提醒在具名分区里 ⇒
 *   等于什么都没取消、也什么都没重排���老项目 :7013 因此有一道
 *   `if (!noteId) { ...='skip-no-note'; return; }` 闸，bj 照抄。
 */

/** 一条提醒的原生形态（Kotlin `Reminder(at: Long, text: String)`）。 */
export interface NativeReminder {
  /** **epoch 毫秒**（不是 ISO —— Kotlin 侧是 Long，见上）。 */
  at: number;
  text: string;
}

/** `sync` 的返回（RemPlugin.kt:286-288）。 */
export interface SyncResult {
  /** 实际排上的条数。`at <= now - 60s` 的会被原生丢掉，不计入。 */
  scheduled?: number;
  failed?: number;
}

/** 桥的最小形状（只声明用得到的字段，便于单测造假桥）。 */
export interface RemBridgeLike {
  sync(o: { list: NativeReminder[]; noteId: string }): Promise<SyncResult | null>;
  requestExactAlarm?(): Promise<{ canScheduleExactAlarms?: boolean } | null>;
}

/** window.Capacitor 的最小形状（与 update/ota-native.ts:65 同款，刻意不引第三方的 Capacitor 类型）。 */
interface CapacitorLike {
  Plugins?: Record<string, unknown>;
}

/**
 * 取 RemBridge 桥。**每次调用都重新读 window，绝不缓存成模块级 const。**
 *
 * 🔴🔴 顺序是本文件最承重的一行，判据 REMN-01/02 逐字钉它：
 *   ① `window.Capacitor.Plugins.RemBridge` —— Capacitor 官方暴露路径，**真机唯一有效的那条**
 *   ② `window.RemBridge`                   —— 回退，保留单测注入 mock 的能力
 *   两条都取不到 → null，调用方**返回 false 而不是抛错**（照 main.ts:855 nativeCopyImage 既有口径：
 *   抛错会把调用方后面整条回退链断掉）。
 *
 * @param win 注入的 window（单测传假窗；生产不传走真 window）
 */
export function getRemBridge(win?: unknown): RemBridgeLike | null {
  const w = (win ?? (typeof window !== 'undefined' ? window : undefined)) as
    | { Capacitor?: CapacitorLike; RemBridge?: unknown }
    | undefined;
  if (!w) return null;
  const viaCapacitor = w.Capacitor?.Plugins?.RemBridge as RemBridgeLike | undefined;
  const rb = viaCapacitor ?? (w.RemBridge as RemBridgeLike | undefined);
  if (!rb || typeof rb.sync !== 'function') return null;
  return rb;
}

/** 把真源提醒（ISO）转成原生形态（epoch 毫秒）。非法的 `at` 会被剔除。 */
export function toNativeList(
  reminders: ReadonlyArray<{ at: string; text: string }>,
): NativeReminder[] {
  const out: NativeReminder[] = [];
  for (const r of reminders) {
    const at = Date.parse(r.at);
    if (!Number.isFinite(at)) continue;
    out.push({ at, text: r.text });
  }
  return out;
}

/** 一次同步的结论（`?diag` / 单测读）。 */
export interface SyncOutcome {
  /** 桥在不在（false 时 `note` 一律是 `no-bridge`，绝不抛错）。 */
  ok: boolean;
  /** 收场原因：`no-bridge` / `skip-no-note` / `synced` / `bridge-threw` */
  note: 'no-bridge' | 'skip-no-note' | 'synced' | 'bridge-threw';
  /** 原生回报的排上条数（仅 note==='synced' 时有值）。 */
  scheduled?: number;
}

/**
 * 把提醒列表交给原生排精确闹钟（老项目 index.html:7006 `syncRemindersToNative`）。
 *
 * 🔴🔴 **桥不存在 / 调用抛错 ⇒ 一律 resolve，绝不 reject。**
 *   老项目 :7010 `if (!rb || ...) { window.__lastNativeSync = 'no-bridge'; return; }`
 *   ——它连`return` 都没有返回值，因为那是个纯 fire-and-forget。
 *   bj 这里给它一个明确的 `SyncOutcome` 返回值，是为了让"桥到底有没有接上"
 *   **可被单测观察**，而不是又一次"看起来正常、实际没接"。
 *   理由同 main.ts:866 `nativeCopyImage`：抛错会把调用方后面的路全断掉。
 *
 * @param noteId 当前笔记名。**为空则整条跳过**（照老项目 :7013 的 `skip-no-note` 闸）：
 *        空串在原生侧是"" 分区，误传会污染首页分区且清不掉具名分区的闹钟。
 */
export async function syncRemindersToNative(
  reminders: ReadonlyArray<{ at: string; text: string }>,
  noteId: string,
  win?: unknown,
): Promise<SyncOutcome> {
  const rb = getRemBridge(win);
  if (!rb) return { ok: false, note: 'no-bridge' };
  if (!noteId) return { ok: false, note: 'skip-no-note' };
  try {
    const ret = await rb.sync({ list: toNativeList(reminders), noteId });
    // 🔴 `exactOptionalPropertyTypes` 下不能写 `scheduled: undefined`：
    //   可选属性要么不出现，要么是 number。原生没报数（老壳/异常形态）时就不带这个键。
    return typeof ret?.scheduled === 'number'
      ? { ok: true, note: 'synced', scheduled: ret.scheduled }
      : { ok: true, note: 'synced' };
  } catch {
    // 🔴 原生层异常**不污染前端流程**（老项目 :7020 同款）：
    //   提醒在页内照样弹卡响铃，只是原生闹钟这次没排上。
    return { ok: false, note: 'bridge-threw' };
  }
}

/** localStorage 里"已引导过精确闹钟权限"的标记。**bj 前缀**，不复用老项目的键名。 */
export const EXACT_ALARM_ASKED_KEY = 'notesync_bj_exact_alarm_asked';

/**
 * 精确闹钟权限自检（老项目 index.html:7024 `ensureExactAlarmPermission`）。
 *
 * 🔴 为什么需要它：Android 12+ 的 `SCHEDULE_EXACT_ALARM` **默认不开**。
 *   不开时 `RemPlugin.scheduleAlarm`（:190-191）走 `setAndAllowWhileIdle` 非精确档，
 *   深睡可能晚到几十秒，被 `sync` 的 60s 容差（:268）吞掉 ⇒ **到点不响**。
 *
 * 🔴 为什么**只引导一次**：`requestExactAlarm` 会 `startActivity` 跳系统设置页
 *   （RemPlugin.kt:356-361）。每次进来都跳一次 = 用户被反复打断。
 *
 * @returns 能否排精确闹钟。桥不存在 / 抛错 / 非壳内 ⇒ false，绝不抛错。
 */
export async function ensureExactAlarmPermission(win?: unknown): Promise<boolean> {
  const w = (win ?? (typeof window !== 'undefined' ? window : undefined)) as
    | { localStorage?: { getItem(k: string): string | null; setItem(k: string, v: string): void } }
    | undefined;
  try {
    if (w?.localStorage?.getItem(EXACT_ALARM_ASKED_KEY) === '1') return false;
  } catch {
    /*隐私模式读不到：当作没引导过，继续（多引导一次的代价远小于漏引导） */
  }
  const rb = getRemBridge(win);
  if (!rb || typeof rb.requestExactAlarm !== 'function') return false;
  try {
    const ret = await rb.requestExactAlarm();
    try {
      w?.localStorage?.setItem(EXACT_ALARM_ASKED_KEY, '1');
    } catch {
      /* 写不进��已引导标记：下次会再引导一次，不致命 */
    }
    return ret?.canScheduleExactAlarms === true;
  } catch {
    return false;
  }
}