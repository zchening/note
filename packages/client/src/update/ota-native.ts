/**
 * App 在线升级 —— 原生桥适配层（零 DOM，可单测）
 *
 * 🔴🔴 为什么不直接在 ota.ts 里写 Capacitor 调用：
 *   ota.ts 要能在 node 里单测（版本判定是纯逻辑），而 Capacitor 桥只在壳内存在。
 *   桥探测与降级全部收敛在这里，用「注入式依赖」传给 ota.ts，
 *   单测就能用假桥覆盖全部分支——包括"老壳没有这个桥"这种最该测的降级。
 *
 * 🔴🔴 桥形态必须与老项目一致（`Capacitor.Plugins.AppUpdate`，
 *   而不是 `Capacitor.registerPlugin` 的现代写法）：
 *   MainActivity 用 `registerPlugin(UpdatePlugin.class)` 显式注册，
 *   插件类上 `@CapacitorPlugin(name = "AppUpdate")`，
 *   运行时挂在 `window.Capacitor.Plugins.AppUpdate`。
 *   写错形态的唯一症状是"更新按钮点了没反应，且不报错"——
 *   `Plugins.AppUpdate` 取到 undefined，静默走 window.open 兜底。
 *
 * 🔴 每次都现读 window.Capacitor，不缓存：
 *   冷启动早期读一次可能拿到 undefined（Capacitor 注入晚于我们的脚本），
 *   缓存下来就永久是 undefined。老项目的做法是每次现读，照搬。
 *
 * 🔴 "老壳没有桥"是**正常状态**不是错误：
 *   上一版 APK 装的用户，在升级到本版之前一直是老壳。
 *   此时点「立即更新」必须退到"打开官方下载页"，不能装死。
 */

import { compareVersions, isNewer, noUpdate, parseLatest } from './ota.ts';
import type { LatestRelease } from './ota.ts';

/** 原生桥的最小形状（只声明用得到的字段，便于单测造假桥） */
export interface AppUpdateBridge {
  downloadApk(o: { url: string; tag: string; expectedBytes?: number; wifiOnly?: boolean }): Promise<DownloadResult>;
  downloadState(o: { id: number }): Promise<StateResult>;
  install(o: { path: string }): Promise<InstallResult>;
  requestInstallPermission?(): Promise<unknown>;
}

/** 原生版本查询桥（老项目挂在 RemPlugin 上，方法名 getVersion） */
export interface RemBridge {
  getVersion?(): Promise<{ nativeVersion?: string } | null>;
}

export interface DownloadResult {
  ok: boolean;
  id?: number;
  path?: string;
  reused?: boolean;
  attached?: boolean;
  error?: string;
}
export interface StateResult {
  ok: boolean;
  status?: 'pending' | 'running' | 'done' | 'failed' | 'gone';
  downloaded?: number;
  total?: number;
  path?: string;
  error?: string;
}
export interface InstallResult {
  ok: boolean;
  needPermission?: boolean;
  error?: string;
}

/** window.Capacitor 的最小形状 */
interface CapacitorLike {
  isNativePlatform?: () => boolean;
  Plugins?: Record<string, unknown>;
}

/** 注入式依赖 —— ota 层不碰 window，单测可换 */
export interface NativeDeps {
  /** 是否在 App 壳内（网页版 false） */
  isNativeApp: boolean;
  /** 取得 AppUpdate 桥；没有返回 null */
  getUpdateBridge: () => AppUpdateBridge | null;
  /** 取得原生版本；取不到返回 '' */
  getNativeVersion: () => Promise<string>;
  /** 同源 fetch（注入是为了单测能造各种失败） */
  fetchJson: (url: string) => Promise<{ ok: boolean; status: number; text: string }>;
  /** 网页版兜底：打开下载页 */
  openExternal: (url: string) => void;
}

/** 读 window 上的真实依赖（生产入口） */
export function nativeDepsFromWindow(win: Window): NativeDeps {
  const cap = (win as unknown as { Capacitor?: CapacitorLike }).Capacitor;
  return {
    isNativeApp: typeof cap?.isNativePlatform === 'function' ? cap.isNativePlatform() : false,
    getUpdateBridge: () => {
      const p = cap?.Plugins?.AppUpdate as AppUpdateBridge | undefined;
      return p && typeof p.downloadApk === 'function' ? p : null;
    },
    getNativeVersion: async () => {
      const rb = cap?.Plugins?.RemBridge as RemBridge | undefined;
      if (!rb || typeof rb.getVersion !== 'function') return '';
      try {
        const r = await rb.getVersion();
        return r && typeof r.nativeVersion === 'string' ? r.nativeVersion : '';
      } catch {
        // 🔴 取不到不是致命：退回用网页版 APP_VERSION 比较。
        //   宁可判"已是最新"也不要因为一次异常就弹一个装不上的包。
        return '';
      }
    },
    fetchJson: async (url) => {
      const r = await fetch(url, { cache: 'no-store' });
      return { ok: r.ok, status: r.status, text: await r.text() };
    },
    openExternal: (url) => {
      // 🔴 必须用 noopener：新标签页能拿到 opener 就能改本窗口地址
      //   （"反向标签页劫持"）。老项目写的 window.open(url,'_blank') 少了这个参数。
      win.open(url, '_blank', 'noopener,noreferrer');
    },
  };
}

/** 检查更新的结果，供 UI 分文案 */
export type CheckResult =
  | { kind: 'no-app' }                                   // 网页版：根本不显示这行
  | { kind: 'network'; status: number }                  // 404 = 服务器没发版；其他 = 请求异常
  | { kind: 'bad-json' }
  | { kind: 'no-apk' }                                   // 服务端发了版但没挂 APK（要查）
  | { kind: 'latest'; native: string }                   // 已是最新
  | { kind: 'update'; rel: LatestRelease; native: string };

/**
 * 点「检查更新」。
 *
 * 🔴 判"本机版本"的顺序：**原生 versionName 优先，网页版 APP_VERSION 兜底**。
 *   原因：APK 里 JS 与壳的版本可能不同步（网页层热更先到、壳还没发版，
 *   或反之）。拿 JS 版本去比 APK 的新版本会得出错误结论：
 *   壳旧 JS 新 → 认为无需升级（其实壳确实旧，但升级也没用，没有新壳）；
 *   壳新 JS 旧 → 提示升级到同版（装了个寂寞）。原生版本才是"我能升到什么"的真源。
 */
export async function checkUpdate(deps: NativeDeps, webVersion: string): Promise<CheckResult> {
  if (!deps.isNativeApp) return { kind: 'no-app' };

  const native = await deps.getNativeVersion();
  const local = native || webVersion;

  let resp: { ok: boolean; status: number; text: string };
  try {
    resp = await deps.fetchJson('/api/latest?ts=' + Date.now());
  } catch {
    return { kind: 'network', status: 0 };
  }
  if (!resp.ok) return { kind: 'network', status: resp.status };

  const parsed = parseLatest(resp.text, local);
  if (!parsed.ok) {
    if (parsed.reason === 'not-newer') return { kind: 'latest', native: local };
    if (parsed.reason === 'bad-json') return { kind: 'bad-json' };
    if (parsed.reason === 'no-apk') return { kind: 'no-apk' };
    return { kind: 'bad-json' };
  }
  return { kind: 'update', rel: parsed.rel, native: local };
}

/** 下载进度回调 */
export type ProgressFn = (downloaded: number, total: number) => void;

/** 轮询间隔（毫秒）。 */
const POLL_MS = 700;
/** 单次下载的总时长上限（毫秒）。超了当失败，不无限等。
 *  🔴 APK 约 26MB，慢网 3~5 分钟正常；15 分钟还下不完基本是卡死了。 */
const TOTAL_TIMEOUT_MS = 15 * 60_000;

/**
 * 「立即更新」完整流程：下载 → 校验 → 拉系统安装器。
 *
 * 🔴🔴 幂等语义：同一 url 已有在跑单时，原生桥返回 attached，JS 接管轮询而不重下。
 *   老项目 v10.1.0 修的就是"预下载与手动下载互撤单"，症状是
 *   「下载被取消」—— 那时预下载已删掉对方正在写的文件。
 *   现在原生侧改成在跑单接管，JS 侧只管轮询。
 *
 * @returns 给用户看的一句话（不抛异常：升级失败不该崩页面）
 */
export async function runUpdate(
  deps: NativeDeps,
  rel: LatestRelease,
  onProgress: ProgressFn,
): Promise<string> {
  const br = deps.getUpdateBridge();
  if (!br) {
    // 🔴 老壳无桥：退到打开下载页，不装死。老项目的原话是
    //   「当前版本壳不支持一键升级，正在打开官方下载页」。
    deps.openExternal(rel.url);
    return '当前版本壳不支持一键升级，正在打开官方下载页';
  }

  let dl: DownloadResult;
  try {
    dl = await br.downloadApk({
      url: rel.url,
      tag: rel.version,
      // 🔴 expectedBytes 必须传：原生侧靠它做精确尺寸校验，
      //   少了它就用"文件 >1MB 即复用"的粗判，截断的 APK 会被当已下完反复复用，
      //   最后安装器报 packageInfo is null（老项目 v9.5.4 修的正是这个）。
      expectedBytes: rel.size,
    });
  } catch (e) {
    return '下载失败：' + errText(e);
  }
  if (!dl.ok) {
    if (dl.error === 'not-wifi') return '当前不是 Wi-Fi，已跳过下载';
    if (dl.error === 'not-https') return '下载地址不是 https，已拒绝下载';
    return '下载失败：' + (dl.error || '未知原因');
  }

  // reused / attached 两种复用路径：都没有 id，只有 path
  if (!dl.id) {
    if (!dl.path) return '下载失败：原生未返回下载任务号与路径';
    return finishInstall(br, dl.path);
  }

  // 轮询
  const t0 = Date.now();
  for (;;) {
    if (Date.now() - t0 > TOTAL_TIMEOUT_MS) return '下载超时，请检查网络后重试';
    await sleep(POLL_MS);
    let st: StateResult;
    try {
      st = await br.downloadState({ id: dl.id });
    } catch (e) {
      return '查询下载状态失败：' + errText(e);
    }
    if (!st.ok) return '查询下载状态失败：' + (st.error || '未知原因');
    const s = st.status || 'running';
    if (s === 'pending' || s === 'running') {
      onProgress(st.downloaded || 0, st.total || rel.size);
      continue;
    }
    if (s === 'gone') {
      // 🔴 gone = DownloadManager 侧记录没了（被系统清理/进程换代）。
      //   路径还在就照样能装；路径没了只能说失败。
      return st.path ? finishInstall(br, st.path) : '下载已丢失，请重试';
    }
    if (s === 'failed') return '下载失败：' + (st.error || '请重试');
    if (s === 'done') {
      if (!st.path) return '下载完成但拿不到文件路径';
      return finishInstall(br, st.path);
    }
  }
}

/** 拉起系统安装器；Android 8+ 未授权时先跳设置页授权再回来装。 */
async function finishInstall(br: AppUpdateBridge, path: string): Promise<string> {
  let r: InstallResult;
  try {
    r = await br.install({ path });
  } catch (e) {
    return '拉起安装失败：' + errText(e);
  }
  if (r.ok) return '正在打开安装程序';
  if (r.needPermission) {
    // 🔴 授权结果无法回传（跳的是系统设置页），所以"已尽力"就是全部语义。
    //   用户授权后需要自己再点一次更新。老项目同款处理。
    try { await br.requestInstallPermission?.(); } catch { /* 无此页的 ROM 静默咽下 */ }
    return '在设置里允许「安装未知应用」后，回到这里再点一次';
  }
  return '拉起安装失败：' + (r.error || '未知原因');
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function errText(e: unknown): string {
  const m = e instanceof Error ? e.message : String(e);
  return m.slice(0, 60) || '未知原因';
}

/** 关于页要显示的 App 版本行。取不到原生版本时返回 ''（该行隐藏）。 */
export function appVersionLine(deps: NativeDeps, webVersion: string): Promise<string> {
  if (!deps.isNativeApp) return Promise.resolve('');
  return deps.getNativeVersion().then((v) => (v ? 'Version ' + v : ''));
}

/** 已在本地，用于 UI 层判断"该不该显示检查更新行" */
export { isNewer, compareVersions, noUpdate };
