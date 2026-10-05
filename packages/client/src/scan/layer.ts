/**
 * 取景层 —— 扫一扫的全屏扫描浮层
 *
 * 判据全部来自 engine.ts 里注明的 6 条老项目血泪，本文件只负责"把那些判据执行掉"：
 * 引擎降级、可见区裁剪、像素分级、自排队、在途 Promise 收口、jsQR 自拉。
 *
 * 🔴 一条**不承接**的老项目行为：老项目在 60 秒后自动收起二维码，
 *   新项目改成常驻（老项目 v7.5.1 起其实已经去掉了自动隐藏，
 *   但 resetQrHolder 里的"重新显示"按钮逻辑还留着）——
 *   常驻更符合"配对时另一台设备可能过一会儿才拿出来"的实际。
 */

import { COPY } from '../ui/copy.ts';
import {
  downgradeWhy,
  gapFor,
  loadJsQr,
  makeDetector,
  newDiag,
  shouldDowngrade,
  tierFor,
  visibleCrop,
  type ScanDiag,
} from './engine.ts';

export interface ScanLayerDeps {
  /** 拿到码后回调。返回 true 表示已处理。 */
  onResult: (raw: string) => void;
  /** 状态行（常驻，用于上屏"为什么扫不出"）。 */
  onHint: (text: string) => void;
  /** 自检数据写回（供诊断页读）。 */
  onDiag: (d: ScanDiag) => void;
  /** 用户取消 / 失败。 */
  onClosed: () => void;
}

export type ScanOutcome =
  /** 正常：流起、解码循环跑起来了 */
  | { kind: 'open' }
  /** 相机起不来：已给可见原因，浮层已拆 */
  | { kind: 'camfail'; reason: string }
  /** 组件不可用（非安全上下文 / jsQR 拉不到） */
  | { kind: 'compfail'; reason: string };

/** 抖动的三个点（老项目 v8.1.4 起的"正在开启相机…"占位）。 */
const DOTS = '<span class="ns-sd"></span><span class="ns-sd ns-sd2"></span><span class="ns-sd ns-sd3"></span>';

function ensureStageCss(): void {
  if (document.getElementById('scanStageCss')) return;
  const css = document.createElement('style');
  css.id = 'scanStageCss';
  css.textContent =
    '@keyframes nsScanSweep{0%{top:16px;opacity:0}12%{opacity:1}88%{opacity:1}100%{top:calc(100% - 18px);opacity:0}}' +
    '.ns-scan-line{animation:nsScanSweep 2.1s cubic-bezier(.45,0,.55,1) infinite}' +
    '@keyframes nsScanDot{0%,60%,100%{opacity:.25}30%{opacity:1}}' +
    '.ns-sd{display:inline-block;width:3px;height:3px;border-radius:50%;background:currentColor;margin:0 2px;' +
    'vertical-align:middle;animation:nsScanDot 1.4s infinite}' +
    '.ns-sd2{animation-delay:.2s}.ns-sd3{animation-delay:.4s}';
  document.head.appendChild(css);
}

export function buildScanLayer(deps: ScanLayerDeps): { el: HTMLElement; close: () => void } {
  ensureStageCss();

  const overlay = document.createElement('div');
  overlay.className = 'mask';
  overlay.id = 'scanMask';
  // 🔴 z-index 必须显式给：落地页自身的遮罩是 z30，而 .ns-mask 默认更低，
  //   在首页点「扫码打开笔记」时取景框会被压在落地页底下 ——
  //   症状是"点了没反应"，实际浮层已经建好了（老项目 v7.7.0 同款）。
  overlay.style.zIndex = '40';

  const box = document.createElement('div');
  box.className = 'box';
  // 🔴 max-height + overflow：横屏矮视口下按钮不被顶出屏（老项目 v10.1.4）。
  box.setAttribute('style', 'text-align:center;max-height:calc(100vh - 48px);overflow:auto');

  const h = document.createElement('h1');
  h.className = 'qr-title';
  h.textContent = COPY.scanTitle;

  const stage = document.createElement('div');
  stage.className = 'ns-scan-stage';

  const video = document.createElement('video');
  video.setAttribute('playsinline', '');
  video.muted = true;
  video.autoplay = true;
  // 🔴 出帧前先藏：国产 WebView 在 getUserMedia 冷启动空窗期会画默认播放三角。
  video.setAttribute('style', 'position:absolute;inset:0;width:100%;height:100%;object-fit:cover;visibility:hidden');

  const reticle = document.createElement('div');
  reticle.setAttribute('style', 'position:absolute;inset:0;pointer-events:none');
  reticle.innerHTML =
    '<span style="position:absolute;left:16px;top:16px;width:26px;height:26px;border:2px solid var(--accent);border-right:0;border-bottom:0;border-radius:6px 0 0 0;opacity:.9"></span>' +
    '<span style="position:absolute;right:16px;top:16px;width:26px;height:26px;border:2px solid var(--accent);border-left:0;border-bottom:0;border-radius:0 6px 0 0;opacity:.9"></span>' +
    '<span style="position:absolute;left:16px;bottom:16px;width:26px;height:26px;border:2px solid var(--accent);border-right:0;border-top:0;border-radius:0 0 0 6px;opacity:.9"></span>' +
    '<span style="position:absolute;right:16px;bottom:16px;width:26px;height:26px;border:2px solid var(--accent);border-left:0;border-top:0;border-radius:0 0 6px 0;opacity:.9"></span>' +
    '<span class="ns-scan-line" style="position:absolute;left:16px;right:16px;top:16px;height:2px;border-radius:2px;background:linear-gradient(90deg,transparent,var(--accent) 18%,var(--accent) 82%,transparent);box-shadow:0 0 14px 2px var(--ring)"></span>';

  const status = document.createElement('div');
  status.className = 'ns-scan-status';
  status.innerHTML = COPY.scanOpening + DOTS;

  stage.append(video, reticle, status);

  const tip = document.createElement('p');
  tip.className = 'ns-scan-tip';
  tip.textContent = COPY.scanTip;

  const cancel = document.createElement('button');
  cancel.id = 'scanCancel';
  cancel.textContent = COPY.scanCancel;

  const snap = document.createElement('button');
  snap.id = 'scanSnap';
  snap.className = 'ns-ghost-btn';
  snap.textContent = COPY.scanSnap;

  box.append(h, stage, tip, cancel, snap);
  overlay.appendChild(box);

  const setHint = (t: string): void => {
    status.textContent = t;
  };

  let stream: MediaStream | null = null;
  let timer: number | null = null;
  let hintTimer: number | null = null;
  let revealTimer: number | null = null;
  let done = false;
  let aborted = false;
  let revealed = false;
  let snapFn: (() => void) | null = null;

  const clearTimers = (): void => {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
    if (hintTimer !== null) {
      clearTimeout(hintTimer);
      hintTimer = null;
    }
    if (revealTimer !== null) {
      clearTimeout(revealTimer);
      revealTimer = null;
    }
  };

  const cleanup = (): void => {
    done = true;
    aborted = true;
    clearTimers();
    // 🔴 流必须停：漏掉这一句 = 摄像头顶着红色指示灯一直亮着，
    //   而且下一次扫码拿不到流（老项目 v10.1.4 的在途泄漏同源）。
    if (stream) {
      for (const t of stream.getTracks()) t.stop();
      stream = null;
    }
    if (overlay.parentNode) overlay.parentNode.removeChild(overlay);
    snapFn = null;
  };

  // 🔴🔴 取消/点遮罩必须把在途 Promise **收口**（老项目 v10.1.4 血泪）。
  //   旧写法只 cleanup 不 resolve：上层 await 永久悬挂，
  //   再点一次「扫一扫」就叠出第二层取景框，且同一份 stream 句柄还漏在闭包里。
  const abortScan = (): void => {
    cleanup();
    deps.onClosed();
  };
  cancel.addEventListener('click', abortScan);
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) abortScan();
  });
  const onKey = (e: KeyboardEvent): void => {
    if (e.key === 'Escape') abortScan();
  };
  document.addEventListener('keydown', onKey, true);

  const reveal = (): void => {
    if (revealed) return;
    revealed = true;
    video.style.visibility = 'visible';
    setHint(COPY.scanIdentifying);
  };
  video.addEventListener('loadedmetadata', reveal);
  video.addEventListener('loadeddata', reveal);
  video.addEventListener('canplay', reveal);
  video.addEventListener('playing', reveal);

  // 720p 软目标（ideal 非 exact，拿不到自动回落默认档，不会抛 OverconstrainedError）
  const want = { video: { facingMode: 'environment', width: { ideal: 1280 }, height: { ideal: 720 } } };

  const startLoop = (): void => {
    const diag = newDiag();
    let detector = makeDetector();
    diag.engine = detector ? 'detector' : 'jsqr';
    // canvas/ctx **无条件**建：抓拍要落帧取像素，而 detector 在位时最容易忘了建 ——
    // 于是"谷歌解码器还在跑"这条最主流的路径上第一下点抓拍必报"画面还没准备好"（老项目 v10.1.7 闸 R1）。
    const cvs = document.createElement('canvas');
    const ctx = cvs.getContext('2d', { willReadFrequently: true });

    const switchToJsQr = async (why: string): Promise<boolean> => {
      if (!diag.err0) diag.err0 = why;
      if (!(await loadJsQr())) return false;
      detector = null;
      diag.engine = 'jsqr(降级)';
      deps.onDiag({ ...diag });
      return true;
    };

    // 🔴 6 秒就把"卡在哪一层"写屏：只说"识别中"= 和没反应一个观感（老项目 v10.1.4 闸 R3）。
    hintTimer = window.setTimeout(() => {
      if (!done) setHint(COPY.scanAlign + ' · ' + downgradeWhy(diag));
    }, 6000);

    const hit = (value: string): void => {
      if (done) return;
      deps.onDiag({ ...diag, result: '命中', hits: diag.hits + 1 });
      done = true;
      clearTimers();
      setHint(COPY.scanHit);
      // 🔴 延迟 160ms 收场：让人看见"已识别"再消失，别凭空一闪就没了。
      timer = window.setTimeout(() => {
        cleanup();
        deps.onResult(value);
      }, 160);
    };

    const tick = async (): Promise<void> => {
      if (done) return;
      const t0 = Date.now();
      let hitVal = '';
      diag.frames++;
      try {
        if (detector) {
          const codes = await detector.detect(video);
          if (codes && codes[0] && codes[0].rawValue) {
            diag.hits++;
            hitVal = codes[0].rawValue;
          }
        } else if (video.videoWidth && ctx) {
          const vw = video.videoWidth;
          const vh = video.videoHeight;
          diag.cam = vw + 'x' + vh;
          // 🔴 只解**取景框里真正看得见的那一块**（老项目 v10.1.6）。
          //   整帧解 = 1280×720 在中端机 150~300ms/帧 → 实际只有 2~3 次/秒。
          const sr = stage.getBoundingClientRect();
          const crop = visibleCrop(vw, vh, sr.width, sr.height);
          const tier = tierFor(diag.miss);
          const w = Math.min(tier, crop.sw);
          const hh = Math.max(1, Math.round((w * crop.sh) / crop.sw));
          cvs.width = w;
          cvs.height = hh;
          ctx.drawImage(video, crop.sx, crop.sy, crop.sw, crop.sh, 0, 0, w, hh);
          const img = ctx.getImageData(0, 0, w, hh);
          const r = window.jsQR?.(img.data, w, hh, { inversionAttempts: 'attemptBoth' });
          diag.dec = w + 'x' + hh + (tier > 560 ? '清' : '快');
          if (r && r.data) {
            diag.hits++;
            hitVal = r.data;
          } else {
            diag.miss++;
          }
        }
      } catch (e) {
        diag.errs++;
        if (!diag.err0) diag.err0 = String((e as Error)?.message ?? e);
      }
      if (done) return;
      if (diag.frames % 20 === 0) deps.onDiag({ ...diag });
      if (hitVal) {
        hit(hitVal);
        return;
      }
      // 🔴 降级判据两条都在这里（老项目 v10.1.5/v10.1.6）：
      //   连错 3 帧 / 40 帧零命中。少任何一条都会出现"画面在跑、永远扫不出"。
      if (shouldDowngrade(diag)) {
        const why = downgradeWhy(diag);
        await switchToJsQr(why);
        deps.onDiag({ ...diag });
      }
      // 🔴 自排队 setTimeout，不是 setInterval：帧与帧互相排队 = getImageData 堆积更卡。
      timer = window.setTimeout(() => void tick(), gapFor(Date.now() - t0));
    };

    // 〔抓拍识别〕：停一帧按全分辨率单张解一次。反光/对焦不实时连续低清帧几乎必然全 miss。
    snapFn = (): void => {
      if (done || !video.videoWidth) {
        setHint(COPY.scanSnapWait);
        return;
      }
      setHint(COPY.scanSnapDoing);
      void (async () => {
        try {
          // 🔴 detector 那条路上 jsQR 从没加载过，抓拍必须自己拉
          //   （老项目 v10.1.7：否则 window.jsQR 是 undefined）。
          if (typeof window.jsQR !== 'function' && !(await loadJsQr())) {
            setHint(COPY.scanSnapNoLib);
            return;
          }
          if (!ctx) {
            setHint(COPY.scanSnapFail);
            return;
          }
          const iw = video.videoWidth;
          const ih = video.videoHeight;
          const w = Math.min(1600, iw);
          const hh = Math.max(1, Math.round((w * ih) / iw));
          cvs.width = w;
          cvs.height = hh;
          ctx.drawImage(video, 0, 0, iw, ih, 0, 0, w, hh);
          const img = ctx.getImageData(0, 0, w, hh);
          const r = window.jsQR?.(img.data, w, hh, { inversionAttempts: 'attemptBoth' });
          diag.dec = w + 'x' + hh + '抓拍';
          if (r && r.data) {
            hit(r.data);
            return;
          }
          deps.onDiag({ ...diag });
          setHint(COPY.scanSnapMiss);
        } catch (e) {
          diag.errs++;
          if (!diag.err0) diag.err0 = String((e as Error)?.message ?? e);
          deps.onDiag({ ...diag });
          setHint(COPY.scanSnapFail);
        }
      })();
    };
    snap.addEventListener('click', () => {
      // 🔴 句柄还没挂上时也得给一句反馈：静默 = 用户以为按钮坏了。
      if (snapFn) snapFn();
      else setHint(COPY.scanOpening);
    });

    if (aborted) {
      cleanup();
      return;
    }
    timer = window.setTimeout(() => void tick(), 0);
  };

  void (async () => {
    if (!navigator.mediaDevices?.getUserMedia) {
      // 🔴 非安全上下文（HTTP）才有这条。APK 壳里 Capacitor 走 https，不受影响。
      document.removeEventListener('keydown', onKey, true);
      cleanup();
      deps.onClosed();
      deps.onHint(COPY.scanNeedHttps);
      return;
    }
    // 组件可用性：BarcodeDetector 优先；都没有才必须拉 jsQR。
    // 🔴 判"不支持"与"组件加载失败"要分开（老项目 v6.1）——
    //   前者让用户换设备，后者让他重试，混成一句只会让人反复点。
    if (!makeDetector() && !(await loadJsQr())) {
      document.removeEventListener('keydown', onKey, true);
      cleanup();
      deps.onClosed();
      deps.onHint(COPY.scanCompFail);
      return;
    }
    try {
      stream = await navigator.mediaDevices.getUserMedia(want);
    } catch (e) {
      // 🔴 相机起不来就**立即收口**：浮层当场拆、流当场放。
      //   老项目这里曾留层等用户选退路，现在没有退路了，
      //   留着只是让用户对着一个永远扫不出的黑框枯等。
      const name = (e as { name?: string })?.name;
      const reason =
        name === 'NotAllowedError' ? COPY.scanDenied : name === 'NotFoundError' ? COPY.scanNoCamera : COPY.scanStartFail;
      document.removeEventListener('keydown', onKey, true);
      cleanup();
      deps.onClosed();
      deps.onDiag({ ...newDiag(), result: '相机起不来', errs: 1, err0: String(name ?? e).slice(0, 90) });
      deps.onHint(reason);
      return;
    }
    video.srcObject = stream;
    // 兜底：某些 WebView 媒体事件不发 → 2.5s 强制显形（流已 attach，解码不受影响）
    revealTimer = window.setTimeout(reveal, 2500);
    try {
      await video.play();
    } catch {
      /* autoplay 被拒：解码仍可继续，reveal 兜底会显形 */
    }
    if (aborted) {
      cleanup();
      return;
    }
    startLoop();
    deps.onDiag(newDiag());
    deps.onHint(COPY.scanIdentifying);
  })();

  return {
    el: overlay,
    close: () => {
      abortScan();
    },
  };
}
