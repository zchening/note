/**
 * 主题与色板 —— **全项目唯一允许出现颜色字面量的地方**
 *
 * 🔴🔴 改配色只改本文件，绝不在渲染函数里硬编码颜色。
 *   踩过的坑：标题色写死在渲染函数里，换浅色时那段文字在白底上直接隐形
 *   （"看起来渲染了"但用户看不见）。ARCH.md 的用户偏好是**浅色高级风、拒黑底**，
 *   所以深色必须是"夜间模式"的可选态，默认给浅色。
 *
 * 色值逐字节抄自老项目 `index.html` 的 `:root` 与 `.dark` 两组变量（见 ARCH.md §4.2.1），
 * **不许自行微调** —— 用户要的是"体验和现在完全一致"。
 */

export type ThemeName = 'light' | 'dark';

/** 老项目的时间规则原文：分钟<420（07:00 前）或 >=1140（19:00 后）为夜间。 */
const NIGHT_START_MIN = 19 * 60;
const NIGHT_END_MIN = 7 * 60;

export interface ThemeTokens {
  bg: string;
  fg: string;
  muted: string;
  line: string;
  accent: string;
  accentSoft: string;
  ring: string;
  boxBg: string;
  uploadBg: string;
  hover: string;
  danger: string;
}

/**
 * 色板。值与老项目逐字一致。
 * 🔴 浅色底是暖白 `#FBFBF8` 而不是纯白 —— 这是"高级感"的来源，不要"顺手改成 #fff"。
 */
export const PALETTE: Readonly<Record<ThemeName, ThemeTokens>> = {
  light: {
    bg: '#FBFBF8',
    fg: '#1C1C1A',
    muted: '#98958A',
    line: '#ECEAE2',
    accent: '#8F7126',
    accentSoft: 'rgba(143,113,38,.07)',
    ring: 'rgba(143,113,38,.16)',
    boxBg: '#FFFFFF',
    uploadBg: '#1C1C1A',
    hover: 'rgba(28,28,26,.05)',
    danger: '#C0453E',
  },
  dark: {
    bg: '#0F0F11',
    fg: '#E9E8E3',
    muted: '#7A786F',
    line: '#242428',
    accent: '#D4B068',
    accentSoft: 'rgba(212,176,104,.08)',
    ring: 'rgba(212,176,104,.22)',
    boxBg: '#17171A',
    uploadBg: '#E9E8E3',
    hover: 'rgba(233,232,227,.07)',
    danger: '#C0453E',
  },
} as const;

export const FONTS = {
  serif: 'Georgia,"Times New Roman","Songti SC","STSong",serif',
  mono: 'ui-monospace,SFMono-Regular,"SF Mono",Consolas,Menlo,monospace',
} as const;

/**
 * 遮罩与覆膜层的半透明色 —— 同样属于"颜色"，所以也归本文件管。
 *
 * 🔴 为什么必须集中：`styles.css` 里若出现 rgba 字面量，改配色时就会漏掉覆膜层，
 *   症状是"夜间模式下扫描线还是黑的"，极难联想到是色板漏改。
 */
export const OVERLAY = {
  /** 口令页等模态遮罩：浅色用暖调深色，不用纯黑（纯黑在暖白底上很脏） */
  maskLight: 'rgba(20,20,18,.45)',
  maskDark: 'rgba(0,0,0,.55)',
  /** 终端绿皮肤扫描线 */
  scanNight: 'repeating-linear-gradient(to bottom, rgba(0,0,0,.16) 0 1px, transparent 1px 3px)',
  scanDay: 'repeating-linear-gradient(to bottom, rgba(0,0,0,.09) 0 1px, transparent 1px 3px)',
  /** 打字机纸皮肤横竖格线 */
  paperDay:
    'repeating-linear-gradient(to bottom, rgba(120,110,90,.10) 0 1px, transparent 1px 26px),' +
    ' repeating-linear-gradient(to right, rgba(120,110,90,.07) 0 1px, transparent 1px 26px)',
  paperNight:
    'repeating-linear-gradient(to bottom, rgba(210,200,170,.10) 0 1px, transparent 1px 26px),' +
    ' repeating-linear-gradient(to right, rgba(210,200,170,.07) 0 1px, transparent 1px 26px)',
} as const;

/** 复古皮肤三态（老项目叫"三态环"，靠连点 logo 7 次前进）。 */
export type SkinName = 'default' | 'terminal' | 'typewriter';

export const SKIN_WORDS: Readonly<Record<SkinName, string>> = {
  default: 'NoteSync',
  terminal: 'NOTE-SYNC.EXE',
  typewriter: 'N O T E S Y N C',
} as const;

export const SKIN_LABELS: Readonly<Record<SkinName, string>> = {
  default: '已恢复默认',
  terminal: '复古 · 终端绿',
  typewriter: '复古 · 打字机纸',
} as const;

/** 下一个皮肤（三态环前进一格）。 */
export function nextSkin(cur: SkinName): SkinName {
  if (cur === 'default') return 'terminal';
  if (cur === 'terminal') return 'typewriter';
  return 'default';
}

/** body 上的class 名，老项目用的是 `dark` / `skin-a` / `skin-b`。 */
export function bodyClassFor(theme: ThemeName, skin: SkinName): string {
  const out: string[] = [];
  if (theme === 'dark') out.push('dark');
  if (skin === 'terminal') out.push('skin-a');
  if (skin === 'typewriter') out.push('skin-b');
  return out.join(' ');
}

/** 由分钟数判夜间（老项目时间规则的直接翻译，规则本身见 ARCH.md §4.2.1）。 */
export function isNightByClock(date: Date): boolean {
  const m = date.getHours() * 60 + date.getMinutes();
  return m < NIGHT_END_MIN || m >= NIGHT_START_MIN;
}

/**
 * 解析当前应当生效的主题。
 *
 * 🔴 优先级只有两级：**手动内存态 > 时间规则**。
 *   老项目**没有"跟随系统"这个选项**（主题只有日/夜两态，菜单里就是"夜间模式/日间模式"
 *   两个互斥项）。我第一版顺手加了系统跟随层，那是新造功能、不是复刻 ——
 *   用户要"体验和现在完全一致"，多一个优先级就意味着某些机器上首屏颜色与老项目不同。
 *   所以这里只有两级，`systemPrefersDark` 形参已删。
 *
 * @param manual 用户本次会话的手动选择；`null` 表示"按时间规则"
 * @param now    注入时间，便于测试（不直接读 Date.now 是为了可测）
 */
export function resolveTheme(manual: boolean | null, now: Date): ThemeName {
  if (manual !== null) return manual ? 'dark' : 'light';
  return isNightByClock(now) ? 'dark' : 'light';
}

/** 把色板写进 :root 的 CSS 变量。切换主题时调用。 */
export function applyThemeVars(theme: ThemeName, el: HTMLElement): void {
  const p = PALETTE[theme];
  const s = el.style;
  s.setProperty('--bg', p.bg);
  s.setProperty('--fg', p.fg);
  s.setProperty('--muted', p.muted);
  s.setProperty('--line', p.line);
  s.setProperty('--accent', p.accent);
  s.setProperty('--accent-soft', p.accentSoft);
  s.setProperty('--ring', p.ring);
  s.setProperty('--box-bg', p.boxBg);
  s.setProperty('--upload-bg', p.uploadBg);
  s.setProperty('--hover', p.hover);
  s.setProperty('--danger', p.danger);
  s.setProperty('--serif', FONTS.serif);
  s.setProperty('--mono', FONTS.mono);
  s.setProperty('--mask-bg', theme === 'dark' ? OVERLAY.maskDark : OVERLAY.maskLight);
  el.classList.toggle('dark', theme === 'dark');
}

/**
 * 复古皮肤的覆膜层样式。
 *
 * 🔴 返回空串表示"这一档不覆膜"——所以皮肤环的 default 档必须真的什么都不画，
 *   残留一层扫描线是最难察觉的 UI 漂移。
 */
export function skinOverlayStyle(skin: SkinName, night: boolean): string {
  if (skin === 'terminal') return night ? OVERLAY.scanNight : OVERLAY.scanDay;
  if (skin === 'typewriter') return night ? OVERLAY.paperNight : OVERLAY.paperDay;
  return '';
}
