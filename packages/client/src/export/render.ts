/**
 * 导出长图 —— 渲染与交付
 *
 * 🔴 移植依据：老项目 index.html:2854-2880（懒加载）+ 2897-2996（回退阶梯）。
 *
 * ─────────────────────────────────────────────────────────────────────────
 * 渲染只有一条路（html2canvas），但交付有四档
 *
 *   渲染失败 → 一律给看得懂的失败文案，绝不静默。
 *   渲染成功 → 逐级往下交付，任何一档成功就收场：
 *     ① 剪贴板（Promise 形态，手势窗口内发起）
 *     ② APP 原生桥（Android WebView 剪贴板不可用时的确定性路径）
 *     ③ 系统分享面板（手机上「发给微信」更符合诉求）
 *     ④ 全屏预览（长按保存；唯一不依赖任何权限的出口）
 *
 * ─────────────────────────────────────────────────────────────────────────
 * 🔴🔴 为什么剪贴板要走「Promise 形态」（老项目 v7.7.0 血泪，最容易写错的一处）
 *
 *   直觉写法是「await 渲染 → 再 clipboard.write」。在移动端这是**必然失败**的：
 *   html2canvas(scale:2) 动辄数秒，浏览器要求剪贴板写入发生在
 *   **用户手势的 transient activation 窗口内**（Chrome 约 5 秒），
 *   等渲染完手早就过期了，write() 被拒且**不报错给用户看**。
 *
 *   正确写法：把**渲染 Promise 本身**装进 ClipboardItem，write() 立刻调用，
 *   由浏览器在窗口内等这个 Promise 兑现。老项目为此踩过一次，症状是
 *   「桌面能复制、手机永远复制不了」。
 */

/** html2canvas的最小形态（只用到这三个成员，不 import 整包类型）。 */
interface Html2Canvas {
  (el: HTMLElement, opts: Record<string, unknown>): Promise<HTMLCanvasElement>;
}

declare global {
  interface Window {
    html2canvas?: Html2Canvas;
  }
}

let loadPromise: Promise<boolean> | null = null;

/**
 * 懒加载同源 html2canvas。
 *
 * 🔴🔴 绝不能挂公共 CDN（老项目 v7.5.1 血泪）：jsdelivr 在大陆常不可达，
 *   手机端表现为「图片导出组件未加载」，用户完全看不出是网络问题，
 *   只会觉得功能坏了。自托管 + 同源 = 没有可达性问题。
 *
 * 🔴 失败必须**可重试**：`loadPromise` 失败时置回 null，
 *   否则一次断网就把导出功能永久废掉（刷新前都不再尝试）。
 */
export function loadHtml2Canvas(src = '/html2canvas.min.js'): Promise<boolean> {
  if (typeof window.html2canvas === 'function') return Promise.resolve(true);
  if (loadPromise) return loadPromise;
  loadPromise = new Promise<boolean>((resolve) => {
    const s = document.createElement('script');
    s.src = src;
    s.async = true;
    s.onload = () => {
      const ok = typeof window.html2canvas === 'function';
      if (!ok) {
        // eslint-disable-next-line no-console
        console.error('[export] /html2canvas.min.js 已加载但 window.html2canvas 非函数');
      }
      loadPromise = null;
      resolve(ok);
    };
    s.onerror = () => {
      // eslint-disable-next-line no-console
      console.error('[export] html2canvas 加载失败（服务端未部署该文件 / 断网 / CSP 缺 self）');
      loadPromise = null;
      resolve(false);
    };
    document.head.appendChild(s);
  });
  return loadPromise;
}

/** 渲染参数。老项目 v9.5.0 起固定 scale:2、width/height 用 offsetWidth。 */
export const RENDER_OPTS: Readonly<Record<string, unknown>> = {
  backgroundColor: null, // 圆角外保持透明（外衬卡自带底色）
  scale: 2,
  useCORS: true,
  logging: false,
};

/**
 * 离屏卡 → PNG Blob。
 *
 * 🔴🔴 **必须用 offsetWidth 不是 scrollWidth**（老项目闸 R2-P2 实锤）：
 *   scrollWidth 不含 1px 边框，右/下边线会被裁掉 2px —— 用户看到的是
 *   「导出图右边少一条细线」，极难自查。
 */
export async function renderCardToPng(wrap: HTMLElement): Promise<Blob> {
  const fn = window.html2canvas;
  if (typeof fn !== 'function') throw new Error('图片导出组件未加载');
  const canvas = await fn(wrap, {
    ...RENDER_OPTS,
    width: wrap.offsetWidth,
    height: wrap.offsetHeight,
    windowWidth: wrap.offsetWidth,
    windowHeight: wrap.offsetHeight,
  });
  const blob = await new Promise<Blob | null>((resolve) => {
    canvas.toBlob((b) => resolve(b), 'image/png');
  });
  if (!blob) throw new Error('渲染异常');
  return blob;
}

/** 交付方式。调用方据此决定提示文案。 */
export type DeliverKind = 'clipboard' | 'native' | 'share' | 'preview';

export interface DeliverDeps {
  /**
   * 原生桥（Android）。S8 注入；Web 下为 undefined。
   *
   * 🔴 显式写成 `| undefined`（而不是只写 `?`）：本仓库开了
   *   `exactOptionalPropertyTypes`，`{ nativeCopyImage: undefined }`
   *   **不**satisfies `nativeCopyImage?: T`。踩过一次：报错说的是
   *   "Type 'undefined' is not assignable"，与"可选属性"读起来完全对不上，
   *   容易误判成调用方传错了。
   */
  nativeCopyImage?: ((base64: string, mime: string) => Promise<boolean>) | undefined;
  /** 全屏预览兜底。必须有 id 以便 e2e 判。 */
  showPreview: (blob: Blob) => void;
  // 当前是否在原生壳内。
  isNativeApp: boolean;
  /** Blob → base64（去掉 data: 前缀）。 */
  blobToB64: (blob: Blob) => Promise<string>;
  /**
   * 是否纯触屏（老项目口径 `(hover: none) and (pointer: coarse)`）。
   *
   * 🔴 由调用方注入而不是本模块自己 matchMedia：触屏判据全项目唯一出处是
   *   `platform/touch.ts` 的 `isTouchDevice()`（那里记着"判不准时怎么办"的纪律），
   *   本模块再写一份字面量就是第二处口径，迟早漂移。
   */
  isTouch: boolean;
}

/**
 * 触屏上剪贴板成功时，**额外**开一次全屏预览层。
 *
 * 🔴🔴🔴 为什么必须多开这个出口（用户报障第 5 条，实测由 e2e EXPORT-W02 钉住）：
 *
 *   老项目 v7.7.0 写阶梯时的判断是「Android WebView 对图片写剪贴板长期不可用」
 *   —— 在那个假设下，移动端必然落到分享/预览档，所以阶梯把剪贴板当终点没问题。
 *
 *   但 bj 的用户实测是**反的**：「能正常复制到系统自带笔记 App」
 *   ⇒ 第①档剪贴板在他手机上**是成功的** ⇒ 阶梯停在第①档就 return 了，
 *   **永远到不了分享面板与预览层**。
 *   而微信会话框不接受剪贴板里的图片（它只认相册/自己的媒体输入），
 *   于是用户看到的正是「提示已复制 → 去微信粘贴 → 没反应」，
 *   而屏上根本没有一张可以长按的图。
 *
 * 🔴 这**不是推翻老项目的阶梯**：顺序一分不变，仍是剪贴板→桥→分享→预览。
 *   只是在第①档成功之后，**触屏**再补一个出口，把"长按转发给微信"这条路
 *   真正摆到用户面前。
 *
 * 🔴🔴 为什么桌面端绝对不许走这条：桌面有分享面板与 Ctrl+V，
 *   多弹一层遮罩是把老项目同款行为改坏（e2e EXPORT-W03 反向闸钉着）。
 */
async function openTouchPreviewOnClipboard(
  blobP: Promise<Blob>,
  deps: DeliverDeps,
): Promise<void> {
  if (!deps.isTouch) return;
  try {
    // 🔴 必须 await 渲染结果：第①档是把 Promise 塞进 ClipboardItem 交出去的，
    //   此刻手上还没有 Blob。剪贴板已经写成功，这里渲染失败**绝不能**改写结论
    //   （否则会把"已复制"变成"失败"，用户反而更懵）。
    const blob = await blobP;
    deps.showPreview(blob);
  } catch {
    /* 预览开不出来不影响"已复制"这个既成事实 */
  }
}

/**
 * 四档交付阶梯。
 *
 * @returns 实际生效的那一档；用户主动取消分享返回 'cancelled'。
 * @returns 全部失败返回 null（调用方必须给可见失败提示）。
 */
export async function deliverPng(blobP: Promise<Blob>, deps: DeliverDeps): Promise<DeliverKind | 'cancelled' | null> {
  let clipTried = false;
  // 防 unhandledrejection：回退路径可能先返回，blobP 的 rejection 无人消费
  blobP.catch(() => {});

  // ① 剪贴板（Promise 形态，write 立即调用）
  try {
    if (
      navigator.clipboard &&
      typeof navigator.clipboard.write === 'function' &&
      typeof ClipboardItem !== 'undefined'
    ) {
      clipTried = true;
      await navigator.clipboard.write([new ClipboardItem({ 'image/png': blobP })]);
      await openTouchPreviewOnClipboard(blobP, deps);
      return 'clipboard';
    }
  } catch {
    /* 被拒/超时/不支持 → 继续往下 */
  }

  let blob: Blob | null = null;
  let renderErr: Error | null = null;
  try {
    blob = await blobP;
  } catch (e) {
    renderErr = e instanceof Error ? e : new Error('渲染异常');
  }
  if (renderErr) throw renderErr;
  if (!blob) return null;

  // ② Promise 形态被个别旧内核拒（只认 Blob）→ 渲染完成后用 Blob 再试一次，
  //   保住桌面「复制」语义。这必须在**非原生**下做：原生走桥。
  if (clipTried && !deps.isNativeApp) {
    try {
      await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
      // 🔴 与第①档同一条真因：这里也是"剪贴板成功"，触屏上同样到不了分享/预览。
      //   漏了这一档的话，老内核（只认 Blob）那批手机上用户照样进不了微信。
      await openTouchPreviewOnClipboard(Promise.resolve(blob), deps);
      return 'clipboard';
    } catch {
      /* 仍被拒（手势过期等）→ 继续 */
    }
  }

  // ③ APP 原生桥：ClipboardManager 真·复制图片
  if (deps.isNativeApp && deps.nativeCopyImage) {
    try {
      const ok = await deps.nativeCopyImage(await deps.blobToB64(blob), 'image/png');
      if (ok) return 'native';
    } catch {
      /* 桥异常继续分享回退 */
    }
  }

  // ④ 系统分享面板
  try {
    const file = new File([blob], 'note.png', { type: 'image/png' });
    if (
      typeof navigator.canShare === 'function' &&
      navigator.canShare({ files: [file] }) &&
      typeof navigator.share === 'function'
    ) {
      await navigator.share({ files: [file] });
      return 'share';
    }
  } catch (e) {
    // 用户主动取消分享：静默收场，不该弹"失败"
    if (e instanceof Error && e.name === 'AbortError') return 'cancelled';
  }

  // ⑤ 全屏预览：唯一不依赖任何权限的出口，必须永远存在
  deps.showPreview(blob);
  return 'preview';
}

/** Blob → base64（去 data: 前缀）。 */
export function blobToB64(blob: Blob): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => {
      const s = String(fr.result || '');
      resolve(s.slice(s.indexOf(',') + 1));
    };
    fr.onerror = () => reject(fr.error || new Error('读取图片失败'));
    fr.readAsDataURL(blob);
  });
}
