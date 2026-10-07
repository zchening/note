/**
 * APK 冷启动自动进入上次笔记 —— 五部件的唯一出处。
 *
 * 老项目金标（五处，全部逐字照抄，见每处的行号注释）：
 *   ① 常量与守卫:index.html:913-929（NOTE_LAST_KEY / NOTE_JUMPED_KEY / JUMP_WINDOW_MS /
 *      jumpedRecently() / markJumped()）
 *   ② 写入:index.html:3437（口令解锁 applyUnlocked）+ :10298（自动解锁）
 *      🔴 v5.57 记载：**只抄一处是真 bug** —— 记住密钥/扫码配对进来的设备
 *        NOTE_LAST_KEY 从不更新，冷启动自动跳转形同虚设（用户实测实锤）。
 *        ⇒ bj 三条解锁路径（口令 / 扫码 / 记忆解锁）全写。
 *   ③ 读取跳转:index.html:10152-10159（init 的空noteId 分支）
 *   ④ 抑制标记三处:index.html:8038（菜单回首页）/ :10104（口令框关闭）/ :10084（pagehide）
 *   ⑤ 原生守卫:index.html:10152 的 `isNativeApp()`
 *
 * 🔴🔴🔴 为什么不抄老项目 head 里那段内联抢跳（index.html:40-54）：
 *   bj 的 capacitor.config.json 有 `server.url`，App 首屏加载的是**线上根页**，
 *   同一时刻原生侧可能正在 `loadUrl('/'+noteId)`（通知点击冷启 / App Links，
 *   见 MainActivity.java:476-505）。两个 `location.assign` 竞速，
 *   谁后 commit 谁赢 ⇒ **有时进 A 有时进 B**。
 *   这不是假想：老项目自己踩过并记在案 —— MainActivity.java:470-474 的
 *   "v6.3 P1 根治「点通知有时进错笔记」"整段就是在修这个竞速。
 *   ⇒ 只抄 init 一处（老项目同款），head 抢跳不抄。同理用 `location.assign`
 *     而非 replace：留历史，用户按返回键可退回首页换笔记（老项目 :10156 注释）。
 *
 * 🔴 为什么不写成"preference"：老项目用裸键名，本项目所有本机偏好都走
 *   `prefKey()` 前缀（见 main.ts）。两套命名并存会让"清本机数据"类操作漏掉一半。
 */

/** 记住最后一篇笔记（localStorage，**永久**）。键名走 prefKey 前缀纪律。 */
const LAST_KEY = 'lastNote';
/** "刚跳走过"标记（sessionStorage，随标签页/进程生命周期消失）。 */
const JUMPED_KEY = 'notesync_bj_jumped';
/**
 * 抑制窗口 120s（老项目 :918 `const JUMP_WINDOW_MS = 120 * 1000`）。
 *
 * 🔴 为什么不能是"本次会话"这种更长/更短的语义：标记只需桥接
 *   「写入 → 根页 init 读取」这一小段（菜单点击/返回键到根页加载，亚秒~几秒）。
 *   过长会把「回首页后快速重开 App」误杀成停在首页，免输名特性直接受损
 *   （老项目 :915-917 逐字记了这个取舍）。
 */
export const JUMP_WINDOW_MS = 120 * 1000;

/**
 * 笔记名校验。与服务端 `ID_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/` **不同**，
 * 这里用老项目 index.html:10154 的口径`/^[A-Za-z0-9_-]{1,64}$/`：
 *   🔴 必须容许大写首字符与 1 字符短名，否则会静默剔掉本机真的打得开的那几条
 *   （bj 的 `sanitizeNoteName` 只剔非法字符、保留大小写；服务端那条更严是因为
 *   它还要挡路径穿越，两处职责不同，见 landing-logic.ts:23 的注释）。
 */
const NOTE_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

/** 判定一个路径片段是否是可用的笔记名（导出给 route 侧复用，避免两处口径）。 */
export function isUsableNoteId(v: string | null | undefined): v is string {
  return typeof v === 'string' && NOTE_ID_RE.test(v);
}

function storage(kind: 'local' | 'session'): Storage | null {
  try {
    const s = kind === 'local' ? localStorage : sessionStorage;
    //🔴 隐私模式/存储被禁用时访问 localStorage 本身就可能抛（Safari 无痕旧版）。
    return s;
  } catch {
    return null;
  }
}

/** 本会话是否刚"主动回过首页/离开过笔记页"（老项目 :919-926 逐字）。 */
export function jumpedRecently(now = Date.now()): boolean {
  const s = storage('session');
  if (!s) return false;
  try {
    const raw = s.getItem(JUMPED_KEY);
    // 🔴🔴 必须先判null 再 Number()。`Number(null)` 是 **0**（不是 NaN），
    //   于是"压根没有标记"会被算成 t=0、age=now ⇒ 只要 now 小于 120s
    //   （设备时钟被改到很早、或测试里注入固定 now），jumpedRecently 就返回 true
    //   ⇒ 冷启动自动进入被静默抑制，而且**零报错**。
    //   老项目 :921-924 直接 `Number(sessionStorage.getItem(...))`，
    //   靠真实时钟（Date.now() 约 1.7e12）远大于窗口才侥幸没踩到 ——
    //   那是"在某个时刻恒不成立"的判据，不是真判据。
    if (raw === null || raw === '') return false;
    const t = Number(raw);
    if (!Number.isFinite(t)) return false;
    const age = now - t;
    // 🔴 age >= 0：时钟回拨/未来时间戳（负差值）视为过期放行。
    //   不加这条，标记永不过期 ⇒ 冷启动特性被静默杀死（老项目 :923 逐字记过）。
    return age >= 0 && age < JUMP_WINDOW_MS;
  } catch {
    return false;
  }
}

/** 打"刚跳走过"标记（老项目 :927-929 逐字）。 */
export function markJumped(now = Date.now()): void {
  try {
    storage('session')?.setItem(JUMPED_KEY, String(now));
  } catch {
    /* 存不下就本次会话不抑制 —— 最坏结果是多弹一次首页，不会白屏 */
  }
}

/** 读记住的笔记名；不合法/读不到返回 null（老项目 :10153-10154 的两重守卫）。 */
export function readLastNote(): string | null {
  let v: string | null = null;
  try {
    v = storage('local')?.getItem(`notesync_bj_pref_${LAST_KEY}`) ?? null;
  } catch {
    return null;
  }
  return isUsableNoteId(v) ? v : null;
}

/**
 * 记住成功打开过的笔记（老项目两处写入的合并版）。
 *
 * 🔴 三条解锁路径都要调（这是 v5.57 那条教训）：
 *   口令解锁（showPass.onSubmit）/ 扫码配对落地（handleScanRaw）/ 记忆解锁（route）。
 *   漏任何一条 ⇒ 那条进来的设备下次冷启动仍停在首页，而用户完全无法自查
 *   （症状是"有时候记得有时候不记得"）。
 *
 * @param noteId 已 sanitize 过的笔记名；空串/不合法一律不写。
 */
export function rememberLastNote(noteId: string | null | undefined): void {
  if (!isUsableNoteId(noteId)) return;
  try {
    storage('local')?.setItem(`notesync_bj_pref_${LAST_KEY}`, noteId);
  } catch {
    /* 存不下就本次会话内有效（老项目 :3437 同款catch） */
  }
}

/**
 * 冷启动该跳哪一篇（老项目 :10152-10159 的判据，逐字同语义）。
 *
 * @param isNative 是否在 APK 壳内 —— **必须由调用方传isNativeApp() 的现读结果**，
 *   不能在这里自己判：判据在 platform/native-detect.ts，而本模块是纯逻辑，
 *   单测要能注入"真网页/模拟原生"两种场景。
 * @returns 该跳转的笔记名；不该跳时返回 null（网页端 / 刚回过首页 / 没记住 / 不合法）。
 */
export function lastNoteToResume(isNative: boolean, now = Date.now()): string | null {
  if (!isNative) return null;
  if (jumpedRecently(now)) return null;
  return readLastNote();
}