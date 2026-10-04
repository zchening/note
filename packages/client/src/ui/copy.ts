/**
 * 界面文案 —— **全项目可见中文的唯一出处**
 *
 * 🔴🔴 为什么单独一个文件：用户要求「体验与老项目完全一致」，所以这些字是**契约**。
 *   文案散落在各渲染函数里必然漂移 —— 改按钮时顺手改个标点，谁都发现不了。
 *   集中在这里 + 测试逐字断言，才是真纪律。
 *
 * 全部逐字抄自 `TraeProject/notesync/index.html`（见 ARCH.md §4.2.1），
 * **一个字都不许改**。测试 `ui-copy.test.mjs` 会逐条比对。
 */

export const COPY = {
  /* 落地页 */
  brandName: 'NoteSync',
  landingSub: '落笔即心安',
  landingPlaceholder: '笔记名（英文/数字）',
  landingBtnOpen: '打开',
  /** 命中彩蛋保留字时按钮文案 */
  landingBtnEgg: '打开彩蛋',
  landingWarn: '仅支持英文、数字、下划线和短横线',
  landingUrlPrefix: '你的笔记网址为：',
  landingScan: '扫码打开笔记',
  trustCipher: '服务器只见密文',
  trustNoAccount: '无需账号',
  trustScan: '扫码跨设备',
  /** 彩蛋门牌提示：`{name} 是彩蛋门牌，不会新建笔记` */
  eggReservedTip: (name: string): string => `${name} 是彩蛋门牌，不会新建笔记`,

  /* 口令页 */
  passTitle: '输入口令',
  passHint:
    '此口令用于在本机派生加密密钥，不会发送到服务器。每台新设备首次打开需输入一次，之后自动记住。',
  passBtn: '解 锁',
  /** 口令页右上角 × 的 title */
  passCloseTitle: '返回首页',

  /* 首页提示页 */
  homeTitle: 'NoteSync',
  homeHintLead: '请在 URL 后加笔记名访问，例如：',

  /* 底栏 */
  statusConnecting: '连接中…',
  offlinePrefix: '· 最后同步：',

  /* 编辑器宿主（无障碍标签） */
  editorAria: '笔记正文',

  /* 菜单：主视图 11 项 */
  menuHome: '返回首页',
  menuFavOn: '收藏笔记',
  menuFavOff: '取消收藏',
  menuFavEntry: '收藏夹',
  menuHistEntry: '历史版本',
  menuLink: '打开链接',
  menuBackup: '扫码换机',
  menuPet: '桌宠',
  menuThemeDark: '夜间模式',
  menuThemeLight: '日间模式',
  menuPass: '修改口令',
  menuLock: '退出锁定',
  menuAbout: '关于 NoteSync',

  /* 菜单：二级视图 */
  back: '返回',
  favEmpty: '暂无收藏',
  histEmpty: '暂无历史版本',
  histSave: '新增历史版本',
  linkKicker: '链接打开方式',
  linkInApp: '应用内',
  linkBrowser: '系统浏览器',
  linkHint: '笔记里的网址默认打开方式，仅对本机生效。',

  /* 顶栏 title（老项目原文，含全角括号） */
  titleStrike: '删除线',
  titleRemind: '提醒（到点通知或下次打开提示）',
  titleUpload: '上传图片',
  titleCopy: '复制到剪贴板',
  titleExport: '导出为图片并复制',
  titleScan: '扫一扫',
  titleQr: '二维码配对',
  titleMenu: '菜单',
  titleRefresh: '刷新',
} as const;

/**
 * 菜单项 id 清单 —— 与 ARCH.md §4.2.1 的 11 项一一对应。
 * 🔴 不用 data-act：老项目就是 id + .menu-item，测试也按id 找，两边一致才不会错位。
 */
export const MENU_ITEM_IDS = [
  'menuHome',
  'menuFav',
  'menuFavEntry',
  'menuHistEntry',
  'menuLink',
  'menuBackup',
  'menuPet',
  'menuTheme',
  'menuPass',
  'menuLock',
  'menuAbout',
] as const;

/** 顶栏可见 7 键的 id。themeBtn / lock 被 CSS 隐藏，不在此列。 */
export const TOPBAR_VISIBLE_IDS = [
  'strikeBtn',
  'remBtn',
  'uploadBtn',
  'copyBtn',
  'exportImgBtn',
  'scanBtn',
  'qrBtn',
] as const;

/** 顶栏被CSS 永久隐藏的两个键（功能已迁入菜单，复刻要保留"看不见"的事实）。 */
export const TOPBAR_HIDDEN_IDS = ['themeBtn', 'lock'] as const;
