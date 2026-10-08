/**
 * App 在线升级 —— UI 层（关于页行 + 确认弹窗 + 进度条）
 *
 * 🔴🔴 复刻纪律（与菜单 11 项同源）：
 *   「检查更新」行**只在 App 壳内显示**。网页版 F5 就是最新，
 *   给按钮只会让用户困惑"我明明刚刷新过"。
 *   App 版本行同理 —— 网页上没有"App 版本"这回事。
 *
 * 🔴🔴 全部 DOM 用 createElement + textContent 拼，**不拼 innerHTML**：
 *   更新摘要来自 GitHub Release 正文，是**外部输入**。
 *   老项目用 innerHTML 拼过一次，是个真实 XSS 面（Release 正文可被任意 tag 触发者控制）。
 *   这里逐字用 textContent，外部输入一个字节都不当 HTML 解析。
 *
 * 🔴 用现成的 .mask / .box 类，不另起一套：
 *   颜色全走 var(--*)，本文件不出现颜色字面量（见 styles.css 文件头）。
 */

import { COPY } from '../ui/copy.ts';
import { ICON_X } from '../ui/icons.ts';
import { REAL_SCHED, aboutTapHit, createAboutTapper } from '../diag/tap.ts';
import type { LatestRelease } from './ota.ts';
import type { CheckResult, NativeDeps, ProgressFn } from './ota-native.ts';
import { appVersionLine, checkUpdate, runUpdate } from './ota-native.ts';

export interface AboutDeps {
  native: NativeDeps;
  /** 网页版版本（构建期注入的 APP_VERSION） */
  webVersion: string;
  /**
   * 🔴 彩蛋：标题 800ms 内连点 4 次 ⇒ 关关于页 + 开诊断模态（老项目 index.html:8204-8215）。
   *
   *   **为什么做成注入而不是本文件自己实现**：连点判定是纯状态机
   *   （滑动窗口，见 diag/panel.ts 的 `aboutTapHit` 注释），把它放在这里
   *   就等于让 ota-ui 也持有一份计数态，而这份状态**只有诊断用**。
   *   注入后本文件只负责"点击了标题 ⇒ 问一声要不要开诊断"，
   *   判据也能在 node 里直接测那套状态机而不必拉起整个关于页。
   *
   *   缺省则不响应连点（不传就是没接这功能，不留半个实现）。
   */
  onTitleQuadTap?: () => void;
  /**
   * 🔴🔴 关于页的「彩蛋 N / M FOUND」入口行（老项目 index.html:11115-11131 `mountAboutRow`）。
   *
   *   老项目把这行**插在作者行之后**（`box.parentNode.insertBefore(row, box.nextSibling)`，
   *   box = `#aboutAuthor`），整行可点，点了开图鉴（`nsEggOpen()`）。
   *   用户报障第 5 条「关于 NoteSyncX 没有列举彩蛋」就是这行缺失。
   *
   *   **为什么做成注入而不是本文件自己实现**：与 `onTitleQuadTap` 同款 ——
   *   本文件不认识彩蛋层（`egg/registry` 是另一层），计数与开图鉴都得由调用方给。
   *   不传 ⇒ 该行**根本不渲染**（不接就不留半个实现）。
   */
  eggRow?: {
    /** 计数文案，如 `3 / 17 FOUND`（老项目 `nsEggGot() + ' / ' + NS_EGG_LIST.length + ' FOUND'`）。 */
    count: () => string;
    /** 点整行开图鉴（老项目 `nsEggOpen()`）。 */
    open: () => void;
  };
}

/** 彩蛋入口行的 chevron —— 老项目 index.html:11124 逐字（24 视框、描边 2.4、圆头圆角）。 */
const CHEV_SVG =
  '<svg class="ns-chev" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" ' +
  'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9.5 5.5 16 12l-6.5 6.5"/></svg>';

export interface AboutOverlay {
  el: HTMLElement;
  /** 打开关于页。壳内会异步补 App 版本行与检查更新行。 */
  open: () => void;
  close: () => void;
  isOpen: () => boolean;
}

/** 更新弹窗 DOM id —— e2e 按 id 找。改动要同步改 e2e。 */
export const UPD_IDS = {
  mask: 'updMask',
  ver: 'updVer',
  notes: 'updNotes',
  msg: 'updMsg',
  prog: 'updProg',
  bar: 'updBar',
  yes: 'updYes',
  no: 'updNo',
} as const;

export function buildAboutOverlay(host: HTMLElement, deps: AboutDeps): AboutOverlay {
  // 🔴🔴 幂等：老项目 `#aboutMask` / `#updMask` 是页面里的**单例**（index.html:828/842），
  //   而 bj 每次点「关于」都新建一层。不摘旧的就会叠出第二层 ——
  //   表现是出现两个 `#aboutEggRow`（`getElementById` 取到旧的那个，计数停在旧值）。
  document.getElementById('aboutMask')?.remove();
  document.getElementById(UPD_IDS.mask)?.remove();

  const el = document.createElement('div');
  el.className = 'mask hidden';
  el.id = 'aboutMask';

  const box = document.createElement('div');
  // 🔴 老项目 index.html:830 `class="box qr-box"` —— 两个类都要。
  //   .qr-box 提供 `text-align:center`（老项目 index.html:526），
  //   关于页的「整体居中 + 标题金线」版式就是靠它落的。
  //   只靠 .about-title 自带的 text-align:center 虽然当前显示等价，
  //   但那是**新项目自己另找的等价路径**：一旦标题改成非块级或加副标题，
  //   两边就会分叉。承重类优先用老项目的。
  box.className = 'box qr-box';

  const h1 = document.createElement('h1');
  h1.textContent = COPY.aboutTitle;
  // 🔴🔴 关于页标题必须**独立居中 + 下方一条 52px 金线**（老项目 index.html:253-254）：
  //   `#aboutTitle{font-family:var(--serif);font-size:18px;font-weight:600;letter-spacing:1px}`
  //   `#aboutTitle::after{content:'';display:block;width:52px;height:1px;background:var(--accent);margin:11px auto 0;opacity:.8}`
  //   原先它挂在 .modal-head 里与关闭 × 并排（space-between），既不居中也没有金线 ——
  //   「扉页式小号衬线标题 + 细长金线」是用户五轮反馈收敛出来的版式，丢了就不是那个关于页。
  //   金线走 ::after（纯 CSS），这里只需给它一个能居中的块级容器；
  //   关闭 × 改为 .box-x 绝对定位浮在盒内右上（老项目 .box-x 同款），不参与标题行的排版。
  // 🔴🔴 id 必须叫 `aboutTitle`（老项目 index.html:829 就是
  //   `<h1 class="qr-title" id="aboutTitle">`），**不能只用 .about-title 类**：
  //   老项目靠 **ID 特异性**（1,0,0）压过 `.qr-box .qr-title`（0,2,0）的 letter-spacing:.02em，
  //   才保住「字距 1px」；bj 若只用类名（本项目此前就是这样），新加的 `.box h1`（0,1,1）
  //   会把 letter-spacing 吃掉改成 .02em、还多塞一个 margin-bottom:8px ——
  //   而那正是用户五轮反馈收敛出来的「扉页式小号衬线标题 + 细长金线」版式。
  //   类名保留（e2e 与样式都按它选），但承重的那份 specificity 交给 id。
  h1.className = 'about-title';
  h1.id = 'aboutTitle';
  const x = document.createElement('button');
  x.className = 'box-x';
  x.type = 'button';
  x.title = COPY.close;
  x.setAttribute('aria-label', COPY.close);
  // 🔴🔴 用 ICON_X 的 SVG，不要 textContent='×'：
  //   字形 × 的 optical size / 笔画粗细由系统字体决定（各机型不一致），
  //   而老项目全站关闭键都是 24 视框、描边 2 的同一枚路径（index.html:667/679），
  //   并排看时字形 × 明显比旁边的 SVG 图标"轻一号、偏一号"。
  //   走 innerHTML 是安全的：ICON_X 是本项目自产的常量字符串，无外部输入。
  x.innerHTML = ICON_X();
  box.append(h1, x);

  const body = document.createElement('div');
  body.className = 'about-body';

  // 网页版本
  body.append(row(COPY.aboutWeb, 'Version ' + deps.webVersion));

  // App 版本（仅壳内，取不到就整行隐藏）
  const appRow = row(COPY.aboutApp, '');
  appRow.id = 'aboutAppRow';
  appRow.classList.add('hidden');
  body.append(appRow);

  // 作者
  // 🔴 作者行的**值是金色衬线 14px**（老项目 index.html:260
  //   `#aboutAuthorName{…font-family:var(--serif);color:var(--accent);font-weight:400;font-size:14px;letter-spacing:.5px}`），
  //   与其余行的前景色值不同 —— 给行加一个专属类，CSS 才能只把这一行的值挑出来。
  const authorRow = row(COPY.aboutAuthor, COPY.aboutAuthorName);
  authorRow.classList.add('about-author');
  body.append(authorRow);

  // 彩蛋入口行（老项目 :11125 `insertBefore(row, aboutAuthor.nextSibling)` ⇒ 排在作者行之后）
  if (deps.eggRow) {
    const eggRow = document.createElement('div');
    eggRow.className = 'about-row ns-egg-entry';
    // 🔴 id 必须是 `aboutEggRow`（老项目 :11121）：漏赋值 ⇒ 每次开关于多插一行。
    eggRow.id = 'aboutEggRow';
    eggRow.setAttribute('role', 'button');
    eggRow.tabIndex = 0;
    const ek = document.createElement('span');
    ek.className = 'about-k';
    ek.textContent = COPY.aboutEgg;
    const ev = document.createElement('span');
    ev.className = 'about-v';
    const num = document.createElement('span');
    num.className = 'ns-num';
    num.textContent = deps.eggRow.count();
    ev.append(num);
    // 🔴 chevron 是本项目自产常量（无外部输入）⇒ 走 innerHTML 安全，与 ICON_X 同款；
    //   取出首个子元素（就是那枚 svg）直接当 `ev` 的孩子，保持老项目「svg 自带 .ns-chev」的形状。
    const chevWrap = document.createElement('span');
    chevWrap.innerHTML = CHEV_SVG;
    const chev = chevWrap.firstElementChild;
    if (chev) ev.append(chev);
    eggRow.append(ek, ev);
    const openEgg = deps.eggRow.open;
    eggRow.addEventListener('click', () => openEgg());
    eggRow.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        openEgg();
      }
    });
    body.append(eggRow);
  }

  // 检查更新（仅壳内）
  const updRow = row(COPY.aboutUpdate, '');
  updRow.id = 'aboutUpdRow';
  updRow.classList.add('hidden');
  const updBtn = document.createElement('span');
  updBtn.id = 'aboutUpd';
  // 🔴🔴 必须**两个类都挂**：老项目 index.html:838 是 `class="about-v upd-link"`。
  //   只挂 `upd-link` 会丢掉 `.about-v` 的 `width:110px; text-align:left` ⇒
  //   「检查更新」不再与「Version x.y.z」左对齐（用户报障第 6 条）。
  //   `.upd-link` 只负责金色 + 下划线，定宽左对齐那半仍在 `.about-v` 上。
  updBtn.className = 'about-v upd-link';
  updBtn.setAttribute('role', 'button');
  updBtn.tabIndex = 0;
  updBtn.textContent = COPY.upd.checkBtn;
  updRow.lastChild!.replaceWith(updBtn);
  body.append(updRow);

  box.append(body);
  el.append(box);
  host.append(el);

  /* ---------- 更新弹窗（挂在 body 上，独立于关于页） ---------- */
  const um = document.createElement('div');
  um.className = 'mask hidden';
  um.id = UPD_IDS.mask;
  const ubox = document.createElement('div');
  ubox.className = 'box';

  const uver = document.createElement('div');
  uver.className = 'upd-ver';
  uver.id = UPD_IDS.ver;

  const unotes = document.createElement('div');
  unotes.className = 'upd-notes';
  unotes.id = UPD_IDS.notes;

  const umsg = document.createElement('div');
  umsg.className = 'upd-msg';
  umsg.id = UPD_IDS.msg;

  const uprog = document.createElement('div');
  uprog.className = 'upd-prog hidden';
  uprog.id = UPD_IDS.prog;
  const ubar = document.createElement('div');
  ubar.className = 'upd-bar';
  const ufill = document.createElement('i');
  ufill.id = UPD_IDS.bar;
  ubar.append(ufill);
  uprog.append(ubar);

  const ufoot = document.createElement('div');
  ufoot.className = 'upd-foot';
  const uno = document.createElement('button');
  uno.className = 'ghost';
  uno.type = 'button';
  uno.id = UPD_IDS.no;
  uno.textContent = COPY.upd.later;
  const uyes = document.createElement('button');
  uyes.className = 'primary';
  uyes.type = 'button';
  uyes.id = UPD_IDS.yes;
  uyes.textContent = COPY.upd.now;
  ufoot.append(uno, uyes);

  ubox.append(uver, unotes, umsg, uprog, ufoot);
  um.append(ubox);
  host.append(um);

  /* ---------- 行为 ---------- */
  let current: LatestRelease | null = null;

  const closeAbout = () => el.classList.add('hidden');
  const closeUpd = () => um.classList.add('hidden');

  x.onclick = closeAbout;
  // 🔴 彩蛋连点（老项目 :8206-8215）。计数状态机在 diag/panel.ts 的 aboutTapHit，
  //   本文件**只挂标题这一个入口**。
  if (deps.onTitleQuadTap) {
    const tapper = createAboutTapper();
    h1.onclick = () => {
      // 🔴 必须先关关于页再开诊断模态（老项目 :8212-8213 的顺序）：
      //   两个都是全屏遮罩（`.mask` z40），不关的话诊断模态盖在关于页下面，
      //   现象是"点了没反应" —— 而 z 值相同，谁后 remove('hidden') 谁在上面，
      //   顺序反了就会出现两层遮罩叠着、关掉诊断后关于页又露出来。
      if (aboutTapHit(tapper, REAL_SCHED)) {
        closeAbout();
        deps.onTitleQuadTap?.();
      }
    };
  }
  um.onclick = (e) => { if (e.target === um) closeUpd(); };
  uno.onclick = closeUpd;

  // 检查更新按钮
  const onCheck = async () => {
    if (updBtn.getAttribute('aria-busy') === '1') return;
    updBtn.setAttribute('aria-busy', '1');
    updBtn.textContent = COPY.upd.checking;
    // 🔴 用 style 禁指针而不是 disabled：disabled 的元素不触发 CSS hover，
    //   用户会觉得"按钮坏了"，而实际只是 200ms 内不可点。
    updBtn.style.pointerEvents = 'none';
    const restore = () => {
      updBtn.setAttribute('aria-busy', '0');
      updBtn.textContent = COPY.upd.checkBtn;
      updBtn.style.pointerEvents = '';
    };
    try {
      const r: CheckResult = await checkUpdate(deps.native, deps.webVersion);
      if (r.kind === 'update') {
        showUpdate(r.rel);
        restore();
      } else {
        updBtn.textContent = messageFor(r);
        setTimeout(restore, 2600);
      }
    } catch {
      updBtn.textContent = COPY.upd.fail;
      setTimeout(restore, 2600);
    }
  };
  updBtn.onclick = () => { void onCheck(); };
  // 🔴 role=button 必须自己处理 Enter/Space，键盘用户否则进不去
  updBtn.onkeydown = (e) => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); void onCheck(); }
  };

  uyes.onclick = () => { void onYes(); };

  async function onYes() {
    if (!current) return;
    const rel = current;
    uyes.disabled = true;
    uyes.textContent = COPY.upd.preparing;
    uprog.classList.remove('hidden');
    ufill.style.width = '0%';
    umsg.textContent = '';
    const onProgress: ProgressFn = (d, t) => {
      // 🔴 首次收到进度就把按钮切成「下载中…」（老项目 :8166 同款）：
      //   「准备下载…」是 downloadApk 发车前的态，进了轮询还挂着它，
      //   用户会以为一直没开始下。
      if (uyes.textContent !== COPY.upd.downloadingBtn) uyes.textContent = COPY.upd.downloadingBtn;
      // 🔴 total 为 0 时不显示百分比：显示 "0%" 再跳 100% 比不显示更让人以为卡住。
      if (t <= 0) return;
      // 🔴 下载期上限 99%（老项目 :8179 同款）：100% 只留给"已完成"，
      //   否则进度条满了却还在下，用户以为卡在最后 1%。
      const pct = Math.min(99, Math.round((d / t) * 100));
      ufill.style.width = pct + '%';
      const mb = (n: number): string => (n / 1048576).toFixed(1);
      umsg.textContent = COPY.upd.downloading(pct, mb(d), mb(t));
    };
    const msg = await runUpdate(deps.native, rel, onProgress);
    uprog.classList.add('hidden');
    uyes.disabled = false;
    uyes.textContent = COPY.upd.now;
    umsg.textContent = msg;
    // 🔴 失败类文案留在弹窗里（用户要看），成功类自动关掉（要去装应用了）。
    if (msg.startsWith('正在打开安装程序')) {
      setTimeout(closeUpd, 1200);
    } else {
      // 失败后按钮变「重试」
      uyes.textContent = COPY.upd.retry;
    }
  }

  function showUpdate(rel: LatestRelease) {
    current = rel;
    uver.textContent = '';
    uver.append(document.createTextNode(COPY.upd.newVersion(rel.version)));
    if (rel.size > 0) {
      const sz = document.createElement('span');
      sz.className = 'sz';
      sz.textContent = COPY.upd.size((rel.size / 1048576).toFixed(1));
      uver.append(sz);
    }
    unotes.textContent = '';
    rel.notes.forEach((ln, i) => {
      if (i > 0) unotes.append(document.createElement('br'));
      const b = document.createElement('i');
      b.textContent = '·';
      unotes.append(b, document.createTextNode(ln));
    });
    umsg.textContent = '';
    uprog.classList.add('hidden');
    uyes.disabled = false;
    uyes.textContent = COPY.upd.now;
    closeAbout();
    um.classList.remove('hidden');
  }

  function messageFor(r: CheckResult): string {
    switch (r.kind) {
      case 'no-app': return COPY.upd.webNoUpdate;
      // 🔴 404 = 服务端还没发过版（deploy/latest_app.json 不存在）。
      //   这与"网络断了"是两回事，文案必须分开 —— 前者是正常状态，
      //   后者要重试。老项目把 403 说成"请求太频繁"，也没说清 404。
      case 'network': return r.status === 404 ? COPY.upd.noRelease : COPY.upd.fail;
      case 'bad-json': return COPY.upd.fail;
      // 🔴 服务端发了版但 Release 里没有 APK —— 这是**部署漏了**，
      //   不是"已是最新"。必须说清，否则用户永远等不到那个包。
      case 'no-apk': return COPY.upd.noApk;
      case 'latest': return COPY.upd.alreadyLatest;
      default: return COPY.upd.fail;
    }
  }

  return {
    el,
    open: async () => {
      el.classList.remove('hidden');
      if (deps.native.isNativeApp) {
        const v = await appVersionLine(deps.native, deps.webVersion);
        if (v) {
          const span = appRow.querySelector('span:last-child');
          if (span) span.textContent = v;
          appRow.classList.remove('hidden');
        }
        updRow.classList.remove('hidden');
      }
    },
    close: closeAbout,
    isOpen: () => !el.classList.contains('hidden'),
  };
}

function row(k: string, v: string): HTMLDivElement {
  const d = document.createElement('div');
  d.className = 'about-row';
  const kk = document.createElement('span');
  kk.className = 'about-k';
  kk.textContent = k;
  const vv = document.createElement('span');
  vv.className = 'about-v';
  vv.textContent = v;
  d.append(kk, vv);
  return d;
}
