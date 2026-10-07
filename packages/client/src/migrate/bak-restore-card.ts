/**
 * 备份笔记的只读恢复卡 —— 老项目 `#bakRestMask`（index.html:817-827）的形态复刻
 *
 * ══════════════════════════════════════════════════════════════════════════
 * 🔴🔴🔴 这是老项目**甲案误编辑三闸的第①闸**：解密后清单直接进只读恢复卡，
 *   **绝不进 contenteditable**。
 *
 * 老项目原文（index.html:817-827，只读）：
 *   `<div class="mask hidden" id="bakRestMask">`
 *     `<div class="box qr-box">`
 *       `<h1 class="qr-title">换机备份</h1>`
 *       `<p id="bakRestSummary"></p>`
 *       `<p id="bakRestList" style="max-height:28vh;overflow:auto;text-align:left;
 *              font-size:12.5px;line-height:1.9;white-space:pre-wrap;word-break:break-all"></p>`
 *       `<p class="qr-warn">这里只能读取，不能编辑。<br>要更新备份，回到旧设备上点「扫码换机」。</p>`
 *       `<button id="bakRestGo">恢复</button>`
 *       `<button id="bakRestCancel" class="ghost-btn">先看看</button>`
 *
 * 🔴🔴 **老项目那行内联样式必须逐字照抄**（`max-height:28vh; overflow:auto;
 *   text-align:left; font-size:12.5px; line-height:1.9; white-space:pre-wrap;
 *   word-break:break-all`）—— 那是"篇名清单在长名单下仍可读"的全部保证：
 *   ① `max-height:28vh + overflow:auto` ⇒ 不封顶时页面不被推走
 *   ② `word-break:break-all` ⇒ 篇名含长串无空格时不溢出（篇名规则是 [A-Za-z0-9_-]，
 *      一个 64 字符的篇名在 12.5px 下会顶破窄屏）
 *   ③ `white-space:pre-wrap` ⇒ 换行靠文本里的 \n，不用人为插 br
 *   少任何一条的症状都是"恢复卡把清单挤成一片/撑破弹窗"，而那看起来像功能坏了。
 *
 * 🔴 为什么警示用 `.ns-qr-warn` 而不是老项目的 `.qr-warn`：
 *   老项目 `.qr-warn`（index.html:537）声明的 12px/danger **被 `.box p`(0,1,1) 压掉**，
 *   实测渲染是 13px muted（这正是 docs/replication-discipline.md 里记的"死规则"）。
 *   bj 的 `.ns-qr-warn`（styles.css:1704）同样会被 `.box p` 压 ——
 *   **这是刻意的**：照抄类名让规则链自然给出与老项目一致的实测结果，
 *   而不是"照抄声明"（照抄声明 = 把 bug 一起抄进来，见 MEMORY 的判据纪律）。
 *
 * 零 DOM 依赖的部分（判别/清单解析）在 migrate/bak-note.ts；本文件只管呈现。
 */

import { COPY } from '../ui/copy.ts';

export interface BakRestoreCardDeps {
  /** 清单里的篇名（已按备份里的顺序）。 */
  ids: readonly string[];
  /** 生成时刻（毫秒）。0 = 清单里没有时间戳，那就不显示时间部分。 */
  ts: number;
  /**
   * 点「恢复这 N 篇」。返回成功文案；失败时抛错或返回失败文案由调用方决定。
   * 🔴 面板**不持有**任何恢复逻辑 —— 与 migrate/panel.ts 的口令纪律同款：
   *   面板只收用户输入、只渲染，副作用全在 deps 里。
   */
  onGo: () => Promise<string>;
  /** 点「先看看」/关闭。只读态**不归还编辑器焦点**（老项目 :9238 的刻意不补）。 */
  onCancel: () => void;
  /** 时间戳格式化（老项目 fmtSyncTime）。注入避免本模块引时间层。 */
  fmtTime?: (ms: number) => string;
}

export interface BakRestoreCard {
  el: HTMLElement;
  close: () => void;
}

function fmtSyncTime(ms: number): string {
  const d = new Date(ms);
  const p = (n: number): string => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

export function isBakRestoreCardOpen(): boolean {
  return document.getElementById('bakRestMask') !== null;
}

export function closeBakRestoreCard(): void {
  document.getElementById('bakRestMask')?.remove();
}

/**
 * 开恢复卡。
 *
 * 🔴 形态与老项目同款：`.mask` 遮罩 + `.box.qr-box` 居中卡。
 *   点遮罩空白**不关**（老项目 :817 的 #bakRestMask 没有那条路径）——
 *   这道恢复卡是"你扫到的这篇是别人的备份清单"的第一眼，
 *   误触关掉等于让用户以为自己扫了个空笔记，得重扫一次。
 */
export function buildBakRestoreCard(deps: BakRestoreCardDeps): BakRestoreCard {
  closeBakRestoreCard();

  const mask = document.createElement('div');
  mask.className = 'mask';
  mask.id = 'bakRestMask';

  const box = document.createElement('div');
  box.className = 'box qr-box';

  const title = document.createElement('h1');
  title.className = 'qr-title';
  title.textContent = COPY.bakRestTitle;

  const summary = document.createElement('p');
  const fmt = deps.fmtTime ?? fmtSyncTime;
  summary.id = 'bakRestSummary';
  // 🔴 老项目 :9227 口径：`生成于 <时间>，含 N 篇笔记的解锁密钥。`
  //   bj 的措辞去掉「的解锁密钥」—— 清单里**没有密钥**（见 bak-note.ts 文件头），
  //   留着这句就是谎报。
  summary.textContent = COPY.bakRestSummary(deps.ts > 0 ? '生成于 ' + fmt(deps.ts) : '', deps.ids.length);

  const list = document.createElement('p');
  list.id = 'bakRestList';
  // 🔴🔴 老项目那行内联样式逐字照抄（理由见文件头，逐条都对应一个具体症状）
  list.style.cssText =
    'max-height:28vh;overflow:auto;text-align:left;font-size:12.5px;line-height:1.9;' +
    'white-space:pre-wrap;word-break:break-all';
  list.textContent = deps.ids.join('\n');

  const warn = document.createElement('p');
  warn.className = 'ns-qr-warn';
  // 老项目 :823 原文含 <br>，且它是**本模块自产的常量**（不是用户输入）⇒ innerHTML 安全
  warn.innerHTML = COPY.bakRestWarnHtml;

  const go = document.createElement('button');
  go.id = 'bakRestGo';
  go.textContent = COPY.bakRestGo(deps.ids.length);

  const cancel = document.createElement('button');
  cancel.id = 'bakRestCancel';
  cancel.className = 'ghost-btn';
  cancel.textContent = COPY.bakRestCancel;

  box.append(title, summary, list, warn, go, cancel);
  mask.appendChild(box);
  document.body.appendChild(mask);

  const teardown = (): void => {
    document.removeEventListener('keydown', onKey, true);
    closeBakRestoreCard();
    deps.onCancel();
  };

  const onKey = (e: KeyboardEvent): void => {
    if (e.key === 'Escape') teardown();
  };
  document.addEventListener('keydown', onKey, true);

  go.addEventListener('click', () => {
    go.disabled = true;
    // 🔴 老项目 :9242 逐字：按下去先变「正在恢复…」，别让用户以为没点上而连点
    go.textContent = COPY.bakRestWorking;
    void (async () => {
      try {
        const msg = await deps.onGo();
        // 成功文案由调用方给（老项目 :9270 那句带篇数与覆盖数，本项目 favRestoreTip 同款）
        list.textContent = msg;
        // 恢复完就地改成结果态：清单原文没必要留着（用户已经恢复完了）
        warn.textContent = '';
        go.remove();
        cancel.textContent = COPY.migrateDoneClose;
        go.disabled = false;
      } catch {
        // 🔴 失败必须**留在能看见的态**，且 go 重新可点
        //   （失败文案由调用方用 showUploadNote 之类给到屏幕上）。
        go.disabled = false;
        go.textContent = COPY.bakRestGo(deps.ids.length);
      }
    })();
  });
  cancel.addEventListener('click', teardown);

  return { el: mask, close: teardown };
}
