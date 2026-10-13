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
 *     ① APP 原生桥（**壳内第一档**：ClipboardManager 真·复制图片）
 *     ② 剪贴板（Promise 形态，手势窗口内发起；桌面/浏览器的主路径）
 *     ③ 系统分享面板（手机上「发给微信」更符合诉求）
 *     ④ 全屏预览（长按保存；唯一不依赖任何权限的出口）
 *
 * ─────────────────────────────────────────────────────────────────────────
 * 🔴🔴🔴 为什么原生壳里**不许**先试 WebView 剪贴板（2026-10-13 真机报障的根）
 *
 *   用户原话：App 里「导出为图片并复制」点了之后，微信粘不出、小米自带笔记
 *   也粘不出 —— 等于**压根没进系统剪贴板**。
 *
 *   根因在 Chromium 源码里，不在我们代码里：
 *     `ui/android/java/src/org/chromium/ui/base/ClipboardImpl.java`
 *       public void setImage(byte[] imageData, String extension) {
 *         if (mImageFileProvider == null) {
 *           // ... we can just drop it on the floor.
 *           return;
 *         }
 *     `ImageFileProvider` 只有 Chrome 自己注入（ChromeImageFileProvider），
 *     WebView 宿主（Capacitor 壳）**从不注入** ⇒ 壳内
 *     `navigator.clipboard.write(ClipboardItem{'image/png'})` 被**静默丢弃**，
 *     而 C++ 侧不检查返回值、`Java_Clipboard_setImage` 又是 void ⇒
 *     **promise 照常 resolve**。
 *
 *   ⇒ 于是阶梯在第①档就 return、弹「已复制」，而真正能写进系统剪贴板的
 *     原生桥（ImgClip）**永远轮不到**。这就是「点了没复制到剪贴板」的全部。
 *
 *   ⇒ 修法：壳内把原生桥提到剪贴板之前。桌面/浏览器不受影响（那里没有壳，
 *     也没有这个坑，异步剪贴板是真能写图片的）。
 *
 *   🔴 附带一条纪律：**写完必须读回验证**。桥回报 ok 只是"我调了
 *   ClipboardManager"，不等于系统剪贴板里真有一张图。验证为空就继续往下
 *   走（分享/预览），绝不能对用户谎报「已复制」。
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

/**
 * 交付结果。
 *
 * 🔴 v3.2.3 起从「裸 kind 字符串」改成对象，原因：**壳内复制成功后还有第二件事
 *   （顺手存一份到相册），而它的成败必须能被调用方看见**。
 *   早先只有 kind，调用方无法知道相册存没存成 ⇒ 要么谎报"请从相册选图"，
 *   要么放弃相册这条路。把事实放在返回值里，而不是藏在副作用/文案里。
 */
export interface DeliverOutcome {
  kind: DeliverKind | 'cancelled' | null;
  /**
   * 壳内：同一张图是否也存进了系统相册。仅 `kind === 'native'` 时有意义。
   *
   * 🔴 false 的三种来源（桥缺失 / 桥回报失败 / 桥抛错）都**不是失败** ——
   *   复制本身已经成功，只是微信那条"从相册选图"的路没铺上。调用方据此
   *   决定文案提不提"相册"，**绝不许在没存成时说相册里有图**。
   */
  albumSaved: boolean;
}

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
   * 原生桥写完之后的**读回验证**（可为 undefined：旧 APK 没有 `hasImage`）。
   *
   * 🔴 返回 false = 系统剪贴板里确实没有图片 ⇒ 不许回报成功（谎报"已复制"
   *   比直接失败更伤用户：他会去微信里长按半天）。
   *   抛错/读不回来 = **无法证伪** ⇒ 调用方按 true 处理，信任桥的 ok。
   *
   * 🔴 显式写成 `| undefined`（不是只写 `?`）：本仓库开了
   *   `exactOptionalPropertyTypes`，`{ verifyClipboardImage: undefined }`
   *   **不** satisfies `verifyClipboardImage?: T`。
   */
  verifyClipboardImage?: (() => Promise<boolean>) | undefined;
  /**
   * 把同一张图再存一份进系统相册（壳内；Web 下 undefined）。
   *
   * 🔴🔴 为什么复制成功还要存相册（2026-10-13 用户第二轮报障）：
   *   **微信 Android 不支持从剪贴板粘贴图片**（多来源一致，第三方实测的
   *   可行路径就是「先存相册 → 微信相册选图」）。这是微信自己的输入实现，
   *   剪贴板写得再对也改不掉。而"复制到剪贴板"这个按钮对微信就是死路。
   *   ⇒ 复制成功之后顺手存一份相册，提示语指路，用户才真能把图送进微信。
   *   剪贴板语义一分不变（小米自带笔记等照旧能粘）。
   *
   * 🔴 **复用剪贴板那一份 base64**，不要为了存相册再转一次（长图 base64
   *   可能上 MB，两次 FileReader 是白烧 CPU；判据 EXPORT-24 钉着）。
   */
  saveToAlbum?: ((base64: string, mime: string) => Promise<boolean>) | undefined;
  // 🔴🔴 这里**曾经**还有一个 `isTouch` 字段，是"剪贴板成功后给触屏补开预览层"那套
  //   逻辑的注入口（用户报障第 4 条，2026-10-07 用户拍板 A1 删除）。
  //   那个逻辑删掉后它零消费者，是个会骗人的死字段 —— 留着的话，下一个人会以为
  //   "触屏还有地方需要平台分支"，从而把刚拆掉的行为原样写回来。
  //   触屏现在只影响两处，且都在 export/index.ts 一层：文案分档与预览层指引。
}

/**
 * 四档交付阶梯。
 *
 * 🔴🔴🔴 **剪贴板成功后不许再开预览层**（用户报障第 4 条「导出图片并复制要老版本体验，
 *   不要现在这样下载什么的」，2026-10-07 用户再次拍板 A1 = 严格对齐老项目）。
 *
 *   老项目 index.html:2896-2963 的 exportImage() **零平台分支** —— 剪贴板成功后只有
 *   showUploadStatus(...) + setTimeout(hideUploadStatus, 3000) + return，
 *   没有任何后续动作；showImagePreview 只在阶梯全部落空时才被调用（:2967）。
 *
 *   本文件此前在第①档与第②档成功之后各调一次 openTouchPreviewOnClipboard()，
 *   依据是「老项目假设 Android WebView 剪贴板不可用，而 bj 用户实测能复制」
 *   ⇒ 阶梯停在第①档就永远到不了分享/预览 ⇒ 补一个出口好让用户长按转发给微信。
 *   那个推理链本身没错，但它与**用户要什么**冲突：
 *   用户看到的就是「点了复制 → 屏上盖来一层图片 + 下载按钮」= 像下载的流程。
 *   ⇒ 按 A1 整个删掉。**代价明说**：在"剪贴板成功但微信不接受剪贴板图片"的内核上，
 *   用户确实进不去微信（老项目同样如此 —— 这不是新引入的缺陷，是回到老项目口径）。
 *
 * @returns 实际生效的那一档；用户主动取消分享返回 'cancelled'。
 * @returns 全部失败返回 null（调用方必须给可见失败提示）。
 */
export async function deliverPng(blobP: Promise<Blob>, deps: DeliverDeps): Promise<DeliverOutcome> {
  let clipTried = false;
  // 防 unhandledrejection：回退路径可能先返回，blobP 的 rejection 无人消费
  blobP.catch(() => {});

  // ① APP 原生桥（**壳内第一档**）
  //
  // 🔴🔴 绝不许把它放到 WebView 剪贴板之后：壳内 `navigator.clipboard.write`
  //   写图片会被 Chromium 静默丢弃却照常 resolve（见文件头第二节），
  //   那样本档永远轮不到，用户永远是"复制了但哪儿都粘不出"。
  if (deps.isNativeApp && deps.nativeCopyImage) {
    let b: Blob | null = null;
    try {
      b = await blobP;
    } catch (e) {
      // 渲染失败是**真失败**（图没生成），必须如实往外抛，不许假装走了别的档
      throw e instanceof Error ? e : new Error('渲染异常');
    }
    if (b) {
      try {
        const b64 = await deps.blobToB64(b);
        if (await deps.nativeCopyImage(b64, 'image/png')) {
          // 🔴 验证器缺失（旧 APK）或读不回来 ⇒ 无法证伪 ⇒ 信任桥的 ok
          const v = deps.verifyClipboardImage;
          if (!v || (await v()) !== false) {
            // 🔴🔴 微信 Android 不支持粘贴剪贴板图片 ⇒ 顺手存一份相册，
            //   给用户一条真能用的路。存不成**不影响**这次复制已经成功，
            //   只是 albumSaved=false，调用方文案里不提"相册"（不许谎报）。
            let album = false;
            if (deps.saveToAlbum) {
              try {
                album = (await deps.saveToAlbum(b64, 'image/png')) === true;
              } catch {
                album = false;
              }
            }
            return { kind: 'native', albumSaved: album };
          }
          // 验证为空：系统剪贴板里没有图 ⇒ 继续往下走，绝不谎报
        }
      } catch {
        /* 桥异常 / 验证异常 → 继续往下 */
      }
    }
  }

  // ② 剪贴板（Promise 形态，write 立即调用）
  //
  // 🔴🔴 **壳内不走这一档**：见文件头第二节 —— 壳内它会被静默丢弃却照常
  //   resolve，等于给用户一个假的「已复制」。壳里要么桥成功（①档已返回），
  //   要么老实走到分享/预览，用户总有能用的出口。
  try {
    if (
      !deps.isNativeApp &&
      navigator.clipboard &&
      typeof navigator.clipboard.write === 'function' &&
      typeof ClipboardItem !== 'undefined'
    ) {
      clipTried = true;
      await navigator.clipboard.write([new ClipboardItem({ 'image/png': blobP })]);
      return { kind: 'clipboard', albumSaved: false };
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
  if (!blob) return { kind: null, albumSaved: false };

  // ② 之二 Promise 形态被个别旧内核拒（只认 Blob）→ 渲染完成后用 Blob 再试一次，
  //   保住桌面「复制」语义。这必须在**非原生**下做（壳内剪贴板会假成功）。
  if (clipTried && !deps.isNativeApp) {
    try {
      await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
      return { kind: 'clipboard', albumSaved: false };
    } catch {
      /* 仍被拒（手势过期等）→ 继续 */
    }
  }

  // ③ 系统分享面板（原生壳里剪贴板不可信时，这是"真能进微信"的出口）
  try {
    const file = new File([blob], 'note.png', { type: 'image/png' });
    if (
      typeof navigator.canShare === 'function' &&
      navigator.canShare({ files: [file] }) &&
      typeof navigator.share === 'function'
    ) {
      await navigator.share({ files: [file] });
      return { kind: 'share', albumSaved: false };
    }
  } catch (e) {
    // 用户主动取消分享：静默收场，不该弹"失败"
    if (e instanceof Error && e.name === 'AbortError') return { kind: 'cancelled', albumSaved: false };
  }

  // ④ 全屏预览：唯一不依赖任何权限的出口，必须永远存在
  deps.showPreview(blob);
  return { kind: 'preview', albumSaved: false };
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
