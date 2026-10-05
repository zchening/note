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
import type { LatestRelease } from './ota.ts';
import type { CheckResult, NativeDeps, ProgressFn } from './ota-native.ts';
import { appVersionLine, checkUpdate, runUpdate } from './ota-native.ts';

export interface AboutDeps {
  native: NativeDeps;
  /** 网页版版本（构建期注入的 APP_VERSION） */
  webVersion: string;
}

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
  const el = document.createElement('div');
  el.className = 'mask hidden';
  el.id = 'aboutMask';

  const box = document.createElement('div');
  box.className = 'box';

  const head = document.createElement('div');
  head.className = 'modal-head';
  const h1 = document.createElement('h1');
  h1.textContent = COPY.aboutTitle;
  const x = document.createElement('button');
  x.className = 'box-x';
  x.type = 'button';
  x.title = COPY.close;
  x.setAttribute('aria-label', COPY.close);
  x.textContent = '×';
  head.append(h1, x);

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
  body.append(row(COPY.aboutAuthor, COPY.aboutAuthorName));

  // 检查更新（仅壳内）
  const updRow = row(COPY.aboutUpdate, '');
  updRow.id = 'aboutUpdRow';
  updRow.classList.add('hidden');
  const updBtn = document.createElement('span');
  updBtn.id = 'aboutUpd';
  updBtn.className = 'upd-link';
  updBtn.setAttribute('role', 'button');
  updBtn.tabIndex = 0;
  updBtn.textContent = COPY.upd.checkBtn;
  updRow.lastChild!.replaceWith(updBtn);
  body.append(updRow);

  box.append(head, body);
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
      // 🔴 total 为 0 时不显示百分比：显示 "0%" 再跳 100% 比不显示更让人以为卡住。
      const pct = t > 0 ? Math.min(100, Math.round((d / t) * 100)) : 0;
      ufill.style.width = pct + '%';
      umsg.textContent = COPY.upd.downloading(pct);
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
