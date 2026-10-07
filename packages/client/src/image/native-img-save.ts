/**
 * 原生存相册桥适配层（零 DOM，可单测）
 *
 * 🔴 桥形态逐字对齐 ImgSavePlugin.kt:29 `@CapacitorPlugin(name = "ImgSave")`
 *   ⇒ 运行时挂在 `window.Capacitor.Plugins.ImgSave`。
 *   MainActivity.java:167 `registerPlugin(ImgSavePlugin.class)` 显式注册。
 *   插件自己的注释（ImgSavePlugin.kt:28）也写明了这条规矩：
 *   「JS 每次现读 Capacitor.Plugins.ImgSave，失败静默回退」。
 *
 * ── 方法签名（**读 Kotlin 源码抄下来的**）─────────────────────────────────
 *
 *   ImgSavePlugin.kt:35-64  `@PluginMethod fun saveImage(call: PluginCall)`
 *     · 入参：`call.getString("base64")`（:39，空串 ⇒ `{ok:false, error:"empty"}`）
 *            `call.getString("mime")`，缺省 `"image/jpeg"`（:44）
 *     · 成功：`{ok:true, path, bytes}`（:57）
 *     · 失败：`{ok:false, error:"save-failed" | 异常消息}`（:55 / :61）
 *   ⚠️ **全程 `call.resolve`，从不 `call.reject`**（:63）——
 *     所以"失败"也是 resolve 出来的 `{ok:false}`，不是异常。
 *     这就是为什么下面两档都必须判`res.ok === true` 而不是"没抛错就算成功"。
 *
 *   ImgSavePlugin.kt:69-134  `@PluginMethod fun saveImageUrl(call: PluginCall)`
 *     · 入参：`call.getString("url")`（:73），
 *       **非 `https://` 开头直接 `{ok:false, error:"not-https"}`**（:74-77）
 *     · 成功：`{ok:true, path, bytes}`（:127）
 *     · 失败：`{ok:false, error:"not-https" | "download-failed" | "too-large" | "save-failed"}`
 *     · ⚠️ 原生自己用 `HttpURLConnection` 取字节（:82），**不吃页面 CORS** ——
 *       这正是老项目 v9.3.0 把主路径换成它的原因（Cloudinary 偶发 CORS/缓存失败
 *       导致"点保存变成打开链接"，index.html:5558-5560 原文）。
 *
 * ── 与 ImgClip 的分工（别重复做）──────────────────────────────────────
 *   `ImgClip.copyImage` 是**导出长图复制到剪贴板**，已在 main.ts:855-875 接好
 *   （`nativeCopyImage`）+ export/render.ts:231-233。
 *   本文件只管**保存到相册**，两条路不重叠。
 */

/** `saveImage` / `saveImageUrl` 的返回（ImgSavePlugin 侧永远 resolve，不 reject）。 */
export interface SaveResult {
  ok?: boolean;
  /** 落盘路径（`ok:true` 时有）。API29+ 是 MediaStore 的 content:// URI。 */
  path?: string;
  bytes?: number;
  /** 失败原因（`ok:false` 时有）。原生把它塞进 resolve 里，不是抛出来的。 */
  error?: string;
}

/** 桥的最小形状（只声明用得到的字段，便于单测造假桥）。 */
export interface ImgSaveBridgeLike {
  saveImage(o: { base64: string; mime: string }): Promise<SaveResult | null>;
  saveImageUrl?(o: { url: string }): Promise<SaveResult | null>;
}

/** window.Capacitor 的最小形状（与 update/ota-native.ts:65 同款）。 */
interface CapacitorLike {
  Plugins?: Record<string, unknown>;
}

/**
 * 取 ImgSave 桥。**每次调用都重新读 window，绝不缓存成模块级 const。**
 *
 * 🔴🔴 顺序与 native-rem.ts 同款，判据 IMGSAVE-01 钉它：
 *   ① `window.Capacitor.Plugins.ImgSave`（Capacitor 官方暴露路径，真机唯一有效）
 *   ② `window.ImgSave`（回退，保留单测注入 mock 的能力）
 *
 * 🔴 **只收 `saveImage`**：`saveImageUrl` 是 v9.3.0 才加的，老壳上没有。
 *   判据是 `saveImage` 在（那是 v9.2.0 的初版接口，:36），`saveImageUrl` 有则用、没有跳过。
 *   反过来判会栽在"壳比桥新"的组合上。
 *
 * @param win 注入的 window（单测传假窗；生产不传走真window）
 */
export function getImgSaveBridge(win?: unknown): ImgSaveBridgeLike | null {
  const w = (win ?? (typeof window !== 'undefined' ? window : undefined)) as
    | { Capacitor?: CapacitorLike; ImgSave?: unknown }
    | undefined;
  if (!w) return null;
  const viaCapacitor = w.Capacitor?.Plugins?.ImgSave as ImgSaveBridgeLike | undefined;
  const rb = viaCapacitor ?? (w.ImgSave as ImgSaveBridgeLike | undefined);
  if (!rb || typeof rb.saveImage !== 'function') return null;
  return rb;
}

/**
 * 第① 档：壳内 https 直链 → 原生下载并存相册（老项目 index.html:5561-5566）。
 *
 * 🔴🔴 **只认 https**，非 https 直接跳过本档、落到第 ② 档。
 *   这不是我们的选择，是原生的硬约束（ImgSavePlugin.kt:74 非 https ⇒
 *   `{ok:false, error:"not-https"}`）。判一次比白跑一趟原生便宜。
 *
 * @returns 原生回报 `ok:true` 才算成功。**桥不存在 / 抛错 / ok:false 一律 false，绝不抛。**
 *         口径同 main.ts:866 `nativeCopyImage`：抛错会把调用方后面的回退链断掉。
 */
export async function nativeSaveImageUrl(
  src: string,
  win?: unknown,
): Promise<SaveResult | null> {
  if (!/^https:/i.test(src)) return null;
  const rb = getImgSaveBridge(win);
  if (!rb || typeof rb.saveImageUrl !== 'function') return null;
  try {
    const res = await rb.saveImageUrl({ url: src });
    return res?.ok === true ? res : null;
  } catch {
    return null;
  }
}

/**
 * 第 ② 档：base64 桥（老项目 index.html:5572-5575）。
 *
 * 🔴 保留给**旧壳与 `data:` 本地图**（它们走不了第 ① 档的 https 直链）。
 *
 * @param b64 **不带 `data:` 前缀**的 base64（Kotlin 侧 `Base64.decode` 直接解，
 *        带前缀会解出垃圾字节）。用 export/render.ts的 `blobToB64`——它已经剥了前缀。
 * @returns 原生回报 `ok:true` 才算成功；其余一律 null，绝不抛。
 */
export async function nativeSaveImage(
  b64: string,
  mime: string,
  win?: unknown,
): Promise<SaveResult | null> {
  const rb = getImgSaveBridge(win);
  if (!rb) return null;
  try {
    const res = await rb.saveImage({ base64: b64, mime });
    return res?.ok === true ? res : null;
  } catch {
    return null;
  }
}