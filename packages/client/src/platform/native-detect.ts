/**
 * 原生（APK 壳内）判据 —— 全项目**唯一**出处。
 *
 * 🔴🔴🔴 为什么要单独成文件：判据散在 4 处（诊断面板 `isNative`、
 *   导出长图 `isNativeApp`、`registerSW` 的早退、`ui/shell.ts` 品牌位），
 *   4 处各写一遍字符串，改的时候必漏一处 —— 而漏掉的那一处症状是
 *   **静默失效**（功能走了网页分支，不报错、日志正常）。
 *
 * 🔴🔴🔴 本文件修的是一个真实缺陷，不是重构洁癖：
 *   bj 此前 4 处全读 `window.__NOTESYNC_NATIVE__ === true`，
 *   而**那个标志全仓从未被赋值**（6 处读、0 处写；android 侧也没注入）。
 *   ⇒ 它恒为 `undefined`，`=== true` 恒假，**真机 APK 里也判不出来**。
 *   静默失效的三个后果：
 *     ① APK 里也在注册 Service Worker（`registerSW` 的早退永远不触发）
 *        —— 缓存的是线上壳，SW 与 MainActivity 的三段兜底叠加；
 *     ② APK 里导出长图走不到原生复制（`nativeCopyImage` 那一档被跳过）；
 *     ③ APK 里顶栏品牌位永远不显示当前笔记名（老项目 v7.3.2 的口径）。
 *   这类缺陷的形态与"用了类名 ≠ 样式命中它"同族：**声明在、判定永不成立**。
 *
 * 🔴 判据必须照老项目 index.html:10125-10127 逐字：
 *     `!!(window.Capacitor && window.Capacitor.isNativePlatform && window.Capacitor.isNativePlatform())`
 *   —— 不能用 `window.Capacitor.isNative()`（那看的是运行环境，不是平台），
 *   也不能只看 `window.Capacitor` 存在（网页版若注了同名全局会误判成 APK）。
 *   bj 的 `MainActivity extends BridgeActivity` ⇒ 真机注入成立（已核对源码）。
 *
 * 🔴🔴 每次调用**现读**，不要在模块顶层缓存成 const：
 *   Capacitor 的桥是在页面脚本执行**之后**才注入的，顶层缓存会永久拿到 undefined。
 *   （与 `reminder/native-rem.ts` 的 `getRemBridge()` 同一纪律。）
 */

/** window.Capacitor 的最小形状（与 update/ota-native.ts:65 同款，刻意不引第三方类型）。 */
interface CapacitorShape {
  isNativePlatform?: () => boolean;
}

function cap(): CapacitorShape | undefined {
  return typeof window === 'undefined' ? undefined : (window as unknown as { Capacitor?: CapacitorShape }).Capacitor;
}

/**
 * 当前是否跑在 App 壳内（APK）。
 *
 * 🔴 供e2e 用：判据必须在「模拟原生」与「真网页」两种页面里给出不同答案，
 *   否则单测只能测出恒假这一种情况（见 test/native-detect.test.mjs）。
 */
export function isNativeApp(): boolean {
  const c = cap();
  if (!c || typeof c.isNativePlatform !== 'function') return false;
  // 🔴 四个调用点全在**启动路径**上（registerSW / 挂编辑器 / 顶栏渲染 / 诊断采集）。
  //   判据函数把异常漏出去 = 整页白屏，而原生判据失败时唯一正确的答案是"当作网页"，
  //   因为网页分支对所有功能都有降级实现（原生复制降级到 html2canvas、SW 只是增强项）。
  try {
    return !!c.isNativePlatform();
  } catch {
    return false;
  }
}