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
  /**
   * 空态占位符（老项目 index.html:746 `data-ph="开始输入，自动同步到所有设备…"`）。
   * 🔴 逐字抄老项目，含那个竖排省略号「…」（不是「...」也不是「⋯」）。
   */
  editorPlaceholder: '开始输入，自动同步到所有设备…',

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

  /* 关于页 */
  aboutTitle: '关于 NoteSync',
  close: '关闭',
  aboutWeb: '网页',
  /** App 版本行的键；整行仅在 App 壳内显示 */
  aboutApp: 'App',
  aboutAuthor: '作者',
  aboutAuthorName: '@zchening',
  aboutUpdate: '更新',

  /* App 在线升级（仅壳内可见；网页版 F5 即最新） */
  upd: {
    checkBtn: '检查更新',
    checking: '检查中…',
    alreadyLatest: '已是最新版本',
    /** 服务端还没发过版（/api/latest 404）——正常状态，不是故障 */
    noRelease: '还没有可安装的新版本',
    /** 🔴 服务端发了版但 Release 里没挂 APK ——这是部署漏了，必须说清，
     *   否则用户只会看到"检查了但永远没结果"。 */
    noApk: '发现新版本，但下载包还没挂上，请稍后再试',
    fail: '检查失败，稍后再试',
    webNoUpdate: '网页版无需更新，刷新页面即可',
    newVersion: (v: string): string => `新版本：v${v}`,
    /** 括号里的包大小 */
    size: (m: string): string => `（${m}M）`,
    now: '立即更新',
    later: '以后再说',
    retry: '重试',
    preparing: '准备下载…',
    downloading: (p: number): string => `正在下载 ${p}%`,
  },

  /* 菜单：二级视图 */
  back: '返回',
  favEmpty: '暂无收藏',
  /** 收藏夹列表上方的计数行：`{n}` 是篇数 */
  favKicker: (n: number): string => `收藏 · ${n} 篇`,
  /** 收藏超过上限时的提示：`{n}` 是上限 */
  favFull: (n: number): string => `收藏最多 ${n} 篇，已把最旧的一篇挤出去`,
  histEmpty: '暂无历史版本',
  histSave: '新增历史版本',
  linkKicker: '链接打开方式',
  linkInApp: '应用内',
  linkBrowser: '系统浏览器',
  linkHint: '笔记里的网址默认打开方式，仅对本机生效。',

  /* 冲突裁决（老项目底部状态栏给提示，裁决入口在这里） */
  conflictTitle: '同步冲突',
  conflictKicker: '两台设备同时改了同一处，请选保留哪一份：',
  conflictKeepLocal: '保留这台设备的',
  conflictKeepRemote: '保留云端的',
  conflictEmpty: '当前没有冲突',

  /* 提醒：响铃卡片（老项目 remCard，页内主通道 —— 无论通知权限如何都弹） */
  remCardTitle: '提醒',
  remCardAck: '知道了',
  /** 补弹时的迟到提示：`{m}` 已被填成「12分钟」或「3 小时」 */
  remCardLate: (m: string): string => `已过 ${m}`,
  remLateMin: (n: number): string => `${n} 分钟`,
  remLateHour: (n: number): string => `${n} 小时`,
  /** 通知正文：`来自笔记 · {id}` */
  remNotifyBody: (id: string): string => `来自笔记 · ${id}`,
  /** 通知标题：⏰ + 事项，事项为空时的兜底文案 */
  remNotifyFallback: '该看笔记了',
  /** 通知 tag，多条提醒共用一个以免刷屏 */
  remNotifyTag: 'notesync-rem',

  /* 提醒：时间 chip（光标落在时间串上浮出）。老项目 v7.8.0 起是三行小卡，不是单行胶囊 */
  remChipAdd: '添加提醒',
  remChipAdded: '✅ 提醒已添加',
  /** 时间 chip 关闭按钮的 aria */
  remChipClose: '关闭',
  /** chip 上时间行：`{time}　{item}` */
  remChipWhen: (time: string, item: string): string => (item ? `${time}　${item}` : time),

  /* 提醒：面板（老项目 remPanel，时/分滚轮 + 事项 + 已设列表） */
  remPanelTitle: '提醒',
  remItemPlaceholder: '事项（最多20字）',
  remItemAria: '提醒事项',
  remDateAria: '提醒日期',
  remAddBtn: '添加提醒',
  remCancelOne: '取消这条提醒',
  remCancelGlyph: '×',
  remWheelHhAria: '小时',
  remWheelMmAria: '分钟',
  remIosTip: 'iOS 需先添加到主屏幕才能收到通知（仍可设置，下次打开会提示）',
  remEmpty: '还没有设置提醒',
  /** 面板回写正文的格式：`{time}　{item}` —— 全角空格是分隔符，解析层靠它划「事项区」 */
  remInsertLine: (time: string, item: string): string => (item ? `${time}　${item}` : `${time}　`),
  /** 已过时刻时的accent 提示（老项目只闪红框不弹文字，这里给一句可读的） */
  remPastTip: '这个时间已经过去了，换一个吧',

  /* 提醒：到期与权限 */
  remPermTitle: '开启提醒通知',
  remPermBody: '到点时用通知提醒你，不开启也能在下次打开时看到。',
  remPermOk: '好',
  remCatchupKicker: '上次没打开，以下提醒已过：',

  /* 折叠块 */
  /** 标题行的 title 提示：告诉用户"这里能点" */
  foldToggleTitle: '点这行展开或收起',
  /** 新建折叠块时的默认标题 */
  foldDefaultTitle: '折叠块',
  /** 折叠块正文区的无障碍标签 */
  foldBodyAria: '折叠块内容',

  /* 彩蛋层 */
  /** 彩蛋图鉴标题 */
  eggBookTitle: '彩蛋图鉴',
  /** 图鉴副标题 */
  eggBookSub: '点已发现的彩蛋可立刻再玩一次；带??? 的还没被你撞见。',
  /** 图鉴底部按钮 */
  eggBookClose: '关 闭',
  /** 图鉴计数：`{got} / {total} FOUND` */
  eggCount: (got: number, total: number): string => `${got} / ${total} FOUND`,
  /** 未发现彩蛋的名字占位 */
  eggLockedName: '???',
  /** 未发现彩蛋的提示 */
  eggLockedHint: '还没被发现',
  /** 路由到某个门牌但没注册对应实现时的提示（不静默白屏） */
  eggMissing: (id: string): string => `${id} 这个彩蛋正在赶来的路上`,

  /* 彩蛋游戏外壳（老项目 ns-hud / ns-over 原文） */
  /** HUD 退出键 */
  gameExit: '退出',
  /** 暂停时显示在 HUD 中间那格 */
  gamePaused: '已暂停',
  /** 结算卡：回到笔记 */
  gameBack: '回到笔记',
  /** 结算卡：再来一局 */
  gameAgain: '再来一局',
  /** 结算卡默认标题 */
  gameOver: '这一局结束了',
  /** 结算卡行：得分 */
  gameRowScore: '得分',
  /** 结算卡行：最高 */
  gameRowBest: '最高',
  /** 结算卡行：长度/关卡等 */
  gameRowExtra: '这一局',
  /** 结算卡行：存活秒数 */
  gameRowSurvived: '撑了',
  /** 结算卡行：秒 */
  gameUnitSec: '秒',

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

  /* 图片上传（老项目原文；失败文案必须自带"未插入 + 请重试"） */
  /** 压缩阶段提示 */
  uploadCompressing: '正在压缩图片…',
  /** 直传阶段提示 */
  uploadSending: '正在上传…',
  /** 成功提示，2 秒后自动收 */
  uploadOk: '上传成功',
  /**
   * 失败前缀。后半句由 code 拼「原因，未插入，请重试」。
   * 🔴 为什么失败文案必须这么长：老项目 v10.0.0 关键路径止血 ——
   *   2 秒在手机上根本来不及看清一次失败原因，用户只看到图片没出来，
   *   以为功能坏了。静默失败比报错更伤信任。
   */
  uploadFailPrefix: '上传失败：',
  uploadFailSuffix: '，图片未插入，请重试',
  /** 成功驻留毫秒（老项目 2000） */
  uploadOkMs: 2000,
  /** 失败驻留毫秒（老项目 4500，比成功长一倍以上） */
  uploadFailMs: 4500,

  /* 扫码配对（老项目原文，个别处按新架构改了措辞并注明） */
  /** 出码弹层标题 */
  pairTitle: '扫码配对',
  /**
   * 出码弹层的风险提示。老项目原文是"二维码含解锁密钥"，逐字抄。
   * 🔴 措辞不再改：用户要的是与老项目一致的体验，而"含解锁密钥"这句话
   *   对**用户**仍然是准确的（扫完这台设备确实能解锁），
   *   内部实现从"传密钥"改成"传口令"是用户不可见层，不该外溢到文案。
   */
  pairWarn: '二维码含解锁密钥，等同你的口令：<br>仅限自有设备间扫码，勿截图外传。',
  pairClose: '关 闭',
  /** 锁定态（尚未解锁 → 本机没有可用凭据） */
  pairNeedUnlock: '解锁后才可使用二维码配对',
  /**
   * 兜底失败文案。触发路径：IndexedDB 读不到 key-store（隐私模式/清过数据）
   *   或导出密钥被拒。**绝不能**退化成空按钮或静默无反应
   *   —— 老项目 v5.x 的"哑二维码"就是这条（点它什么都不发生）。
   */
  pairNoKey: '无法读取本机密钥，请退出锁定后重新解锁再配对',
  /** 出码失败（qrcode-generator 没加载 / canvas 拿不到 2D 上下文） */
  pairRenderFail: '二维码生成失败，请检查网络后重试',
  /** 重新显示按钮（60 秒自动隐藏时代的入口，现在码常驻，此键为出码失败后的重试入口） */
  pairReveal: '重新显示',
  /** 配对成功落地后的提示 */
  pairLanded: '已扫码解锁，正在打开笔记',

  /* 取景层（老项目原文） */
  scanTitle: '扫一扫',
  scanTip: '对准另一台设备上的二维码',
  scanCancel: '取 消',
  /** 抓拍识别（反光/对焦不实时连续低清帧必然全 miss，停一帧按全分辨率单张解一次就能中） */
  scanSnap: '别动，抓拍识别',
  /** 相机开启中占位（带三个闪点） */
  scanOpening: '正在开启相机',
  /** 视频出帧后 */
  scanIdentifying: '识别中…',
  /** 6 秒零命中后的取景建议（老项目 v10.1.4：只说"识别中"= 和没反应一个观感） */
  scanAlign: '让码完整落在框里',
  scanHit: '已识别',
  /** 组件加载失败：与"当前环境无法调用摄像头"必须区分（老项目 v6.1） */
  scanCompFail: '扫码组件加载失败，请稍后重试',
  /** 非安全上下文（HTTP）才有这条 */
  scanNeedHttps: '当前环境无法调用摄像头（需 HTTPS）',
  scanDenied: '相机权限被拒绝，请到系统设置里允许相机后重试',
  scanNoCamera: '未检测到可用摄像头，请检查摄像头是否被其他应用占用',
  scanStartFail: '扫码启动失败',
  scanBusy: '扫码已在进行中',
  /** 扫到的不是本系统配对码 */
  scanNotPair: '不是本系统的二维码',
  /** 抓到帧但没解出来 */
  scanSnapMiss: '这一帧没认出来：贴近一点、避开反光后再点一次',
  scanSnapWait: '画面还没准备好，稍等一下再点',
  scanSnapDoing: '正在识别这一帧…',
  scanSnapNoLib: '抓拍组件没能加载上，自动识别仍在继续',
  scanSnapFail: '抓拍失败，自动识别仍在继续',
  /** 成功提示驻留毫秒 */
  scanOkMs: 3000,

  /* 复制到剪贴板（老项目 index.html:2841/2845/2847 原文） */
  /** 双 MIME 写成功 */
  copyOk: '已复制到剪贴板',
  /** 降级：只写成了纯文本，格式没保住 —— 必须说清，否则用户以为格式跟过来了 */
  copyTextOnly: '已复制文字',
  /** 两档都失败 */
  copyFail: '复制失败',
  /** 驻留毫秒（老项目成功/失败都是 2000，同口径） */
  copyOkMs: 2000,
  copyFailMs: 2000,
  /** 顶栏还在但笔记已卸载 */
  copyNoEditor: '请先打开一篇笔记再复制',

  /* 导出长图（老项目原文；失败文案必须自带「图片未生成」） */
  /** 组件加载失败（自托管文件没部署 / 断网 / CSP） */
  exportLoadFail: '图片导出组件未加载，请检查网络后重试',
  /** 渲染过程提示（常驻，被下一条覆盖） */
  exportDoing: '正在生成图片…',
  /** 外链图片跨域导致的失败（SecurityError 要说人话，不能回显英文） */
  exportFailCors: '导出失败：可能因外链图片跨域，请使用支持跨域的图床，图片未生成',
  /** 其他渲染失败：`{msg}` 由异常 message 拼入 */
  exportFailMsg: (msg: string): string => `导出失败：${msg}，图片未生成`,
  /** 渲染完成但没有任何交付出口（理论上不可达，留着兜底） */
  exportFailUnknown: '导出失败：渲染异常，图片未生成',
  /** 成功提示，按实际生效的那一档给不同措辞 */
  exportOkMsg: (kind: string): string =>
    kind === 'native'
      ? '图片已复制，可直接粘贴'
      : kind === 'share'
        ? '已通过系统分享发出'
        : kind === 'preview'
          ? '图片已生成，可长按保存或下载'
          : '图片已复制，可直接粘贴',
  /** 成功驻留毫秒 */
  exportOkMs: 3000,
  /** 失败驻留毫秒（比成功长，与上传同口径） */
  exportFailMs: 4500,
  /* 全屏预览兜底 */
  exportPreviewTitle: '图片已生成',
  exportPreviewAlt: '笔记图片',
  exportPreviewTip: '长按图片可保存或发送；点「下载」也可直接保存',
  exportDownload: '下载',
  exportDone: '完 成',
  /** 编辑器不在时点导出（顶栏还在但笔记已卸载） */
  exportNoEditor: '请先打开一篇笔记再导出',
  /** 非图片文件的拒绝文案 */
  uploadNotImage: '不是图片文件，图片未插入，请重试',
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
