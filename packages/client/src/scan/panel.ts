/**
 * 出码浮层 —— 「二维码配对」弹窗
 *
 * 沿用老项目 v7.5.1 起的形态：打开即出码（**不**要二次点击）、
 * 点码全屏放大（反光/夜里对拍）、常亮防息屏、关闭时焦点归还编辑器。
 * 机制上与老项目的唯一分叉见 scan/pair-link.ts（传口令而非传密钥）。
 *
 * 🔴 本文件所有 document 级监听都在 close 时**成对摘除**：
 *   浮层是临时物，监听不是。老项目在 scan 层踩过"上一层的 keydown 还在，
 *   关掉浮层后按一下键把已关的页面又动一次"。
 */

import { COPY } from '../ui/copy.ts';
import { buildPairLink } from './pair-link.ts';
import { drawQr, largeTargetPx, loadQrcode, type QrcodeApi } from './qr-draw.ts';

export interface PairPanelDeps {
  /**
   * 本机口令（明文）。拿不到就不出码。
   * 🔴 为什么是口令不是密钥：新项目 key-store 里的 CryptoKey 是
   *   extractable:false，物理上导不出 raw 字节（见 scan/pair-link.ts）。
   */
  passphrase: string | null;
  noteId: string;
  origin: string;
  /** 关闭后归还焦点（老项目红线：关弹窗必须让光标回到编辑器）。 */
  onClosed: () => void;
  /**
   * 「锁定笔记」按钮的回调（可省）。
   *
   * 🔴 只在**本机没有口令**（passphrase 为 null）时才用到 ——
   *   典型触发路径：本次是「记忆解锁」进来的（route() 里 unlockIfRemembered 成功），
   *   而记忆解锁从不经过口令，所以 sessionPass 为空。
   *   老项目在这条路径上仍能出码（raw key 常驻 localStorage），
   *   新项目不能，且**不该**为了出码把密钥降级成可导出（见 pair-link.ts 文件头）。
   *   于是给一条可执行的一步：锁定 → 解锁 → 出码。
   *   不给按钮的话，用户只看到一句「无法生成」，等于走进死路。
   */
  onLockNow?: () => void;
}

export interface PairPanel {
  el: HTMLElement;
  close: () => void;
}

/** 屏幕常亮句柄。`released` 是我们自己挂的标记，绕开 TS 的 WakeLock 类型。 */
interface HeldLock {
  released: boolean;
  release: () => Promise<void>;
}
let wakeLock: HeldLock | null = null;

function isPanelOpen(): boolean {
  return document.getElementById('pairMask') !== null;
}

async function acquireWakeLock(): Promise<void> {
  try {
    if (!('wakeLock' in navigator) || !navigator.wakeLock?.request) return;
    if (wakeLock && !wakeLock.released) return;
    const s = await navigator.wakeLock.request('screen');
    // 🔴 开→秒关竞态：弹窗已关或已切后台就立刻释放，不留常亮句柄
    //   （老项目 v7.5.1 实锤过：句柄留着会让手机屏一直亮着）。
    if (!isPanelOpen() || document.hidden) {
      try {
        s.release();
      } catch {
        /* ignore */
      }
      return;
    }
    const held = s as unknown as HeldLock;
    held.released = false;
    s.addEventListener('release', () => {
      held.released = true;
      if (wakeLock === held) wakeLock = null;
    });
    wakeLock = held;
  } catch {
    /* 特性不支持 / 被拒：静默跳过，不影响出码 */
  }
}

function releaseWakeLock(): void {
  try {
    if (wakeLock) {
      void wakeLock.release();
      wakeLock = null;
    }
  } catch {
    /* ignore */
  }
}

function putHint(host: HTMLElement, text: string): void {
  host.innerHTML = '';
  const p = document.createElement('p');
  p.className = 'ns-lock-warn';
  p.textContent = text;
  host.appendChild(p);
}

/**
 * 「没有口令」专用提示：一句原因 + 一个能走下去的动作。
 *
 * 🔴 与 putHint 的区别不是样式，而是**有没有出口**。
 *   单纯显示一句「无法生成配对码」＝把用户放在死路上：
 *   他既不知道为什么，也不知道下一步该做什么，只能反复点二维码按钮。
 */
function putNeedPassphrase(host: HTMLElement, onLockNow?: () => void): void {
  host.innerHTML = '';
  const p = document.createElement('p');
  p.className = 'ns-lock-warn';
  p.textContent = COPY.pairNeedPassphrase;
  host.appendChild(p);
  if (!onLockNow) return;
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'ns-ghost-btn';
  btn.id = 'pairLockNow';
  btn.textContent = COPY.pairLockNow;
  btn.addEventListener('click', onLockNow);
  host.appendChild(btn);
}

function putReveal(host: HTMLElement, onReveal: () => void): void {
  host.innerHTML = '';
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.id = 'qrReveal';
  btn.textContent = COPY.pairReveal;
  btn.addEventListener('click', onReveal);
  host.appendChild(btn);
}

/** 全屏放大层（老项目 v7.5.1：纯白铺满、点任意处收回）。 */
function showLarge(text: string): void {
  let el = document.getElementById('qrLarge');
  if (!el) {
    el = document.createElement('div');
    el.id = 'qrLarge';
    el.addEventListener('click', () => el?.classList.remove('show'));
    document.body.appendChild(el);
  }
  el.innerHTML = '';
  const cv = document.createElement('canvas');
  const wantPx = largeTargetPx(
    Math.min(window.innerWidth, window.innerHeight),
    window.devicePixelRatio || 2,
  );
  try {
    // 🔴 放大态**必须按 DPR 取设备像素**：按 CSS 像素画再让 CSS 放大，
    //   边缘会被浏览器双线性插值糊掉，摄像头识别率断崖（老项目 v7.5.1 实锤）。
    drawQr(cv, text, { qrcode: window.qrcode as QrcodeApi, wantPx });
  } catch {
    return;
  }
  el.appendChild(cv);
  el.classList.add('show');
}

export function buildPairPanel(deps: PairPanelDeps): PairPanel {
  // 已有开着的一层：先关掉再开新的。老项目没这一步，
  // 连点两下会叠两层遮罩，关掉最上面那层后底下那层再也关不掉。
  closePairPanel();

  const mask = document.createElement('div');
  mask.className = 'mask';
  mask.id = 'pairMask';

  const box = document.createElement('div');
  box.className = 'box qr-box';

  const h = document.createElement('h1');
  h.className = 'qr-title';
  h.textContent = COPY.pairTitle;

  // 🔴 老项目 index.html:774 标题下方的引导段，此前新项目**整个漏了**：
  //   <p>用另一台设备扫描二维码，<br>直接打开此笔记，无需输入口令。</p>
  // 它排在 holder **之前**，是扫码配对弹层的第二段。
  // 漏掉的后果不只是少一句话：弹层直接从标题跳到二维码，
  // 而「无需输入口令」正是扫码配对与"扫码换机"的分界说明 ——
  // 用户分不清这两件事，就会以为扫了还得手输口令（用户第 13 条抱怨的就是配对这一层说不清）。
  // innerHTML 安全：内容是本项目常量，不含任何用户输入。
  const lead = document.createElement('p');
  lead.innerHTML = COPY.pairLead;

  const holder = document.createElement('div');
  holder.id = 'qrHolder';

  const warn = document.createElement('p');
  warn.className = 'ns-qr-warn';
  warn.innerHTML = COPY.pairWarn;

  const closeBtn = document.createElement('button');
  closeBtn.id = 'qrClose';
  closeBtn.textContent = COPY.pairClose;

  box.append(h, lead, holder, warn, closeBtn);
  mask.appendChild(box);
  document.body.appendChild(mask);

  const link = deps.passphrase === null ? null : buildPairLink(deps.origin, deps.noteId, deps.passphrase);

  const reveal = async (): Promise<void> => {
    if (link === null) {
      putNeedPassphrase(holder, deps.onLockNow);
      return;
    }
    if (!(await loadQrcode())) {
      putHint(holder, COPY.pairRenderFail);
      return;
    }
    const cv = document.createElement('canvas');
    cv.id = 'qrCanvas';
    try {
      drawQr(cv, link, { qrcode: window.qrcode as QrcodeApi });
    } catch {
      // 🔴 出码失败必须留兜底入口，不能留一片空白
      //   （老项目「哑二维码」同款：按钮在、点了什么都不发生）。
      putReveal(holder, () => void reveal());
      return;
    }
    holder.innerHTML = '';
    cv.addEventListener('click', () => showLarge(link));
    holder.appendChild(cv);
  };

  const teardown = (): void => {
    document.removeEventListener('keydown', onKey, true);
    document.removeEventListener('visibilitychange', onVis);
    releaseWakeLock();
    document.getElementById('qrLarge')?.classList.remove('show');
    if (mask.parentNode) mask.parentNode.removeChild(mask);
    deps.onClosed();
  };

  // 🔴 Esc 必须能关。桌面端没有手机返回键，这条是唯一退路。
  const onKey = (e: KeyboardEvent): void => {
    if (e.key === 'Escape') teardown();
  };
  document.addEventListener('keydown', onKey, true);

  const onVis = (): void => {
    if (document.visibilityState === 'visible') {
      if (isPanelOpen()) void acquireWakeLock();
    } else {
      releaseWakeLock();
    }
  };
  document.addEventListener('visibilitychange', onVis);

  closeBtn.addEventListener('click', teardown);
  mask.addEventListener('click', (e) => {
    if (e.target === mask) teardown();
  });

  // 🔴🔴 拿不到口令（本次是「记忆解锁」进来的）时，给的是**带按钮**的提示。
  //   此前只 putHint 一句「解锁后才可使用二维码配对」，而此时用户明明在编辑器里，
  //   看起来就是自相矛盾的死路（用户报障第 13 条）。
  if (link === null) putNeedPassphrase(holder, deps.onLockNow);
  else void reveal();

  void acquireWakeLock();
  return { el: mask, close: teardown };
}

/** 显式关闭（供切页时清理）。 */
export function closePairPanel(): void {
  const el = document.getElementById('pairMask');
  if (el) {
    // 触发 teardown 的等价效果，但不强依赖闭包（closePairPanel 可能是另一次开面板时调的）
    document.getElementById('qrLarge')?.classList.remove('show');
    if (el.parentNode) el.parentNode.removeChild(el);
  }
  releaseWakeLock();
}
