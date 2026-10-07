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
  /** 彩蛋门牌提示的**后半句**（老项目 index.html:10190 裸文字节点，逐字照抄）。
   *  前半句是 `/门牌名` 进 `<b>`（金黄 600，老项目 `.eggtip b`）——
   *  所以不能合成一整句文案，否则门牌名就没法单独上色。 */
  eggReservedTipSuffix: ' 是彩蛋门牌，不会新建笔记',

  /* 口令页 */
  passTitle: '输入口令',
  passHint:
    '此口令用于在本机派生加密密钥，不会发送到服务器。每台新设备首次打开需输入一次，之后自动记住。',
  passBtn: '解 锁',
  /** 口令页右上角 × 的 title */
  passCloseTitle: '返回首页',

  /* ── 修改口令弹窗（老项目 index.html:780-793 `#cpMask` 逐字）─────────────
     🔴🔴 用户报障第 12 条「修改口令弹窗和老版本不一样」：
       本项目的第一版实现是 `window.prompt()` 两次——连弹窗都没有，
       更不用说老项目那个「先验证旧口令 → 再设新口令」的**两阶段**形态。
       两阶段不是形式主义：`changePassphrase` 要先用旧口令解开密文自证身份，
       一次弹窗里同时要"旧/新/确认"三个框会让用户不知道先后。 */
  cpTitle: '修改口令',
  /** 老项目 :783 原文（含 <br> 与 <b> 新口令 </b>） */
  cpHintHtml:
    '修改后本机立即用新口令重新加密；<br>其他设备需用<b>新口令</b>重新打开此笔记。',
  cpOldPh: '当前口令',
  cpNewPh: '新口令',
  cpNew2Ph: '再次输入',
  /** 第一阶段按钮（老项目 :789 `#cpOk` 初始文案） */
  cpNext: '下一步',
  /** 第二阶段按钮（老项目 cpVerify 成功后 `cpOk.textContent = '确 定'`） */
  cpDone: '确 定',
  cpCancel: '取消',
  /** 校验旧口令中（老项目 :8296 `cpErr.textContent = '验证中…'`） */
  cpVerifying: '验证中…',
  /** 换密钥中（老项目 :8313 `cpErr.textContent = '重新加密中…'`） */
  cpRotating: '重新加密中…',
  /** 新口令为空（老项目 :8311） */
  cpEmpty: '新口令不能为空',
  /** 两次不一致（老项目 :8312） */
  cpMismatch: '两次输入的新口令不一致',
  /** 换完了（老项目 :8338 `showUploadStatus('口令已修改'…)`；本项目无备份笔记，不带后半句） */
  cpDoneMsg: '口令已修改',

  /* 首页提示页 */
  homeTitle: 'NoteSync',
  homeHintLead: '请在 URL 后加笔记名访问，例如：',

  /* 底栏 */
  statusConnecting: '连接中…',
  /**
   * 🔴 同步成功后的底栏文案 —— 老项目 `setStatus(true, '已同步')`（index.html:7 处调用）。
   *🔴 此前**漏了这个键**：shell.ts 的 synced 分支写 `textContent = detail ?? ''`，
   *   而 footFor('idle') 又不传 detail ⇒ 同步完成后底栏**一个字都不显示**（用户报障第 3 条
   *   「底部没有已同步三个字」）。老项目的 setStatus 是`textContent = text` 无条件赋值，
   *   "静默"只在**不调setStatus** 时成立，而不是靠空串实现 —— 抄错语义就会静默变空。
   */
  statusSynced: '已同步',
  offlinePrefix: '· 最后同步：',
  /**
   *🔴 以下三条是 footFor() 喂给 footText() 的 detail 文案。
   *   此前它们以字面量硬编码在 main.ts 的 footFor 里，而 fsm.ts 又另有一份
   *   从没被引用的 STATE_LABEL —— **同一个"状态→文案"映射散在两处、其中一处是死的**。
   *   这正是"底部没有已同步三个字"能长期存活的原因：改了/没改都看不出。
   *   可见文案一律归COPY（ui层），fsm 只管状态迁移，不碰文案。
   */
  footSaving: '保存中…',
  footOffline: '离线中，改动会在恢复后自动同步',
  footConflict: '两台设备改了同一处，正在等你选保留哪一份',

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

  /* ── 扫码换机（弹层，不是独立页面；依据见 migrate/panel.ts 文件头）─────
     两态文案：备份侧（make）与恢复侧（take）。
     🔴🔴 本段曾整段自创措辞（「把当前这篇笔记生成一张换机码…」/「生成换机码」/「知道了」），
       现按老项目 index.html:924-939 bakMask 逐字翻案。用户第 13/15 条报的就是这层。
     🔴「口令不进码」这条安全设计**必须有可见文案兜底**：
        用户在新设备上看到"你的口令"输入框才知道还要手输，
        否则他会对着二维码反复扫，怀疑是功能坏了。 */
  migrateTitle: '扫码换机',
  // 🔴 老项目 index.html:926 原文（含 <b> 备份笔记 </b> 强调，panel.ts 按 innerHTML 分段注入）
  migrateMakeLeadHtml:
    '换机备份要用口令为专用的<b>备份笔记</b>派生密钥：<br>收藏夹里笔记的密钥都写进它，扫一扫整体带走。',
  migrateMakeLead: '换机备份要用口令为专用的备份笔记派生密钥：收藏夹里笔记的密钥都写进它，扫一扫整体带走。',
  // 🔴 老项目 index.html:929 原文是「生成备份码」（不是「生成换机码」——那三个字是新项目自造的）
  migrateMakeGo: '生成备份码',
  migrateTakeGo: '恢复',
  migrateTakeLead: '粘贴旧设备上的换机码，再输入原来的口令。',
  migrateCodePh: '粘贴换机码',
  migratePassPh: '你的口令',
  migrateCancel: '取消',
  migrateWorking: '正在写入备份…',
  /** 出码后提示：点码可放大（老项目 v10.1.7：放大改成手动后屏上必须补这条指引） */
  migrateScanTip: '在新设备上打开首页，扫一扫对准这张码。看不清就点一下码。',
  /**
   * 🔴 收藏备份码的出码提示（老项目 index.html:9187 逐字，**由调用方算好篇数后传进来**）：
   *   '新设备首页「扫码打开笔记」对准它，一键恢复 ' + n + ' 篇' +（…）+ '。看不清就点一下码'
   *
   * 🔴🔴 为什么单独一条、而不是把 migrateScanTip 改掉：
   *   两条是**不同的码**，给两句不同的话。收藏清单码的出码提示必须报"一键恢复 N 篇"——
   *   那是这张码唯一的用途说明；单篇换机码那句没有篇数概念。
   *   合并成一句就会有一边变成谎报。
   *   实际逐字由 `favBackupTip()` 生成（老项目三段逐字，见 migrate/fav-backup.ts）。
   */
  migrateFavScanTip: '新设备首页「扫码换机」对准它，一键恢复',
  migrateDoneMsg: '已恢复，可以继续编辑了',
  // 🔴 老项目 index.html:937 是「关 闭」（**中间一个全角空格**），不是「知道了」
  migrateDoneClose: '关 闭',
  migrateNeedPass: '请输入口令',
  migrateNeedCode: '请先粘贴换机码',
  migrateRenderFail: '二维码生成失败，请重试',
  /** 文档超出定长容量。老项目有同款"超限不静默截断"的纪律（BAK_MAX / capped）。 */
  migrateTooLong: '这篇笔记太长，扫码换机装不下，请改用别的方式搬运',
  migrateNotMigrate: '这不是换机码，请检查是否复制完整',
  /* 收藏备份码（nsfav1:）专有文案。
     🔴🔴 这几句**不是老项目原文**——老项目那个卡片压根没有"收藏夹是空的"这一态
       （它有备份槽就一定有收藏）。但 bj 必须有：收藏夹空时点「扫码换机」，
       出来一张"恢复 0 篇"的码是纯骗人。老项目 :9245 有一句同源口气的
       「这份备份里没有可恢复的笔记」，本项目两句都按它的口径写。 */
  /** 收藏夹为空，没东西可备份（老项目 :9245「这份备份里没有可恢复的笔记」同源） */
  migrateNoFav: '收藏夹里还没有收藏，先收藏几篇再回来',
  /** 收藏夹里的篇数超出单张码的容量 —— 明说装不下，绝不静默截断（老项目 capped 纪律） */
  migrateTooManyFav: '收藏夹里的篇数太多，一张码装不下',
  /** 码解开了但里面一篇都没有（老项目 :9245 逐字同款） */
  migrateNothingRestored: '这份备份里没有可恢复的笔记',
  /** 🔴 落盘失败（隐私模式 / 配额满）。绝不能在这时候报"已恢复" —— 那是谎报。 */
  migrateFavWriteFail: '收藏夹写不进去，请检查浏览器的隐私模式或存储空间',
  // 🔴 老项目 index.html:5759 备份/恢复的锁定态只有一句「请先解锁」。
  //   「解锁后才可生成换机码」是本项目自造的第四种说法，用户第 13 条报的
  //   「解锁后才可使用二维码配对」也是同一类毛病：老项目根本没有这些句子。
  //   统一回老项目那一句。
  migrateNeedUnlock: '请先解锁',

  /* 甲案：清单写进云端一篇专用「备份笔记」，二维码只装它的链接。
     🔴 这一段文案大量是**老项目逐字**，出处标在每一行后面 ——
       出码后的那两句（老项目 index.html:9195/9199）与只读恢复卡（:816-826）
       在 bj 之前压根不存在（清单直接进码，见 migrate/bak-note.ts 文件头）。
     🔴🔴 但**入口引导句必须改**：老项目写「收藏夹里笔记的密钥都写进它」，
       本项目的清单里**没有密钥**（CryptoKey 是 extractable:false，导不出 raw 字节）——
       照抄这句就是**谎报**，用户会以为码里带着钥匙。 */
  migrateBakLeadHtml:
    '换机备份要用口令为专用的<b>备份笔记</b>派生密钥：<br>收藏夹里的篇名写进它，扫一扫整体带走。',
  /** 出码后那行「备份笔记：nsbak-xxxxxx」（老项目 index.html:9195 逐字） */
  migrateBakIdLine: (id: string): string => '备份笔记：' + id,
  /** 出码后屏上指引（老项目 :9187-9190 逐字，本项目把入口指向真正能扫它的按钮） */
  migrateBakScanTip: (n: number): string =>
    '新设备首页「扫码换机」对准它，一键恢复 ' + n + ' 篇。看不清就点一下码',
  /** 只读恢复卡的标题（老项目 :819 `换机备份` 逐字） */
  bakRestTitle: '换机备份',
  /** 只读恢复卡的摘要（老项目 :9227 口径：生成于 + 含 N 篇） */
  bakRestSummary: (tsText: string, n: number): string =>
    (tsText ? tsText + '，' : '') + '含 ' + n + ' 篇笔记。',
  /** 🔴 只读恢复卡的警示（老项目 :823 逐字，含那个 <br>） */
  bakRestWarnHtml: '这里只能读取，不能编辑。<br>要更新备份，回到旧设备上点「扫码换机」。',
  /** 恢复按钮（老项目 :824 `恢复` 逐字；实际文案是「恢复这 N 篇」，见 bakRestGo） */
  bakRestGo: (n: number): string => '恢复这 ' + n + ' 篇',
  bakRestCancel: '先看看',
  /** 「先看看」之后的那句（老项目 :9236 逐字） */
  bakRestReadonly: '这是换机备份笔记，只能读；要更新请回旧设备点「扫码换机」',
  /** 正在恢复（老项目 :9242 逐字） */
  bakRestWorking: '正在恢复…',
  /** 备份笔记上再点「扫码换机」而清单解不开（老项目 :9124 逐字） */
  bakRestBroken: '这篇备份笔记的清单没能解开，请回旧设备重新生成',
  /** 出码失败（网络/离线）。老项目 :9107/:9093 同款口径 */
  bakWriteOffline: '当前离线，换机备份要联网',
  bakWriteFail: '备份写入服务器失败，请检查网络后重试',
  bakWriteUnconfirmed: '备份写入未被服务器确认，请稍后重试',
  /** 本机存的备份密钥已失效，请输入口令（老项目 :9090 逐字） */
  bakKeyLost: '本机存的备份密钥已失效，请输入口令',

  /* 菜单：二级视图 */
  back: '返回',
  favEmpty: '暂无收藏',
  /** 收藏夹列表上方的计数行：`{n}` 是篇数 */
  favKicker: (n: number): string => `收藏 · ${n} 篇`,
  /** 收藏超过上限时的提示：`{n}` 是上限 */
  favFull: (n: number): string => `收藏最多 ${n} 篇，已把最旧的一篇挤出去`,
  histEmpty: '暂无历史版本',
  histSave: '新增历史版本',
  /** 每一行右端的「恢复」按钮（老项目 index.html:8492 `rs.textContent = '恢复'` 逐字） */
  histRestore: '恢复',
  /**
   * 每一行右端的「预览」按钮（老项目 index.html:8481 `pv.textContent = '预览'` 逐字）。
   * 🔴 与「恢复」成对，缺一个这一行就只有一个不可逆的操作（用户报障第 4 条）。
   */
  histPreview: '预览',
  /** 历史列表上方的计数行：`{n}` 是版本数（老项目 index.html:8486「版本 · N 个」） */
  histKicker: (n: number): string => `版本 · ${n} 个`,
  /** 手动打的点（老项目 :8493 逐字：自动的不标注，只有手动带这个后缀） */
  histManualMark: ' · 手动',
  /** 恢复成功（老项目 :8527 逐字） */
  histRestored: '已恢复所选版本',
  /** 手动存一版成功（老项目 :8551 逐字） */
  histSaved: '已保存当前版本',
  /**
   * 某一版取不到/解不开（老项目 markHistBad :8455-8462）。
   * 🔴 不区分"没有这一版"与"解不开" —— 区分开等于给暴力破解一个 oracle
   *   （ARCH 安全不变量，与解锁失败同一句文案）。
   */
  /** 某一版取不到/解不开（老项目 markHistBad :8455-8462） */
  histBad: '该版本不可用',
  /** 取某一版时网络异常（老项目 :8504/:8519 逐字） */
  histNetFail: '网络异常，请重试',
  /**
   * 🔴 预览的**网络**失败（老项目 index.html:8486逐字：「预览失败：网络异常，请重试」）。
   * 🔴 必须与 `histNetFail` 分开两句：那是"恢复"的失败话术。
   *   合成一句的话用户分不清是预览没成还是恢复没成，而这两个后果完全不同
   *   （预览失败 = 只是看一眼没看成；恢复失败 = 内容可能没换成功）。
   */
  histPreviewNetFail: '预览失败：网络异常，请重试',
  /**
   * 预览展开后正文为空（老项目 `... || '（空）'` 同款，index.html:8489）。
   * 🔴 不能让它显示成空白框：用户会以为"这一版没内容"，进而以为历史坏了。
   */
  histPreviewEmpty: '（空）',
  /** 列表都取不到（老项目 loadHistList 整段 catch） */
  histListFail: '历史版本读取失败，请检查网络后重试',
  /** 没解锁时点历史（老项目 :8548 逐字） */
  histNeedUnlock: '请先解锁',
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
  /** 确认卡尾部「删除」伪按钮的文字（老项目 index.html:6488 `d.textContent = '删除'`） */
  remChipDeleteLabel: '删除',
  /** 同上按钮的 aria-label（老项目 index.html:6348 aria-label 逐字「删除这条提醒」） */
  remChipDelete: '删除这条提醒',
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
  /** 面板回写正文的格式：`{time}　{item}` —— 全角空格是分隔符，解析层靠它划「事项区」 */
  remInsertLine: (time: string, item: string): string => (item ? `${time}　${item}` : `${time}　`),
  /** 已过时刻的拦截提示。
   *  🔴 老项目 index.html:7299 原文「已过去的时间不能设提醒」——
   *    走的是**顶部提示条**（addReminder 的兜底闸门），不是面板里的一行文字。
   *    面板内只闪红框（`bads.forEach(x => x.classList.add('bad'))` 后 900ms 移除，
   *    index.html:7740）。此前新项目在面板里插了一行「这个时间已经过去了，换一个吧」，
   *    那是老项目里不存在的文案，还把弹窗顶高一截。 */
  remPastTip: '已过去的时间不能设提醒',

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

  /* 「插入图片方式」二选一（纯触屏点上传才出现，老项目 index.html:2807-2818） */
  insertImageTitle: '插入图片',
  insertImageSub: '选一种方式，图片会自动压缩上传',
  /** 🔴 「拍 照」中间那个空格是老项目 :2813 原文，不是打字错。 */
  insertImageShoot: '拍 照',
  insertImageAlbum: '从相册选择',

  /* 正文图片查看器提示（老项目 index.html:5459 按nsHoverPointer 分两支，逐字） */
  imgZoomTipFine: '滚轮缩放 · 双击 1:1 · 点空白关闭',
  imgZoomTipTouch: '双指缩放 · 点图片即回笔记',

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
  /** 🔴 老项目 index.html:774 标题下方的引导段，此前新项目漏了整段。
   *  含 <br>，用 innerHTML 注入（内容是本项目常量，不含用户输入）。 */
  pairLead: '用另一台设备扫描二维码，<br>直接打开此笔记，无需输入口令。',
  /**
   * 出码弹层的风险提示。老项目原文是"二维码含解锁密钥"，逐字抄。
   * 🔴 措辞不再改：用户要的是与老项目一致的体验，而"含解锁密钥"这句话
   *   对**用户**仍然是准确的（扫完这台设备确实能解锁），
   *   内部实现从"传密钥"改成"传口令"是用户不可见层，不该外溢到文案。
   */
  pairWarn: '二维码含解锁密钥，等同你的口令：<br>仅限自有设备间扫码，勿截图外传。',
  pairClose: '关 闭',
  /** 锁定态提示。
   *  🔴🔴 本条**曾被我误判为"新项目自造"**，已撤回。
   *   它是老项目原文（index.html:3335 resetQrHolder）：
   *     const hint = document.createElement('p');
   *     hint.className = 'qr-lock-warn';
   *     hint.textContent = '解锁后才可使用二维码配对';
   *   第一次 grep 时只搜了 showUploadStatus 与字面量，漏掉了这条，
   *   于是差点把用户第 13 条报的这句话当成"新项目凭空加的"删掉 ——
   *   那正好删掉了用户**在老项目里见过的那句话**。
   *   教训：判"某句文案是老项目原文还是自创"时，grep 范围必须覆盖
   *   所有赋值途径（textContent / innerHTML / 模板串），只搜一种会误判。
   *  配对侧锁定态仍应显示这句：老项目在这个状态下确实只给提示，不给码。 */
  pairNeedUnlock: '解锁后才可使用二维码配对',
  /** 🔴 S9 新增：记忆解锁（unlockIfRemembered 成功）时本机没有口令时的可执行提示。
   *
   *  背景：新项目的 CryptoKey 是 extractable:false，raw 字节导不出，
   *  所以配对码只能装**口令**（见 scan/pair-link.ts 文件头的权衡说明）。
   *  而「记忆解锁」这条路径（route() 里 unlockIfRemembered 成功）**本来就没经过口令**，
   *  于是 sessionPass 为空 → 出码函数拿不到载荷 → 只能显示上面那句「解锁后才可使用」。
   *  用户看到的就是：明明已经在编辑正文了，点配对却说没解锁（用户报障第 13 条）。
   *
   *  为什么不照抄老项目：老项目把 raw key 明文存 localStorage（KEY_STORE），
   *  所以"记忆解锁后出码"对它天然成立。照抄就得先把密钥降级成可导出，
   *  等于亲手把「XSS 拿到密钥即可离线解开全部历史密文」这个缺口请回来。
   *  省掉的是一次输入，赔进去的是全部历史数据 —— 不划算。
   *  所以给的是可执行的一步（锁定 → 解锁 → 出码），而不是偷偷存口令。
   */
  pairNeedPassphrase: '本机未保留口令，无法生成配对码。请先锁定，再解锁一次即可生成。',
  /** 上面那条提示里的行动按钮 */
  pairLockNow: '锁定笔记',
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
  exportLoadFail: '图片导出组件加载失败，请检查网络后重试',
  /** 渲染过程提示（常驻，被下一条覆盖） */
  exportDoing: '正在生成图片…',
  /** 外链图片跨域导致的失败（SecurityError 要说人话，不能回显英文）
   *  🔴 老项目 index.html:2922 原文：「导出失败：可能因外链图片跨域，请使用支持CORS的图床」
   *    —— **没有「，图片未生成」后缀**。此前新项目自己加的后缀是凭空多出来的字，
   *    用户可见文案必须与老项目逐字一致。 */
  exportFailCors: '导出失败：可能因外链图片跨域，请使用支持CORS的图床',
  /** 其他渲染失败：`{msg}` 由异常 message 拼入（老项目 index.html:2922 同款，无后缀） */
  exportFailMsg: (msg: string): string => `导出失败：${msg}`,
  /** 渲染完成但没有任何交付出口（老项目 index.html:2923 原文「导出失败：渲染异常」） */
  exportFailUnknown: '导出失败：渲染异常',
  /** 成功提示，按实际生效的那一档给不同措辞
   *  🔴🔴 逐字对照老项目（index.html:2915 / 2931 / 2937 / 2955）：
   *    - 剪贴板两档（Promise 形态 + Blob 重试）都是**「图片已复制，可直接 Ctrl+V 粘贴」**
   *      —— 用户报的第 11 条就是这里：新项目把默认档也写成了「可直接粘贴」，
   *      少了「Ctrl+V」。这是最常走的一档（PC 浏览器点复制就落这里）。
   *    - 只有 App 原生桥那档是「图片已复制，可直接粘贴」（触屏没有 Ctrl+V 这个动作）。
   *    - 分享档「已通过系统分享发出」，预览档老项目**根本不给提示条**
   *      （showImagePreview 第一行就是 hideUploadStatus，见 index.html:2967）。 */
  exportOkMsg: (kind: string): string =>
    kind === 'native'
      ? '图片已复制，可直接粘贴'
      : kind === 'share'
        ? '已通过系统分享发出'
        : '图片已复制，可直接 Ctrl+V 粘贴',
  /**
   * 🔴🔴 剪贴板档的提示要**按平台分**：老项目只有一句「可直接 Ctrl+V 粘贴」，
   *   但手机上根本没有 Ctrl+V 这个动作 —— 用户看到的是一句无法执行的指引
   *   （这正是用户报障第 13 条「移动端没法复制到微信」的一半原因）。
   *
   *   触屏判据与 dismissKeyboardForTouch 同一套（`(hover:none) and (pointer:coarse)`），
   *   不用 UA sniff —— UA 字符串在国产内核里常年不准。
   *
   *   🟡 严格说这是**老项目自带**的缺陷（老项目同一句），但用户是从移动端报的障，
   *   而"给一句做不到的指引"没有任何好处：触屏复用老项目原生桥那档的措辞
   *   （index.html:2943 的「图片已复制，可直接粘贴」）。
   */
  exportOkMsgTouch: (kind: string): string =>
    kind === 'native'
      ? '图片已复制，可直接粘贴'
      : kind === 'share'
        ? '已通过系统分享发出'
        : '图片已复制，长按下方图片可发给微信',
  /** 成功驻留毫秒（老项目剪贴板档 3000 / 原生桥与分享档 2400，这里取剪贴板档的 3000） */
  exportOkMs: 3000,
  /** 失败驻留毫秒（老项目三处失败分支全是 3000，此前新项目自己抬到 4500） */
  exportFailMs: 3000,
  /* ── PWA 安装引导（老项目 index.html:738-739/5959-5983 逐字）──────────── */
  installTitle: '安装到主屏幕',
  installDismissTitle: '不再提示',
  installGo: '安装',
  installLater: '以后再说',
  /** Chromium/Android 有 beforeinstallprompt 时的文案 */
  installMsgChromium: '像 App 一样打开：桌面直达、全屏输入、更新自动到位',
  /**
   * 🔴 iOS 如实说明（老项目 :5976）：`beforeinstallprompt` 在 iOS 永不触发，
   * 只能走 Safari 分享菜单。给一个点不动的「安装」按钮比不给更糟。
   */
  installMsgIOS: '在 Safari 底部分享菜单选「添加到主屏幕」，即可像 App 一样使用',

  /* 全屏预览兜底 */
  exportPreviewTitle: '图片已生成',
  exportPreviewAlt: '笔记图片',
  exportPreviewTip: '长按图片可保存或发送；点「下载」也可直接保存',
  /**
   * 🔴 触屏专属的第二行指引（用户报障第 13 条「移动端没法复制到微信」）。
   *
   *   机制：`navigator.clipboard.write(ClipboardItem)` 在 Android WebView /
   *   国产内核里常被拒，`navigator.share({files})` 又常常 `canShare` 为 false，
   *   于是绝大多数移动端最终落在**全屏预览**这一档。
   *   老项目那句「长按图片可保存或发送」是泛用表述，用户不知道要长按才能进微信，
   *   于是看到图就以为"导出失败了"。
   *
   *   只在触屏加这一行（桌面端这句是多余的：桌面有分享面板与 Ctrl+V）。
   */
  exportPreviewTipTouch: '在微信里：长按上面这张图 → 转发给朋友',
  exportDownload: '下载',
  exportDone: '完 成',
  /** 编辑器不在时点导出（顶栏还在但笔记已卸载） */
  exportNoEditor: '请先打开一篇笔记再导出',
  /** 非图片文件的拒绝文案 */
  uploadNotImage: '不是图片文件，图片未插入，请重试',

  /* ── 顶栏节日/深夜徽章（老项目 index.html:6521-6532 `NS_FEST_META` 逐字）──────────
     🔴🔴 本项目此前用的是**自创**的两句「节日快乐」「夜深了」，且 emoji 写死成 🎆。
       用户报障第 5 条：深夜时看到的应是老项目那枚 🌙 与「夜深了，写完这条就睡」。
       十个档位（元旦/除夕/春节/元宵/端午/七夕/中秋/重阳/腊八/深夜）一个都不能少。 */
  badge: {
    // 🔴🔴 `rain` 是**节日雨下什么字符**（老项目 index.html:6521-6531 `NS_FEST_META` 逐字）。
    //   缺了它，节日雨只能下硬编码雪花（❄✦❅•），而老项目下的是**该节日的 emoji**
    //   （过年下🎆🧧🏮、端午下🐉🍙…）—— 用户报障「彩蛋界面和老版本不一样」的一项。
    //   `night` 档必须是**空数组**：老项目深夜不雨（`nsRainStart` 的守卫是
    //   `f && NS_FEST_META[f].rain.length`，index.html:6648）。
    nj: { em: '🎆', tx: '新年好，记下今年的第一笔', rain: ['🎆'] },
    cx: { em: '🧨', tx: '除夕夜，岁末归档愉快', rain: ['🧨'] },
    cj: { em: '🧧', tx: '过年好！', rain: ['🎆', '🧧', '🏮'] },
    yx: { em: '🏮', tx: '元宵安康，别忘了吃汤圆', rain: ['🏮'] },
    dy: { em: '🐉', tx: '端午安康', rain: ['🐉', '🍙'] },
    qx: { em: '✨', tx: '今宵胜却人间无数', rain: ['✨', '🪶'] },
    zq: { em: '🌕', tx: '但愿人长久', rain: ['🌕'] },
    cy: { em: '🍂', tx: '重阳安康', rain: ['🍂'] },
    lb: { em: '🥣', tx: '先喝粥，再记笔记', rain: ['🥣'] },
    /** 深夜档。老项目 :6576 判定 `h >= 22 || h < 6`，深夜**优先于**节日。 */
    night: { em: '🌙', tx: '夜深了，写完这条就睡', rain: [] },
  } as const,

  /* ── 顶部「每日一句话」（老项目 index.html:8412-8420 `DAILY_LINES` 逐字，27 句）────
     🔴 本项目此前**没有**这条（顶栏只有自创的四时问候）。逐字抄，一个标点都不许改。 */
  dailyLines: [
    '来啦，今天整点啥？', '又打开我，谢了啊。', '早，先把脑子里的事倒出来。', '想到啥写啥，别憋着。',
    '走你，记一笔。', '我在呢，说吧。', '脑子空了？写下来就满了。', '今天也别硬记。',
    '边想边写，别求一次到位。', '记两笔，比记一天稳。', '你负责想，我负责记。', '先把待办掏空。',
    '来都来了，记一下。', '想到就做，做到就记。', '别怕字少，够用就行。', '一句话也是进度。',
    '脑子里那摊我帮你盯着。', '先记上，回头再说。', '你忙你的，笔给你递着。', '这会儿的事，趁热记。',
    '别跟我客气，随便写。', '记完就踏实了。', '灵感这东西，落纸才算数。', '今天想记住点啥？',
    '交给我，你接着忙。', '写下来，就忘不掉了。', '想到哪记到哪。', '有事儿就说，我记着呢。',
  ] as const,

  /** 每日一句话的 localStorage 键（老项目 index.html:8427 逐字。改名等于换用户） */
  greetDayKey: 'notesync_greet_day',
  greetNoteKey: 'notesync_greet_last_note',
  greetLineKey: 'notesync_greet_last_line',
  /** 每日一句话气泡驻留毫秒（老项目 :8449 是 4200） */
  greetMs: 4200,
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
