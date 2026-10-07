/**
 * 彩蛋音效引擎 —— WebAudio 合成器，零音频文件
 *
 * 🔴🔴 三条纪律（老项目踩过的）：
 *   1. **默认静音**。老项目就是默认静音（用户没点过就发声是骚扰，
 *      而且浏览器 autoplay 策略下第一声必然被拦，用户会以为坏了）。
 *      静音态存在 localStorage，用户主动开过才记住。
 *   2. **AudioContext 必须懒创建**，且**只在用户手势后创建**。
 *      顶层创建的 ctx 会被判 autoplay，状态是 suspended，
 *      之后 dispatch 也可能一直是静默 —— 症状是"音效设置打开着但就是没声"。
 *   3. **同类音效60ms 节流**。连射时一帧内多次 fx('shot') 会叠出爆音，
 *      且 macOS 上还会触发音频异常。
 *
 * 音色用五声音阶（宫商角徵羽）做基因，每个蛋换根音与波形即得不同"性格"。
 */

import type { FxName } from './shell.ts';
import type { TyKind } from './typewriter.ts';

/** 五声音阶（相对半音）。 */
const PENTA = [0, 2, 4, 7, 9];

interface Voice {
  root: number;
  wave: OscillatorType;
  dec: number;
}

/** 兜底音色。
 *  🔴 必须提成**具名常量**而不是在每处写 `VOICES.ui`：
 *     noUncheckedIndexedAccess 下 `Record<K, V>` 的索引返回 `V | undefined`，
 *     于是每个使用点都要 `?? 0` / `!` 收窄。提成常量后收窄只做一次。
 */
const DEFAULT_VOICE: Voice = { root: 0, wave: 'sine', dec: 0.1 };

/** 十个蛋的音色：根音（半音）+ 波形 + 衰减（秒）。 */
const VOICES: Record<string, Voice> = {
  snake: { root: 0, wave: 'square', dec: 0.12 },
  dragon: { root: -5, wave: 'sawtooth', dec: 0.18 },
  brick: { root: 3, wave: 'triangle', dec: 0.1 },
  satoshi: { root: 5, wave: 'sine', dec: 0.16 },
  bitcoin: { root: 2, wave: 'square', dec: 0.1 },
  tank: { root: -2, wave: 'sawtooth', dec: 0.14 },
  spacex: { root: 7, wave: 'triangle', dec: 0.2 },
  tesla: { root: 9, wave: 'sine', dec: 0.14 },
  pet: { root: 4, wave: 'triangle', dec: 0.1 },
  mirror: { root: 0, wave: 'sine', dec: 0.12 },
  ui: { root: 0, wave: 'sine', dec: 0.1 },
};

const MUTE_KEY = 'notesync_bj_muted';

export interface Sound {
  muted: () => boolean;
  toggle: () => void;
  fx: (name: FxName) => void;
  /** 换当前局的音色（进游戏时调）。 */
  voice: (id: string) => void;
  /**
   * 打字机音（复古皮肤内）。**复用本引擎的 ctx**，绝不新造 AudioContext。
   *
   * 🔴 为什么挂在这里而不是另写一个模块：老项目 `nsTypeSound` 用的是它自己的
   *   `remAudioCtx`，而 bj 只有本文件一个 ctx（`actx()`）。另造一个会被浏览器
   *   限制（每域同时活跃的 AudioContext 有上限），症状是"进游戏有音、打字没音"。
   *
   * @param force 图鉴「再玩一次」点播示例音（老项目 `nsTypeSound('enter', true)`）：
   *   绕开静音门，但**仍走 ctx.state === 'running' 检查** —— 未解锁时不该出声。
   * @returns 是否真的发声了（`false` = 静音 / ctx 未解锁 / 被节流）。彩蛋埋点靠它。
   */
  type: (kind: TyKind, force?: boolean) => boolean;
}

/** 每个 fx 对应的音程（相对当前根音的半音数）与音量。 */
const FX: Record<FxName, { semi: number; vol: number; seq?: number[] }> = {
  tap: { semi: 0, vol: 0.12 },
  start: { semi: 7, vol: 0.16, seq: [0, 4, 7] },
  enter: { semi: 0, vol: 0.1 },
  eat: { semi: 9, vol: 0.18 },
  coin: { semi: 12, vol: 0.18 },
  shot: { semi: 4, vol: 0.16 },
  brk: { semi: 2, vol: 0.2 },
  thrust: { semi: -3, vol: 0.1 },
  die: { semi: -7, vol: 0.24, seq: [0, -2, -5] },
  up: { semi: 7, vol: 0.14 },
  burp: { semi: -12, vol: 0.22 },
};

export function buildSound(): Sound {
  let ctx: AudioContext | null = null;
  let voice = 'ui';
  const lastAt: Record<string, number> = {};
  /**
   * 50ms 白噪声缓存（带自然衰减），避免每键重新生成。
   *
   * 🔴🔴 缓存**绑定 ctx**（老项目 index.html:6789 闸R2 的原话）：
   *   跨 ctx 复用 AudioBuffer 会抛错，而整段被 catch 吞掉 ⇒ **永久消音**，
   *   症状是"玩了一会儿游戏之后打字机音彻底没了"，且零报错。
   *   所以判据是 `tyNoiseCtx === c`，不是"非空即复用"。
   */
  let tyNoise: AudioBuffer | null = null;
  let tyNoiseCtx: AudioContext | null = null;
  /** 打字机音自己的 24ms 节流（老项目 :6805）。与 fx 的 60ms 是两套，别混。 */
  let tyLastAt = -1e9;

  const isMuted = (): boolean => {
    try {
      return localStorage.getItem(MUTE_KEY) !== '0';
    } catch {
      return true;
    }
  };
  let muted = isMuted();

  /**
   * 懒创建 ctx。
   * 🔴 必须在**用户手势**里第一次调用 —— 顶层创建会被判 autoplay 而 suspended。
   */
  const actx = (): AudioContext | null => {
    if (ctx) {
      if (ctx.state === 'suspended') void ctx.resume().catch(() => {});
      return ctx;
    }
    try {
      const Ctor =
        window.AudioContext ??
        (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!Ctor) return null;
      ctx = new Ctor();
      return ctx;
    } catch {
      return null;
    }
  };

  const tone = (semi: number, at: number, dur: number, vol: number, wave: OscillatorType): void => {
    const c = ctx;
    if (!c) return;
    const v = VOICES[voice] ?? DEFAULT_VOICE;
    const osc = c.createOscillator();
    const gain = c.createGain();
    osc.type = wave;
    // 五声音阶取模：任意半音都映射到最近的一个音级上（基因池受控）
    const deg = PENTA[((semi + v.root) % 12 + 12) % 5] ?? 0;
    const oct = Math.floor((((semi + v.root) % 12) + 12) % 12 / 12);
    const f = 220 * Math.pow(2, (deg + oct * 12) / 12);
    osc.frequency.setValueAtTime(f, at);
    gain.gain.setValueAtTime(0, at);
    // 🔴 5ms 淡入：直接给非零增益会click（爆音），用户会以为设备坏了
    gain.gain.linearRampToValueAtTime(vol, at + 0.005);
    gain.gain.exponentialRampToValueAtTime(0.0001, at + dur);
    osc.connect(gain).connect(c.destination);
    osc.start(at);
    osc.stop(at + dur + 0.02);
  };

  /**
   * 50ms 白噪声（带自然衰减），**按 ctx 缓存**（老项目 index.html:6789 `nsTyNoiseBuf`）。
   *
   * 🔴 判据必须是 `tyNoiseCtx === c` 而不是 `tyNoise !== null`（闸 R2）：
   *   跨 ctx 复用 buffer 会抛 InvalidStateError，而 `type()` 整段被 catch 吞掉
   *   ⇒ 用户看到的是"玩过游戏之后打字机音永久消失"，且**零报错**。
   */
  const noiseBuf = (c: AudioContext): AudioBuffer => {
    if (tyNoise && tyNoiseCtx === c) return tyNoise;
    const n = Math.max(1, Math.floor(c.sampleRate * 0.05));
    const b = c.createBuffer(1, n, c.sampleRate);
    const d = b.getChannelData(0);
    // 线性衰减（1 - i/n）：白噪直接进包络会在末尾"啪"一下（老项目 :6794 逐字）
    for (let i = 0; i < n; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / n);
    tyNoise = b;
    tyNoiseCtx = c;
    return b;
  };

  return {
    muted: () => muted,
    toggle: () => {
      muted = !muted;
      try {
        localStorage.setItem(MUTE_KEY, muted ? '1' : '0');
      } catch {
        // 存不下就在本次会话内有效
      }
      if (!muted) {
        // 主动开声时才建ctx（此时一定在手势链内）
        actx();
      }
    },
    voice: (id) => {
      voice = VOICES[id] !== undefined ? id : 'ui';
    },
    fx: (name) => {
      if (muted) return;
      const spec = FX[name];
      if (!spec) return;
      // 🔴 同类60ms 节流（连射不糊成一片）
      const now = performance.now();
      if (now - (lastAt[name] ?? -1e9) < 60) return;
      lastAt[name] = now;
      const c = actx();
      if (!c) return;
      const v = VOICES[voice] ?? DEFAULT_VOICE;
      const t0 = c.currentTime + 0.001;
      if (spec.seq) {
        spec.seq.forEach((s, i) => tone(s, t0 + i * 0.07, v.dec, spec.vol, v.wave));
      } else {
        tone(spec.semi, t0, v.dec, spec.vol, v.wave);
      }
    },
    /**
     * 打字机音（老项目 index.html:6798-6831 `nsTypeSound`，逐值照抄）。
     *
     * 🔴 三条复刻纪律：
     *   1. **静音即停**（`!force && muted` 早退）。老项目 :6799。
     *      `force` 是图鉴「再玩一次」的点播，明确意图绕开门。
     *   2. **24ms 节流，回车豁免**（老项目 :6805）。回车是节奏点，吞掉就"不像打字机"。
     *      ⚠️ 与 `fx()` 的 60ms 是两套独立节流 —— 混用会让打字声在高连打时
     *      比游戏音效更容易被吞，反过来也一样。
     *   3. **复用 actx()**，绝不 `new AudioContext()`（见 Sound.type 的注释）。
     */
    type: (kind, force) => {
      if (!force && muted) return false;
      const c = actx();
      if (!c) return false;
      // 未解锁（无手势）或已关闭：静默。老项目 :6803 的 `state !== 'running'` 闸。
      if (c.state !== 'running') return false;
      const now = Date.now();
      if (kind !== 'enter' && now - tyLastAt < 24) return false; // 回车永不被吞
      tyLastAt = now;
      try {
        const t0 = c.currentTime + 0.005;
        const src = c.createBufferSource();
        src.buffer = noiseBuf(c);
        const bp = c.createBiquadFilter();
        bp.type = 'bandpass';
        // 空格比普通字母闷一档（老项目 :6812）—— 否则空格听起来与字母同质。
        bp.frequency.value = kind === 'space' ? 1100 : 1900;
        bp.Q.value = 1.1;
        const g = c.createGain();
        g.gain.setValueAtTime(0.0001, t0);
        g.gain.exponentialRampToValueAtTime(kind === 'enter' ? 0.12 : 0.16, t0 + 0.004);
        g.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.05);
        src.connect(bp);
        bp.connect(g);
        g.connect(c.destination);
        src.start(t0);
        src.stop(t0 + 0.06);
        if (kind === 'enter') {
          // 回车 = 打字机回车铃（老项目 :6820-6828）。少了这声回响就不像打字机。
          const o = c.createOscillator();
          const g2 = c.createGain();
          o.type = 'sine';
          o.frequency.value = 1560;
          g2.gain.setValueAtTime(0.0001, t0);
          g2.gain.exponentialRampToValueAtTime(0.1, t0 + 0.01);
          g2.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.3);
          o.connect(g2);
          g2.connect(c.destination);
          o.start(t0);
          o.stop(t0 + 0.32);
        }
        return true;
      } catch {
        // 🔴 发声失败绝不打断输入（老项目 :6830 的空catch）。
        //   注意**节流时刻已经推进**了：宁可少响一声，也不要每键都重试整条链。
        return false;
      }
    },
  };
}
