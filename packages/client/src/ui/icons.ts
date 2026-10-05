/**
 * 图标 —— 全部 inline SVG，**不引图标库**
 *
 * 理由（ARCH.md §4.6 运行时零依赖）：图标库就是几百 KB 的第三方代码，
 * 而 E2EE 项目把"产物里每一行代码都审读过"当作投毒防线。
 * 7 个顶栏键 + 11 个菜单项，一共 15 个图标，手写 SVG 是最短路径。
 *
 * 🔴 尺寸约定：`.ic{width:20px;height:20px}`；菜单项里是 26px（老项目 CSS 定的）。
 *   颜色一律 `currentColor`，**不许写死颜色** —— 深浅色切换靠这个自动跟随。
 *   `.g` 类是次要描边（老项目用它做双层线条的分层）。
 */

const svg = (body: string, size = 20): string =>
  `<svg class="ic" viewBox="0 0 24 24" width="${size}" height="${size}" fill="none" ` +
  `stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" ` +
  `aria-hidden="true" focusable="false">${body}</svg>`;

/** 顶栏：删除线（双S 划线 + 横线，与老项目图形一致） */
export const ICON_STRIKE = (): string =>
  svg('<path d="M16.5 5H9.8a3.3 3.3 0 0 0-1.3 6.3"/><path d="M7.5 19h6.7a3.3 3.3 0 0 0 1.3-6.3"/><line class="g" x1="4" x2="20" y1="12.2" y2="12.2"/>');

/** 顶栏：提醒（闹钟） */
export const ICON_REMIND = (): string =>
  svg('<circle cx="12" cy="13.5" r="7"/><path d="M12 10v3.5l2.2 1.6"/><path d="M5.5 4.5 8 3m10.5 1.5L16 3"/>');

/** 顶栏：上传图片（上箭头） */
export const ICON_UPLOAD = (): string => svg('<path d="M12 16V5"/><path d="m7.5 9.5 4.5-4.5 4.5 4.5"/><path d="M4.5 15v2.5A1.5 1.5 0 0 0 6 19h12a1.5 1.5 0 0 0 1.5-1.5V15"/>');

/** 顶栏：复制（双矩形） */
export const ICON_COPY = (): string =>
  svg('<rect x="8.5" y="8.5" width="11" height="11" rx="2"/><path d="M15.5 5.5v-.5A2 2 0 0 0 13.5 3h-8a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h.5"/>');

/** 顶栏：导出为图片并复制（下箭头入托盘） */
export const ICON_EXPORT = (): string =>
  svg('<path d="M12 4.5v10"/><path d="m8 11 4 4 4-4"/><path d="M4.5 15v2.5A1.5 1.5 0 0 0 6 19h12a1.5 1.5 0 0 0 1.5-1.5V15"/>');

/** 顶栏：扫一扫（取景框） */
export const ICON_SCAN = (): string =>
  svg('<path d="M4 8.5V6a2 2 0 0 1 2-2h2.5M15.5 4H18a2 2 0 0 1 2 2v2.5M20 15.5V18a2 2 0 0 1-2 2h-2.5M8.5 20H6a2 2 0 0 1-2-2v-2.5"/><path d="M8.5 12h7"/>');

/** 顶栏：二维码配对（四个方块） */
export const ICON_QR = (): string =>
  svg(
    '<rect x="4" y="4" width="6" height="6" rx="1"/><rect x="14" y="4" width="6" height="6" rx="1"/>' +
      '<rect x="4" y="14" width="6" height="6" rx="1"/>' +
      '<path d="M14 14h2.5v2.5H14zM17.5 17.5H20V20h-2.5zM14 20h1M20 14h-1"/>',
  );

/** 底栏：菜单（三横线，中间一条是 .g 次色） */
export const ICON_MENU = (): string =>
  svg('<path d="M4 6.8h16"/><path class="g" d="M4 12h16"/><path d="M4 17.2h16"/>');

/** 底栏：刷新 */
export const ICON_REFRESH = (): string =>
  svg('<path d="M19.5 12a7.5 7.5 0 1 1-2.2-5.3"/><path d="M19.5 4.5V9H15"/>');

/* ---------------- 菜单项图标 ---------------- */

export const ICON_HOME = (): string =>
  svg('<path d="M4 10.5 12 4l8 6.5"/><path d="M6 9.8V20h12V9.8"/><path d="M10 20v-5h4v5"/>');

export const ICON_STAR = (filled: boolean): string =>
  svg(
    '<path d="m12 4 2.4 4.9 5.4.8-3.9 3.8.9 5.4-4.8-2.6-4.8 2.6.9-5.4L4.2 9.7l5.4-.8z"' +
      (filled ? ' fill="currentColor"' : ''),
  );

export const ICON_FOLDER = (): string =>
  svg('<path d="M4 7.5A1.5 1.5 0 0 1 5.5 6h3.2l1.8 2h8A1.5 1.5 0 0 1 20 9.5v8A1.5 1.5 0 0 1 18.5 19h-13A1.5 1.5 0 0 1 4 17.5z"/>');

export const ICON_CLOCK = (): string => svg('<circle cx="12" cy="12" r="7.5"/><path d="M12 7.5V12l3 2"/>');

export const ICON_LINK = (): string =>
  svg('<path d="M10 13.5a3.5 3.5 0 0 0 5 0l2.5-2.5a3.5 3.5 0 0 0-5-5L11 7.5"/><path d="M14 10.5a3.5 3.5 0 0 0-5 0L6.5 13a3.5 3.5 0 0 0 5 5l1.5-1.5"/>');

/** 扫码换机：取景框 + 加号（与「扫一扫」区分开） */
export const ICON_HANDOFF = (): string =>
  svg('<path d="M4 8.5V6a2 2 0 0 1 2-2h2.5M15.5 4H18a2 2 0 0 1 2 2v2.5M20 15.5V18a2 2 0 0 1-2 2h-2.5M8.5 20H6a2 2 0 0 1-2-2v-2.5"/><path d="M12 9.5v5M9.5 12h5"/>');

/** 桌宠：爪印 */
export const ICON_PAW = (): string =>
  svg(
    '<ellipse cx="7.5" cy="10" rx="1.6" ry="2.1"/><ellipse cx="12" cy="8.2" rx="1.6" ry="2.2"/>' +
      '<ellipse cx="16.5" cy="10" rx="1.6" ry="2.1"/>' +
      '<path d="M12 12.2c2.4 0 4.2 1.8 4.2 3.6 0 1.4-1.1 2.2-2.3 2.2-.7 0-1.2-.3-1.9-.3s-1.2.3-1.9.3c-1.2 0-2.3-.8-2.3-2.2 0-1.8 1.8-3.6 4.2-3.6z"/>',
  );

export const ICON_MOON = (): string => svg('<path d="M20 14.2A8.2 8.2 0 0 1 9.8 4 8.5 8.5 0 1 0 20 14.2z"/>');
export const ICON_SUN = (): string =>
  svg('<circle cx="12" cy="12" r="4"/><path d="M12 3.5v1.8M12 18.7v1.8M3.5 12h1.8M18.7 12h1.8M6 6l1.3 1.3M16.7 16.7 18 18M18 6l-1.3 1.3M7.3 16.7 6 18"/>');

export const ICON_KEY = (): string =>
  svg('<circle cx="8" cy="12" r="3.5"/><path d="M11.5 12H20"/><path d="M17 12v3M20 12v2.2"/>');

export const ICON_LOCK = (): string =>
  svg('<rect x="5" y="10.5" width="14" height="9" rx="2"/><path d="M8.5 10.5V8a3.5 3.5 0 0 1 7 0v2.5"/>');

export const ICON_INFO = (): string => svg('<circle cx="12" cy="12" r="8"/><path d="M12 11v5.5"/><circle cx="12" cy="8" r=".6" fill="currentColor"/>');

/** 关闭（弹层右上角 ×） */
export const ICON_X = (): string => svg('<path d="M6.5 6.5l11 11M17.5 6.5l-11 11"/>');

/** 返回（二级视图左上角左箭头）。与 ICON_X 分开：语义不同，形状也必须不同。 */
export const ICON_BACK = (): string => svg('<path d="M14.5 5.5 8 12l6.5 6.5"/>');

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
 *   （这也是老项目当年特意把 N 描成 path 的原因。）
 *
 * 🔴 `stroke-width` 分两档：弧环 2.3、直角尖 2.3，与老项目**逐字相同**。
 *   原新项目用了 1.4 / 1.6，细了近一半 —— 在 17px 顶栏尺寸下几乎看不见弧环。
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
 * 顶栏 / 菜单里用的**小号** logo（老项目 `index.html:650` 同一枚 path，只是尺寸更小）。
 *
 * 🔴🔴 尺寸被老项目用 CSS **按视口 clamp** 到 17–27px；原新项目写死 `width="48"`，
 *   而顶栏格只有 17px 高 —— 一个 48px 的 SVG 塞进 17px 格子里，
 *   实际渲染成一团糊的色块，还会把顶栏行高撑开。
 *   ⇒ 这里**不写死 width/height**，尺寸交给 CSS 的 clamp（见 styles.css 的 `.ns-mark svg`），
 *   与老项目「用 CSS 缩放 SVG、HTML 里不写尺寸」的做法一致。
 */
export const LOGO_SM = (): string =>
  '<svg class="ns-logo-sm" viewBox="0 0 48 48" fill="none" aria-hidden="true">' +
  '<g stroke="currentColor" stroke-width="3.6" stroke-linecap="round">' +
  '<path d="M40.5 14.5A19 19 0 0 1 14.5 40.5"/>' +
  '<path d="M7.5 33.5A19 19 0 0 1 33.5 7.5"/>' +
  '</g>' +
  '<path d="M18.72 16.96h2.2l6.16 11V16.96h2.2v14.08h-2.2l-6.16-11V31.04h-2.2Z" fill="currentColor"/>' +
  '</svg>';
