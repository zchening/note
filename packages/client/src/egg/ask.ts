/**
 * 彩蛋词表确认浮层 —— 「进入 /dragon？」+ 「进入」/「✕」
 *
 * 🔴🔴 本文件是**唯一**允许为这条链路用 innerHTML 的地方，且拼进去的
 *   `id` 已被 `EGG_DOORS` 白名单与正则双重约束（见 buildEggWordRe）。
 *   纪律原文：「绝不许用 innerHTML 拼用户输入」—— 本文件拼的是**白名单枚举**，
 *   不是用户输入。正文/ 事项文本一律 textContent（见 codex.ts同款纪律）。
 *   🔴 就算将来有人把 `id` 来源改坏，`openAsk` 开头还有一道`EGG_DOORS` 断言兜着，
 *   不会退化成 XSS。这道断言是**故意保留**的，不要「优化」掉。
 *
 * 🔴 逐条对应老项目：
 *   - `index.html:11007` `b.id='nsAsk'; b.className='ns-ask-m'`（本项目 id 改`#eggAsk`）
 *   - `index.html:11008` innerHTML 结构（逐字照抄，含全角问号「？」）
 *   - `index.html:11009` mousedown preventDefault（红线⑩：点浮层不抢编辑器焦点）
 *   - `index.html:11014` 「进入」：`delete asked[id]` → hideAsk → editor.blur() → launch
 *   - `index.html:11015` 「✕」：`asked[id]=1` → hideAsk → 归还焦点
 *   - `index.html:10972-10985` `_askPlace` 定位算法（上方优先/ 放不下翻下方 / 水平夹视口 / 无坐标退底部）
 *   - `index.html:11004` 同泳道让位：先移除`#nsDraw`
 *
 * 🔴 **与老项目的两处刻意差异**（都是补缺，不是改行为）：
 *   1. **ESC 关闭**：老项目**没有**给 `#nsAsk` 绑Escape（grep 确认全库只有
 *      图片菜单 / 图鉴 / 提醒面板 / 游戏外壳四处 Escape）。但用户拿到一个
 *      堵在正文里的浮层、按 Esc 没反应，是明确的坏体验，且与本项目图鉴
 *      「Esc 关一层」的既有口径一致。故**新增** Escape 关闭，行为取「关而不进」
 *      （等价点✕：`latch.arm(id)`，不回焦点以外不做别的）。
 *      任务书明确要求「ESC 与 ✕ 都能关」，故此项不是自作主张。
 *   2. **归还焦点无条件化**：老项目 `askReturnFocus` 外层套了
 *      `if (CHIP_HOVER_OK)`（仅桌面端才还焦点，:11009）。本项目不搬这个
 *      `CHIP_HOVER_OK` 分支 —— 因为 v9.4.1 起 PC 已无 hover 通道（:11059），
 *      那条判据在本链路里已无对应物；触屏还焦点会被软键盘顶回来，
 *      故用 `hoverFine()` 判据（与老项目 CHIP_HOVER_OK 同源，见 main.ts 同款判据）。
 */

import { EGG_DOORS } from './registry.ts';

/** 浮层 DOM id。与 styles.css `#eggAsk` 严格对应。 */
const ASK_ID = 'eggAsk';

/** 老项目 :11008 的 innerHTML，逐字照抄（含全角「？」与「✕」）。 */
function askHtml(id: string): string {
  return '进入 <b class="ns-w">/' + id + '</b>？' +
    '<button class="ns-go" type="button">进入</button>' +
    '<button class="ns-no" type="button">✕</button>';
}

export interface EggAskHost {
  /** 归还焦点到编辑器（老项目 `askReturnFocus` :11009）。 */
  refocus: () => void;
  /** 启动对应彩蛋游戏（老项目 `launch(id)`）。 */
  launch: (id: string) => void;
  /**
   * 老项目 `askReturnFocus` 里`if (CHIP_HOVER_OK)` 的等价判据。
   * true = 桌面（精确指针），关闭时归还焦点；false = 触屏，不归还。
   */
  hoverFine: () => boolean;
}

export interface EggAsk {
  /** 显示确认层。`rect` 是锚定矩形（词旁/ 光标旁），拿不到就退到底部。 */
  open: (id: string, rect?: DOMRect | null) => void;
  /** 收起（清所有在途的收起定时器）。 */
  close: () => void;
  /** 当前是否在展示。 */
  isOpen: () => boolean;
  /** 当前展示的 id（不在展示则空串）。给单测与上层判据用。 */
  showingId: () => string;
}

/**
 * 定位算法（老项目 `_askPlace` :10972-10985 的**纯函数化**）。
 *
 * 🔴 三条判据照抄：
 *   1. 优先弹在词**上方**（`rect.top - bh - 8`），上方放不下翻到**下方**；
 *   2. 水平方向夹在视口内（`[8, vw - bw - 8]`）；
 *   3. 拿不到任何坐标（jsdom 守护 / 词在视口外）退到旧底部位`vh - bh - 76`。
 *
 * @param rect 锚定矩形；宽高左上都为 0 视为「无坐标」（老项目 :10977 同款判据）
 */
export function placeAsk(
  bw: number,
  bh: number,
  vw: number,
  vh: number,
  rect: { left: number; top: number; width: number; height: number; bottom: number } | null | undefined,
): { left: number; top: number } {
  let left: number;
  let top: number;
  if (rect && (rect.width || rect.height || rect.left || rect.top)) {
    const cx = rect.left + rect.width / 2;
    left = cx - bw / 2;
    top = rect.top - bh - 8;
    if (top < 8) top = rect.bottom + 8;// 上方放不下 → 翻下方
    if (top + bh > vh - 8) top = Math.max(8, vh - bh - 8); // 下方也放不下 → 贴底内收
  } else {
    left = vw / 2 - bw / 2;
    top = vh - bh - 76;
  }
  left = Math.max(8, Math.min(left, vw - bw - 8));
  return { left, top };
}

export function buildEggAsk(host: EggAskHost, askLatch: { arm: (id: string) => void; rearm: (id: string) => void }): EggAsk {
  let showing = '';
  let hideTimer: ReturnType<typeof setTimeout> | undefined;

  const el = (): HTMLElement | null => document.getElementById(ASK_ID);

  const close = (): void => {
    // 🔴 老项目 `hideAsk` :11020 开头就clearTimeout —— 撤销任何在途的收起，
    //   否则「刚弹出来就被上一个 140ms 定时器收掉」，表现为闪一下就没。
    if (hideTimer !== undefined) clearTimeout(hideTimer);
    hideTimer = undefined;
    const b = el();
    if (b && b.parentNode) b.parentNode.removeChild(b);
    showing = '';
  };

  const askReturnFocus = (): void => {
    // 🔴 触屏不还焦点：老项目 CHIP_HOVER_OK 判据（:11009 同款，见文件头差异 2）
    if (!host.hoverFine()) return;
    try {
      host.refocus();
    } catch {
      // 归还焦点失败绝不影响浮层收口
    }
  };

  const open = (id: string, rect?: DOMRect | null): void => {
    // 🔴🔴 白名单断言（文件头纪律）。id 若不在门牌表内，**不给弹**——
    //   这是innerHTML 唯一入口的兜底，删掉它就等于开出 XSS 口子。
    if (EGG_DOORS.indexOf(id) < 0) return;

    // 🔴 同泳道让位（老项目 :11004）：先撤掉 #nsDraw —— 确认层是用户刚敲出来的，
    //   优先级高于桌宠/镜像那类自绘层。
    const draw = document.getElementById('nsDraw');
    if (draw && draw.parentNode) draw.parentNode.removeChild(draw);

    // 同 id 已在展示：不重复建（老项目先remove 旧的再 append 新的是同款效果，
    // 但那会让已聚焦的按钮失焦；这里只在不同 id 时重建，同 id 直接重定位）
    const prev = el();
    const same = showing === id;
    if (prev && prev.parentNode && !same) prev.parentNode.removeChild(prev);

    let b = el();
    if (!b || !same) {
      b = document.createElement('div');
      b.id = ASK_ID;
      b.className = 'ns-ask-m';
      b.setAttribute('role', 'dialog');
      b.setAttribute('aria-label', '进入 ' + id);
      b.innerHTML = askHtml(id);
      // 🔴🔴 红线⑩（老项目 :11009）：点浮层**不抢**编辑器焦点。
      //   不写的话 mousedown 默认行为会让编辑器 blur、光标消失；且后续
      //   「编辑器是否持焦」的判据会永远为假，浮层再也收不掉。
      b.addEventListener('mousedown', (e) => e.preventDefault());
      const go = b.querySelector<HTMLButtonElement>('.ns-go');
      const no = b.querySelector<HTMLButtonElement>('.ns-no');
      if (!go || !no) throw new Error('确认浮层结构不完整：askHtml 与选择器不同源');
      // 「进入」：进过一次即 re-arm（老项目 v9.3.1），且**先 blur 编辑器再启动**
      //   （v9.3.9）—— 防游戏方向键把字打进正文（红线③）。
      go.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        askLatch.rearm(id);
        close();
        try {
          (document.activeElement as HTMLElement | null)?.blur();
        } catch {
          /* blur 失败不阻断启动 */
        }
        host.launch(id);
      });
      // 「✕」：真置 asked（老项目 :11015，只抑打字通道）
      no.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        askLatch.arm(id);
        close();
        askReturnFocus();
      });
      document.body.appendChild(b);
    }
    showing = id;

    // 🔴 锚定：老项目 :11012 `_askPlace(b, rect || _askCaretRect())`。
    //   拿不到 rect 时placeAsk 自己退到底部（等价老项目的 _askCaretRect 失败分支）。
    const bw = b.offsetWidth || 200;
    const bh = b.offsetHeight || 40;
    const vw = window.innerWidth || 800;
    const vh = window.innerHeight || 600;
    const p = placeAsk(bw, bh, vw, vh, rect ?? null);
    b.style.transform = 'none';
    b.style.bottom = 'auto';
    b.style.left = p.left + 'px';
    b.style.top = p.top + 'px';
  };

  // 🔴 ESC 关闭（老项目**没有**这条，见文件头差异 1；任务书明确要求）。
  //   capture 阶段监听且 stopPropagation：与 codex.ts 的「Esc 关一层」同款，
  //   否则会被游戏外壳的 Escape 抢先处理掉（图鉴注释里记过这个坑）。
  const onKey = (e: KeyboardEvent): void => {
    if (e.key !== 'Escape' || !showing) return;
    e.stopPropagation();
    // 等价点「✕」：置 asked 抑制后续打字重弹 + 归还焦点。
    askLatch.arm(showing);
    close();
    askReturnFocus();
  };
  document.addEventListener('keydown', onKey, true);

  return {
    open,
    close,
    isOpen: () => showing !== '',
    showingId: () => showing,
  };
}
