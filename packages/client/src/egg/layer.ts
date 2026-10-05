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
import { buildSound, type Sound } from './sound.ts';
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
  shell: Shell;
  sound: Sound;
  /** 图鉴是否开着。codex 对象是模块私有的，外部要判只能走这里。 */
  codexOpen: () => boolean;
  dispose: () => void;
}

export function buildEggLayer(host: HTMLElement, store: EggStore, h: EggHost): EggLayer {
  const sound = buildSound();
  const shell = buildShell(sound, {
    onClosed: () => h.onGameClosed?.(),
  });

  /** 门牌 → 游戏定义。**必须覆盖全部 10 个门牌**（有单测钉）。 */
  const defs: Record<string, () => AnyGame> = {
    mirror: () => mirrorGame(),
    snake: () => snakeGame(() => ({ body: h.bodyText(), favs: h.favs(), cur: h.curNote() })),
    dragon: () => dragonGame(() => ({ body: h.bodyText(), favs: h.favs() })),
    brick: () => brickGame(() => ({ body: h.bodyText(), favs: h.favs() })),
    satoshi: () => satoshiGame(),
    bitcoin: () => bitcoinGame(),
    tank: () => tankGame(() => ({ body: h.bodyText(), favs: h.favs(), cur: h.curNote() })),
    spacex: () => spacexGame(),
    tesla: () => teslaGame(() => ({ body: h.bodyText(), favs: h.favs() })),
    pet: () => petGame(),
  };

  const codex: Codex = buildCodex(host, store, {
    onReplay: (id) => {
      codex.close();
      openByRoute(id);
    },
    onClosed: () => h.refocus(),
    // 🔴 图鉴打开即暂停正在跑的游戏（老项目 nsEggOpen 同款）：
    //   不暂停的话后台 rAF 继续跑，用户在看图鉴时分数已经变了。
    onPauseGame: () => {
      if (shell.isOpen()) shell.pause(true);
    },
  });

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
    sound.voice(key);
    shell.launch(make());
    return true;
  }

  function openCodex(): void {
    codex.open();
  }

  function bindTriggers(): void {
    // 条件触发 1/2：正文里的数字梗与 notesync。
    // 判据放在**词表纯函数**里（见 registry.numGagsIn / hasFireworkWord），
    // 这里只负责撒粒子与标记。
    let lastFw = 0;
    const scan = (text: string): void => {
      if (text === '') return;
      // 数字梗
      if (markDiscovered(store, 'num', text.length > 0 && /(?<![\d.])(666|520|1314|888|6666)(?![\d.])/.test(text))) {
        // 🔴 id 是 `#editor-host`（见 ui/shell.ts）。写错成 nsEditor 时
        //   getElementByRect 恒为 null，粒子会撒到窗口正中而不是编辑器上方，
        //   而getBoundingClientRect 的 null 分支是静默的 —— 不报错，只是位置不对。
        const ed = document.getElementById('editor-host');
        const r = ed?.getBoundingClientRect();
        burst(r ? r.left + r.width / 2 : window.innerWidth / 2, r ? Math.max(56, r.bottom - 120) : 120, '🔥', 14);
      }
      // notesync 烟花（600ms 节流：一次输入可能命中多次判定）
      const now = performance.now();
      if (now - lastFw > 600 && /notesync/i.test(text)) {
        lastFw = now;
        if (markDiscovered(store, 'fw', true)) {
          firework(window.innerWidth / 2, window.innerHeight / 2);
        }
      }
    };
    (h as unknown as { __scanEggs?: (t: string) => void }).__scanEggs = scan;

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
    shell,
    sound,
    dispose: () => {
      shell.close(false);
      clearFx();
    },
    codexOpen: () => codex.isOpen(),
  };
}

/** 让main.ts 在 update 回调里能扫正文触发条件。 */
export function scanEggTriggers(layerHost: unknown, text: string): void {
  const scan = (layerHost as { __scanEggs?: (t: string) => void } | null)?.__scanEggs;
  if (scan) scan(text);
}

export { eggById };
