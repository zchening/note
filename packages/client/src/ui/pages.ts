/**
 * 落地页 / 口令解锁页 / 首页提示页
 *
 * 三个页面互斥切换（老项目就是这么做的，不做路由库 —— 单页应用这三态用一个变量足够）。
 *
 * 🔴 两条复刻纪律：
 *   1. **文案不许在这里写字面量**，一律从 `copy.ts` 取。契约集中、测试好逐字比对。
 *   2. **颜色不许硬编码**，一律 var(--*)。改配色只改 ui/theme.ts。
 */

import { COPY } from './copy.ts';
import { LOGO, ICON_SCAN, ICON_TRUST_LOCK, ICON_TRUST_NOACCT, ICON_TRUST_SCAN } from './icons.ts';
import { isEggRoute, sanitizeNoteName } from './landing-logic.ts';

export type PageKind = 'landing' | 'pass' | 'home' | 'editor';

export interface LandingCallbacks {
  /** 用户点「打开」。name 已净化过。 */
  onOpen: (name: string, isEgg: boolean) => void;
  /** 点「扫码打开笔记」。 */
  onScan: () => void;
}

export function buildLanding(host: HTMLElement, cb: LandingCallbacks): void {
  host.innerHTML = `
<div class="landing" id="landing">
  <div class="landing-in">
    ${LOGO()}
    <h1>${COPY.brandName}</h1>
    <p class="sub">${COPY.landingSub}</p>
    <div class="lrow">
      <input id="li" type="text" inputmode="latin" autocomplete="off"
             placeholder="${COPY.landingPlaceholder}" maxlength="64"
             aria-label="${COPY.landingPlaceholder}">
      <button type="button" id="landingBtn" disabled>${COPY.landingBtnOpen}</button>
    </div>
    <div class="warn hidden" id="landingWarn">${COPY.landingWarn}</div>
    <div class="lurl" id="landingUrl"></div>
    <div class="legghint" id="landingEggTip"></div>
    <div class="lscan" id="landingScan" role="button" tabindex="0"
         aria-label="${COPY.landingScan}">${ICON_SCAN()}<span>${COPY.landingScan}</span></div>
    <!-- 🔴 扫码反馈专用位。必须与 #landingWarn 分开：
         landingWarn 归输入校验管（净化时亮），拿它显示"相机起不来"的话，
         用户下一次敲键盘就会被净化逻辑清掉 —— 症状是"错误信息闪一下就没了"。
         这个位只由 scanFeedback 写，且带「文案仍是它才清」守卫。 -->
    <div class="warn hidden" id="landingScanMsg"></div>
    <div class="trust" aria-hidden="true">
      <span>${ICON_TRUST_LOCK()}<span>${COPY.trustCipher}</span></span>
      <span>${ICON_TRUST_NOACCT()}<span>${COPY.trustNoAccount}</span></span>
      <span>${ICON_TRUST_SCAN()}<span>${COPY.trustScan}</span></span>
    </div>
  </div>
</div>`.trim();

  const input = host.querySelector<HTMLInputElement>('#li');
  const btn = host.querySelector<HTMLButtonElement>('#landingBtn');
  const warn = host.querySelector<HTMLElement>('#landingWarn');
  const url = host.querySelector<HTMLElement>('#landingUrl');
  const eggTip = host.querySelector<HTMLElement>('#landingEggTip');
  const scan = host.querySelector<HTMLElement>('#landingScan');
  if (!input || !btn || !warn || !url || !eggTip || !scan) {
    throw new Error('落地页结构不完整：buildLanding 与模板不同源');
  }

  const hostName = location.host;

  const refresh = (): void => {
    const raw = input.value;
    const name = sanitizeNoteName(raw);
    // 🔴 输入即净化：非法字符直接剔除（不是禁用提交）。老项目行为，
    //   粘贴带中文/空格的笔记名也能用。
    if (name !== raw) {
      input.value = name;
      warn.classList.remove('hidden');
    } else if (name !== '') {
      // 全部合法时收起警告（用户已经改对了，不该一直被红字盯着）
      warn.classList.add('hidden');
    }

    const isEgg = isEggRoute(name);
    btn.textContent = isEgg ? COPY.landingBtnEgg : COPY.landingBtnOpen;
    // 🔴 彩蛋门牌不禁用按钮（点了是去彩蛋，不是新建笔记）
    btn.disabled = !isEgg && name.trim().length === 0;

    eggTip.textContent = isEgg ? COPY.eggReservedTip(name) : '';
    url.textContent = name === '' ? '' : `${COPY.landingUrlPrefix}${hostName}/${name}`;
  };

  input.addEventListener('input', refresh);
  input.addEventListener('focus', () => host.querySelector('#landing')?.classList.add('trust-away'));
  input.addEventListener('blur', () => host.querySelector('#landing')?.classList.remove('trust-away'));

  const submit = (): void => {
    if (btn.disabled) return;
    cb.onOpen(input.value, isEggRoute(input.value));
  };
  btn.addEventListener('click', submit);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') submit();
  });

  const scanGo = (): void => cb.onScan();
  scan.addEventListener('click', scanGo);
  scan.addEventListener('keydown', (e) => {
    // 🔴 role=button 的元素必须自己处理 Enter/Space，否则键盘用户用不了
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      scanGo();
    }
  });

  refresh();
  // 落地页是首屏，自动聚焦（老项目也这样，进来就能打字）
  input.focus();
}

export interface PassCallbacks {
  onSubmit: (pass: string) => Promise<string | null>;
  /** 关闭口令页回到落地页。 */
  onClose: () => void;
}

export function buildPass(host: HTMLElement, cb: PassCallbacks): void {
  host.innerHTML = `
<div class="mask" id="mask">
  <div class="box">
    <div class="modal-head">
      <h1>${COPY.passTitle}</h1>
      <button type="button" id="maskClose" class="box-x" title="${COPY.passCloseTitle}"
              aria-label="${COPY.passCloseTitle}"></button>
    </div>
    <p class="hint">${COPY.passHint}</p>
    <input id="pw" type="password" autocomplete="off" aria-label="${COPY.passTitle}">
    <div class="err" id="err" role="alert" aria-live="polite"></div>
    <button type="button" id="ok" disabled>${COPY.passBtn}</button>
  </div>
</div>`.trim();

  const pw = host.querySelector<HTMLInputElement>('#pw');
  const ok = host.querySelector<HTMLButtonElement>('#ok');
  const err = host.querySelector<HTMLElement>('#err');
  const close = host.querySelector<HTMLButtonElement>('#maskClose');
  if (!pw || !ok || !err || !close) throw new Error('口令页结构不完整');

  // 关闭键用同一个 X 图标（内联注入，避免 import 循环）
  close.innerHTML =
    '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" ' +
    'stroke-width="1.6" stroke-linecap="round" aria-hidden="true"><path d="M6.5 6.5l11 11M17.5 6.5l-11 11"/></svg>';

  let busy = false;
  const refresh = (): void => {
    ok.disabled = busy || pw.value.length === 0;
  };
  pw.addEventListener('input', () => {
    err.textContent = '';
    refresh();
  });
  close.addEventListener('click', () => cb.onClose());

  const submit = async (): Promise<void> => {
    if (ok.disabled || busy) return;
    busy = true;
    refresh();
    err.textContent = '';
    try {
      const error = await cb.onSubmit(pw.value);
      if (error) {
        // 🔴 口令错与数据坏**必须同一句话**（ARCH 安全不变量）：
        //   区分开等于给暴力破解一个 oracle。
        err.textContent = error;
        pw.select();
      }
    } finally {
      busy = false;
      refresh();
    }
  };
  ok.addEventListener('click', () => void submit());
  pw.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') void submit();
  });

  refresh();
  pw.focus();
}

export function buildHome(host: HTMLElement): void {
  const domain = location.host;
  host.innerHTML = `
<div class="home" id="home">
  <h1>${COPY.homeTitle}</h1>
  <p>${COPY.homeHintLead}<br><code><span class="dyn-domain">${domain}</span>/biji</code></p>
</div>`.trim();
}
