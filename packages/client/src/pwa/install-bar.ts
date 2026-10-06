/**
 * PWA 安装引导条（老项目 index.html:734-745 DOM / 171-183 CSS / 5947-5994 JS）
 *
 * 🔴🔴 为什么必须有它（用户报障第 12 条「网页端不支持生成 PWA」）：
 *   manifest 齐了之后，Chrome/Edge 才会真的发出 `beforeinstallprompt`，
 *   而那件事**只发生一次、且不告诉用户任何事** —— 不接住它，
 *   用户永远不知道可以装。老项目 v5.35 就是为了这个才做这条横幅。
 *
 * 三条纪律（都是老项目踩过的）：
 *   1. **解锁后才弹**，不在落地页打扰（老项目 index.html:3476 的调用点在解锁回调里）。
 *   2. **iOS 如实说明**：`beforeinstallprompt` 在 iOS 永不触发，只能走 Safari
 *      分享菜单。老项目对 iOS 隐藏「安装」按钮并改文案，**不装糊涂**
 *      （index.html:5975-5977）。硬给一个点不动的按钮比不给更糟。
 *   3. **「以后再说」只收本会话、「×」才写永久**（老项目 v9.5.8 index.html:5989-5995）：
 *      前者靠 `shownThisSession` 挡重弹，不写 localStorage；
 *      后者写 `notesync_install_dismissed=1`，是用户明确表达"别再提"。
 */

import { COPY } from '../ui/copy.ts';
import { LOGO_SM } from '../ui/icons.ts';

const DISMISS_KEY = 'notesync_bj_install_dismissed';

let deferredPrompt: (Event & { prompt?: () => Promise<void>; userChoice?: Promise<{ outcome: string }> }) | null =
  null;
let shownThisSession = false;
let bar: HTMLElement | null = null;

function isStandalone(): boolean {
  return (
    (typeof matchMedia === 'function' &&
      matchMedia('(display-mode: standalone)').matches) ||
    // iOS Safari 的旧写法
    (navigator as unknown as { standalone?: boolean }).standalone === true
  );
}

function isIOS(): boolean {
  return /iphone|ipad|ipod/i.test(navigator.userAgent || '');
}

function dismissed(): boolean {
  try {
    return localStorage.getItem(DISMISS_KEY) === '1';
  } catch {
    return false;
  }
}

function hide(): void {
  bar?.classList.add('hidden');
}

/**
 * 建条。只建一次，重复调用复用同一个节点。
 * 可见性由 `tryShow` 控制。
 */
function ensureBar(): HTMLElement {
  if (bar) return bar;
  const el = document.createElement('div');
  el.id = 'installBar';
  el.className = 'hidden';
  el.innerHTML = `
<div class="instcard">
  <button type="button" id="installDismiss" title="${COPY.installDismissTitle}" aria-label="${COPY.installDismissTitle}">${CLOSE_SVG}</button>
  <span class="inst-logo" aria-hidden="true">${LOGO_SM()}</span>
  <div id="installTitle">${COPY.installTitle}</div>
  <p id="installMsg"></p>
  <div class="inst-btns">
    <button type="button" id="installGo">${COPY.installGo}</button>
    <button type="button" id="installLater">${COPY.installLater}</button>
  </div>
</div>`.trim();
  document.body.appendChild(el);
  bar = el;

  el.querySelector('#installGo')?.addEventListener('click', () => {
    void (async () => {
      if (!deferredPrompt?.prompt) return;
      try {
        await deferredPrompt.prompt();
        await deferredPrompt.userChoice;
      } catch {
        /* 用户取消或内核拒绝：静默收场，不给报错 */
      }
      deferredPrompt = null;
      hide();
    })();
  });
  // 🔴 「以后再说」只收本会话：不写存储（老项目 v9.5.8 明确区分这两个按钮）
  el.querySelector('#installLater')?.addEventListener('click', hide);
  // 🔴 「×」才是"别再提"
  el.querySelector('#installDismiss')?.addEventListener('click', () => {
    try {
      localStorage.setItem(DISMISS_KEY, '1');
    } catch {
      /* 写不进就只在本次会话生效 */
    }
    hide();
  });
  return el;
}

const CLOSE_SVG =
  '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" ' +
  'stroke-width="2" stroke-linecap="round" aria-hidden="true">' +
  '<path d="m6.2 6.2 11.6 11.6"/><path d="M17.8 6.2 6.2 17.8"/></svg>';

/**
 * 尝试显示安装条。**必须在解锁成功后调用**（老项目 index.html:3476）。
 *
 * 不显示的四种情况（与老项目一致）：本会话已弹过 / 已是桌面应用 /
 * 用户点过 × / **冲突条在场**（老项目 index.html:5969：冲突优先，不叠条）。
 */
export function tryShowInstallBar(conflictVisible?: boolean): void {
  if (shownThisSession || isStandalone() || dismissed()) return;
  if (conflictVisible) return;
  // 只有「有 deferredPrompt」或「是 iOS」才值得弹；其它浏览器一律不打扰
  if (!deferredPrompt && !isIOS()) return;

  shownThisSession = true;
  const el = ensureBar();
  const go = el.querySelector<HTMLElement>('#installGo');
  const msg = el.querySelector<HTMLElement>('#installMsg');
  if (deferredPrompt) {
    if (msg) msg.textContent = COPY.installMsgChromium;
    go?.classList.remove('hidden');
  } else {
    // 🔴 iOS：没有可编程的安装入口，如实说明去 Safari 分享菜单做
    if (msg) msg.textContent = COPY.installMsgIOS;
    go?.classList.add('hidden');
  }
  el.classList.remove('hidden');
}

/**
 * 装监听。**在启动时调一次**（老项目在主脚本末尾挂 window 监听）。
 * 幂等：重复调不会重复挂。
 */
let installed = false;
export function initInstallPrompt(): void {
  if (installed) return;
  installed = true;
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    deferredPrompt = e as typeof deferredPrompt;
  });
  window.addEventListener('appinstalled', () => {
    deferredPrompt = null;
    hide();
  });
}