/**
 * 出码端 —— 把配对链接画成二维码
 *
 * 三条纪律（都来自老项目的实测教训，不是审美偏好）：
 *
 * 1. **自托管 + 同源懒加载**。老项目 v7.5.1 血泪：公共 CDN（jsdelivr）
 *    在大陆不可达，于是"点开配对弹窗一片空白"且控制台只有一句 404。
 *    与 loadHtml2Canvas / loadJsQR 同一范式。
 *
 * 2. **码必须有静区**。QR 规范要求四边各留 4 模块空白，没有它的话
 *    摄像头定位失败率极高 —— 症状是"我这台扫得出、那台扫半天没反应"。
 *
 * 3. **点码可全屏放大**。老项目 v7.5.1：反光/夜里对拍屏幕码时
 *    260px 的小码物理上扫不出来。放大态按 DPR 反推整数 scale，
 *    交给 CSS 拉伸 -> 边缘仍是硬边，摄像头才分得清。
 *
 * 零 DOM 依赖的部分（scale 计算）单独导出，可单测。
 */

/** 弹窗态固定 scale（老项目口径 5）。 */
const POPUP_SCALE = 5;
/** 弹窗态显示上限（老项目口径 260px）。 */
const POPUP_MAX_PX = 260;
/** 放大态最小位图宽：低于这个数摄像头基本解不出。 */
const LARGE_MIN_PX = 480;

export interface QrcodeApi {
  (typeNumber: 0, errorCorrectionLevel: 'L' | 'M' | 'Q' | 'H'): {
    addData(data: string, mode: 'Byte'): void;
    make(): void;
    getModuleCount(): number;
    isDark(row: number, col: number): boolean;
  };
}

declare global {
  interface Window {
    qrcode?: QrcodeApi;
    jsQR?: (
      data: Uint8ClampedArray,
      width: number,
      height: number,
      opts?: { inversionAttempts?: 'attemptBoth' | 'dontInvert' },
    ) => { data: string } | null;
  }
}

let qrLoadPromise: Promise<boolean> | null = null;

/** 懒加载 qrcode-generator。失败可重试（loadPromise 失败时清空）。 */
export function loadQrcode(src = '/qrcode-generator.js'): Promise<boolean> {
  if (typeof window !== 'undefined' && typeof window.qrcode === 'function') {
    return Promise.resolve(true);
  }
  if (qrLoadPromise) return qrLoadPromise;
  qrLoadPromise = new Promise<boolean>((resolve) => {
    const el = document.createElement('script');
    el.src = src;
    el.onload = () => {
      const ok = typeof window.qrcode === 'function';
      if (!ok) {
        // 🔴 留日志：文件存在但 UMD 形态不对时，页面上只表现为"弹窗里没码"，
        //   不留痕就只能靠猜（老项目 2026-09 排查 CSP 时踩过同一形状）。
        console.error('[pair] /qrcode-generator.js 已加载但 window.qrcode 非函数');
      }
      resolve(ok);
    };
    el.onerror = (e) => {
      // 🔴 同 loadHtml2Canvas：失败必留日志。控制台出现 CSP violation 提示
      //   就说明 script-src 缺 'self'，文件本身没问题。
      console.error("[pair] /qrcode-generator.js 加载失败（若控制台报 CSP violation 则 script-src 缺 'self'）", e);
      resolve(false);
    };
    document.head.appendChild(el);
  }).then((ok) => {
    // 🔴 失败必须把 memo 清掉，否则这次失败被永久缓存 ——
    //   症状是"刷新一下就好了，但再刷新又坏"，最难查的一种。
    if (!ok) qrLoadPromise = null;
    return ok;
  });
  return qrLoadPromise;
}

/** 由目标位图宽度反推整数 scale（含两侧各 4 模块静区）。 */
export function scaleFor(modules: number, wantPx?: number): number {
  if (wantPx === undefined) return POPUP_SCALE;
  // 🔴 Math.max(4, ...) 下限不是审美选择：scale 低于 4 时每格不到 4 设备像素，
  //   摄像头插值后边缘糊成一片，实测必然扫不出。
  return Math.max(4, Math.floor(wantPx / (modules + 8)));
}

/** 放大态目标位图宽：视口短边的 88% × DPR，下限 480。 */
export function largeTargetPx(viewportShort: number, dpr: number): number {
  return Math.max(LARGE_MIN_PX, Math.floor(viewportShort * 0.88 * (dpr || 2)));
}

export interface DrawDeps {
  qrcode: QrcodeApi;
  /** 目标宽（设备像素）。省略 = 弹窗态。 */
  wantPx?: number;
}

/** 把链接画到 canvas。返回模块数（供调用方算显示尺寸）。 */
export function drawQr(canvas: HTMLCanvasElement, text: string, deps: DrawDeps): number {
  const qr = deps.qrcode(0, 'M');
  qr.addData(text, 'Byte');
  qr.make();
  const n = qr.getModuleCount();
  const scale = scaleFor(n, deps.wantPx);
  const quiet = scale * 4;
  const size = n * scale + quiet * 2;
  canvas.width = size;
  canvas.height = size;
  if (deps.wantPx === undefined) {
    const shown = Math.min(size, POPUP_MAX_PX);
    canvas.style.width = shown + 'px';
    canvas.style.height = shown + 'px';
  }
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('2D 上下文不可用');
  // 🔴 画布必须先铺白底：透明底在部分扫码器上被当成"码本身有透明格"，
  //   表现为识别率随机波动、同一台机器时灵时不灵。
  ctx.fillStyle = '#FFFFFF';
  ctx.fillRect(0, 0, size, size);
  ctx.fillStyle = '#111111';
  for (let r = 0; r < n; r++) {
    for (let c = 0; c < n; c++) {
      if (qr.isDark(r, c)) ctx.fillRect(quiet + c * scale, quiet + r * scale, scale, scale);
    }
  }
  return n;
}
