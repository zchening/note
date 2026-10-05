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
  };
}
