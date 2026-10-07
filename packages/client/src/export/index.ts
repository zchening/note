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
  /** 状态提示驻留时长（毫秒）；0 = 常驻直到下一条覆盖。 */
  okMs: number;
  failMs: number;
  /** 原生壳判定。 */
  isNativeApp: boolean;
  /** 原生桥复制图片（S8 注入；Web 下 undefined）。 */
  nativeCopyImage?: (base64: string, mime: string) => Promise<boolean>;
}

export type ExportResult = DeliverKind | 'cancelled' | 'loadfail' | 'renderfail';

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

  // ② 组件加载
  if (!(await loadHtml2Canvas())) {
    deps.onStatus('bad', COPY.exportLoadFail, deps.failMs);
    return 'loadfail';
  }
  deps.onStatus('doing', COPY.exportDoing, 0);

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
    const kind = await deliverPng(blobP, {
      isNativeApp: deps.isNativeApp,
      blobToB64,
      nativeCopyImage: deps.nativeCopyImage,
      showPreview: (b) => showPreview(b),
      // 🔴🔴 这里**不再**注入 isTouch：交付阶梯里唯一的平台分支是"原生桥 vs 分享"，
      //   而"剪贴板成功后给触屏补开预览层"已按用户拍板的 A1 删掉了（render.ts 的注释与
      //   单测 EXP-W02b 钉着这条）。平台判据在本模块仍有两处消费（文案分档、预览层指引），
      //   走同一个唯一出处 `platform/touch.ts`，不在 render.ts 再开一个注入口。
    } satisfies DeliverDeps);

    if (kind === 'cancelled') return 'cancelled';
    if (kind === null) {
      deps.onStatus('bad', COPY.exportFailUnknown, deps.failMs);
      return 'renderfail';
    }
    // 🔴 预览档**不给任何提示条**（老项目 index.html:2967 showImagePreview 第一行
    //   就是 hideUploadStatus）。此前这里统一弹「图片已生成，可长按保存或下载」——
    //   那是老项目里不存在的文案，且弹在预览浮层**背后**，用户压根看不见，
    //   等于凭空多一次状态切换（预览层盖住提示条，关闭后又闪一下）。
    if (kind === 'preview') return kind;
    // 🔴🔴 触屏上剪贴板档不能给「Ctrl+V」（手机没这个动作）。
    //   触屏判据与 dismissKeyboardForTouch 同一套，不用 UA sniff。
    // 🔴 顺带修一处**口径分裂**：文案分档与预览层补微信指引原先各写一遍
    //   matchMedia 字面量，而 `isTouchDevice()` 那边还多一层 try/catch ——
    //   同一件事三处写法，matchMedia 缺失时行为不一致。统一走唯一出处。
    deps.onStatus('ok', (isTouchDevice() ? COPY.exportOkMsgTouch : COPY.exportOkMsg)(kind), deps.okMs);
    return kind;
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
