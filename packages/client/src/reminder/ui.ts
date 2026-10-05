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
import { fmtLate, fmtRelDay, fmtRemInsert, fmtRemTime, itemForChip, matchAtCaret } from '../reminder/format.ts';
import { addReminder, removeReminder, upcomingReminders, dueReminders } from './reconcile.ts';
import type { Doc } from '@bj/shared-schema';

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
    el.className = 'ns-timechip';
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
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0) return this.hideChip();
    const range = sel.getRangeAt(0);
    // 🔴 只在编辑器内部的光标才响应：选区落在菜单/输入框里时不该浮 chip
    if (!editable.contains(range.startContainer)) return this.hideChip();
    const offset = this.offsetWithin(editable, range.startContainer, range.startOffset);
    if (offset < 0) return this.hideChip();
    const text = editable.textContent ?? '';
    const m = matchAtCaret(text, offset, Date.now());
    if (!m) return this.hideChip();
    this.showChip(m, itemForChip(text, m, Date.now()));
  }

  /**
   * 把 DOM 位置换算成编辑器纯文本里的字符偏移。
   *
   * 🔴🔴 用 `Range.toString()` 而不是 `textContent.indexOf(node.textContent)`：
   *   同一段文字在文档里出现两次时 indexOf 会返回第一处，于是光标在第二处
   *   却被算成第一处 —— 表现为"点第二个时间串，加的却是第一个的提醒"。
   *
   * 🔴 偏移必须与 matchAtCaret 吃的那个 text 是**同一个串**。
   *   这里用 Range 展开（等价于 textContent 的 DOM 顺序），调用方也必须传
   *   `editable.textContent` —— 两处口径不一致时偏移会整体错位，
   *   症状是"光标明明在时间串上，chip 不出现"。
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

  private showChip(m: { at: number; index: number; length: number }, item: string): void {
    const time = fmtRemTime(m.at);
    this.chip.textContent = '';
    const hd = document.createElement('div');
    hd.className = 'ns-chip-hd';
    const rel = document.createElement('span');
    rel.className = 'ns-chip-rel';
    rel.textContent = fmtRelDay(m.at, Date.now());
    const clock = document.createElement('span');
    clock.className = 'ns-chip-clock';
    clock.textContent = time;
    hd.appendChild(rel);
    hd.appendChild(clock);
    const it = document.createElement('div');
    it.className = 'ns-chip-item';
    // 🔴 截断只落在事项行：老项目 v7.8.0 定的规矩（CTA 恒完整可见可点）
    it.textContent = item ? escapeTruncPlain(item, 30) : '';
    const cta = document.createElement('div');
    cta.className = 'ns-chip-cta';
    cta.textContent = COPY.remChipAdd;
    this.chip.appendChild(hd);
    if (item) this.chip.appendChild(it);
    this.chip.appendChild(cta);
    this.chip.dataset.at = String(m.at);
    this.chip.classList.remove('hidden');
  }

  private hideChip(): void {
    this.chip.classList.add('hidden');
  }

  private chipActivate(): void {
    const at = Number(this.chip.dataset.at ?? '');
    if (!Number.isFinite(at) || at <= 0) return;
    const d = this.host.getDoc();
    const item = this.chip.querySelector('.ns-chip-item');
    const text = item && item.textContent ? item.textContent : '';
    this.host.setDoc(addReminder(d, at, text).doc);
    this.hideChip();
    this.showChipAdded(at, text);
  }

  /** 点添加后就地变两行确认卡（老项目 v5.45 行为）。 */
  private showChipAdded(at: number, text: string): void {
    this.chip.textContent = '';
    const head = document.createElement('div');
    head.className = 'ns-chip-cta ns-chip-done';
    head.textContent = COPY.remChipAdded;
    const when = document.createElement('div');
    when.className = 'ns-chip-hd';
    when.textContent = `${fmtRelDay(at, Date.now())} ${fmtRemTime(at)}`;
    this.chip.appendChild(head);
    this.chip.appendChild(when);
    if (text) {
      const it = document.createElement('div');
      it.className = 'ns-chip-item';
      it.textContent = text;
      this.chip.appendChild(it);
    }
    this.chip.classList.remove('hidden');
    window.setTimeout(() => this.hideChip(), 1600);
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
      t.textContent = fmtRemTime(r.at) + (r.text ? `　${escapeTruncPlain(r.text, 40)}` : '');
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
   */
  schedule(): void {
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
    this.timer = window.setTimeout(() => this.schedule(), wait);
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
        // 已过/无效：accent 提示，不设（老项目只闪红框；这里给一句可读的）
        dateInp.classList.add('ns-bad');
        hh.wrap.classList.add('ns-bad');
        mm.wrap.classList.add('ns-bad');
        const tip = document.createElement('div');
        tip.className = 'ns-rem-tip';
        tip.textContent = COPY.remPastTip;
        form.appendChild(tip);
        window.setTimeout(() => {
          dateInp.classList.remove('ns-bad');
          hh.wrap.classList.remove('ns-bad');
          mm.wrap.classList.remove('ns-bad');
          tip.remove();
        }, 1500);
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
      row.appendChild(document.createTextNode(fmtRemTime(r.at) + (r.text ? `　${escapeTruncPlain(r.text, 40)}` : '')));
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
    if (up.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'ns-rem-empty';
      empty.textContent = COPY.remEmpty;
      list.appendChild(empty);
    }
    this.mask.classList.remove('hidden');
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

/** 纯文本截断（进的是 textContent，不拼 HTML，所以不需要 HTML 转义）。 */
function escapeTruncPlain(s: string, n: number): string {
  return s.length <= n ? s : s.slice(0, n - 1) + '…';
}

/** 供外部（e2e）读取 chip 可见性。 */
export function chipVisible(root: HTMLElement = document.body): boolean {
  const el = root.querySelector('#timeChip');
  return !!el && !el.classList.contains('hidden');
}
