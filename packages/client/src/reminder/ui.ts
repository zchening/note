/**
 * 提醒 UI —— 时间 chip / 响铃卡 / 提醒面板 / 到点通知
 *
 * 🔴🔴 本文件只做 **DOM 与交互**，一切判定都在 reminder/ 下的纯函数里。
 *   理由是老项目栽过的跟头：提醒逻辑散在 UI 函数里，格式与解析各写一份，
 *   于是"刚加的提醒自己消失了"而**界面上没有任何报错**。
 *
 * 复刻的老项目形态（v8.1.5，逐项对应）：
 *   - 时间 chip：光标落在**未过期**时间串上时浮出，三行小卡（v7.8.0 起不是单行胶囊）
 *   - 响铃卡 remCard：页内主通道，**无论通知权限如何都弹**（老项目铁律）
 *   - 提醒面板 remPanel：时/分滚轮 + 事项 + 已设列表
 *   - 到点：WebAudio 双音两轮 + 震动 + 系统通知（能通知就通知，不能通知也有页内卡）
 *
 * 纪律：
 *   - 可见中文只从 ui/copy.ts 取
 *   - 颜色字面量只从 ui/theme.ts 取（本文件不写任何颜色）
 *   - 用户数据进 innerHTML 前必过 ui/escape.ts
 *   - 折叠开合 / chip 显隐是 **ephemeral UI 态**，绝不进真源
 */

import { COPY } from '../ui/copy.ts';
import { ICON_X } from '../ui/icons.ts';
import { fmtChipDay, fmtChipTime, fmtLate, fmtRemInsert, itemForChip, matchAtCaret } from '../reminder/format.ts';
import { addReminder, removeReminder, removeReminderAt, upcomingReminders, dueReminders } from './reconcile.ts';
import { syncRemindersToNative } from './native-rem.ts';
import type { SyncOutcome } from './native-rem.ts';

import type { Doc } from '@bj/shared-schema';
/**
 * 🔴 最近一次原生闹钟同步的结论留存（`?diag` 面板读，见 syncNative 的注释）。
 *
 * 🔴 为什么是**模块级单份**而不是挂在 UI 实例上：原生闹钟只有一份，
 *   面板也只是读"最近一次"，多份留存必然出现分叉（面板读到 A、另一个面板读到 B）。
 * 纯可观测性，**不参与任何业务判定** —— 删掉它只少两格诊断读数，行为完全不变。
 */
let lastNativeOutcome: { note: string; at: number; scheduled: number | null } | null = null;

/** 读最近一次原生同步结论。从没同步过（或非壳内）返回 null ⇒ 诊断渲染成 `n/a`。 */
export function lastNativeSyncOutcome(): { note: string; at: number; scheduled: number | null } | null {
  return lastNativeOutcome;
}

type ReminderDoc = Doc;

const REM_WHEEL_ITEM_H = 50;

export interface ReminderHost {
  /** 取当前真源（深拷贝）。 */
  getDoc: () => ReminderDoc;
  /** 用新真源整体替换编辑器内容。 */
  setDoc: (d: ReminderDoc) => void;
  /** 顶栏提醒键（铃铛点开面板）。 */
  onPanelToggle: () => void;
  /**
   * 在编辑器里插入一行提醒文字，并把光标落到它后面的空行上。
   *
   * 🔴🔴 这不是可有可无的锦上添花，而是**面板加提醒能活下来的唯一原因**。
   *   老项目 v5.45 `insertRemLine`：面板点「添加」时，除了写 reminders，
   *   还要把「2026-10-6 14:30　开会」这一行**插进正文光标处**。
   *
   *   我第一版只写 reminders、没插正文行，症状极其隐蔽：
   *     - 点添加 → 面板收起 → 看起来成功
   *     - 提醒**立刻被对账判死**（reconcile 第一步：既有提醒在正文里找不到对应
   *       时间串 ⇒ 判为"正文删了时间串"⇒ 移出）
   *     - 于是 __NOTESYNC_DOC__().reminders.length 恒为 0
   *   而界面上没有任何报错 —— 面板正常收起、有 brief 的确认感，
   *   只有"提醒列表永远是空的"这一个症状。REM-07/08/10 三条一起红就是这么来的。
   *
   *   换句话说：**reminders 与正文时间串必须成对存在**，这正是 reconcile 的设计前提。
   */
  insertLine: (text: string) => void;
  /**
   * 面板打开瞬间存下正文选区（老项目 panelSavedSel）。
   *
   * 🔴 必须在**打开面板之前**调，不是点「添加」时。面板里的输入框一获焦，
   *   编辑器就丢光标 —— 等点提交时已经不知道该往哪插行了。
   */
  saveSelection: () => void;
  /**
   * 顶部状态提示条（老项目 showUploadStatus）。
   *
   * 🔴 可选不是为了省事，而是**唯一一处"拒绝用户操作"的反馈出口**：
   *   addReminder 的兜底闸门拒掉一个过去时间时，老项目走的就是这条路
   *   （index.html:7299 提示条说一句「已过去的时间不能设提醒」后 return false）。
   *   没有它，被拒就是**完全静默**——用户点了"添加提醒"，面板毫无反应，
   *   像是坏了。可选则保证不传也不会崩（单测里就没传）。
   */
  onStatus?: (kind: 'doing' | 'ok' | 'bad', text: string) => void;
}

export class ReminderUI {
  private host: ReminderHost;

  /** 时间 chip。定位 fixed 在顶栏下方，与老项目一致。 */
  private chip: HTMLDivElement;
  /** 响铃卡。 */
  private card: HTMLDivElement;
  /** 提醒面板的遮罩。 */
  private mask: HTMLDivElement;

  /** 本次已弹过卡片的提醒 at，避免同一批反复弹（老项目 cardShownAts）。 */
  private shownAts = new Set<string>();

  /**
   * 🔴 chip 状态三件（老项目 chipData / chipDeleteAt / chipAutoHideTimer+chipFeedbackUntil）
   *
   * chipDeleteAt：确认卡上那个「删除」按钮的目标 at。不是 null 时确认卡正在展示（老项目 :6384）。
   * chipAutoHideTimer：自动收卡句柄。任何新展示前必须 clearTimeout（老项目 :6377）。
   * chipFeedbackUntil：收卡后的冷却截止戳。老项目 :6390 autoHideTimeChip 里
   *   `chipFeedbackUntil = Date.now() + 2000`，refreshChip 开头判它。
   */
  private chipDeleteAt: number | null = null;
  private chipAutoHideTimer: number | undefined;
  private chipFeedbackUntil = 0;
  /** CTA 卡的目标时间串（老项目 chipData）。展示确认卡时必须置 null（老项目 :6382）。 */
  private chipData: { at: number; index: number; length: number } | null = null;

  /** 已经响过的提醒 id，进内存即可（老项目把它写进密文以跨端一致）。 */
  private firedIds = new Set<string>();

  /** 定时器句柄。切笔记/锁屏时要清掉，否则旧笔记的提醒会在新笔记里炸。 */
  private timer: number | undefined;

  private audioCtx: AudioContext | null = null;

  constructor(host: ReminderHost) {
    this.host = host;
    this.chip = this.buildChip();
    this.card = this.buildCard();
    this.mask = this.buildPanel();
    document.body.appendChild(this.chip);
    document.body.appendChild(this.card);
    document.body.appendChild(this.mask);
    this.bindAudioUnlock();
    this.bindSelection();
  }

  /* ==================== 时间 chip ==================== */

  /**
   * chip 的三行小卡结构（老项目 v7.8.0）。
   * 🔴 用 createElement + textContent 而不是 innerHTML 模板：
   *   事项文本来自用户笔记，拼进 HTML 就是 XSS 缺口（老项目在这个点上很脆弱）。
   */
  private buildChip(): HTMLDivElement {
    const el = document.createElement('div');
    el.id = 'timeChip';
    // 🔴🔴 初始必须带 `hidden`（老项目 index.html:672 `<div id="timeChip" class="hidden">`）。
    //   漏了它就是一个**永远看得见的空圆角矩形**—— position:fixed 贴在顶栏下方，
    //   内容为空时宽高都不为零，`.ns-timechip` 也没有 `display:none` 兜底。
    //   用户报的"笔记编辑界面正上方有个圆角矩形一直显示"就是它，
    //   而它平时完全不做事，看起来像凭空多出来的 UI 元素。
    el.className = 'ns-timechip hidden';
    el.setAttribute('role', 'button');
    el.setAttribute('tabindex', '0');
    el.setAttribute('aria-label', COPY.remChipAdd);
    // 🔴🔴 click 与 keydown **两个都要绑**。我第一版只绑了 keydown（Enter/Space），
    //   理由是"它是 role=button，键盘可达就行"—— 结果鼠标点它**完全没反应**，
    //   而 role=button 的语义本来就承诺鼠标可点。
    //   症状极具欺骗性：chip 明明显示出来了（探针里 textContent 有内容），
    //   点下去却什么都不发生，且**零报错**（因为压根没有 handler 被调用）。
    //   判据口诀：**role="button" 的元素必须同时有 click 与键盘路径**，
    //   少一条就是"看得见点不动"。
    el.addEventListener('click', () => this.chipActivate());
    el.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        this.chipActivate();
      }
    });
    return el;
  }

  /** 光标/选区变化时调；命中未过期时间串就显示，否则收起。 */
  refreshChip(editable: HTMLElement | null): void {
    if (!editable) return this.hideChip();
    // 🔴 冷却期内不唤起（老项目 index.html:6390 autoHideTimeChip 把 chipFeedbackUntil
    //   推到 2 秒后，showChipForMatch 开头判它）。缺这一句：光标停在时间串上时，
    //   自动收卡 → selectionchange 立刻唤回 → 用户看到卡片每3 秒闪一次。
    if (Date.now() < this.chipFeedbackUntil) return;
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0) return this.hideChip();
    const range = sel.getRangeAt(0);
    // 🔴 只在编辑器内部的光标才响应：选区落在菜单/输入框里时不该浮 chip
    if (!editable.contains(range.startContainer)) return this.hideChip();
    // 🔴🔴🔴 必须取**块级** text + 块内偏移（老项目 index.html:6305 caretInfoInEditor）。
    //   这里曾用 `editable.textContent` + 全编辑器偏移，两者都错在同一个地方：
    //   全文 textContent 把**所有块无分隔符地拼在一起**，于是
    //     ① itemForChip 的 `end` 回退到 text.length ⇒ 事项把**下面所有块**吞进来
    //        （用户报障第1 条：chip 事项显示成「买菜和水果第二行文字第三行文字」）；
    //     ② 光标在第二块时，collectTimeMatches 仍能匹配，但 index 是全局的，
    //        一切基于"同一行"的推断全部失效。
    //   老项目的 `itemAfterMatch` 虽然也切到串尾，但它的 text 来自
    //   `caretInfoInEditor()` —— **只含当前块**，所以天然不跨行。
    //   ⇒ 这不是"少了个 trim"，是**取文本的粒度**错了。
    const info = caretInfoIn(editable, range.startContainer, range.startOffset);
    if (!info) return this.hideChip();
    const m = matchAtCaret(info.text, info.offset, Date.now());
    if (!m) return this.hideChip();
    const item = itemForChip(info.text, m, Date.now());
    // 🔴🔴 已添加态优先判定（老项目 index.html:6380
    //   `if (reminders.some(r => r.at === m.at))`）。
    //   此前这一步整个缺失 —— 只要命中一个未过期时间串就弹 CTA「添加提醒」卡，
    //   于是**已经加过提醒的时间串，光标移上去仍然要你再点一次添加**；
    //   而 addReminder 走「同一时刻不重复加」分支静默返回，
    //   用户看到的就是"我明明加过了，怎么还要再加"。
    const now = Date.now();
    const existing = (this.host.getDoc().reminders ?? []).find((r) => r.at === new Date(m.at).toISOString());
    if (existing) {
      // 真已过期：与下划线同步消失，不弹（老项目 :6381）
      if (m.at <= now) return this.hideChip();
      this.chipData = null; // 清残留，防此前 CTA 卡的旧目标被误触
      this.chipDeleteAt = m.at; // v5.47：展示卡带「删除」按钮
      this.showChipFeedback(m.at, item);
      return;
    }
    // 🔴 已过期的时间串**不浮 chip**（老项目 :6393 `if (m.expired) hideTimeChip()`，零打扰铁律）
    if (m.at <= now) return this.hideChip();
    this.chipDeleteAt = null;
    this.chipData = { at: m.at, index: m.index, length: m.length };
    this.showChip(m, item);
  }

  /** 两行「已添加」确认卡（老项目 index.html:6382-6389）。 */
  private showChipFeedback(at: number, item: string): void {
    this.chip.textContent = '';
    this.chip.classList.add('feedback');
    const l1 = document.createElement('div');
    l1.className = 'ns-chip-ok1';
    l1.appendChild(document.createTextNode(COPY.remChipAdded));
    l1.appendChild(this.buildChipDeleteBtn());
    const l2 = document.createElement('div');
    l2.className = 'ns-chip-ok2';
    l2.textContent = fmtChipTime(at) + (item ? `　${item}` : '');
    this.chip.appendChild(l1);
    this.chip.appendChild(l2);
    this.chip.classList.remove('hidden');
    // 🔴 走冷却包装（老项目 :6390 autoHideTimeChip）：
    //   收卡后 2 秒内不重弹。缺冷却 = 光标停在时间串上时卡片反复闪。
    this.armChipAutoHide();
  }

  /**
   * 「删除这条提醒」伪按钮（老项目 buildChipDeleteBtn，index.html:6486）。
   * 🔴🔴 用 span + role=button（老项目 v5.39「伪按钮键盘可达」惯例），
   *   四条激活路径全绑：pointerdown / touchstart / mousedown / 键盘 Enter·Space。
   *   只绑 click 的话，移动端 pointerdown 之后仍可能不产生 click（老内核）。
   *   每条都要 stopPropagation —— 否则冒泡到整卡的 chipActivate = 先加后删。
   */
  private buildChipDeleteBtn(): HTMLElement {
    const d = document.createElement('span');
    d.className = 'ns-chip-del';
    d.setAttribute('role', 'button');
    d.setAttribute('tabindex', '0');
    d.setAttribute('aria-label', COPY.remChipDelete);
    d.textContent = COPY.remChipDeleteLabel;
    const act = (e: Event): void => {
      e.preventDefault();
      e.stopPropagation(); // 阻止冒泡到 chipActivate（整卡点击路径）
      const at = this.chipDeleteAt;
      if (at === null) return;
      this.chipDeleteAt = null;
      this.host.setDoc(removeReminderAt(this.host.getDoc(), at));
      this.hideChip();
    };
    d.addEventListener('pointerdown', act);
    d.addEventListener('touchstart', act, { passive: false });
    d.addEventListener('mousedown', act);
    d.addEventListener('keydown', (e) => {
      const ke = e as KeyboardEvent;
      if (ke.key === 'Enter' || ke.key === ' ') act(ke);
    });
    return d;
  }

  /**
   * 自动收卡 + 冷却（老项目 autoHideTimeChip / hideTimeChip）。
   * 🔴 收卡时把 chipFeedbackUntil 推到 2 秒后：这一段内refreshChip 不再唤起。
   *   没有它，光标仍停在时间串上时 selectionchange 会把卡立刻唤回来 ——
   *   用户看到的是卡片每 3 秒闪一次。
   */
  private armChipAutoHide(ms = 3000): void {
    window.clearTimeout(this.chipAutoHideTimer);
    this.chipAutoHideTimer = window.setTimeout(() => {
      this.chipFeedbackUntil = Date.now() + 2000;
      this.hideChip();
    }, ms);
  }

  /** CTA 卡（老项目未添加态：时间＋相对日 / 事项 / 分隔线 / 通栏主按钮）。 */
  private showChip(m: { at: number; index: number; length: number }, item: string): void {
    this.chip.textContent = '';
    this.chip.classList.remove('feedback');
    const hd = document.createElement('div');
    hd.className = 'ns-chip-hd';
    // 🔴🔴 顺序：**时间在首行最左侧且加粗**，相对日在右（老项目 index.html:6410-6418）。
    //   bj 此前是「相对日左 / 时间右」，与老项目完全反过来 ——
    //   用户看到的截图就是「左边的字小、右边的字大」，主次颠倒。
    const clock = document.createElement('span');
    clock.className = 'ns-chip-clock';
    clock.textContent = fmtChipTime(m.at);
    hd.appendChild(clock);
    // 🔴 同日返回空 ⇒ **不挂这个元素**（老项目 `if (dayTxt) {...}`）。
    //   挂一个空 span 会在首行右侧留出一条空白，justify-content:space-between
    //   下把加粗时间挤向左边，与老项目「时间贴左」不一致。
    const dayTxt = fmtChipDay(m.at, Date.now());
    if (dayTxt) {
      const rel = document.createElement('span');
      rel.className = 'ns-chip-rel';
      rel.textContent = dayTxt;
      hd.appendChild(rel);
    }
    this.chip.appendChild(hd);
    if (item) {
      const it = document.createElement('div');
      it.className = 'ns-chip-item';
      // 🔴 截断只落在事项行：老项目 v7.8.0 定的规矩（CTA 恒完整可见可点）
      it.textContent = escapeTruncPlain(item, 30);
      this.chip.appendChild(it);
    }
    // 🔴🔴 分隔线（老项目 index.html:6424 `const sep = document.createElement('div'); sep.className='chip-sep'`）。
    //   bj 的样式表**早就有** `.ns-chip-sep` 规则（styles.css:1108），
    //   但 showChip() 从没创建过这个元素 —— 典型的「有样式没节点」：
    //   规则恒不命中，且症状是"老项目有、bj 没有"，一眼看出是漏了元素而非漏了 CSS。
    const sep = document.createElement('div');
    sep.className = 'ns-chip-sep';
    this.chip.appendChild(sep);
    const cta = document.createElement('div');
    cta.className = 'ns-chip-cta';
    cta.textContent = COPY.remChipAdd;
    this.chip.appendChild(cta);
    this.chip.dataset.at = String(m.at);
    this.chip.classList.remove('hidden');
  }

  private hideChip(): void {
    // 🔴 任何新展示都要作废旧自动收定时器（老项目 index.html:6377 clearTimeout）：
    //   否则「已添加」卡的残留定时器会把随后弹出的 CTA 卡误收。
    window.clearTimeout(this.chipAutoHideTimer);
    this.chipDeleteAt = null;
    this.chip.classList.add('hidden');
  }

  /**
   * 把 DOM 位置换算成编辑器纯文本里的字符偏移。
   *
   * 🔴🔴🔴 本方法已**不再用于 chip 判定**（改走文件尾的 `caretInfoIn`，取块级 text）。
   *   保留它是因为它还有一个正当用途：把 chip 的全局 index 换算回"编辑器全文"，
   *   供 `insertRemLine` 之类的写回路径定位。**留着一个"看起来还能用"的旧口径**
   *   是本项目记过的坑（`STATE_LABEL`、CSS 里的 `.menu-item` 背景都栽过）：
   *   下一个人看到它会以为这就是 chip 的取文本方式。
   *
   * 🔴 用 `Range.toString()` 而不是 `textContent.indexOf(node.textContent)`：
   *   同一段文字在文档里出现两次时 indexOf 会返回第一处，于是光标在第二处
   *   却被算成第一处 —— 表现为"点第二个时间串，加的却是第一个的提醒"。
   */
  private offsetWithin(root: HTMLElement, node: Node, nodeOffset: number): number {
    if (!root.contains(node)) return -1;
    const probe = document.createRange();
    try {
      probe.setStart(root, 0);
      probe.setEnd(node, nodeOffset);
    } catch {
      return -1;
    }
    return probe.toString().length;
  }

  private chipActivate(): void {
    const at = Number(this.chip.dataset.at ?? '');
    if (!Number.isFinite(at) || at <= 0) return;
    const d = this.host.getDoc();
    const item = this.chip.querySelector('.ns-chip-item');
    const text = item && item.textContent ? item.textContent : '';
    const r = addReminder(d, at, text);
    // 🔴 过去时间：老项目 index.html:7299 是「提示条说一句 + return false」，
    //   面板**不**变确认卡。addReminder 的兜底闸门会拒，此时不许弹确认卡
    //   ——弹了就等于骗用户「加上了」，而 reminders 里根本没有这一条。
    if (r.rejected) {
      this.hideChip();
      this.host.onStatus?.('bad', COPY.remPastTip);
      return;
    }
    this.host.setDoc(r.doc);
    // 🔴 🔴 确认卡走老项目 showChipForMatch 的「已添加」分支（index.html:6382）：
    //   两行 + 尾部删除钮 + 3 秒自动收。此前是三行、无删除钮、1.6 秒硬收。
    this.chipDeleteAt = null;
    this.hideChip();
    this.showChipFeedback(at, text);
  }

  private bindSelection(): void {
    // 🔴 selectionchange 在输入框里也触发，所以判据是"焦点在编辑器"。
    //   无条件监听会让用户在口令框里打字时编辑器 chip 也跟着闪。
    const onSel = (): void => {
      const host = document.querySelector('[data-note] [contenteditable="true"]') as HTMLElement | null;
      if (!host) return;
      const ae = document.activeElement;
      if (ae && host !== ae && !host.contains(ae)) return;
      this.refreshChip(host);
    };
    document.addEventListener('selectionchange', onSel);
  }

  /* ==================== 响铃卡 ==================== */

  private buildCard(): HTMLDivElement {
    const el = document.createElement('div');
    el.id = 'remCard';
    el.className = 'ns-remcard hidden';
    el.setAttribute('role', 'alertdialog');
    const x = document.createElement('div');
    x.className = 'box-x';
    x.setAttribute('role', 'button');
    x.setAttribute('tabindex', '0');
    x.setAttribute('title', COPY.remChipClose);
    x.setAttribute('aria-label', COPY.remChipClose);
    // 🔴🔴 关闭键必须**有图标**：此前只挂了 class / role / 事件，容器是空的
    //   ⇒ 弹窗右上角什么都不显示（用户报障第 3 条「提醒弹窗关闭按钮没显示出来」）。
    //   量化实测：老项目关闭图标 font-size 13.3px、bj 是 16px —— 因为 bj 压根没有 svg。
    //   与老项目 `.box-x` 内含 svg 同款。
    x.innerHTML = ICON_X();
    const title = document.createElement('div');
    title.className = 'ns-remcard-title';
    title.textContent = COPY.remCardTitle;
    const list = document.createElement('div');
    list.className = 'ns-remcard-list';
    const ack = document.createElement('div');
    ack.className = 'ns-remcard-ack';
    ack.setAttribute('role', 'button');
    ack.setAttribute('tabindex', '0');
    ack.textContent = COPY.remCardAck;
    const close = (): void => {
      this.shownAts.clear();
      el.classList.add('hidden');
    };
    ack.addEventListener('click', close);
    x.addEventListener('click', close);
    for (const n of [ack, x]) {
      n.addEventListener('keydown', (e) => {
        const ev = e as KeyboardEvent;
        if (ev.key === 'Enter' || ev.key === ' ') {
          ev.preventDefault();
          (n as HTMLElement).click();
        }
      });
    }
    el.appendChild(x);
    el.appendChild(title);
    el.appendChild(list);
    el.appendChild(ack);
    return el;
  }

  /**
   * 弹响铃卡。
   * @param isCatchup 是否为「补弹」（下次打开时对已过的提醒）
   */
  showCard(items: readonly { id: string; at: string; text: string }[], isCatchup: boolean): void {
    // 🔴 空数组必须早退：否则 showCard([]) 会把卡片显示成空壳，
    //   而调用方（补弹路径）传空数组是完全正常的。
    if (items.length === 0) return;
    for (const it of items) this.shownAts.add(it.at);
    const list = this.card.querySelector('.ns-remcard-list');
    if (!list) return;
    list.textContent = '';
    const now = Date.now();
    for (const r of items) {
      const row = document.createElement('div');
      row.className = 'ns-rem-item';
      const t = document.createElement('span');
      t.className = 'ns-rem-when';
      const at = Date.parse(r.at);
      t.textContent = fmtChipTime(r.at) + (r.text ? `　${escapeTruncPlain(r.text, 40)}` : '');
      row.appendChild(t);
      if (isCatchup && at <= now) {
        const late = document.createElement('span');
        late.className = 'ns-rem-late';
        late.textContent = COPY.remCardLate(fmtLate(at, now));
        row.appendChild(late);
      }
      list.appendChild(row);
    }
    this.card.classList.remove('hidden');
    this.hideChip();
    this.hidePanel();
  }

  /* ==================== 到点调度 ==================== */

  /**
   * 启动调度。**必须在每次真源变化后重排**（对账可能新增/删除提醒）。
   *
   * 🔴 调度口径：`setTimeout` 到最近那条 + 1 秒，醒来看还有没有到点的。
   *   用 setInterval 轮询会让笔记本休眠醒来后一次性炸出十几张卡。
   *
   * 🔴🔴🔴 这里同时把提醒列表**交给原生排精确闹钟**（老项目 `syncRemindersToNative`）。
   *   为什么必须挂在 `schedule()` 上而不是散到各个 mutator 里：
   *   bj 的 `schedule()` 已经是「真源变了就重排」的**唯一收口**（面板加、面板删、
   *   对账增删、setDoc 写回都会经过它），挂在这里就等于**一遍不漏**。
   *   漏挂的症状是老项目 v5.55 那个 P0：App 退后台或杀进程后到点不响铃，
   *   而页内定时器那条路（`fire` → 卡片 + 声音）**照样正常** ⇒ 界面上零异常。
   */
  schedule(): void {
    this.rearm();
    void this.syncNative();
  }

  /**
   * 同步提醒列表到原生闹钟层（App退后台 / 杀进程后到点仍响铃的唯一保障）。
   *
   * 🔴 当前笔记名取自 `[data-note]`（`main.ts mountEditor` 写的）。
   *   与老项目 :7013 的 `skip-no-note` 闸同源：**空笔记名一律跳过**——
   *   空串在原生侧是 "" 分区，误传会清首页分区却碰不到具名分区的闹钟。
   *
   * 🔴 返回值不抛错、也不静默丢弃：`SyncOutcome.note` 能区分
   *   「没桥」（网页版正常）/「桥抛了」（壳内异常，值得查）两种收场。
   *
   * 🔴🔴 结论**顺手留一份给诊断面板**（`lastNativeSyncOutcome`）：
   *   `schedule()` 用 `void this.syncNative()` 调它，返回值当场丢掉 ——
   *   于是 `?diag` 第 5 组的 `scheduled` 与第 8 组的 `lastNativeSync` 永远读不到，
   *   两条读数恒为 `n/a`，等于这一格诊断白给。
   *   老项目是靠 `window.__remNativeScheduled` / `__lastNativeSync` 两个全局做到的
   *   （`index.html:2054`）。**留存放在真正产出它的地方**（本模块），
   *   而不是让 main.ts 包一层 —— 包一层就得把 private 方法改成 public，
   *   那是为诊断拓宽生产 API，得不偿失。
   *   纯可观测性留存，不参与任何业务判定。
   */
  private async syncNative(): Promise<SyncOutcome> {
    const noteId = this.currentNoteName();
    const out = await syncRemindersToNative(this.host.getDoc().reminders ?? [], noteId);
    lastNativeOutcome = {
      note: out.note,
      at: Date.now(),
      // 🔴 原生没报数时（老壳 / 异常形态）`scheduled` 键不出现 ⇒ 归一成 null。
      //   "没报数"与"报 0"必须能分辨：后者是"同步了但一条都没排上"。
      scheduled: out.scheduled ?? null,
    };
    return out;
  }

  /** 只重排页内定时器。定时器自己醒来时走这条（老项目 fireReminder :7551 同款：不重复同步原生）。 */
  private rearm(): void {
    if (this.timer !== undefined) {
      window.clearTimeout(this.timer);
      this.timer = undefined;
    }
    const due = dueReminders(this.host.getDoc());
    const now = Date.now();
    for (const r of due) {
      if (!this.firedIds.has(r.id)) this.fire(r);
    }
    const up = upcomingReminders(this.host.getDoc());
    if (up.length === 0) return;
    const next = Math.min(...up.map((r) => Date.parse(r.at)));
    const wait = Math.max(250, Math.min(next - now + 1000, 2147483647));
    // 🔴 醒来自调用的是 `rearm` 而不是 `schedule`：老项目 :7551 fireReminder 里
    //   重新排程**不**带 syncRemindersToNative。跟着做，避免每响一次铃就重排一次原生闹钟。
    this.timer = window.setTimeout(() => this.rearm(), wait);
  }

  /**
   * 到点。
   *
   * 🔴🔴 页内卡是**主通道**，系统通知是增强 —— 老项目 v6.3 之后明确"过期静默，
   *   无补弹"，但**到点当次**必须响。所以顺序是：先 sound + card（一定执行），
   *   再尝试通知（失败静默）。
   */
  private fire(r: { id: string; at: string; text: string }): void {
    this.firedIds.add(r.id);
    this.playSound();
    void this.notify(r);
    this.showCard([r], false);
  }

  private bindAudioUnlock(): void {
    // 🔴🔴 全局音频解锁（老项目 v5.44）：每次响铃新建 AudioContext 的话，
    //   到点时没有用户手势，ctx 恒为 suspended 直接哑火，且**零报错**。
    //   必须在首次手势时就建好并 resume，响铃时复用不close。
    const unlock = (): void => {
      try {
        const AC = window.AudioContext || (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
        if (!AC) return;
        if (!this.audioCtx) this.audioCtx = new AC();
        if (this.audioCtx.state === 'suspended') void this.audioCtx.resume().catch(() => {});
        // iOS/国产内核必需的静音 buffer
        const b = this.audioCtx.createBuffer(1, 1, 22050);
        const s = this.audioCtx.createBufferSource();
        s.buffer = b;
        s.connect(this.audioCtx.destination);
        if (s.start) s.start(0);
      } catch {
        /* 解锁失败不致命：响铃时再试 */
      }
    };
    for (const ev of ['pointerdown', 'touchend', 'keydown']) {
      document.addEventListener(ev, unlock, { passive: true });
    }
  }

  /** 双音两轮（老项目 [[880,0],[1318.5,.18],[880,.55],[1318.5,.73]]，逐值复刻）。 */
  playSound(): void {
    try {
      navigator.vibrate?.([200, 120, 200]);
    } catch {
      /* 震动不可用 */
    }
    try {
      const ctx = this.audioCtx;
      if (!ctx || ctx.state === 'closed') return;
      if (ctx.state === 'suspended') void ctx.resume().catch(() => {});
      const t0 = ctx.currentTime + 0.02;
      for (const [f, dt] of [[880, 0], [1318.5, 0.18], [880, 0.55], [1318.5, 0.73]] as const) {
        const o = ctx.createOscillator();
        const g = ctx.createGain();
        o.type = 'sine';
        o.frequency.value = f;
        g.gain.setValueAtTime(0.0001, t0 + dt);
        g.gain.exponentialRampToValueAtTime(0.22, t0 + dt + 0.025);
        g.gain.exponentialRampToValueAtTime(0.0001, t0 + dt + 0.38);
        o.connect(g);
        g.connect(ctx.destination);
        o.start(t0 + dt);
        o.stop(t0 + dt + 0.42);
      }
    } catch {
      /* 音频失败不影响卡片 */
    }
  }

  private async notify(r: { at: string; text: string }): Promise<void> {
    if (typeof window.Notification === 'undefined') return;
    if (window.Notification.permission !== 'granted') return;
    const title = '⏰ ' + (r.text || COPY.remNotifyFallback);
    const body = COPY.remNotifyBody(this.currentNoteName());
    try {
      const reg = await navigator.serviceWorker.getRegistration();
      if (reg) await reg.showNotification(title, { body, tag: COPY.remNotifyTag });
      else new window.Notification(title, { body, tag: COPY.remNotifyTag });
    } catch {
      /* 通知失败不影响页内卡 */
    }
  }

  private currentNoteName(): string {
    return document.querySelector('[data-note]')?.getAttribute('data-note') ?? '';
  }

  /** 问一次通知权限（老项目 askRemPermission 在真正添加时才问）。 */
  static async askPermission(): Promise<void> {
    if (typeof window.Notification === 'undefined') return;
    if (window.Notification.permission === 'default') {
      try {
        await window.Notification.requestPermission();
      } catch {
        /* 拒绝也无妨：页内卡是主通道 */
      }
    }
  }

  /* ==================== 提醒面板 ==================== */

  private buildPanel(): HTMLDivElement {
    const mask = document.createElement('div');
    // 🔴 id 是**对外契约**：`main.ts hasOverlayPanelOpen()` 用它判断"提醒面板开着没有"
    //   （链接识别延迟守卫）。此前这里只有 `class="mask hidden"`、既无 id 也无专属类，
    //   而守卫那边写的是 `.ns-rem-mask:not(.hidden)` ⇒ **恒 null，守卫静默失效**。
    //   病：提醒面板开着时正文不可编辑，那种场景没有新输入，
    //   守卫失效就表现为"打开面板时点正文，光标被链接重建弹走"。
    mask.id = 'remMask';
    mask.className = 'mask hidden';
    const box = document.createElement('div');
    box.className = 'box ns-rembox';
    const head = document.createElement('div');
    head.className = 'modal-head';
    const h1 = document.createElement('h1');
    h1.textContent = COPY.remPanelTitle;
    const x = document.createElement('div');
    x.className = 'box-x';
    x.setAttribute('role', 'button');
    x.setAttribute('tabindex', '0');
    x.setAttribute('title', COPY.remChipClose);
    x.setAttribute('aria-label', COPY.remChipClose);
    // 🔴🔴 关闭键必须**有图标**：此前只挂了 class / role / 事件，容器是空的
    //   ⇒ 弹窗右上角什么都不显示（用户报障第 3 条「提醒弹窗关闭按钮没显示出来」）。
    //   量化实测：老项目关闭图标 font-size 13.3px、bj 是 16px —— 因为 bj 压根没有 svg。
    //   与老项目 `.box-x` 内含 svg 同款。
    x.innerHTML = ICON_X();
    const close = (): void => this.hidePanel();
    x.addEventListener('click', close);
    x.addEventListener('keydown', (e) => {
      const ev = e as KeyboardEvent;
      if (ev.key === 'Enter' || ev.key === ' ') {
        ev.preventDefault();
        close();
      }
    });
    const form = document.createElement('div');
    form.className = 'ns-rem-form';
    const list = document.createElement('div');
    list.className = 'ns-rem-list';
    head.appendChild(h1);
    head.appendChild(x);
    box.appendChild(head);
    box.appendChild(form);
    box.appendChild(list);
    mask.appendChild(box);
    // 遮罩空白处点击关闭
    mask.addEventListener('click', (e) => {
      if (e.target === mask) this.hidePanel();
    });
    return mask;
  }

  togglePanel(): void {
    if (this.mask.classList.contains('hidden')) this.showPanel();
    else this.hidePanel();
  }

  hidePanel(): void {
    this.mask.classList.add('hidden');
  }

  showPanel(): void {
    // 🔴 先存正文选区，再碰任何输入框（详见 host.saveSelection 的注释）
    this.host.saveSelection();
    const form = this.mask.querySelector('.ns-rem-form');
    const list = this.mask.querySelector('.ns-rem-list');
    if (!form || !list) return;
    form.textContent = '';
    list.textContent = '';
    this.hideChip();

    // 时间行：日期用原生选择器（触屏弹系统日历，比滚 12 个月好用）
    const timeRow = document.createElement('div');
    timeRow.className = 'ns-rem-time-row';
    const dateInp = document.createElement('input');
    dateInp.type = 'date';
    dateInp.setAttribute('aria-label', COPY.remDateAria);
    // 🔴 默认 = 当前 +5 分钟（老项目 v5.42 用户要求 12:35 → 12:40）
    const nd = new Date(Date.now() + 5 * 60000);
    const p2 = (x: number): string => String(x).padStart(2, '0');
    dateInp.value = `${nd.getFullYear()}-${p2(nd.getMonth() + 1)}-${p2(nd.getDate())}`;
    const hh = this.makeWheel('hh', 23, nd.getHours());
    const mm = this.makeWheel('mm', 59, nd.getMinutes());
    const colon = document.createElement('span');
    colon.className = 'ns-rem-colon';
    colon.textContent = ':';
    timeRow.appendChild(dateInp);
    timeRow.appendChild(hh.wrap);
    timeRow.appendChild(colon);
    timeRow.appendChild(mm.wrap);
    form.appendChild(timeRow);

    const item = document.createElement('input');
    item.type = 'text';
    item.className = 'ns-rem-input';
    item.placeholder = COPY.remItemPlaceholder;
    item.maxLength = 20;
    item.setAttribute('aria-label', COPY.remItemAria);

    const ok = document.createElement('button');
    ok.type = 'button';
    ok.className = 'ns-rem-add';
    ok.textContent = COPY.remAddBtn;

    const doAdd = (): void => {
      const dv = dateInp.value;
      const h = this.wheelVal('hh');
      const m = this.wheelVal('mm');
      const at = dv && Number.isFinite(h) && Number.isFinite(m)
        ? new Date(+dv.slice(0, 4), +dv.slice(5, 7) - 1, +dv.slice(8, 10), h, m).getTime()
        : 0;
      if (!at || at <= Date.now()) {
        // 🔴 已过/无效：**只闪红框**（老项目 index.html:7740
        //   `bads.forEach(x => x.classList.add('bad'))` 后 `setTimeout(..., 900)` 移除），
        //   面板里不插任何文字行。此前这里插了一行「已过去的时间不能设提醒」——
        //   老项目这句话只出现在**顶部提示条**（addReminder 兜底闸门 index.html:7299），
        //   面板里多这一行既是凭空多出的可见元素，又把弹窗顶高一截。
        const bads = [dateInp, hh.wrap, mm.wrap];
        bads.forEach((x) => x.classList.add('ns-bad'));
        window.setTimeout(() => {
          bads.forEach((x) => x.classList.remove('ns-bad'));
        }, 900);
        return;
      }
      const text = item.value.trim();
      void ReminderUI.askPermission();
      // 🔴🔴 顺序不能换：先插正文行，再写 reminders。
      //   插行会触发一次 update 监听 → 那里立刻跑对账；若此刻 reminders 还没写进去，
      //   对账看不到这条提醒，就会把刚插进来的时间串当"普通正文"，
      //   紧接着 setDoc 写进去的提醒又因为"找不到时间串"被判死 —— 来回两次都丢。
      //   先插行则正文已经有串，对账只是"发现了一个没提醒的时间串"（红线 1：不动它），
      //   紧接着 setDoc 补上提醒，下一轮对账就能配上对。
      this.host.insertLine(ReminderUI.insertLine(at, text));
      this.host.setDoc(addReminder(this.host.getDoc(), at, text).doc);
      this.hidePanel();
      this.schedule();
    };
    ok.addEventListener('click', doAdd);
    const onEnter = (e: KeyboardEvent): void => {
      // 🔴 IME 组合中不触发（老项目 v7.1.0）：中文输入法打完字按 Enter 会立刻吞掉
      if (e.isComposing || e.keyCode === 229) return;
      if (e.key === 'Enter') {
        e.preventDefault();
        doAdd();
      }
    };
    item.addEventListener('keydown', onEnter);
    dateInp.addEventListener('keydown', onEnter);
    form.appendChild(item);
    form.appendChild(ok);

    // 已设条目：只列未来的（老项目 v5.47 显式升序，最近的在最上）
    const up = upcomingReminders(this.host.getDoc());
    for (const r of up) {
      const row = document.createElement('div');
      row.className = 'ns-rem-row';
      // 🔴 老项目 v5.42：行内容用**裸文本节点**（span 元素盒被国产浏览器夜间模式吃字）
      row.appendChild(document.createTextNode(fmtChipTime(r.at) + (r.text ? `　${escapeTruncPlain(r.text, 40)}` : '')));
      const off = document.createElement('button');
      off.type = 'button';
      off.className = 'ns-rem-off';
      off.textContent = COPY.remCancelGlyph;
      off.title = COPY.remCancelOne;
      off.addEventListener('click', () => {
        this.host.setDoc(removeReminder(this.host.getDoc(), r.id));
        this.showPanel();
        this.schedule();
      });
      row.appendChild(off);
      list.appendChild(row);
    }
    // 🔴🔴 无提醒时**不渲染任何空态文案**（老项目 renderRemPanel 一带根本没有这层）。
    //   这里曾经凭空加了一句「还没有设置提醒」—— 面板空着本来就自明，
    //   多这一行既是老项目里不存在的东西（违反"用户可见层逐字复刻"这条硬约束），
    //   又把「设置行」与「已设列表」之间的留白切掉一截，弹窗高度都跟着变了。
    this.mask.classList.remove('hidden');
    // 🔴🔴 滚轮定位必须在 mask 摘掉 hidden **之后**（老项目 v5.55 resetWheelScroll 同款，
    //   原文注释：「display:none 内 scrollTop 无效，必须显示后设置」）。
    //   症状是用户报的第6 条「提醒弹窗默认时间不对」：dataset.val 已经是当前 +5 分钟，
    //   但滚轮的可视位置还停在 00:00 —— **值对、显示不对**，最容易被当成"随机"，
    //   而且点一下滚轮就"跳"到正确值，更显得莫名其妙。
    //   顺序反过来（先定位再显示）等于什么都没做，且不报错。
    this.resetWheelScroll();
    // 🔴 事项输入框默认聚焦（用户报障第 1 条「默认没有聚焦在事项文本框」）。
    //   同样必须**在摘掉 hidden 之后**：display:none 的输入框 focus() 是 no-op，
    //   与 scrollTop 同款陷阱（且症状一样是"看着没聚焦、点一下又好了"）。
    //   用 preventScroll：老项目 v5.43/v5.55 记过触屏自动聚焦会弹软键盘把视口压扁、
    //   居中弹窗偏位（index.html bakPass focus 那条同款纪律）。
    try {
      item.focus({ preventScroll: true });
    } catch {
      // 老内核不支持 options：退化为无参 focus（弹窗仍会聚焦，只是可能带滚动）
      try { item.focus(); } catch { /* 聚焦失败不影响功能 */ }
    }
  }

  /**
   * 滚轮滚到当前值（老项目 resetWheelScroll）。
   * 🔴 用 dataset.val 而不是重新构造时的入参：值以 dataset 为唯一事实源（v5.55），
   *   用户手动调过之后重开面板，滚轮必须停在他上次调的位置，而不是重置回 +5 分钟。
   */
  private resetWheelScroll(): void {
    this.wheels.forEach((wh) => {
      const v = Number(wh.dataset.val);
      if (!Number.isFinite(v)) return;
      try {
        wh.scrollTop = v * REM_WHEEL_ITEM_H;
      } catch {
        // jsdom / 无布局环境写不进 scrollTop —— dataset 已是唯一事实源，测试靠它
      }
    });
  }

  /**
   * 时/分滚轮。
   * 🔴 值以 `dataset.val` 为唯一事实源（老项目 v5.55）——
   *   jsdom/无布局环境下 scrollTop 写不进去，只有 dataset 可靠，测试才测得动。
   */
  private wheels = new Map<string, HTMLDivElement>();

  private makeWheel(seg: 'hh' | 'mm', max: number, val: number): { wrap: HTMLDivElement } {
    const wrap = document.createElement('div');
    wrap.className = 'ns-rem-wheel-wrap';
    const wh = document.createElement('div');
    wh.className = 'ns-rem-wheel ns-rem-wheel-' + seg;
    wh.setAttribute('role', 'listbox');
    wh.setAttribute('aria-label', seg === 'hh' ? COPY.remWheelHhAria : COPY.remWheelMmAria);
    wh.tabIndex = 0;
    wh.dataset.val = String(val);
    wh.dataset.max = String(max);
    const pad = document.createElement('div');
    pad.className = 'ns-rem-wheel-pad';
    wh.appendChild(pad.cloneNode(false));
    for (let i = 0; i <= max; i += 1) {
      const it = document.createElement('div');
      it.className = 'ns-rem-wheel-it' + (i === val ? ' cur' : '');
      it.textContent = String(i).padStart(2, '0');
      it.dataset.i = String(i);
      wh.appendChild(it);
    }
    wh.appendChild(pad.cloneNode(false));
    wh.addEventListener('scroll', () => {
      const v = Math.max(0, Math.min(max, Math.round(wh.scrollTop / REM_WHEEL_ITEM_H)));
      wh.dataset.val = String(v);
      wh.querySelectorAll('.ns-rem-wheel-it').forEach((el) => el.classList.toggle('cur', Number((el as HTMLElement).dataset.i) === v));
    }, { passive: true });
    wh.addEventListener('keydown', (e) => {
      const ev = e as KeyboardEvent;
      if (ev.key === 'ArrowUp' || ev.key === 'ArrowDown') {
        ev.preventDefault();
        this.setWheel(seg, this.wheelVal(seg) + (ev.key === 'ArrowUp' ? -1 : 1));
      } else if (ev.key === 'Enter') {
        ev.preventDefault();
        (this.mask.querySelector('.ns-rem-add') as HTMLElement | null)?.click();
      }
    });
    wh.addEventListener('click', (e) => {
      const t = (e.target as HTMLElement).closest('.ns-rem-wheel-it') as HTMLElement | null;
      if (t && t.dataset.i !== undefined) this.setWheel(seg, Number(t.dataset.i), true);
    });
    wrap.appendChild(wh);
    const mid = document.createElement('div');
    mid.className = 'ns-rem-wheel-mid';
    wrap.appendChild(mid);
    this.wheels.set(seg, wh);
    return { wrap };
  }

  private wheelVal(seg: 'hh' | 'mm'): number {
    const el = this.wheels.get(seg);
    return el ? Number(el.dataset.val) : Number.NaN;
  }

  private setWheel(seg: 'hh' | 'mm', v: number, smooth = false): void {
    const el = this.wheels.get(seg);
    if (!el) return;
    const max = Number(el.dataset.max ?? '59');
    const c = Math.max(0, Math.min(max, Math.round(v)));
    el.dataset.val = String(c);
    const top = c * REM_WHEEL_ITEM_H;
    try {
      if (smooth && el.scrollTo) el.scrollTo({ top, behavior: 'smooth' });
      else el.scrollTop = top;
    } catch {
      el.scrollTop = top;
    }
    el.querySelectorAll('.ns-rem-wheel-it').forEach((x) => x.classList.toggle('cur', Number((x as HTMLElement).dataset.i) === c));
  }

  /* ==================== 生命周期 ==================== */

  /** 面板里点添加后回写正文一行「时间　事项」（老项目 insertRemLine）。 */
  static insertLine(at: number, text: string): string {
    return COPY.remInsertLine(fmtRemInsert(at), text);
  }

  destroy(): void {
    if (this.timer !== undefined) window.clearTimeout(this.timer);
    this.timer = undefined;
    this.chip.remove();
    this.card.remove();
    this.mask.remove();
  }
}

/* ---------------- 小工具 ---------------- */

/**
 * 光标落点信息：**所在根级块的纯文本 + 块内偏移**。
 *
 * 🔴🔴🔴 逐字对应老项目 `caretInfoInEditor()`（index.html:6305）。这是本项目
 *   提醒 chip 能不能"事项不跨行"的**唯一决定性结构**，不是可选优化。
 *
 * 为什么必须是块级（量化实测，390×844 真浏览器）：
 *   输入「2027-3-1 10:00　买菜和水果 ↵ 第二行文字 ↵ 第三行文字」，
 *   光标停在第一行时间串上时——
 *     全编辑器 textContent = "2027-3-1 10:00买菜和水果第二行文字第三行文字"
 *       ⇒ itemForChip 的 end 回退到 text.length ⇒ 事项 = "买菜和水果第二行文字第三行文字"❌
 *     块级 textContent     = "2027-3-1 10:00　买菜和水果"
 *       ⇒ 事项 = "买菜和水果" ✅（与老项目实测逐字一致）
 *
 * 两个必须与老项目一致的实现细节：
 *   ① 偏移用 `Range.selectNodeContents(block)` + `setEnd` 再 `.toString().length`
 *      —— 与 `block.textContent` **同源**。若改用全局偏移，跨块就错位。
 *   ② **裸文本节点兜底**：光标落在"直接挂在 root 下的裸文本"里时，
 *      往上找不到块（老项目 v5.57 修的就是这个：症状是"有时候不弹 chip"）。
 *      此时用该节点自身文本 + 节点内偏移。
 *
 * @param root 编辑器根元素
 * @param node 光标所在 DOM 节点（通常是文本节点）
 * @param nodeOffset 该节点内的偏移
 * @returns 块级文本与块内偏移；光标不在 root 内 / 找不到块时返回 null
 */
export function caretInfoIn(
  root: HTMLElement,
  node: Node,
  nodeOffset: number,
): { text: string; offset: number } | null {
  if (!root.contains(node)) return null;

  // ① 裸文本兜底（老项目 v5.57）
  if (node.nodeType === 3 && node.parentNode === root) {
    return { text: (node as Text).data || '', offset: nodeOffset };
  }

  // ② 往上找到"直接挂在 root 下的那一层块"
  let block: Node | null = node.nodeType === 3 ? node.parentNode : node;
  while (block && block.parentNode !== root) block = block.parentNode;
  if (!block || block === root) return null;

  // ③ 块内偏移：Range 展开，与 block.textContent 同源
  let offset: number;
  try {
    const pre = document.createRange();
    pre.selectNodeContents(block);
    pre.setEnd(node, nodeOffset);
    offset = pre.toString().length;
  } catch {
    return null;
  }
  return { text: block.textContent || '', offset };
}

/** 纯文本截断（进的是 textContent，不拼 HTML，所以不需要 HTML 转义）。 */
function escapeTruncPlain(s: string, n: number): string {
  return s.length <= n ? s : s.slice(0, n - 1) + '…';
}

/** 供外部（e2e）读取 chip 可见性。 */
export function chipVisible(root: HTMLElement = document.body): boolean {
  const el = root.querySelector('#timeChip');
  return !!el && !el.classList.contains('hidden');
}
