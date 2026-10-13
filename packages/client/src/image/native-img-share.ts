/**
 * 原生分享图片桥适配层（零 DOM，可单测）
 *
 * 🔴 为什么必须有这座桥（v3.2.4，用户报障第 4 条逐字拍板）：
 *   移动端导出弹窗的「分享」按钮要"调用系统分享组件，跟分享整个诊断报告一样"。
 *   诊断报告分享走 DiagExport.shareText（ACTION_SEND），而**图片**需要一座
 *   接受 base64 的分享桥 —— 壳内 WebView 没有 navigator.share（DiagExportPlugin.kt
 *   注释双实锤："Web Share API 是 Chrome 特性，WebView 不实现"），剪贴板那条路
 *   微信又不认（v3.2.3 实锤）。所以：ImgSharePlugin.kt（ACTION_SEND + FileProvider）。
 *
 * 🔴 桥形态逐字对齐 ImgSharePlugin.kt `@CapacitorPlugin(name = "ImgShare")`
 *   ⇒ 运行时挂在 `window.Capacitor.Plugins.ImgShare`。
 *   MainActivity 显式 registerPlugin（判据 EXPORT-31 钉着，缺注册 = 死代码）。
 *   与 ImgSave / DiagExport 同规矩：**JS 每次现读，失败静默回退** ——
 *   老壳上没有 ImgShare（桥比壳新），读不到就走网页 navigator.share 那条路。
 *
 * ── 方法签名（读 Kotlin 源码抄下来的）────────────────────────────────
 *
 *   ImgSharePlugin.kt  `@PluginMethod fun shareImage(call: PluginCall)`
 *     · 入参：`call.getString("base64")`（空串 ⇒ `{ok:false, error:"empty"}`）
 *            `call.getString("mime")`，缺省 `"image/png"`
 *     · 成功：`{ok:true, shared:true}`（分享面板已拉起；用户在面板点取消
 *       native 侧收不到回执，一律按"已拉起"算 —— DiagExport.shareText 同款口径）
 *     · 失败：`{ok:false, error:"save-failed" | "share-failed" | 异常消息}`
 *     · ⚠️ **全程 `call.resolve`，从不 `call.reject`** ——
 *       "失败"也是 resolve 出来的 `{ok:false}`，所以必须判 `res.ok === true`，
 *       "没抛错"不算成功（native-img-save.ts 同一条纪律）。
 */

/** `shareImage` 的返回（ImgSharePlugin 侧永远 resolve，不 reject）。 */
export interface ShareResult {
  ok?: boolean;
  /** `ok:true` 时为 true：分享面板已拉起（不代表用户没在面板里点取消）。 */
  shared?: boolean;
  /** 失败原因（`ok:false` 时有）。 */
  error?: string;
}

/** 桥的最小形状（只声明用得到的字段，便于单测造假桥）。 */
export interface ImgShareBridgeLike {
  shareImage(o: { base64: string; mime: string }): Promise<ShareResult | null>;
}

/** window.Capacitor 的最小形状（与 update/ota-native.ts 同款）。 */
interface CapacitorLike {
  Plugins?: Record<string, unknown>;
}

/**
 * 取 ImgShare 桥。**每次调用都重新读 window，绝不缓存成模块级 const。**
 *
 * 🔴🔴 顺序与 native-img-save.ts 同款：
 *   ① `window.Capacitor.Plugins.ImgShare`（Capacitor 官方暴露路径，真机唯一有效）
 *   ② `window.ImgShare`（回退，保留单测注入 mock 的能力）
 *
 * 🔴 判据只收 `shareImage` 在 —— 这是 v3.2.4 的初版接口，没有新旧壳差异。
 *
 * @param win 注入的 window（单测传假窗；生产不传走真 window）
 */
export function getImgShareBridge(win?: unknown): ImgShareBridgeLike | null {
  const w = (win ?? (typeof window !== 'undefined' ? window : undefined)) as
    | { Capacitor?: CapacitorLike; ImgShare?: unknown }
    | undefined;
  if (!w) return null;
  const viaCapacitor = w.Capacitor?.Plugins?.ImgShare as ImgShareBridgeLike | undefined;
  const rb = viaCapacitor ?? (w.ImgShare as ImgShareBridgeLike | undefined);
  if (!rb || typeof rb.shareImage !== 'function') return null;
  return rb;
}

/** 桥是否存在（弹窗分享 handler 的第①档判定用；export/index.ts 注入为 hasNativeShare）。 */
export function hasNativeImgShare(win?: unknown): boolean {
  return getImgShareBridge(win) !== null;
}

/**
 * 拉系统分享面板分享一张图。
 *
 * @param b64 **不带 `data:` 前缀**的 base64（Kotlin 侧 `Base64.decode` 直接解，
 *        带前缀会解出垃圾字节。export/render.ts 的 `blobToB64` 已剥前缀）。
 * @returns 原生回报 `ok:true` 才算成功。**桥不存在 / 抛错 / ok:false 一律 false，绝不抛** ——
 *         抛错会把调用方的下一级（网页 navigator.share）断掉。
 */
export async function nativeShareImage(
  b64: string,
  mime: string,
  win?: unknown,
): Promise<boolean> {
  const rb = getImgShareBridge(win);
  if (!rb) return false;
  try {
    const res = await rb.shareImage({ base64: b64, mime });
    return res?.ok === true;
  } catch {
    return false;
  }
}
