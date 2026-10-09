/**
 * 彩蛋层总装 —— 路由 + 触发点 + 图鉴 + 外壳
 *
 * 🔴🔴 这个文件是彩蛋层的**唯一入口**。它负责：
 *   1. 把「门牌id」映射到游戏定义（映射不出来的**必须给提示**，绝不静默白屏）
 *   2. 提供三个入口：`openByRoute`（路由/图鉴 replay）、
 *      `openCodex`（?eggs / 菜单）、`bindTriggers`（正文词表等条件触发）
 *   3. 标记发现记录（幂等，见 registry.markDiscovered）
 *
 * 🔴 触发点绑在**编辑器的 update 事件**上而不是按键事件上：
 *   按键事件拿不到"最终文本"（输入法组字中），而 update 拿到的是已提交的真源。
 *   代价是每次输入都跑一遍词表判定 —— 所以**必须靠 markDiscovered 的幂等**
 *   拦住重复写盘（见 registry.ts的 EGG-07）。
 */

import { COPY } from '../ui/copy.ts';
import { doorOf, eggById, markDiscovered, type EggStore } from './registry.ts';
import { buildCodex, type Codex } from './codex.ts';
import { buildShell, type AnyGame, type Shell } from './shell.ts';
import { bindEggWordTrigger, caretCtx, type EggWordBinding } from './word-trigger.ts';
import { buildGagLatch, fwFire, gagFire, GAG_TAIL_WINDOW } from './gag.ts';
import { buildSound, type Sound } from './sound.ts';
import { adoptPet, mountPet } from './pet.ts';
import { burst, clearFx, firework, isFestival, rain, showBadge } from './fx.ts';
import {
  bitcoinGame,
  brickGame,
  dragonGame,
  mirrorGame,
  petGame,
  satoshiGame,
  snakeGame,
  spacexGame,
  tankGame,
  teslaGame,
} from './games.ts';

export interface EggHost {
  /** 正文纯文本（供砖面/蛇身抽词）。 */
  bodyText: () => string;
  /** 本机收藏（词不够时兜底）。 */
  favs: () => string[];
  /** 当前笔记名。 */
  curNote: () => string;
  /** 打开图鉴后归还焦点的动作。 */
  refocus: () => void;
  /**
   * 🔴🔴 **非游戏彩蛋的 replay 出口**（老项目 `NS_EGG_LIST` 里 `type` / `diag` 的 `replay`）。
   *
   *   为什么它们不在 `defs` 里：`defs` 的值类型是 `() => AnyGame`
   *   （canvas 游戏或 DOM 游戏），而 `type`（打一声回车铃）与 `diag`（开诊断模态）
   *   **都不是游戏** —— 它们没有游戏可开。硬塞进 `defs` 的后果是
   *   `shell.launch()` 拿到一个不是游戏的对象，症状是"点再玩一次 → 画面变空白"，
   *   而且**零报错**。
   *
   *   老项目把它们放在 `NS_EGG_LIST` 的 `replay` 字段里（`index.html:6886-6887`：
   *   `type` → `nsTypeSound('enter', true)`、`diag` → `openDiagModal()`），
   *   与门牌游戏那张表是**两张表**。bj 照抄这个形状。
   *
   *   @param id 彩蛋 id（`type` / `diag`）
   * @returns 是否处理了（未注册的非游戏 id 返回 false，调用方据此提示"正在赶来的路上"）
   */
  replaySide: (id: string) => boolean;
  /**
   * 游戏外壳拆干净后回调（门牌路径退出时用来重画落地页）。
   *
   * 🔴 独立于 refocus：归还焦点对**编辑器里开的游戏**（菜单→桌宠）是对的，
   *   但门牌路径进来时根本没有编辑器，focus 到不存在的元素上等于什么都不做，
   *   页面会一直空白。
   */
  onGameClosed?: () => void;
}

export interface EggLayer {
  /** 按门牌 id 打开。**未知 id 会给可见提示并返回 false**，绝不静默。 */
  openByRoute: (id: string) => boolean;
  /** 当前路径是否是门牌（给路由层用）。 */
  doorOfPath: () => string;
  /** 打开图鉴。 */
  openCodex: () => void;
  /** 绑定条件触发（正文数字梗/ notesync、节日雨/徽章）。 */
  bindTriggers: () => void;
  /**
   * 条件触发的扫描入口 —— main.ts 在编辑器 update 回调里调它。
   *
   * 🔴🔴 为什么必须是**本返回对象上的一个方法**，而不是往外部传进来的 hooks 上挂
   *   `__scanEggs`：调用方 `scanEggTriggers` 收到的是**这个返回对象**，
   *   而那个 hooks（`buildEggLayer` 的第三个参数）是 main.ts 的一**临时字面量**、
   *   外面根本不持有引用 ⇒ 扫描函数永远取不到 ⇒
   *   "数字梗 / notesync 烟花一次都没放过"，而且**零报错**（catch 全吞了）。
   *   这是本次"没有老版本那种动效"最靠前的那个根因。
   */
  scanEggs: () => void;
  /**
   * 绑定正文彩蛋词表触发（敲 `/dragon` 弹确认层）。
   *
   * 🔴 为什么要**单独**一个入口而不是塞进 `bindTriggers`：
   *   `bindTriggers` 绑的是**条件触发**（数字梗/烟花），判据跑在
   *   编辑器 update 的真源文本上；词表触发需要的是**光标位置**，
   *   必须在 root DOM 上挂 beforeinput / compositionend 监听。
   *   两者触发时机与依赖完全不同，混在一个函数里会让人以为
   *   「挂上 bindTriggers 词表就能用」—— 而漏调这个的后果是
   *   **用户敲 /dragon 永远不弹，且零报错**（正是本次报障）。
   */
  bindWordTrigger: (root: HTMLElement) => void;
  /** 词表确认浮层是否开着（给 e2e 钩子）。 */
  wordAskOpen: () => boolean;
  /** 词表确认浮层当前展示的蛋 id（空串 = 没展示）。 */
  wordAskId: () => string;
  /**
   * 非游戏彩蛋的 replay（`type` / `diag`）。**图鉴「再玩一次」与门牌都走它。**
   *
   * 🔴 为什么要独立出口而不是塞进 `openByRoute`：`openByRoute` 的语义是
   *   "开一个游戏外壳"，而 `type` / `diag` 不开外壳。若混进去，
   *   映射缺失分支会 `history.pushState('/')` —— 而这两个压根不是门牌，
   *   它们该留在原地。所以单独一张表、单独一个出口（老项目 `NS_EGG_LIST`
   *   的 `replay` 字段与 `defs` 本来就是两张表）。
   */
  replaySide: (id: string) => boolean;
  shell: Shell;
  sound: Sound;
  /** 图鉴是否开着。codex 对象是模块私有的，外部要判只能走这里。 */
  codexOpen: () => boolean;
  dispose: () => void;
}

export function buildEggLayer(host: HTMLElement, store: EggStore, h: EggHost): EggLayer {
  const sound = buildSound();
  /** 词表触发绑定句柄。`bindWordTrigger` 可被重复调，故存起来以便先解绑。 */
  let wordBinding: EggWordBinding | undefined;
  /** 条件触发的扫描函数。`bindTriggers()` 里赋值，经 `scanEggs` 暴露给 main.ts。 */
  let eggScan: (() => void) | undefined;
  const shell = buildShell(sound, {
    onClosed: () => h.onGameClosed?.(),
  });

  /** 门牌 → 游戏定义。**必须覆盖全部 10 个门牌**（有单测钉）。 */
  const defs: Record<string, () => AnyGame> = {
    mirror: () => mirrorGame(),
    snake: () => snakeGame(() => ({ body: h.bodyText(), favs: h.favs(), cur: h.curNote() })),
    // 🔴 `cur`（当前笔记名）是dragon 开场站牌「未命名笔记 · N 字」的素材
    //   （老项目 :11801 `title().length * 128`）。漏传则站牌恒显示「未命名笔记」。
    dragon: () => dragonGame(() => ({ body: h.bodyText(), favs: h.favs(), cur: h.curNote() })),
    brick: () => brickGame(() => ({ body: h.bodyText(), favs: h.favs() })),
    satoshi: () => satoshiGame(),
    // 🔴 老项目 /bitcoin 的金块面上印的是**你的笔记名**（`names()` 抽收藏/待办），
    //   所以这里必须把 favs 传进去，否则金块只能显示内置兜底词。
    bitcoin: () => bitcoinGame(() => ({ favs: h.favs() })),
    tank: () => tankGame(() => ({ body: h.bodyText(), favs: h.favs(), cur: h.curNote() })),
    spacex: () => spacexGame(),
    tesla: () => teslaGame(() => ({ body: h.bodyText(), favs: h.favs() })),
    pet: () => petGame(),
  };

  /**
   * 🔴🔴 非游戏彩蛋 id 全集。**必须与 `EggHost.replaySide` 的实现对齐。**
   *
   * 为什么要这张表而不是直接把 `replaySide` 塞进 `defs`：
   * `defs` 的值类型是 `() => AnyGame`，而这两个不是游戏（见 EggHost.replaySide 注释）。
   * 另立一张表后，`openByRoute` 的"映射缺失 ⇒ 提示 + 落地页"这条路径**不会**
   * 被它们误触发 —— 它们 `door: false`，本来就不该走门牌路由。
   */
  const SIDE_EGGS = ['type', 'diag'] as const;

  const codex: Codex = buildCodex(host, store, {    onReplay: (id) => {
      codex.close();
      // 🔴🔴 先试非游戏表再试门牌：`type` / `diag` 不开游戏外壳，
      //   而 openByRoute 的映射缺失分支会 `pushState('/')` 把用户踢回落地页。
      //   顺序反了的话图鉴里点「打字机音 / 诊断面板」的「再玩一次」
      //   会把用户丢回落地页 —— 而这两个蛋恰恰**不是门牌**，它们该留在原地。
      if (replaySide(id)) return;
      openByRoute(id);
    },
    onClosed: () => h.refocus(),
    // 🔴 图鉴打开即暂停正在跑的游戏（老项目 nsEggOpen 同款）：
    //   不暂停的话后台 rAF 继续跑，用户在看图鉴时分数已经变了。
    onPauseGame: () => {
      if (shell.isOpen()) shell.pause(true);
    },
  });

  /**
   * 非游戏彩蛋的 replay（老项目 `NS_EGG_LIST` 的 `replay` 字段）。
   *
   * 🔴 埋点放在**调用之后**：老项目 :8219 的 `nsEggUnlock('diag')` 是
   *   openDiagModal 的第一行（同款），但 `type` 的 replay
   *   （`nsTypeSound('enter', true)`）**不埋点** —— 它埋点在打字机音真正响的那一刻
   *   （sound.ts 侧 `Sound.type()` 返回 true 时），因为图鉴点播这一次
   *   不代表用户"在复古皮肤里敲了键盘"。
   */
  function replaySide(id: string): boolean {
    const key = id.toLowerCase();
    if ((SIDE_EGGS as readonly string[]).indexOf(key) < 0) return false;
    // 🔴🔴 埋点必须在**确认处理成功之后**：宿主实现万一不认这个 id
    //   （返回 false），用户点了「再玩一次」什么也没发生 ——
    //   此时若已写进发现记录，图鉴就会把这枚蛋标成"已发现"，
    //   而用户永远没见到过它。老项目是"解锁 + 执行"写在一起，
    //   bj 把这两件事分开正是为了不让记录领先于事实。
    if (!h.replaySide(key)) return false;
    markDiscovered(store, key, true);
    return true;
  }

  function openByRoute(id: string): boolean {
    const key = id.toLowerCase();
    // 🔴🔴 进游戏先关图鉴：不关的话图鉴的 z90 盖在游戏之上，
    //   用户看到的是"点了一下没反应"（行被图鉴挡住了）。
    if (codex.isOpen()) codex.close();
    const make = defs[key];
    if (!make) {
      //🔴 映射缺失必须**可见**：老项目的做法是直接 return，
      //   于是"某个门牌没实现"表现为空白编辑器 —— 用户以为笔记空了。
      //   这里显式回落地页并给一句提示。
      const note = COPY.eggMissing(id);
      // eslint-disable-next-line no-console
      console.warn('[notesync] 彩蛋未实现：' + key, note);
      history.pushState({}, '', '/');
      return false;
    }
    if (defs[key]) markDiscovered(store, key, true);
    // 🔴🔴 访问 /pet 即**领养**（老项目 index.html:11348
    //   `PET.adopted = true; … setTimeout(petMount, 60)`）。
    //   老项目的桌宠是「默认关、不领养就永远不出现」—— 少了这一句，
    //   顶栏那只常驻螃蟹就永远挂不上（用户报障「螃蟹在顶栏爬行」的一半根因）。
    //   挂载放在 openByRoute 之后：此刻 header 已在 DOM 里，且用户已经离开菜单。
    if (key === 'pet') {
      adoptPet();
      mountPet(() => sound.voice('pet'));
    }
    sound.voice(key);
    shell.launch(make());
    return true;
  }

  function openCodex(): void {
    codex.open();
  }

  function bindTriggers(): void {
    /**
     * 条件触发 1/2：正文里的数字梗与 notesync。
     *
     * 🔴🔴 判定面是**光标前缀**（老项目 `nsCaretPrefix` + `nsDigitHit` / `nsFwHit`），
     *   不是"整篇包含"：整篇包含会让"打开一篇本来就有 1314 的笔记"也爆一次，
     *   而老项目只在**打字**时才判定（它挂在 document 的 input 事件上）。
     *   判定逻辑本身在纯函数层 `gag.ts`（node 里可单测），这里只负责撒粒子与记账。
     *
     * 🔴🔴 动效由**跳变闩锁**驱动（每次成梗都放）；`markDiscovered` 只负责图鉴记账、
     *   **不再门控视觉** —— 那道门控正是"第一次之后再也没见过动效"的根因。
     *   （老项目里 nsBurst/nsFirework 与 nsEggUnlock 本就是两件互不相干的事。）
     */
    const numLatch = buildGagLatch();
    const fwLatch = buildGagLatch();
    const scan = (): void => {
      try {
        const root = document.getElementById('editor-host');
        if (!root) return;
        const out: { rect: DOMRect | null } = { rect: null };
        const ctx = caretCtx(root, out);
        // 拿不到光标（无选区 / 光标不在编辑器内）：不爆，也不动闩锁
        if (!ctx) return;
        // 🔴 还框选着：老项目铁律，绝不打扰（caretCtx 用哨兵 \u0000SEL 表达）
        if (ctx.pre === '\u0000SEL') return;
        const tail = ctx.pre.slice(-GAG_TAIL_WINDOW);
        const emo = gagFire(numLatch, tail);
        if (emo) {
          markDiscovered(store, 'num', true); // 只记账，不门控
          const r = out.rect;
          // 老项目 :5448-5451：从光标处冒；拿不到光标矩形才退回编辑器上方
          burst(r ? r.left : window.innerWidth / 2, r ? Math.max(56, r.bottom - 6) : 120, emo, 5);
        }
        if (fwFire(fwLatch, tail)) {
          markDiscovered(store, 'fw', true);
          const r = out.rect;
          firework(r ? r.left : window.innerWidth / 2, r ? Math.max(56, r.bottom - 6) : 120);
        }
      } catch {
        /* 氛围层：不许它把编辑流程带崩（老项目整段 try/catch 同款） */
      }
    };
    // 🔴 挂到本层闭包里、经返回对象的 `scanEggs` 暴露 —— **不再**挂到外部传进来的
    //   hooks 对象 `h` 上：那个对象调用方拿不到，挂上去等于没挂（见 EggLayer.scanEggs 注释）。
    eggScan = scan;

    // 条件触发 3/4：节日雨 + 节日/深夜徽章（启动时判一次）。
    const now = new Date();
    if (showBadge(now)) markDiscovered(store, 'badge', true);
    if (isFestival(now)) {
      if (markDiscovered(store, 'rain', true)) rain(4000);
    }
  }

  return {
    openByRoute,
    doorOfPath: () => doorOf(location.pathname.replace(/^\/+|\/+$/g, '')),
    openCodex,
    bindTriggers,
    scanEggs: () => {
      eggScan?.();
    },
    bindWordTrigger: (root: HTMLElement) => {
      // 🔴 幂等：main.ts 的挂载路径与热重载都可能调第二次，重复绑定会让
      //   一次击键弹两层确认层（用户看到两个「进入」按钮）。
      wordBinding?.dispose();
      wordBinding = bindEggWordTrigger(root, {
        launch: openByRoute,
        refocus: h.refocus,
      });
    },
    wordAskOpen: () => wordBinding?.isOpen() ?? false,
    wordAskId: () => wordBinding?.showingId() ?? '',
    replaySide,
    shell,
    sound,
    dispose: () => {
      wordBinding?.dispose();
      wordBinding = undefined;
      shell.close(false);
      clearFx();
    },
    codexOpen: () => codex.isOpen(),
  };
}

/**
 * 让 main.ts 在 update 回调里触发条件彩蛋（数字梗 / notesync 烟花）。
 *
 * 🔴 不再接收"整篇正文"：判定面改成光标前缀（见上面 `scan` 的注释），
 *   由 `scan` 自己从编辑器取，避免调用方与判定面对不上。
 */
export function scanEggTriggers(layerHost: unknown): void {
  const scan = (layerHost as { scanEggs?: () => void } | null)?.scanEggs;
  if (scan) scan();
}

export { eggById };
