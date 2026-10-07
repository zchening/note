/**
 * 换机浮层 —— 老项目 `#bakMask`（index.html:795-812）的形态复刻
 *
 * ═══════════════════════════════════════════════════════════════════════
 * 🔴 核实结论：**老项目的「扫码换机」是弹层（mask 遮罩），不是独立页面。**
 * ═══════════════════════════════════════════════════════════════════════
 * 依据（老项目 index.html，只读）：
 *   - 795 行：`<div class="mask hidden" id="bakMask">` —— `.mask` 是遮罩类，
 *     同文件里 about/upd/egg 全部弹层都用它，没有一条是独立路由。
 *   - 9113 行：`$('#menuBackup').addEventListener('click', async () => {`
 *     处理器里第一句就是 `menuMask.classList.add('hidden')`（收起菜单），
 *     紧接着 `bakMask` 两态切换 —— **全程没有任何 location 赋值**。
 *   - 老项目全文 grep 不到 `/backup` 路由；菜单项不跳地址。
 *
 * 所以本项目的 `onBackup` 也**不跳 `/backup`**：
 * 跳过去会落进 SPA 回落 → 命中 egg/registry.ts:88 的保留字 `backup`
 * → 停在首页提示页（正是本次要修的死链形状）。
 * 走遮罩与老项目一致，也让 `backup` 保留字可以**留在原地**
 * （egg-registry.test.mjs:72 正钉着它，动了会红）。
 *
 * ── 形态照抄老项目的三处 ─────────────────────────────────────────────────
 *  1. **两态**：stage1 要口令 → stage2 出码（老项目 bakShowStage(1|2)）
 *  2. **出码成功即抹掉口令框**（老项目 index.html:9192 `bakPass.value = ''`）
 *  3. **点码全屏放大**（复用 scan/qr-draw.ts 的 largeTargetPx，与配对码同一套）
 *
 * ── 两种码，共用这一个浮层 ─────────────────────────────────────────────
 * 🔴🔴 **本项目有两张换机码，形态刻意做成同款浮层**（老项目只有一张）：
 *   ① 单篇换机码 `nsbak1:` —— 打包**当前这一篇**正文。**老项目没有这个功能**，
 *      是本项目的额外能力（旧版 bj 的「扫码换机」错误地只打包了当前这一篇）。
 *   ② 收藏备份码 `nsfav1:` —— 打包**收藏夹全部**（老项目 v10.1.7 定稿的唯一口径，
 *      index.html:8997-8998 逐字：「备份范围（v10.1.7 定稿）：**只备份收藏夹**，
 *      没有例外、也没有开关。」）。
 *   ⇒ 菜单「扫码换机」现在走**②**（与老项目一致），①保留为"旧码仍能解"的兼容读。
 *   实现见 migrate/fav-backup.ts（含"为什么不装密钥"的架构性分叉论证）。
 *
 * ── 一处**不承接**的老项目行为 ───────────────────────────────────────────
 * 🔴🔴 2026-10-08 起**已承接**：老项目把清单加密后写进**云端一篇专用笔记**，
 *   二维码只装那篇的链接（甲案，用户报障第 2 条拍板「复刻老项目甲案」）。
 *   判「码密度与篇数解耦」的那个承诺由 migrate/bak-note.ts 承担，
 *   本面板只多了**一行「备份笔记：nsbak-xxxxxx」**（老项目 #bakBakId，
 *   与 #bakTip 是两个独立 `p.qr-warn`，见 outIdLine）。
 *   本项目仍然保留**单篇码 `nsbak1:` 与收藏清单码 `nsfav1:` 的读**（旧码仍能恢复）。
 */

import { COPY } from '../ui/copy.ts';
import { drawQr, largeTargetPx, loadQrcode, type QrcodeApi } from '../scan/qr-draw.ts';

export type MigrateMode = 'make' | 'take';

export interface MigratePanelDeps {
  mode: MigrateMode;
  /**
   * 备份侧：生成码。返回码或失败原因。
   * 🔴 口令由**面板**收，由**这个回调**消费；面板不持有口令，
   *   码生成完立刻清空输入框（老项目同款纪律）。
   */
  onMake?: (passphrase: string) => Promise<{ ok: true; code: string } | { ok: false; reason: string }>;
  /**
   * 🔴🔴 免口令直出码：本机**当前会话已持有口令**时传进来（老项目 `preKey` 同名机制）。
   *
   * 老项目 index.html `bakShowStage(1)`：
   *   if (preKey) { await doBakGenerate(preKey); return; }   ← 有 preKey 直接出码
   *   else { bakShowStage(1); }                              ← 否则才要口令框
   * 而 bj 此前**没有 preKey**，于是"本机明明刚解锁过，点扫码换机还要再输一次口令"
   *（用户报障第 4 条：体验与老项目不一致）。
   *
   * 为什么 bj 需要显式传：本项目的口令在 `main.ts` 的 `sessionPass` 里，
   * 面板不持有它（见onMake 注释的纪律），所以由调用方把"这次会话的口令"传进来。
   * 为 null 时行为与老项目一致（要口令框）。
   */
  preKey?: string | null;
  /**
   * 备份侧的入口引导句（HTML）。不传则用 `COPY.migrateMakeLeadHtml`（旧路线那句）。
   *
   * 🔴 为什么要开这个口而不是直接改 `migrateMakeLeadHtml`：
   *   旧收藏清单码 `nsfav1:` 仍然可解（历史码不能作废），它那条路要展示的
   *   是"清单就在码里"；甲案那句说的是"清单写进了备份笔记"。两句话**互斥**，
   *   合成一句只会两边都不成立。
   */
  makeLeadHtml?: string;
  /**
   * 恢复侧：拿码 + 口令去恢复。
   *
   * 🔴 `reason` 在 `ok:true` 时是**成功文案**（老项目 :9270 口径逐字，
   *   「已恢复 N 篇收藏（覆盖 N 篇旧密钥）」），`ok:false` 时才是失败原因。
   *   两态共用一个字段是有意的：面板只要把文案丢进同一个 .ns-qr-warn 里，
   *   成功/失败的**呈现位置**就永远一致 —— 分成两个字段就会出现
   *   "成功时那句在 A 处、失败时那句在 B 处"，样式迟早会分叉。
   */
  onTake?: (
    code: string,
    passphrase: string,
  ) => Promise<{ ok: true; reason?: string } | { ok: false; reason: string }>;
  /** 生成前的预判（文档太长等），返回非空即拒绝生成。 */
  precheck?: () => string | null;
  /**
   * 🔴 出码后的提示文案。**整句**（含篇数与那两个括号分支）。
   *
   * 🔴 为什么不让面板自己算：老项目 :9187-9190 那句里有「一键恢复 N 篇」+ skipped 括号，
   *   而 N 与 skipped 都只在**生成那一瞬间**、在调用方手里算得出来（收藏夹随时会变）。
   *   面板拿到的只有码字符串，它硬算就必然要么恒 0、要么与码里的真实清单不符 ——
   *   后者更糟：屏幕上报"一键恢复 6 篇"，扫回来是3 篇。
   *
   * 🔴🔴 传**函数**而不是字符串：篇数要等 `onMake` 跑完（解完密、拿到 ids）才知道，
   *   而 `buildMigratePanel` 的实参早于那一刻求值。传字符串就只能是提前算好的死值 ——
   *   用户在面板开着的时候改一下收藏夹，屏上那句就跟码里的清单对不上了。
   *   不传则退回通用提示（单篇换机走那条）。
   */
  scanTip?: (code: string) => string;
  /**
   * 出码后码上方那行「备份笔记：nsbak-xxxxxx」（老项目 #bakBakId）。
   *
   * 🔴 与 `scanTip` 同款理由传**函数**：备份篇名是 `onMake` 里才生成的，
   *   `buildMigratePanel` 的实参早于那一刻求值 ⇒ 传字符串只能是空值或预估值。
   * 🔴 不传则该行保持隐藏（单篇码 `nsbak1:` / 收藏清单码 `nsfav1:` 两条路都没有它）。
   */
  scanIdLine?: (code: string) => string;
  /** 关闭后归还焦点（老项目红线：关弹窗必须让光标回到编辑器）。 */
  onClosed: () => void;
  /** 恢复成功后要跳的提示文案（由调用方决定，因为要带上篇名）。 */
  onRestored?: () => void;
}

export interface MigratePanel {
  el: HTMLElement;
  close: () => void;
}

function isOpen(): boolean {
  return document.getElementById('migrateMask') !== null;
}

/** 关掉可能存在的另一层（老项目没这一步，连点两下会叠两层遮罩）。 */
export function closeMigratePanel(): void {
  const el = document.getElementById('migrateMask');
  if (el && el.parentNode) el.parentNode.removeChild(el);
  document.getElementById('migrateLarge')?.classList.remove('show');
}

/** 屏幕常亮（出码期间息屏 = 白扫）。与 scan/panel.ts 同一范式。 */
interface HeldLock {
  released: boolean;
  release: () => Promise<void>;
}
let wakeLock: HeldLock | null = null;

async function acquireWakeLock(): Promise<void> {
  try {
    if (!('wakeLock' in navigator) || !navigator.wakeLock?.request) return;
    if (wakeLock && !wakeLock.released) return;
    const s = await navigator.wakeLock.request('screen');
    if (!isOpen() || document.hidden) {
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
    /* 特性不支持 / 被拒：静默跳过 */
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

/** 全屏放大层（与配对码共用一套几何，见 scan/panel.ts 的 showLarge）。 */
function showLarge(text: string): void {
  let el = document.getElementById('migrateLarge');
  if (!el) {
    el = document.createElement('div');
    el.id = 'migrateLarge';
    el.addEventListener('click', () => el?.classList.remove('show'));
    document.body.appendChild(el);
  }
  el.innerHTML = '';
  const cv = document.createElement('canvas');
  cv.id = 'migrateQrLarge';
  const wantPx = largeTargetPx(
    Math.min(window.innerWidth, window.innerHeight),
    window.devicePixelRatio || 2,
  );
  try {
    drawQr(cv, text, { qrcode: window.qrcode as QrcodeApi, wantPx });
  } catch {
    return;
  }
  el.appendChild(cv);
  el.classList.add('show');
}

function err(host: HTMLElement, text: string): void {
  host.textContent = text;
  host.classList.toggle('hidden', text === '');
}

function hint(host: HTMLElement, text: string): void {
  host.textContent = text;
}

export function buildMigratePanel(deps: MigratePanelDeps): MigratePanel {
  closeMigratePanel();

  const making = deps.mode === 'make';

  const mask = document.createElement('div');
  mask.className = 'mask';
  mask.id = 'migrateMask';

  const box = document.createElement('div');
  box.className = 'box qr-box';

  const title = document.createElement('h1');
  title.className = 'qr-title';
  title.textContent = COPY.migrateTitle;

  const lead = document.createElement('p');
  lead.className = 'hint';
  // 🔴 老项目 index.html:801 原文含 `<b>备份笔记</b>` 与 `<br>`：
  //   「换机备份要用口令为专用的<b>备份笔记</b>派生密钥：<br>收藏夹里笔记的密钥都写进它，扫一扫整体带走。」
  //   这段是**本项目自产的常量**（不是用户输入），所以 innerHTML 安全；
  //   而纯文本版migrateMakeLead 会把「备份笔记」四字连同标签一起显示出来。
  // 🔴 甲案那一版（migrateBakLeadHtml）与这句只差「密钥」→「篇名」：
  //   老项目的清单里装的是**密钥**，bj 的清单里**没有密钥**（CryptoKey 是
  //   extractable:false，WebCrypto 层面导不出 raw 字节，见 migrate/fav-backup.ts 文件头）。
  //   照抄「密钥都写进它」就是谎报，用户会以为码里带着钥匙。
  if (making) {
    lead.innerHTML = deps.makeLeadHtml ?? COPY.migrateMakeLeadHtml;
  } else {
    lead.textContent = COPY.migrateTakeLead;
  }

  const errBox = document.createElement('div');
  errBox.className = 'err';
  errBox.id = 'migrateErr';

  /* ── 备份侧输入 ── */
  const passWrap = document.createElement('div');
  passWrap.id = 'migratePassWrap';
  const pass = document.createElement('input');
  pass.type = 'password';
  pass.id = 'migratePass';
  pass.placeholder = COPY.migratePassPh;
  pass.autocomplete = 'off';
  passWrap.appendChild(pass);

  /* ── 恢复侧输入 ── */
  const codeWrap = document.createElement('div');
  codeWrap.id = 'migrateCodeWrap';
  // 🔴 只在**备份侧**才隐藏：恢复侧它就是主输入口，藏起来用户什么都填不了。
  //   （这行一开始无条件加 hidden，恢复面板就成了"只有口令框、没有码框"的残废形态。
  //   QR-M08 就是它的回归闸。）
  if (making) codeWrap.classList.add('hidden');
  const codeIn = document.createElement('textarea');
  codeIn.id = 'migrateCodeIn';
  codeIn.rows = 3;
  codeIn.placeholder = COPY.migrateCodePh;
  codeIn.autocomplete = 'off';
  codeIn.spellcheck = false;
  codeWrap.appendChild(codeIn);

  const go = document.createElement('button');
  go.id = 'migrateGo';
  go.textContent = making ? COPY.migrateMakeGo : COPY.migrateTakeGo;

  const cancel = document.createElement('button');
  cancel.id = 'migrateCancel';
  cancel.className = 'ghost-btn';
  cancel.textContent = COPY.migrateCancel;

  /* ── 出码区 ── */
  const outWrap = document.createElement('div');
  outWrap.id = 'migrateOutWrap';
  outWrap.classList.add('hidden');
  const holder = document.createElement('div');
  holder.id = 'migrateQrHolder';
  // 🔴 老项目 index.html:805 是**两个独立**的 `p.qr-warn`：
  //     `<p class="qr-warn" id="bakBakId"></p>`（备份笔记名）
  //     `<p class="qr-warn" id="bakTip"></p>`   （扫码指引）
  //   合成一句会让用户找不到"我那篇备份笔记叫什么"—— 而那正是换机时要手输/对号的
  //   唯一标识。默认隐藏（单篇码/收藏码路径没有它），由调用方给出时才出现。
  const idLine = document.createElement('p');
  idLine.className = 'ns-qr-warn';
  idLine.id = 'migrateBakId';
  idLine.classList.add('hidden');
  const tip = document.createElement('p');
  tip.className = 'ns-qr-warn';
  tip.id = 'migrateTip';
  outWrap.append(holder, idLine, tip);

  /* ── 成功区 ── */
  const doneWrap = document.createElement('div');
  doneWrap.id = 'migrateDoneWrap';
  doneWrap.classList.add('hidden');
  const doneMsg = document.createElement('p');
  doneMsg.className = 'ns-qr-warn';
  doneMsg.id = 'migrateDoneMsg';
  const doneClose = document.createElement('button');
  doneClose.id = 'migrateDoneClose';
  doneClose.textContent = COPY.migrateDoneClose;
  doneWrap.append(doneMsg, doneClose);

  if (making) {
    box.append(title, lead, passWrap, errBox, go, cancel, outWrap);
  } else {
    box.append(title, lead, codeWrap, passWrap, errBox, go, cancel, doneWrap);
  }
  mask.appendChild(box);
  document.body.appendChild(mask);

  const showInput = (): void => {
    outWrap.classList.add('hidden');
    doneWrap.classList.add('hidden');
    passWrap.classList.remove('hidden');
    go.classList.remove('hidden');
    cancel.classList.remove('hidden');
  };

  const teardown = (): void => {
    document.removeEventListener('keydown', onKey, true);
    document.removeEventListener('visibilitychange', onVis);
    releaseWakeLock();
    document.getElementById('migrateLarge')?.classList.remove('show');
    if (mask.parentNode) mask.parentNode.removeChild(mask);
    // 🔴 口令绝不残留在 DOM 里（同老项目 bakClose 的 bakPass.value = ''）。
    try {
      pass.value = '';
      codeIn.value = '';
    } catch {
      /* ignore */
    }
    deps.onClosed();
  };

  const onKey = (e: KeyboardEvent): void => {
    if (e.key === 'Escape') teardown();
  };
  document.addEventListener('keydown', onKey, true);

  const onVis = (): void => {
    if (document.visibilityState === 'visible') {
      if (isOpen()) void acquireWakeLock();
    } else {
      releaseWakeLock();
    }
  };
  document.addEventListener('visibilitychange', onVis);

  go.addEventListener('click', () => void run());
  cancel.addEventListener('click', teardown);
  doneClose.addEventListener('click', teardown);
  mask.addEventListener('click', (e) => {
    if (e.target === mask) teardown();
  });
  holder.addEventListener('click', (e) => {
    const t = e.target as HTMLElement | null;
    if (!t || t.tagName !== 'CANVAS') return;
    const code = holder.dataset.code;
    if (code) showLarge(code);
  });

  const onEnter = (e: KeyboardEvent): void => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      void run();
    }
  };
  pass.addEventListener('keydown', onEnter);
  codeIn.addEventListener('keydown', onEnter);

  async function renderCode(code: string): Promise<void> {
    if (!(await loadQrcode())) {
      err(errBox, COPY.migrateRenderFail);
      showInput();
      return;
    }
    const cv = document.createElement('canvas');
    cv.id = 'migrateQr';
    try {
      drawQr(cv, code, { qrcode: window.qrcode as QrcodeApi });
    } catch {
      // 🔴 出码失败必须回到能看见输入框的那一态（老项目 v10.1.7 闸第一轮 R1/R2/R3 同款）：
      //   停在"出码区"而那里没有输入框，用户就彻底卡死了。
      err(errBox, COPY.migrateRenderFail);
      showInput();
      return;
    }
    holder.innerHTML = '';
    holder.dataset.code = code;
    holder.appendChild(cv);
    passWrap.classList.add('hidden');
    errBox.classList.add('hidden');
    go.classList.add('hidden');
    cancel.classList.add('hidden');
    outWrap.classList.remove('hidden');
    // 🔴 优先用调用方给的整句（老项目 :9187 口径，带"一键恢复 N 篇"）；
    //   没有就给通用那句（单篇换机）。见 MigratePanelDeps.scanTip 的注释。
    //   scanTip 传的是函数：篇数要等 onMake 跑完才知道（见该字段注释）。
    hint(tip, (deps.scanTip && deps.scanTip(code)) || COPY.migrateScanTip);
    // 🔴 甲案那一行（老项目 :9186 `bakIdLine.textContent = '备份笔记：' + res.id`）。
    //   只在调用方给了 scanIdLine 时出现；没给就保持隐藏，别给单篇/收藏码留一行空的。
    const idText = deps.scanIdLine ? deps.scanIdLine(code) : '';
    if (idText) {
      idLine.textContent = idText;
      idLine.classList.remove('hidden');
    } else {
      idLine.textContent = '';
      idLine.classList.add('hidden');
    }
    void acquireWakeLock();
  }

  async function run(): Promise<void> {
    err(errBox, '');
    const typed = pass.value;

    if (making) {
      // 🔴 预判放在最前面：超长就别白跑 600,000 次 PBKDF2。
      const pre = deps.precheck?.() ?? null;
      if (pre) {
        err(errBox, pre);
        return;
      }
      if (typed === '') {
        err(errBox, COPY.migrateNeedPass);
        return;
      }
      if (!deps.onMake) return;
      go.disabled = true;
      go.textContent = COPY.migrateWorking;
      try {
        const r = await deps.onMake(typed);
        // 🔴 出码成功即抹掉口令（老项目 index.html:9192）。
        try {
          pass.value = '';
        } catch {
          /* ignore */
        }
        if (!r.ok) {
          err(errBox, r.reason);
          showInput();
          return;
        }
        await renderCode(r.code);
      } finally {
        go.disabled = false;
        go.textContent = COPY.migrateMakeGo;
      }
      return;
    }

    /* 恢复侧 */
    const code = codeIn.value.trim();
    if (code === '') {
      err(errBox, COPY.migrateNeedCode);
      return;
    }
    if (typed === '') {
      err(errBox, COPY.migrateNeedPass);
      return;
    }
    if (!deps.onTake) return;
    go.disabled = true;
    go.textContent = COPY.migrateWorking;
    try {
      const r = await deps.onTake(code, typed);
      try {
        pass.value = '';
        codeIn.value = '';
      } catch {
        /* ignore */
      }
      if (!r.ok) {
        // 🔴 失败必须留在能看见的输入态，且**不写任何东西**
        //   （"恢复失败但笔记被清空"比直接报错糟糕得多）。
        err(errBox, r.reason);
        showInput();
        return;
      }
      passWrap.classList.add('hidden');
      codeWrap.classList.add('hidden');
      errBox.classList.add('hidden');
      go.classList.add('hidden');
      cancel.classList.add('hidden');
      outWrap.classList.add('hidden');
      doneWrap.classList.remove('hidden');
      // 🔴 成功文案优先用调用方给的（老项目 :9270 的「已恢复 N 篇收藏…」逐字）；
      //   没有就退回通用那句「已恢复，可以继续编辑了」——单篇换机走的就是后者。
      hint(doneMsg, r.reason || COPY.migrateDoneMsg);
      deps.onRestored?.();
    } finally {
      go.disabled = false;
      go.textContent = COPY.migrateTakeGo;
    }
  }

  void acquireWakeLock();
  // 🔴🔴 免口令直出码（老项目 `if (preKey) { await doBakGenerate(preKey); return; }` 同款）。
  //   本机当前会话已持有口令时，**直接出码**，不再弹口令框——
  //   否则用户明明刚解锁过，点「扫码换机」还要再输一次口令（体验与老项目不一致）。
  //   preKey 为空（本次是「记忆解锁」进来的、sessionPass 为空）时行为不变，仍要口令框。
  if (making && deps.preKey && deps.onMake) {
    const pre0 = deps.precheck?.() ?? null;
    if (pre0) {
      err(errBox, pre0);
    } else {
      passWrap.classList.add('hidden');
      doneWrap.classList.add('hidden');
      outWrap.classList.remove('hidden');
      go.disabled = true;
      go.textContent = COPY.migrateWorking;
      const mk = deps.onMake;
      void (async () => {
        try {
          const r = await mk(deps.preKey as string);
          if (!r.ok) {
            err(errBox, r.reason);
            showInput();
            return;
          }
          await renderCode(r.code);
        } finally {
          go.disabled = false;
          go.textContent = COPY.migrateMakeGo;
        }
      })();
    }
  }
  return { el: mask, close: teardown };
}