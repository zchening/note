/**
 * 扫码端 —— getUserMedia + BarcodeDetector/jsQR 自写全屏取景层
 *
 * 老项目在这里踩了 6 个坑，全部承接（不是抄代码，是抄**判据**）：
 *
 *  1. **BarcodeDetector 不可靠**（v10.1.5 血泪）
 *     部分 WebView 里构造函数存在、`detect()` 却每帧抛错（缺谷歌 ML 组件）；
 *     更阴的是 `detect()` 不抛错但永远返回空数组。
 *     症状：摄像头有实时画面、版本最新，却永远扫不出。
 *     判据：**连错 3 帧换引擎** + **40 帧零命中也换**。
 *
 *  2. **整帧解码在白烧像素**（v10.1.6 血泪）
 *     video 用 object-fit:cover，可见内容是按 stage 宽高比做的**中心裁剪**。
 *     1280×720 整帧在中端机要 150~300ms，实际只剩 2~3 次/秒 ——
 *     这是"对准后还要磨好几秒"的另一半根因。必须只解可见那一块。
 *
 *  3. **像素分级**（v10.1.6）
 *     先用小预算快试（帧率优先），连续 8 帧没中再升大预算（分辨率优先）。
 *     固定高像素 = 慢机型饿死；固定低像素 = 快机型白刷。
 *
 *  4. **在途 Promise 必须收口**（v10.1.4 血泪）
 *     旧写法取消时只 cleanup 不 resolve，上层 await 永久悬挂，
 *     再点一次就叠出第二层取景框（同一份 stream 句柄还漏在闭包里）。
 *
 *  5. **自排队 setTimeout 而非 setInterval**（v10.1.4）
 *     setInterval 下"一帧解到 400ms 时下一枪照发"，getImageData 堆积 = 更卡。
 *
 *  6. **jsQR 懒加载**（v10.1.7）
 *     detector 那条路上 jsQR 从没加载过，页面层的"抓拍识别"必须自己拉，
 *     否则 window.jsQR 是 undefined —— 新功能恰好在**最不需要救它的机型上**作废。
 *
 * 另有一条**刻意不做**的：老项目曾有"随包 ML Kit 原生预览层"（v10.1.6 加、v10.1.8 整体退役），
 * 代价是一整套附加零件（页面主体透明化、15 秒接力、相机句柄交接、手电所有权）。
 * 新项目只保留"有 BarcodeDetector 就用，没有就 jsQR"两级。
 */

/** 触发降级的连续报错帧数 */
const DETECTOR_ERR_FRAMES = 3;
/** 触发降级的零命中帧数（detect 不抛错但永远返回空数组） */
const DETECTOR_MISS_FRAMES = 40;
/** 连续 miss 多少帧后升到大像素预算 */
const TIER_UP_MISS = 8;
/** 小预算（帧率优先） */
const TIER_FAST = 560;
/** 大预算（分辨率优先） */
const TIER_CLEAR = 1120;
/** 单帧解码的最小/最大间隔（毫秒），自排队时按上一帧耗时自适应 */
const GAP_MIN = 120;
const GAP_MAX = 400;

export interface ScanDiag {
  engine: '' | 'detector' | 'jsqr' | 'jsqr(降级)';
  frames: number;
  hits: number;
  miss: number;
  errs: number;
  cam: string;
  dec: string;
  err0: string;
  result: string;
}

export function newDiag(): ScanDiag {
  return { engine: '', frames: 0, hits: 0, miss: 0, errs: 0, cam: '0x0', dec: '0x0', err0: '', result: '' };
}

let jsQrLoad: Promise<boolean> | null = null;

/** 懒加载 jsQR。失败可重试。 */
export function loadJsQr(src = '/jsQR.js'): Promise<boolean> {
  if (typeof window !== 'undefined' && typeof window.jsQR === 'function') {
    return Promise.resolve(true);
  }
  if (jsQrLoad) return jsQrLoad;
  jsQrLoad = new Promise<boolean>((resolve) => {
    const el = document.createElement('script');
    el.src = src;
    el.onload = () => {
      const ok = typeof window.jsQR === 'function';
      if (!ok) console.error('[scan] /jsQR.js 已加载但 window.jsQR 非函数（检查文件内容/UMD 形态）');
      resolve(ok);
    };
    el.onerror = (e) => {
      // 🔴 留日志（老项目 2026-09 血泪：服务器旧版/断网时这条分支才走到，
      //   当时没有任何日志，只能靠"是不是我网络坏了"猜）。
      console.error("[scan] /jsQR.js 加载失败（若控制台报 CSP violation 则 script-src 缺 'self'）", e);
      resolve(false);
    };
    document.head.appendChild(el);
  }).then((ok) => {
    if (!ok) jsQrLoad = null;
    return ok;
  });
  return jsQrLoad;
}

/** BarcodeDetector 的最小形状（只声明用到的那一个方法）。 */
interface DetectorLike {
  detect(src: HTMLVideoElement): Promise<Array<{ rawValue?: string }>>;
}

export function makeDetector(): DetectorLike | null {
  if (typeof window === 'undefined') return null;
  const Ctor = (window as unknown as { BarcodeDetector?: new () => DetectorLike }).BarcodeDetector;
  if (typeof Ctor !== 'function') return null;
  try {
    return new Ctor();
  } catch {
    // 🔴 构造函数存在但 new 抛错（老项目实锤：缺谷歌 ML 组件时这样）
    //   —— 这里静默返回 null 走 jsQR，不要让整层扫码崩掉。
    return null;
  }
}

/**
 * 按 stage 可见区域算「视频帧里的哪一块是可见的」。
 * 导出是因为它是本模块唯一的纯计算（可单测），且是最容易算错的一处。
 */
export interface CropRect {
  sx: number;
  sy: number;
  sw: number;
  sh: number;
}

export function visibleCrop(
  vw: number,
  vh: number,
  stageW: number,
  stageH: number,
): CropRect {
  if (vw <= 0 || vh <= 0 || stageW <= 0 || stageH <= 0) {
    return { sx: 0, sy: 0, sw: vw, sh: vh };
  }
  const aspect = stageW / stageH;
  let sw = vw;
  let sh = Math.round(vw / aspect);
  if (sh > vh) {
    sh = vh;
    sw = Math.round(vh * aspect);
  }
  return { sx: Math.round((vw - sw) / 2), sy: Math.round((vh - sh) / 2), sw, sh };
}

/** 按 miss 次数选像素预算。 */
export function tierFor(misses: number): number {
  return misses >= TIER_UP_MISS ? TIER_CLEAR : TIER_FAST;
}

/** 自排队间隔：上一帧越久，等得越久（但夹在 [120,400]）。 */
export function gapFor(costMs: number): number {
  return Math.min(GAP_MAX, Math.max(GAP_MIN, costMs + 120));
}

/** 是否应当从 detector 降级到 jsQR。 */
export function shouldDowngrade(d: ScanDiag): boolean {
  if (d.engine !== 'detector') return false;
  if (d.errs >= DETECTOR_ERR_FRAMES) return true;
  return d.frames >= DETECTOR_MISS_FRAMES && d.hits === 0;
}

/** 降级原因的人话版（给屏幕，不是给日志）。 */
export function downgradeWhy(d: ScanDiag): string {
  if (d.errs >= DETECTOR_ERR_FRAMES) return '解码器连错 ' + d.errs + ' 帧';
  return '解码器 ' + d.frames + ' 帧零命中';
}
