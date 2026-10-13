/**
 * 导出长图 —— 全流程编排 + 全屏预览兜底
 *
 * 🔴 移植依据：老项目 index.html:2897-2996（exportImage + showImagePreview）。
 *
 * ─────────────────────────────────────────────────────────────────────────
 * 顺序不能改的四处
 *
 *   1. **先收软键盘**（老项目 v9.5.1）：导出钮原是全排唯一不收键盘的顶栏动作。
 *      光标在正文时点导出，pointerdown 的 preventDefault 令编辑器不失焦，
 *      渲染几秒键盘一直挂着 —— 观感是「导出把键盘打开了」。
 *      桌面端**不能** blur（打字时误触会丢光标），所以判据是触屏。
 *
 *   2. **先开提示条再渲染**：用户点了之后必须有即时反馈。
 *      html2canvas 在长笔记上要几秒，没有提示条就是"点了没反应"。
 *
 *   3. **finally 里 dispose 离屏卡**：老项目 v10.0.2 事故，
 *      快路 return 时漏拆，每次导出泄漏一张卡，几十次后卡顿。
 *
 *   4. **失败文案必须含原因 + 「图片未生成」**：静默失败 = 用户以为功能坏了。
 */

import { buildCard, settleCard, type ExportCard } from './card.ts';
import {
  blobToB64,
  deliverPng,
  loadHtml2Canvas,
  renderCardToPng,
  type DeliverKind,
  type DeliverDeps,
} from './render.ts';
import { COPY } from '../ui/copy.ts';
import { isTouchDevice } from '../platform/touch.ts';
import { ICON_X } from '../ui/icons.ts';
import {
  hasNativeImgShare as hasNativeShare,
  nativeShareImage,
} from '../image/native-img-share.ts';

export interface ExportDeps {
  editorHost: HTMLElement;
  noteId: string;
  brandSvg: Element | null;
  /** 触屏收键盘（main.ts 注入，内部已判平台）。 */
  dismissKeyboard: () => void;
  /**
   * 状态提示。
   *
   * @param kind 'doing' 过程 / 'ok' 成功 / 'bad' 失败
   * @param text 给人看的一句话
   * @param autoHideMs 自动收起毫秒；0 = 常驻（过程态靠调用方重发覆盖）
   *
   * 🔴 驻留时长**由本模块给**而不是让调用方从 COPY 里翻 ——
   *   上一版把 okMs/failMs 挂在 deps 上却在内部直接读 COPY，
   *   于是"传给调用方的数字"和"实际用的数字"可能不一致，且没有任何测试能发现。
   */
  onStatus: (kind: 'doing' | 'ok' | 'bad', text: string, autoHideMs: number) => void;
  /**
   * 收掉状态提示（v3.2.4 移动端弹窗用）。
   *
   * 🔴🔴 为什么必须注入而不能只靠 onStatus 覆盖：触屏渲染成功后弹窗接管
   *   （zIndex 40 盖住提示条），「正在生成图片…」那条 doing 提示条必须**清掉**
   *   而不是被盖在弹窗底下挂一整场。main.ts 传 hideUploadNote。
   */
  hideStatus: () => void;
  /** 状态提示驻留时长（毫秒）；0 = 常驻直到下一条覆盖。 */
  okMs: number;
  failMs: number;
  /** 原生壳判定。 */
  isNativeApp: boolean;
  /** 原生桥复制图片（S8 注入；Web 下 undefined）。 */
  nativeCopyImage?: (base64: string, mime: string) => Promise<boolean>;
  /**
   * 原生桥写完后的**读回验证**（旧 APK 无 `hasImage` 时由调用方给 undefined）。
   *
   * 🔴 与 render.ts 的 DeliverDeps 同义，只是这一层是"顶栏 → 导出"的对外契约；
   *   **必须透传下去**，不能在这一层自己判 —— 否则"验证过了没"这个事实
   *   又变成藏在副作用里的东西（全项目统一纪律）。
   */
  verifyClipboardImage?: (() => Promise<boolean>) | undefined;
  /**
   * 把同一张图再存一份进系统相册（壳内；Web 下 undefined）。
   *
   * 🔴 v3.2.3：**微信 Android 不支持从剪贴板粘贴图片**（多来源一致，第三方
   *   实测的可行路径就是「先存相册 → 微信相册选图」）⇒ 复制成功之后顺手
   *   存一份，用户才真能把图送进微信。存不成不影响复制本身已成功，
   *   只影响文案提不提"相册"（没存成绝不许提，那是谎报）。
   */
  saveToAlbum?: ((base64: string, mime: string) => Promise<boolean>) | undefined;
}

export type ExportResult = DeliverKind | 'cancelled' | 'loadfail' | 'renderfail' | 'modal';

/**
 * 导出长图全流程。
 *
 * 🔴🔴 **必须返回成败，不能靠调用方"看提示条现在是什么态"反推**。
 *   那是把"数据"藏在"副作用"里：两个提示同时弹出、或提示条已被收起计时器
 *   删掉时，判定就不成立了（与 image/upload.ts 同一条纪律）。
 */
export async function exportNotePng(deps: ExportDeps): Promise<ExportResult> {
  // ① 触屏先收键盘
  deps.dismissKeyboard();

  // ② 先开提示条，**再**做组件加载（v3.2.4 修正顺序）
  //
  // 🔴🔴 本文件头把「先开提示条再渲染」列为顺序不能改的第 2 条，而此前的代码
  //   却把 `loadHtml2Canvas()` 排在提示条**之前** —— 冷启动后的第一次导出，
  //   要先等一个 198KB 脚本的网络往返（移动端几百毫秒到一秒），那段时间里
  //   屏幕没有任何反馈，用户看到的就是「点了没反应」。
  //   而用户这次报障的正是「生成图片的时间太长」：等待不可怕，
  //   看不见的等待才像坏了。提示条先上，加载与渲染都在它后面。
  deps.onStatus('doing', COPY.exportDoing, 0);

  // ③ 组件加载
  if (!(await loadHtml2Canvas())) {
    deps.onStatus('bad', COPY.exportLoadFail, deps.failMs);
    return 'loadfail';
  }

  let card: ExportCard | null = null;
  try {
    card = buildCard({
      editorHost: deps.editorHost,
      noteId: deps.noteId,
      brandSvg: deps.brandSvg,
    });
    await settleCard(card.el);

    // 🔴🔴 渲染 Promise **立即**开始，交付阶梯同步发起 ——
    //   剪贴板要抢在用户手势窗口内，await 渲染就晚了（见 render.ts 文件头）。
    const blobP = renderCardToPng(card.el);

    // 🔴🔴🔴 触屏（移动端）分岔 —— 渲染成功后**不走复制阶梯**，弹窗接管
    //   （用户报障第 4 条逐字拍板，v3.2.4；判据 EXPORT-29 钉着分岔位置）。
    //
    //   为什么复制语义在移动端退场：壳内 WebView 写剪贴板图片是假成功
    //   （v3.2.2 Chromium 实锤），真写进去微信也不认（v3.2.3 多来源实锤）——
    //   "复制"在移动端只剩小米笔记一个目的地，而用户要的是**把图发出去**。
    //   弹窗给出两条真能用的路：保存到相册（微信相册选图）+ 系统分享面板。
    //
    //   🔴 分岔必须在 deliverPng 之前：桌面才走四档阶梯。
    //   🔴 await blobP 失败继续走下方 catch（渲染失败该弹"导出失败"，不该无声）。
    if (isTouchDevice()) {
      const blob = await blobP;
      // 🔴 先清「正在生成图片…」再开弹窗：弹窗 zIndex 40 会盖住提示条，
      //   不清就是"弹窗底下挂着一条永远不消失的旧提示"。
      deps.hideStatus();
      await showExportModal(blob, {
        saveToAlbum: deps.saveToAlbum,
      });
      return 'modal';
    }

    const out = await deliverPng(blobP, {
      isNativeApp: deps.isNativeApp,
      blobToB64,
      nativeCopyImage: deps.nativeCopyImage,
      verifyClipboardImage: deps.verifyClipboardImage,
      saveToAlbum: deps.saveToAlbum,
      showPreview: (b) => showPreview(b),
      // 🔴🔴 这里**不再**注入 isTouch：交付阶梯里唯一的平台分支是"原生桥 vs 分享"，
      //   而"剪贴板成功后给触屏补开预览层"已按用户拍板的 A1 删掉了（render.ts 的注释与
      //   单测 EXP-W02b 钉着这条）。平台判据在本模块仍有两处消费（文案分档、预览层指引），
      //   走同一个唯一出处 `platform/touch.ts`，不在 render.ts 再开一个注入口。
    } satisfies DeliverDeps);

    if (out.kind === 'cancelled') return 'cancelled';
    if (out.kind === null) {
      deps.onStatus('bad', COPY.exportFailUnknown, deps.failMs);
      return 'renderfail';
    }
    // 🔴 预览档**不给任何提示条**（老项目 index.html:2967 showImagePreview 第一行
    //   就是 hideUploadStatus）。此前这里统一弹「图片已生成，可长按保存或下载」——
    //   那是老项目里不存在的文案，且弹在预览浮层**背后**，用户压根看不见，
    //   等于凭空多一次状态切换（预览层盖住提示条，关闭后又闪一下）。
    if (out.kind === 'preview') return out.kind;
    // 🔴🔴 触屏上剪贴板档不能给「Ctrl+V」（手机没这个动作）。
    //   触屏判据与 dismissKeyboardForTouch 同一套，不用 UA sniff。
    // 🔴 顺带修一处**口径分裂**：文案分档与预览层补微信指引原先各写一遍
    //   matchMedia 字面量，而 `isTouchDevice()` 那边还多一层 try/catch ——
    //   同一件事三处写法，matchMedia 缺失时行为不一致。统一走唯一出处。
    // 🔴 第二参 albumSaved：相册存成了文案才敢指路"微信请从相册选图发送"，
    //   没存成就不提相册（不许谎报）—— 判据 EXPORT-25 钉着这两句话。
    const okMsg = isTouchDevice() ? COPY.exportOkMsgTouch : COPY.exportOkMsg;
    deps.onStatus('ok', okMsg(out.kind, out.albumSaved), deps.okMs);
    return out.kind;
  } catch (e) {
    // 🔴 SecurityError 是外链图片跨域的典型症状，必须说人话而不是回显英文
    const msg =
      e instanceof Error && e.name === 'SecurityError'
        ? COPY.exportFailCors
        : COPY.exportFailMsg(e instanceof Error && e.message ? e.message : '');
    deps.onStatus('bad', msg, deps.failMs);
    return 'renderfail';
  } finally {
    // ③ 离屏卡必拆（老项目 v10.0.2 泄漏事故的结构性修法）
    card?.dispose();
  }
}

/**
 * 全屏预览兜底。
 *
 * 🔴 为什么必须长按 + 下载两个出口：浏览器与 WebView 原生支持长按保存/转发，
 *   而 `<a download>` 在 App 壳内是哑弹 —— 只给下载按钮 = App 里导出了但存不下来。
 */
export function showPreview(blob: Blob): void {
  document.getElementById('imgPreviewMask')?.remove();
  const url = URL.createObjectURL(blob);
  const overlay = document.createElement('div');
  overlay.className = 'mask';
  overlay.id = 'imgPreviewMask';
  // 🔴 老项目 index.html:2967 `overlay.style.zIndex = '40'` —— 预览层压在提示条之上，
  //   所以"预览档不给提示条"是配套的：给了也看不见。
  overlay.style.zIndex = '40';

  const box = document.createElement('div');
  box.className = 'box';
  box.setAttribute('style', 'text-align:center;max-width:92vw');

  const h = document.createElement('h1');
  h.className = 'qr-title';
  h.textContent = COPY.exportPreviewTitle;

  const img = document.createElement('img');
  img.src = url;
  img.alt = COPY.exportPreviewAlt;
  img.setAttribute('style', 'max-width:100%;max-height:60vh;border-radius:12px;background:#fff');

  const tip = document.createElement('p');
  tip.textContent = COPY.exportPreviewTip;
  // 🔴 老项目这里是**内联样式**而非 class（index.html:2981）：
  //   font-size:12px;color:var(--muted);line-height:1.7;margin:12px 0 0
  //   —— 与 .link-hint（11.5px/1.6）**不是**同一条规则，别混用。
  tip.setAttribute('style', 'font-size:12px;color:var(--muted);line-height:1.7;margin:12px 0 0');

  // 🔴🔴 触屏补一行「怎么进微信」（用户报障第 5/13 条）。
  //   移动端常落在预览档：剪贴板被 WebView 拒、canShare 又常为 false。
  //   而老项目那句「长按图片可保存或发送」没点名"转发给微信"，
  //   用户看到图只会以为导出失败。桌面端不加（桌面有分享面板与 Ctrl+V）。
  // 🔴 判据与上面文案分档、render.ts 的 isTouch 注入同源（唯一出处）。
  if (isTouchDevice()) {
    const wechatTip = document.createElement('p');
    wechatTip.textContent = COPY.exportPreviewTipTouch;
    wechatTip.setAttribute(
      'style',
      'font-size:12px;color:var(--muted);line-height:1.7;margin:6px 0 0',
    );
    box.appendChild(wechatTip);
  }

  // 🔴 老项目 index.html:2982-2988：按钮行与两个按钮全是内联样式，
  //   描边胶囊 `padding:10px 22px;border:1px solid var(--line);border-radius:999px;font-size:13px`，
  //   「完 成」按钮只补 `padding:10px 22px`（其余靠 row-btn 的 class 兜）。
  const btnRow = document.createElement('div');
  btnRow.setAttribute('style', 'display:flex;gap:12px;justify-content:center;margin-top:14px');
  const dl = document.createElement('a');
  dl.className = 'row-btn';
  dl.textContent = COPY.exportDownload;
  dl.href = url;
  dl.download = 'note.png';
  dl.setAttribute('style', 'padding:10px 22px;border:1px solid var(--line);border-radius:999px;font-size:13px;color:var(--fg);text-decoration:none');
  const cancel = document.createElement('button');
  cancel.type = 'button';
  cancel.className = 'row-btn';
  cancel.id = 'imgPreviewClose';
  cancel.textContent = COPY.exportDone;
  cancel.setAttribute('style', 'padding:10px 22px');
  btnRow.appendChild(dl);
  btnRow.appendChild(cancel);

  box.appendChild(h);
  box.appendChild(img);
  box.appendChild(tip);
  box.appendChild(btnRow);
  overlay.appendChild(box);
  document.body.appendChild(overlay);

  const close = (): void => {
    overlay.remove();
    URL.revokeObjectURL(url);
    // 🔴 关闭后归还焦点给编辑器（老项目红线10：桌面失焦后光标不绘制）
    const ed = document.getElementById('editor-host');
    if (ed instanceof HTMLElement) ed.focus();
  };
  cancel.addEventListener('click', close);
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) close();
  });
  document.addEventListener('keydown', function onEsc(e) {
    if (e.key !== 'Escape') return;
    document.removeEventListener('keydown', onEsc);
    close();
  });
}

/** 移动端导出弹窗的注入口。 */
export interface ExportModalDeps {
  /**
   * 相册桥（main.ts 条件注入：只有 `isNativeApp()` 才给）。
   *
   * 🔴 **存在才显示「保存到相册」按钮** —— 手机浏览器 / 旧壳上没有 ImgSave 桥，
   *   "保存到相册"没有真能落地的路，不给一个点了必失败的按钮（判据 EXPORT-30）。
   *   桥点了之后 ok:false ⇒ 弹窗内反馈失败，绝不谎报。
   */
  saveToAlbum?: ((base64: string, mime: string) => Promise<boolean>) | undefined;
}

/**
 * 移动端导出弹窗（v3.2.4，用户报障第 4 条逐字拍板）：
 *
 *   上：生成图片的预览图（data: URL，长按可存 = 无桥环境的最后兜底）
 *   下：左「保存到相册」 + 右「分享」（系统分享面板，与诊断报告同款）
 *   右上角：关闭叉 —— **唯一**关闭出口
 *
 * 🔴🔴 点弹窗其他位置/外围**都不关**（用户逐字拍板）：mask 不绑任何点击关闭。
 *   对照组 showPreview 有 `e.target === overlay` 外围关闭 —— 本函数绝不许有，
 *   判据 EXPORT-30 反向钉着这两条（出现即红）。
 *
 * 🔴 为什么反馈条收进弹窗自己的 DOM（diagNote 同款纪律）：本弹窗 zIndex 40
 *   盖住 #uploadNote，把反馈写进提示条 = 用户看不见 = 「点了没反应」
 *   （v3.1.3 诊断导出真机实锤过同款事故，见 diag/panel.ts 文件头）。
 *
 * 🔴 开窗即转 base64（渲染完才进本函数，多等 ~20ms 无感）：预览图 data: URL、
 *   保存相册、壳内分享三处共用这一份，不再各转各的（长图 base64 可能上 MB）。
 */
export async function showExportModal(blob: Blob, deps: ExportModalDeps): Promise<void> {
  document.getElementById('exportModalMask')?.remove();
  const b64 = await blobToB64(blob);

  const mask = document.createElement('div');
  mask.className = 'mask';
  mask.id = 'exportModalMask';
  mask.setAttribute('role', 'dialog');
  mask.setAttribute('aria-modal', 'true');
  mask.setAttribute('aria-label', COPY.exportModalTitle);
  // 🔴 老项目 index.html:2967：预览层压在提示条之上（zIndex 40）
  mask.style.zIndex = '40';

  const box = document.createElement('div');
  box.className = 'box';
  box.setAttribute('style', 'text-align:center;max-width:92vw');

  // 🔴 叉要右上角（v3.2.5 报障）：.box-x 是流内格子（无 absolute），必须放进
  //   .modal-head（flex + space-between）才与标题同行右对齐 —— 直接挂 box
  //   会掉到标题下方左侧（v3.2.4 真机实锤）。
  const head = document.createElement('div');
  head.className = 'modal-head';

  const h = document.createElement('h1');
  h.className = 'qr-title';
  h.textContent = COPY.exportModalTitle;

  // 右上角关闭叉：全站同一枚 ICON_X SVG（diag/ota 同款，不写字形 × —— 大小与
  // 笔画粗细由系统字体决定，并排看明显"轻一号"）。走 innerHTML 安全：ICON_X
  // 是本项目自产常量，无外部输入。
  const x = document.createElement('button');
  x.className = 'box-x';
  x.type = 'button';
  x.id = 'exportModalClose';
  x.title = COPY.exportModalClose;
  x.setAttribute('aria-label', COPY.exportModalClose);
  x.innerHTML = ICON_X();
  head.append(h, x);

  const img = document.createElement('img');
  img.alt = COPY.exportPreviewAlt;
  // 🔴 data: 而不是 blob:：壳内 WebView 长按菜单对 blob: 图常不给保存项，
  //   data: 才有「长按存图」这条最后兜底（编辑器内图片同形态）。
  img.src = 'data:image/png;base64,' + b64;
  img.setAttribute(
    'style',
    'max-width:100%;max-height:56vh;border-radius:12px;background:#fff',
  );

  const note = document.createElement('div');
  note.className = 'diag-note';
  note.setAttribute('role', 'status');
  note.setAttribute('aria-live', 'polite');
  note.hidden = true;

  let noteTimer: number | undefined;
  const flash = (msg: string, kind: string): void => {
    note.textContent = msg;
    note.dataset.kind = kind;
    note.hidden = false;
    if (noteTimer !== undefined) window.clearTimeout(noteTimer);
    noteTimer = window.setTimeout(() => {
      // 只有"现在显示的仍是本条"才收（diag/panel.ts 同款守卫）
      if (note.textContent === msg) note.hidden = true;
    }, COPY.exportOkMs);
  };

  const close = (): void => {
    if (noteTimer !== undefined) window.clearTimeout(noteTimer);
    mask.remove();
  };
  x.addEventListener('click', close);
  // 🔴🔴 mask **不**绑任何点击关闭 —— 关闭只有右上角叉一条路。

  // 🔴🔴 按钮禁用 .row-btn（v3.2.5 报障）：其 flex:none + 通栏
  //   .box button{width:100%} 叠加 = 两枚各 297px 的不可收缩按钮并排，
  //   总宽 594px 溢出 297px 的行（探针实测 saveBtn x=-108）。改
  //   flex:1 1 0;min-width:0 —— 等分且可收缩，不溢出。
  const btnStyle = 'flex:1 1 0;min-width:0';
  const shareBtn = document.createElement('button');
  shareBtn.type = 'button';
  shareBtn.id = 'exportModalShare';
  shareBtn.setAttribute('style', btnStyle);
  shareBtn.textContent = COPY.exportModalShare;

  const onShare = async (): Promise<void> => {
    // ① 壳内 ImgShare 桥（ACTION_SEND 系统分享面板，与诊断报告分享同款）。
    //    壳内 WebView 没有 navigator.share（DiagExportPlugin.kt 注释双实锤），
    //    这座桥是壳内唯一能拉起系统分享组件的路。
    if (hasNativeShare()) {
      try {
        // ok:true = 面板已拉起；用户在面板里点取消 native 侧收不到回执，
        // 一律按"已拉起"算，静默不打扰（DiagExport.shareText 同款口径）。
        if (await nativeShareImage(b64, 'image/png')) {
          close(); // v3.2.5：点完分享自动关弹窗（用户拍板）
          return;
        }
      } catch {
        /* 落下一级 */
      }
    }
    // ② 网页系统分享面板（移动浏览器；Android Chrome 实测可用）
    const nav = navigator as Navigator & {
      canShare?: (data: { files: File[] }) => boolean;
      share?: (data: { files: File[]; title?: string }) => Promise<void>;
    };
    if (typeof nav.share === 'function' && typeof nav.canShare === 'function') {
      try {
        const file = new File([blob], 'note.png', { type: 'image/png' });
        if (nav.canShare({ files: [file] })) {
          await nav.share({ files: [file], title: COPY.exportModalTitle });
          close(); // v3.2.5：分享面板拉起即算"点完了"，自动关
          return;
        }
      } catch (e) {
        if (e instanceof Error && e.name === 'AbortError') {
          close(); // 用户取消面板 = 用完了，同样自动关（真失败才留窗）
          return;
        }
        /* 真失败 → 落到反馈 */
      }
    }
    // ③ 都不可用：弹窗内可见失败（预览图是 data: URL，长按可存 —— 文案指路）
    flash(COPY.exportShareFail, 'bad');
  };
  shareBtn.addEventListener('click', () => {
    void onShare();
  });

  const row = document.createElement('div');
  row.setAttribute('style', 'display:flex;gap:12px;margin-top:14px');

  // 🔴🔴 保存按钮**整个**以 saveToAlbum 桥存在为前提（main.ts 只在原生壳注入）：
  //   手机浏览器 / 旧壳上不创建也不上屏 —— 不给一个点了必失败的按钮。
  //   判据 EXPORT-30 钉 `if (deps.saveToAlbum) {` 块形态；e2e EXPORT-M01
  //   行为级双向钉（有桥显示/无桥不显示）。
  if (deps.saveToAlbum) {
    const saveBtn = document.createElement('button');
    saveBtn.type = 'button';
    saveBtn.id = 'exportModalSave';
    saveBtn.setAttribute('style', btnStyle);
    saveBtn.textContent = COPY.exportModalSave;
    saveBtn.addEventListener('click', () => {
      if (!deps.saveToAlbum) return; // 双保险：块进了必有桥
      flash(COPY.exportAlbumDoing, 'doing');
      void deps
        .saveToAlbum(b64, 'image/png')
        .then((ok) => {
          // 🔴 v3.2.5：成功即自动关弹窗（用户拍板「点完自动关」——关窗本身
          //   就是成功反馈）；失败留窗 flash，指路重试。
          if (ok) close();
          else flash(COPY.exportAlbumFail, 'bad');
        })
        .catch(() => flash(COPY.exportAlbumFail, 'bad'));
    });
    // 🔴 左保存右分享（用户拍板；判据 EXPORT-30 钉 append 顺序）
    row.append(saveBtn, shareBtn);
  } else {
    row.append(shareBtn);
  }

  box.append(head, img, note, row);
  mask.appendChild(box);
  document.body.appendChild(mask);
}
