/**
 * 正文图片的查看器（#nsZoom）与长按菜单（#nsImgMenu）。
 *
 * 🔴🔴🔴 为什么这个文件现在才存在（用户报障第 7 条「移动端图片显示异常」）：
 *   `ui/styles.css:1607-1670` **早就把两者的整套样式抄过来了** —— 查看器暗底、
 *   44px 大按钮、safe-area 让位、菜单 12px 圆角与 nsMenuFade 动画，
 *   文件头还写着「z序：查看器 88、菜单 89，都在图鉴 z90 之下」。
 *   但**没有任何一行 JS 建它们** ⇒ 那是**死 CSS**。
 *   探针实测（触屏 390x844，真浏览器）：`tap('.ns-img img')` →
 *   `{ zoom: false, menu: false }`，**什么都不发生**。
 *   症状正是用户在手机上看到的：「图片点了没反应，长按也没用」。
 *
 * ── 与老项目的口径对齐（index.html:5450-5560）─────────────────────
 *   ① **桌面点图直接进查看器；触屏长按先弹菜单**（老项目按 `nsHoverPointer()` 分流）。
 *      判据是**有没有精确指针**，与 platform/touch.ts、pickImage() 同一套，
 *      不能用 UA sniff（国产内核常年不准）。
 *   ② 触屏必须关掉原生长按菜单（老项目 :377 `html.ns-no-callout`）：
 *      iOS/Android 的 callout 只给「保存/复制」，会与自建菜单打架，
 *      而且它一出现，自建菜单就点不到了。
 *   ③ 菜单三项逐字：「放大查看」/「保存到相册」/「复制图片链接」（老项目 :5523-5525）。
 *      注意第三项是**五个字**的「复制图片链接」，而查看器底栏是三个字的「复制链接」
 *      （老项目 :5461）—— 两处不同，别混。
 *   ④ 查看器提示语按设备分（老项目 :5459）：
 *      桌面「滚轮缩放 · 双击 1:1 · 点空白关闭」/ 触屏「双指缩放 · 点图片即回笔记」。
 *   ⑤ Esc 只关一层：菜单在场时先关菜单（老项目 nsImgEsc :5513）。
 *
 * 🔴 为什么「保存到相册」在 bj 里走 `<a download>` 而不是老项目那套桥/阶梯：
 *   老项目有 Capacitor 原生桥（ImgSave.saveImageUrl / ImgClip）与四级阶梯，
 *   那些是**壳内**路径；bj 是纯 Web。纯 Web 下真正能落地的只有两条：
 *   浏览器下载、或系统分享面板。两条都给，且**如实告知**结果 ——
 *   浏览器不允许静默落盘时必须让用户看见（这是"静默降级"的红线）。
 */

import { dismissKeyboardForTouch } from '../platform/touch.ts';
import { COPY } from '../ui/copy.ts';

/** 是否存在精确指针。与 pickImage() 的 hasPrecisePointer 同口径。 */
function hasFinePointer(): boolean {
  try {
    const mq = window.matchMedia;
    if (!mq) return true;
    return !!mq('(any-pointer: fine)').matches || !!mq('(hover: hover)').matches;
  } catch {
    return true;
  }
}

/** 取图片的 src。走 DecoratorNode 渲染出的 `<img>`，没有就 null。 */
function srcOf(img: HTMLImageElement | null): string {
  if (!img) return '';
  const s = img.getAttribute('src') || '';
  return s.trim() === '' ? '' : s;
}

/** 图标：关闭 ×（老项目 :5464 的 path 逐字）。 */
const ICON_X =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" ' +
  'stroke-linecap="round"><path d="M6 6l12 12M18 6 6 18"/></svg>';

/* ------------------------------------------------------------------ *
 * 长按菜单 #nsImgMenu
 * ------------------------------------------------------------------ */

let imgMenuClose: (() => void) | null = null;

/** 关菜单。无菜单在场时**绝不抢焦点**（它挂在 capture 的 scroll/mousedown 上）。 */
export function closeImgMenu(): void {
  const m = document.getElementById('nsImgMenu');
  if (!m || !m.parentNode) return;
  m.parentNode.removeChild(m);
  const fn = imgMenuClose;
  imgMenuClose = null;
  if (fn) fn();
}

/**
 * 弹长按/右键菜单。老项目 index.html:5519。
 *
 * @param at `{x, y}` 屏幕坐标。定位按老项目 :5531-5532：先夹进视口内，
 *        再留8px 安全边 —— 否则长按屏幕最右边的图，菜单会有一半在屏外。
 */
export function openImgMenu(img: HTMLImageElement, at: { x: number; y: number }, close: () => void): void {
  closeImgMenu();
  const src = srcOf(img);
  if (!src) return;
  imgMenuClose = close;

  const m = document.createElement('div');
  m.id = 'nsImgMenu';
  // 🔴 顺序与逐字照老项目 :5523-5525。
  const items: Array<[string, () => void]> = [
    ['放大查看', () => openZoom(img)],
    ['保存到相册', () => saveImageToAlbum(src)],
    ['复制图片链接', () => copyImageLink(src)],
  ];
  for (const [text, fn] of items) {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = text;
    b.addEventListener('click', () => {
      closeImgMenu();
      fn();
    });
    m.appendChild(b);
  }
  document.body.appendChild(m);
  const w = m.offsetWidth || 160;
  const h = m.offsetHeight || 180;
  m.style.left = `${Math.max(8, Math.min(window.innerWidth - w - 8, at.x))}px`;
  m.style.top = `${Math.max(8, Math.min(window.innerHeight - h - 8, at.y))}px`;
}

/** 复制图片链接。老项目 :5534：clipboard.writeText，退回 execCommand。 */
function copyImageLink(src: string): void {
  void (async () => {
    try {
      if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
        await navigator.clipboard.writeText(src);
      } else {
        const ta = document.createElement('textarea');
        ta.value = src;
        document.body.appendChild(ta);
        ta.select();
        document.execCommand('copy');
        document.body.removeChild(ta);
      }
      flashStatus('图片链接已复制');
    } catch {
      flashStatus('图片链接复制失败');
    }
  })();
}

/**
 * 保存到相册。
 *
 * 🔴🔴 bj 是纯 Web，**没有**老项目那套 Capacitor ImgSave/ImgClip 桥，
 *   所以只有两条真能落地的路：`<a download>` 与系统分享面板。
 *   顺序按"成功率高者先"：分享面板在手机上几乎是唯一真正把图写进相册的口子
 *   （Chrome 桌面会让 download 直接落盘，移动端 WebView 则常常无反应）。
 *
 * 🔴🔴 **绝不静默**：两条都拿不到结果时必须明说，不能给"已保存"然后什么都没发生。
 *   那是最坏的一种失败 —— 用户以为存好了，回头找不到图。
 */
function saveImageToAlbum(src: string): void {
  void (async () => {
    // ① 系统分享面板（移动端落到相册的主力）
    try {
      const res = await fetch(src);
      const blob = await res.blob();
      const file = new File([blob], 'note-image.png', { type: blob.type || 'image/png' });
      if (typeof navigator.canShare === 'function' && navigator.canShare({ files: [file] }) && navigator.share) {
        await navigator.share({ files: [file] });
        flashStatus('已通过系统分享发出，可选「保存到相册」');
        return;
      }
    } catch (e) {
      // 用户主动取消分享：不弹失败文案（老项目 exportImage 的 AbortError 同款口径）
      if (e instanceof Error && e.name === 'AbortError') return;
    }
    // ② `<a download>`：桌面直接落盘，移动端视内核
    try {
      const a = document.createElement('a');
      a.href = src;
      a.download = 'note-image.png';
      document.body.appendChild(a);
      a.click();
      a.remove();
      flashStatus('已触发下载；若没反应请长按图片另存');
    } catch {
      flashStatus('这台设备无法直接保存，请长按图片另存');
    }
  })();
}

/* ------------------------------------------------------------------ *
 * 短提示（复用顶栏提示条；没有就退回不提示，绝不弹 alert）
 * ------------------------------------------------------------------ */

let flashTimer = 0;

function flashStatus(msg: string): void {
  const el = document.getElementById('uploadNote');
  if (!el) return;
  el.textContent = msg;
  el.dataset.kind = 'ok';
  el.classList.remove('hidden');
  window.clearTimeout(flashTimer);
  // 🔴 守卫式兜底自收（老项目「红线15」）：异常分支漏收也不许让提示条常驻。
  flashTimer = window.setTimeout(() => el.classList.add('hidden'), 2400);
}

/* ------------------------------------------------------------------ *
 * 查看器 #nsZoom
 * ------------------------------------------------------------------ */

let zoomState: {
  open: boolean;
  scale: number;
  tx: number;
  ty: number;
  pts: Record<number, { x: number; y: number }>;
  pinch: number;
  base: number;
  dragging: boolean;
  sx: number;
  sy: number;
  tapId: number | null;
  tapSX: number;
  tapSY: number;
  tapMoved: boolean;
  pushed: boolean;
} | null = null;

/**
 * 取当前活跃的两个指针。`pts` 是 Record，TS 的 noUncheckedIndexedAccess
 * 会把索引结果判成 `| undefined`，而这里"取两个就一定有两个"是调用方自己数过的 ——
 * 用一个显式函数把断言收在一处，别在四个调用点各写一个 `!`。
 */
function twoPoints(
  st: NonNullable<typeof zoomState>,
): [{ x: number; y: number }, { x: number; y: number }] | null {
  const ids = Object.keys(st.pts);
  if (ids.length !== 2) return null;
  const a = st.pts[Number(ids[0])];
  const b = st.pts[Number(ids[1])];
  return a && b ? [a, b] : null;
}

function applyTransform(): void {
  const z = document.getElementById('nsZoom');
  const im = z && (z.querySelector('.nz-stage img') as HTMLElement | null);
  const st = zoomState;
  if (!im || !st) return;
  im.style.transform = `translate(${st.tx}px, ${st.ty}px) scale(${st.scale})`;
  z.classList.toggle('zm', st.scale > 1.02);
}

export function closeZoom(): void {
  document.getElementById('nsZoom')?.remove();
  const wasOpen = zoomState?.open === true;
  zoomState = null;
  if (wasOpen) {
    // 🔴 老项目 :5470 压了一条同 URL 历史，让安卓物理返回键能关掉大图回正文。
    //   popstate 必须由本模块消费掉，否则返回键会把用户带出整个页面。
    window.removeEventListener('popstate', onZoomPop);
    if (zoomPushedOnce) {
      zoomPushedOnce = false;
      try {
        history.back();
      } catch {
        /* 老内核 history.back 不可用：忽略，用户点× 照样能关 */
      }
    }
  }
}

let zoomPushedOnce = false;

function onZoomPop(): void {
  // 由 closeZoom 主动 history.back() 触发：只关层，不再 back（否则来回弹跳）
  zoomPushedOnce = false;
  const st = zoomState;
  zoomState = null;
  document.getElementById('nsZoom')?.remove();
  void st;
}

/**
 * 打开查看器。老项目 index.html:5450。
 *
 * @param img 正文里的那张图（外链src 原样取，不重新 fetch 成blob）
 */
export function openZoom(img: HTMLImageElement): void {
  const src = srcOf(img);
  if (!src) return;
  closeZoom();
  closeImgMenu();

  const z = document.createElement('div');
  z.id = 'nsZoom';
  const stage = document.createElement('div');
  stage.className = 'nz-stage';
  const im = document.createElement('img');
  im.src = src;
  im.alt = '';
  im.decoding = 'async';
  im.referrerPolicy = 'no-referrer';
  stage.appendChild(im);
  const tip = document.createElement('div');
  tip.className = 'nz-tip';
  // 🔴 按设备分文案（老项目 :5459 nsHoverPointer 分支，逐字）
  tip.textContent = hasFinePointer() ? COPY.imgZoomTipFine : COPY.imgZoomTipTouch;
  const bar = document.createElement('div');
  bar.className = 'nz-bar';
  // 🔴 底栏两项与菜单三项**不是同一套文案**（老项目 :5461 vs :5523-5525）：
  //   底栏是「复制链接」（三个字），菜单是「复制图片链接」（五个字）。
  for (const [text, fn, pri] of [
    ['复制链接', () => copyImageLink(src), false],
    ['保存到相册', () => saveImageToAlbum(src), true],
  ] as Array<[string, () => void, boolean]>) {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = text;
    if (pri) b.className = 'nz-pri';
    b.addEventListener('click', fn);
    bar.appendChild(b);
  }
  const x = document.createElement('div');
  x.className = 'nz-x';
  x.setAttribute('role', 'button');
  x.setAttribute('tabindex', '0');
  x.setAttribute('aria-label', COPY.close);
  x.innerHTML = ICON_X;
  z.append(stage, tip, bar, x);
  document.body.appendChild(z);

  zoomState = {
    open: true, scale: 1, tx: 0, ty: 0, pts: {}, pinch: 0, base: 1,
    dragging: false, sx: 0, sy: 0, tapId: null, tapSX: 0, tapSY: 0, tapMoved: false, pushed: false,
  };
  applyTransform();

  // 🔴 压一条同 URL 历史（老项目 :5470），只在首次打开时压，
  //   重开不同图沿用已压的那条 —— 否则连点十次会压十层，返回键要按十次。
  if (!zoomPushedOnce) {
    try {
      history.pushState({ nsZoom: 1 }, '');
      zoomPushedOnce = true;
      window.addEventListener('popstate', onZoomPop);
    } catch {
      zoomPushedOnce = false;
    }
  }

  // 🔴 触屏打开大图收一次输入法（老项目 :5471）——
  //   不收的话软键盘会遮住图片，而此刻用户根本没打算打字。
  try {
    dismissKeyboardForTouch();
  } catch {
    /* 收键盘失败不影响看图 */
  }

  // 点空白 / × / stage 关；点图片本身**不关**（缩放态还要接受拖拽）
  const close = (): void => closeZoom();
  z.addEventListener('click', (e) => {
    const t = e.target as HTMLElement;
    if (t === z || t === stage || t === x || x.contains(t)) close();
  });
  x.addEventListener('click', close);

  // 双击 1:1 / 2.4x（老项目 :5476）
  im.addEventListener('dblclick', (e) => {
    e.preventDefault();
    const st = zoomState;
    if (!st) return;
    st.scale = st.scale > 1.02 ? 1 : 2.4;
    if (st.scale === 1) {
      st.tx = 0;
      st.ty = 0;
    }
    applyTransform();
  });

  // 滚轮缩放（老项目 :5477）
  z.addEventListener(
    'wheel',
    (e) => {
      e.preventDefault();
      const st = zoomState;
      if (!st) return;
      const k = e.deltaY < 0 ? 1.12 : 1 / 1.12;
      st.scale = Math.max(1, Math.min(6, st.scale * k));
      if (st.scale === 1) {
        st.tx = 0;
        st.ty = 0;
      }
      applyTransform();
    },
    { passive: false },
  );

  // 指针事件统一管拖拽平移与双指缩放（桌面/触屏一套代码，老项目 :5479-5505）
  z.addEventListener('pointerdown', (e) => {
    const st = zoomState;
    if (!st || e.target !== im) return;
    st.pts[e.pointerId] = { x: e.clientX, y: e.clientY };
    const pair = twoPoints(st);
    if (pair) {
      st.pinch = Math.hypot(pair[0].x - pair[1].x, pair[0].y - pair[1].y);
      st.base = st.scale;
      st.tapId = null;
    } else if (!st.dragging && Object.keys(st.pts).length === 1) {
      st.dragging = true;
      st.sx = e.clientX;
      st.sy = e.clientY;
      st.tapId = e.pointerId;
      st.tapSX = e.clientX;
      st.tapSY = e.clientY;
      st.tapMoved = false;
    }
    try {
      z.setPointerCapture(e.pointerId);
    } catch {
      /* 某些内核对非活动指针抛错：不影响主流程 */
    }
    e.preventDefault();
  });

  z.addEventListener('pointermove', (e) => {
    const st = zoomState;
    if (!st || !st.pts[e.pointerId]) return;
    st.pts[e.pointerId] = { x: e.clientX, y: e.clientY };
    // 位移超 12px 就判定为拖拽，之后抬手**不**当单击（老项目 :5500）
    if (st.tapId === e.pointerId && !st.tapMoved && Math.hypot(e.clientX - st.tapSX, e.clientY - st.tapSY) > 12) {
      st.tapMoved = true;
    }
    const pair = twoPoints(st);
    if (pair && st.pinch > 0) {
      st.scale = Math.max(1, Math.min(6, st.base * (Math.hypot(pair[0].x - pair[1].x, pair[0].y - pair[1].y) / st.pinch)));
      if (st.scale === 1) {
        st.tx = 0;
        st.ty = 0;
      }
      applyTransform();
    } else if (st.dragging && st.scale > 1.02) {
      st.tx += e.clientX - st.sx;
      st.ty += e.clientY - st.sy;
      st.sx = e.clientX;
      st.sy = e.clientY;
      applyTransform();
    }
  });

  const up = (e: PointerEvent): void => {
    const st = zoomState;
    if (!st) return;
    // 🔴 触屏单指、无位移、非双指 → 单击图片即关窗回正文（老项目 :5508）。
    //   桌面鼠标**不**走这条 —— 桌面用户单击图片是"看"，关窗会显得莫名其妙。
    if (e.pointerType === 'touch' && st.tapId === e.pointerId && !st.tapMoved) {
      st.tapId = null;
      closeZoom();
      return;
    }
    delete st.pts[e.pointerId];
    if (Object.keys(st.pts).length < 2) st.pinch = 0;
    st.dragging = false;
  };
  z.addEventListener('pointerup', up);
  z.addEventListener('pointercancel', up);

  document.addEventListener('keydown', onZoomKey, true);
}

/** Esc 只关一层：菜单在场先关菜单（老项目 nsImgEsc :5513）。 */
function onZoomKey(e: KeyboardEvent): void {
  if (!e || e.key !== 'Escape') return;
  if (document.getElementById('nsImgMenu')) {
    closeImgMenu();
    return;
  }
  if (zoomState?.open) {
    document.removeEventListener('keydown', onZoomKey, true);
    closeZoom();
  }
}

/* ------------------------------------------------------------------ *
 * 接线
 * ------------------------------------------------------------------ */

/** 长按判定阈值（ms）。老项目用 500ms 附近的定时器；太短会与"点开查看器"打架。 */
const HOLD_MS = 480;
/** 位移超过这个数就不算长按（用户是在拖图，不是在长按）。 */
const HOLD_SLOP = 12;

/**
 * 挂到编辑器容器上（事件委托，一次挂好）。
 *
 * 🔴🔴 **触屏必须关掉原生长按菜单**（老项目 :377）：
 *   iOS/Android 的 callout 只给「保存/复制」，它一弹出来，
 *   下面的自建菜单就点不到了 —— 于是"我加了菜单但用户还是看到系统的"，
 *   而且**无法在桌面验证**（桌面没有 callout）。
 *   做法是给 `documentElement` 挂 `ns-no-callout` 类，与老项目同名同机制；
 *   精确指针设备不挂（桌面不需要，且它会顺带禁掉桌面右键的原生能力）。
 */
export function bindImageViewer(host: HTMLElement, closeOverlay: () => void): void {
  const fine = hasFinePointer();
  if (!fine) document.documentElement.classList.add('ns-no-callout');
  else document.documentElement.classList.remove('ns-no-callout');

  let holdTimer = 0;
  let holdFrom: { x: number; y: number } | null = null;

  const clearHold = (): void => {
    window.clearTimeout(holdTimer);
    holdTimer = 0;
    holdFrom = null;
  };

  host.addEventListener(
    'pointerdown',
    (e) => {
      const t = e.target as HTMLElement | null;
      const img = t && t.tagName === 'IMG' ? (t as HTMLImageElement) : null;
      // 精确指针设备：长按菜单不是主路径（右键/单击已够用），不挂定时器。
      if (fine || !img) return;
      holdFrom = { x: e.clientX, y: e.clientY };
      holdTimer = window.setTimeout(() => {
        holdFrom = null;
        openImgMenu(img, { x: e.clientX, y: e.clientY }, closeOverlay);
      }, HOLD_MS);
    },
    { capture: true },
  );

  host.addEventListener(
    'pointermove',
    (e) => {
      if (!holdFrom) return;
      if (Math.hypot(e.clientX - holdFrom.x, e.clientY - holdFrom.y) > HOLD_SLOP) clearHold();
    },
    { capture: true },
  );
  for (const ev of ['pointerup', 'pointercancel', 'pointerleave'] as const) {
    host.addEventListener(ev, clearHold, { capture: true });
  }

  // 菜单在场时：点别处关掉、Esc 关掉、滚动关掉（老项目 :5641/:5643 capture 全局挂）
  document.addEventListener('pointerdown', (e) => {
    const m = document.getElementById('nsImgMenu');
    if (m && !m.contains(e.target as HTMLElement)) closeImgMenu();
  }, true);
  document.addEventListener('scroll', closeImgMenu, { passive: true, capture: true });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeImgMenu();
  }, true);

  // 点击：有精确指针 → 直接开查看器；触屏 → 不动（长按才出菜单，单击留着选图/不干扰）
  host.addEventListener('click', (e) => {
    if (!fine) return;
    const t = e.target as HTMLElement | null;
    if (!t || t.tagName !== 'IMG') return;
    if (!t.closest('.ns-img')) return;
    openZoom(t as HTMLImageElement);
  });
}