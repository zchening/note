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
/**
 * 🔴 v1.12.0：连续 miss 多少帧后升到大像素预算。
 *
 * 老项目基线是 8（v10.1.6定的）。用户报障「老版本扫描识别更快」，
 * 本版调 8 → 14：**更久保持高帧率**，快档每帧耗时低、帧数多，
 * 帧数够时根本走不到升档那一步 —— 对"码大且手机不慢"的场景是纯增益。
 *
 * ⚠️ 代价：码**很小或很远**时要多扫 6 帧才升清晰档（按 GAP_MIN=90ms 约多 0.5 秒）。
 * 用户明确选择跳过真机验证直接改，所以这里是**方向正确但未在真机定量**的取值；
 * 真机实测若发现"远距离码反而更慢"，第一个该回退的就是这个数。
 */
const TIER_UP_MISS = 14;
/**
 * 🔴 v1.12.0：小预算（帧率优先）560 → 640。
 *   提一档分辨率换更早解出，单帧耗时上升但仍在 GAP_MIN 夹紧范围内。
 */
const TIER_FAST = 640;
/** 大预算（分辨率优先） */
const TIER_CLEAR = 1120;
/**
 * 🔴 v1.12.0：单帧解码的**额外余量**（在实测耗时之外再等的毫秒数）。
 *
 * 🔴🔴 v1.12.0 修正一处自己没想清楚的地方：
 *   上一轮只把 GAP_MIN 120→90 称作"帧率上限8/s→11/s"，**那是错的** ——
 *   `gapFor` 的实际公式是 `clamp(costMs + 余量, GAP_MIN, GAP_MAX)`，
 *   而 `costMs + 120` 在绝大多数机型上**早就大于 90**，所以 GAP_MIN 那一项
 *   根本不是约束项，**改它几乎是空操作**（ENGINE-05 首跑`120 !== 90` 抓到的就是
 *   "常量改了但公式里那120 没改"，公式其实由 GAP_MIN 与余量两处共同决定）。
 *
 *   ⇒ **帧率真正的杠杆是这个余量**：它才是"帧解完再多喘一会儿"的那部分。
 *     老项目基线 120ms，本版调 60ms —— 帧率上限从约 8次/秒提到约 11次/秒。
 *
 * ⚠️ 为什么不直接把公式改成 `costMs * 1.1`？自排队的意义是**帧与帧之间让出主线程**，
 *   余量太小会让 getImageData 堆积（老项目 v10.1.4 的血泪：setInterval 下"一帧解到
 *   400ms 时下一枪照发"）。60ms 是"比 120 明显快、仍留出让步余量"的折中。
 */
const GAP_PAD = 60;
/** 自排队间隔的下限（毫秒）—— 仅在上一帧极快、余量不足以撑起间隔时生效 */
const GAP_MIN = 90;
/** 单帧解码的最大间隔（毫秒），自排队时按上一帧耗时自适应 */
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

/**
 * 🔴 v1.12.0：空闲时预拉 jsQR（127KB），消掉"点开扫码才下载"的那一次等待。
 *
 * 动机（用户报障：「老版本扫描识别更快」）：老项目 index.html:2877 有
 * `prefetchHtml2CanvasIdle` —— 页面一空闲就把导出组件拉好，所以点导出是热的。
 * bj 此前**完全没有预热**（全src/ grep `requestIdleCallback` 命中 0），
 * `loadJsQr` 只在 layer.ts 打开扫码浮层时才被调 ⇒ 打开扫码的第一件事就是
 * 等一个 127KB 的网络往返，而解码马上就用它。
 *
 *🔴 为什么这个函数是**幂等且不阻塞**的：
 *   · 复用 `loadJsQr`，它自带 in-flight 去重（jsQrLoad）⇒ 预热与扫码并发不会拉两次。
 *   · `requestIdleCallback` 带 timeout 兜底 —— 移动内核（尤其国产 WebView）
 *     可能压根不调 rIC，只靠它会永远不预热。
 *   · 两道保险（rIC + setTimeout）重复调用同 URL 无害，`loadJsQr` 去重。
 *   · 失败不重试也不打印：预热是**可选优化**，失败只意味着回到"扫码时再拉"，
 *     而那时 `loadJsQr` 自己会打日志（`onerror` 那条）。这里再打一遍就是
 *     同一条原因刷两行日志，干扰真排查。
 *
 * 🔴 顺序陷阱：老项目的 `setTimeout(go, 8000)` 放在 rIC **之后**，
 *   这里照抄同一顺序 —— 两次调用的结果由 `loadJsQr` 内部去重兜住，
 *   换顺序不会出错，但保持一致便于日后对照老项目。
 *
 * 🔴 不在 Node 侧直接调用（`typeof window` 守卫）：本文件被单测直接 import，
 *   无window 环境时立刻返回，不能碰document。
 */
export function prefetchJsQrIdle(src = '/jsQR.js'): void {
  if (typeof window === 'undefined') return;
  const go = (): void => {
    try {
      void loadJsQr(src).catch(() => {});
    } catch {
      /* 预热失败静默：扫码时那次调用自己会报 */
    }
  };
  try {
    if (typeof window.requestIdleCallback === 'function') {
      window.requestIdleCallback(go, { timeout: 4000 });
    } else {
      setTimeout(go, 3000);
    }
    setTimeout(go, 8000); // 移动内核 rIC 可能不来：双保险，重复调用同 URL 去重无害
  } catch {
    go();
  }
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

/**
 * 🔴 v1.12.0：档位的**人话标签**，给诊断字段 `dec` 用。
 *
 * 存在的理由：layer.ts 原来写 `tier > 560` 判断「显示清还是快」，
 * 而 TIER_FAST 已调成 640 ⇒ `640 > 560` **恒真** ⇒ 无论跑哪档都显示"清"，
 * 诊断标签彻底失效（症状：?diag 里尺寸后面的字恒为"清"）。
 *
 * 同源化后调用方不再复制任何魔法数，改常量时不必记得来改第二处。
 */
export function tierLabel(tier: number): '清' | '快' {
  return tier === TIER_CLEAR ? '清' : '快';
}

/** 自排队间隔：上一帧越久，等得越久（但夹在 [120,400]）。 */
export function gapFor(costMs: number): number {
  return Math.min(GAP_MAX, Math.max(GAP_MIN, costMs + GAP_PAD));
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
