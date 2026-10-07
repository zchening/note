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
import { LOGO, ICON_SCAN, ICON_TRUST_LOCK, ICON_TRUST_NOACCT, ICON_TRUST_SCAN, ICON_X } from './icons.ts';
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
    <p class="lurl hidden" id="landingUrl">${COPY.landingUrlPrefix}&nbsp;<span class="lurl-host"></span>/<span id="landingUrlName" class="u-name"></span></p>
    <p class="legghint hidden" id="landingEggTip"></p>
    <div class="lscan-row">
      <div class="lscan" id="landingScan" role="button" tabindex="0"
           aria-label="${COPY.landingScan}">${ICON_SCAN()}<span>${COPY.landingScan}</span></div>
    </div>
    <!-- 🔴 扫码反馈专用位。必须与 #landingWarn 分开：
         landingWarn 归输入校验管（净化时亮），拿它显示"相机起不来"的话，
         用户下一次敲键盘就会被净化逻辑清掉 —— 症状是"错误信息闪一下就没了"。
         这个位只由 scanFeedback 写，且带「文案仍是它才清」守卫。
         🔴 它在 DOM 里排在 .lscan-row **之后**，而入场动画是按子节点序号步进的
            （老项目 nth-child 步进）—— 放在最后一位，步进序号才与老项目一致。 -->
    <div class="warn hidden" id="landingScanMsg"></div>
    <div class="trust" aria-hidden="true">
      <span>${ICON_TRUST_LOCK()}${COPY.trustCipher}</span>
      <span>${ICON_TRUST_NOACCT()}${COPY.trustNoAccount}</span>
      <span>${ICON_TRUST_SCAN()}${COPY.trustScan}</span>
    </div>
  </div>
</div>`.trim();

  const input = host.querySelector<HTMLInputElement>('#li');
  const btn = host.querySelector<HTMLButtonElement>('#landingBtn');
  const warn = host.querySelector<HTMLElement>('#landingWarn');
  const url = host.querySelector<HTMLElement>('#landingUrl');
  const urlName = host.querySelector<HTMLElement>('#landingUrlName');
  const urlHost = host.querySelector<HTMLElement>('#landingUrl .lurl-host');
  const eggTip = host.querySelector<HTMLElement>('#landingEggTip');
  const scan = host.querySelector<HTMLElement>('#landingScan');
  if (!input || !btn || !warn || !url || !urlName || !urlHost || !eggTip || !scan) {
    throw new Error('落地页结构不完整：buildLanding 与模板不同源');
  }

  // 🔴 老项目 index.html:3289 那个 IIFE 用 **hostname**（不含端口），
  //   网址预览行显示的是用户要抄到别处的地址，带端口是噪声。
  urlHost.textContent = location.hostname;

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

    // 🔴🔴 彩蛋提示行照老项目 index.html:10187-10192 的做法**用 DOM API 拼装**：
    //   门牌名进 <b>（金黄 600），后半句说明是裸文字（muted）。
    //   此前是 `eggTip.textContent = ...` 整行同一颜色 —— 老项目整行是灰的，
    //   只有门牌名金黄（`.eggtip b{color:var(--accent);font-weight:600}`）。
    //   走 DOM API 而非 innerHTML：门牌名来自用户输入，不拼字符串进 HTML。
    eggTip.textContent = '';
    eggTip.classList.toggle('hidden', !isEgg);
    if (isEgg) {
      const b = document.createElement('b');
      b.textContent = `/${name}`;
      eggTip.appendChild(b);
      eggTip.appendChild(document.createTextNode(COPY.eggReservedTipSuffix));
    }

    // 🔴 网址预览行：老项目 index.html:10177-10181 `syncUrlHint()`
    //   「非空且非彩蛋才显行，空值/彩蛋整行隐身」——
    //   彩蛋门牌不是网址，显示出来是错的（老项目也这么判）。
    //   结构必须是「前缀 + 域名 + / + <b>笔记名</b>」四段，
    //   笔记名那一段是金黄 span（老项目 .urlline .u-name）。
    urlName.textContent = name;
    url.classList.toggle('hidden', name === '' || isEgg);
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
  // 🔴🔴 **不要** input.focus()。
  //   老项目 index.html 全文 39 处 `.focus()` 无一处是落地页输入框（`li` 只被 getElementById 取用）。
  //   此前这里有一句 `input.focus()`，注释还写"老项目也这样" —— 那句注释是错的，后果有两条：
  //     ① 一进来就触发 focus 事件 → #landing 挂 `.trust-away` → .trust opacity:0
  //        ⇒ "服务器只见密文/无需账号/扫码跨设备"三行**永久不可见**（用户报障第 6 条原话）；
  //     ② 移动端一进落地页就弹软键盘。
  //   老项目把淡出做成"聚焦时"的行为，语义是"给软键盘让位"，
  //   不是"一进来就让位"—— 自动聚焦把这个前提整个抹掉了。
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
              aria-label="${COPY.passCloseTitle}">${ICON_X()}</button>
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

/**
 * 修改口令弹窗（老项目 index.html:780-793 `#cpMask`）
 *
 * 🔴🔴 两阶段是**老项目的形态**，不是我们加的流程：
 *   阶段 0 只问「当前口令」（`下一步`）——先用旧口令解开密文自证身份；
 *   阶段 1 才展开「新口令 / 再次输入」（`确 定`）。
 *   一次弹窗里同时摆三个框，用户分不清先后，而"先用旧口令自证"这条
 *   恰恰是改口令唯一的安全前提（否则任何人点一下菜单就能把别人的笔记改了口令）。
 *
 * 🔴 结构上刻意**不带右上角 ×**：老项目 `#cpMask` 只有「下一步 / 确定」+「取消」，
 *   没有关闭钮（改口令是破坏性操作，退出路径只有明确的「取消」）。
 */
export interface ChangePassCallbacks {
  /** 验证旧口令：返回 null 通过，返回文案即错误（显示在 .err 里）。 */
  onVerifyOld: (oldPass: string) => Promise<string | null>;
  /** 提交新口令（已保证非空且两次一致）：返回 null 成功。 */
  onSubmitNew: (newPass: string) => Promise<string | null>;
  /** 取消 / 成功之后的收场。 */
  onClose: () => void;
}

export function buildChangePass(host: HTMLElement, cb: ChangePassCallbacks): void {
  host.insertAdjacentHTML(
    'beforeend',
    `<div class="mask" id="cpMask">
  <div class="box" id="cpBox">
    <h1>${COPY.cpTitle}</h1>
    <p>${COPY.cpHintHtml}</p>
    <input id="cpOld" type="password" placeholder="${COPY.cpOldPh}" autocomplete="off">
    <input id="cpNew" type="password" placeholder="${COPY.cpNewPh}" autocomplete="off" class="hidden">
    <input id="cpNew2" type="password" placeholder="${COPY.cpNew2Ph}" autocomplete="off" class="hidden">
    <div class="err" id="cpErr" role="alert" aria-live="polite"></div>
    <button type="button" id="cpOk" disabled>${COPY.cpNext}</button>
    <button type="button" id="cpCancel" class="ghost-btn">${COPY.cpCancel}</button>
  </div>
</div>`,
  );

  const mask = host.querySelector<HTMLElement>('#cpMask');
  const oldIn = host.querySelector<HTMLInputElement>('#cpOld');
  const newIn = host.querySelector<HTMLInputElement>('#cpNew');
  const new2In = host.querySelector<HTMLInputElement>('#cpNew2');
  const err = host.querySelector<HTMLElement>('#cpErr');
  const ok = host.querySelector<HTMLButtonElement>('#cpOk');
  const cancel = host.querySelector<HTMLButtonElement>('#cpCancel');
  if (!mask || !oldIn || !newIn || !new2In || !err || !ok || !cancel) {
    throw new Error('修改口令弹窗结构不完整');
  }

  /** 0 = 验证旧口令；1 = 设置新口令（老项目 `cpStage`）。 */
  let stage: 0 | 1 = 0;
  let busy = false;

  const close = (): void => {
    mask.remove();
    cb.onClose();
  };

  const refresh = (): void => {
    // 🔴 禁用判据逐字抄老项目 `cpOk.disabled = !cpOld.value` / `cpNewGuard()`
    //   （:8288-8291）：**只看非空**，不设最短长度（老项目 v6.1 取消位数要求）。
    ok.disabled = busy || (stage === 0 ? oldIn.value.length === 0 : !(newIn.value && new2In.value));
  };

  const toStage1 = (): void => {
    stage = 1;
    oldIn.classList.add('hidden');
    newIn.classList.remove('hidden');
    new2In.classList.remove('hidden');
    err.textContent = '';
    ok.textContent = COPY.cpDone;
    refresh();
    newIn.focus();
  };

  const submit = async (): Promise<void> => {
    if (ok.disabled || busy) return;
    err.textContent = '';
    if (stage === 0) {
      busy = true;
      ok.disabled = true;
      err.textContent = COPY.cpVerifying;
      try {
        const message = await cb.onVerifyOld(oldIn.value);
        if (message) {
          err.textContent = message;
          oldIn.select();
          return;
        }
        toStage1();
      } finally {
        busy = false;
        refresh();
      }
      return;
    }
    // 🔴 两条本地校验在**弹窗内**做（老项目 cpRotate 开头同款 :8311-8312），
    //   不进 onSubmitNew：它们是输入错误，不是网络/密钥错误，
    //   交给调用方会让"网络失败"与"两次不一致"混成一句。
    if (newIn.value.length === 0) {
      err.textContent = COPY.cpEmpty;
      return;
    }
    if (newIn.value !== new2In.value) {
      err.textContent = COPY.cpMismatch;
      new2In.select();
      return;
    }
    busy = true;
    ok.disabled = true;
    err.textContent = COPY.cpRotating;
    const message = await cb.onSubmitNew(newIn.value);
    busy = false;
    refresh();
    if (message) {
      err.textContent = message;
      return;
    }
    close();
  };

  oldIn.addEventListener('input', () => {
    if (stage === 0 && err.textContent === COPY.cpVerifying) err.textContent = '';
    refresh();
  });
  newIn.addEventListener('input', refresh);
  new2In.addEventListener('input', refresh);
  ok.addEventListener('click', () => void submit());
  cancel.addEventListener('click', close);
  for (const el of [oldIn, newIn, new2In]) {
    el.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') void submit();
    });
  }

  refresh();
  // 老项目 index.html:8279-8280 `try { cpOld.focus(); } catch (e) {}`
  //   —— 打开修改口令弹窗必须聚焦「当前口令」框（用户报障第 9 条）。
  oldIn.focus();
}

export function buildHome(host: HTMLElement): void {
  const domain = location.host;
  host.innerHTML = `
<div class="home" id="home">
  <h1>${COPY.homeTitle}</h1>
  <p>${COPY.homeHintLead}<br><code><span class="dyn-domain">${domain}</span>/biji</code></p>
</div>`.trim();
}
