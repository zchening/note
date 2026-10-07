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
  /**
   * 删除线线色（老项目 index.html:424 `rgba(152,149,138,.7)`）。
   * 🔴 老项目**只写了这一处**、没有夜间覆写 —— 它的夜间值就等于日间值。
   *   照实抄，不要"顺手给夜间换个深一档的"：那会让夜间正文里的删除线
   *   与老项目不一致，而这类差异并排才看得出。
   */
  delLine: string;
  /**
   * 链接下划线色（老项目 index.html:380 `rgba(169,134,60,.35)`，hover 转实`var(--accent)`）。
   * 🔴 同样只有单值，老项目夜间不改这一行。
   */
  linkLine: string;
  /**
   * 选中态底色（老项目 index.html:97 `rgba(169,134,60,.22)`）。
   * 🔴 同上：老项目是**全局单值**，夜间不覆写。
   */
  selection: string;
  /**
   * 🔴🔴 图片查看器五档（老项目 index.html:69 / :71，逐字节抄）。
   *
   *   日间**也暗**（`rgba(20,20,18,.94)`）—— 老项目注释写得很直白：
   *   「照片要看清必须暗背景」。这一档最容易被"顺手改成日间浅色"，
   *   症状是白底相册里的白衣服在查看器里彻底看不见，而单看代码无懈可击。
   *
   *   `zoomSolid` 是 v9.3.7 补的**不透明**实底（同色去 alpha）：
   *   亮图铺到底栏后面时半透明底被冲淡，按钮文字读不出来。
   *   它与 `zoomBg` 必须分开 —— 用 bg 就会把那个已修的 bug 装回来。
   */
  zoomBg: string;
  zoomInk: string;
  zoomChip: string;
  zoomLine: string;
  zoomDim: string;
  zoomSolid: string;
  /**
   * 🔴🔴 底栏同步状态点两档（老项目 index.html:498/499）。
   *
   * 独立于 accent 的理由：`.dot.on` 此前接的是 var(--accent)，于是"已同步"
   * 显示成**金色**（用户报的第 4 条）。而老项目那里是 `#2FA866` 一枚**绿点**。
   * 语义上也该分开 —— 金色是"可点/强调"，绿色是"已连通"，
   * 混用会把状态读成动作。
   */
  dotOn: string;
  dotIdle: string;
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
    delLine: 'rgba(152,149,138,.7)',
    linkLine: 'rgba(169,134,60,.35)',
    selection: 'rgba(169,134,60,.22)',
    // 老项目 index.html:69 —— 日间也压深到近黑（见 ThemeTokens.zoomBg 注释）
    zoomBg: 'rgba(20,20,18,.94)',
    zoomInk: '#F2F1EC',
    zoomChip: 'rgba(255,255,255,.12)',
    zoomLine: 'rgba(255,255,255,.22)',
    zoomDim: 'rgba(242,241,236,.62)',
    zoomSolid: '#141412',
    // 🔴🔴 底栏同步状态点（老项目 index.html:499 `footer .dot.on{background:#2FA866}`）。
    //   此前这里用的是 var(--accent)（金色 #8F7126）—— 那正是用户报的
    //   "显示黄色而非绿色"。同步状态点与品牌金是两件事：
    //   品牌金是"可点/强调"，绿是"已连通"，混用会让"已同步"读起来像"可点击"。
    //   dotIdle 同老项目 `#C9C7BE`（不是 --line #ECEAE2，后者太浅、点在白底上几乎看不见）。
    dotOn: '#2FA866',
    dotIdle: '#C9C7BE',
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
    // 🔴 三个值与浅色**逐字节相同**：老项目这三处根本不是令牌，是硬编码单值，
    //   夜间不覆写（已在 index.html 里grep 确认每处只出现一次）。
    //   写成"夜间更深的档"就是自造，判红。
    delLine: 'rgba(152,149,138,.7)',
    linkLine: 'rgba(169,134,60,.35)',
    selection: 'rgba(169,134,60,.22)',
    // 老项目 index.html:90 —— 夜间比日间再压一档近纯黑。zoomInk 两档同值（老项目如此）。
    zoomBg: 'rgba(0,0,0,.95)',
    zoomInk: '#F2F1EC',
    zoomChip: 'rgba(255,255,255,.1)',
    zoomLine: 'rgba(255,255,255,.18)',
    zoomDim: 'rgba(242,241,236,.55)',
    zoomSolid: '#000000',
    // 🔴 与浅色逐字节相同：老项目 footer .dot 两档都是硬编码单值，夜间不覆写
    //   （index.html:498/499 只出现一次，无夜间分支）。照实抄。
    dotOn: '#2FA866',
    dotIdle: '#C9C7BE',
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
  /**
   * 浮起卡片的投影（时间 chip、响铃卡）。两条而非一条 `0 0 0 0`：
   * 老项目 chip 是 `0 14px 36px`、提醒卡是 `0 18px 48px`，两个尺寸都得留住。
   * 🔴 写在 theme.ts 而不是 styles.css —— S4-T7 有机械扫描，CSS 里出现
   *   rgba 字面量会直接判红。这条纪律的作用就是"颜色只允许有一个出处"。
   */
  shadowChip: '0 14px 36px rgba(0,0,0,.16)',
  shadowCard: '0 18px 48px rgba(0,0,0,.2)',
  /**
   * 弹窗/响铃卡级浮起投影（老项目 index.html:189 与 :509 是**同一个值**）。
   * 🔴 原先 `.box` 用的是 `0 10px 40px var(--ring)` —— 那是"聚焦光圈"的量级，
   *   拿来做弹窗投影等于浮层没有高度感（弹窗贴在纸上而不是浮起来）。
   *   老项目 .box 与 #remCard 同为 `0 24px 70px rgba(20,20,18,.16)`，故合并成一档。
   */
  shadowBox: '0 24px 70px rgba(20,20,18,.16)',
  /**
   * 底部上传状态条投影（老项目 index.html:598 `0 10px 30px rgba(20,20,18,.2)`）。
   * 🔴 与浮层档分开：状态条是**贴在底栏上方**的小胶囊，投影更紧更实，
   *   和弹窗共用一档会让它看起来像个大浮层。
   */
  shadowUpload: '0 10px 30px rgba(20,20,18,.2)',
  /**
   * 彩蛋词表确认浮层（`#eggAsk`）的投影 —— 老项目 index.html:10467
   * `#nsAsk{...box-shadow:0 10px 30px rgba(20,20,18,.14)}`。
   * 🔴 与 `shadowUpload` **同尺寸不同透明度**（.14 vs .2）：老项目就是两个值。
   *   合并成一档会让浮层在浅色暖白底上"压得太重"，与老项目并排看得出。
   */
  shadowAsk: '0 10px 30px rgba(20,20,18,.14)',
  /**
   * 提醒滚轮的上下渐隐遮罩（老项目 index.html:235 `-webkit-mask-image:
   * linear-gradient(transparent,#000 32%,#000 68%,transparent)`）。
   *
   * 🔴🔴 为什么整条渐变进theme.ts 而不是只把 `#000` 换成变量：
   *   `#000` 是 mask 的**不透明挡位**标记（alpha=1），不是"黑色"——
   *   写成 `var(--wheel-mask-ink)` 之类的新令牌会让人误以为可以给渐变调色，
   *   而 mask 的语义恰恰是"这里完全不透明"。整条搬进来既过得了颜色扫描闸，
   *   又不会给后人留一个"看起来能改色"的假旋钮。
   */
  wheelFadeMask:
    'linear-gradient(transparent,#000 32%,#000 68%,transparent)',
  // 二维码纸：必须始终是白纸 + 深色码，与主题无关（见 applyThemeVars 处注释）
  qrPaper: '#FFFFFF',
  // 取景台径向渐变两色：比任何相机画面都深，保证取景框永远看得见
  scanStageA: '#1a1a1d',
  scanStageB: '#0b0b0c',
  // 取景台内描边：一像素的白，用来把 stage 边界从相机画面里分出来
  scanStageEdge: 'rgba(255,255,255,.04)',
  // 取景台上的提示字：浅色压深底。必须与 --muted 分开——muted 是"跟着主题走的
  // 次要文字色"，夜间主题下它会变亮，白天主题下会变深，都不适合压在取景台上。
  scanStageText: 'rgba(233,232,227,.62)',
  /* ---- 图片查看器 / 长按菜单（老项目 index.html:363-375）---- */
  /**
   * 长按自建菜单的投影（老项目 :369 `0 18px 50px rgba(20,20,18,.22)`）。
   * 🔴 比 `--shadow-box` 紧一档：它是贴在图上的小菜单，不是居中模态。
   */
  imgMenuShadow: '0 18px 50px rgba(20,20,18,.22)',
  /**
   * 查看器次按钮的**纯白字**（老项目 :366 `color:#FFFFFF`）。
   * 🔴🔴 故意不用 `--zoom-ink`（#F2F1EC）：老项目 v9.3.8 记过一次实测 ——
   *   近白在手机屏幕上仍发灰看不清，用户拍板改纯白。这是"用户拍板值"，
   *   不是图省事的硬编码；改回近白等于把那个 bug 装回来。
   */
  zoomBtnInk: '#FFFFFF',
  /**
   * 查看器主按钮：纯白底 + **纯黑**字（老项目 :367）。
   * 🔴 同上：近白底/近黑字在手机上发灰，纯黑字是老项目用户明确拍板的。
   */
  zoomPriBg: '#FFFFFF',
  zoomPriInk: '#000000',
  /* ---- 光标诊断浮层（老项目 index.html:2065-2068）---- */
  /**
   * 诊断浮层底色（老项目 :2066 `rgba(0,0,0,.82)`）。
   * 🔴🔴 **必须与主题无关**：这是一层压在真机页面上的取证浮层，
   *   它的唯一职责是「无论日间还是夜间都要能看清读数」。
   *   若跟着主题走，日间模式下白底 + 浅色字 = 读数全糊在纸上，
   *   而"看不清读数"恰好是这个功能存在的目的被自己废掉。
   *   老项目是写死在 cssText 里的硬编码单值（无夜间分支），照实抄。
   */
  diagBg: 'rgba(0,0,0,.82)',
  /**
   * 诊断浮层字色（老项目 :2066 `color:#0f0`）。
   * 🔴 纯荧光绿是**刻意的**：它与页面本身的配色（暖白/深灰）完全不同族，
   *   所以截图发给开发者时，一眼就能分清"这行是诊断读数不是正文"。
   *   换成 var(--fg) 的话浮层会融进页面，截图里根本认不出边界。
   */
  diagInk: '#0f0',
  /**
   * 诊断模态的**正文底色**（老项目 :8220 那张 `pre#diagContent` 用主题色板）。
   * 🔴 与浮层底刻意分开：模态走 `.box`/主题令牌（与全站弹窗一致），
   *   浮层才用固定黑底绿字。两者混成一个值就会出现
   *   「模态在日间是白底黑字、浮层是黑底绿字，同一份读数两种脸色」。
   */
  diagModalBg: '#0F0F11',
  diagModalInk: '#E9E8E3',
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
  // 🔴 删除线/链接下划线/选中态三档：老项目是硬编码单值，两档同值（见 PALETTE 注释）。
  s.setProperty('--del-line', p.delLine);
  s.setProperty('--link-line', p.linkLine);
  s.setProperty('--selection', p.selection);
  // 🔴 图片查看器五档 + 不透明实底（老项目 index.html:69/:71 日间，:90/:91 夜间）。
  //   实底与半透明底必须并存：底栏吃 --zoom-solid，查看器大底吃 --zoom-bg。
  s.setProperty('--zoom-bg', p.zoomBg);
  s.setProperty('--zoom-ink', p.zoomInk);
  s.setProperty('--zoom-chip', p.zoomChip);
  s.setProperty('--zoom-line', p.zoomLine);
  s.setProperty('--zoom-dim', p.zoomDim);
  s.setProperty('--zoom-solid', p.zoomSolid);
  s.setProperty('--dot-on', p.dotOn);
  s.setProperty('--dot-idle', p.dotIdle);
  s.setProperty('--img-menu-shadow', OVERLAY.imgMenuShadow);
  s.setProperty('--zoom-btn-ink', OVERLAY.zoomBtnInk);
  s.setProperty('--zoom-pri-bg', OVERLAY.zoomPriBg);
  s.setProperty('--zoom-pri-ink', OVERLAY.zoomPriInk);
  s.setProperty('--serif', FONTS.serif);
  s.setProperty('--mono', FONTS.mono);
  s.setProperty('--mask-bg', theme === 'dark' ? OVERLAY.maskDark : OVERLAY.maskLight);
  // 🔴 浮层投影也走变量：CSS 里写 rgba 会被 S4-T7 判红（颜色只允许一个出处），
  //   而投影本质是颜色，所以必须在这里注入而不是写在 styles.css。
  s.setProperty('--shadow-chip', OVERLAY.shadowChip);
  s.setProperty('--shadow-card', OVERLAY.shadowCard);
  s.setProperty('--shadow-box', OVERLAY.shadowBox);
  s.setProperty('--shadow-upload', OVERLAY.shadowUpload);
  s.setProperty('--shadow-ask', OVERLAY.shadowAsk);
  s.setProperty('--wheel-fade-mask', OVERLAY.wheelFadeMask);
  // 🔴 二维码纸与取景台是**两套与主题无关的固定色**，但仍由这里注入：
  //   S4-T7 纪律闸禁止 styles.css 出现颜色字面量，就地写 rgba/hex 会绕过色板，
  //   症状是"以后调深浅色时这两块忘了改"。
  //   固定的理由：二维码必须在浅底上才识别得出来（老项目血泪，深色二维码在暗光下
  //   大面积识别失败）；取景台必须比相机画面深，否则白墙白纸前根本看不见取景框。
  s.setProperty('--qr-paper', OVERLAY.qrPaper);
  s.setProperty('--scan-stage-a', OVERLAY.scanStageA);
  s.setProperty('--scan-stage-b', OVERLAY.scanStageB);
  s.setProperty('--scan-stage-edge', OVERLAY.scanStageEdge);
  s.setProperty('--scan-stage-text', OVERLAY.scanStageText);
  /* 🔴 诊断浮层两色（老项目 index.html:2066）。**与主题无关**，理由见 OVERLAY.diagBg 注释：
     取证浮层的第一职责是"任何主题下都读得清"，跟主题走等于自己废掉这个功能。 */
  s.setProperty('--diag-bg', OVERLAY.diagBg);
  s.setProperty('--diag-ink', OVERLAY.diagInk);
  /* 诊断模态走主题色板（与全站 .box 一致），刻意与浮层的固定黑底绿字分开。 */
  s.setProperty('--diag-modal-bg', OVERLAY.diagModalBg);
  s.setProperty('--diag-modal-ink', OVERLAY.diagModalInk);
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
