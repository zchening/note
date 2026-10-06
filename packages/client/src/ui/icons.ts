/**
 * 图标 —— 全部 inline SVG，**不引图标库**
 *
 * 理由（ARCH.md §4.6 运行时零依赖）：图标库就是几百 KB 的第三方代码，
 * 而 E2EE 项目把"产物里每一行代码都审读过"当作投毒防线。
 *
 * 🔴🔴🔴 本文件全部 path 与描边宽度**逐字复刻老项目** `index.html` 的对应图标。
 *   原新项目是"另画的一套看着差不多的图形"，且描边宽度统一塌成 1.6：
 *     ·顶栏删除线：老项目是**双 S 弧 + 金色横线**，新项目第二段弧写成直线（弧度不同）
 *     · 顶栏提醒：老项目铃身 r7 + **四根外撇铃舌**（M4.6 4.2 7.2 2.6 等四条），
 *                新项目只有两根短须，图形明显更"瘦"
 *     · 上传/导出：老项目是**U 形托盘 + 金色竖箭头**（托盘在下方开口朝上），
 *                新项目把托盘和箭头都拆成独立 path 且托盘是闭合矩形
 *     · 扫一扫：老项目取景框**四角 + 金色横线 + 三枚金色方点**，
 *                新项目只有个"8.5 12h7"短横线，方点全丢
 *     · 二维码：老项目是**三个描边定位角 + 七枚金色实心方块**，新项目是四个描边方块 +
 *                几段 path 拼的伪方块（图形与金点分布都不同）
 *     · 菜单项：老项目描边 1.9（比顶栏粗一号），新项目全用 1.6 —— 菜单整组"变细"
 *     · 收藏星/月亮/钥匙/锁：老项目的金色高亮件（.g/.gf）在新项目里丢了
 *   单看任一图标都不算错，并排才刺眼，所以极难自查。
 *
 * 🔴 描边宽度分五档（老项目原值，别"顺手统一"）：
 *   顶栏 7 键 1.7 / 落地页扫码 1.8 / 菜单 11 项 1.9 / 关闭 × 2 / 游戏喇叭 1.8
 *
 * 🔴 颜色一律 `currentColor` + `.g` / `.gf` 金色层（见 styles.css 的 `svg .g`）。
 * 🔴 尺寸交给 CSS（顶栏 17px / 菜单 20px / 扫码 16px / trust 17px），这里不写死 width。
 */

/** 描边宽度是规格的一部分：五档必须逐档传，不能抽成一个默认值。 */
const svg = (body: string, w: number): string =>
  `<svg class="ic" viewBox="0 0 24 24" fill="none" ` +
  `stroke="currentColor" stroke-width="${w}" stroke-linecap="round" stroke-linejoin="round" ` +
  `aria-hidden="true" focusable="false">${body}</svg>`;

/** 顶栏档1.7 */
const TOP = (b: string): string => svg(b, 1.7);
/** 菜单档 1.9（比顶栏粗一号，老项目如此） */
const MENU = (b: string): string => svg(b, 1.9);

/* ---------------- 顶栏 7 键（老项目 index.html:653-659，描边 1.7） ---------------- */

/** 删除线：双 S 弧 + 金色横线 */
export const ICON_STRIKE = (): string =>
  TOP('<path d="M16.5 5H9.8a3.3 3.3 0 0 0-1.3 6.3"/>' +
      '<path d="M14 12.5a3.8 3.8 0 0 1-1.6 6.5H6.5"/>' +
      '<line class="g" x1="4" x2="20" y1="12.2" y2="12.2"/>');

/** 提醒：铃身 + 四根外撇铃舌 + 金色指针 */
export const ICON_REMIND = (): string =>
  TOP('<circle cx="12" cy="13.5" r="7"/>' +
      '<path d="M4.6 4.2 7.2 2.6"/>' +
      '<path d="M19.4 4.2 16.8 2.6"/>' +
      '<path d="M18.6 19.3l2.2 2.2"/>' +
      '<path d="M5.4 19.3l-2.2 2.2"/>' +
      '<path class="g" d="M12 10v3.5l2.4 1.6"/>');

/** 上传图片：U 形托盘 + 金色竖箭头 */
export const ICON_UPLOAD = (): string =>
  TOP('<path d="M4 14.5V17a3 3 0 0 0 3 3h10a3 3 0 0 0 3-3v-2.5"/>' +
      '<path class="g" d="M12 3.5v10.8"/>' +
      '<polyline class="g" points="7.6 7.9 12 3.5 16.4 7.9"/>');

/** 复制：后层方框 + 金色前层角标 */
export const ICON_COPY = (): string =>
  TOP('<rect width="12" height="12" x="3.5" y="3.5" rx="2.5"/>' +
      '<path class="g" d="M8.5 16.5V20a.5.5 0 0 0 .5.5h11a.5.5 0 0 0 .5-.5V9a.5.5 0 0 0-.5-.5H16.5"/>');

/** 导出为图片并复制：U 形托盘 + 金色下箭头 */
export const ICON_EXPORT = (): string =>
  TOP('<path d="M4 9.5V7a3 3 0 0 1 3-3h10a3 3 0 0 1 3 3v2.5"/>' +
      '<path class="g" d="M12 3.8v10.7"/>' +
      '<polyline class="g" points="7.6 10.1 12 14.5 16.4 10.1"/>');

/** 扫一扫：四角取景框 + 金色横线 + 三枚金色实心点 */
export const ICON_SCAN = (): string =>
  TOP('<path d="M3 8.5V6a3 3 0 0 1 3-3h2.5"/>' +
      '<path d="M15.5 3H18a3 3 0 0 1 3 3v2.5"/>' +
      '<path d="M21 15.5V18a3 3 0 0 1-3 3h-2.5"/>' +
      '<path d="M8.5 21H6a3 3 0 0 1-3-3v-2.5"/>' +
      '<path class="g" d="M3.5 12h17"/>' +
      '<rect class="gf" x="6.6" y="14.8" width="1.7" height="1.7" rx=".55"/>' +
      '<rect class="gf" x="11.2" y="14.8" width="1.7" height="1.7" rx=".55"/>' +
      '<rect class="gf" x="15.8" y="14.8" width="1.7" height="1.7" rx=".55"/>');

/** 二维码配对：三个描边定位角 + 七枚金色实心方块 */
export const ICON_QR = (): string =>
  TOP('<rect x="3.5" y="3.5" width="6.5" height="6.5" rx="1.5"/>' +
      '<rect x="14" y="3.5" width="6.5" height="6.5" rx="1.5"/>' +
      '<rect x="3.5" y="14" width="6.5" height="6.5" rx="1.5"/>' +
      '<rect class="gf" x="5.7" y="5.7" width="2.1" height="2.1" rx=".7"/>' +
      '<rect class="gf" x="16.2" y="5.7" width="2.1" height="2.1" rx=".7"/>' +
      '<rect class="gf" x="5.7" y="16.2" width="2.1" height="2.1" rx=".7"/>' +
      '<rect class="gf" x="14" y="14" width="2.3" height="2.3" rx=".7"/>' +
      '<rect class="gf" x="18.2" y="14" width="2.3" height="2.3" rx=".7"/>' +
      '<rect class="gf" x="14" y="18.2" width="2.3" height="2.3" rx=".7"/>' +
      '<rect class="gf" x="18.2" y="18.2" width="2.3" height="2.3" rx=".7"/>');

/* ---------------- 底栏 ---------------- */

/** 菜单：三横线，中间一条是金色（老项目 .g 次色层） */
export const ICON_MENU = (): string =>
  TOP('<path d="M4 6.8h16"/>' +
      '<path class="g" d="M4 12h16"/>' +
      '<path d="M4 17.2h16"/>');

/** 刷新 */
export const ICON_REFRESH = (): string =>
  TOP('<path d="M19.5 12a7.5 7.5 0 1 1-2.2-5.3"/>' +
      '<path d="M19.5 4.5V9H15"/>');

/* ---------------- 菜单 11 项（老项目 index.html:697-707，描边 1.9） ---------------- */

/** 返回首页：屋顶 + 门洞 */
export const ICON_HOME = (): string =>
  MENU('<path d="M3.4 10.6 12 3.5l8.6 7.1"/>' +
       '<path d="M5.6 9.1v9.4a2 2 0 0 0 2 2h8.8a2 2 0 0 0 2-2V9.1"/>' +
       '<path class="g" d="M10 20.5v-4.7a2 2 0 0 1 4 0v4.7"/>');

/**
 * 收藏笔记：五角星。
 *
 * 🔴🔴 实心态必须用 `class="gf"`（走 CSS `svg .gf{fill:var(--accent);stroke:none}`），
 *   **不能**写 `fill="currentColor"` —— 用户报障第 4 条「收藏笔记后五角星图标没变」。
 *   病根是 SVG 的两段式表现属性优先级：
 *     ① `svg()` 给每个图标在 <svg> 上写死了 `fill="none"`（表现属性，**可被 CSS 覆盖**）；
 *     ② 但 path 上的 `fill="currentColor"` 在这一档里**解析成空**
 *        （实测 Chromium：`getAttribute('fill')` 还留着 'currentColor'，
 *          `getComputedStyle(path).fill` 却是 ''，于是既没描边变化也没填充 —— 视觉上"完全没变"）。
 *   换句话说：老代码"看起来写了填充"但实际一像素都没生效，label 变而图标不变。
 *   老项目的正解就是 `class="gf"`（STAR_IN_SVG），此处照抄。
 */
export const ICON_STAR = (filled: boolean): string =>
  MENU((filled ? '<path class="gf" ' : '<path ') +
       'd="M12 3.8l2.4 4.9 5.4.8-3.9 3.8.9 5.4-4.8-2.5-4.8 2.5.9-5.4-3.9-3.8 5.4-.8z"/>');

/** 收藏夹：文件夹 + 金色中划线 */
export const ICON_FOLDER = (): string =>
  MENU('<path d="M3.5 7A2.5 2.5 0 0 1 6 4.5h3.6a2 2 0 0 1 1.6.8l1.3 1.7H18A2.5 2.5 0 0 1 20.5 9.5v7.8A2.5 2.5 0 0 1 18 19.8H6a2.5 2.5 0 0 1-2.5-2.5Z"/>' +
       '<path class="g" d="M3.5 11.6h17"/>');

/** 历史版本：钟面 + 金色指针 */
export const ICON_CLOCK = (): string =>
  MENU('<circle cx="12" cy="12" r="8.5"/>' +
       '<path class="g" d="M12 7.2V12l3.4 2.2"/>');

/** 打开链接：两段开口环 + 金色中划 */
export const ICON_LINK = (): string =>
  MENU('<path class="g" d="M10.4 13.6l3.2-3.2"/>' +
       '<path d="M12.6 8.8l1.4-1.4a3.6 3.6 0 0 1 5.1 5.1l-1.4 1.4"/>' +
       '<path d="M11.4 15.2L10 16.6a3.6 3.6 0 0 1-5.1-5.1l1.4-1.4"/>');

/** 扫码换机：取景框 + 金色十字。与「扫一扫」的差别是框内是+ 号不是点阵 */
export const ICON_HANDOFF = (): string =>
  MENU('<path d="M3 8.5V6a3 3 0 0 1 3-3h2.5"/>' +
       '<path d="M15.5 3H18a3 3 0 0 1 3 3v2.5"/>' +
       '<path d="M21 15.5V18a3 3 0 0 1-3 3h-2.5"/>' +
       '<path d="M8.5 21H6a3 3 0 0 1-3-3v-2.5"/>' +
       '<path class="g" d="M12 8.6v6.8"/>' +
       '<path class="g" d="M8.6 12h6.8"/>');

/** 桌宠：四枚趾 + 金色掌垫 */
export const ICON_PAW = (): string =>
  MENU('<circle cx="6.3" cy="10" r="1.7"/>' +
       '<circle cx="10" cy="7.1" r="1.7"/>' +
       '<circle cx="14" cy="7" r="1.7"/>' +
       '<circle cx="17.6" cy="9.6" r="1.7"/>' +
       '<path class="g" d="M12 11.6c3.2 0 5.4 2.3 5.4 4.8 0 2.3-2 3.7-5.4 3.7s-5.4-1.4-5.4-3.7c0-2.5 2.2-4.8 5.4-4.8Z"/>');

/**
 * 夜间模式：月牙 + 金色四角星（老项目 index.html:1025 `ICON_MOON`）
 *
 * 🔴🔴 这一对（太阳/月亮）走 **TOP 档 1.7，不是菜单档 1.9**：
 *   老项目的 `syncThemeMenuItem`（index.html:1231）直接把顶栏那两个常量
 *   `ICON_SUN` / `ICON_MOON`（:1025-1026，stroke-width 1.7）塞进菜单项，
 *   而菜单里其它九项用的是行内 svg 的 1.9。这是老项目的**既有事实**（不是我们该"统一"的）。
 *   此前 bj 用 MENU(1.9)，于是日夜间那一项比其它菜单行细一号 —— 用户报障
 *   「有些图标和老版本不一样，比如日间模式的太阳图标」的第一层。
 */
export const ICON_MOON = (): string =>
  TOP('<path d="M20.6 14.3A8.7 8.7 0 0 1 9.7 3.4a8.7 8.7 0 1 0 10.9 10.9Z"/>' +
      '<path class="gf" d="M17.3 3.2l.6 1.5 1.5.6-1.5.6-.6 1.5-.6-1.5-1.5-.6 1.5-.6Z"/>');

/**
 * 日间模式：**小日面 r4.2 + 圈外八根短芒 + 金色圆心 r1.4**（老项目 :1026 `ICON_SUN`，逐字）
 *
 * 🔴🔴 此前 bj 是"大圆 r8.5 + 金色大圆点 r3.4 + 八根长芒"——同一语义的**另一种画法**：
 *   老项目的日面只占中间一小块（r4.2，直径约占 24 格的三分之一），
 *   八根短芒**画在圆外**（`M12 2.6v2` 起于半径 7.4 处），圆心一枚金色实心点；
 *   bj 的圆几乎撑满整格（r8.5）且芒从 2.2 起（离边缘只剩 1.1 格），
 *   观感是"一个实心大饼"而不是"一轮小太阳"——这是用户报障点名的那条。
 */
export const ICON_SUN = (): string =>
  TOP('<circle cx="12" cy="12" r="4.2"/>' +
      '<path d="M12 2.6v2"/><path d="M12 19.4v2"/>' +
      '<path d="M2.6 12h2"/><path d="M19.4 12h2"/>' +
      '<path d="M5.3 5.3 6.8 6.8"/><path d="M17.2 17.2 18.7 18.7"/>' +
      '<path d="M18.7 5.3 17.2 6.8"/><path d="M6.8 17.2 5.3 18.7"/>' +
      '<circle class="gf" cx="12" cy="12" r="1.4"/>');

/** 修改口令：斜钥匙 + 金色钥匙环 */
export const ICON_KEY = (): string =>
  MENU('<path d="M11.2 12.8 20 4"/>' +
       '<path d="M16.4 7.6 19 10.2"/>' +
       '<path d="M13.6 10.4l2.2 2.2"/>' +
       '<circle class="g" cx="8.2" cy="15.8" r="4.2"/>');

/** 退出锁定：锁体 + 斜锁梁 + 金色锁孔 */
export const ICON_LOCK = (): string =>
  MENU('<rect x="4" y="10" width="16" height="10.5" rx="3"/>' +
       '<path d="M7.8 10V7.6a4.2 4.2 0 0 1 8.2-1.4"/>' +
       '<circle class="gf" cx="12" cy="14.3" r="1.35"/>' +
       '<path class="g" d="M12 15.6v1.7"/>');

/** 关于：圆面 + 金色感叹号 */
export const ICON_INFO = (): string =>
  MENU('<circle cx="12" cy="12" r="8.5"/>' +
       '<path class="g" d="M12 11.1v5.1"/>' +
       '<circle class="gf" cx="12" cy="7.9" r="1.1"/>');

/** 关闭（弹层右上角 ×）：描边 2，比图标档粗一号 */
export const ICON_X = (): string =>
  svg('<path d="M6 6l12 12"/>' +
      '<path d="M18 6L6 18"/>', 2);

/** 返回（二级视图左上角左箭头）。与 ICON_X 分开：语义不同，形状也必须不同。 */
export const ICON_BACK = (): string =>
  TOP('<path d="M14.5 5.5 8 12l6.5 6.5"/>');

/* ---------------- 落地页 trust 三列（老项目 index.html:643-645，描边 1.7） ---------------- */

/** 服务器只见密文：盾 + 金色对勾 */
export const ICON_TRUST_LOCK = (): string =>
  TOP('<path d="M12 2.8 4.6 5.6v5.6c0 4.7 3.1 7.9 7.4 9.4 4.3-1.5 7.4-4.7 7.4-9.4V5.6Z"/>' +
      '<path class="g" d="m8.7 11.9 2.3 2.3 4.3-4.7"/>');

/** 无需账号：开口圆 + 金色圆点（人形） */
export const ICON_TRUST_NOACCT = (): string =>
  TOP('<path d="M19.4 17.8A8.4 8.4 0 1 0 4.6 17.8"/>' +
      '<circle class="gf" cx="12" cy="9" r="3"/>');

/** 扫码跨设备：双屏 + 金色中划 */
export const ICON_TRUST_SCAN = (): string =>
  TOP('<rect x="2.5" y="4.5" width="13" height="9.6" rx="1.8"/>' +
      '<path d="M6 19.5h6"/>' +
      '<path d="M9 14.1v5.4"/>' +
      '<rect x="16.5" y="8.5" width="5" height="10.5" rx="1.6"/>' +
      '<path class="g" d="M17.7 16.7h2.6"/>');

/* ---------------- 其余此前缺失的图标 ---------------- */

/** 收藏列表行内的金星（收藏夹视图） */
export const ICON_STAR_FILLED = (): string =>
  MENU('<path class="gf" d="M12 3.8l2.4 4.9 5.4.8-3.9 3.8.9 5.4-4.8-2.5-4.8 2.5.9-5.4-3.9-3.8 5.4-.8z"/>');

/** 新建（收藏夹 / 历史列表里的 + 号） */
export const ICON_PLUS = (): string =>
  MENU('<path class="g" d="M12 5.5v13"/><path class="g" d="M5.5 12h13"/>');

/** 手机（跨设备 / App 相关行的图标） */
export const ICON_PHONE = (): string =>
  MENU('<rect x="6.5" y="2.5" width="11" height="19" rx="2.6"/>' +
       '<path class="g" d="M10.6 18.6h2.8"/>');

/** 地球（历史版本里的跨端同步标记） */
export const ICON_GLOBE = (): string =>
  MENU('<circle cx="12" cy="12" r="8.5"/>' +
       '<path class="g" d="M3.5 12h17"/>' +
       '<path d="M12 3.5c2.2 2.4 3.4 5.4 3.4 8.5s-1.2 6.1-3.4 8.5' +
       'c-2.2-2.4-3.4-5.4-3.4-8.5S9.8 5.9 12 3.5Z"/>');

/** 勾（操作成功 / 已同步） */
export const ICON_CHECK = (): string =>
  TOP('<path class="g" d="m5 12.5 4.5 4.5L19 7.5"/>');

/* ---------------- 链接打开方式（二级页两枚专属图标）----------------
 * 🔴 逐字抄老项目 index.html 的两个 path（用户报障第 4 条
 *   「没有显示系统浏览器图标」—— bj 此前两行共用一个通用槽位，
 *   浏览器那行干脆没图标）。SVG path 一个坐标都不能改，
 *   改了就是"另一个图标"而不是"同一个图标"。 */

/** 应用内打开：手机 + 底部横条（老项目 `#linkOptInapp` 的 svg） */
export const ICON_LINK_APP = (): string =>
  MENU('<rect x="6.6" y="3" width="10.8" height="18" rx="2.6"/>' +
       '<path class="g" d="M10.4 17.6h3.2"/>');

/** 系统浏览器打开：地球 + 经纬线（老项目 `#linkOptBrowser` 的 svg） */
export const ICON_LINK_BROWSER = (): string =>
  MENU('<circle cx="12" cy="12" r="8.5"/>' +
       '<path class="g" d="M3.6 12h16.8"/>' +
       '<path d="M12 3.5c2.4 2.2 3.6 5 3.6 8.5s-1.2 6.3-3.6 8.5c-2.4-2.2-3.6-5-3.6-8.5S9.6 5.7 12 3.5Z"/>');

/** 游戏喇叭（彩蛋层音效开关） */
export const ICON_SPEAKER = (): string =>
  svg('<path d="M4 9.5h3.2L12 5.2v13.6L7.2 14.5H4a1 1 0 0 1-1-1v-3a1 1 0 0 1 1-1Z"/>' +
      '<path class="g" d="M15.4 9.4a3.6 3.6 0 0 1 0 5.2"/>' +
      '<path class="g" d="M18 6.8a7.2 7.2 0 0 1 0 10.4"/>', 1.8);

/** 桌宠猫脸（桌宠层开关，卡通描边档） */
export const ICON_CAT = (): string =>
  MENU('<path d="M4.6 9.4 4.2 4.2l4 2.6a8.6 8.6 0 0 1 7.6 0l4-2.6-.4 5.2"/>' +
       '<path d="M4.6 9.4a7.4 7.4 0 0 0 14.8 0 7.4 7.4 0 0 0-14.8 0Z"/>' +
       '<circle class="gf" cx="9.4" cy="12.4" r="1.15"/>' +
       '<circle class="gf" cx="14.6" cy="12.4" r="1.15"/>' +
       '<path class="g" d="M12 15v1.1"/>');

/** 右向箭头（二级视图的"进入"标记，描边 1.7） */
export const ICON_CHEVRON = (): string =>
  TOP('<path class="g" d="M9.5 5.5 16 12l-6.5 6.5"/>');

/**
 * 产品 Logo —— **1:1 复刻老项目「品牌 3A 全细节版」**（老项目 `index.html:620-629`）。
 *
 * 🔴🔴🔴 这里原先是一套**另画的** logo（一个整圆 + 两段同心弧 + `<text>` 渲染的 N），
 *   看着"差不多"，实际与老项目**完全不是同一个标志**：
 *     - 老项目：两段**对称圆弧**（开口对角）+ 两段**直角尖**装饰 + 衬线 N 用 **path 描边字形**
 *     - 原新项目：一个 **circle 整圆**（老项目根本没有闭合圆）+ 弧线参数完全不同
 *                 + N 用 `<text>` 元素（依赖系统 Georgia 字体，**跨平台字形不一致**）
 *   用户天天看的品牌标，换了就是"这不是我那个 NoteSync"。
 *
 * 🔴 为什么 N 必须是 `<path>` 而不能用 `<text>`：
 *   `<text>` 的实际字形由**运行环境字体**决定。Windows / iOS / Android 上
 *   Georgia（或回退 serif）的 N 字形**宽窄与衬线角度都不同**，
 *   同一个 logo 在不同设备上会长得不一样。path 是固定坐标，永远一致。
 *
 * 🔴 `stroke-width` 2.3，与老项目**逐字相同**。原新项目用了 1.4 / 1.6，
 *   细了近一半 —— 在 17px 顶栏尺寸下几乎看不见弧环。
 */
export const LOGO = (): string =>
  '<svg class="ns-logo" viewBox="0 0 48 48" fill="none" aria-hidden="true">' +
  // 双弧环：两段对称圆弧，开口对角
  '<g stroke="currentColor" stroke-width="2.3" stroke-linecap="round">' +
  '<path d="M40.5 14.5A19 19 0 0 1 14.5 40.5"/>' +
  '<path d="M7.5 33.5A19 19 0 0 1 33.5 7.5"/>' +
  '</g>' +
  // 直角尖：左上 / 右下两处装饰角
  '<g stroke="currentColor" stroke-width="2.3" stroke-linecap="round" stroke-linejoin="round">' +
  '<path d="M14.5 35.5v5h-5"/>' +
  '<path d="M33.5 12.5v-5h5"/>' +
  '</g>' +
  // 衬线 N：path 字形，非 <text>
  '<path d="M18.72 16.96h2.2l6.16 11V16.96h2.2v14.08h-2.2l-6.16-11V31.04h-2.2Z" fill="currentColor"/>' +
  '</svg>';

/**
 * 顶栏 / 菜单里用的**小号** logo（老项目 `index.html:650` 同一枚 path，描边 3.6）。
 *
 * 🔴🔴 尺寸被老项目用 CSS **按视口 clamp** 到 17–27px；原新项目写死 `width="48"`，
 *   而顶栏格只有 17px 高 —— 一个 48px 的 SVG 塞进 17px 格子里，
 *   实际渲染成一团糊的色块，还会把顶栏行高撑开。
 *   ⇒ 这里**不写死 width/height**，尺寸交给 CSS（见 styles.css 的 `.ns-brand .ns-mark svg`），
 *   与老项目「用 CSS 缩放 SVG、HTML 里不写尺寸」的做法一致。**恒定 17px，不随视口变。**
 *
 * 🔴 描边 3.6 而不是 2.3：小尺寸下必须加粗才看得见弧环，
 *   这是老项目"同一枚 logo 两档描边"的原意（顶栏档 3.6 / 落地页档 2.3）。
 *
 * 🔴🔴 2026-10-07 删掉了 svg 上的 `class="ns-logo-sm"`（用户报障第 5 条
 *   「左上角 Logo 大小和老版本不一样」）。此前那条 class 挂着一份
 *   `width:clamp(17px,4.4vw,27px)`，让视口 ≥386px 时 logo 就开始变大、
 *   ≥614px 到 27px；**老项目 index.html:102 是恒定 17px，全文零 clamp**。
 *   现在尺寸由 `.ns-brand .ns-mark svg` 承担（与老项目 :102 逐值等价）。
 *   ⚠️ 删 clamp 的同时**必须**有那条规则接手：SVG 没有 width/height 属性时
 *   默认占 300×150，只给外层 span 定尺寸是约束不住它的。
 */
export const LOGO_SM = (): string =>
  '<svg viewBox="0 0 48 48" fill="none" aria-hidden="true">' +
  '<g stroke="currentColor" stroke-width="3.6" stroke-linecap="round">' +
  '<path d="M40.5 14.5A19 19 0 0 1 14.5 40.5"/>' +
  '<path d="M7.5 33.5A19 19 0 0 1 33.5 7.5"/>' +
  '</g>' +
  '<path d="M18.72 16.96h2.2l6.16 11V16.96h2.2v14.08h-2.2l-6.16-11V31.04h-2.2Z" fill="currentColor"/>' +
  '</svg>';
