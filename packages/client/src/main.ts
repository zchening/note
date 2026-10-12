/**
 * 浏览器端入口 —— 页面状态机 + Lexical 编辑器 + 主题/皮肤
 *
 * 四个互斥页面（老项目就是这么做的，不引路由库）：
 *   landing 落地页 / pass 口令页 / home 首页提示页 / editor 编辑器
 *
 * 🔴🔴 四条硬纪律（违反任何一条都属于"看起来能跑、实际已漂移"）：
 *   1. **不引 React / 任何 UI 框架**。选 Lexical 的理由是"不重踩 contenteditable 的坑"，
 *      不是"顺手把 React 也带进来"。UI 外壳是顶栏 7 键 + 菜单 11 项 + 落地页，
 *      命令式 DOM 就够；引框架要多背 ~40KB gzip、要处理并发渲染与 Lexical 自己
 *      update 批次的时序冲突 —— 收益远小于代价。
 *   2. **APK 内绝不注册 SW**（见文件头 registerSW）。
 *   3. **行为注册必须在 setRootElement 之后**（见 behaviors.ts，漏了打不了字且零报错）。
 *   4. 折叠开合、皮肤档位、主题手动态**都是 ephemeral UI 态，不进真源**。
 *
 * 页面判定（老项目 URL 规则）：
 *   /                 → landing
 *   /<name> 且 name 是彩蛋保留字 → 彩蛋入口（S8 接）
 *   /<name> 且本机已记住口令 → editor
 *   /<name> 且没有口令     → pass
 *   /<name> 且口令错/数据坏 → pass（**同一句错误文案**，见 ARCH 安全不变量）
 */

import {
  $createRangeSelection,
  $getNodeByKey,
  $getSelection,
  $isRangeSelection,
  $setSelection,
  createEditor,
  FORMAT_TEXT_COMMAND,
  type EditorState,
  type LexicalEditor,
} from 'lexical';
import { $createParagraphNode, $createTextNode, $getRoot, $isElementNode, $isTextNode, type LexicalNode } from 'lexical';
// 🔴 官方链接可点扩展：让识别出来的链接**真的点得动**（探针实锤，见 registerClickableLink 处注释）
// 🔴 0.52 的 LexicalEditor **没有 editor.use()**（typecheck TS2339 直接报出来），
//   所以只能调底层 registerClickableLink(editor, signals)，用不了官方那个 Extension 包装。
import { registerClickableLink } from '@lexical/link';
import { namedSignals } from '@lexical/extension';

import { APP_VERSION, BUILD_DATE, SCHEMA_VERSION } from './version.ts';
import { registerBehaviors } from './behaviors.ts';
import { insertFoldAtCaret, placeCaret, registerCommands } from './commands.ts';
import { $isFoldNode, $isReminderMarkNode } from './nodes.ts';
import { ALL_NODES } from './node-registry.ts';
import { docToLexical, lexicalToDoc, nodesToSpans, replaceBlocksAt } from './serialize.ts';
import { canonicalize, decryptString, deriveKey, encryptString, emptyDoc, normalize, parseDoc, putKey, resolveKey, type DerivedKey, type Doc, type Envelope } from '@bj/shared-schema';
import { SyncClient, fetchTextWithTimeout, FETCH_TIMEOUT_GET_MS, type TimedResponse } from './sync/client.ts';
import { ComposeGuard, WithdrawGuard } from './sync/compose-guard.ts';
import {
  autoSnapshotThrottled,
  fetchHistoryDoc,
  fetchHistoryList,
  fmtHistTime,
  pushHistory,
} from './sync/history.ts';
import type { SyncState } from './sync/fsm.ts';
import {
  applyDraft,
  clearDraft,
  discardDraft,
  flushDraft,
  resetDraftSession,
  restoreDraftIfNeeded,
  readDraft,
  saveDraft,
  type DraftCtx,
} from './sync/draft.ts';
import { changePassphrase, fetchRemote, lockNote, unlock, unlockIfRemembered } from './sync/unlock.ts';
import { readCache, writeCache, envelopeOf } from './sync/local-cache.ts';
import { installKdfWorker } from './sync/kdf-worker.ts';
import { pushInternalError } from './diag/internal-ring.ts';
import { deriveWriteKey } from './sync/write-key.ts';
import { buildChangePass, buildHome, buildLanding, buildPass } from './ui/pages.ts';
import { buildShell, type Shell, type TopbarAction } from './ui/shell.ts';
import { COPY } from './ui/copy.ts';
import { buildMenu, type MenuState } from './ui/menu.ts';
import { applyThemeVars, resolveTheme, type SkinName, type ThemeName } from './ui/theme.ts';
import { sanitizeNoteName } from './ui/landing-logic.ts';
import { blockFingerprintsOf, chooseRewritePath, planLocalMarkRewrite } from './reminder/local-mark.ts';
import { reconcileReminders } from './reminder/reconcile.ts';
import { ensureExactAlarmPermission } from './reminder/native-rem.ts';
import { ReminderUI, lastNativeSyncOutcome } from './reminder/ui.ts';
import { handleImageUpload } from './image/upload.ts';
import { bindImageViewer } from './image/viewer.ts';
import { browserStore, favListOf, mergeFavs, readFavs, toggleFav, writeFavs, FAVS_MAX } from './fav/favs.ts';
import { buildEggLayer, scanEggTriggers, type EggLayer } from './egg/layer.ts';
import { initInstallPrompt, tryShowInstallBar } from './pwa/install-bar.ts';
import { dayGreet } from './egg/fx.ts';
import { mountPet, unmountPet } from './egg/pet.ts';
import { eggBrowserStore, eggCountText, isEggRoute, markDiscovered, readDiscovered } from './egg/registry.ts';
import { bindTypewriterSound } from './egg/typewriter.ts';
import {
  buildDiagPanel,
  hasDiagFlag,
  diagFlagStored,
  rememberDiagFlag,
  type DiagPanel,
} from './diag/panel.ts';
import { collectDiagLines, type DiagDeps } from './diag/collect.ts';
import { buildEggDraw } from './egg/draw.ts';
import { exportNotePng } from './export/index.ts';
import { copyNoteToClipboard, docToClipboardPayload } from './export/copy.ts';
import { buildPairPanel, closePairPanel } from './scan/panel.ts';
import { buildScanLayer } from './scan/layer.ts';
import { parsePairLink, PAIR_FRAGMENT_KEY } from './scan/pair-link.ts';
import {
  buildMigrateCode,
  fitsInMigrateCode,
  isMigrateCode,
  readMigrateEnvelope,
  resealMigrateDoc,
  restoreMigrateCode,
  MIGRATE_PAYLOAD_CAP,
} from './migrate/code.ts';
import {
  buildFavBackupCode,
  collectFavBackupIds,
  favBackupTip,
  favRestoreTip,
  isFavBackupCode,
  restoreFavBackupCode,
  FAV_BACKUP_MAX,
} from './migrate/fav-backup.ts';
import { buildMigratePanel, closeMigratePanel } from './migrate/panel.ts';
import {
  BAK_MAX,
  BAK_TEXT_PREFIX,
  buildBakDoc,
  buildBakLink,
  collectBakEntries,
  isBakNoteDoc,
  newBakId,
  parseBakLink,
  readBakManifest,
  readBakSlot,
  writeBakSlot,
  type BakMaterial,
} from './migrate/bak-note.ts';
import { collectBakMaterials, proveBakMaterials } from './migrate/bak-materials.ts';
import { readPassVault, savePassVault } from './sync/pass-vault.ts';
import { createImeGate, TYPE_ACTIVE_MS, type ImeGate } from './sync/ime-gate.ts';
import { recordFlight, flightLines } from './sync/flight-recorder.ts';
import { buildBakRestoreCard, closeBakRestoreCard } from './migrate/bak-restore-card.ts';
import { buildAboutOverlay } from './update/ota-ui.ts';
import { nativeDepsFromWindow } from './update/ota-native.ts';
import {
  dismissKeyboardForTouch as dismissKeyboard,
  isTouchDevice as isTouch,
  restoreEditorFocus,
} from './platform/touch.ts';
// 🔴 v1.13.0：原生判据统一出口。原来 4 处各读一遍 `window.__NOTESYNC_NATIVE__`，
//   而那个标志全仓从无赋值（6 处读、0 处写）⇒ 恒 undefined ⇒ 真机 APK 里也判不出来。
import { isNativeApp } from './platform/native-detect.ts';
// 🔴 v1.13.0：APK 冷启动自动进入上次笔记（五部件）。见 route/last-note.ts 文件头。
import { lastNoteToResume, markJumped, rememberLastNote } from './route/last-note.ts';
// 🔴 v1.12.0：值导入（不是type）——boot() 要用它做空闲预拉jsQR。
import { prefetchJsQrIdle } from './scan/engine.ts';
import type { ScanDiag } from './scan/engine.ts';

declare global {
  interface Window {
    // 🔴🔴 v1.13.0 删除了 `__NOTESYNC_NATIVE__?: boolean`。它是个**从无赋值的幽灵标志**：
    //   6 处读、0 处写，恒undefined ⇒ 任何 `=== true` 都恒假。
    //   而这条类型声明让它"看起来像个正常开关" —— 类型系统在这里帮了倒忙：
    //   它让 `window.__NOTESYNC_NATIVE__ === true` 编得过、读得顺，却永远不成立。
    //   原生判据改用 platform/native-detect.ts 的 isNativeApp()
    //   （window.Capacitor.isNativePlatform()，老项目 index.html:10125 口径）。
    //   判据见test/native-detect.test.mjs 的 NAT-3（禁止再读这个标志）。
    __NOTESYNC_BUILD__?: { version: string; date: string; sha: string };
    __NOTESYNC_EDITOR__?: LexicalEditor;
    /** 读取最近一次提交的真源快照（深拷贝）。正式接口，非调试后门。 */
    __NOTESYNC_DOC__?: () => Doc;
    /** v3.0.10 合成塌方守卫 e2e 驱动钩子（正式接口，仅驱动真实 update 监听）。 */
    __NOTESYNC_COMPOSE_TEST__?: {
      start: () => void;
      collapse: (short: string) => void;
      /** v3.0.11 回归钩子：模拟豆包智能整理「只 insertCompositionText、不发 compositionstart」。 */
      collapseNoStart: (short: string) => void;
      /** v3.1.5 回归钩子：真机 v3.1.4 第二跳形状——组字串 compLen 字远长于塌到的
       *  shortLen 字（帧间掉幅小 + prevLen<minPrev，旧实现在早退里放行）。 */
      collapseMismatch: (shortLen: number, compLen: number) => void;
      end: () => void;
      flightLines: () => string[];
      guardActive: () => boolean;
      /** v3.0.12 回归钩子：只 insertCompositionText(isComposing=true) 不发真实 compositionstart 时，返回 ed.isComposing() 是否被合成置位。 */
      probeSynthCompose: () => boolean;
      /** v3.0.14 回归钩子：模拟豆包语音组字增长帧（comp=1 全量替换到 n 字）。 */
      growTo: (n: number) => void;
      /** v3.0.14 回归钩子：模拟撤稿帧（comp=0 替换到 n 字，组字态转假）。 */
      withdrawTo: (n: number) => void;
      /** v3.0.15 回归钩子：读**编辑器树**的文本长度（区别于真源 latestDoc）。
       *  撤稿恢复的「树延迟同步」只能靠它钉住：模型落账是即时的，树有没有被
       *  重建 / 有没有被杀锚点，只有读树才知道。 */
      treeTextLen: () => number;
      /** v3.0.18 回归钩子：模拟**锚点死亡后的空转帧**——comp=1 组字帧持续到达
       *  （组字串 dLen 远长于文档）但写入全部空转（树长纹丝不动；真机 Android
       *  宿主专属形状：宿主撤稿杀锚点后组字 reconciliation 找不到锚点节点）。
       *  桌面用 selection 置位制造「有 flush 但树长不变」的等价形状，喂
       *  锚点死亡检测（连续 4 帧 ⇒ wd:dead + wd:reboot 自愈）。 */
      stallBi: (dLen: number) => void;
      /** v3.0.18 只读探针：ed.isComposing() 当前值（死会话是否被 reboot 强制结束）。 */
      probeComposing: () => boolean;
      /** v3.2.0：心跳阈值运行时改写（e2e 隔离机制用——其他判据关心跳钉自己的
       *  形状，WD-E2E-11 专门钉心跳）。生产路径从不调用。 */
      setHeartbeatAt: (n: number) => void;
    };
    /** 当前页面名（landing / pass / home / editor）。e2e 与 S5 同步都读它。 */
    __NOTESYNC_PAGE__?: () => string;
    /**
     * 采一份诊断读数并回**文本**（老项目 `window.collectDiagLines()` 同名同义）。
     * 正式接口，不是调试后门：光标类问题只能在真机上确认（老项目 :1927），
     * 而真机把 10 组读数交给用户的方式就是复制这段文本发出来。
     *
     * 🔴🔴 只回文本、**不回 DOM 句柄**：钩子挂在 window 上，回一个能改的节点
     *   等于开后门（改了节点，"读数是纯只读的"这条纪律就破了）。
     *   采集失败返回 `null`（明确表示"这次没采到"），不返回半份读数。
     */
    __NOTESYNC_DIAG__?: () => string | null;
    /**
     * 在光标处插入折叠块。**正式接口**，不是调试后门：
     * 折叠块是纯编辑器内结构，菜单/快捷键/未来的 MCP 都要走它，
     * e2e 也用它造场景（造场景走生产代码，才不会测一份只有测试才有的路径）。
     */
    __NOTESYNC_INSERT_FOLD__?: () => void;
    /**
     * 把 Lexical 选区落到指定位置。**正式接口**，不是调试后门。
     *
     * 🔴🔴 为什么必须有它（这条是被逼出来的）：
     *   e2e 若自己用 `document.createRange()` 设 DOM 选区，**不会同步到 Lexical 内部选区**
     *   ⇒ 之后的 `keyboard.press('Enter')` 根本不进编辑器 ⇒ 测试会把
     *   "实现有效"误判成"修复无效"。我在这上面白绕了很久。
     *   而"点击标题行"也**不是**解法：点标题就是切换开合（既有设计），
     *   一敲折叠块被打开，拦截器的判据②`!fold.open` 就不成立了。
     *   ⇒ 唯一可靠路径：**在页面内用 Lexical 自己的节点 API 落选区**，也就是这个钩子。
     *
     * 三个位置够覆盖全部折叠交互：标题末尾 / 正文开头 / 块外最后一段末尾。
     */
    __NOTESYNC_CARET_FOLD_TITLE_END__?: (offset?: number) => boolean;
    __NOTESYNC_CARET_FOLD_BODY_START__?: () => boolean;
    __NOTESYNC_CARET_AFTER_BLOCKS__?: () => boolean;
    /**
     * 真源的 canonical 字节。
     *
     * 🔴 为什么必须暴露它而不是让 e2e 自己 `JSON.stringify`：
     *   canonical 有四条规则（schema 键序、默认值省略、无空格 UTF-8、数组序即文档序），
     *   e2e 手写一份 JSON.stringify 等于**手写第二份实现**，
     *   判出来的"往返无损"是假的（键序不同就判红、键序巧合就对）。
     *   这与本项目"测试判据不许手写第二份实现"的纪律同源。
     */
    __NOTESYNC_CANON__?: (d: Doc) => string;
    /**
     * 用当前真源重建编辑器 —— 等价于"刷新后重新导入"。
     * e2e 用它验往返无损（import → export → import 逐字节相等）。
     */
    __NOTESYNC_RELOAD_FROM_DOC__?: () => void;
    /**
     * 读 Lexical **自己眼里的**选区（不是 DOM 选区）。
     *
     * 🔴 为什么需要这个钩子：折叠收起护栏（$parkCaretOnFoldHead）改的是
     *   **Lexical 选区**，而 e2e 从 `window.getSelection()` 读到的是 **DOM 选区**。
     *   两者在 reconcile 之后可能不一致 —— 只看 DOM 会分不清
     *   「护栏根本没执行」和「护栏执行了但被 Lexical 覆盖回去」。
     *   这个钩子把两边都读出来对比，才能定性到底是哪一层的问题。
     */
    __NOTESYNC_SEL__?: () => {
      lexKey: string | null;
      lexOffset: number | null;
      lexType: string | null;
      collapsed: boolean | null;
      nodeText: string | null;
    } | null;
    /**
     * 打开某个彩蛋门牌（正式接口）。
     * e2e 用它走真实路径进游戏 —— 造场景走生产代码，
     * 才不会测一份只有测试才有的路径。
     */
    __NOTESYNC_EGG_OPEN__?: (id: string) => boolean;
    /** 彩蛋图鉴是否开着（e2e 判图鉴渲染）。 */
    __NOTESYNC_EGG_CODEX__?: () => boolean;
    /** 主动打开图鉴（与 `?eggs` 同一条生产路径）。 */
    __NOTESYNC_EGG_CODEX_OPEN__?: () => void;
    /** 词表确认浮层是否开着（e2e 判「敲 /dragon 弹了没」）。 */
    __NOTESYNC_EGG_ASK__?: () => boolean;
    /** 当前浮层里展示的蛋 id（空串= 没展示）。 */
    __NOTESYNC_EGG_ASK_ID__?: () => string;
    /**
     * 最近一次扫码自检（引擎/帧数/错误摘要）。正式接口。
     * 🔴 只含元信息，**不含扫码内容** —— 码里带着口令。
     *
     * 🔴 类型用生产侧的 `ScanDiag`（scan/engine.ts）而不是就地写一份结构字面量：
     *   就地写窄了，诊断面板那行 `scan …` 就会在引擎加字段后**编译期失配**，
     *   而失配的表现是"面板少显示几个字段"——正是这类面板最容易被当成正常。
     */
    __NOTESYNC_SCAN_DIAG__?: () => ScanDiag | null;
    /**
     * 解析一个配对链接（生产解析器本体）。正式接口。
     *
     * 🔴🔴 为什么必须暴露它：判"出码能扫通"若在测试里手写一份 URL 解析，
     *   判出来的往返无损是**假的**（URL 的 origin 归一、fragment 边界、
     *   base64url padding 三处最容易分叉，而分叉只在真机上偶发）。
     *   这与 __NOTESYNC_CANON__ 同源：判据不许手写第二份实现。
     *
     * 🔴 只回显判定的**结构**（笔记名 + 口令长度），
     *   不回显口令本身 —— 免得这个钩子变成一个"把口令打印到控制台"的入口。
     */
    __NOTESYNC_PARSE_PAIR__?: (raw: string) => { ok: boolean; noteId?: string; passLen?: number; reason?: string };
    /**
     * 最近一次出码的**配对链接**。正式接口。
     *
     * 🔴 链接里带着口令，所以它和换机码一样**只由生产侧交出、供本机判据用**。
     *🔴🔴 为什么必须有它：配对码画在 canvas 上，DOM 读不到；
     *   没有这条口，e2e 判"配对链接往返无损"就只能手写一份 buildPairLink，
     *   而那会在生产侧改 origin 归一/fragment 边界时与产物分叉却照样全绿。
     */
    __NOTESYNC_PAIR_CODE__?: () => string;
    /**
     * 喂一条扫码结果，走**生产落地链路** handleScanRaw。正式接口。
     *
     * 🔴🔴 headless 没有摄像头，e2e 判"扫到备份笔记链接会不会进只读恢复卡"
     *   就只能靠它 —— 不给这条，判据只能去调内部函数，
     *   测出来的是另一条路，测到的东西不作数。
     *
     * 🔴 只**吃**文本、**不吐**任何东西（不回口令、不回明文、不回解密结果）。
     *   它不是读取口，是写入口 —— 与取景层 onResult 同款边界。
     */
    __NOTESYNC_SCAN_RAW__?: (raw: string) => void;
    /* ── 换机码（扫码换机）──────────────────────────────────────────────
       🔴🔴 四条钩子**一律不回显口令、也不回显笔记明文**。
         钩子挂在 window 上 = 任何页面脚本都能调；把口令或正文放进返回值，
         它就成了"任何人可读的口令/内容出口"，而那正是这个功能要保护的东西。
         e2e 要的安全断言（码里不含明文）靠"拿码去搜明文"做，不需要钩子吐明文。 */
    /** 生成换机码（生产实现本体）。回显成败，不回显码。 */
    __NOTESYNC_MIGRATE_MAKE__?: (passphrase: string) => Promise<{ ok: boolean; reason?: string }>;
    /** 取最近一次生成的码（只有密文，无口令无明文）。 */
    __NOTESYNC_MIGRATE_CODE__?: () => string;
    /** 走生产恢复链路。回显成没成。 */
    __NOTESYNC_MIGRATE_TAKE__?: (code: string, passphrase: string) => Promise<boolean>;
    /** 最近一次恢复的结果：**含"失败时真源是否被动过"**（反向闸的核心判据）。 */
    __NOTESYNC_MIGRATE_LAST__?: () => { ok: boolean; reason?: string; docChanged?: boolean } | null;
    /** 打开恢复面板（e2e 走真实用户路径）。 */
    __NOTESYNC_MIGRATE_OPEN_TAKE__?: (code?: string) => void;
    /** 定长容量（供 e2e 断言"超长被如实拒绝"）。 */
    __NOTESYNC_MIGRATE_CAP__?: () => number;
    /* ── 收藏备份码（nsfav1:）专用，与上面那组同款形态 ──
       🔴 之所以单独一组而不在上面那组上加参数：两种码的**恢复副作用完全不同** ——
         单篇码动正文（挂编辑器、推同步），收藏码只动收藏夹名单。
         混在一个函数里，e2e 就没法分别断言"恢复收藏码绝不该碰正文"。 */
    /** 本机收藏清单（已剔备份槽与非法名）。 */
    __NOTESYNC_FAVBAK_SOURCE__?: () => string[];
    /** 走生产备份链路出收藏清单码。 */
    __NOTESYNC_FAVBAK_MAKE__?: (passphrase: string) => Promise<{ ok: boolean; reason?: string }>;
    /** 出码提示整句（老项目 :9187 口径，带"一键恢复 N 篇"）。 */
    __NOTESYNC_FAVBAK_TIP__?: () => string;
    /** 走生产恢复链路喂清单码。 */
    __NOTESYNC_FAVBAK_TAKE__?: (code: string, passphrase: string) => Promise<boolean>;
    /** 上次收藏备份恢复的结果（篇数/覆盖/丢弃）。 */
    __NOTESYNC_FAVBAK_LAST__?: () =>
      | { ok: boolean; count?: number; renewed?: number; capped?: number }
      | null;
    /** 打开收藏备份恢复面板（e2e 走真实用户路径）。 */
    __NOTESYNC_FAVBAK_OPEN_TAKE__?: (code?: string) => void;
    /** 清单容量上限。 */
    __NOTESYNC_FAVBAK_CAP__?: () => number;
    /* ── 甲案（清单写进云端一篇备份笔记）────────────────────────────────
       🔴 同上：一律不回显清单内容与口令。清单与口令正是这功能要保护的东西。 */
    /** 当次甲案备份的备份笔记篇名（`nsbak-xxxxxx`）。空 = 还没出码。 */
    __NOTESYNC_BAK_ID__?: () => string;
    /** 走生产甲案链路出码。回显成败/篇名/篇数/未装进正文的篇数，**不回显清单**。 */
    __NOTESYNC_BAK_MAKE__?: (
      passphrase: string,
    ) => Promise<{ ok: boolean; reason?: string; bakId?: string; count?: number; skipped?: number }>;
    /** 本机备份槽（`{id, salt}` 或 null）。盐是公链上的东西，回显无害。 */
    __NOTESYNC_BAK_SLOT__?: () => { id: string; salt: string | null } | null;
    /** 甲案清单的篇数上限。 */
    __NOTESYNC_BAK_CAP__?: () => number;
    /**
     * Capacitor 全局（App 壳注入）。
     *
     * 🔴 必须声明成宽松形态而不是 `any`：桥对象由壳在运行时塞进来，
     *   编译期无从知道形状；这里只声明本项目**实际用到的那一个方法**，
     *   访问不存在的插件时返回 undefined（而不是崩）。
     */
    Capacitor?: {
      Plugins?: Record<
        string,
        { copyImage?: (o: { base64: string; mime: string }) => Promise<{ ok?: boolean }> }
      >;
    };
  }
}

/** Lexical 主题 class 名。CSS 在 ui/styles.css，节点侧在 nodes.ts，两边必须一致。 */
const THEME = {
  paragraph: 'ns-p',
  quote: 'ns-quote',
  heading: { h1: 'ns-h1', h2: 'ns-h2', h3: 'ns-h3' },
  list: {
    ul: 'ns-ul',
    ol: 'ns-ol',
    listitem: 'ns-li',
    nested: { listitem: 'ns-li-nested' },
  },
  link: 'ns-link',
  text: {
    bold: 'ns-b',
    italic: 'ns-i',
    underline: 'ns-u',
    strikethrough: 'ns-s',
    code: 'ns-c',
  },
} as const;

/* ---------------- 主题 / 皮肤 ---------------- */

/**
 * 🔴 手动主题态是**纯内存态，刻意不写 localStorage** —— 老项目就是这样：
 *   刷新或重新解锁一律回到时间规则（19:00–07:00 夜间）。
 *   写进 localStorage 会被当成"新功能"，首屏颜色就与老项目不一致了。
 */
let manualDark: boolean | null = null;
let currentTheme: ThemeName = 'light';
let currentSkin: SkinName = 'default';
/** 当前外壳引用。皮肤与主题都要经它重绘 —— 两处各写一份判定必然漂移。 */
let shellRef: Shell | undefined;

function repaint(): void {
  // 🔴 皮肤要整站换色，必须把 currentSkin 传进去（老项目 NS_SKIN_PALETTES 九档）：
  //   此前只传主题，皮肤只换了字形不换配色 —— 用户报障第 9 条。
  applyThemeVars(currentTheme, document.documentElement, currentSkin);
  // 🔴 菜单里的主题项是互斥双文案（夜间模式 / 日间模式）+ 月亮/太阳图标。
  //   不跟着重画就会出现"已经是白天了，菜单还写夜间模式" —— 典型的静默漂移。
  menuState.night = currentTheme === 'dark';
  menuRef?.render();
  shellRef?.setSkin(currentSkin, currentTheme === 'dark');
}

function applyTheme(): void {
  currentTheme = resolveTheme(manualDark, new Date());
  repaint();
}

/* ---------------- 路由 ---------------- */

/** 从 pathname 取笔记名（去掉首尾斜杠、URL 解码）。取不到返回空串。 */
function noteNameFromPath(): string {
  const parts = location.pathname.split('/').filter((p) => p !== '');
  const first = parts[0];
  // 🔴 noUncheckedIndexedAccess 下 parts[0] 是 string | undefined。
  //   这里显式收窄而不是 ! —— 断言会把"以后改了 filter 条件"变成静默 bug。
  if (first === undefined) return '';
  try {
    return decodeURIComponent(first);
  } catch {
    // 🔴 非法百分号编码（手敲 %zz 就会遇到）不能让整页崩，回退到原始片段
    return first;
  }
}

/* ---------------- 路由 ---------------- */

/**
 * 当前有没有遮罩态面板开着。
 *
 * 🔴 这是链接识别延迟守卫的一项（老项目 index.html:3632 的 `!remPanelOpen`）。
 *   判据抄老项目的语义：**面板开着时正文不可编辑**，那种场景没有打字，
 *   若也把链接识别推迟 1.5s，标记/链接会晚 1.6s 才出现（老项目 e2e V545-1 实锤）。
 *
 * 判据用「遮罩元素是否可见」而不是「有没有记录打开状态」：
 *   面板的显隐走 class（reminder/ui.ts:608 用 `mask.classList.contains('hidden')`），
 *   任何一处漏更新状态变量都会让这个守卫静默失效 —— 而症状是"打开面板时
 *   光标被链接重建弹走"，用户只会觉得"这软件的焦点有点莫名其妙"。
 *
 *覆盖三类遮罩（与老项目remPanelOpen 单一遮罩的差异）：
 *   提醒面板 / 二维码配对 / 扫一扫。它们都是"挡住正文、抢走焦点"，
 *   对链接识别的意义完全相同。
 *
 * 🔴🔴🔴 三个判据必须**逐一对着真实 DOM 结构核过**（2026-10-07 全都核过一遍，
 *   前两个此前是**恒不命中的死选择器**，守卫等于没有）：
 *
 *   ① 提醒面板：真实根元素是 `reminder/ui.ts:601 mask.className = 'mask hidden'`，
 *      **既没有 `.ns-rem-mask` 也没有任何 id** ⇒ 此前那句
 *      `querySelector('.ns-rem-mask:not(.hidden)')` 永远返回 null。
 *      修法不是把选择器改成 `.mask:not(.hidden)`（那会连落地页/关于页/扫一扫一起命中，
 *      过度覆盖），而是**给提醒遮罩补一个自己的 id**（`remMask`），
 *      判据按 id 查 —— 与 pairMask 的口径一致。
 *   ② 二维码配对：`getElementById('pairMask')` ✅ 正确（scan/panel.ts:170）。
 *      之所以用"元素存在与否"而不是可见性：面板关闭走 `mask.remove()`，元素直接消失。
 *   ③ 扫一扫：真实根元素是 `scan/layer.ts:66-67 overlay.className='mask';
 *      overlay.id='scanMask'`，**没有 `.ns-scan` 这个类** ⇒ 此前那句同样恒 null。
 *      且它关闭走 `removeChild`，同样用"存在即开"口径。
 */
function hasOverlayPanelOpen(): boolean {
  if (typeof document === 'undefined') return false;
  // 提醒面板（reminder/ui.ts:601 `mask.className = 'mask hidden'`，id 见 buildPanel）
  const remMask = document.getElementById('remMask');
  if (remMask && !remMask.classList.contains('hidden')) return true;
  // 二维码配对（scan/panel.ts:170 id=pairMask，关闭走 remove()）
  if (document.getElementById('pairMask')) return true;
  // 扫一扫图层（scan/layer.ts:67 id=scanMask，关闭走 removeChild）
  if (document.getElementById('scanMask')) return true;
  return false;
}

/* ---------------- 提醒：往正文插一行 ---------------- */

/**
 * 🔴 面板打开瞬间的正文选区（老项目 panelSavedSel）。
 *
 * 为什么必须存：面板里的输入框一获焦，编辑器就丢光标；等用户点「添加」时
 * 已经无从知道该往哪插。老项目也是这么做的 —— 打开面板时 `saveSelection()`，
 * 提交时 `restoreSelectionInBlock()` 再插。
 *
 * 用 Lexical 自己的 selection API（$getSelection/$setSelection）而不是 DOM Range：
 * DOM Range 在 reconcile 后就失效了，存下来再 set 会抛 "Unable to find an active
 * editor state"。存 Range 的**序列化形态**（anchor/focus 节点 key + offset）才活得下来。
 */
let panelSavedSel: {
  anchorKey: string;
  anchorType: 'text' | 'element';
  anchorOffset: number;
  focusKey: string;
  focusType: 'text' | 'element';
  focusOffset: number;
} | null = null;

function saveEditorSelection(): void {
  const ed = editor;
  if (!ed) return;
  ed.getEditorState().read(() => {
    // 🔴 收窄成 RangeSelection：$getSelection() 的返回类型是 BaseSelection，
    //   它没有 anchor/focus（只有 isCollapsed/getTextContent 等），
    //   不收窄就 TS2339。NodeSelection / GridSelection 的锚点语义完全不同，
    //   硬取 anchor 会拿到 undefined，插行时静默插到文档开头。
    const sel = $getSelection();
    if (!sel || !$isRangeSelection(sel)) {
      panelSavedSel = null;
      return;
    }
    panelSavedSel = {
      anchorKey: String(sel.anchor.key),
      // 🔴🔴 **点的类型必须存**：空段落里的光标是 element 锚点（段落里没有
      //   TextNode），恢复时若强设成 'text'，sel.insertText 会**静默空转** ——
      //   症状是 Bug2：「面板点添加 → 面板收起 → 正文和提醒两边什么都没有」
      //   （插行没进正文，提醒被对账按"正文找不到时间串"判死）。
      anchorType: sel.anchor.type,
      anchorOffset: sel.anchor.offset,
      focusKey: String(sel.focus.key),
      focusType: sel.focus.type,
      focusOffset: sel.focus.offset,
    };
  });
}

/**
 * 在正文里插入一行提醒文字，并把光标落到它**后面那个空行**的行首
 * （老项目 v7.3.2：连续添加多个提醒时文字不会连在一起）。
 *
 * 🔴 用 `$insertText` 而不是自己拼 TextNode 再 append：
 *   前者走 Lexical 自己的选区更新与撤销栈合并（Ctrl+Z 能一步撤掉整行），
 *   后者要自己处理选区，容易出现"文字插进去了但光标还在原地"。
 */
function insertRemLineToEditor(text: string): void {
  const ed = editor;
  if (!ed) return;
  ed.update(
    () => {
      // 1) 恢复面板打开时的选区。
      //    🔴 用 $getNodeByKey 而不是 ed.getEditorState()._nodeMap：
      //      后者是私有字段，bundled ESM 下改名/压缩即失效，且失败时报
      //      "undefined is not a function" 这种完全指不到错的错。
      //    🔴🔴 点类型以**节点实际形态**为准，不照抄保存值：保存后文档可能被
      //      对账/远端合并重建，节点会换 key 或换形态（text ↔ element）。
      //      空段落锚点是 element —— 强设 'text' 会让 insertText 静默空转（Bug2 病根）；
      //      偏移也要按形态钳制（文本按内容长度、元素按子节点数），防越界。
      if (panelSavedSel) {
        const anchor = $getNodeByKey(panelSavedSel.anchorKey);
        const focus = $getNodeByKey(panelSavedSel.focusKey);
        if (anchor && focus) {
          const aIsText = $isTextNode(anchor);
          const fIsText = $isTextNode(focus);
          const aOff = aIsText
            ? Math.min(panelSavedSel.anchorOffset, anchor.getTextContentSize())
            : Math.min(panelSavedSel.anchorOffset, $isElementNode(anchor) ? anchor.getChildrenSize() : 0);
          const fOff = fIsText
            ? Math.min(panelSavedSel.focusOffset, focus.getTextContentSize())
            : Math.min(panelSavedSel.focusOffset, $isElementNode(focus) ? focus.getChildrenSize() : 0);
          const sel = $createRangeSelection();
          sel.anchor.set(anchor.getKey(), aOff, aIsText ? 'text' : 'element');
          sel.focus.set(focus.getKey(), fOff, fIsText ? 'text' : 'element');
          $setSelection(sel);
        }
      }
      // 2) 插提醒行文字
      //    🔴🔴 用 **RangeSelection.insertText() 实例方法**，不用 $insertText：
      //      实测 0.52 里 $insertText 定义在 lexical/dist/Lexical.dev.js 内，
      //      但**没有从 lexical 的 .d.ts 导出**（typecheck 报 TS2305）；
      //      而 @lexical/selection 只导出 $moveCharacter 之类，也没有它。
      //      实例方法是**公开且有类型**的入口，语义相同（走 Lexical 自己的选区更新
      //      与撤销栈合并，Ctrl+Z 能一步撤掉整行）。
      const sel = $getSelection();
      if (!sel || !$isRangeSelection(sel)) {
        // 🔴🔴 无选区时**追加到文末**，不能直接 return。
        //   探针实测：全新笔记（文档只有一个空段落）从未聚焦过时 $getSelection() 返回 null，
        //   我第一版直接 return —— 于是「面板加的第一条提醒根本没进正文」，
        //   紧接着对账按「正文里找不到时间串」判死，净结果是加了个寂寞。
        //   老项目 insertNodeAtCaret 也是这个语义：无光标就落到末尾。
        const root = $getRoot();
        root.append($createParagraphNode().append($createTextNode(text)));
        root.append($createParagraphNode());
        return;
      }
      sel.insertText(text);
      // 3) 换行 + 再补一个空行（老项目 v7.3.2：连续添加不连行）
      //    🔴 用 insertNodes 而不是自己 append —— 后者不更新选区，
      //      症状是「文字插进去了但光标还在原地」，连续加第二条会插到第一行中间。
      sel.insertNodes([$createParagraphNode()]);
      sel.insertNodes([$createParagraphNode()]);
    },
    { discrete: true },
  );
  panelSavedSel = null;
}

/* ---------------- 应用装配 ---------------- */

const appEl = document.getElementById('app');
if (!appEl) throw new Error('#app 不存在：index.html 与本文件不同源');
// 🔴 显式标注成HTMLElement：模块顶层的 throw 窄化传不进下面这些函数体，
//   于是每个 build*(app) 调用点都报一遍"可能是 null" —— 一次收口，别处干净。
const app: HTMLElement = appEl;

let editor: LexicalEditor | undefined;
/**
 * 「立刻跑一轮链接识别」句柄。模块级的原因与上面 `editor` 相同：
 * 远端合并（setDoc）、历史版本恢复、迁移恢复这三条路径都在 mountEditor 之外，
 * 它们换完真源后都需要重新识别链接。
 *
 * 🔴🔴 漏掉任何一条的用户症状都极难自查：
 *   打开旧笔记是裸网址（首屏已修）、打字敲的网址会亮（延迟链路已修），
 *   但「另一台设备同步过来的网址」永远不亮 —— 用户会怀疑是同步坏了。
 *   老项目对应用法是 `applyRemoteBody` / `remoteTake` / `undo` 之后都调一次
 *   `linkifyEditor`（index.html:3977-3979 在 finally 里统一收口）。
 *   本项目用这一个函数把那些散点收成同一处。
 */
let linkifyNowRef: (() => void) | undefined;

// 🔴🔴 IME 门控的模块级出口（用户报障第 7 条）。
//   两个变量各管一件事，别合并：
//     imeGateRef   = 门控本体⇒ 三条回灌路径判 canEditTree()（v3.0.8 起比
//                    canApply() 更严：还要躲"整段改写会话窗口"）
//     detachImeRef = 解绑函数 ⇒ 下次 mountEditor 时撤掉上一篇的监听
//   🔴🔴 都**必须**有 `undefined` 初值而不是就地 new 一个：
//   mountEditor 之外（落地页/口令页/备份恢复卡）没有编辑器，
//   那时读它必须是 undefined 而不是一个"永不组字、恒放行"的假门控 ——
//   后者会让回灌守卫在无编辑器时形同虚设，看着有闸实际没闸。
// 🔴 本次挂载的真源快照（B-① 的initialDoc 来源）。
//   🔴🔴 为什么必须是模块级而不是 startSyncFor 的参数：
//   startSyncFor 是**独立函数**，而真源 `initial` 是 mountEditor 的局部变量。
//   两者之间隔着一次路由跳转（route() → showPass/memory unlock → startSyncFor），
//   把它做成参数要改一串调用点，而那些调用点里**有的路径根本没有这个值**
//   （比如扫码落地那条）。模块级快照是"最近一次挂载的真源"，语义正好对上
//   "解锁时解出来的那一版"。
let mountDocSnapshot: Doc | undefined;
let imeGateRef: ImeGate | undefined;
let detachImeRef: (() => void) | undefined;
/**
 * 补铺调度器的模块级引用。
 *
 * 🔴 为什么要有它：`scheduleStrayMarkFlush` 活在 `mountEditor` 闭包里（它要读本次
 *   挂载的 `latestDoc` 与 `imeGate`），但 `startSyncFor` 的 `setDoc` 在**模块级**，
 *   够不到那个闭包。换笔记重建编辑器时，新挂载会把它重新指向新闭包
 *   （旧闭包随旧挂载一起废弃）。
 * 🔴 第二参是"待回灌真源的存活提醒 id 集合"，只有 `setDoc` 那条路径会传
 *   （见 `strayPendingLive` 的注释）。
 */
let strayFlushRef: ((delay: number, pendingLive?: ReadonlySet<string>) => void) | undefined;
/** 外壳根节点。同步状态回调要往它身上写 dataset，作用域必须在 mountEditor 之外。 */
let root: HTMLElement | undefined;
let setFootStatus: ((s: 'connecting' | 'synced' | 'offline', d?: string) => void) | undefined;

/**
 * 🔴🔴 一次性底栏提示的**占有窗口**。
 *
 *   问题：底栏那一行同时是"同步状态"和"临时提示"两个用途（老项目亦如此）。
 *   提示只在设置那一刻存在，下一个到达的 `onSnapshot` 会把它无声覆盖 ——
 *   实测 FAV-E06「收藏封顶」提示就是这么闪一下就没的（偶发红，竞态）。
 *   老项目没有这个洞是因为它压根不提示（writeFavs 静默截断）；
 *   bj 选了"如实告知"这条更好的路，就得自己把提示护住。
 *
 *   做法：提示期间记一个到期时间戳，`onSnapshot` 见到还没到期就**跳过写入**。
 *   到期后恢复真实状态（不是硬写"已同步"——那时可能真处于离线）。
 */
let footHoldUntil = 0;
let footHoldText = '';

/** 显示一条会自己消失的底栏提示；`ms` 内不被同步快照覆盖。 */
function footFlash(text: string, ms: number): void {
  footHoldText = text;
  footHoldUntil = Date.now() + ms;
  setFootStatus?.('synced', text);
  window.setTimeout(() => {
    // 期间又来了条更新的提示 ⇒ 交给它收，别把新的收掉
    if (footHoldText !== text) return;
    footHoldUntil = 0;
    footHoldText = '';
    const f = footFor(lastSyncState);
    setFootStatus?.(f.s, f.d);
  }, ms);
}

/** 同步状态回写口：持有一次性提示期间让路。 */
function footStatus(s: 'connecting' | 'synced' | 'offline', d?: string): void {
  if (footHoldUntil > Date.now()) return;
  setFootStatus?.(s, d);
}

/** 最近一次快照的原始状态，供提示到期后恢复真实状态用。 */
let lastSyncState: SyncState = 'idle';

/**
 * 🔴🔴 刷新按钮前的两道刹车（老项目 index.html:5760 `if (busy || inflightWrites > 0)`）。
 *
 *   老项目那两道**都只包住 PUT（写）**，不包 GET（读）：
 *     · `busy`（保存互斥）在 saveLocal / persistReminders 里置位（:7127 起），
 *       整段期间就是一次 PUT；
 *     · `inflightWrites`（在途写计数）在 `apiPut` / `apiPutTo` 的 try/finally 里
 *       ±1（:2270/:2294），**只有 PUT 会动它**。
 *   ⇒ 老项目的守卫语义精确地是「**有写正在飞**」。首次拉取（apiGet）既不动 busy
 *     也不动 inflightWrites，故老项目在首拉期间按刷新**照样抽卡 + reload**。
 *
 *   bj 没有这两个全局量，等价物是同步状态机（sync/fsm.ts）的态。**只有 `pushing`
 *   对应"有 PUT 在飞"**：
 *     · `pushing`  —— 正在 PUT。✅ 刹车（等价 busy + inflightWrites 的并集）
 *     · `syncing`  —— 正在拉取/合并。❌ 纯读，reload 只是重来一遍（老项目不拦）
 *     · `dirty`    —— 本地有未推送改动（去抖窗口内）。❌ 老项目此刻 busy=false、
 *                     inflightWrites=0 也不拦；且 bj 的 pendingEnv 由 unload 抢写落本地
 *     · `offline`  —— 无在途写入。❌
 *
 *   🔴🔴 教训（2026-10-09 实测）：最初把 `syncing` / `dirty` 一起算进来是**错的** ——
 *     openEditor 完成后状态恰是 `syncing`（首拉），于是"点刷新"被永久拦下、永不 reload，
 *     而首拉是纯读、打断它零风险。回归闸 EGGDRAW-01 正是钉这条路径的（点刷新必须出卡）。
 */
function saveInFlight(): boolean {
  return lastSyncState === 'pushing';
}


/* ---- 上传状态条（老项目 showUploadStatus 同款） ---- */

/** 上传提示条的自动收起计时器。🔴 换文案前必须清掉旧的，否则会出现"新文案被旧计时器提前收走"。 */
let uploadNoteTimer: number | undefined;

/**
 * 显示上传状态。
 *
 * 🔴 为什么不用底栏 setStatus：底栏那一行是**同步状态**的位置
 *   （connecting / synced / offline），拿它显示"正在压缩图片"会让用户
 *   以为同步坏了。老项目是独立浮层，这里照搬。
 *
 * @param kind 'doing' 过程 / 'ok' 成功 / 'bad' 失败
 * @param autoHideMs 自动收起毫秒；0 = 常驻（过程态就靠调用方重发覆盖）
 */
function showUploadNote(kind: 'doing' | 'ok' | 'bad', text: string, autoHideMs: number): void {
  let el = document.getElementById('uploadNote');
  if (!el) {
    el = document.createElement('div');
    el.id = 'uploadNote';
    el.setAttribute('role', 'status');
    el.setAttribute('aria-live', 'polite');
    document.body.appendChild(el);
  }
  // 🔴 走 textContent，不走 innerHTML：文案里含用户文件名/云端返回的原因，
  //   一旦有尖括号就是注入面（S4 已立的 XSS 收口口径）。
  el.textContent = text;
  el.dataset.kind = kind;
  if (uploadNoteTimer !== undefined) {
    clearTimeout(uploadNoteTimer);
    uploadNoteTimer = undefined;
  }
  if (autoHideMs > 0) {
    uploadNoteTimer = window.setTimeout(() => {
      el?.remove();
      uploadNoteTimer = undefined;
    }, autoHideMs);
  }
}

function hideUploadNote(): void {
  if (uploadNoteTimer !== undefined) {
    clearTimeout(uploadNoteTimer);
    uploadNoteTimer = undefined;
  }
  document.getElementById('uploadNote')?.remove();
}

/**
 * 🔴🔴 **全站唯一的图片上传入口** —— 选图、拖拽、粘贴三条路都走它。
 *
 * 之前这段 deps 是内联在 `ensureUploadInput` 的 change 里的，
 * 于是 behaviors 想接拖拽/粘贴就得**再抄一份**同样的 deps：
 * 改一次提示文案要动两处，漏一处就出现"点上传有提示、拖进来没提示"——
 * 用户看到的是"拖拽功能坏了"，而代码零报错。抽出来即从结构上消除这个可能。
 */
function uploadImageFromFile(f: File): void {
  const ed = editor;
  if (!ed) return;
  void handleImageUpload(f, ed, {
    noteId: currentNote,
    base: location.origin,
    onStatus: (m) => showUploadNote('doing', m, 0),
    onOk: () => showUploadNote('ok', COPY.uploadOk, COPY.uploadOkMs),
    onError: (m) => showUploadNote('bad', m, COPY.uploadFailMs),
  }).then((ok) => {
    // 🔴 成功才收键盘：失败时图片没插进去，编辑器还该留着继续用。
    //   判据用 handleImageUpload 的**返回值**，不是"看提示条是什么态"——
    //   后者在两个提示同屏、或提示条已被收起计时器删掉时就不成立了。
    if (ok) dismissKeyboardForTouch();
  });
}

/**
 * 隐藏的 file input —— 「点顶栏按钮选图」的入口。
 *
 * 🔴 为什么藏在 DOM 里而不是 `input.click()` 临时造一个：
 *   iOS Safari 对**用户手势链外**的 input.click() 会直接忽略，
 *   症状是"点上传没反应且零报错"。挂在 DOM 里有两个好处：
 *   ① 手势链完整（点在按钮上 → 按钮 handler 内 click 它，仍在手势内）；
 *   ② accept 属性让系统直接给"照片"选择器而不是文件管理器。
 */
let uploadInput: HTMLInputElement | undefined;

/**
 * 建立（并记住）隐藏的 file input。
 *
 * 🔴🔴 必须是**启动即建**，不能等点上传按钮才建。
 *   我第一版挂在 pickImage() 里懒创建，e2e 一跑就报「未找到 nsUploadInput」——
 *   而这不只是测试问题：**懒创建意味着「第一次点击必须成功」**，
 *   一旦那次 appendChild 失败（或被扩展/内核拦了一次），按钮就永久是死的，
 *   且症状是"点了没反应零报错"。
 *   提前建好 = 第一次点击与第 n 次点击走完全同一条路径。
 */
function ensureUploadInput(): HTMLInputElement {
  if (uploadInput) return uploadInput;
  const el = document.createElement('input');
  el.type = 'file';
  el.accept = 'image/*';
  el.id = 'nsUploadInput';
  // 必须藏起来但**不能 display:none** —— display:none 的 input 在部分
  // 内核里不可点击（等于死按钮）。用视觉隐藏，保留可交互性。
  el.style.cssText = 'position:fixed;left:-9999px;top:0;width:1px;height:1px;opacity:0;';
  el.addEventListener('change', () => {
    const f = el.files?.[0];
    // 🔴 必须清空 value：同一个文件连选两次，第二次不触发 change
    //   （value 没变），用户会以为"点了没反应"。
    el.value = '';
    if (f) uploadImageFromFile(f);
  });
  document.body.appendChild(el);
  uploadInput = el;
  return el;
}

function pickImage(): void {
  // 🔴 开选前先收掉上一条提示：上一条失败提示还挂着（4.5 秒驻留）时
  //   又发起新上传，两条提示会在同一位置叠着、互相盖住失败原因。
  hideUploadNote();
  // 🔴🔴 老项目 index.html:2825：
  //   `uploadBtn.addEventListener('click', () => { if (CHIP_HOVER_OK) { pickUploadFile(false); return; } nsUpMenuOpen(); });`
  //   ⇒ **有精确指针就直接开文件框，纯触屏才弹「插入图片方式」二选一**。
  //   判据用 restoreEditorFocus 那套（any-pointer: fine / hover: hover）而不是 isTouchDevice，
  //   理由同 touch.ts 的纪律：平板 + 触控笔 / 插了鼠标的触屏本 / 桌面触屏一体机
  //   都不是"纯触屏"，它们要的是直开文件框（老项目管这叫 CHIP_HOVER_OK）。
  //   判错的后果是双向的：用 isTouchDevice 会让带触控笔的 iPad 每次都多点一次；
  //   反过来一律弹模态则桌面用户也得多点一次。
  if (hasPrecisePointer()) {
    pickUploadFile(false);
    return;
  }
  openUploadWayModal();
}

/** 是否存在精确指针（鼠标/触控笔/桌面触屏一体机）。与 touch.ts restoreEditorFocus 同口径。 */
function hasPrecisePointer(): boolean {
  try {
    const mq = window.matchMedia;
    if (!mq) return true; // 判不准时按桌面处理（老项目同款保守取向）
    return !!mq('(any-pointer: fine)').matches || !!mq('(hover: hover)').matches;
  } catch {
    return true;
  }
}

/** 开文件框。`cam` 为真时带 `capture=environment` 直接调相机（老项目 :2799 同款）。 */
function pickUploadFile(cam: boolean): void {
  const el = ensureUploadInput();
  if (cam) el.setAttribute('capture', 'environment');
  else el.removeAttribute('capture');
  try {
    el.click();
  } catch {
    /* 老项目同款：click 抛了就不管（真机上是用户手势被系统拒绝，不是代码错） */
  }
}

function closeUploadWayModal(): void {
  document.getElementById('nsUpModal')?.remove();
}

/**
 * 「插入图片方式」二选一（拍照 / 从相册）—— 老项目 index.html:2807 `nsUpMenuOpen`。
 *
 * 🔴 文案与样式**逐字照抄**老项目，因为它们是用户已看过一眼的东西：
 *   h1「插入图片」/副标题「选一种方式，图片会自动压缩上传」/「拍 照」/「从相册选择」。
 *   「拍 照」中间那个空格是老项目 :2813 的原文（`bCam.textContent = '拍 照'`），
 *   与弹窗里其它按钮「关 闭」「完 成」同款 —— 那是给空格留呼吸的老项目排版手法。
 *
 * 🔴 「从相册选择」挂 `ghost-btn`（老项目 :2814），但**不要**按 `.ghost-btn` 的声明去写视觉：
 *   那个类的 background/color/font-weight 被 `.box button:not(:disabled):not(.box-x)`
 *   （0,3,1，**带 !important**）吃回，只剩 `margin-top:10px` 与 `border` 活下来
 *   —— 见 styles.css:421 的量化记录与 replication-discipline §2。
 *
 * 🔴 开模态前先收键盘（老项目 :2807 `dismissKeyboardForTouch()`）：
 *   不收的话软键盘会压在「拍 照 / 从相册选择」底下 —— 用户报障第 7 条的现场之一。
 */
function openUploadWayModal(): void {
  closeUploadWayModal();
  dismissKeyboardForTouch();

  const mask = document.createElement('div');
  mask.className = 'mask';
  mask.id = 'nsUpModal';
  const box = document.createElement('div');
  box.className = 'box';
  box.style.textAlign = 'center';
  const h = document.createElement('h1');
  h.textContent = COPY.insertImageTitle;
  const sub = document.createElement('p');
  sub.textContent = COPY.insertImageSub;
  // 🔴 内联样式而非 class（老项目 :2811 就是内联）：
  //   font-size:12.5px;line-height:1.7;color:var(--muted);margin:10px 4px 18px
  sub.style.cssText = 'font-size:12.5px;line-height:1.7;color:var(--muted);margin:10px 4px 18px';
  const bCam = document.createElement('button');
  bCam.type = 'button';
  bCam.id = 'nsUpCam';
  bCam.textContent = COPY.insertImageShoot;
  const bAlb = document.createElement('button');
  bAlb.type = 'button';
  bAlb.id = 'nsUpAlbum';
  bAlb.className = 'ghost-btn';
  bAlb.textContent = COPY.insertImageAlbum;

  box.append(h, sub, bCam, bAlb);
  mask.append(box);
  document.body.append(mask);

  bCam.addEventListener('click', () => {
    closeUploadWayModal();
    pickUploadFile(true);
  });
  bAlb.addEventListener('click', () => {
    closeUploadWayModal();
    pickUploadFile(false);
  });
  // 🔴 点遮罩空白取消（老项目 :2818）。
  //   触屏下这条必须有，否则"想取消却关不掉"= 只能刷新页面。
  mask.addEventListener('click', (e) => {
    if (e.target === mask) closeUploadWayModal();
  });
}

/**
 * 是不是触屏设备（决定手机号点下去拨不拨号）。
 *
 * 🔴🔴 三条判据（收键盘 / 触屏判定 / 关闭后还焦点）此前是三份**各写一遍**的
 *   matchMedia 字面量，其中 `dismissKeyboardForTouch` 还与 `isTouchDevice` 写得不一致
 *   （前者 `window.matchMedia(...)` 直接调、后者 `?.`）——
 *   两套判定一定会漂移，而漂移的表现是"PC 上能拨号 / 手机上拨不了号"，
 *   两边都是用户一眼看穿的错。
 *   ⇒ 现在全部收敛到 `platform/touch.ts`，这里只保留转发别名给本文件的既有调用点。
 *   （老项目 v9.5.1 `dismissKeyboardForTouch` 原文：blur 是移动端唯一可靠收键盘的手段，
 *    但桌面端绝不能 blur —— 用户打字时误触上传，编辑器一失焦光标就丢了。）
 */
function isTouchDevice(): boolean {
  return isTouch();
}

/** 触屏下收起软键盘（转发到 platform/touch.ts）。 */
function dismissKeyboardForTouch(): void {
  dismissKeyboard();
}

/**
 * 🔴🔴🔴 关闭浮层后**把焦点还给编辑器** —— 只在桌面级设备上做。
 *
 * 老项目 `CHIP_HOVER_OK`（index.html:6490）的定义：
 *   `!!(window.matchMedia && matchMedia('(hover: hover) and (pointer: fine)').matches)`
 *
 * 它出现在**每一个**收尾 focus 上，一处不漏：
 *   :3377/:7628 二维码弹窗关闭   :6929/:9111 彩蛋层关闭
 *   :8000 菜单遮罩点空白关闭     :8216 关于遮罩点空白关闭
 *   :8244 关于页 × 关闭          :8249 菜单切主题
 *   :8287 修改口令**取消**关闭   :4409 折叠三角开合收尾
 *
 * 🔴🔴🔴 **漏掉这个守卫就是用户报障第 8 / 10 / 11 条**：
 *   手机上 `focus()` 就是弹软键盘。于是用户点一下关闭弹窗，键盘"啪"地弹出来 ——
 *   而他刚才做的明明是"关掉一个浮层"，没打算打字。
 *   bj 此前的对应位置全是裸 `editor?.focus()` / `host.focus()`。
 *
 * 🔴 实现本体在 `platform/touch.ts`（behaviors.ts 折叠开合也要用，
 *   而 main.ts import behaviors.ts ⇒ 反向 import 就是循环依赖）。
 *   这里只做本地转发，语义注释留在那一处，避免两处各写一份口径。
 */
function restoreEditorFocusOnClose(el?: HTMLElement | null): void {
  // 🔴 `editor` 是 **LexicalEditor**，不是 DOM 元素 —— 把它塞进 HTMLElement 的
  //   `??` 链里，运行时恰好也能工作（LexicalEditor 自己有 focus()，内部转给根元素），
  //   但类型是错的，而且"恰好能工作"掩盖了真相：真出问题时定位不到。
  //   正确口径是取它的**根元素**，再兜底按 id 找（根元素可能已卸载）。
  restoreEditorFocus(() => {
    if (el) return el;
    const root = editor?.getRootElement?.();
    return root ?? document.getElementById('editor-host');
  });
}

/**
 * 原生桥：复制图片到系统剪贴板。
 *
 * 🔴 为什么需要它（老项目 v7.7.0 血泪）：Android WebView 对
 *   `navigator.clipboard.write` 写图片**长期不可用**，而导出长图的主要场景
 *   就是手机。这条桥是那条路上唯一确定性的出口。
 *
 * 🔴 桥不存在时返回 false 而不是抛错：调用方会继续往下走分享/预览阶梯，
 *   抛错会把整条回退链断掉（症状是"有原生桥的机器上分享面板也不弹了"）。
 */
async function nativeCopyImage(base64: string, mime: string): Promise<boolean> {
  try {
    const br = window.Capacitor?.Plugins?.ImgClip;
    if (!br || typeof br.copyImage !== 'function') return false;
    const res = await br.copyImage({ base64, mime });
    return res?.ok === true;
  } catch {
    return false;
  }
}

let currentPage = 'boot';
let currentNote = '';

/**
 * 本次会话用过的口令（**只在内存里**，不落盘、不进 localStorage）。
 *
 * 🔴🔴 为什么需要它：新项目的 CryptoKey 是 extractable:false，**物理上导不出**，
 *   所以出配对码时拿不到"另一台设备需要的那件东西"。那件东西就是口令本身
 *   （见 scan/pair-link.ts 的架构分叉说明）。
 *
 * 🔴🔴 为什么放内存而不是 localStorage：
 *   老项目把 raw key 写进 localStorage，XSS 一次就能拿走并离线解开全部历史密文，
 *   改口令也救不回来（历史密文已被解开）。新项目不能为了"出码方便"再开后门。
 *   内存副本的暴露窗口 = 本次页面会话，且不跨刷新；XSS 当场能读，
 *   但要长期窃取必须每次会话都注入 —— 与"密钥永不可导出"的口径一致。
 *
 * 🔴 锁定时必须清（见 menuLock 分支）。不清的话"退出锁定"就是假的，
 *   用户以为清干净了，实际上点配对码还是能出。
 */
let sessionPass = '';

/** 供配对码用；锁定后为 ''。 */
function passForPair(): string | null {
  return sessionPass === '' ? null : sessionPass;
}

/** 收藏态与链接打开方式是**本机偏好**（老项目：仅对本机生效），存 localStorage。 */
/**
 * 程序化重建（`docToLexical` / `replaceBlocksAt`）的 update 标记。
 *
 * 🔴🔴 为什么必须有这个 tag：Lexical 的 update listener 对**每一个 commit 都会触发**
 *   （含纯选区变化这种 no-op），而下面四条路径都是**程序化**写回 ——
 *   初始装载、远端回灌、提醒到点整篇重建。老项目这些路径压根没有 input 事件，
 *   所以绝不能让它们放彩蛋动效；少了这个 tag，症状就是
 *   "打开一篇本来就有 1314 的笔记，一进去就炸一次"。
 */
const EGG_NOFX_TAG = 'notesync-nofx';

const prefKey = (k: string): string => `notesync_bj_pref_${k}`;
function readPref(k: string, dflt: string): string {
  try {
    return localStorage.getItem(prefKey(k)) ?? dflt;
  } catch {
    return dflt;
  }
}
function writePref(k: string, v: string): void {
  try {
    localStorage.setItem(prefKey(k), v);
  } catch {
    /* 存不下就本次会话内有效 */
  }
}

const menuState: MenuState = {
  // 🔴 进编辑器时就要算好"这篇是否已收藏"：菜单是打开时才渲染的，
  //   而收藏项是互斥双文案 —— 状态没喂进去的话，用户会看到「收藏笔记」
  //   点一下却变成「取消收藏」，第一次点像是没用。
  faved: false,
  night: false,
  linkInApp: readPref('linkInApp', '1') === '1',
  favList: [],
  histList: [],
  histFail: '',
  // 🔴 历史预览三件（用户报障第 4 条「历史版本页面没有预览按钮」）
  histPreviewTs: '',
  histPreviewText: {},
  histPreviewErr: {},
  conflicts: [],
};

/** 收藏的localStorage 口。老项目是纯本机键（notesync_favs），本项目独立前缀。 */
const favStore = browserStore();

/** 彩蛋层。懒建于第一次需要时（门牌/图鉴/触发点），不进编辑器就不建。 */
let eggLayer: EggLayer | undefined;

/**
 * 懒建彩蛋层。
 *
 * 🔴 为什么懒建：彩蛋层会往 body 上挂粒子 canvas 与徽章。
 *   用户只是打开一篇笔记去写字，不该为此付出一次 DOM 构建。
 */
function ensureEggLayer(): EggLayer | undefined {
  if (eggLayer) return eggLayer;
  try {
    eggLayer = buildEggLayer(app, eggBrowserStore(), {
      bodyText: () => {
        // 🔴 只给**纯文本**：游戏只是抽词当素材，不该看到真源结构。
        const st = editor?.getEditorState();
        let out = '';
        st?.read(() => {
          out = $getRoot().getTextContent();
        });
        return out;
      },
      favs: () => readFavs(favStore),
      curNote: () => currentNote,
      refocus: () => {
        // 图鉴/游戏关闭后把焦点还给编辑器（老项目红线10：桌面失焦光标不绘制）
        // 🔴 老项目 :6929/:9111 的 `nsEggClose` 是
        //   `if (CHIP_HOVER_OK) { editor.focus(); ensureCaret(); }` —— 触屏不还焦点。
        restoreEditorFocusOnClose();
      },
      onGameClosed: () => {
        // 🔴 门牌路径（/snake）进游戏时落地页从未渲染过，退出后不重画就是空白页。
        //   currentPage==='egg' 正是"这局是靠门牌开的"的唯一可靠证据 ——
        //   菜单里开桌宠时 currentPage 是 'editor'，那里什么都不用做。
        if (currentPage !== 'egg') return;
        // 🔴 顺手把地址栏拉回 '/'：门牌路径的外壳是"同址 pushState"，
        //   close() 判定 pathname 没变就不还原 —— 于是留在 /snake 上，
        //   用户一刷新又被弹回游戏。回落地页却留着游戏URL，是最难查的一类"幽灵状态"。
        try {
          history.replaceState({}, '', '/');
        } catch {
          /* file:// 等极端环境没有 history，落地页照常显示 */
        }
        showLanding();
        goto('landing');
      },
      // 🔴 非游戏彩蛋的 replay（老项目 NS_EGG_LIST 的 replay 字段，:6886-6887）。
      //   `type` → 点播一声回车铃（force=true 绕开静音门，但仍走 ctx running 检查）；
      //   `diag` → 直接开诊断模态。
      //   🔴 未知 id 返回 false —— layer.ts 据此**不埋点**（见那里的注释：
      //   不能让"用户点了没反应"变成"图鉴里已发现"）。
      replaySide: (id: string): boolean => {
        if (id === 'type') {
          const s = eggLayer?.sound;
          if (!s) return false;
          const rang = s.type('enter', true);
          if (rang) markDiscovered(eggBrowserStore(), 'type', true);
          return true;
        }
        if (id === 'diag') {
          openDiagModal();
          return true;
        }
        return false;
      },
    });
    eggLayer.bindTriggers();
    return eggLayer;
  } catch (e) {
    // 🔴 彩蛋层坏掉绝不能连带笔记不可用：它是娱乐层，不是数据层
    console.warn('[notesync] 彩蛋层初始化失败（不影响笔记）', e);
    eggLayer = undefined;
    return undefined;
  }
}

// 🔴🔴 正式 e2e 钩子：**在模块作用域注册**，不挂在 ensureEggLayer 里面。
//   挂在里面的话，钩子只在那次懒建之后才存在 —— 于是"编辑器里直接调
//   __NOTESYNC_EGG_OPEN__('snake')"拿到 undefined，而调用方看到的是
//   "is not a function"，完全指不到真正的原因（层还没建）。
//   钩子本身就是懒的：被调时才 ensureEggLayer，语义不变但始终可调。
window.__NOTESYNC_EGG_OPEN__ = (id: string): boolean => ensureEggLayer()?.openByRoute(id) ?? false;
window.__NOTESYNC_EGG_CODEX__ = (): boolean => eggLayer?.codexOpen() ?? false;
window.__NOTESYNC_EGG_CODEX_OPEN__ = (): void => {
  ensureEggLayer()?.openCodex();
};
// 🔴 词表确认浮层的只读探针。**不含**任何能改状态的入口 ——
//   「关掉浮层」「点进入」都由真实点击走生产路径（e2e 用真click），
//   这里只回答「弹了没有 / 弹的是谁」，避免测试为了方便去开后门。
window.__NOTESYNC_EGG_ASK__ = (): boolean => eggLayer?.wordAskOpen() ?? false;
window.__NOTESYNC_EGG_ASK_ID__ = (): string => eggLayer?.wordAskId() ?? '';

/* ------------------------------------------------------------------ *
 * 诊断面板（老项目 index.html:1926-2082 + :8204-8215）
 * ------------------------------------------------------------------ */

/**
 * 🔴 当前真源的模块级只读引用（给诊断面板数提醒用）。
 *
 * `latestDoc` 是 `mountEditor` 的闭包局部变量，诊断面板在模块作用域拿不到它。
 * 这里另存一份引用，**在 update 监听里赋值**（`latestDoc` 的每一次真变更都会
 * 经过那个监听，见 mountEditor 的对账收口），所以它不会与真源漂移。
 *
 * 🔴 为什么不复用 `window.__NOTESYNC_DOC__`：那个钩子每次调用都
 * `structuredClone(latestDoc)`，而诊断浮层**每 250ms 采一次** ——
 * 全文深拷贝 4 次/秒，在一个长笔记上是白给的主线程开销。
 * 诊断要的是 reminders 的条数与时间，不是深拷贝。
 */
let latestDocRef: Doc | undefined;

/** 诊断读数的采集依赖。**每次取快照时重新组装**（里面的闭包读的都是当下的值）。 */
function diagDeps(): DiagDeps {
  return {
    version: APP_VERSION,
    editorHost: () => editor?.getRootElement() ?? document.getElementById('editor-host'),
    // 🔴 Lexical 自带组字态。老项目的 `isComposing` 是它自己维护的全局变量，
    //   bj 不复制那套全局态，直接问编辑器 —— 少一个可能与真实状态不同步的影子变量。
    composing: () => editor?.isComposing() ?? null,
    // 🔴 v1.13.0：原来读 `window.__NOTESYNC_NATIVE__ === true`，而那个标志**全仓从无赋值**
    //   ⇒ 恒 undefined ⇒ 诊断面板在真机 APK 里也显示 `web`。改用统一判据（platform/native-detect.ts）。
    isNative: () => isNativeApp(),
    sync: () => syncRef?.diagState() ?? null,
    doc: () => latestDocRef ?? null,
    scan: () => window.__NOTESYNC_SCAN_DIAG__?.() ?? null,
    // 🔴 留存放在 reminder/ui.ts（真正产出 SyncOutcome 的地方，见那里的注释）
    lastNativeSync: lastNativeSyncOutcome,
    // 飞行记录器（v3.0.9 诊断版）：追加在诊断读数之后，复制按钮一并带走。
    flight: () => flightLines(),
  };
}

/** 诊断面板。懒建于第一次真需要时（连点 / ?diag / 图鉴 replay 三条路共用）。 */
let diagPanel: DiagPanel | undefined;

function ensureDiagPanel(): DiagPanel {
  if (diagPanel) return diagPanel;
  diagPanel = buildDiagPanel(app, diagDeps(), {
    // 🔴 埋点：老项目 :8219 是 openDiagModal 的第一行 `nsEggUnlock('diag')`。
    //   走 markDiscovered（幂等，见 registry.ts）而不是自己写 storage ——
    //   自己写就会绕过"未注册 id 拒收"与"按注册表过滤"两条口径。
    onUnlock: () => {
      markDiscovered(eggBrowserStore(), 'diag', true);
    },
    onClosed: () => {
      restoreEditorFocusOnClose();
    },
  });
  return diagPanel;
}

/** 打开诊断模态。连点 / 图鉴 replay / e2e 三条路共用这一个入口。 */
function openDiagModal(): void {
  ensureDiagPanel().open();
}

/**
 * e2e / 控制台钩子。
 *
 * 🔴 只回**文本**，不回 DOM 句柄：钩子挂在 window 上，回一个能改的节点等于开后门。
 *   判"诊断面板弹了没有"看返回值有没有 10 组（见 test/diag-panel.test.mjs）。
 */
window.__NOTESYNC_DIAG__ = (): string | null => {
  try {
    return collectDiagLines(diagDeps(), Date.now()).join('\n');
  } catch (e) {
    // 🔴 采读数失败绝不让调用方拿到半个对象：返回 null 明确表示"这次没采到"
    console.warn('[notesync] 诊断读数采集失败', e);
    return null;
  }
};

let menuRef: ReturnType<typeof buildMenu> | undefined;

function goto(page: string): void {
  currentPage = page;
  window.__NOTESYNC_PAGE__ = () => currentPage;
}

/**
 * 顶栏 7 键的处理器。
 *
 * 🔴 S4 只做两件事：把删除线这类**纯编辑器内**的操作接上，
 *   其余（图片、复制、导出、扫码、二维码）分别属于 S5/S6。
 *   未接的键**不弹"敬请期待"** —— 那是老项目没有的文案，用户会以为是坏了；
 *   静默无反馈也不行（用户会反复点），所以在底栏给一行短状态。
 *
 * 🔴 `default:` 分支只剩兜底，**新增顶栏键必须在这里补 case**。
 *   复制键此前就漏在这儿：落进 default 只置了 connecting，
 *   症状是"点了没反应、什么也没复制"，零报错（老项目是真复制）。
 *   `TOPBAR_ITEMS`（ui/shell.ts）与本switch 的一致性由 ui-contract.test.mjs 盯。
 */
function onTopbar(act: TopbarAction): void {
  const ed = editor;
  switch (act) {
    case 'strike': {
      if (!ed) return;
      // 🔴🔴 必须用**公开**的 FORMAT_TEXT_COMMAND，不能自己拼 payload 调 dispatchCommand：
      //   富文本命令的 payload 形态是包内约定，0.52 起还多了 Extension 体系，
      //   写死会静默失效（不报错、不生效、单元测试也测不出来）。
      //   FORMAT_TEXT_COMMAND 的语义就是"切换"，与老项目顶栏删除线一致。
      ed.dispatchCommand(FORMAT_TEXT_COMMAND, 'strikethrough');
      return;
    }
    case 'remind': {
      // 顶栏铃铛 = 打开提醒面板（老项目同一入口）
      reminderRef?.togglePanel();
      return;
    }
    case 'upload': {
      // 顶栏上箭头 = 选图上传（老项目同一入口）
      pickImage();
      return;
    }
    case 'copy': {
      // 🔴 必须判编辑器在不在：顶栏在编辑器卸载后仍留在 DOM 里（与 exportImg 同款守卫）。
      //   复制是从**真源模型**读的（不是 DOM），所以收起态的折叠块也能读到完整正文 ——
      //   见 export/copy.ts 文件头第一节：老项目需要"临时展开再还原"的那套
      //   是因为它读 innerText 会被 CSS display:none 吃掉，我们不读 DOM 就没这问题。
      if (!ed || currentPage !== 'editor') {
        setFootStatus?.('offline', COPY.copyNoEditor);
        return;
      }
      void copyNoteToClipboard({
        getDoc: () => window.__NOTESYNC_DOC__?.() ?? emptyDoc(),
        dismissKeyboard: () => dismissKeyboardForTouch(),
        // 🔴 复用上传状态条而不是底栏：底栏那一行是同步状态的位置，
        //   拿它显示"已复制"会让用户以为同步出了问题（与 exportImg 同款口径）。
        onStatus: (kind, text, autoHideMs) => showUploadNote(kind, text, autoHideMs),
        okMs: COPY.copyOkMs,
        failMs: COPY.copyFailMs,
      });
      return;
    }
    case 'exportImg': {
      // 🔴 必须判编辑器在不在：顶栏在编辑器卸载后仍留在 DOM 里，
      //   此时点导出会 buildCard(null) 抛 TypeError，症状是"退出后误点顶栏就报错"。
      const host = document.getElementById('editor-host');
      if (!ed || !host) {
        setFootStatus?.('offline', COPY.exportNoEditor);
        return;
      }
      void exportNotePng({
        editorHost: host,
        noteId: currentNote,
        brandSvg: document.querySelector('#brandMark svg'),
        dismissKeyboard: () => dismissKeyboardForTouch(),
        onStatus: (kind, text, autoHideMs) => {
          // 🔴 复用上传状态条而不是底栏：底栏那一行是同步状态的位置，
          //   拿来显示"正在生成图片"会让用户以为同步坏了（老项目同款口径）。
          showUploadNote(kind, text, autoHideMs);
        },
        // 🔴 v1.13.0：同 diagDeps —— 原读那个从无赋值的 __NOTESYNC_NATIVE__，
        //   恒false ⇒ APK 里导出长图走不到原生复制那一档（降级到 html2canvas，慢且可能失败）。
        isNativeApp: isNativeApp(),
        nativeCopyImage,
        okMs: COPY.exportOkMs,
        failMs: COPY.exportFailMs,
      });
      return;
    }
    case 'scan': {
      // 🔴 收键盘：光标在笔记内点扫一扫不弹软键盘（老项目 v7.5.1 口径）。
      dismissKeyboardForTouch();
      openScanner();
      return;
    }
    case 'qr': {
      dismissKeyboardForTouch();
      // 🔴 顶栏在编辑器卸载后仍留在 DOM 里，出码必须判当前笔记在不在 ——
      //   否则 buildPairLink 会出指向空篇名的码，扫过去是「打不开」。
      if (!currentNote || currentPage !== 'editor') {
        setFootStatus?.('offline', COPY.pairNoKey);
        return;
      }
      buildPairPanel({
        passphrase: passForPair(),
        noteId: currentNote,
        origin: location.origin,
        // 🔴 出码后把链接交出来（正式接口，供 e2e 判"这条码往返无损"）。
        //   配对链接是画在 canvas 上的，DOM 里读不到；不给这条口，
        //   判据就只能自己手写一份 buildPairLink —— 那正是禁止的"第二份实现"。
        onCode: (link) => {
          lastPairCode = link;
        },
        // 🔴 本机没有口令时的唯一出口：锁定 → 解锁 → 出码。
        //   触发路径是「记忆解锁」进来的那次会话（route() 里 unlockIfRemembered 成功，
        //   从未经过口令，sessionPass 为空）。不给这个按钮，用户看到的就是
        //   「明明在编辑器里却说没解锁」，且无路可走（用户报障第 13 条）。
        //   🔴 锁定前先关弹层：否则新弹层盖在旧弹层上，reload 前的观感是"点了没反应"。
        onLockNow: () => {
          closePairPanel();
          sessionPass = '';
          void lockNote(currentNote).then(() => location.reload());
        },
        onClosed: () => {
          // 🔴 关闭必须归还焦点（老项目红线）：否则用户关掉弹窗后
          //   光标停在 body 上，接着敲键盘什么都不会发生。
          // 🔴🔴 但**只在有精确指针的设备上还焦点**（老项目 :3377/:7628
          //   `if (CHIP_HOVER_OK) { editor.focus(); ensureCaret(); }`）。
          //   手机上无条件还焦点 = 每次关二维码弹窗都弹一次软键盘（用户报障第 8 条）。
          restoreEditorFocusOnClose();
        },
      });
      return;
    }
    default:
      setFootStatus?.('connecting');
      return;
  }
}

/**
 * 挂载编辑器。
 * 🔴 `initial` 必须由调用方给**已解密**的文档，绝不能在这里再自己去拉 ——
 *   解密是异步的，在 mountEditor 内部拉会出现"编辑器先显示空的，
 *   稍后内容才闪进来"的中间态，而用户在这半秒内打字就会被打断。
 */
/**
 * 进笔记时递一句「每日一句话」（老项目 index.html:3481/3512/10323 三处调用）。
 *
 * 🔴 为什么要延 1000ms：老项目三处调用点全是 `setTimeout(..., 1000)`
 *   （index.html:3481 注释写明「v5.44：与 PWA 安装条同帧不抢」）——
 *   问候与安装条、节日雨都挤在"进笔记"这一刻，不让开就会互相盖。
 *
 * `dayGreet` 内部自带幂等（同日同篇不重复）与错峰判断
 * （冲突条/更新条在场时跳过），这里只管调用时机。
 */
function greetThisNote(noteId: string): void {
  window.setTimeout(() => {
    try {
      dayGreet(noteId);
    } catch {
      /* 问候是装饰，绝不能影响进笔记 */
    }
  }, 1000);
}

/**
 * 刷新开奖卡句柄（老项目 v9.2.0）。
 *
 * 🔴 抽卡必须落在 `location.reload()` **之前**（老项目 index.html:5765 注释：
 *   「reload 一执行后面就是死代码」）。写在 reload 之后 ⇒ 永远抽不到卡，
 *   而症状是"刷新了但从不开奖"——**零报错**，因为 reload 本身工作正常。
 */
const eggDraw = buildEggDraw();

function mountEditor(name: string, initialDoc?: Doc): void {
  currentNote = name;
  // 🔴 离线草稿条是常驻 DOM：换笔记先收上一条（是否再弹由 startSyncFor 的裁决决定）。
  hideDraftBar();
  // 🔴 收藏态与收藏夹列表必须在**挂菜单之前**算好：菜单是打开时读这两个值的，
  //   留到 onMenu 回调里算就晚了（那时 innerHTML 已经渲染完，用户会先看到
  //   「收藏笔记」点一下才变「取消收藏」）。
  menuState.faved = readFavs(favStore).indexOf(name) >= 0;
  syncRef?.noteEdit();
  menuState.favList = favListOf(favStore);

  const shell = buildShell(app, {
    // 🔴 顶栏品牌位在移动端显示笔记名（App 没有地址栏，PC 看 URL 即知）。
    //   老项目 index.html:10135 的条件是 `noteId && (isNativeApp() || !CHIP_HOVER_OK)`；
    //   不传这个字段时 shell 会判成首页（字标显示、笔记名不显示），不会崩，
    //   但用户报障第 3 条「移动端左上角没有显示笔记名」就不会好。
    noteId: name,
    onTopbar: (act) => void onTopbar(act),
    onMenu: () => {
      // 打开前重算一次：可能在别的笔记里加过收藏（换设备/开两个标签）
      menuState.faved = readFavs(favStore).indexOf(name) >= 0;
      menuState.favList = favListOf(favStore);
      menuRef?.open();
    },
    // 🔴🔴 「刷新 + 掉一张卡」（老项目 index.html:5758-5767）。
    //   `roll()` 必须在 `location.reload()` **之前**：reload 一执行后面就是死代码，
    //   写在后面 ⇒ 券永远抽不到，症状是"刷新了但从不开奖"，且**零报错**。
    //   抽卡失败（隐私模式写不进 storage 等）绝不挡住刷新本身 ——
    //   drawRoll 内部整段 try/catch，异常路径返回 null。
    onRefresh: () => {
      // 🔴 两道刹车（老项目 :5760 `if (busy || inflightWrites > 0)`）：
      //   在途保存/有未推送改动时不抽卡、不 reload —— reload 会打断在途写入。
      //   提示文案与自动收起时长逐字照抄老项目 :5761-5762。
      if (saveInFlight()) {
        showUploadNote('doing', COPY.refreshSaving, 1500);
        return;
      }
      eggDraw.roll();
      location.reload();
    },
    onSkin: (skin) => {
      currentSkin = skin;
      // 🔴🔴 必须走 repaint()，不能只调 shellRef.setSkin：
      //   `:root` 的九档配色变量**只有 applyThemeVars 会写**（repaint 里那一次），
      //   而 setSkin 只换 body class / 字体 / 覆膜纹理。老项目 `nsSetSkin` 末尾
      //   就是 `applyTheme(themeWantsDark)` 重注入调色板（index.html:1750）。
      //   只调 setSkin 的症状：七连点切皮肤当场只换字形不换色，
      //   要等下次切主题/刷新才生效 —— 用户报障第 9 条。
      repaint();
      // 🔴 复古皮肤蛋埋点（老项目 index.html:1744-1759 `nsSetSkin`：
      //   `if (nsSkin !== 0) nsEggUnlock('skin')`）。**只有离开默认档才埋**——
      //   七连点转一圈回到默认档时那次不算"体验过复古皮肤"。
      //   走 markDiscovered（幂等 + 按注册表过滤），不自己写 storage。
      if (skin !== 'default') markDiscovered(eggBrowserStore(), 'skin', true);
    },
  });
  shellRef = shell;
  setFootStatus = shell.setStatus;
  // 🔴 桌宠挂顶栏下沿（老项目 petMount，index.html:11198）。
  //   必须在这里（而不是 boot）调：header 是 buildShell 刚建出来的，
  //   早一步 `document.querySelector('header.ns-top')` 恒为 null ⇒ 永不挂载，
  //   而症状是"访问过 /pet 也看不到螃蟹"，零报错。
  //   未领养时 mountPet 自己就返回 false（老项目 `adopted` 缺省 false = 默认关）。
  mountPet();
  // 首屏就把皮肤摆对（default 档也要调一次：清空残留纹路）
  shell.setSkin(currentSkin, currentTheme === 'dark');

  // 菜单面板挂在 shell 之后（同一宿主内，用fixed 定位，互不影响）
  menuRef = buildMenu(app, menuState, {
    // 🔴 关闭菜单 = 把焦点**还给编辑器**（老项目红线 10）。
    //   menu.ts 的 close() 在收掉遮罩后调这个回调：打开时它把焦点收进了菜单盒
    //   （否则键盘用户按 Esc 关不掉菜单 —— 事件 target 是编辑器，不冒到遮罩），
    //   关掉时若不还回去，焦点落在一个刚被摘干净的节点上，
    //   症状是"关掉菜单后打字没反应"，用户视角就是"菜单点了没反应"。
    //   ⚠️ 此前这个回调写的是 `() => menuRef?.close()` —— 自己调自己。
    //     因为 close() 从来不调它，所以只是一条死路；现在真被调用了，
    //     不改就是无限递归。**教训：把回调从"没人调"改成"有人调"时，
    //     必须重读它的实现** —— 死代码里往往藏着荒谬的接线。
    onClose: () => {
      // 🔴🔴 触屏不还焦点（老项目 :8000/:8216/:8244/:8249
      //   全部是 `if (CHIP_HOVER_OK) { editor.focus(); ensureCaret(); }`）。
      //   手机上点空白关菜单就弹键盘 —— 用户报障第 10 条前两项。
      restoreEditorFocusOnClose();
    },
    onHome: () => {
      // 🔴 v1.13.0（老项目 index.html:8036-8040逐字同款）：主动回首页必须打
      //   "已跳转"标记 —— 否则 APK 里 route() 的冷启动自动跳转会把用户又弹回
      //   last note（手动输名/扫码/收藏夹进入时那条路径从未设过标记）。
      markJumped();
      history.pushState({}, '', '/');
      route();
    },
    onToggleFav: () => {
      // 🔴 收藏是**本机键**（不进真源、不同步）—— 老项目 v5.55 拍板。
      //   收藏表达"这台设备上我常看哪几篇"，塞进真源会让两台设备互相覆盖。
      const r = toggleFav(favStore, name);
      menuState.faved = r.faved;
      //🔴 收藏夹列表必须同刻重算：老项目 toggle 后立刻 writeFavs，
      //   而收藏夹视图若还读旧缓存，进去会看到刚才取消的那条还在。
      menuState.favList = favListOf(favStore);
      // 超上限时如实告知挤掉了谁 —— 不说的话用户查不到自己刚收藏的。
      //🔴 走 footFlash 而不是裸 setFootStatus：裸调用会被紧接着到达的同步
      //   快照覆盖，提示一闪而过（老项目没这洞是因为它压根不提示）。
      if (r.evicted !== null) {
        footFlash(COPY.favFull(FAVS_MAX), 5_000);
      }
      // 🔴 收藏一变就刷新本机的换机备份笔记（v4，见 refreshBakNote 注释）。
      //   fire-and-forget：刷新是副作用，不挡收藏、失败也不报错。
      void refreshBakNote();
    },
    onOpenFav: (n) => {
      location.href = '/' + encodeURIComponent(n);
    },
    onSaveHist: async () => {
      // 手动打点：用户明确要的，**不过自动节流**（老项目 :8551 同款）。
      const dk = currentDk;
      if (!dk) {
        showUploadNote('bad', COPY.histNeedUnlock, 2200);
        return;
      }
      const doc = window.__NOTESYNC_DOC__?.();
      if (!doc) {
        showUploadNote('bad', COPY.histNeedUnlock, 2200);
        return;
      }
      const ts = await pushHistory(name, doc, dk.key, dk, true);
      showUploadNote(ts === null ? 'bad' : 'ok', ts === null ? COPY.histNetFail : COPY.histSaved, 2200);
    },
    onLoadHist: async () => {
      await loadHistIntoMenu(name);
    },
    onOpenHist: (at) => {
      // 🔴 点行/点「恢复」都走这里。老项目只有一个恢复入口，本项目两个入口同一条路。
      void restoreHistVersion(name, at);
    },
    onPreviewHist: async (at) => {
      // 🔴 展开/收起是同一个按钮的两种结果，先认"当前开着的那一版"
      if (menuState.histPreviewTs === at) {
        menuState.histPreviewTs = '';
        return;
      }
      menuState.histPreviewTs = at;
      const dk = currentDk;
      if (!dk) {
        menuState.histPreviewErr[at] = COPY.histNeedUnlock;
        return;
      }
      const ts = Number(at);
      // 🔴🔴 网络失败与"这一版解不开"**必须分两句**（老项目 index.html:8485的注释同款）：
      //   "预览失败：网络异常，请重试" ⇒ 用户重试一下就好；
      //   "该版本不可用" ⇒ 再点一百次也是这个结果。
      //   合成一句的话，用户会一直重试一件不可能成功的事。
      //   🔴 且 fetchHistoryDoc 内部对"没有这一版"与"解不开"返回同一个 null
      //   （安全不变量：不给暴力破解 oracle），所以网络与非网络只能靠
      //   "拿之前先探过网络"来分—— 这里用 histNetFail 只在 fetch 抛错时给。
      let doc: Doc | null;
      try {
        doc = await fetchHistoryDoc(name, ts, dk.key);
      } catch (e) {
        menuState.histPreviewErr[at] = COPY.histPreviewNetFail;
        return;
      }
      if (doc === null) {
        // 🔴 区分不了"没这一版/解不开"与"网络断"，措辞取保守的那句
        menuState.histPreviewErr[at] = COPY.histBad;
        return;
      }
      delete menuState.histPreviewErr[at];
      // 🔴 复用生产代码那份plain 生成器（export/copy.ts 的 docToClipboardPayload），
      //   **不另写一份** Doc→文本：另写一份必然与复制/导出口径漂移，
      //   于是用户看到的预览与恢复后的正文长得不一样。
      const text = docToClipboardPayload(doc).plain;
      menuState.histPreviewText[at] = text === '' ? COPY.histPreviewEmpty : text;
    },
    onLinkMode: (inApp) => {
      menuState.linkInApp = inApp;
      writePref('linkInApp', inApp ? '1' : '0');
    },
    onBackup: () => {
      // 🔴🔴🔴 必须先关菜单，否则弹层盖在菜单上，**看起来像弹了两层**
      //   （用户报障：「点扫码换机后下面又弹一个『扫码换机』」）。
      //   老项目同款：菜单项 click 里 `menuMask.classList.add('hidden')`（index.html:9113）
      //   —— 它是**先关菜单再开弹层**，bj 此前漏了关闭那一步。
      menuRef?.close();
      // 🔴 这里曾是一句 `location.href = '/backup'` —— 一条**死链**。
      //   服务端没有这个页面（SPA 回落到 index.html），
      //   而 egg/registry.ts:88 又把 `backup` 列为保留字，
      //   于是「点扫码换机 → 跳 /backup → 回落 → 落进首页提示页 → 什么也没发生」，
      //   全程零报错。用户看到的就是"这个按钮坏了"。
      //
      //   老项目（index.html:795`class="mask hidden" id="bakMask"` +
      //   9113 菜单项 click 里 `menuMask.classList.add('hidden')` 且全程无 location 赋值）
      //   是**弹层**，不是独立页面 —— 依据见 migrate/panel.ts 文件头。
      //   所以这里开遮罩，既与老项目一致，也让 `backup` 保留字可以留在原地
      //   （egg-registry.test.mjs:72 正钉着它）。
      openMigrateMake();
    },
    onPet: () => {
      // 🔴 桌宠是**彩蛋门牌**（老项目：菜单「桌宠」直接进 /pet），
      //   不跳路由：走 openByRoute 才能复用游戏外壳与音效。
      ensureEggLayer()?.openByRoute('pet');
    },
    onToggleTheme: () => {
      // 🔴 手动切换是**内存态，刻意不写 localStorage**（老项目行为）：
      //   刷新或重新解锁一律回到时间规则。写进存储就等于给老项目加了个它没有的功能。
      manualDark = currentTheme === 'dark' ? false : true;
      applyTheme();
    },
    onChangePass: () => {
      // 重设口令：真走换密钥（解旧密文 → 用新口令重加密 → 推上去 → 换本机密钥）。
      // 🔴 绝不能只清个"记住"标记了事 —— 那样用户下次进来会被要求输新口令，
      //   而云端还是旧口令的密文，于是**这篇笔记从此再也解不开**。
      void doChangePassphrase();
    },
    onLock: () => {
      // 锁定 = 只清本机密钥与缓存，云端数据不动（老项目行为）。
      // 🔴🔴 必须先清会话口令。锁定的语义是"这台设备不再持有任何凭据"，
      //   而口令留在内存里的话，配对码还能照出 —— 用户以为锁了，
      //   实际上任何能操作这台机器的人扫一下屏幕就能拿走口令。
      sessionPass = '';
      // 🔴 桌宠也要拆：它是 60ms 一跳的定时器，不拆就在锁定的页面上继续爬。
      unmountPet();
      void lockNote(name).then(() => location.reload());
    },
    onAbout: () => {
      // 🔴 S8：就地打开关于页浮层，**不再**跳 /about。
      //   跳路由在老项目里成立是因为老项目有真实的 about 页；
      //   新项目没有这条路由，跳过去会落进门牌解析 ——
      //   症状是"点关于 → 页面变白 / 提示笔记名不合法"，而不是一个关于页。
      //   顺带把"App 版本"与"检查更新"两行接上（仅壳内显示）。
      const about = buildAboutOverlay(root || app, {
        native: nativeDepsFromWindow(window),
        webVersion: APP_VERSION,
        // 🔴 彩蛋：标题 800ms 内连点 4 次 ⇒ 关关于页 + 开诊断模态
        //   （老项目 index.html:8204-8215）。计数状态机在 diag/tap.ts。
        onTitleQuadTap: () => {
          openDiagModal();
        },
        // 🔴🔴 关于页「彩蛋 N / M FOUND」入口行（老项目 index.html:11115-11131）。
        //   用户报障第 5 条「关于 NoteSyncX 没有列举彩蛋」—— 老项目把这行插在作者行之后，
        //   计数与图鉴**同一口径**（readDiscovered 已按注册表过滤，见 registry.ts 文件头），
        //   点整行走 `nsEggOpen` 同款出口（ensureEggLayer().openCodex()）。
        //   🔴 计数在**每次开关于页**时现算（buildAboutOverlay 每次重建）——
        //     本会话新解锁的蛋不会还挂着旧数（老项目 :11119 的"重开必须刷新"）。
        eggRow: {
          count: () => eggCountText(readDiscovered(eggBrowserStore()).size),
          open: () => {
            ensureEggLayer()?.openCodex();
          },
        },
        // 🔴🔴 v3.0.12：关于页关闭后归还焦点/选区到编辑器（见 ota-ui.ts onClose）。
        onClose: () => restoreFocusAndReanchor(),
      });
      void about.open();
    },
    onKeepLocal: () => {
      // 保留本机：把当前内容推上去，覆盖云端。
      // 🔴 必须走 sync 客户端而不是直接 POST：它持有 base，
      //   直接推会让下次三方合并的祖先错位。
      syncRef?.resolveKeepLocal();
    },
    onKeepRemote: () => {
      // 保留云端：丢弃本机改动。
      //🔴 这一步是**破坏性**的（用户本机输入的字会消失），
      //   所以必须由用户显式点选，不能由程序自动裁决。
      syncRef?.resolveKeepRemote();
    },
  });

  const { root: shellRoot, editorHost } = shell;
  shellRoot.dataset.note = name;
  shellRoot.dataset.version = APP_VERSION;
  shellRoot.dataset.schema = String(SCHEMA_VERSION);
  shellRoot.dataset.build = BUILD_DATE;
  // 🔴 root 提到模块级：同步状态的回调（onSnapshot）要写 root.dataset.syncState，
  //   而那个回调在 mountEditor 之外触发。留在局部会直接 ReferenceError，
  //   且只在这条路径上炸 —— 表现为"底栏不更新"，与状态机无关。
  root = shellRoot;

  const ed = createEditor({
    namespace: 'NoteSyncBJ',
    theme: THEME,
    // 🔴 必须给全量清单（内置 + 自定义），少一个就在运行时抛
    //   "Attempted to create node X that was not configured"，症状是整篇文档变空
    nodes: [...ALL_NODES],
    onError(e: Error) {
      // 不吞异常：空白页类故障的取证入口就是这里
      console.error('[notesync] editor error', e);
    },
  });

  ed.setRootElement(editorHost);

  // 🔴🔴🔴 IME 门控（用户报障第 7 条）：**按挂载实例独立**，不做模块级单例。
  //
  //   为什么必须挂到 editorHost 而不是 document：Lexical 的 composition 事件
  //   冒泡到宿主，挂在 document 上会同时收到别的元素（弹窗里的输入框）的组字事件
  //   ⇒ 在弹窗里打字会把这个编辑器也锁成"组字中" ⇒ 回灌全停。
  //
  //   为什么必须解绑（off()）：bj 是多页 SPA，会反复 mountEditor。
  //   旧监听不撤⇒ 状态跨挂载残留（新编辑器继承上一篇的组字态 / 活跃期），
  //   症状是"换一篇笔记后同步功能坏了"，而本机一切正常。
  // 🔴🔴 P0-3 语音修复：把 Lexical 自身的组字态也喂进门控（防御纵深）。
  //   豆包语音转文字的组字串有时挂在 Lexical 内部、`composition` 事件因时序/宿主
  //   元素问题没被本门控收到 ⇒ 仅靠 DOM 事件会漏拦。Lexical 的 isComposing()
  //   是它自己监听同一批事件得出的内部态，能兜住这道漏网。它**只增不减**地加固
  //   canApply()，不会削弱既有判据。闭包延迟读取 `editor`，此刻 editor 尚未赋值，
  //   但 canApply() 被调用时 editor 早已挂好。
  const imeGate: ImeGate = createImeGate(undefined, () => editor?.isComposing() ?? false);
  // 🔴🔴 v3.0.10：跨段组字串塌方守卫（豆包智能整理丢字的根因修复）。
  //   见 compose-guard.ts 顶部注释。它**只依赖自己的 active 标志**（由下面
  //   compositionstart 处理器设置），不读 editor.isComposing() —— 因为塌方发生时
  //   Lexical 原生合成回灌已经把正文吞了，isComposing 真假都不影响判定。
  const composeGuard = new ComposeGuard();
  // 🔴🔴 v3.0.14：组字会话水位线（撤稿吞字守卫）。v3.0.13 真机日志钉死：丢字
  //   走的是「会话内渐进放血（重识别修订每步低于塌方阈值）+ 会话收尾撤稿」，
  //   单帧灾难性模型全盲（collapse 不增、drop 低于阈值、最终只剩第一句）。
  //   见 compose-guard.ts WithdrawGuard 注释。与 composeGuard 同一调用点喂帧。
  const withdrawGuard = new WithdrawGuard();
  // 🔴🔴🔴 v3.0.15：撤稿恢复的「模型先落账、树延迟同步」。
  //   v3.0.14 真机日志（第二份）实测钉死：撤稿判定后浏览器侧组字常常还活着
  //   （synthed=0、comp=1 每帧都来 —— Lexical 内部组字态整场未断），立即
  //   docToLexical 重建会**杀死组字锚点**：锚点节点被销毁后，后续每帧
  //   insertCompositionText 全部模型空转（upd len=9 d=0 冻结、组字串
  //   d=77→93 持续增长 3.5s+），用户继续口述的内容一个字都进不了文档。
  //   改为：撤稿帧只写模型（peakDoc），树同步延迟 —— v3.0.17/18 机制演进为：
  //     - 组字帧/组字会话开始 ⇒ holdDeferredTreeSync()：只推迟（v3.0.18 解冻
  //       移到 update 监听，锚=会话峰值 deferPeakLen——树长涨过峰值才算组字
  //       恢复写入成功）；
  //     - 组字态活着 ⇒ 观察窗顺延（帧稀疏只是口述停顿，不等于组字死）；
  //     - 连续 4 帧空转（组字串远长于文档+树长不动）⇒ wd:dead 取证 + wd:reboot
  //       自愈（强制结束死会话+重建 peakDoc，v3.0.18：锚点死亡实时流断裂治本）；
  //     - 组字态真正结束（ce/comp=0）后窗口到期 ⇒ 重建兜底（峰值内容上屏）。
  //   ⚠️ 这是同一闭包内的局部 timer：换笔记重挂载后旧 timer 随旧闭包废弃，
  //   不会跨笔记触发（回调里捕获的 ed/最新引用都是旧闭包自己的）。
  /** 🔴🔴🔴 v3.0.17：观察窗从 600ms 放宽到 1200ms。v3.0.16 真机日志实测：豆包
   *  语音口述有停顿，组字帧间隔可达 778ms（54351→55129）——600ms「无帧=组字死」
   *  不成立，定时器在停顿中到期重建杀了锚点，用户再开口述全部空转（len=20 冻结、
   *  组字串 d=193→212 增长）。窗口必须盖过正常停顿间隔。 */
  const WD_SYNC_WINDOW_MS = 1200;
  let deferredTreeSyncTimer: ReturnType<typeof setTimeout> | null = null;
  // 🔴🔴🔴 v3.0.16：延迟同步窗口内**冻结「树→模型」常规同步**。探针实测（e2e
  //   E2E-01/04 破案）：塌方判定帧落账 before 之后，紧跟着的塌方残留帧（树=短串）
  //   会走常规 reconcile 把 latestDoc/latestDocRef **覆盖成残串** —— 600ms 后
  //   wd:sync 重建的就是残串，峰值内容照样丢。冻结解除：组字帧 hold（模型=树，
  //   口述内容进模型）或 wd:sync 重建完成时。
  let wdFreeze = false;
  /** 观察窗基线：判定/重置时刻的树长。到期时树**变长**了 = 窗口内有新内容写入
   *  （用户切键盘手动打字 —— insertText 不走 hold 通道），树内容是用户最新
   *  意图，绝不能重建抹掉；只解冻让常规同步接管。变短/不变 = 塌方收尾或无写入
   *  = 正常兜底重建。 */
  let deferTreeLen = 0;
  /** 🔴🔴🔴 v3.0.18 解冻判据的锚：判定时刻的**会话峰值长度**（撤稿=peakLen、
   *  塌方=prevLen）。探针实测（WD-E2E-05）：v3.0.18 初版用「树长 > deferTreeLen
   *  基线」做解冻判据 —— 合成 compositionstart 重开组字会话的副作用能让树长
   *  +1（组字锚点重建），14 > 13 基线 ⇒ 误解冻 ⇒ peakDoc 被残串覆盖（docLen
   *  108→13）。树长涨过**会话峰值**才是「组字恢复写入成功」的真证据（组字串
   *  全量替换语义下，恢复=树长追上并超过峰值）；锚点死亡空转场景树长永远
   *  到不了峰值 ⇒ peakDoc 绝不被覆盖。wd:sync 的 skip 判据仍用 deferTreeLen
   *  （保手动打字，两层判据各司其职）。 */
  let deferPeakLen = 0;
  /** 🔴 v3.1.7：延迟同步窗口内是否发生过**用户手动编辑**（非组字的 beforeinput：
   *   insertText/退格等——用户切键盘自己敲字）。wd:sync 到期时的 skip 例外：
   *   手动敲的是最新意图，不能按峰值重建抹掉。组字帧落地不算手动。 */
  let wdWindowManual = false;
  const armDeferredSync = (): void => {
    if (deferredTreeSyncTimer != null) clearTimeout(deferredTreeSyncTimer);
    deferTreeLen = ed.getEditorState().read(() => $getRoot().getTextContent().length);
    deferredTreeSyncTimer = setTimeout(() => {
      deferredTreeSyncTimer = null;
      // 🔴🔴🔴 v3.0.17：到期时 Lexical 组字态还活着 = 组字会话没死（帧稀疏只是
      //   口述停顿）—— 此时重建必杀锚点。顺延观察窗，等 ce/comp=0 真正结束。
      //   记独立标记 wd:wait（ wd:sync 保留给「真正执行重建」，判据好区分）。
      if (ed.isComposing() === true) {
        armDeferredSync();
        recordFlight('wd:wait', 'composing');
        return;
      }
      wdFreeze = false;
      const nowLen = ed.getEditorState().read(() => $getRoot().getTextContent().length);
      // 🔴🔴🔴 v3.1.7：skip 判据从「树长 > 基线」改为「树长 >= 会话峰值」或
      //   「窗口内有用户手动打字且树长 > 基线」。真机 v3.1.6 日志钉死旧判据的坑：
      //   knock-back（懒重连形状）后残串从 11 涨到 13——2 个组字字符落地即
      //   13 > 11 命中 skip ⇒ 峰值 21 永远上不了屏；更严重的是冻结解除后模型
      //   被 13 字残串覆盖并 push 上行＝内容真丢。树没涨过会话峰值＝屏幕上的
      //   还不是最完整的内容，必须按模型重建（峰值才最完整）。
      //   手动打字是唯一例外：用户切键盘敲的字是最新意图，绝不能重建抹掉
      //   （v3.0.17 立的规矩，用 wdWindowManual 标志保留）。
      if (nowLen >= deferPeakLen || (wdWindowManual && nowLen > deferTreeLen)) {
        recordFlight('wd:sync', 'skip len=' + nowLen);
        return;
      }
      const doc = latestDocRef;
      recordFlight('wd:sync', doc == null ? 'no-doc' : '');
      if (doc != null) ed.update(() => { docToLexical(doc); }, { tag: EGG_NOFX_TAG });
    }, WD_SYNC_WINDOW_MS);
  };
  /** 🔴🔴🔴 v3.0.18：组字帧到达 = 推迟重建（锚点可能活着）。**解冻不在这里做**
   *  —— v3.0.17 真机（尾段 len=8 冻结、组字串 d=196→222）实测：锚点可能已被
   *  宿主撤稿操作杀死，组字帧写不进树（空转）；此时解冻会让落账的 peakDoc 被
   *  残串覆盖。解冻决策在 update 监听：树长涨过**会话峰值**（deferPeakLen，
   *  组字恢复写入成功的真证据）才解冻让模型=树；空转则保持冻结（peakDoc
   *  保住，wd:sync 到期照常上屏），并记 wd:dead 取证（连续空转帧）。 */
  const holdDeferredTreeSync = (): void => {
    if (deferredTreeSyncTimer == null) return;
    armDeferredSync();
    recordFlight('wd:hold', '');
  };
  const scheduleDeferredTreeSync = (info: string, peakLen: number): void => {
    wdFreeze = true;
    stallCount = 0;
    stallPrevTreeLen = -1;
    // v3.1.7：新观察窗开账，手动编辑标志归零（该标志只保护**本窗口内**的手动输入）
    wdWindowManual = false;
    // 🔴🔴🔴 v3.1.5：解冻锚（deferPeakLen）在延迟同步**已激活**时只涨不跌。
    //   塌方路径传的是「会话峰值」（见下方调用点的 sessionPeak），而渐进放血
    //   形状下模型长可能远低于会话峰值——任何把锚写低的调用都会让残串提前
    //   解冻覆盖峰值模型（v3.0.18 WD-E2E-05 同款事故的另一入口）。无激活
    //   定时器时（全新塌方）才以本次峰值为锚。
    deferPeakLen = deferredTreeSyncTimer != null ? Math.max(deferPeakLen, peakLen) : peakLen;
    recordFlight('wd:defer', info);
    armDeferredSync();
  };
  /** 🔴🔴🔴 v3.0.18：锚点死亡（空转）检测。延迟同步机制激活期间，组字帧持续
   *  到达（composing=true）但树长纹丝不动、而组字串远长于文档 ⇒ 锚点已死
   *  （宿主撤稿操作/僵尸组字），写入全部空转。连续 4 帧记一次 wd:dead 取证
   *  ——下一轮真机日志靠它钉死锚点死亡根因（宿主杀 vs 我方杀）。 */
  let lastBiDataLen = 0;
  let stallCount = 0;
  /** 🔴🔴🔴 v3.0.19：上一组字帧的树长（静止判定基准）。空转=树长**纹丝不动**
   *  （连续帧同值）才计数；树长在变（撤稿后锚点活着、全量替换逐帧追）绝不
   *  计——防「串远长于树但正在追上」的追帧场景误 reboot 杀活锚点。 */
  let stallPrevTreeLen = -1;
  /** 🔴🔴🔴 v3.0.20：上次 wd:reboot 时刻（冷却判定）。真机 v3.0.19 实测：宿主
   *  InputConnection 视图错位时 reboot 会震荡循环——reboot 重建 111 → 宿主视图
   *  仍停留 14 字残串 → 下一个组字帧按旧视图把树打回 14（upd len=14 d=-97 每帧
   *  重复）→ 判定 → 4 帧空转 → 再 reboot，口述不停则每 ~500ms 一轮。冷却期内
   *  只记 dead 取证不再 reboot（skip cooldown），把风暴频率压到 2s 一轮；重连
   *  若成功（树长恢复增长）自然不再触发。 */
  let wdRebootAt = 0;
  const WD_REBOOT_COOLDOWN_MS = 2000;
  /** 🔴 v3.1.6：懒重连窗口（ms）。reboot 后这么久还没被 knock-back ⇒ 视图
   *  对齐成功（或会话已死），过期作废——别让陈年 flag 误伤后来的正常塌方。 */
  const WD_RECONNECT_WINDOW_MS = 2000;
  /** v3.1.6：reboot 已重建、正在等「下一个组字帧是否把树打回」的待重连标志。 */
  let wdReconnectPending = false;
  let wdReconnectTimer: ReturnType<typeof setTimeout> | null = null;
  /** 🔴🔴 v3.1.8：连续多少次 reboot 都没把组字帧救活（树长纹丝不动、无塌方可拦）。
   *  真机 v3.1.7 日志（19:35）钉死的新形状：锚点死亡但**没有掉幅**——每帧
   *  `upd len=122 d=0` 空转，塌方守卫无从拦；reboot 的「按峰值重建」是空操作
   *  （树已在峰值）⇒ ce+重建+新 cs 空转 26s，用户的话全在输入法串里没落地。 */
  let wdRebootFails = 0;
  /** 连续失败这么多次 ⇒ 懒重连升级为无条件 blur/focus（拆焦点赌视图对齐）。 */
  const WD_REBOOT_ESCALATE_AT = 2;
  let wdEscalateAt = 0;
  /** 升级重连冷却（ms）：拆焦点是重兵器，10s 内只来一次，防焦点风暴。 */
  const WD_ESCALATE_COOLDOWN_MS = 10000;
  /** 🔴🔴🔴 v3.2.0 组字心跳：组字串长过此阈值即合成 ce+重建（等价于用户点
   *  「完成」重开口述），把长组字切成短组字。依据：真机 7 次塌方全部发生在
   *  组字 >100 字时（tree:frag 实证塌方前后都是单 TextNode——打塌树的是
   *  浏览器/输入法自己的替换几何，与 Lexical 碎片无关）；用户分段口述
   *  （每段点完成 = 一次真实 ce+cs）从不触发。合成 ce 不杀 ASR 会话已有
   *  三份真机实证（reboot 后新 cs 照来、帧照落）。 */
  const COMPOSE_HEARTBEAT_AT = 80;
  /** 心跳冷却（ms）：口述速度 ~10 字/秒，80 字 ≈ 8s，冷却很少绑定。 */
  const COMPOSE_HEARTBEAT_COOLDOWN_MS = 5000;
  let wdHeartbeatAt = 0;
  let wdHeartbeatQueued = false;
  /** 🔴 v3.2.0：心跳阈值的运行时可写副本——探针 setHeartbeatAt 改写它，
   *  e2e 隔离各自机制用（关掉心跳钉撤稿/塌方形状，WD-E2E-11 专门钉心跳）。
   *  生产代码路径从不写它，恒为 COMPOSE_HEARTBEAT_AT。 */
  let wdHeartbeatThreshold = COMPOSE_HEARTBEAT_AT;
  /** 🔴🔴🔴 v3.1.6：懒重连——只有 knock-back 实锤（重建后组字帧真把树打回，
   *  宿主视图确实没对齐）才拆会话。blur 会 tear down 输入法连接、豆包识别
   *   会话当场死（用户 2026-10-12 真机日志实证：没点停止键也被掐断），
   *   所以默认不拆，给会话一次自愈机会。 */
  const wdReconnect = (): void => {
    if (!wdReconnectPending) return;
    wdReconnectPending = false;
    if (wdReconnectTimer != null) { clearTimeout(wdReconnectTimer); wdReconnectTimer = null; }
    recordFlight('wd:reconnect', 'blur/focus');
    editorHost.blur();
    setTimeout(() => { editorHost.focus(); }, 50);
  };
  /** 🔴🔴🔴 v3.2.0 组字心跳（排队一次 ce＋按模型重建）：把长组字切成短组字，
   *  让豆包的重识别永远够不到触发长度。只在组字**健康**时触发（未冻结、
   *  无恢复窗口）——塌方/空转的恢复期由各自的机制接管，心跳不插手。 */
  const queueHeartbeat = (): void => {
    if (wdHeartbeatQueued) return;
    if (wdFreeze || deferredTreeSyncTimer != null) return;
    if (Date.now() - wdHeartbeatAt < COMPOSE_HEARTBEAT_COOLDOWN_MS) return;
    wdHeartbeatQueued = true;
    setTimeout(() => {
      wdHeartbeatQueued = false;
      wdHeartbeatAt = Date.now();
      recordFlight('wd:heartbeat', 'ce+rebuild');
      clearSyntheticComposeTimer();
      // 合成 ce：Lexical 把当前组字文本提交为正文（树里已经有了，无内容变化）
      editorHost.dispatchEvent(new CompositionEvent('compositionend'));
      syntheticCompose = false;
      // 按模型重建：刷新 DOM 节点 + 让浏览器/输入法的文档视图对齐当前内容
      const doc = latestDocRef;
      if (doc != null) {
        ed.update(() => { docToLexical(doc); }, { tag: EGG_NOFX_TAG, discrete: true });
      }
    }, 0);
  };
  /** 🔴🔴🔴 v3.1.9/v3.2.0 取证：塌方机理调查——快照分两层（只记数量/长度/
   *  元素同异，绝不记内容）。真机 21:05 日志的模型层取证（tn=1 塌方前后单
   *  TextNode）排除了碎片理论，把矛头指向 **Lexical 对 DOM 元素的管理**：
   *  用户实证自带笔记/老版本同输入法长口述无恙，唯独本 App 出事 ⇒ 差异在
   *  本页的组字期 DOM 处理。本快照含 DOM 层：contenteditable 内的文本节点
   *  数量/长度＋首文本节点元素**是否与上次同一实例**（same=0 = 两次快照间
   *  DOM 元素被替换 = 浏览器组字区域被打断的机理实锤）。 */
  let lastFragFirstTextEl: Text | null = null;
  /** 上次快照的 DOM/模型长度差（div 转变时才记录——稀疏取证不刷屏）。
   *  真机 21:43 日志实锤：组字期 DOM 比模型多 1 个零宽字符（dom=1[55] vs
   *  tn=1[54]，塌方后 8 vs 7 差值恒定）——豆包重识别按含零宽的几何替换，
   *  文档当场塌掉。此差值何时出现/变化 = 机理时间线。 */
  let lastFragDiv = -999;
  const treeFragSnapshot = (force = false): string | null => {
    try {
      const rootEl = ed.getRootElement();
      if (rootEl == null) return null;
      const domLens: number[] = [];
      const domModes: number[] = [];
      let firstTextEl: Text | null = null;
      const walker = document.createTreeWalker(rootEl, NodeFilter.SHOW_TEXT);
      let t = walker.nextNode();
      while (t != null) {
        const content = t.textContent ?? '';
        domLens.push(content.length);
        // 零宽字符计数（U+200B/U+200C/U+200D/U+FEFF）
        const zw = (content.match(/[\u200b\u200c\u200d\ufeff]/g) ?? []).length;
        domModes.push(zw);
        if (firstTextEl == null) firstTextEl = t as Text;
        t = walker.nextNode();
      }
      const domTotal = domLens.reduce((a, b) => a + b, 0);
      const domSame = firstTextEl != null && firstTextEl === lastFragFirstTextEl;
      lastFragFirstTextEl = firstTextEl;
      const modelLens: number[] = [];
      const modelModes: string[] = [];
      let modelTotal = 0;
      ed.getEditorState().read(() => {
        const walk = (n: LexicalNode): void => {
          if ($isTextNode(n)) {
            const len = n.getTextContentSize();
            modelLens.push(len);
            modelModes.push(n.getMode());
            modelTotal += len;
            return; // TextNode 是叶子，不再下钻
          }
          if ($isElementNode(n)) for (const c of n.getChildren()) walk(c);
        };
        walk($getRoot());
      });
      const div = domTotal - modelTotal;
      const divChanged = div !== lastFragDiv;
      lastFragDiv = div;
      // div 未变化且元素未替换且非首次 ⇒ 不记录（稀疏取证）；force（塌方帧）例外
      if (!force && !divChanged && lastFragDiv !== -999 && domSame) return null;
      return `dom=${domLens.length}[${domLens.join(',')}] zw=[${domModes.join(',')}] same=${domSame ? 1 : 0} tn=${modelLens.length}[${modelLens.join('+')}] mode=[${modelModes.join(',')}] div=${div >= 0 ? '+' + div : div}`;
    } catch {
      return 'frag-err';
    }
  };
  // 🔴🔴 v3.0.11：组字态由输入事件流的 isComposing 驱动（见 onFlightBI / onComposeStartGuard）。
  //   豆包智能整理常只发 insertCompositionText、不发 compositionstart ⇒ v3.0.10 的守卫从不
  //   激活而漏拦。这里从 beforeinput 的 isComposing 抽出来，供 update 监听判定 composing。
  let lastBiIsComposing = false;
  // 🔴 上一篇的监听必须先解绑（见上面"为什么必须解绑"）。
  //   顺序不能反：先建新的再解旧的，中间那一瞬会没有任何门控。
  detachImeRef?.();
  const detachIme = imeGate.attach(editorHost);
  // 🔴 飞行记录器输入探针（v3.0.9 诊断版）：**capture 阶段被动监听**，
  //   只记事件名与数据长度，绝不 preventDefault / stopPropagation ——
  //   记录器本身不许成为新的"程序化动树"。与门控同生共死（同一个 detach）。
  const onFlightBI = (e: Event): void => {
    const ie = e as InputEvent;
    // 🔴 v3.0.13：bi 也记 comp= —— Android 宿主的 beforeinput.isComposing 是否
    //   可靠是从日志反推 ① 触发链的前提，没有这一位就只能靠猜（v3.0.12 栽过）。
    recordFlight('in:bi', (ie.inputType ?? '?') + ' comp=' + (ie.isComposing ? 1 : 0) + ' d=' + (ie.data == null ? '-' : String(ie.data.length)));
    // 🔴🔴 v3.0.11：从组字输入事件抽 isComposing，喂守卫激活（兜底 compositionstart 不发的情况）。
    //   insertCompositionText 且 isComposing=true ⇒ 正处组字中；其余类型 ⇒ 退出组字态。
    //   一旦捕获到跨段选区（全选替换），记进 multiBlock，极端塌方兜底之外的主判据路径才生效。
    if (ie.inputType === 'insertCompositionText') {
      lastBiIsComposing = !!ie.isComposing;
      if (lastBiIsComposing) {
        // 🔴🔴 v3.1.9 取证：豆包重识别的瞬间（组字串变短）= 塌方前夜——先记
        //   DOM 碎片结构（塌方前照），塌方判定帧处再记后照，前后对照即机理。
        //   注意放在 lastBiDataLen 更新**之前**（对比对象是上一帧的串长）。
        if (lastBiDataLen > 0 && ie.data != null && ie.data.length < lastBiDataLen) {
          const fragPre = treeFragSnapshot();
          if (fragPre != null) recordFlight('tree:frag', fragPre);
        }
        // 🔴🔴🔴 v3.0.18：组字串长度喂锚点死亡检测（update 监听空转判定用：
        //   组字串远长于文档但树长不动 = 写入全部空转）。
        lastBiDataLen = ie.data == null ? 0 : ie.data.length;
        // 🔴🔴🔴 v3.2.0 组字心跳：组字串过阈值即排队 ce＋重建——把长组字切成
        //   短组字，豆包的重识别永远够不到触发线（详见 COMPOSE_HEARTBEAT_AT 注释）。
        //   阈值可被探针改写（setHeartbeatAt）——e2e 隔离各自机制用，生产恒为默认。
        if (ie.data != null && ie.data.length >= wdHeartbeatThreshold) queueHeartbeat();
        // 🔴🔴🔴 v3.0.17：comp=1 组字帧到达 = 锚点活着 → 解冻（口述内容照常进
        //   模型）＋推迟重建到最后一次组字帧+窗口（原 v3.0.15/16 的「取消」在
        //   语音停顿场景失效：停顿超窗 → 定时器到期重建 → 杀锚点 → 后续口述空转）。
        //   v3.0.18：解冻决策移到 update 监听（树长增长证据），这里只推迟。
        holdDeferredTreeSync();
        // 🔴🔴 v3.0.12 治本：DOM 正在组字但 Lexical 内部未进入组字态（豆包只发
        //   insertCompositionText、不稳定发 compositionstart）⇒ 合成 compositionstart，
        //   让 Lexical 走全量插入路径，绕过孤儿 composition 分支（逐帧只读单锚点节点吞字）。
        if (ed.isComposing() !== true) {
          recordFlight('sel:orphaned', 'bi');
          ensureSyntheticComposeStart();
        }
        clearSyntheticComposeTimer();
        syntheticComposeTimer = setTimeout(ensureSyntheticComposeEnd, SYNTHETIC_COMPOSE_MAX_MS);
        if (!composeGuard.isMultiBlock) {
          const multi = ed.getEditorState().read(() => {
            const sel = $getSelection();
            if (!$isRangeSelection(sel) || sel.isCollapsed()) return false;
            const aTop = sel.anchor.getNode().getTopLevelElement();
            const fTop = sel.focus.getNode().getTopLevelElement();
            return !!aTop && !!fTop && aTop.getKey() !== fTop.getKey();
          });
          composeGuard.noteComposingInput(multi);
        }
      } else {
        // 🔴🔴 v3.0.14：comp=0 的 insertCompositionText = 孤儿组字帧（宿主报了
        //   组字输入类型却说不在组字态）。v3.0.13 真机日志里丢字发生在所有标记
        //   的盲区 —— 这类帧此前**零痕迹**。先留痕，再走退出组字态的老路。
        recordFlight('orphan0', 'd=' + (ie.data == null ? '-' : String(ie.data.length)));
        composeGuard.noteComposingInput(false);
        ensureSyntheticComposeEnd();
      }
    } else {
      lastBiIsComposing = false;
      // 🔴 v3.1.7：非组字的 beforeinput = 用户手动编辑（切键盘敲字/退格）。
      //   记进窗口标志——wd:sync 到期时若树长还没过峰值，这个标志是唯一允许
      //   skip 不重建的例外（手敲的是最新意图，峰值重建会抹掉它）。
      wdWindowManual = true;
      // 非组字输入（insertText / 回车 / 删除…）⇒ 收掉可能残留的合成态
      ensureSyntheticComposeEnd();
    }
  };
  const onFlightI = (e: Event): void => {
    const ie = e as InputEvent;
    recordFlight('in:i', (ie.inputType ?? '?') + ' comp=' + (ie.isComposing ? 1 : 0));
    // 🔴🔴 v3.0.12：input 也按 isComposing 反推（某些宿主 beforeinput 时序不稳定）。
    if (ie.isComposing === true) {
      if (ed.isComposing() !== true) {
        recordFlight('sel:orphaned', 'i');
        ensureSyntheticComposeStart();
      }
      clearSyntheticComposeTimer();
      syntheticComposeTimer = setTimeout(ensureSyntheticComposeEnd, SYNTHETIC_COMPOSE_MAX_MS);
    } else {
      ensureSyntheticComposeEnd();
    }
  };
  const onFlightCS = (): void => {
    syntheticCompose = false; // 真实 compositionstart 到了，交还，不再由我们维护
    recordFlight('in:cs', '');
  };
  const onFlightCE = (): void => {
    syntheticCompose = false;
    clearSyntheticComposeTimer();
    recordFlight('in:ce', '');
  };
  // 🔴🔴 v3.0.10：合成起止 → 喂守卫。compositionstart 时算选区是否跨多个顶层块
  //   （豆包整理=全选替换 ⇒ 跨段），并把当前正文本长度作为基准。compositionend
  //   清空 active，避免之后正常编辑被误判。两个都是 capture 被动监听，不拦截事件。
  const onComposeStartGuard = (): void => {
    // 🔴🔴🔴 v3.0.17：真实组字会话开始 = 锚点活着（或刚建立新锚点）。
    //   撤稿恢复的延迟树同步必须推迟 —— 否则「cs 先于第一帧 comp=1 到达」的
    //   间隙里定时器触发重建，会杀掉新组字锚点（同 v3.0.14 病灶）。
    holdDeferredTreeSync();
    syntheticCompose = false; // 真实 compositionstart 到了，交还，不再由我们维护
    const multi = ed.getEditorState().read(() => {
      const sel = $getSelection();
      if (!$isRangeSelection(sel) || sel.isCollapsed()) return false;
      const aTop = sel.anchor.getNode().getTopLevelElement();
      const fTop = sel.focus.getNode().getTopLevelElement();
      return !!aTop && !!fTop && aTop.getKey() !== fTop.getKey();
    });
    const len = docTextLen(lexicalToDoc(ed.getEditorState(), latestDoc.reminders ?? []));
    composeGuard.begin(multi, len);
    lastBiIsComposing = true;
    recordFlight('cmp:start', 'mb=' + (multi ? 1 : 0) + ' len=' + len);
  };
  const onComposeEndGuard = (): void => {
    syntheticCompose = false;
    clearSyntheticComposeTimer();
    composeGuard.end();
    lastBiIsComposing = false;
    recordFlight('cmp:end', '');
  };
  // 🔴🔴 v3.0.12 治本 —— 豆包语音只发 insertCompositionText、不稳定发 compositionstart
  //   ⇒ Lexical 内部 `isComposing()` 恒 false ⇒ 孤儿 composition 分支：逐帧只读单个 DOM
  //   锚点节点写回单个 TextNode，其余正文被吞（v3.0.11 诊断 DOM comp=1 但 editor composing=no）。
  //   我们在 **capture 相位**（早于 Lexical 挂在 editorHost 上的非 capture beforeinput 监听器）
  //   按 DOM `InputEvent.isComposing` 反推：当 DOM 正在组字、而 Lexical 内部还没进入组字态时，
  //   向 editorHost 合成派发 `compositionstart`，让 Lexical 走全量插入路径（绕过孤儿分支）。
  //   合成的 compositionstart 只在"我们反推出来"时发；真实 compositionstart 一到就交还（不重复、不冲突）。
  let syntheticCompose = false;
  let syntheticComposeTimer: ReturnType<typeof setTimeout> | null = null;
  // 组字静默超过此窗（豆包句间停顿）仍未收到新组字输入 ⇒ 收掉合成态，避免永不结束。
  const SYNTHETIC_COMPOSE_MAX_MS = 1500;
  const clearSyntheticComposeTimer = (): void => {
    if (syntheticComposeTimer !== null) {
      clearTimeout(syntheticComposeTimer);
      syntheticComposeTimer = null;
    }
  };
  const ensureSyntheticComposeStart = (): void => {
    if (syntheticCompose || ed.isComposing() === true) return;
    editorHost.dispatchEvent(new CompositionEvent('compositionstart'));
    syntheticCompose = true;
    recordFlight('cmp:synthed', 'start');
  };
  const ensureSyntheticComposeEnd = (): void => {
    clearSyntheticComposeTimer();
    if (!syntheticCompose) return;
    editorHost.dispatchEvent(new CompositionEvent('compositionend'));
    syntheticCompose = false;
    recordFlight('cmp:synthed', 'end');
  };
  // 🔴🔴 v3.0.12：关于页/菜单等外壳浮层关闭后，把焦点与失效选区归还编辑器
  //   （见 ota-ui.ts 的 onClose）。外壳节点（如关于页标题"关于 NoteSync"）在 editorHost
  //   之外；浮层打开期间原生 caret 可能停在外壳，关页不交还 ⇒ 后续输入落到编辑器外
  //   （v3.0.11 诊断 anchor=关于NoteSync、inEditor=no）。
  const reanchorSelection = (): void => {
    ed.update(
      () => {
        const root = $getRoot();
        const sel = $getSelection();
        if (sel && $isRangeSelection(sel)) {
          let n: LexicalNode | null = sel.anchor.getNode();
          let inRoot = false;
          while (n) {
            if (n === root) { inRoot = true; break; }
            n = n.getParent();
          }
          if (inRoot) return; // 有效选区不动
        }
        // 找到最后一个叶子文本节点，把 caret 重锚到其末尾
        let node: LexicalNode | null = root.getLastChild();
        while (node && $isElementNode(node) && node.getChildrenSize() > 0) {
          node = node.getLastChild();
        }
        if (node) node.selectEnd();
      },
      { discrete: true },
    );
  };
  // 🔴🔴🔴 命名纪律：这里**绝不能**叫 restoreEditorFocusOnClose —— 模块级已有同名守卫版
  //   （platform/touch.ts，带 CHIP_HOVER_OK：触屏关闭浮层不得聚焦编辑器，否则弹软键盘
  //   = 报障第 10 条）。若在内层重名会遮蔽守卫版，mountEditor 后续所有既有调用点
  //   （图片查看器/菜单/口令弹窗关闭）全部被劫持成裸 ed.focus() —— VVW-26 已实测红。
  const restoreFocusAndReanchor = (): void => {
    try {
      restoreEditorFocusOnClose(); // 模块级守卫版：非触屏才真正 focus
      // 🔴🔴 reanchor 必须以「焦点真的落回编辑器」为闸：selectEnd 会触发 Lexical commit
      //   把 DOM Selection 写回 contenteditable，Chromium 在那一步**隐式聚焦**编辑器 ——
      //   触屏上就是用户报障第 10 条的"关个弹窗键盘弹出"（VVW-26 已实测红）。
      //   焦点没还回来（触屏）就什么都不做；rebuild 场景的重锚已由 serialize.ts 兜底。
      const rootEl = ed.getRootElement();
      const host = rootEl ?? document.getElementById('editor-host');
      if (!host || !host.contains(document.activeElement)) return;
      reanchorSelection();
    } catch {
      /* focus 失败（如页面不可聚焦）不阻塞关页 */
    }
  };
  editorHost.addEventListener('beforeinput', onFlightBI, true);
  editorHost.addEventListener('input', onFlightI, true);
  editorHost.addEventListener('compositionstart', onFlightCS, true);
  editorHost.addEventListener('compositionend', onFlightCE, true);
  editorHost.addEventListener('compositionstart', onComposeStartGuard, true);
  editorHost.addEventListener('compositionend', onComposeEndGuard, true);
  detachImeRef = () => {
    detachIme();
    editorHost.removeEventListener('beforeinput', onFlightBI, true);
    editorHost.removeEventListener('input', onFlightI, true);
    editorHost.removeEventListener('compositionstart', onFlightCS, true);
    editorHost.removeEventListener('compositionend', onFlightCE, true);
    editorHost.removeEventListener('compositionstart', onComposeStartGuard, true);
    editorHost.removeEventListener('compositionend', onComposeEndGuard, true);
  };
  // 挂到模块级：三条回灌路径（setDoc / 对账回灌 / 提醒回灌）都要判它。
  imeGateRef = imeGate;
  // 补铺定时器句柄（IME 门控推迟标记回写后的最终一致兜底，见 update listener
  // 门控跳过分支的注释）。挂在 mountEditor 闭包内：它要读本篇的 latestDoc，
  // 换笔记重建编辑器时旧句柄随闭包一起废弃（destroy 侧不持有它也无所谓——
  // 到点后的 walk 读的是新的 root，旧笔记的 key 早已 detach，isAttached 挡住）。
  let strayMarkFlushTimer: number | undefined = undefined;

  // 🔴🔴🔴 链接可点：必须装官方 `registerClickableLink`（0.52 新增，@lexical/link）。
  //
  //   症状（探针 probe-link-nav-cause 实锤，零报错）：链接识别得好好的
  //   —— `<a href="https://example.com/" target="_blank" rel="noopener noreferrer">`
  //   齐活、computed color 金色、pointer-events auto，**点击事件也真的派发了**
  //   （document 冒泡阶段能收到、defaultPrevented=false），
  //   连原生 `a.click()` 都不产生导航、context 上也等不到新页面。
  //
  //   真因：可编辑的 contenteditable 里，原生 `<a>` 的默认导航被编辑器的
  //   "点击是放光标、不是跟随链接"语义压制。官方给的正解不是绕开它，而是
  //   **接管**：在 root 上挂 click/auxclick，主动 `window.open(url, '_blank')`
  //   并 `preventDefault()`（LexicalLink.dev.js:1310-1341）。
  //   少了它，链接就是"点亮但点不动"—— 而识别侧看起来完全正常，测试也全绿。
  //
  //   🔴 `newTab: true` 对齐本项目自己的 `target="_blank"`（linkify/apply.ts 逐字抄了
  //   老项目 index.html:3746），否则官方默认的 `_self` 会与节点上的 target 不一致 ——
  //   表现是"能点开但开在当前标签，笔记被导航走"。
  //   🔴 官方那个 `ClickableLinkExtension` 包装需要 `editor.use()`，而
  //   **0.52 的 LexicalEditor 上没有这个方法**（TS2339 直接报出来）⇒ 只能调底层。
  //   🔴 为什么不能自己写个 click 监听：编辑器里用户经常要选中链接文字改写，
  //   官方实现先判 `!selection.isCollapsed()` 才 preventDefault（选区非空时放行）。
  //   自己写通常会漏这个分支 ⇒ 想改链接却总被新标签抢走。
  //   反向判据见 test/e2e/19-link-click.test.js 的 LINK-E03。
  registerClickableLink(ed, namedSignals({ disabled: false, newTab: true }));

  // 🔴🔴 `tel:` 必须**从可点链接里摘出来单独处理**（用户报障第 1 条：
  //   「手机号在 PC 端不该点得动，只在移动端」）。
  //
  //   病根：`registerClickableLink` 对所有 `<a>` 一律 `window.open(url, '_blank')`
  //   （LexicalLink.dev.js:1310-1341）。对 https:// 这是对的；对 `tel:` 就成了
  //   **桌面端也去开一个新标签** —— 桌面上没有拨号处理器，开出来的是空白页/白闪一下。
  //   老项目不是这么做的：index.html:2789 走的是 `location.href = a.href`，
  //   移动端由系统接管拨号，桌面端浏览器没有 tel: 处理器 ⇒ 静默无事发生。
  //
  //   所以这里在**捕获阶段**拦下 tel: 点击（早于 registerClickableLink 的冒泡监听），
  //   触屏设备才真的发起拨号，桌面端直接吞掉。
  //
  //   🔴 为什么用捕获 + stopPropagation：两个监听都在 editorHost 上，
  //   捕获阶段先到，stopPropagation 后它那个冒泡监听就不会再跑 ⇒
  //   不会再有 window.open('tel:...', '_blank')。
  editorHost.addEventListener(
    'click',
    (e) => {
      const t = e.target as HTMLElement | null;
      const a = t?.closest?.('a[href^="tel:"]') as HTMLAnchorElement | null;
      if (!a) return;
      e.preventDefault();
      e.stopPropagation();
      // 🔴 触屏才拨号（老项目同款：location.href = ...）。
      //   桌面端什么都不做 —— 这正是用户要的"PC 端点不动"。
      if (isTouchDevice()) location.href = a.href;
    },
    true,
  );
  // 🔴🔴 行为注册必须在 setRootElement 之后、任何 update 之前。
  //   漏掉它 = 编辑器能显示但打不了字，且**零报错**（详见 behaviors.ts 文件头）。
  //   deps.uploadImage 指向 main.ts 里那**唯一**的上传入口，
  //   于是「选图 / 拖拽 / 粘贴」三条路共用同一份校验与提示。
  //   deps.hasOverlayOpen 是链接识别的遮罩守卫（老项目 index.html:3632 的
  //   `!remPanelOpen` 那一项）：面板开着时 lastTypeAt 可能被程序化回写，
  //   那种场景根本没有 typing，推迟会让标记晚 1.6s 才出现（老项目 e2e V545-1 实锤）。
  const behaviors = registerBehaviors(ed, {
    uploadImage: uploadImageFromFile,
    hasOverlayOpen: () => hasOverlayPanelOpen(),
    // 🔴🔴 把 IME 门控喂给链接识别：组字中 / 语音输入冷却期内**不许动树**。
    //   链接识别是把裸网址包成 LinkNode 的**增删节点**操作，与回灌、补铺同属
    //   "输入过程中的 DOM 手术"。Android 输入法靠 InputConnection 的文本视图定位，
    //   网页一改树视图就错位 ⇒ 输入法下一次提交按旧偏移操作 ⇒ 整段正文被替掉
    //   （用户报的"语音输入中突然只剩第一句"）。
    //   🔴🔴 v3.0.8：喂的是 canEditTree()（比 canApply() 更严）—— 除时间窗外还要
    //   躲开"整段改写会话窗口"（豆包「智能整理」大段删除后分批插入的间隙）。
    canEdit: () => (imeGate ? imeGate.canEditTree() : true),
  });
  // 🔴 自定义命令（插入折叠块等）也要注册。漏掉的表现是
  //   「菜单点了没反应、零报错」—— dispatchCommand 进了没有监听者的黑洞，
  //   与文件头behaviors.ts 记的 registerRichText 那条P0 是同一个形状。
  registerCommands(ed);

  // 🔴🔴 彩蛋词表触发（本次报障那条链路）：正文里敲 `/dragon`、`/pet`
  //   → 弹「进入 /dragon？」确认层 → 点「进入」直达游戏。
  //   **漏掉的后果就是用户报的那句话**：「在笔记正文输入『/dragon』『/pet』
  //   等菜单文字没有正常识别并可以进入」—— 且零报错（没有异常、没有 console）。
  //   为什么放这里而不是 ensureEggLayer()：那个函数是**懒建**的，
  //   而词表触发必须在编辑器 root 就绪的同一拍挂上；挂晚了用户已经敲完字了。
  //   为什么不用 ensureEggLayer 里的 bindTriggers：那条是**条件触发**
  //   （数字梗/烟花，跑在 update 真源文本上），与光标位置无关（见 layer.ts 注释）。
  ensureEggLayer()?.bindWordTrigger(editorHost);

  // 🔴🔴 v3.1.1 数字梗**组字补扫**（用户报障：安卓/拼音 IME 下敲 520/1314/666 不放动画，
  //   回车+退格才放；notesync 是例外——word-trigger 自带 compositionend 通道）。
  //   根因：数字梗扫描只挂在 update 监听器上，三道闸的第三道 `!ed.isComposing()`
  //   会把**组字提交帧**挡掉 —— 安卓键盘 setComposingText / 拼音组字下，提交那一刻
  //   Lexical 还在组字态；compositionend 之后不再有 update flush，于是组字路径的
  //   成梗永远没人扫。回车/退格走 Lexical 键盘命令路径（非组字）⇒ 能扫 ⇒ "回车+
  //   退格才爆"。E2E-E16 实锤：提交后 waitBurst 超时，中间断言（组字中不爆）绿。
  //   修法与 word-trigger 通道 2 同款：compositionend → setTimeout(0)
  //   （等 Lexical 清组字态、等最后一次 DOM 变更的 flush 收尾）→ 不在组字态才补扫。
  //   🔴 无条件补扫（不判文本真变）：被挡的那帧已经把 lastEggText 更新过了，
  //     再判真变恒 false —— 去重交给数字梗闩锁（gagFire 在梗态内不重复放），
  //     补扫与提交帧扫描撞车时第二次自动 no-op。
  editorHost.addEventListener('compositionend', () => {
    window.setTimeout(() => {
      try {
        if (!eggLayer || ed.isComposing()) return;
        scanEggTriggers(eggLayer);
      } catch {
        /* 氛围层：绝不把编辑流程带崩（同 scan 内 try/catch 纪律） */
      }
    }, 0);
  });

  // 🔴🔴 打字机音（老项目 index.html:6783-6878）。复古皮肤内才发声。
  //
  //   为什么挂在**这里**而不是 buildShell 那一段：三条输入通道必须绑在
  //   编辑器 root 就绪的**同一拍**（与词表触发同理）。挂晚了用户已经敲完字了，
  //   而症状是"复古皮肤里打字一点声音都没有"—— 零报错。
  //
  //   🔴 皮肤守卫做在 typewriter.ts 的**纯逻辑层**（三个闸门函数的第一行），
  //   这里传的 `skin` 只是那个判定的数据源；出环即静默是纪律，不是这里的 if。
  //
  //   🔴 发声复用 eggLayer.sound（唯一 AudioContext）。另造 ctx 会被浏览器限制，
  //   症状是"进游戏有音、打字没音"（见 sound.ts 的 Sound.type 注释）。
  const tyLayer = ensureEggLayer();
  if (tyLayer) {
    const tySound = tyLayer.sound;
    bindTypewriterSound(editorHost, {
      skin: () => currentSkin,
      play: (kind, force) => {
        const rang = tySound.type(kind, force);
        // 🔴 埋点只在**真的响了**时记：老项目是在 nsTypeSound 成功发声后
        //   nsEggUnlock('type')，静音/ctx 未解锁都不算"体验过打字机音"。
        //   反过来（先埋点后发声）会让图鉴在用户从没听见过声音时就解锁它。
        if (rang) markDiscovered(eggBrowserStore(), 'type', true);
        return rang;
      },
    });
  }

  // 🔴🔴 正文图片查看器 / 长按菜单接线（用户报障第 7 条后半段「移动端图片显示异常」）。
  //   漏掉的表现与"没实现"一模一样：样式表里 #nsZoom / #nsImgMenu 的规则全在
  //   （styles.css:1607-1670），但**没有一行 JS 建它们** ⇒ 死 CSS，
  //   手机上点图片没反应、长按也没反应，且**零报错**（探针实测 `{zoom:false, menu:false}`）。
  //   PC 端"正常"是因为 PC 一直就点不开，只是用户没在 PC 上试过长按。
  //
  //   为什么放这里而不是 uploadImageFromFile 里：图片是 DecoratorNode 渲染出的
  //   `<figure class="ns-img"><img></figure>`（nodes.ts:353），
  //   走事件委托挂一次就覆盖"新上传的"与"加载历史文档里的"两种来源。
  //   closeOverlay 传 restoreEditorFocusOnClose：关掉查看器/菜单后把焦点还给编辑器，
  //   否则在手机上关掉大图会留下"焦点在 body ⇒ 键盘行为诡异"的半死状态。
  bindImageViewer(editorHost, () => restoreEditorFocusOnClose());

  /* ---- 提醒层接线 ---- */
  // 🔴 对账必须发生在 docToLexical **之前**：对账会把提醒的 rem 标记挂到
  //   正文的 span 上，而序列化是按 span.rem 渲染下划线的。
  //   顺序反了 ⇒ 首屏正文没有下划线，要等下一次 update 才补上（闪一下）。
  const reconciled = reconcileReminders(initialDoc ?? emptyDoc());
  const initial = reconciled.doc;

  reminderRef?.destroy();
  reminderRef = new ReminderUI({
    getDoc: () => latestDoc,
    setDoc: (d) => {
      // 🔴🔴🔴 只写 reminders，**绝不整体替换文档**。
      //
      //   探针实测（zz-probe）：面板加提醒后 `编辑器文本 = ""`、真源 `{"v":1}`。
      //   根因是我原来写的 `docToLexical(d)` —— 它 `root.clear()` 后按 blocks 重建整棵树。
      //   而面板流程是「先 insertLine 插正文行、再 setDoc 写 reminders」，
      //   第二次调用把刚插进去的那一行**连同光标一起冲掉**，
      //   于是正文空、时间串消失，紧接着对账按「正文里找不到时间串」把提醒判死。
      //   净结果：面板正常收起、服务器确实收到了一次推送，**但什么都没存下来**，
      //   界面上零报错。这是本项目最危险的一类故障（看起来成功、实际丢数据）。
      //
      //   reminders 是**真源字段**，而 Lexical 树里只有 span.rem 标记、没有提醒列表，
      //   所以它天然是「树外」的数据：改它不需要动树。
      //   正确做法：先把新 reminders 记进 latestDoc，再让**下划线标记**由对账写回树里。
      latestDoc = d;
      // 🔴🔴 **这里刻意不挂 IME 门控**（曾挂过，随后撤掉 —— 记下来防止后人加回来）：
      //   这条 setDoc 是**用户主动**点提醒面板触发的（不是远端回灌），
      //   而用户点面板那一刻输入法组字必然已结束（点走本身就会blur）⇒ 门控恒放行。
      //   反过来，若在这里挂门控，一旦判定不放行就会**跳过 rem 标记回灌**，
      //   症状是"提醒加上了但正文没有下划线"，而真源是对的 ⇒ 用户反复点、反复不见。
      //   **门控只许挂在"用户没请求"的异步回灌路径上**（见 setDoc 与 poll 守卫）。
      // 立刻把 rem 标记铺到正文（对账只改标记，不动用户输入）
      const marked = reconcileReminders(d);
      latestDoc = marked.doc;
      editor?.update(
        () => {
          docToLexical(marked.doc);
        },
        { discrete: true },
      );
      // 🔴🔴🔴 远端合并/ 采纳远端 / 采纳本机之后，必须重排原生闹钟。
      //
      //   对应老项目三处调用点：
      //     index.html:5901（拍板「保留本机」后并入草稿）
      //     index.html:5939（拍板「使用远端」后并入草稿）
      //     index.html:7287（mergeRemoteReminders 合并远端提醒后）
      //   bj 没有那三个独立函数（草稿挂起机制是老项目特有的），
      //   但三者的**共同收口**就是 SyncDeps.setDoc —— 拉取、合并、
      //   冲突裁决后写回，全走它（sync/client.ts:284 / :422 / :440）。
      //
      //   🔴 为什么不能指望下面 1646 那行`rec.added/removed` 顺带覆盖：
      //   `reconcileReminders` 的 `added` **恒为 []**（reconcile.ts:162 写死），
      //   所以那行的判据实际只看 `removed`。**远端新增一条提醒时 removed 为空
      //   ⇒ schedule() 不被调用 ⇒ 原生闹钟停在旧列表**，
      //   而他端到点照响、这边不响，且界面上零报错。
      //   这正是"看起来正常、实际静默失效"那一类，必须在这里显式补。
      reminderRef?.schedule();
    },
    onPanelToggle: () => reminderRef?.togglePanel(),
    insertLine: (text) => insertRemLineToEditor(text),
    saveSelection: () => saveEditorSelection(),
    // 🔴 addReminder 兜底闸门拒掉过去时间时，老项目走顶部提示条说一句
    //   （index.html:7299 showUploadStatus('已过去的时间不能设提醒')）。
    //   不接这一条，被拒就是**完全静默** —— 用户点了"添加提醒"，界面毫无反应，像是坏了。
    onStatus: (kind, text) => showUploadNote(kind, text, 2200),
    // 🔴🔴 到点即重铺标记（用户拍板 2026-10-08「时间过了就画」）。done 是派生态，
    //   且老项目 v6.3 的删除线覆盖「时间+分隔+事项」整段 —— 事项段要等 markAll
    //   按 done 重新切分才会进真源，所以这里必须**重新对账 + 整篇重铺**，
    //   只把已有节点 setDone 摘不掉"事项段缺失"。
    //   ⚠️ 权衡：整篇重建在到点瞬间冲光标 —— 与老项目 fireReminder 到点重画
    //   同一风险（老项目没有 IME 门控照做），到点恰逢组字的概率低，接受。
    //   🔴 v3.0.9：到点重画同样是 docToLexical 整篇重建 —— 与回灌同级的树手术，
    //   也是此前**唯一不过门控**的整篇重建路径。现在有了 canEditTree（v3.0.8），
    //   顺手纳管：窗口内顺延 800ms 重试（与补铺同节奏；重试用当时的 latestDoc
    //   重新对账，不拿过期快照）。
    refreshDone: function refreshDoneImpl(): void {
      if (!ed) return;
      if (imeGate && !imeGate.canEditTree()) {
        recordFlight('gate:refreshDone', 'retry');
        window.setTimeout(refreshDoneImpl, 800);
        return;
      }
      recordFlight('tree:refreshDone', '');
      const rec = reconcileReminders(latestDoc);
      latestDoc = rec.doc;
      latestDocRef = rec.doc;
      ed.update(
        () => {
          docToLexical(latestDoc);
        },
        { discrete: true, tag: EGG_NOFX_TAG },
      );
    },
  });

  let latestDoc: Doc = initial;
  // 🔴 供 startSyncFor 的 initialDoc 用（见 mountDocSnapshot 的注释）。
  //   必须在 latestDoc 之后的**首屏内容**上取，不能等用户编辑过再取。
  mountDocSnapshot = initial;

  /**
   * 提醒标记的**补铺调度**（门控没开时顺延，不放弃）。
   *
   * 🔴🔴🔴 补铺是**树手术**，不是只读操作：它把已死的提醒标记节点
   *   `insertBefore` 挪出子节点后 `remove()` 掉 —— 这是真实的节点增删，
   *   会**重建受影响的 DOM 子树**。
   *
   *   在输入法（尤其**语音输入**）还在工作期间做这件事的后果不是"光标跳一下"：
   *   Android 输入法通过 `InputConnection` 的文本视图定位光标与组字区，
   *   网页一旦在输入过程中增删节点，那个视图就与真实 DOM 错位；
   *   输入法下一次 `commitText` / `deleteSurroundingText` 会按**旧偏移**操作
   *   ⇒ 整段正文被替换成它以为的那一小段 ⇒ 用户看到的
   *   「正在说话，突然后面的字全没了，只剩第一句」（或反过来只剩后两句）。
   *
   *   所以补铺必须过**与回灌同一道** IME 门控；不过闸就重新排队，
   *   绝不硬做（推迟一小会儿，标记迟早会铺上）。
   */
  const STRAY_FLUSH_RETRY_MS = 800;

  /**
   * 待回灌真源的**存活提醒 id 集合**（`setDoc` 被 IME 门控拦下时才非空）。
   *
   * 🔴🔴🔴 为什么补铺要认它、而不是只认 `latestDoc`：
   *   setDoc 承载「远端/合并结果」写回，被门控拦下时**回灌没落地** ⇒ 树里那条
   *   已被远端删掉的提醒下划线会一直挂着（用户看到的就是"提醒没删掉"）。
   *   而补铺的判死集合若取 `latestDoc.reminders`，那份还是**旧真源**（含该提醒）
   *   ⇒ 判定"还活着" ⇒ 一个都不摘 ⇒ 补铺空跑。**这正是残留缺口的本体。**
   *
   * 🔴🔴 为什么**不**顺手把 `latestDoc` 也改成待回灌的 `d`：
   *   树还是旧内容（含被远端删掉的那段正文）。一旦 latestDoc 先落账而树没跟上，
   *   用户下一次按键触发的 updateListener 会从**树**导出（把已删正文带回来）
   *   ⇒ 已删内容复活 —— 那是比"下划线残留"严重得多的数据分叉。
   *   所以：文本类的回灌**整轮推迟**（下一轮 poll/SSE 再落，base 也不推进，
   *   见 `imeCanEditTree` 的 P0-3 纪律），**只有"摘标记"这一件纯视觉的事**
   *   可以拿待回灌真源先做 —— 因为 unwrap 标记**不改变任何文本**。
   */
  let strayPendingLive: ReadonlySet<string> | undefined = undefined;

  const scheduleStrayMarkFlush = (delay: number, pendingLive?: ReadonlySet<string>): void => {
    // 🔴 后到的待回灌真源覆盖先到的：补铺要以**最新**那份远端事实为准，
    //   否则可能拿一份更旧的集合去摘，把刚被重新加回来的提醒又摘掉。
    if (pendingLive) strayPendingLive = pendingLive;
    if (strayMarkFlushTimer !== undefined) window.clearTimeout(strayMarkFlushTimer);
    strayMarkFlushTimer = window.setTimeout(() => {
      strayMarkFlushTimer = undefined;
      // 🔴 有"待回灌真源"时以它为准（见 strayPendingLive 的注释）；
      //   否则退回 latestDoc（既有 update 分支补铺路径，语义不变）。
      //   🔴 取完即清：这一次补铺落地后，该事实已兑现，不能让它污染后续轮次
      //   （后续轮次要么 setDoc 真落地了、latestDoc 已是新真源，要么又会有新的待回灌）。
      //   🔴 必须在门控检查**之前**取：顺延重试的那一轮也要带着它继续走。
      const pending = strayPendingLive;
      strayPendingLive = undefined;
      // 🔴 门控不开 ⇒ 顺延重试。用局部 imeGate（本次挂载那一个），
      //   不用模块级 imeGateRef —— 换笔记后旧挂载的门控不该影响新挂载。
      //   🔴🔴 v3.0.8：判 canEditTree()（补铺是树手术，还要躲整段改写窗口）。
      if (imeGate && !imeGate.canEditTree()) {
        recordFlight('gate:stray', 'retry');
        // 🔴 重试必须把待回灌真源**继续带下去**：上面已把它从 strayPendingLive
        //   取出并清空，这里不回传的话重试轮会退回 latestDoc（旧真源）⇒ 一个都摘不掉。
        scheduleStrayMarkFlush(STRAY_FLUSH_RETRY_MS, pending);
        return;
      }
      const live = pending ?? new Set((latestDoc.reminders ?? []).map((r) => r.id));
      const doomed: string[] = [];
      ed.update(() => {
        const walk = (n: LexicalNode): void => {
          if ($isReminderMarkNode(n)) {
            if (!live.has(n.remId)) doomed.push(n.getKey());
            return; // 标记节点是行内包裹层，不再下钻
          }
          if ($isElementNode(n)) for (const c of n.getChildren()) walk(c);
        };
        walk($getRoot());
      });
      if (doomed.length === 0) return;
      ed.update(() => {
        for (const key of doomed) {
          const n = $getNodeByKey(key);
          if (!n || !$isReminderMarkNode(n) || !n.isAttached()) continue;
          for (const c of n.getChildren()) n.insertBefore(c);
          n.remove();
        }
      }, { discrete: true });
    }, delay);
  };

  // 🔴 挂到模块级：`startSyncFor` 的 `setDoc` 要走这条补铺通道（见 strayFlushRef 的注释）。
  //   换笔记重建编辑器时这里会被重新指向新闭包（旧闭包随旧挂载一起废弃）。
  strayFlushRef = scheduleStrayMarkFlush;

  // 🔴 必须在 docToLexical 之前挂监听：initial 那一次 update 也要留下快照，
  //   否则首次 commit 之前 latestDoc 停在空文档，e2e 读到的是"从未提交过"的假象。
  /** 上一次扫描时的正文文本 —— 彩蛋「文本真变」那道闸的基准。 */
  let lastEggText = '';
  /** P1-13：`lastDocBytes` 的节流时间戳（见下面那处的注释）。 */
  let lastDocBytesAt = 0;
  ed.registerUpdateListener(({ editorState, tags }: { editorState: EditorState; tags?: Set<string> }) => {
    // 🔴 state.read() 回调外节点句柄失效 —— 整段导出必须在回调内部完成
    const before = latestDoc;
    // 🔴🔴🔴 导出基准的 reminders 必须来自 **latestDoc**（可能是刚被 setDoc 写进去的新值），
    //   不能来自"上一次提交时的旧值"，也不能来自任何缓存副本。
    //
    //   reminders 是**真源字段**，而 Lexical 树里只有 span.rem 标记，没有"提醒列表"这个概念
    //   —— 也就是说导出时必须由外部把这份列表喂进来。喂哪一份是这一行唯一的关键：
    //
    //   我第一版喂的是 `before`（= 上一次 update 结束时的 latestDoc），看着"稳"，实际：
    //     用户在面板点添加 → setDoc(新 reminders) → docToLexical → 触发本监听
    //     → 导出拿旧 reminders（空）→ 对账把新提醒判死 → latestDoc 回到空
    //   症状：面板正常收起、UI 一切正常，**只有提醒列表永远是空的**，零报错。
    //
    //   正确口径：latestDoc 是唯一真源快照，setDoc 已同步更新过它，
    //   所以直接用 latestDoc.reminders 即可。
    //
    // 🔴🔴 每次导出后**立刻对账**：用户改完正文，对账要马上算出提醒的增删，
    //   并把下划线 / 删除线挂回 span。漏了这一步的症状是"改了时间，提醒列表不变"，
    //   而界面上没有任何提示 —— 与"对账算错了"表现完全一样，极难自查。
    // 🔴🔴🔴 折叠标题回写：必须在**导出之前**把标题段落的实时文字同步回 __titleJson。
    //
    //   病根：FoldNode 的标题存在 `__titleJson` **字段**里，而导出侧 `nodeToBlock`
    //   **优先取 __titleJson**（注释写"权威"），只有它为空才回退到 children[0] 的文字。
    //   而 `setTitle()` 全项目只有 serialize.ts 反序列化时调用过 ——
    //   用户在标题行的任何编辑都**never**被写回 ⇒ 导出时仍按旧 title 走 ⇒ 改动被丢弃。
    //   症状：光标放进折叠标题、打字，真源一个字不变（老项目明确支持"改标题"，
    //   还专门用「第几处折叠」序号做身份，好让改标题不换身份）。
    //
    //   🔴 为什么不在**导出侧**改（我先试过，更差）：nodeToBlock 里把标题改从
    //   children[0] 取，会踩两个坑（属性测试 S3-21/S3-23 逐个抓出来）：
    //     ① 多 span 标题被压成一段；② 每个 span 的加粗/提醒标记属性丢失。
    //   「字段是权威」这个设计本身是对的（标题不是"块内的一个段落"，它是这个块的把手），
    //   所以正确做法是**让字段跟上编辑**，而不是让导出侧去猜。
    //
    //   判据：只改**文字**、保留原 span 属性；标题段落为空时不动字段
    //   （canonical 会省略空 title，硬写空串会让往返少字段）。
    // 🔴🔴🔴 折叠标题回写必须走**独立的 editor.update**，不能塞在下面那次
    //   editorState.read() 里 —— read() 拿到的是**冻结快照**，
    //   在里面 setTitle() 不产生新的 editor state，导出仍按旧 __titleJson 走。
    //   （实测：探针能看到标题文字已是「折叠块ZZZ」，而真源仍是「折叠块」——
    //     DOM 变了、模型没变，正是这个原因。）
    //   写回自身不引起无限循环：title 没变时 JSON 相同，直接跳过。
    ed.update(() => {
      for (const node of $getRoot().getChildren()) {
        if (!$isFoldNode(node)) continue;
        const head = node.getFirstChild();
        if (!head || !$isElementNode(head)) continue;
        const spans = nodesToSpans(head.getChildren());
        // 标题被清空 ⇒ 不动（保留占位「折叠块N」之类）
        if (spans.length === 0) continue;
        if (JSON.stringify(spans) !== node.titleJson) node.setTitle(spans);
      }
    });

    const exported = normalize(lexicalToDoc(editorState, latestDoc.reminders ?? []));

    // 🔴🔴🔴 v3.0.8「整段改写会话窗口」的**触发器**（豆包「智能整理/精炼润色」丢字）。
    //
    //   豆包的智能整理是一次「大段删除原文 → 静默（"识别优化中"）→ 分批插入整理稿」。
    //   删除与批次之间的静默可以远超 1.5s 活跃期与 4s 冷却期 —— 那时组字态早就
    //   结束，门控（canApply）按时间判定为"没在输入"，一切程序化动树都会放行。
    //   而 Android 输入法靠 InputConnection 的文本视图定位，只要我们在这段静默里
    //   动一次树（回灌/补铺/链接识别/折叠建组），视图就与 DOM 错位，它下一次
    //   commitText 按旧偏移操作 ⇒ 前面几段被整段替换（用户报障："只剩最后一段"）。
    //
    //   时间窗盖不住它 ⇒ 必须用**结构痕迹**触发：「这次 update 删掉了 ≥ 8 个字符」。
    //   这是真实发生在文档上的变化，不依赖"上一次输入是多久之前"这种采样。
    //   触发后开一个固定长度（BULK_REWRITE_MS=6s）的会话窗口，期间 canEditTree()
    //   恒 false，一切程序化动树顺延；6s 后必然放行（下轮轮询自动重试，推迟不排队）。
    //
    //   误触发（用户自己 Ctrl+A 重打 / 大段退格）的代价只是远端回灌推迟 6s ——
    //   用户此刻正在打字，本来也不该回灌；漏触发的代价是丢字（现状）。
    //   两害相权，判据宁可偏灵敏。
    //
    //   🔴 用 `before`（本次 update 前的 latestDoc）与 `exported`（本次 update 后
    //     从树导出的文档）比长度：两者都过了 normalize/对账前态，口径一致。
    //     在 **read 回调外**调 docTextLen（纯模型函数，与 editorState 无关）。
    // 🔴 取证核心（v3.0.9）：每次 update 记录导出的正文本长度与增量 ——
    //   丢字时间线的主动脉。长度在**单个**输入事件内塌掉 ⇒ Lexical 内部丢；
    //   被 tree:* 事件砸回去 ⇒ 程序化动树丢。nofx 标记区分程序化重建与用户输入。
    const prevLen = docTextLen(before);
    const newLen = docTextLen(exported);
    recordFlight(
      'upd',
      'len=' + newLen + ' d=' + (newLen - prevLen) + (tags && tags.has(EGG_NOFX_TAG) ? ' nofx' : ''),
    );
    if (prevLen - newLen >= BULK_DELETE_CHARS) {
      recordFlight('bulk', 'drop=' + (prevLen - newLen));
      imeGate?.noteBulkEdit();
    }

    // 🔴🔴🔴 v3.0.10 跨段组字串塌方守卫（豆包智能整理丢字根因修复）。
    //
    //   真因：insertCompositionText 走 Lexical 原生 $updateSelectedTextFromDOM，
    //   它只读 anchor 一个 DOM 节点的文本写回那一个 TextNode（见 compose-guard.ts）。
    //   跨段组字串被收进 anchor、其余段落 DOM 被浏览器移除时，正文被整段吞掉，
    //   单帧 116→19，全程零 tree:* / gate:* —— 四道 IME 门控都没触发。
    //
    //   判定：合成进行中（composing，由输入事件流的 isComposing 驱动，兜底
    //   editor.isComposing()；不再只靠 compositionstart，豆包智能整理常不发它）+
    //   单帧灾难性塌方（decideCollapseRestore）。命中即把真源回退到塌方前那帧
    //   `before`（= 上一帧的 latestDoc = 峰值健康正文），并重建树，避免把损坏
    //   状态写回真源 / 推到远端。`return` 跳过后续对账/回灌（那些都是基于损坏
    //   exported 的，不应在此帧执行；重建会触发下一帧正常走完）。
    //
    //   🔴 用 `before` 而非重新捕获峰值文本：before 就是塌方前最后一帧的健康
    //   真源，零额外开销、零内容泄漏（飞行记录器只记长度/哈希）。
    //   🔴 重建走 NOFX 标记：避免触发"整段改写会话窗口"把这次恢复又顺延掉。
    //
    //   🔴🔴 v3.0.11：composing 由输入事件流的 isComposing 决定（lastBiIsComposing，从
    //   beforeinput 的 insertCompositionText 抽到），并兜底 editor.isComposing()。
    //   豆包智能整理常不发 compositionstart，故不能只靠 begin() 激活 —— 否则守卫永不触发
    //   （v3.0.10 漏拦真因）。lastLen 每帧都在 observe 内维护，prevLen 始终为上一帧真实长度。
    const composing = lastBiIsComposing || ed.isComposing() === true;
    // 🔴🔴🔴 v3.0.16/18：观察窗内组字态下的写入（塌方延续帧——判定帧后 root.clear
    //   与插入分多帧 flush、或组字帧）= 锚点/组字还活着的证据 → 重置观察窗：
    //   组字死亡（compositionend/comp=0）后重新倒数，deferTreeLen 吸收
    //   延续帧树长，避免到期时把塌方自身的多帧过程误判成「树被外部改动」而 skip。
    //   🔴🔴🔴 v3.0.18：解冻决策移到这里（树长增长证据），onFlightBI 的 hold 只
    //   推迟。树长真涨了（组字写入成功）→ 解冻让模型=树（口述进模型）；树长
    //   不动且组字串远长于文档 → 锚点已死（宿主撤稿杀/僵尸组字），写入全空转
    //   → 保持冻结（peakDoc 不被残串覆盖）＋连续 4 帧记 wd:dead 取证。
    // 🔴🔴🔴 v3.0.19：空转检测**解耦延迟同步机制**（真机 v3.0.18 尾段实锤盲区）：
    //   判定帧（gate=30，ring 之外更早时段）触发延迟同步，1200ms 窗口到期 wd:sync
    //   重建收尾（timer=null）之后锚点再死 —— 组字帧全程空转（upd len=23 d=0
    //   冻结、组字串 d=153→169 增长 8.6s+、整段 400 条无任何 wd: 帧、synthed=0
    //   = Lexical 组字态整场 true 但锚点已没）。v3.0.18 检测挂在 timer!=null
    //   前提下，机制收尾后永远不跑。改为组字态下**全程监测**：composing &&
    //   组字串远长于文档 && 树长**纹丝不动**（连续 4 帧同值，防「追帧」误判：
    //   撤稿后锚点活着时全量替换逐帧追、树长帧帧在变）⇒ wd:dead 取证 +
    //   wd:reboot 自愈（强制 ce + 重建 latestDocRef），机制激活与否无关。
    if (composing) {
      const treeLenNow = ed.getEditorState().read(() => $getRoot().getTextContent().length);
      if (lastBiDataLen > treeLenNow + 12) {
        if (treeLenNow === stallPrevTreeLen) {
          stallCount += 1;
          if (stallCount === 4) {
            stallCount = 0;
            recordFlight('wd:dead', 'len=' + treeLenNow + ' d=' + lastBiDataLen);
            // 🔴🔴🔴 v3.0.18 自愈：锚点确认死亡（4 帧空转 + 组字串远长于文档）
            //   → 强制结束死会话（合成 compositionend，绕 ensureSyntheticComposeEnd
            //   的 syntheticCompose 闸——死会话可能是真 cs 开的）+ 重建
            //   latestDocRef（机制激活时=peakDoc 落账；未激活时=最新落账模型）。
            //   下一帧 comp=1 到达时 ed.isComposing()=false → 孤儿分支合成
            //   compositionstart → 新组字会话走全量插入路径 → 实时流自愈恢复
            //   （v3.0.12 已真机验证的恢复通道）。ce 的 commit 期间 wdFreeze
            //   若为 true 则模型不被残串覆盖；机制激活时 timer 保持活着（新会话
            //   再死可再次检出，组字静默则 wd:sync 到期兜底）。setTimeout：
            //   脱离当前 update flush 再派发 DOM 事件 / 动树，避免嵌套 flush。
            setTimeout(() => {
            const nowMs = Date.now();
            if (nowMs - wdRebootAt < WD_REBOOT_COOLDOWN_MS) {
              recordFlight('wd:reboot', 'skip cooldown');
              return;
            }
            wdRebootAt = nowMs;
            recordFlight('wd:reboot', 'reconn');
            wdRebootFails += 1;
            clearSyntheticComposeTimer();
            editorHost.dispatchEvent(new CompositionEvent('compositionend'));
            syntheticCompose = false;
            const doc = latestDocRef;
            if (doc != null) {
              ed.update(() => { docToLexical(doc); }, { tag: EGG_NOFX_TAG, discrete: true });
            }
            // 🔴🔴🔴 v3.0.20：宿主 InputConnection 视图错位对齐——真机 v3.0.19
            //   钉死：docToLexical 是程序化动树，宿主侧文档视图仍停留在 14 字
            //   残串状态，reboot 重建 111 后每个组字帧都按旧视图操作把树打回
            //   14（upd len=14 d=-97 每帧重复）。
            // 🔴🔴🔴 v3.1.6：但 blur/focus 不能再**无条件**执行——用户真机日志
            //   （2026-10-12 v3.1.5）钉死：blur 会拆掉 Android 输入法连接，
            //   豆包识别会话当场死（用户没点键盘停止键，之后说的话一句都进不来，
            //   「说着话被自动掐断」的感知真凶）。改为懒重连：reboot 只做
            //   ce＋重建，随后若组字帧真把树打回（视图确实没对齐，塌方守卫
            //   会再拦截）才在 collapse 判定处补 wdReconnect()；帧能落地
            //   （树长涨过峰值）则解冻处清 flag，会话活着、口述继续进。
            wdReconnectPending = true;
            wdReconnectTimer = setTimeout(() => {
              wdReconnectPending = false;
              wdReconnectTimer = null;
            }, WD_RECONNECT_WINDOW_MS);
            // 🔴🔴🔴 v3.1.8：**升级重连**——连续 reboot 救不活（树长纹丝不动、
            //   无塌方可拦的空转形状，真机 19:35 日志实锤）⇒ 懒重连升级为无条件
            //   blur/focus。此刻会话已事实死亡（用户的话一句不进），拆焦点的代价
            //   早就付了；赌的是宿主重新 extract 后视图对齐、后续口述能落地。
            //   10s 冷却防焦点风暴；已拆过就清掉懒重连 flag（别紧接着再拆一次）。
            if (wdRebootFails >= WD_REBOOT_ESCALATE_AT && nowMs - wdEscalateAt >= WD_ESCALATE_COOLDOWN_MS) {
              wdEscalateAt = nowMs;
              recordFlight('wd:escalate', 'blur/focus');
              wdReconnectPending = false;
              if (wdReconnectTimer != null) { clearTimeout(wdReconnectTimer); wdReconnectTimer = null; }
              editorHost.blur();
              setTimeout(() => { editorHost.focus(); }, 50);
            }
            }, 0);
          }
        } else {
          stallCount = 1;
        }
      } else {
        stallCount = 0;
      }
      // 🔴 v3.1.8：树长在变 = 组字帧在落地（reboot 救活了）⇒ 失败计数归零。
      //   纹丝不动才累计——喂给 wd:dead 之后的 reboot 升级判定（无塌方空转形状）。
      if (treeLenNow !== stallPrevTreeLen) wdRebootFails = 0;
      stallPrevTreeLen = treeLenNow;
      if (deferredTreeSyncTimer != null) {
        // 🔴🔴🔴 v3.0.18：解冻锚 = 会话峰值（deferPeakLen）。树长涨过基线不够——
        //   合成 cs 重开组字会话的锚点重建副作用能让树长 +1（WD-E2E-05 探针实测
        //   误解冻 → peakDoc 被残串覆盖）。涨过峰值才是组字恢复写入成功的真证据。
        if (treeLenNow > deferPeakLen) {
          wdFreeze = false;
          // 🔴 v3.1.6：组字恢复写入成功（涨过峰值）⇒ 懒重连窗口作废——宿主
          //   视图已对齐，会话活着，绝不拆。
          wdReconnectPending = false;
          if (wdReconnectTimer != null) { clearTimeout(wdReconnectTimer); wdReconnectTimer = null; }
        }
        armDeferredSync();
        recordFlight('wd:defer', 'reset len=' + deferTreeLen);
      }
    }
    const collapse = composeGuard.observe(newLen, composing, lastBiDataLen);
    if (collapse.restore) {
      recordFlight('gate:collapse', collapse.reason + ' prevLen=' + prevLen);
      // 🔴🔴 v3.1.9 取证：塌方落地后的 DOM 碎片结构（对照 beforeinput 时刻的前照，
      //   前后差值 = 豆包重识别打塌树的机理证据）。塌方帧强制记录。
      const fragAtCollapse = treeFragSnapshot(true);
      if (fragAtCollapse != null) recordFlight('tree:frag', fragAtCollapse);
      // 🔴🔴 v3.1.6 懒重连：reboot 重建后第一个组字帧就把树打回 ⇒ 宿主视图
      //   确实没对齐（v3.0.19 震荡形状实锤）⇒ 补 blur/focus 重连。反之帧能
      //   落地（树长涨过峰值）时 flag 在解冻处清除，会话活着不拆。
      if (wdReconnectPending) {
        setTimeout(() => { wdReconnect(); }, 0);
      }
      latestDoc = before;
      latestDocRef = before;
    // 🔴🔴🔴 v3.0.16：与 wd restore（v3.0.15）同款——**绝不能在这里立即
    //   docToLexical 重建**。v3.0.15 真机日志钉死：撤稿/塌方判定后浏览器侧
    //   组字常常还活着（synthed=0、comp=1 每帧都来），立即重建杀死组字锚点
    //   ⇒ 后续组字帧全部模型空转（upd len=5 d=0 冻结、组字串 d=260→279
    //   增长 6.4s+，用户继续口述一字进不了文档）。v3.0.15 只修了 wd 路径
    //   （真机 gate=24 = collapse 17 + wd 7）——**collapse 路径的 17 次立即
    //   重建仍在杀锚点**（豆包重识别修订的大幅掉幅帧 comp=1 走 collapse、
    //   此时组字活着）。改为同款延迟同步：600ms 内 comp=1 组字帧 ⇒ 取消
    //   （锚点未破坏，输入法全量串替换让文档追上组字串）；超时 ⇒ 组字真死，
    //   重建 before 安全（塌方前内容上屏兜底）。
    // 🔴🔴 v3.1.5：锚取**会话峰值** max(prevLen, 水位线会话峰值)，不再裸传
    //   帧间 prevLen——注意调用点的 prevLen 是**模型相对**长度（docTextLen(before)）：
    //   有冻结保护时它=峰值（没问题），但**渐进放血**形状（多跳小步缩水都没过
    //   阈值、组字串同步变短不拦 ⇒ 模型被残串逐帧覆盖、无冻结）下它已远低于
    //   会话峰值 ⇒ 裸传会把解冻锚蚀到放血后的模型长，残串一涨过它就解冻，
    //   峰值与放血前内容一起丢。水位线会话峰值（withdrawGuard.peak）才是
    //   v3.0.18 定的锚：「树长涨过会话峰值才算组字恢复写入成功」。
    //   （scheduleDeferredTreeSync 里的 max 是第二道闸：延迟同步已激活时
    //   只涨不跌，防将来别的调用方传低值。）
    const sessionPeak = Math.max(prevLen, withdrawGuard.peak);
    scheduleDeferredTreeSync('peak=' + sessionPeak + ' cur=' + newLen, sessionPeak);
    return;
    }
    // 🔴🔴 v3.0.12：组字中本帧"部分欠插"（未达到塌方阈值）也量化，确认合成
    //   compositionstart 后是否仍有丢字（真机靠飞行记录器回传验证治本成效）。
    if (composing && prevLen - newLen > 0) {
      recordFlight('compose:drop', 'd=' + (prevLen - newLen) + ' newLen=' + newLen);
    }
    // 🔴🔴🔴 v3.0.14：组字会话水位线（撤稿吞字守卫）。同一 composing 口径喂帧；
    //   会话结束帧（composing 转假）判撤稿：真源比会话峰值掉超 max(12, 15%) ⇒
    //   回写峰值帧文档。与塌方守卫互斥：collapse 已恢复的本帧走不到这里
    //   （上面 return 了）；恢复帧自身 composing=false 且无会话 ⇒ 幂等不循环。
    //   此时组字已结束，重建不再杀活组字，与输入法无对抗。
    const wd = withdrawGuard.observe(newLen, composing, prevLen, exported);
    if (wd.restore) {
      recordFlight('gate:withdraw', wd.reason);
      const peakDoc = wd.doc as Doc;
      latestDoc = peakDoc;
      latestDocRef = peakDoc;
      // 🔴🔴🔴 v3.0.15：**绝不能在这里立即 docToLexical 重建**。v3.0.14 真机日志
      //   （wd=2 + 尾段 len=9 d=0 冻结、组字串 d=192→208 仍在增长）实测：撤稿后
      //   浏览器侧组字常常还活着（comp=1 每帧都来），立即重建会**杀死组字锚点**
      //   —— Lexical 组字键指向已销毁节点，后续每帧组字变成模型空转，用户继续
      //   口述的字一个都进不了文档。改为「模型先落账、树延迟同步」：
      //     600ms 内 comp=1 帧恢复 ⇒ 取消树同步（锚点从未被破坏，输入法的全量
      //       串替换会让文档自动追上组字串，口述继续落地）；
      //     超时仍无组字帧 ⇒ 组字真死了，此时重建安全（回写峰值内容上屏）。
      scheduleDeferredTreeSync('peak=' + wd.peakLen + ' cur=' + wd.currentLen, wd.peakLen);
      return;
    }

    const rec = reconcileReminders(exported);
    // 🔴🔴🔴 v3.0.16：延迟同步窗口内冻结「树→模型」常规同步 —— 塌方/撤稿判定
    //   落账的 before/peakDoc 绝不能被紧跟着的残留短串帧覆盖（探针实测：塌方
    //   第二帧 len=7 覆盖落账 ⇒ wd:sync 重建残串，峰值照样丢）。冻结在 cancel
    //   （组字恢复，模型=树=组字串，新口述优先）或 wd:sync（重建完成）时解除。
    if (!wdFreeze) {
      latestDoc = rec.doc;
      // 🔴 诊断面板的真源引用（见 latestDocRef 的注释）。必须在对账**之后**赋值：
      //   对账可能增删提醒，赋早了会让诊断第 8 组的 rem/future 少算刚变动的那几条。
      latestDocRef = rec.doc;
    }
    // 🔴🔴 P1-13：这一行是**纯诊断**（全仓无消费方，只留给人工排查），却每个
    //   update 都跑一次 `JSON.stringify` 全文档 —— 5000 字约 0.3ms/键，
    //   中端安卓 ×5 就吃掉按键预算的一大块，而它**对生产没有任何作用**。
    //   节流到 250ms：语义不变（它本来就是"最近一次文档字节数"，不是逐帧值），
    //   热路径这笔序列化税直接省掉。
    const bytesNow = Date.now();
    if (bytesNow - lastDocBytesAt >= 250) {
      lastDocBytesAt = bytesNow;
      shellRoot.dataset.lastDocBytes = String(new TextEncoder().encode(JSON.stringify(latestDoc)).length);
    }

    // 对账可能改了 rem 标记（正文没变但标记变了）→ 此时必须把结果写回编辑器，
    //   否则下划线永远不显示。判据是 canonical 不等：写回自身不会引起无限循环，
    //   因为第二次对账拿到已带标记的文档，算出的结果与自身相同。
    // 🔴🔴🔴 回灌守卫③：IME 门控（用户报障第 7 条的第二半）。
    //
    //   这一处是**用户报障原文「打字的时候换行被吞」最直接的那条路径**：
    //   registerUpdateListener 每一次 update 都跑（零 debounce），跑完立刻对账，
    //   只要对账算出标记有变化就`docToLexical` **整篇重建**。
    //   而 update 的来源包括：用户自己在打字 ⇒ 对账与用户输入**夹在同一帧**，
    //   组字中的拼音串会被 root.clear() 连同选区一起冲掉。
    //
    //   🔴🔴 判据是 `canonicalize(rec.doc) !== canonicalize(exported)`
    //     （正文真变了）而不是"标记变了"：
    //     用户自己敲的字变了正文⇒ 门控拦下的是**回灌**，不是他刚敲的字
    //     （latestDoc 已经写好了，见上面那行），所以他的输入**一个字都不会丢**，
    //     只是标记这次不铺，等下一次允许回灌时补上。
    //     这条区分极其重要：判据放宽成"标记变了也拦"会把用户正常打字也拦掉。
    if (canonicalize(rec.doc) !== canonicalize(exported)) {
      // 🔴🔴 v3.0.8：判 canEditTree() —— 标记重铺（局部或整篇）都是树手术，
      //   在"整段改写会话窗口"内同样必须让路（顺延走补铺重试通道）。
      if (imeGateRef && !imeGateRef.canEditTree()) {
        recordFlight('gate:upd', 'rw-deferred');
        // 🔴 跳过铺标记，**但 schedule() 与 noteEdit() 照旧要走**
        //   （它们在下面）：提醒的增删是真源事实，不该被门控拦住。
        //
        // 🔴🔴🔴 补铺（用户报障 2026-10-08「删掉时间串里的分钟，提醒没自动删」）：
        //   真源这一轮已经判死（latestDoc = rec.doc），但标记层回写被门控推迟——
        //   不补铺的话，正文里那条下划线要**残留到下一次用户编辑**才被冲掉，
        //   症状正是"提醒没删掉"（用户看到的是下划线还在）。老项目没有这层问题：
        //   它是输入后同轮重画（纯 DOM span 重写），从不受门控约束。
        //   补铺只做**点状摘除**（unwrap 树里 remId 已不在真源 reminders 的标记节点），
        //   不整篇重建：别的块一个节点都不碰，光标在被摘标记内的 TextNode
        //   随 key 存活（insertBefore 移动不换 key）。幂等：已清时 walk 空跑。
        // 🔴 补铺一律走 `scheduleStrayMarkFlush`（它内部过 IME 门控并顺延），
        //   **不要**在这里直接 setTimeout —— 那样会在输入法还在工作时下刀。
        scheduleStrayMarkFlush(TYPE_ACTIVE_MS + 150);
      } else {
        // 🔴🔴🔴 **局部重写**（用户拍板 B 的后半段），替掉原来的整篇 docToLexical。
        //
        //   `exported` 是**对账前**的形态（直接从当前 Lexical 树导出），
        //   `rec.doc` 是对账后 —— 两者纯文本逐字相等，只有 span.rem 不同
        //   （reconcile 的 markAll 只写 span.rem，见 reminder/reconcile.ts:191）。
        //   ⇒ 指纹不同的块就是"标记真的需要重铺"的块，其余块**一个节点都不碰**。
        //
        //   为什么必须局部：docToLexical 是 root.clear() + 整篇重建，
        //   而 updateListener 零 debounce ⇒ 用户每敲一个字就可能销毁全文 DOM。
        //   长文档里加一条提醒，原本要重建全文，现在只碰 1 个块。
        //   这与 ime-gate 是**串联**的两道闸：门控挡"组字中"，局部挡"改动面积"。
        const before = blockFingerprintsOf(exported);
        const after = blockFingerprintsOf(rec.doc);
        const plan = planLocalMarkRewrite(before, after);
        const path = chooseRewritePath(plan, before.length);
        if (path === 'full') {
          // 🔴 块数变了 / 或者**每一块都要改**（短文档上局部并不划算，
          //   而且此时下标对齐也失去意义）⇒ 老老实实整篇重建。
          //   这是性能回退，不是正确性回退。
          recordFlight('tree:rw', 'full blocks=' + before.length);
          const snapshot = latestDoc;
          ed.update(() => {
            docToLexical(snapshot);
          }, { discrete: true, tag: EGG_NOFX_TAG });
        } else if (path === 'local') {
          const snapshot = latestDoc;
          const idx = plan.rebuild;
          recordFlight('tree:rw', 'local n=' + idx.length);
          ed.update(() => {
            // 🔴 逐块 replace：Lexical 会复用未变的兄弟节点，
            //   光标/选区/折叠状态在**别的块**上原封不动。
            //   replaceBlocksAt 越界会抛（不静默跳过），异常会冒到
            //   update listener 外 —— 由 ed 自己的错误处理兜住，不会静默失败。
            replaceBlocksAt(snapshot, idx);
          }, { discrete: true, tag: EGG_NOFX_TAG });
        }
      }
    }

    // 对账报出的增删要通知 UI：新增的排进调度，删掉的从调度里消失
    if (rec.added.length > 0 || rec.removed.length > 0) reminderRef?.schedule();

    // 🔴🔴 彩蛋条件触发（数字梗 / notesync 烟花）—— **三道闸，缺一不可**：
    //   1. `tags`：程序化重建（初始装载 / 远端回灌 / 提醒到点）不放动效 ——
    //      老项目这些路径根本没有 input 事件；少了它，"打开一篇本来就有 1314
    //      的笔记"一进去就炸一次。
    //   2. 文本真变：**纯选区变化（只是点一下光标）也会进 update listener**，
    //      少了它，"把光标点到已有的 1314 后面"会误爆。
    //   3. 组字中：拼音尾巴是数字会误判（老项目 index.html:5417 同款守卫）。
    //   🔴 基准仍是**已提交的真源**，不是按键事件 —— 按键时输入法在组字，拿到的是半截文本。
    const eggText = latestDocText();
    const eggTextChanged = eggText !== lastEggText;
    lastEggText = eggText;
    if (eggLayer && eggTextChanged && !(tags && tags.has(EGG_NOFX_TAG)) && !ed.isComposing()) {
      scanEggTriggers(eggLayer);
    }

    // 🔴 只有内容真变了才推。
    //   少了这个判断：docToLexical 的首次 update、以及 merge 把远端内容写回来时，
    //   都会触发一次"编辑"，于是**刚拉下来的内容立刻被推回去** ——
    //   两台设备会互相回声，永不停歇，且服务端被打满。
    if (canonicalize(latestDoc) !== canonicalize(before)) {
      syncRef?.noteEdit();
      // 🔴 v3.1.1 取证：草稿写入进飞行记录器（带 tag），「云端版顶掉离线草稿」类故障可查。
      recordFlight(
        'draft:save',
        'len=' + canonicalize(latestDoc).length + ' tag=' + (tags ? [...tags].join(',') : '-'),
      );
      // 🔴 离线草稿（v3.1.1）：与 noteEdit **同一条件**——只在用户内容真变时记。
      //   远端回灌走 setDoc，进来时 latestDoc 已被更新，before == latestDoc
      //   ⇒ 不进这个分支，不会给"云端刚写下来的内容"白记一份草稿。
      //   草稿条挂起期间 saveDraft 内部直接短路（draft.ts 红线：pending 不写）。
      saveDraftForNote(name, latestDoc);
    }
  });

  ed.update(() => docToLexical(initial), { discrete: true, tag: EGG_NOFX_TAG });

  // 🔴🔴 首屏跑一轮链接识别（老项目 index.html:3471 `if (note.ct) linkifyEditor()`）。
  //
  //   为什么必须显式跑：延迟链路只由 `beforeinput` 触发（打字）。
  //   而**打开一篇已有笔记时用户一个字都没敲** —— 正文里那些裸网址
  //   （老项目迁移过来的真源就是这个样子）不会因为"没人打字"而自动变链接。
  //   漏这一句的症状极具迷惑性：新建笔记里敲网址链接会亮，
  //   但打开旧笔记全是裸文本 —— 用户会以为是"同步没同步过来"。
  //
  //   顺序：必须在上面那次 docToLexical **之后**（树里要有内容才有意可识别），
  //   且在 window.__NOTESYNC_DOC__ 挂载**之前**（让 e2e 读到的是已识别的真源）。
  //   runNow 内部自己 editor.update，不与外层事务嵌套。
  behaviors.linkifyNow();
  // 🔴 挂到模块级：那三条「换真源」的路径要用（见 linkifyNowRef 的注释）。
  //   卸载时随 editor 一起重建，所以这里覆盖赋值而不是 push。
  linkifyNowRef = behaviors.linkifyNow;

  // 暴露真源读取口。**这不是调试后门**：S5 的加密入口、S4 的自动保存、
  // 以及 e2e 的「输入是否真进了真源」判据都走它，是正式接口的一部分。
  window.__NOTESYNC_DOC__ = (): Doc => structuredClone(latestDoc);
  window.__NOTESYNC_EDITOR__ = ed;
  // 🔴 v3.0.10 合成塌方守卫 e2e 驱动钩子（正式接口，仅用于驱动真实 update 监听）。
  //   桌面无法复现 Android InputConnection 的原生塌方，这条用真实 compositionstart
  //   事件 + 真实 ed.update 塌方，验证守卫确实在 update 监听里把真源回退。不含内容。
  window.__NOTESYNC_COMPOSE_TEST__ = {
    start: (): void => {
      editorHost.dispatchEvent(new CompositionEvent('compositionstart'));
    },
    collapse: (short: string): void => {
      ed.update(() => {
        const root = $getRoot();
        root.clear();
        const p = $createParagraphNode();
        p.append($createTextNode(short));
        root.append(p);
      });
    },
    // 🔴🔴 v3.0.11 回归钩子：模拟豆包智能整理「只发 insertCompositionText、不发 compositionstart」
    //   的真实入口。先喂一个 isComposing=true 的 beforeinput（让 onFlightBI 把守卫激活），
    //   再真实 ed.update 塌方。若守卫仍只靠 compositionstart 激活（v3.0.10 的缺陷），这条会红
    //   —— 塌方后真源不回退、飞行日志无 gate:collapse。
    collapseNoStart: (short: string): void => {
      editorHost.dispatchEvent(
        new InputEvent('beforeinput', {
          inputType: 'insertCompositionText',
          data: short,
          isComposing: true,
          bubbles: true,
        } as InputEventInit),
      );
      ed.update(() => {
        const root = $getRoot();
        root.clear();
        const p = $createParagraphNode();
        p.append($createTextNode(short));
        root.append(p);
      });
    },
    // 🔴🔴 v3.1.5 回归钩子：模拟真机 v3.1.4 日志钉死的**第二跳漏拦形状**——
    //   组字串远长于树（宿主替换区域错位/锚点死亡：串还在、树丢了），而帧间
    //   掉幅很小（真机 21→9，drop=12<absDrop 且 prevLen=21<minPrev，两个早退
    //   把 v3.1.3 的 mismatch 分支闷死）。beforeinput 带长组字串（compLen 字），
    //   真源同时塌到 shortLen 字。与 collapseNoStart 的差别就在 compLen≠shortLen。
    collapseMismatch: (shortLen: number, compLen: number): void => {
      editorHost.dispatchEvent(
        new InputEvent('beforeinput', {
          inputType: 'insertCompositionText',
          data: 'x'.repeat(compLen),
          isComposing: true,
          bubbles: true,
        } as InputEventInit),
      );
      ed.update(() => {
        const root = $getRoot();
        root.clear();
        const p = $createParagraphNode();
        p.append($createTextNode('x'.repeat(shortLen)));
        root.append(p);
      });
    },
    // 🔴🔴 v3.0.14 回归钩子：模拟豆包语音的**组字增长帧**——comp=1 的
    //   beforeinput（全量组字串替换）+ 真源整串替换到 n 字。喂水位线会话。
    growTo: (n: number): void => {
      editorHost.dispatchEvent(
        new InputEvent('beforeinput', {
          inputType: 'insertCompositionText',
          data: 'x'.repeat(n),
          isComposing: true,
          bubbles: true,
        } as InputEventInit),
      );
      ed.update(() => {
        const root = $getRoot();
        root.clear();
        const p = $createParagraphNode();
        p.append($createTextNode('x'.repeat(n)));
        root.append(p);
      });
    },
    // 🔴🔴 v3.0.14 回归钩子：模拟**撤稿帧**——comp=0 的 insertCompositionText
    //   （宿主撤稿形状：组字输入类型但 isComposing=false）+ 真源被啃到 n 字。
    //   组字态转假 ⇒ 水位线会话结束 ⇒ 守卫应判撤稿并回写峰值帧。
    withdrawTo: (n: number): void => {
      editorHost.dispatchEvent(
        new InputEvent('beforeinput', {
          inputType: 'insertCompositionText',
          data: 'x'.repeat(n),
          isComposing: false,
          bubbles: true,
        } as InputEventInit),
      );
      ed.update(() => {
        const root = $getRoot();
        root.clear();
        const p = $createParagraphNode();
        p.append($createTextNode('x'.repeat(n)));
        root.append(p);
      });
    },
    // 🔴🔴 v3.0.12 回归钩子：验证"只发 insertCompositionText（isComposing=true）、
    //   不发真实 compositionstart"时，我们按 isComposing 反推并合成 compositionstart，
    //   使 Lexical 内部 isComposing() 置位（绕过孤儿 composition 分支的治本路径）。
    //   返回 ed.isComposing()：修复前恒 false（红），修复后应为 true（绿）。
    probeSynthCompose: (): boolean => {
      editorHost.dispatchEvent(
        new InputEvent('beforeinput', {
          inputType: 'insertCompositionText',
          data: '语音测试',
          isComposing: true,
          bubbles: true,
        } as InputEventInit),
      );
      const composing = ed.isComposing() === true;
      // 探针用完即复位，避免污染后续断言
      editorHost.dispatchEvent(new CompositionEvent('compositionend'));
      return composing;
    },
    end: (): void => {
      editorHost.dispatchEvent(new CompositionEvent('compositionend'));
    },
    // 🔴🔴🔴 v3.0.18 回归钩子：模拟**锚点死亡后的空转帧**——comp=1 组字帧
    //   持续到达（组字串 dLen 远长于文档）但写入全部空转（树长纹丝不动）。
    //   真机 Android 宿主专属形状：宿主撤稿杀锚点后，组字 reconciliation
    //   每帧 flush（upd len=8 d=0）却找不到锚点节点可写。桌面合成 beforeinput
    //   不产生 update flush（探针实测：只有 wd:hold、无重置分支帧）——
    //   markDirty 制造「有 flush 但树长不变」的等价形状，喂锚点死亡检测
    //   （连续 4 帧 ⇒ wd:dead 取证 + wd:reboot 自愈）。
    stallBi: (dLen: number): void => {
      editorHost.dispatchEvent(
        new InputEvent('beforeinput', {
          inputType: 'insertCompositionText',
          data: 'y'.repeat(dLen),
          isComposing: true,
          bubbles: true,
        } as InputEventInit),
      );
      ed.update(() => {
        $getRoot().markDirty();
      });
    },
    // 🔴 v3.0.18 只读探针：ed.isComposing() 当前值（死会话是否被 reboot 强制结束）。
    probeComposing: (): boolean => ed.isComposing() === true,
    // 🔴 v3.2.0：心跳阈值运行时改写（e2e 隔离机制用）。生产路径从不调用。
    setHeartbeatAt: (n: number): void => {
      wdHeartbeatThreshold = n;
    },
    flightLines: (): string[] => flightLines(),
    guardActive: (): boolean => composeGuard.isActive,
    treeTextLen: (): number => ed.getEditorState().read(() => $getRoot().getTextContent().length),
  };
  window.__NOTESYNC_INSERT_FOLD__ = () => {
    if (ed) insertFoldAtCaret(ed);
  };
  // 🔴 选区定位钩子。**正式接口**，不是调试后门 —— 理由见Window 类型声明处的注释。
  //   e2e 靠它把光标准确放进"折叠标题末尾/正文开头/块外"，
  //   因为设 DOM 选区不会同步到 Lexical 内部选区（那样按键根本不进来）。
  if (ed) {
    window.__NOTESYNC_CARET_FOLD_TITLE_END__ = (offset?: number) => placeCaret(ed, 'fold-title-end', offset);
    window.__NOTESYNC_CARET_FOLD_BODY_START__ = () => placeCaret(ed, 'fold-body-start');
    window.__NOTESYNC_CARET_AFTER_BLOCKS__ = () => placeCaret(ed, 'after-blocks');
  }
  // 🔴 复用生产代码那份 canonicalize，不给测试第二份实现
  window.__NOTESYNC_CANON__ = (d: Doc): string => canonicalize(d);
  window.__NOTESYNC_RELOAD_FROM_DOC__ = () => {
    const snapshot = structuredClone(latestDoc);
    ed.update(
      () => {
        docToLexical(snapshot);
      },
      { discrete: true },
    );
    // 🔴 这个钩子的语义是「重放真源」= 模拟一次真实的页面重载，
    //   而真实重载会走 mountEditor 里的 linkifyNow（首屏那一轮）。
    //   不在这里补上，e2e 里"重载后链接没了"会被误当成真源丢数据 ——
    //   钩子与生产行为不一致时，测试结论不可信。
    behaviors.linkifyNow();
  };
  // 🔴 只读探针：把 Lexical 侧选区读出来，供 e2e 与 DOM 选区对照。
  //   必须在 editor.getEditorState().read(...) 里读 —— 选区是 editor state 的一部分，
  //   在 update 之外直接 $getSelection() 拿不到（会抛或返回 null）。
  window.__NOTESYNC_SEL__ = () => {
    const state = ed.getEditorState();
    let out: ReturnType<NonNullable<Window['__NOTESYNC_SEL__']>> = null;
    state.read(() => {
      const sel = $getSelection();
      if (!$isRangeSelection(sel)) return;
      out = {
        lexKey: String(sel.anchor.key),
        lexOffset: sel.anchor.offset,
        lexType: sel.anchor.type,
        collapsed: sel.isCollapsed(),
        nodeText: sel.anchor.getNode().getTextContent(),
      };
    });
    return out;
  };
  editor = ed;
  goto('editor');

  /* ---- 提醒：起调度 ---- */
  // 🔴🔴🔴 **没有补弹（catch-up）** —— 用户报障第 6 条「每次点刷新都弹一次过期提醒，太烦」。
  //   根因就是这里曾有一句"挂载时补弹离现在最近的一条过期提醒"。
  //
  //   🔴 老项目**没有补弹**（唯一权威参照）：`showRemCard` 全仓只有一处调用点
  //     `fireReminder`（index.html:7564，`isCatchup=false`）—— 卡片**只在到点当次弹**，
  //     那个 `isCatchup` 形参从头到尾没被以 true 调过。页面加载时过期条目走
  //     `markExpiredFired()`（:7047）补记 fired + 正文画删除线，**不弹任何卡**。
  //   顶栏 title 那句「下次打开提示」指的是**原生系统通知**（关页期间到点由闹钟推送），
  //   不是页内卡片。此前 bj 把它误读成"页内补弹"，是自造的偏离。
  //
  //   ⇒ 判据：mount 路径里**不得**出现 `showCard(`（源码断言）；到点弹卡只经 `fire()`。
  // 起调度。到点由 schedule() 自己算下一条并重排。
  // 🔴 schedule() 内含「同步提醒列表到原生闹钟层」，所以这一句同时覆盖了
  //   老项目 index.html:7050 `loadReminder` 里的 syncRemindersToNative() ——
  //   bj 的入口是 mountEditor（解锁后进编辑器），老项目是 loadReminder，同一件事。
  reminderRef?.schedule();
  // 🔴 Android 12+ 的 SCHEDULE_EXACT_ALARM 默认不开，不开则原生闹钟退化为非精确档
  //   （深睡晚到，被 sync 的 60s 容差吞掉⇒ 到点不响）。引导一次，localStorage 记标记。
  //   老项目 index.html:7051 `ensureExactAlarmPermission()` 同款，只引导一次。
  void ensureExactAlarmPermission();

  // 🔴🔴 同步在首次 update **之后**才启动。
  //   顺序反了会怎样：start() 立刻 pull → setDoc(远端) → 触发 update → noteEdit()
  //   → 把刚拉下来的内容当成"用户刚编辑的"推回去。两台设备互相回声，永不停歇。
  //   这就是上面那个 canonicalize 比较存在的原因：即便顺序变了也不会误推。
  void startSyncFor(name);
}

/** 当前笔记的同步实例。切笔记时必须先 stop()，否则旧实例的 SSE 还在跑。 */
let syncRef: SyncClient | undefined;
/**
 * `pagehide` 监听器句柄（模块级，因为每次 `startSyncFor` 都要先摘旧的再挂新的）。
 * 🔴 为什么不能用 `{ once: true }`：切笔记会重建 SyncClient，
 *   once 的话只在第一篇生效，切走后页面关闭就不再兜底 —— 缺陷只在第二篇笔记上复现，
 *   极难发现。老项目是单页不换笔记，但本项目**能换**，不能照抄成 once。
 */
let pagehideHandler: (() => void) | null = null;

/**
 * 🔴 当前笔记的派生密钥（模块级）。
 *
 * 🔴🔴 为什么必须提到模块级：历史版本的三个动作（存快照 / 取某一版 / 恢复）
 *   都要用密钥加密解密，而菜单回调是在 `mountEditor` 内部定义的闭包 ——
 *   把密钥塞进那个闭包就得给 SyncDeps 再开一个字段专门往回调里递，
 *   于是"快照用哪把密钥"这件事出现两个可能来源。
 *   这里是**唯一**来源：`startSyncFor` 一处赋值。
 *
 * 🔴 切笔记时必须清空（startSyncFor 开头就置 undefined）：
 *   留着上一把的话，"在 A 笔记点恢复、写回 B 笔记"就成了可能，
 *   而症状是 B 的内容被 A 的密钥加密 —— 云端再也解不开，且零报错。
 */
let currentDk: DerivedKey | undefined;

/** 当前笔记的提醒 UI。切笔记时必须先 destroy()，否则旧 chip/卡片/面板留在页面上，
 *  而它们的调度器还持有旧文档 ⇒ 上一篇笔记的提醒会在这一篇里炸出来。 */
let reminderRef: ReminderUI | undefined;

/**
 * 同步状态（9 态）→ 底栏（3 态）。
 * 🔴 这个映射必须**穷举**且有 default 兜底：状态机加了新状态而这里没跟上时，
 *   TypeScript 会因为 switch 不完整而报错（好）；但如果这里改成 if 链或断言成any，
 *   新状态就会静默落到"看起来正常"的分支上 —— 底栏显示"已同步"而实际正在推送。
 *   所以：switch + 每个 case 显式 return + default 兜底成connecting（最保守）。
 */
function footFor(s: SyncState): { s: 'connecting' | 'synced' | 'offline'; d?: string } {
  switch (s) {
    case 'idle':
      return { s: 'synced' };
    case 'offline':
      return { s: 'offline', d: COPY.footOffline };
    case 'conflict':
      return { s: 'offline', d: COPY.footConflict };
    case 'dirty':
    case 'pushing':
      return { s: 'connecting', d: COPY.footSaving };
    default:
      return { s: 'connecting' };
  }
}

/* ================================================================== *
 * 离线草稿（v3.1.1）—— sync/draft.ts 的主流程接入
 * ================================================================== */

/** 草稿条当前挂起的笔记。undefined = 屏上没有草稿条。 */
let draftConflictNote: string | undefined;

/** 正在编辑的笔记（visibilitychange 兜底用——那个监听器拿不到 startSyncFor 闭包里的 name）。 */
let draftActiveNote: string | undefined;

/**
 * 草稿上下文。🔴 密钥不缓存：每次从 currentDk 现取（draft.ts 头注的密钥策略——
 * 切笔记的 await 间隙里拿旧密钥加密新内容 = 云端再也解不开且零报错）。
 */
function draftCtxOf(noteId: string): DraftCtx | undefined {
  const dk = currentDk;
  if (!dk) return undefined;
  return { noteId, dk };
}

/**
 * 🔴🔴 开篇裁决闸（v3.1.1）：startSyncFor 的草稿裁决（restoreDraftIfNeeded）完成之前，
 * **一切 saveDraftForNote 都不写**。
 *
 *   为什么必须有它：mountEditor 的装载链（docToLexical / 各类程序化 update）在
 *   restore 之前就会触发 update 监听器，而 `before`（上一次的 latestDoc）彼时还是
 *   undefined/旧值 ⇒ canonicalize 比对恒「真变」⇒ **把刚从云端/缓存解出来的内容
 *   当成"用户编辑"写进草稿**——盘上那份真正的离线草稿被顶掉（e2e DRAFT-E1 实锤：
 *   reload 前 268 字节离线记录、restore 读到的已是 51 字节装载回声写下的 248，
 *   conflict 判成「一致」静默清；多设备场景下离线段就此丢失）。
 *
 *   装载回声的内容来源是云端/缓存，**本来就不是用户编辑**——restore 完成后
 *   （conflict ⇒ pending 闸由 draft.ts 形状兜底；none ⇒ 草稿已清）再放行真编辑。
 *   🔴 切笔记（startSyncFor 开头）先重关：上一篇的放行状态不许漏进下一篇。
 */
let draftGateOpen = false;

/**
 * 把内容记进草稿。baseRev 恒 0 —— bj 没有本地内容版本号（diag/lines.ts 口径：
 * 三方合并靠 base 文档而非自增 rev），draft.ts 把 baseRev 的语义留给调用方定义，
 * 这里就诚实地传 0：只作往返保真，不参与任何决策（冲突裁决比的是内容不是 rev）。
 */
function saveDraftForNote(noteId: string, doc: Doc): void {
  // 🔴 开篇裁决闸：restore 完成前不记（见 draftGateOpen 注释）。flushDraftNow
  //   （pagehide/visibilitychange）同样被它挡住——彼时草稿记录还是权威副本，不许覆写。
  if (!draftGateOpen) return;
  const ctx = draftCtxOf(noteId);
  if (!ctx) return; // 密钥未就绪（startSyncFor 的 await 间隙）：编辑器里还是云端内容，无需草稿
  void saveDraft(ctx, doc, 0);
}

/**
 * 离开兜底（pagehide / visibilitychange→hidden）：把**活真源**落一次草稿。
 * 存在理由：PUSH_DEBOUNCE_MS=700 内关页，最后一批编辑没进云端也没进草稿就是丢失。
 * saveDraft（内容真变才写）+ flushDraft（强制落一次，防另一 Tab 删过/上次配额满失败）。
 */
function flushDraftNow(noteId: string): void {
  const ctx = draftCtxOf(noteId);
  if (!ctx) return;
  const live = window.__NOTESYNC_DOC__?.();
  if (live) saveDraftForNote(noteId, live);
  void flushDraft(ctx);
}

/** 弹「保留本机 / 使用云端」。文案在 build.mjs 的静态标记里，这里只管显隐与挂起对象。 */
function showDraftBar(noteId: string): void {
  draftConflictNote = noteId;
  document.getElementById('draftBar')?.classList.remove('hidden');
}

/** 收起草稿条。切笔记 / 回首页 / 回落地页都必须调——条是常驻 DOM，忘了收会盖在别的页上。 */
function hideDraftBar(): void {
  draftConflictNote = undefined;
  document.getElementById('draftBar')?.classList.add('hidden');
}

async function startSyncFor(name: string): Promise<void> {
  syncRef?.stop();
  syncRef = undefined;
  // 🔴 开篇裁决闸先重关：上一篇的放行状态不许漏进下一篇（见 draftGateOpen 注释）。
  draftGateOpen = false;
  // 🔴🔴 先清密钥再解新的：解密钥是 await，期间任何一次历史操作都该看到"没有密钥"，
  //   而不是拿着上一篇的密钥去加密这一篇的内容（见 currentDk 的注释）。
  currentDk = undefined;
  const dk = await deriveKeyFor(name);
  if (!dk) {
    // 拿不到密钥（理论上不该发生：能进编辑器就说明解锁成功过）
    setFootStatus?.('offline', '本机密钥不可用，请刷新页面');
    return;
  }
  currentDk = dk;
  // 🔴 离线草稿裁决（v3.1.1）：开新会话先清内存态（只清内存，盘上记录绝不动——
  //   切笔记不许毁掉别的笔记还没推送的草稿，draft.ts DR-13），再拿「解锁时解出来的
  //   云端版」比对盘上草稿：一致 ⇒ 静默清（草稿已无意义）；不一致 ⇒ 弹
  //   「保留本机 / 使用云端」由用户裁决，绝不自动覆盖（老项目 v5.49 同一口径）。
  resetDraftSession();
  draftActiveNote = name;
  {
    // 🔴🔴 v3.1.1 裁决基准修正：缓存 miss 时 unlockIfRemembered 只能回 emptyDoc
    //   （它自己不在线拉，"交给 sync 去拉"——而裁决发生在首拉**之前**）。
    //   拿 emptyDoc 当基准会把「云端与草稿一致」（E3 实锤：推送成功→缓存被清→
    //   重开误弹「检测到同步冲突」）误判成 conflict。此处在线拉一次真云端：
    //   env→解密→parseDoc 成功才替换基准；offline/empty/解不开（口令在别处改过）
    //   一律维持 emptyDoc 走原判 —— 离线时无法验证，保守交用户裁决，无害。
    let base = mountDocSnapshot ?? emptyDoc();
    if (canonicalize(base) === canonicalize(emptyDoc())) {
      try {
        const remote = await fetchRemote(name, fetch);
        if (remote.kind === 'env') {
          try {
            base = parseDoc(await decryptString(remote.env, dk.key, 'note'));
          } catch {
            /* 解不开（口令已换）：维持 emptyDoc 走原判 */
          }
        }
      } catch {
        /* fetchRemote 自身不抛（offline 形状），这里只是兜底 */
      }
    }
    // 🔴 v3.1.1 取证：先只读一份草稿明文长度（readDraft 不改状态），再裁决——
    //   「该弹条没弹」时这行能直接分辨「一致静默清 / 解不开 / 无草稿」三种形状
    //   （e2e DRAFT-E1 实测就栽在分不清这三种）。盐前缀进日志：盐本就在信封里明文，非新增暴露面。
    const pre = await readDraft({ noteId: name, dk });
    const rr = await restoreDraftIfNeeded({ noteId: name, dk }, base);
    recordFlight(
      'draft:restore',
      rr.kind +
        ' draft=' + (pre ? canonicalize(pre.doc).length : 'x') +
        ' cloud=' + canonicalize(base).length +
        ' salt=' + dk.saltB64.slice(0, 6),
    );
    if (rr.kind === 'conflict') showDraftBar(name);
  }
  // 🔴 裁决完成才放行草稿写入：此后 update 监听器/离开兜底记的才是真用户编辑。
  //   conflict 时防误清由 pending 闸（draft.ts 形状）继续兜底。
  draftGateOpen = true;
  const c = new SyncClient({
    noteId: name,
    // 🔴🔤🔤 base 播种（用户报障第 1 条，B-①）：
    //   base 必须以"解锁时解出来的那一版"为起点，而不是空文档。
    //   否则每次刚开篇就是"本地有内容、base 是空、远端有内容"
    //   ⇒ 第一个分支与第二个分支都不成立 ⇒ 直接掉进三方合并 ⇒ 必弹冲突。
    //   老项目 index.html:3450 在解锁时就把 lastHtml 设成服务端内容，同款。
    // 🔴🔴 `mountDocSnapshot` 是 `Doc | undefined`（还没 mount 过就是 undefined），
    //   而 `SyncDeps.initialDoc?: Doc` 在 exactOptionalPropertyTypes 下**不允许显式传
    //   undefined**。这里显式判一次：拿不到就不带这个键，让 SyncClient 走
    //   `emptyDoc()` 兜底 —— 语义与"传 undefined"完全一致，但不违反该开关。
    ...(mountDocSnapshot ? { initialDoc: mountDocSnapshot } : {}),
    key: dk.key,
    dk,
    getDoc: () => window.__NOTESYNC_DOC__?.() ?? emptyDoc(),
    setDoc: (d) => {
      // 🔴🔴🔴 回灌守卫①：IME 门控（用户报障第 7 条）。
      //
      //   这是**三条回灌路径里最危险的一条** —— 它承载「远端合并结果 / 采纳远端 /
      //   采纳本机」三种写回，全部走 `docToLexical` 的 `root.clear()` + 整篇重建。
      //   而这条路径的触发时机**不受用户控制**：他在打字（组字中）或刚打完字
      //   （活跃期 1.5s 内），远端恰好有变更 ⇒ 整篇重建落在他的拼音串上
      //   ⇒ 吞字、吞回车，且**界面零报错**（内容确实"同步了"，只是少了他刚打的）。
      //
      //   🔴 为什么是「跳过」而不是「排队」：排队就得存一份待写回的 doc，
      //   而下一轮 poll（2 秒后）会自己拉到最新内容 ⇒ 跳过即可，不需要额外状态机。
      //   老项目同款：index.html:9883 的 applyRemoteBody 首行就return。
      //   🔴🔴 v3.0.8：判 canEditTree() —— docToLexical 整篇重建在"整段改写会话窗口"
      //   内同样必须让路（豆包智能整理大段删除后分批插入，间隙超时窗，canApply 会开门）。
      if (imeGateRef && !imeGateRef.canEditTree()) {
        recordFlight('gate:setdoc', 'len=' + docTextLen(d));
        // 🔴🔴🔴 补铺（残留缺口：远端删除路径此前是**裸 return**）。
        //
        //   场景：另一台设备删掉一条提醒 ⇒ 合并结果从这条路径写回 ⇒ 恰好用户在
        //   打字/组字 ⇒ 门控拦下整篇重建。回灌推迟没关系（下一轮 poll/SSE 会再送，
        //   且 base 不推进，见 imeCanEditTree），**但屏幕上那条下划线会一直挂着** ——
        //   用户看到的就是「另一台删了，这台还显示着提醒」，而且**零报错**。
        //
        //   补铺只做点状摘除（unwrap 已死标记节点），**不改变任何文本**，
        //   所以拿"待回灌真源"先做这件纯视觉的事是安全的；文本回灌仍整轮推迟。
        //   判死集合必须来自 `d.reminders`（待回灌的那份），不能是 latestDoc
        //   —— 后者此时还是旧真源，会把该提醒判成"还活着"，补铺空跑。
        //
        //   🔴 走 scheduleStrayMarkFlush（内部过 IME 门控、不开就顺延），
        //   **不要**在这里直接 setTimeout —— 补铺是树手术，输入法还在工作时下刀
        //   会让 InputConnection 的文本视图与真实 DOM 错位 ⇒ 整段正文被替换。
        strayFlushRef?.(TYPE_ACTIVE_MS + 150, new Set((d.reminders ?? []).map((r) => r.id)));
        return;
      }
      recordFlight('tree:setdoc', 'len=' + docTextLen(d));
      // 远端/合并结果写回编辑器。**必须包在 update 里**，
      // 直接改 Lexical 内部状态会在渲染之外改文档，症状是"内容变了但重绘没跟上"。
      editor?.update(() => {
        docToLexical(d);
      }, { discrete: true });
      // 🔴 换完真源立刻重跑链接识别。老项目对应用法：
      //   `applyRemoteBody` / `remoteTake` 之后都调 linkifyEditor
      //   （index.html:3977-3979 在 finally 里统一收口）。
      //   漏掉的症状：另一台设备同步过来的网址在本机永远是裸文本，
      //   而本机敲的会亮 —— 用户会怀疑"同步把内容搞坏了"。
      linkifyNowRef?.();
    },
    // 🔴🔴 P0-3：把 IME 门控喂给 client.ts，让它在「回灌」与「推进 base」同进同退。
    //   此前只有 setDoc 内部那道裸 return 门控——它挡得住回灌，却挡不住 base 推进，
    //   于是 base 与编辑器分叉、后续三方合并复活远端删除。现在 client.ts 自己持有一份
    //   同一来源的谓词，门控不通过时既不回灌也不推进 base，把回灌推迟到下一轮
    //   轮询 / SSE。setDoc 里的旧门控保留作防御纵深（两条用的是同一谓词，不会矛盾）。
    //   🔴🔴 v3.0.8：喂 canEditTree()（比 canApply 多挡"整段改写会话窗口"）——
    //   三方合并结果回灌是动树最狠的一条路，窗口内必须整轮推迟（base 也不推进，
    //   两者同进同退的 P0-3 纪律不变）。
    imeCanEditTree: () => (imeGateRef ? imeGateRef.canEditTree() : true),
    // 飞行记录器（v3.0.9 诊断版）：push/pull/合并分支/状态机全记（只长度与哈希）。
    onFlightEvent: recordFlight,
    onSnapshot: (s) => {
      lastSyncState = s.state;
      const f = footFor(s.state);
      footStatus(f.s, f.d);
      if (root) root.dataset.syncState = s.state;
      if (s.state === 'conflict') showConflictHint();
    },
    onError: (msg) => {
      // 🔴🔴 这里**只放用户能据此行动的错误**（口令不对、数据无法解析、429…）。
      //   内部/编程错误（状态机非法转移、断言失败）走下面的 onInternalError ——
      //   此前两者共用这一条通道，导致「非法状态转移：offline --remote-arrived-->（无此边）」
      //   这种内部消息被当成用户文案推到底栏，闪一个红点（用户报障第 1 条）。
      //   老项目底栏只有 30 句固定白名单（index.html 的 setStatus 全集），
      //   压根不存在"把异常消息显示给用户"这种口径。
      footStatus('offline', msg);
    },
    // 🔴 内部错误：可观测（不许黑洞 —— 静默吞掉等于把同步状态变成不可观测的黑洞，
    //   也就是老项目里"同步偶尔不推、也不报错、也不提示"那类问题的温床），
    //   但**不进 UI**。不传这一条时 client.ts 会退化成 console.warn，
    //   写在这里是为了线上日志能直接捞到。
    onInternalError: (msg, err) => {
      // eslint-disable-next-line no-console
      console.warn('[notesync] 内部错误（不影响用户）：' + msg, err);
      // 🔴🔴 P1-8：console.warn 是**唯一出口**就等于黑洞 —— 真机 APK 上
      //   "同步静默死"时用户零感知、开发者零线索（没人能在手机上开 devtools）。
      //   落进固定容量环形缓冲：诊断面板可读（?diag，长效）、飞行记录器可读
      //   （短效、随机身日志一起被用户贴过来），**且绝不上报服务器**（守零知识）。
      pushInternalError({ msg, err });
    },
    // 🔴 自动快照：每次推送成功后把"刚被覆盖的那一版"存进快照环。
    //   节流在 pushAutoHistory 里（60s，老项目 :8469 同值同理由）。
    //   ⚠️ onArchive 带 onPushed 没有的两道闸（prev 非空 && prev≠doc）——
    //   首推不调它，所以**清草稿不能挂这里**（DRAFT-E1 实锤过：挂这里
    //   首推后草稿永远残留）。快照与草稿清理是两件事，见 onPushed。
    onArchive: (prev) => {
      void pushAutoHistory(name, prev);
    },
    // 🔴 离线草稿（v3.1.1）：推送成功 ⇒ 云端已确认收到这一版 ⇒ 镜像它的草稿完成使命。
    //   🔴 挂 onPushed 不挂 onArchive：首推（prev 为空）也必须清（见上）。
    //   clearDraft 的 API 形状保证：草稿条挂起（pending）期间这里**什么都不做**，
    //   绝不会把用户还没裁决的草稿删掉（draft.ts 文件头的数据丢失红线）。
    //   🔴 全 main.ts 只有这一处 clearDraft —— 清草稿的调用面收紧到一点才可审计。
    onPushed: () => {
      clearDraft(name);
    },
  });
  syncRef = c;
  // 🔴🔴 页面离开时把待推内容立刻推掉（老项目 index.html:10080 `pagehide → flushDirtySave` 同款）。
  //   不接这条的后果是**真的丢数据**：`PUSH_DEBOUNCE_MS = 700`，
  //   用户打完字 700ms 内刷新/关页面/切走，最后一批编辑就只留在内存里。
  //   探针 probe-ep01-flow 实锤：打完 A/空行/B 立刻 reload，真源回到 `{"v":1}`。
  //
  //   🔴 必须用 `{ once: true }` 之外的写法？——不，**恰恰要每次都解绑再绑**：
  //   `startSyncFor` 每篇笔记调一次（切笔记会重建 SyncClient），
  //   用 once:true 的话只在第一次生效，切笔记后就失联了。
  //   正确做法是：先把**模块级**那个 listener 摘掉（它持有的是上一份 syncRef），
  //   再挂新的。
  // 🔴🔴 v1.13.0 修：原来这三行的顺序是「先赋值 → 再 remove(新值) → 再 add」，
//   也就是**从来没摘掉过上一份 listener**（remove 拿到的是刚赋的那个）。
//   而上面那段注释要的正是"摘掉持有旧 syncRef 的那一份"。
//   后果是每次 startSyncFor（切一次笔记调一次）都**多挂一个** listener：
//   旧闭包继续持有已被 stop 的 SyncClient 实例，pagehide 时重复 flushPending。
//   症状隐蔽到极点 —— 内容全都对，只是离开页面时多几次无用的网络请求。
//   正解：先摘旧的（可能为 null，DOM 签名接受），再赋新的，再挂。
  const prevPagehide = pagehideHandler;
  if (prevPagehide) window.removeEventListener('pagehide', prevPagehide);
  pagehideHandler = () => {
    // 🔴 离线草稿兜底（v3.1.1）：走之前把活真源落一次草稿 —— 推送没完成的场景
    //   （700ms 去抖没到 / 断网 / 被系统杀）就靠这份草稿在下次打开时找回。
    flushDraftNow(name);
    // 🔴 同步读一次 localStorage 不做，push 本身已是 fire-and-forget；
    //   本地那份在 writeCache 里是同步写的，所以最坏只丢"上云"这一步。
    syncRef?.flushPending();
    // 🔴 v1.13.0 抑制标记（老项目 index.html:10084 逐字同款）：
    //   离开笔记页（Android 返回键/手势回首页）前打"已跳转"——
    //   扫码/深链/收藏夹进入的笔记从未设过该标记，返回键落回首页时
    //   route() 的冷启动自动跳转会再把用户弹回本笔记（"返回首页有时没反应"的现场）。
    //   等价性：老项目是 `if (noteId) addEventListener(...)`（仅笔记页注册），
    //   bj 这个 handler 本身就只在 startSyncFor（进编辑器）里挂，天然满足。
    markJumped();
  };
  window.addEventListener('pagehide', pagehideHandler);
  await c.start();
  // 🔴 新笔记：解锁时拿到的是空文档且云端也没有，必须立刻推一次，
  //   否则"这篇笔记存在"这件事只存在于本机 —— 换台设备输入同一口令，
  //   服务端返回 200 空体，会被当成另一篇新笔记，用户以为自己记的两篇笔记丢了。
  if (pendingFresh) {
    pendingFresh = false;
    c.noteEdit();
  }
}

/** 本次解锁是否为首建（需要首推）。 */
let pendingFresh = false;

/**
 * 一个文档的纯文本长度（spans/title/text 全算，children 递归）。
 *
 * 🔴 专为「整段改写会话窗口」的触发判据服务（见 update 监听器里的 noteBulkEdit）：
 *   判据只比**长度**，不比内容 —— 一次 update 删掉 8 个字符就是结构痕迹，
 *   与删的是哪 8 个无关。递归 children：折叠块的子块在真源 blocks 树的 children
 *   里（不是扁平兄弟），漏了它们会把"删掉半个折叠块"算成没删。
 *   🔴 纯模型函数：只吃 Doc，不碰 editorState —— 在 read 回调外调用也安全。
 */
function docTextLen(d: Doc): number {
  let n = 0;
  const walk = (bs: Doc['blocks']): void => {
    for (const b of bs ?? []) {
      if (Array.isArray(b.spans)) for (const s of b.spans) n += s.t.length;
      if (Array.isArray(b.title)) for (const s of b.title) n += s.t.length;
      if (typeof b.text === 'string') n += b.text.length;
      if (b.children) walk(b.children);
    }
  };
  walk(d.blocks);
  return n;
}

/**
 * 「整段删除」判据阈值：一次 update 删掉 ≥ 8 个字符 ⇒ 视为输入法在整段改写。
 *
 * 🔴 取值口径：比单行编辑大（敲错一整行重打通常也就几个字），
 *   比豆包智能整理的删除小得多（它删的是整篇）。误触发代价仅为回灌推迟 6s。
 */
const BULK_DELETE_CHARS = 8;

/**
 * 真源的纯文本（给彩蛋层抽词用）。
 *
 * 🔴 只给**纯文本**，绝不给真源结构：游戏只是拿词当素材
 *   （砖面字/ 蛇身 / 基地名），把 reminders、rem 标记这些喂进去
 *   没有意义，且会让"游戏能改真源"这个不该有的可能性看起来存在。
 */
function latestDocText(): string {
  const d = window.__NOTESYNC_DOC__?.();
  if (!d) return '';
  const parts: string[] = [];
  const walk = (bs: Doc['blocks']): void => {
    for (const b of bs ?? []) {
      for (const s of b.spans ?? []) parts.push(s.t);
      if (b.title) for (const s of b.title) parts.push(s.t);
      if (b.text) parts.push(b.text);
      if (b.children) walk(b.children);
      parts.push('\n');
    }
  };
  walk(d.blocks);
  return parts.join('');
}

async function deriveKeyFor(name: string): Promise<DerivedKey | undefined> {
  const rec = await resolveKey(name);
  if (!rec) return undefined;
  return { key: rec.key, saltB64: rec.salt, iter: rec.iter };
}

/* ─────────────────────────────────────────────────────────────────────────
 * 历史版本（服务端快照环的客户端一侧）
 *
 * 🔴🔴 加密边界：三个动作全部走 sync/history.ts 里那唯一一处 `sealDoc`
 *   —— 与正常保存同一个 `canonicalize` + 同一个 `encryptString(..., 'note', dk)`。
 *   服务端从头到尾只见密文（这是本项目的核心红线）。
 *
 * 🔴 恢复**不是**"回滚版本号"，而是"把那一版的内容当**当前新内容**推上去"：
 *   老项目 :8536 `saveLocal(true)` 同款。快照环**不删不改** ——
 *   用户"恢复到旧版再后悔"，要能找回恢复之前那一版。
 * ───────────────────────────────────────────────────────────────────────── */

/**
 * 拉历史列表塞进菜单状态。
 *
 * 🔴🔴 `at` 存的是**服务端给的 ts 字符串**，不是格式化过的时间：
 *   它同时是 `GET /history/<ts>` 的路径段与行上的 `data-at`，
 *   格式化过就取不回原文（`fmtHistTime` 出的 `MM-DD HH:mm` 是给人看的，
 *   见 menu.ts MenuState.histList 的注释）。
 *
 * 🔴 失败**不伪装成空列表**：网络不通时列表显示"历史版本读取失败"，
 *   而"暂无历史版本"是另一个意思（服务端确实没有）。合成一个空数组的话，
 *   用户会以为改动没被记下来 —— 而历史版本是找回丢失内容的唯一指望。
 */
async function loadHistIntoMenu(name: string): Promise<void> {
  const list = await fetchHistoryList(name);
  if (list === null) {
    menuState.histList = [];
    menuState.histFail = COPY.histListFail;
    return;
  }
  menuState.histFail = '';
  menuState.histList = list.map((h) => ({
    at: String(h.ts),
    // 🔴 「· 手动」只标手动打的点（老项目 :8493 逐字：自动的不标注）
    label: fmtHistTime(h.ts) + (h.manual ? COPY.histManualMark : ''),
  }));
}

/**
 * 自动快照（每次推送成功后调）。
 *
 * 🔴 节流在 `autoSnapshotThrottled` 里判：60s 一版（老项目 :8469）。
 *   不节流的话连续打字 30 秒能把 10 条的环全冲掉，只剩最后几十秒的内容 ——
 *   而用户想找回的恰恰是"一小时前那段"。
 *
 * 🔴 失败静默（老项目 :8478）：快照是保险不是主链路。
 *   但**不给"已保存"提示** —— 自动快照用户没主动要求，
 *   每次打字后弹一次提示条会变成噪音。
 */
async function pushAutoHistory(name: string, prev: Doc): Promise<void> {
  const dk = currentDk;
  if (!dk) return;
  // 🔴 P1-3：节流**必须带 noteId**。此前是模块级单值 ⇒ A 笔记刚自动存一版，
  //   60s 内切到 B 编辑，B 的自动快照一律被吞（B 永远收不到自动版本）。
  if (!autoSnapshotThrottled(Date.now(), name)) return;
  await pushHistory(name, prev, dk.key, dk, false);
}

/**
 * 恢复某一版：取回 → 解密 → 写进编辑器 → 走正常保存路径推上云端。
 *
 * 🔴🔴 写入顺序**不能反**：必须先 `fetchHistoryDoc` 拿到可信 doc，
 *   确认拿到了才动编辑器。反过来做（先挂编辑器再解密）的话，
 *   一次失败的恢复会把用户**当前正文**换成空文档 —— 而那次恢复本来就是失败的，
 *   等于"失败的恢复把原文擦了"。这与 migrate 的 applyMigrateRestore 同一条纪律。
 *
 * 🔴 写回走 `editor.update(() => docToLexical(d))` + `syncRef.noteEdit()`，
 *   与 setDoc（远端合并写回）是同一条路。不自己另调 push：
 *   那会把去抖 / 版本协商 / 409 重试全绕过去，等于开了第二条推送链路。
 *
 * 🔴 折叠块的展开态是 ephemeral UI 态，**不在真源里**（见 nodes.ts）：
 *   恢复后由 docToLexical 重建的折叠块一律回到默认收起态，这是正确的
 *   —— 用户要的是"那一版的正文"，展开态不属于正文。
 */
async function restoreHistVersion(name: string, at: string): Promise<void> {
  const dk = currentDk;
  if (!dk) {
    showUploadNote('bad', COPY.histNeedUnlock, 2200);
    return;
  }
  const ts = Number(at);
  if (!Number.isFinite(ts)) {
    showUploadNote('bad', COPY.histBad, 2200);
    return;
  }
  // 🔴🔴 解不开 / 没有这一版 → 同一句「该版本不可用」（老项目 :8539 同款）。
  //   不区分"取不到"与"解不开"：区分开等于给暴力破解一个 oracle
  //   （ARCH 安全不变量，与解锁失败同一句文案）。
  const doc = await fetchHistoryDoc(name, ts, dk.key);
  if (!doc) {
    showUploadNote('bad', COPY.histBad, 2200);
    return;
  }
  editor?.update(
    () => {
      docToLexical(doc);
    },
    { discrete: true },
  );
  // 🔴 历史版本里的裸网址也要亮（老项目 undo/redo 后同样走 linkify 收口，
  //   index.html:3977）。漏掉的症状：恢复历史版本后正文全是裸网址。
  linkifyNowRef?.();
  // 🔴 不在这里赋值 latestDoc：它是 mountEditor 的闭包局部变量（main.ts:989），
  //   而 registerUpdateListener 会在 docToLexical 触发的那次 update 里
  //   **自动**把最新真源写回 latestDoc —— 与 applyMigrateRestore 同一份理由。
  //
  // 🔴 必须 noteEdit()：不推的话这次恢复只活在本机，
  //   用户换个设备 / 刷新一下就回到恢复前的内容，而界面上什么都没说。
  syncRef?.noteEdit();
  //🔴 恢复完把列表也重拉一次：服务端里那一版的"手动"标记没变，
  //   但恢复本身是一次编辑，下一次自动快照会把它记进去 —— 用户可能想立刻看到。
  showUploadNote('ok', COPY.histRestored, 2200);
}

/**
 * 扫码结果落地 —— 不管从哪一级引擎扫出来的，都只走这一个入口判定。
 *
 * 🔴🔴 落地方式刻意**不**用 `location.assign(dest)`（老项目做法）：
 *   那是把口令塞进 URL 后整页重载 —— 口令一旦进地址栏，就会进浏览器历史、
 *   进"最近访问"、可能被同步到别的设备。这里改成**原地 unlock()**：
 *   口令只经过内存，落地后 URL 保持干净。
 *   代价是要走完整的解锁链路（派生 + 解密远端），与手输口令完全同一条 ——
 *   这正是要的：一条路径，一种失败语义。
 */
async function handleScanRaw(raw: string): Promise<void> {
  // 🔴🔴 换机码必须**先于**配对链接分流。
  //   两者的失败文案天差地别（换机码是"口令不对"、配对链接是"这不是配对链接"），
  //   而它们都是一串 base64 —— 若先试配对链接，换机码会走进 URL 解析，
  //   报出"这不是配对链接"，用户完全想不到真正原因（他手里确实是一张换机码）。
  // 🔴 收藏备份码（nsfav1:）必须**先于**单篇换机码（nsbak1:）判。
  //   两者都走 restoreMigrateCode 那条路的话，扫到清单码会被当成单篇码硬解，
  //   报出来的是"口令不对"—— 而口令其实是对的，用户会反复重输。
  //   （前缀互不为前缀，fav-backup.test.mjs BAK-FAV-01 钉着这条。）
  if (isFavBackupCode(raw)) {
    openFavBackupTake(raw);
    return;
  }
  if (isMigrateCode(raw)) {
    openMigrateTake(raw);
    return;
  }
  // 🔴 解析**只经由** resolveScan 一处，落地路径与 e2e 钩子共用它。
  //   两处各写一遍判定的话，改了一边就会表现为
  //   "钩子说能解、实际扫进去说口令不对" —— 极难自查。
  const { parsed, shape } = resolveScan(raw);
  if (!parsed.ok || !shape.ok || !parsed.link || !shape.noteId) {
    scanFeedback(COPY.scanNotPair, COPY.scanOkMs);
    return;
  }
  const { noteId, passphrase } = parsed.link;
  // 🔴🔴🔴 甲案分流**必须在 mountEditor 之前**（老项目 :3464 `enterBackupMode` 同款位置）：
  //   扫到的这篇若篇名是 `nsbak-xxxxxx`，它是**备份清单**，用户看到的是只读恢复卡。
  //   一旦先走 unlock+mountEditor，清单就进 contenteditable 了 ——
  //   那就破了甲案误编辑三闸的第①闸，而症状极隐蔽：
  //   "打开那篇笔记看到一串篇名，改了它，然后下次换机备份的就是被改过的清单"。
  //   tryEnterBakMode 内部**自己**先按篇名形状判（零成本），返回 false = 普通笔记，
  //   所以这里无条件调它，普通配对链接多走一次正则而已。
  //
  // 🔴 判据：走 A/B 两台页面扫码这台，A 上打开的必须是只读恢复卡
  //   （`#bakRestMask` 在、`#editor` 的 contenteditable 不该有那串篇名）。
  if (await tryEnterBakMode(noteId, passphrase)) return;
  showUploadNote('doing', COPY.pairLanded, 0);
  const r = await unlock({ noteId, passphrase });
  if (!r.ok) {
    // 🔴🔴 与手输口令**同一句文案**（ARCH 安全不变量）：
    //   这里绝不能因为"是从二维码来的"就换成更具体的原因 ——
    //   那等于给暴力破解一个 oracle。
    showUploadNote('bad', r.message, COPY.uploadFailMs);
    scanFeedback(r.message, COPY.scanOkMs);
    return;
  }
  sessionPass = passphrase;
  pendingFresh = r.fresh;
  // 🔴 v1.13.0 写入②（配对落地是 bj 的**第三条**解锁路径，老项目没有单独一段）：
  //   换手机后第一次扫码进来，也必须被记住，否则这台新机杀进程后重进仍停在落地页。
  rememberLastNote(noteId);
  // 🔴 落地后把地址栏拉正：扫码时用户可能停在任意页（落地页/别的笔记），
  //   挂载编辑器却不改 URL，刷新一下会回到原来那页 —— 看着像"内容自己跑了"。
  history.replaceState({}, '', '/' + encodeURIComponent(noteId));
  mountEditor(noteId, r.doc);
}

/**
 * 最近一次扫码自检。
 * 🔴 挂到 window 是**正式接口**，不是调试后门：e2e 要靠它判"走了哪条引擎、
 *   试了几帧、有没有报错"（"点了没反应"是这类问题唯一的症状），
 *   诊断页也要读它 —— 用户不该为了知道自己机器上出了什么事而去看控制台。
 * 🔴 只落元信息（引擎/帧数/错误摘要），**绝不落扫码内容**：码里带着口令。
 */
let scanDiag: ScanDiag | null = null;
window.__NOTESYNC_SCAN_DIAG__ = (): ScanDiag | null => (scanDiag ? { ...scanDiag } : null);
window.__NOTESYNC_PARSE_PAIR__ = (raw: string) => resolveScan(raw).shape;
/**
 * 喂一条扫码结果，走**生产落地链路** `handleScanRaw`（正式接口，不是调试后门）。
 *
 * 🔴🔴 为什么必须有它：甲案落地要判三件事 ——
 *   备份笔记链接进只读恢复卡、普通笔记链接照旧进编辑器、错误口令不写任何东西。
 *   这三条全都发生在 `handleScanRaw` 那个分流里，而 e2e 在 headless 下**没有摄像头**，
 *   不给钩子就只能"直接调内部函数"⇒ 判的全是另一条路，测出来的东西不作数。
 *   （QR-F06 此前写的是 `window.__NOTESYNC_SCAN_RAW__ ? … : null`，
 *   而这个钩子**当时根本不存在** ⇒ 那条判据一直在走 fallback 分支，
 *   实际测的是 `__NOTESYNC_FAVBAK_OPEN_TAKE__`，与扫码落地无关。已修。）
 *
 * 🔴 安全边界：与取景层 `onResult` 完全同款 —— 只**吃**一条文本，**不吐**任何东西
 *   （不回口令、不回明文、不回解密结果）。它不是读取口，是写入口。
 */
window.__NOTESYNC_SCAN_RAW__ = (raw: string): void => {
  void handleScanRaw(raw);
};

/** 扫码结果的形状：能不能解得开 + 笔记名 + 口令长度。
 *
 * 🔴🔴 为什么只回显 passLen 而不回显口令：
 *   钩子挂在 window 上，任何页面脚本都能调。若把口令放进 shape，
 *   它就从一个"测试钩子"变成"任何人可读的口令出口" ——
 *   而口令正是这个功能要保护的东西。有 passLen 已经足够让 e2e 判往返。
 */
interface PairShape {
  ok: boolean;
  noteId?: string;
  passLen?: number;
  reason?: string;
}

/**
 * `parsePairLink` 的**唯一调用点** —— 落地路径与 e2e 钩子都从这里过。
 * 🔴 判定口径只写一遍：分叉的根源从来不是"忘了改"，而是"改了一处"。
 */
function resolveScan(raw: string): { parsed: ReturnType<typeof parsePairLink>; shape: PairShape } {
  const parsed = parsePairLink(raw, location.origin);
  if (parsed.ok) {
    return {
      parsed,
      shape: { ok: true, noteId: parsed.link.noteId, passLen: parsed.link.passphrase.length },
    };
  }
  return { parsed, shape: { ok: false, reason: parsed.reason } };
}

/* ── 换机码的 e2e 钩子（正式接口，不是调试后门）───────────────────────────
   🔴🔴 **绝不同回口令、也绝不回明文**：这三个钩子只吐"码本身"与"长度/形状"这类
   与内容无关的元信息。理由与 __NOTESYNC_PARSE_PAIR__ 完全同款 ——
   钩子挂在 window 上，任何页面脚本都能调；把口令或笔记明文放进返回值，
   它就从"测试钩子"变成"任何人可读的口令/内容出口"，
   而那正是这个功能要保护的东西。e2e 需要的安全断言（码里不含明文）
   靠"拿码去搜明文"来做，不需要钩子吐明文。 */
/** 当前会话最后一次生成的换机码（仅码，无口令无明文）。 */
let lastMigrateCode = '';
/**
 * 当前会话最后一次出码的**配对链接**（正式接口，供 e2e 判往返）。
 *
 * 🔴 它含口令，所以只由生产侧 `buildPairPanel` 的 onCode 回写，
 *   绝不由任何"从 canvas 反解"的路径生成 —— 那会引入第二份编码实现。
 */
let lastPairCode = '';
window.__NOTESYNC_PAIR_CODE__ = (): string => lastPairCode;
/**
 * 收藏备份码的出码提示（老项目 :9187 口径，逐字）。
 *
 * 🔴 为什么要单独存而不是让面板现算：清单码出码时，篇数与 skipped 都只在
 *   那一瞬间算得出来（收藏夹随时可能变）。面板拿到的只有码字符串。
 *   而"一键恢复 N 篇"这句话是**出码后唯一告诉用户这张码干什么的文案** ——
 *   少它，用户对着码不知道该扫几篇。
 */
let lastMigrateTip = '';
/**
 * 收藏备份码当次装进码里的**真实篇数**。
 *
 * 🔴 为什么单独存：面板的 `scanTip()` 在 `onMake` 成功之后才被调用（同一轮同步链），
 *   它要报的是「一键恢复 N 篇」—— 这个 N 必须来自**出码那一刻**的清单，
 *   不能来自开面板那一刻的收藏夹快照（用户可以在面板开着时改收藏）。
 *   老项目 :9187 的 `col.f.length` 就是同一个口径。
 */
let lastMigrateFavCount = 0;
/**
 * 当次甲案备份里**没能装进正文**的篇数（本机缓存与服务器都取不到，v3 自包含的缺口数）。
 *
 * 🔴🔴 **不呈现给用户就是静默缺口**：这几篇恢复后将依赖服务器上的原文，
 *   服务器也没有就是空笔记 —— 正是用户报障「所有收藏的笔记都是空的」的形状。
 *   出码时在 scanTip 里如实预警（bakEnvSkipWarn），恢复时由 bakNoContentTip 兜底报数。
 *   🔴 走收藏码（nsfav1）路径时必须清零 —— 那条路没有"信封缺口"的概念，留着旧值
 *   会让收藏码的提示里挂着上一次甲案备份的警告。
 */
let lastMigrateBakSkipped = 0;
/**
 * 当次甲案备份的**备份笔记篇名**（`nsbak-xxxxxx`）。
 *
 * 🔴 与 lastMigrateCode / lastMigrateFavCount 同款理由：老项目 :9186 在出码那一刻
 *   把它写进 `#bakBakId`（独立一行），屏上用户要靠它对号/手输。
 *   它只能在 `onMake` 成功后才知道 ⇒ 不能从闭包里的 ids 推。
 */
let lastMigrateBakId = '';
/** 恢复尝试的形状：成没成、失败原因、以及**恢复后真源是否变了**。 */
let lastMigrateRestore: { ok: boolean; reason?: string; docChanged?: boolean } | null = null;
/** 收藏备份的恢复结果：篇数、覆盖数、丢弃数（供提示与e2e 断言）。 */
let lastFavBackupRestore: { ok: boolean; count?: number; renewed?: number; capped?: number } | null = null;
/**
 * 🔴 手动生成**单篇**换机码（`nsbak1:`）—— **已不是用户路径**。
 *
 * 🔴🔴 菜单「扫码换机」现在出的是**收藏备份码**（`nsfav1:`，见 openMigrateMake）：
 *   老项目只有一个「扫码换机」，备份的就是收藏夹全部（v10.1.7 定稿，index.html:8997-8998），
 *   压根没有"备份当前这一篇"这个功能。旧 bj 把它接成了单篇，那是与老项目不一致的地方。
 *
 *   那单篇码还留在这儿的原因只有两个：
 *     ① **旧码仍能解** —— 之前发给用户的码不能作废（`applyMigrateRestore` 那条完整保留）。
 *     ② QR-M 系列判据要靠它造单篇码，验"旧码链路没被收藏码改坏"。
 *   ⇒ 判"用户能不能造出单篇码"时要看**菜单**，不要看这个钩子；
 *     它的存在只说明兼容层在，不说明功能对用户可见。
 */
window.__NOTESYNC_MIGRATE_MAKE__ = async (passphrase: string): Promise<{ ok: boolean; reason?: string }> => {
  const doc = window.__NOTESYNC_DOC__?.();
  if (!doc) return { ok: false, reason: 'empty' };
  const r = await buildMigrateCode(doc, passphrase);
  if (!r.ok) return { ok: false, reason: r.reason };
  lastMigrateCode = r.code;
  return { ok: true };
};
/** 取最近一次生成的码。 */
window.__NOTESYNC_MIGRATE_CODE__ = (): string => lastMigrateCode;
/** 走**生产恢复链路**（applyMigrateRestore），供 e2e 注入替身喂码。 */
window.__NOTESYNC_MIGRATE_TAKE__ = async (code: string, passphrase: string): Promise<boolean> => {
  const before = window.__NOTESYNC_DOC__ ? canonicalize(window.__NOTESYNC_DOC__()) : '';
  const r = await applyMigrateRestore(code, passphrase);
  const after = window.__NOTESYNC_DOC__ ? canonicalize(window.__NOTESYNC_DOC__()) : '';
  // 🔴🔴 本仓开了 exactOptionalPropertyTypes：`reason: undefined` **不合法**，
  //   必须"键存在且有值"或"键压根不存在"。用条件展开而不是写 `undefined`。
  //   （这条与 local-cache.ts 里 `iter: number | undefined` 那个显式注释同源。）
  lastMigrateRestore = r.ok
    ? { ok: true }
    : {
        ok: false,
        reason: r.reason,
        // 🔴 "失败时真源有没有被动过" —— 这是反向闸的核心判据：
        //   一次失败的恢复绝不允许改动用户当前的正文。
        docChanged: before !== after,
      };
  return r.ok;
};
window.__NOTESYNC_MIGRATE_LAST__ = () => (lastMigrateRestore ? { ...lastMigrateRestore } : null);
/** 打开恢复面板（e2e 走真实用户路径：点菜单/扫到码，而不是直接调内部函数）。 */
window.__NOTESYNC_MIGRATE_OPEN_TAKE__ = (code?: string): void => openMigrateTake(code);
/** 定长容量（供 e2e 断言"超长被如实拒绝"）。 */
window.__NOTESYNC_MIGRATE_CAP__ = (): number => MIGRATE_PAYLOAD_CAP;

/* ── 收藏备份码（nsfav1:）的正式接口 ─────────────────────────────────────
 * 🔴 形态与上面那组**刻意同款**：都是"正式接口，不是调试后门"，
 *   e2e 靠它们走生产链路而不是调内部函数。
 *   菜单入口面板那边已能收清单码（handleScanRaw 先判 isFavBackupCode）。 */

/** 本机收藏清单（已剔备份槽与非法名）。备份侧与钩子共用它 —— **单一真源**。
 *🔴 为什么不让钩子去读 `window.__NOTESYNC_FAVBAK_SOURCE__`：
 *   那样会出现"两个都叫'本机收藏清单'的东西"，钩子读的是 window 上的快照、
 *   备份侧用的是闭包里的 —— 用户在面板开着时改收藏，两边就会分叉。
 *   一律走这个函数，两处永远同一份。 */
function favBackupSourceIds(): string[] {
  return collectFavBackupIds(readFavs(favStore), null);
}

/** 本机收藏清单（已剔备份槽与非法名）。e2e 用来确认"备份范围=收藏全部"。 */
window.__NOTESYNC_FAVBAK_SOURCE__ = (): string[] => favBackupSourceIds();

/** 走**生产备份链路**出收藏清单码。 */
window.__NOTESYNC_FAVBAK_MAKE__ = async (
  passphrase: string,
): Promise<{ ok: boolean; reason?: string }> => {
  const ids = favBackupSourceIds();
  if (ids.length === 0) return { ok: false, reason: 'empty' };
  const r = await buildFavBackupCode(ids, passphrase);
  if (!r.ok) return { ok: false, reason: r.reason };
  lastMigrateCode = r.code;
  lastMigrateTip = favBackupTip(r.ids.length, 0);
  lastMigrateFavCount = r.ids.length;
  lastMigrateBakSkipped = 0; // 收藏码没有"信封缺口"概念，清掉上一次甲案备份可能留下的警告
  return { ok: true };
};

/** 出码提示（老项目 :9187 口径，逐字）。e2e 断言"文案与老项目一致"。 */
window.__NOTESYNC_FAVBAK_TIP__ = (): string => lastMigrateTip;

/** 走**生产恢复链路**（applyFavBackupRestore）喂清单码。 */
window.__NOTESYNC_FAVBAK_TAKE__ = async (
  code: string,
  passphrase: string,
): Promise<boolean> => {
  const r = await applyFavBackupRestore(code, passphrase);
  lastFavBackupRestore = r.ok
    ? { ok: true, count: r.count, renewed: r.renewed, capped: r.capped }
    : { ok: false };
  return r.ok;
};
/** 上次收藏备份恢复的结果（e2e 断言篇数/覆盖/丢弃）。 */
window.__NOTESYNC_FAVBAK_LAST__ = () =>
  lastFavBackupRestore ? { ...lastFavBackupRestore } : null;
/** 打开收藏备份恢复面板（e2e 走真实用户路径）。 */
window.__NOTESYNC_FAVBAK_OPEN_TAKE__ = (code?: string): void => openFavBackupTake(code);
/** 清单容量上限（e2e 断言"超限明说不截断"）。 */
window.__NOTESYNC_FAVBAK_CAP__ = (): number => FAV_BACKUP_MAX;

/* ── 甲案（备份笔记）的正式接口 ──────────────────────────────────────────
 * 🔴 只回**篇名与码**，绝不回清单内容与口令：那两样正是这个功能要保护的东西，
 *   而钩子挂在 window 上、任何页面脚本都能调（与本组上面几条同款理由）。 */

/** 当次甲案备份的备份笔记篇名（`nsbak-xxxxxx`）。空 = 还没出码。 */
window.__NOTESYNC_BAK_ID__ = (): string => lastMigrateBakId;

/**
 * 走**生产甲案链路**出码（与 openMigrateMake 的 onMake 同一条）。
 * e2e 绝大多数判据走真实用户路径（菜单 → 扫码换机），这条只给
 * "要先出码、再拿码去另一台页面扫"这类**跨设备**判据用 ——
 * 那类判据没法只靠一台页面完成，才需要这条捷径。
 */
window.__NOTESYNC_BAK_MAKE__ = async (
  passphrase: string,
): Promise<{ ok: boolean; reason?: string; bakId?: string; count?: number; skipped?: number }> => {
  const slot = readBakSlot();
  const ids = collectBakEntries(favBackupSourceIds(), slot ? slot.id : null);
  const r = await makeBakBackup(ids, passphrase);
  if (!r.ok) return { ok: false, reason: r.reason };
  lastMigrateCode = r.link;
  lastMigrateBakId = r.bakId;
  lastMigrateFavCount = r.count;
  lastMigrateBakSkipped = r.skipped;
  lastMigrateTip = COPY.migrateBakScanTip(r.count) +
    (r.skipped > 0 ? COPY.bakEnvSkipWarn(r.skipped) : '');
  return { ok: true, bakId: r.bakId, count: r.count, skipped: r.skipped };
};

/** 本机备份槽（`{id, salt}` 或 null）。e2e 用来确认"备份槽自身被剔出清单"。 */
window.__NOTESYNC_BAK_SLOT__ = (): { id: string; salt: string | null } | null => {
  const s = readBakSlot();
  return s ? { id: s.id, salt: s.salt } : null;
};

/** 甲案清单能装的篇数上限（e2e 断言"超限明说不截断"）。 */
window.__NOTESYNC_BAK_CAP__ = (): number => BAK_MAX;

/**
 * 打开取景层。
 * 🔴 重入锁用**带过期的时间戳**而不是布尔（老项目闸 R2 实锤）：
 *   布尔锁在"权限框永不返回"时会把扫一扫**永久**锁死，而它本要防的
 *   只是"探测那几秒连点两下叠两层取景框"。过期后放行并说明，
 *   比让按钮永久失灵好。
 */
let scanBusyAt = 0;
const SCAN_BUSY_MS = 90_000;

/**
 * 扫码反馈统一口（老项目 v7.7.0 同款分流）。
 *
 * 🔴🔴 为什么不直接 setFootStatus：底栏 `#foot` 属于编辑器外壳，
 *   在落地页**根本不存在** —— setFootStatus?.() 里的 `?.` 会静默跳过，
 *   于是"点扫码 → 相机起不来 → 提示写在不存在的地方"= 用户什么都没看到，
 *   只觉得按钮坏了。这正是 SCAN-E06 实锤的那一类。
 *
 * 🔴 自动收回带「文案仍是它才清」守卫（老项目红线 15）：
 *   无守卫时，先来的短提示会被后来的定时器清掉，
 *   症状是"错误信息闪一下就没了"，用户根本来不及读。
 */
let scanMsgTimer: number | null = null;

/**
 * 扫码提示在底栏上的**最短占有时长**。
 * `scanFeedback(msg)` 不传 autoHideMs 时是"常驻"，但常驻不等于永久 ——
 * 底栏那一行同时是同步状态的位置，永久占位等于让同步永远不可见。
 */
const SCAN_HINT_HOLD_MS = 5_000;

function scanFeedback(msg: string, autoHideMs = 0): void {
  if (scanMsgTimer !== null) {
    clearTimeout(scanMsgTimer);
    scanMsgTimer = null;
  }
  if (currentPage === 'editor') {
    // 🔴🔴🔴 必须走**占有窗口**，绝不能裸 `setFootStatus`（v1.13.0 实锤，e2e SCAN-E07）。
    //
    //   病态：裸写只改了那一行的文字，却没告诉"同步状态回写口"这里有人占着。
    //   ⇒ 紧接着到达的 `onSnapshot`（打开笔记后首推完成、编辑落盘…）
    //     走 `footStatus()` 时见到 `footHoldUntil` 仍是 0，判定无人占用
    //     ⇒ 直接写「已同步」，把刚写进去的失败原因**无声覆盖**。
    //     用户视角：点「扫一扫」→ 屏幕上什么都没有 → 底栏闪回「已同步」
    //     ⇒ 只剩一个"点了没反应"的印象，完全没有"为什么"。
    //
    //   🔴 这个洞一直都在，只是被另一个 bug 盖住了：
    //     v1.13.0 之前同步状态会永久停在 pushing（pull 的 merge-clean 分支漏了 push），
    //     底栏于是**不再被刷新**，恰好把这条提示"保住"了。
    //     修好状态机之后同步正常回 idle ⇒ 提示立刻被冲掉 ⇒ SCAN-E07 才红。
    //     ⇒ 教训：**两个 bug 互相掩盖时，修好其中一个会暴露另一个，
    //       所以修完必须跑全量，不能只跑自己那一块。**
    //
    //   🔴 保持 offline（红点）：相机起不来是"这件事没做成"，
    //     不是"同步坏了"——红点只表示这一行当前不是同步状态，与 footFlash 的绿点不同。
    const hold = autoHideMs > 0 ? autoHideMs : SCAN_HINT_HOLD_MS;
    footHoldText = msg;
    footHoldUntil = Date.now() + hold;
    setFootStatus?.('offline', msg);
    scanMsgTimer = window.setTimeout(() => {
      scanMsgTimer = null;
      // 🔴 期间又来了更新的提示 ⇒ 交给它收，别把新的收掉
      if (footHoldText !== msg) return;
      footHoldUntil = 0;
      footHoldText = '';
      const f = footFor(lastSyncState);
      footStatus(f.s, f.d);
    }, hold);
    return;
  }
  const w = document.getElementById('landingScanMsg');
  if (!w) return;
  w.textContent = msg;
  w.classList.remove('hidden');
  if (autoHideMs > 0) {
    scanMsgTimer = window.setTimeout(() => {
      scanMsgTimer = null;
      // 🔴 守卫：只有当前显示的仍是这条消息时才收。
      if (w.textContent === msg) w.classList.add('hidden');
    }, autoHideMs);
  }
}

function openScanner(): void {
  const now = Date.now();
  if (scanBusyAt && now - scanBusyAt < SCAN_BUSY_MS) {
    scanFeedback(COPY.scanBusy);
    return;
  }
  scanBusyAt = now;
  try {
    buildScanLayer({
      onResult: (raw) => {
        // 🔴 命中什么（含空串 = 用户取消）都要放锁，
        //   否则取消一次后 90 秒内点不动扫一扫。
        scanBusyAt = 0;
        if (raw === '') return;
        void handleScanRaw(raw);
      },
      onHint: (text) => {
        // 🔴 取景期的"为什么扫不出"是**常驻状态行**，浮层自己会显示。
        //   这里也写一份是为了浮层收场后（相机失败那条路）原因不丢 ——
        //   浮层一拆，那行字就没了，用户只剩一个"点了没反应"的印象。
        scanFeedback(text);
      },
      onDiag: (d) => {
        scanDiag = d;
      },
      onClosed: () => {
        scanBusyAt = 0;
        // 🔴🔴 收场必须把底栏**恢复成真实同步状态**（用户报障第 10 条）。
        //
        //   病：取景期曾往底栏写过"识别中…"，而底栏那一行是同步状态的位置
        //   （scanFeedback 用的是 setFootStatus('offline', …) ⇒ 红点）。
        //   收场时没人把它收回去 ⇒ 用户取消扫码后看到
        //   「红点 + · 最后同步：识别中…」，而那之前是「绿点 + 已同步」。
        //
        //   🔴 顺序是安全的：layer.ts 的失败路径是**先 onClosed() 后 onHint(reason)**，
        //   所以这里的恢复不会把"相机起不来"这类**终态原因**擦掉 ——
        //   原因总是在恢复之后才到达。
        if (scanMsgTimer !== null) {
          clearTimeout(scanMsgTimer);
          scanMsgTimer = null;
        }
        footHoldUntil = 0;
        footHoldText = '';
        const f = footFor(lastSyncState);
        setFootStatus?.(f.s, f.d);
      },
    });
  } catch (e) {
    scanBusyAt = 0;
    scanFeedback(COPY.scanStartFail);
    console.error('[scan] 取景层构建失败', e);
  }
}

/* ─────────────────────────────────────────────────────────────────────────
 * 扫码换机（备份侧 / 恢复侧）
 *
 * 🔴 口令流：口令由用户在面板里手输，只作为 PBKDF2 的输入被消费，
 *   **既不进二维码、也不进日志、也不进任何 storage**。
 *   生成成功后立刻清空输入框（老项目 index.html:9192 bakPass.value = '' 同款纪律）。
 *
 * 🔴🔴 恢复侧失败时**不写任何东西**：不建笔记、不写缓存、不写 key-store。
 *   这不是"尽量少写"，是硬要求 —— 见 migrate/code.ts 的 restoreMigrateCode 注释。
 *   「恢复失败但原文被清空」比直接报错糟糕得多（用户内容没了还不知道）。
 * ───────────────────────────────────────────────────────────────────────── */

/* ══════════════════════════════════════════════════════════════════════════
 * 甲案：把清单写进云端一篇专用「备份笔记」（老项目 writeBackupNote，:9023-9094）
 *
 * 🔴🔴🔴 存在的理由是**用户报障第 2 条**（二维码密度比老项目大得多）。
 *   旧路线把清单直接打进码里，实测（tools 量化，见 bak-note.ts 文件头）：
 *   1 篇 299B / 100 篇 2043B，而老项目甲案恒定约 86B —— 1 篇就1.7 倍、100 篇 4.1 倍。
 *   甲案把清单搬到云端那篇 `nsbak-xxxxxx` 里，码里只剩它的配对链接 ⇒ 恒定。
 *
 * 🔴 加密边界：**密钥派生与正文加密全部走 shared-schema 那唯一一份**
 *   （deriveKey / encryptString(..., 'note', dk)），与正常笔记同一个 AAD 域。
 *   ⇒ 服务端从头到尾只见密文（零知识不变），这是本项目的核心红线。
 *
 * 🔴🔴 为什么**不**把本篇挂进 SyncClient：备份笔记有自己的生命周期
 *   （不出现在笔记列表、不跑提醒、不进历史版本的常规语义）。
 *   走 SyncClient 会顺带开 SSE 轮询与去抖推送，而那篇笔记的用户根本不会打开它。
 *   ⇒ 这里直接 fetch，**不经** `saveLocal`/SyncClient（与老项目 apiPutTo 同款）。
 * ─────────────────────────────────────────────────────────────────═══════════════════════════════════ */

/** 拉备份笔记的远端信封。老项目 apiGetTo（:9028）同款。 */
async function fetchBakNote(id: string, f: typeof fetch = fetch): Promise<{ salt: string | null; env: Envelope | null }> {
  let res: TimedResponse;
  try {
    // 🔴 8s 超时（老项目 `withTimeout(apiGetTo(id), 8000)`，index.html:9037）：
    //   出码要逐篇拉信封，半死 socket 下每一枪都挂死 ⇒ 出码永远转圈。
    res = await fetchTextWithTimeout(
      `/api/note/${encodeURIComponent(id)}`,
      { headers: { accept: 'application/json' }, cache: 'no-store' },
      FETCH_TIMEOUT_GET_MS,
      f,
    );
  } catch {
    throw { msg: COPY.bakWriteOffline };
  }
  if (res.status === 429) throw { msg: COPY.bakWriteOffline };
  if (!res.ok) throw { msg: COPY.bakWriteFail };
  const text = res.text;
  if (text.trim() === '') return { salt: null, env: null };
  try {
    const o = JSON.parse(text) as Partial<Envelope>;
    if (typeof o.iv !== 'string' || typeof o.ct !== 'string' || !o.kdf || typeof o.kdf.salt !== 'string') {
      throw { msg: COPY.bakWriteFail };
    }
    return { salt: o.kdf.salt, env: o as Envelope };
  } catch (e) {
    //🔴 JSON.parse 的 SyntaxError 与我们自己抛的 {msg} 在这里混在一起，
    //   必须区分：前者是"云端数据坏了"，后者已经带好了面向用户的句子。
    if (e && typeof e === 'object' && 'msg' in e) throw e;
    throw { msg: COPY.bakWriteFail };
  }
}

/**
 * 写备份笔记（建档 + 覆盖同一把枪）。老项目 apiPutTo（:9063/:9088）同款。
 * @param wk 该备份笔记的写入凭据（老项目 x-note-key 同款；off/new-only 档没有也照写成功）
 */
async function putBakNote(
  id: string,
  env: Envelope,
  plainLen: number,
  f: typeof fetch = fetch,
  wk?: string | null,
): Promise<void> {
  let res: Response;
  try {
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (wk) headers['x-note-key'] = wk;
    res = await f(`/api/note/${encodeURIComponent(id)}`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ ...env, n: plainLen }),
    });
  } catch {
    throw { msg: COPY.bakWriteOffline };
  }
  if (!res.ok) throw { msg: COPY.bakWriteFail };
}

export type BakMakeFail = 'empty' | 'too-long' | 'offline' | 'write' | 'key-lost' | 'crypto';

export interface BakMakeOk {
  ok: true;
  /** 二维码载荷 = 备份笔记的配对链接（**恒定约 86 字节，与篇数无关**）。 */
  link: string;
  /** 备份篇名（出码后屏上要报「备份笔记：nsbak-xxxxxx」）。 */
  bakId: string;
  /** 清单里的篇数（出码提示与只读恢复卡都要报它）。 */
  count: number;
  /** 因本机/服务器都拿不到正文而没带进备份的篇数（如实告知，不谎报已备份）。 */
  skipped: number;
}

export interface BakMakeErr {
  ok: false;
  reason: BakMakeFail;
  message: string;
}

/**
 * 收集每篇的密文信封（自包含收藏备份用，v3 清单）。
 *
 * 🔴🔴 优先级：**服务器 → 本机缓存兜底**（2026-10-08 对抗审计 A3 修订，原为缓存优先）。
 *   备份装的是"这篇笔记现在的内容"，服务器才是真源 —— 本机缓存可能是旧的
 *   （另一台设备改过、这台还没同步），缓存优先会把**旧信封**当真理装进备份，
 *   恢复端又"有缓存就不再查服务器"，用户就会拿到一份静默回滚的旧版笔记。
 *   服务器拿不到（离线/失败/没有正文）时缓存才兜底 —— 离线备份仍可用，只是那篇
 *   装的是本机最后已知的版本（此时它本来就是这台设备能给出的最好的那份）。
 *   两处都没有 ⇒ 这篇当"无内容"（计入 skipped，出码时 bakEnvSkipWarn 明说）。
 *
 * 🔴 与 `collectBakMaterials` 同一条纪律：返回的数组与 `ids` **同下标**，
 *   拿不到的那篇是 null，绝不错位（错位 = "给 A 篇装了 B 篇的正文"）。
 *
 * @returns 与 ids 同下标的信封数组；`skipped` = 两处都拿不到的篇数。
 */
async function collectBakEnvelopes(
  ids: readonly string[],
  f: typeof fetch = fetch,
): Promise<{ envs: (Envelope | null)[]; skipped: number }> {
  const envs: (Envelope | null)[] = [];
  let skipped = 0;
  for (const id of ids) {
    let env: Envelope | null = null;
    try {
      const remote = await fetchBakNote(id, f);
      if (remote.env) env = remote.env;
    } catch {
      /* 离线/失败 ⇒ 落到缓存兜底 */
    }
    if (!env) {
      const cached = readCache(id);
      if (cached) env = envelopeOf(cached);
    }
    if (env) {
      envs.push(env);
    } else {
      envs.push(null);
      skipped++;
    }
  }
  return { envs, skipped };
}

/**
 * 生成换机备份（甲案）：清单 → 加密 → 写进云端一篇 `nsbak-xxxxxx` → 出它的链接。
 *
 * 🔴 口令的边界（与 code.ts 唯一不同，且是有意的）：
 *   口令会进 `link`（配对链接的 `#p=` 装的就是口令）。
 *   老项目的 `#k=` 装的也是一把"扫到即能解锁"的秘密（老项目装密钥，本项目装口令）。
 *   风险等级与配对码完全一致（用户扫的是自己的屏幕），
 *   而收益是"码密度与篇数彻底解耦"（用户报障第 2 条）。
 *
 * 🔴🔴 建档顺序逐字承接老项目（:9043-9062，v10.0.0 三轮复核实锤）：
 *   ① **盐取自服务端**（有则必用，绝不用本机新盐冲掉服务端盐）
 *   ② 新建那一枪先写"空正文 + 带盐"，随后再写真身
 *      —— 漏掉②的症状是"另一台设备打开这篇备份笔记时解不开"，因为它拿不到盐。
 *   ③ 已有正文却解不开 = 密钥/口令不对 ⇒ **当场把本机那把钥作废**，
 *      否则"本机有钥→免口令→又失败"成死循环，而口令框永远读不到（老项目闸 R1）。
 *
 * @param ids 要备份的篇名（已过滤）
 * @param passphrase 用户口令
 * @param now 生成时刻（毫秒）。显式传入便于判据固定时间戳。
 * @param fetchImpl 注入 fetch，便于判据
 * @param idOverride 强制用这个篇名（用户报障第 8 条「在新手机重建备份笔记」）。
 *   🔴 不传 ⇒ 沿用备份槽的篇名（没有就新随机一个），与老项目一致。
 *   🔴 传了 ⇒ **就地重建同一篇**：盐仍取自服务端（`remote.salt`），
 *     所以「同一个口令 + 同一个盐 ⇒ 同一把钥匙」这条链不断，
 *     用户手里那张**旧二维码照旧能用**（它装的是口令，不是篇名）。
 *     这正是"回旧设备重新生成"的等价动作，只是搬到了新设备上做。
 */
export async function makeBakBackup(
  ids: readonly string[],
  passphrase: string,
  now: number = Date.now(),
  fetchImpl: typeof fetch = fetch,
  idOverride?: string,
): Promise<BakMakeOk | BakMakeErr> {
  const slot = readBakSlot();
  // 🔴 就地重建时以 idOverride 为准，且**必须拿它去剔清单**（见下）：
  //   否则重建这篇自己的篇名会被当成一条普通收藏写进清单，换机后收藏夹里凭空多一篇。
  const id = idOverride ?? (slot ? slot.id : newBakId());
  const entries = collectBakEntries(ids, id);
  if (entries.length === 0) return { ok: false, reason: 'empty', message: COPY.migrateNoFav };
  if (entries.length > BAK_MAX) {
    return { ok: false, reason: 'too-long', message: COPY.migrateTooManyFav };
  }

  // 🔴🔴 为每篇装「解锁材料」（用户报障第 3 条）。
  //   出码这台机器上每篇的钥匙早就躺在 keystore 里了，所以这里只做**签名**
  //   （拿真钥匙加密一段定长常量），**不重新派生** ——
  //   600,000 次 PBKDF2 单次 62ms，100 篇重新派生就是 6 秒白等。
  //   本机没钥匙的那篇给 null（恢复后那篇照常要口令，不假装成功）。
  //
  //   🔴🔴 v4：**顺带把每篇自己的口令读出来装进材料**（用户报障「备份笔记携带
  //   各篇自己的口令」）。口令来自本机口令保险箱（用该篇密钥加密存着的，
  //   见 sync/pass-vault.ts）⇒ 换机后**零输入**逐篇派生，与老项目"装 raw key"
  //   对用户是同一种体验。读不到（保险箱没记 / 隐私模式）⇒ 那篇不写 `p`，
  //   恢复时照旧回落"备份码口令 + 自证"，绝不猜、绝不拿别篇的口令顶上。
  const mats = await collectBakMaterials(entries, deriveKeyFor, (id, dk) => readPassVault(id, dk.key));

  // 🔴🔴🔴 自包含收藏备份（用户报障：扫备份码后每篇都要输口令、且全是空的）：
  //   把每篇的**密文信封**（加密正文）也带进备份笔记。恢复端直接 re-push + 写缓存，
  //   无需服务器恰好有正文、也无需逐篇问口令 —— 真正"一键恢复"。
  //   信封是非机密密文，零知识属性不变（见 bak-note.ts 文件头）。
  //   本机缓存优先（离线也能拿），没有的再去服务器拉；两处都没有 ⇒ 这篇当无内容。
  const { envs, skipped } = await collectBakEnvelopes(entries, fetchImpl);

  const doc = buildBakDoc(entries, now, mats, envs);
  if (doc === null) return { ok: false, reason: 'too-long', message: COPY.migrateTooManyFav };

  const plain = canonicalize(doc);

  let remote: { salt: string | null; env: Envelope | null };
  try {
    remote = await fetchBakNote(id, fetchImpl);
  } catch (e) {
    const msg = e && typeof e === 'object' && 'msg' in e ? String((e as { msg: unknown }).msg) : COPY.bakWriteFail;
    return { ok: false, reason: navigator.onLine ? 'write' : 'offline', message: msg };
  }

  // ① 盐取自服务端。有则必用 —— 换盐就是另一把钥匙，必然解不开。
  const saltB64 = remote.salt ?? null;
  let dk: DerivedKey;
  try {
    dk = await deriveKey(passphrase, saltB64 ?? undefined);
  } catch {
    return { ok: false, reason: 'crypto', message: COPY.migrateNeedPass };
  }

  // ③ 已有正文却解不开 = 密钥/口令不对。老项目 :9053-9059：
  //   presetKey 那把（本机存的）要**当场作废**，否则下一次仍然是"免口令→又失败"死循环。
  if (remote.env) {
    try {
      await decryptString(remote.env, dk.key, 'note');
    } catch {
      return { ok: false, reason: 'key-lost', message: COPY.bakKeyLost };
    }
  }

  // ② 建档那一枪：先落盐（正文留空），随后再写真身。
  //   🔴 漏掉它的症状不是报错，而是"另一台设备打开这篇备份笔记解不开"——
  //     它拿到的信封里没有 kdf.salt，无从派生。老项目 v10.0.0 为这三轮顺序复核过。
  if (!remote.env) {
    const seed = await encryptString('', dk.key, 'note', dk);
    try {
      // 备份笔记自己的凭据：从用户输入的备份口令派生（建档即认领，full 档下其它人改不了）
      const seedWk = await deriveWriteKey(id, passphrase, dk);
      await putBakNote(id, seed, 0, fetchImpl, seedWk);
    } catch (e) {
      const msg = e && typeof e === 'object' && 'msg' in e ? String((e as { msg: unknown }).msg) : COPY.bakWriteFail;
      return { ok: false, reason: 'write', message: msg };
    }
  }

  let env: Envelope;
  try {
    env = await encryptString(plain, dk.key, 'note', dk);
  } catch {
    return { ok: false, reason: 'crypto', message: COPY.migrateRenderFail };
  }
  try {
    // 备份笔记自己的凭据：同一把枪（与建档同源，同一 dk ⇒ 同一缓存口径）
    const realWk = await deriveWriteKey(id, passphrase, dk);
    await putBakNote(id, env, plain.length, fetchImpl, realWk);
  } catch (e) {
    const msg = e && typeof e === 'object' && 'msg' in e ? String((e as { msg: unknown }).msg) : COPY.bakWriteFail;
    return { ok: false, reason: 'write', message: msg };
  }

  // 🔴 本机记住"备份槽 + 那把钥"：下次生成可以免口令（老项目 :9091-9094）。
  //   写不进去不失败（下一句 writeBakSlot 内部已catch）—— 槽只是加速器。
  writeBakSlot(id, saltB64 ?? dk.saltB64);
  await putKey({ id, key: dk.key, salt: dk.saltB64, iter: dk.iter, savedAt: Date.now() });
  // 🔴 备份笔记**自己的口令**也存进保险箱（用它的密钥加密）——
  //   这样"收藏变更后自动刷新备份笔记"（refreshBakNote）在刷新页面、记忆解锁之后
  //   仍拿得出口令，不必依赖 sessionPass（那是**当前这篇**的口令，未必是备份笔记那把）。
  //   与其它保险箱条目同口径：没有密钥这团密文什么都不是，锁定即失效。
  await savePassVault(id, passphrase, dk);

  return { ok: true, link: buildBakLink(location.origin, id, passphrase), bakId: id, count: entries.length, skipped };
}

/** 篇名形状闸：`nsbak-xxxxxx`。零成本，老项目 BAK_ID_RE 同款。 */
export function isBakNoteId(noteId: string): boolean {
  return /^nsbak-[a-z0-9]{6}$/.test(noteId);
}

/* ─────────────────────────────────────────────────────────────────────────
 * 收藏变更 → 自动刷新备份笔记（v4）
 *
 * 🔴🔴 为什么必须自动刷新：v4 起恢复卡上**没有**「本机重建」按钮
 *   （用户报障「备份笔记携带各篇自己的口令」⇒ 不必再靠重建换口令）。
 *   老项目要更新备份得回旧设备点一次「扫码换机」重新出码 ——
 *   而用户报障的正是"旧设备不在手边 / nsbak-xxxxxx 重建不出来"。
 *   于是把「更新备份」从"用户动作"改成"收藏变更的副作用"：
 *   本机有备份槽（说明这台设备出过码）时，收藏夹一变就把清单重写一遍。
 *
 * 🔴 三条前置（缺一条就**不刷**，绝不硬造一篇备份）：
 *   ① 本机有备份槽（`readBakSlot`）—— 没有槽 = 这台设备从没出过码，
 *      凭空建一篇 `nsbak-xxxxxx` 是往云端写一篇用户没要的笔记；
 *   ② 槽那篇的**密钥在 key-store**（`resolveKey`）—— 没有密钥就拿不到它的盐；
 *   ③ 槽那篇的**口令在保险箱**（`readPassVault`）—— 没有口令就派不出同一把钥，
 *      硬刷会换盐 ⇒ 旧二维码失效（老项目闸 R1 记的正是这个形状）。
 *   三条都是"本机记住了才刷"，与老项目"记忆过的设备才拿得出口令"等价。
 *
 * 🔴 失败一律**静默**（fire-and-forget）：这是收藏操作的一个副作用，
 *   刷新失败（离线/隐私模式）不该让用户刚做的收藏动作弹个错。
 *   下次用户主动出码时 makeBakBackup 会照常重建（盐取自服务端，同一把钥）。
 * 🔴 `bakRefreshInFlight` 防重入：连点收藏会连发几次刷新，
 *   并发写同一篇会让后到的旧清单盖掉先到的新清单。
 * 🔴🔴 但防重入**不能是"丢弃式"**（对抗审 MINOR）：飞行中到达的那次收藏变更
 *   若直接 `return` 丢掉，备份就停在**旧快照**，而用户刚做的收藏（他以为
 *   已经进了备份）永远刷不进去。改成 **coalescing**：飞行中只记一笔
 *   `bakRefreshQueued`，落地后再跑一轮 —— 保证"最后一次变更一定反映到备份"。
 */
let bakRefreshInFlight = false;
/** 飞行中又来了新请求 ⇒ 落地后再跑一轮（不丢最后一次变更）。 */
let bakRefreshQueued = false;
async function refreshBakNote(): Promise<void> {
  if (bakRefreshInFlight) {
    bakRefreshQueued = true;
    return;
  }
  const slot = readBakSlot();
  if (!slot) return;
  bakRefreshInFlight = true;
  try {
    do {
      bakRefreshQueued = false;
      await refreshBakNoteOnce(slot.id);
    } while (bakRefreshQueued);
  } finally {
    bakRefreshInFlight = false;
  }
}

/** 单轮刷新：读钥匙 + 读口令 + 采集 + 就地重建。任一步缺失即静默放弃这一轮。 */
async function refreshBakNoteOnce(slotId: string): Promise<void> {
  try {
    const rec = await resolveKey(slotId);
    if (!rec) return;
    const pass = await readPassVault(slotId, rec.key);
    if (!pass) return;
    const ids = collectBakEntries(favBackupSourceIds(), slotId);
    if (ids.length === 0) return;
    // 🔴 idOverride = slot.id：**就地重建同一篇**（盐取自服务端 ⇒ 同一把钥 ⇒ 旧码照用）。
    await makeBakBackup(ids, pass, Date.now(), fetch, slotId);
  } catch {
    /* 静默：刷新失败只是"备份暂时没跟上收藏"，不影响收藏本身 */
  }
}

/**
 * 已解开一篇之后：若它是备份笔记，**开只读恢复卡并吃掉这次落地**。
 *
 * 🔴🔴 三条进入路径必须共用它（老项目 applyUnlocked:3464 只有那一处）：
 *   ① 扫码落地 handleScanRaw ② 手输口令 showPass ③ 记忆解锁 route()
 *   漏掉②③的症状与"功能没实现"一模一样，但更隐蔽：**在旧设备上刷新一下
 *   `/nsbak-xxxxxx` 这个 URL**，route() 走记忆解锁直接 mountEditor，
 *   清单就落进了 contenteditable —— 甲案误编辑三闸的第①闸被从后门打开。
 *
 * @returns true = 这是备份笔记，已进恢复卡，调用方**不要**再挂编辑器
 */
export function presentBakDoc(
  noteId: string,
  doc: Doc,
  dk: DerivedKey,
  passphrase: string,
  f: typeof fetch = fetch,
): boolean {
  if (!isBakNoteId(noteId)) return false;
  const manifest = readBakManifest(doc);
  if (manifest === null) {
    // 形状对但清单解不开：老项目 :9124 的口径。它与"普通笔记"要分开说 ——
    //   后者根本不会走到这里（篇名形状已经挡住了）。
    showUploadNote('bad', COPY.bakRestBroken, COPY.uploadFailMs);
    return true;
  }
  // 🔴🔴 老项目 enterBackupMode:9225 `writeBakSlot(noteId, note.salt)` 逐字承接：
  //   打开备份笔记 ⇒ 把它记成**本机的换机备份**（"恢复/以后更新都靠它"）。
  //   这同时是"收藏变更自动刷新备份笔记"（refreshBakNote）的接线：
  //   槽在，refreshBakNote 才知道该刷哪一篇。
  writeBakSlot(noteId, dk.saltB64);
  // 🔴🔴 备份笔记**自己的口令**存进保险箱（用它的密钥加密）——
  //   这样这台设备"记住了"它，refreshBakNote 在刷新页面/记忆解锁之后仍拿得出口令。
  //   fire-and-forget：存不下（隐私模式）不影响打开恢复卡。
  if (passphrase !== '') void savePassVault(noteId, passphrase, dk);
  // 🔴 三闸之①：清单**绝不进 contenteditable**。这里根本不挂编辑器，
  //   恢复卡是唯一呈现。老项目 enterBackupMode 还要先 contentEditable=false，
  //   bj 直接不挂 —— 那比"挂了再锁"少一整条漏锁的路径。
  history.replaceState({}, '', '/' + encodeURIComponent(noteId));
  // 🔴🔴 传的是**清单的材料**，不是备份笔记自己的钥匙。
  //   `dk` 是解开这篇备份笔记的那把钥匙（用来解密清单正文），
  //   而各篇的钥匙必须用**口令 + 各篇 salt** 重新派生再自证 ——
  //   备份笔记的钥匙与收藏夹里那些钥匙毫无关系，拿它去开收藏夹是错的。
  //   🔴 `passphrase` 作为**回落口令**传下去：v4 清单各篇自带 `p` 时用不上它，
  //     但 v1/v2/v3 老备份没有 `p`，只能靠"解开备份笔记那把口令"（老项目的模型）。
  showBakRestoreCard(noteId, manifest.ids, manifest.ts, manifest.mats, manifest.envs, passphrase, f);
  return true;
}

/**
 * 恢复侧：扫到备份笔记链接 → 解开清单 → **只读恢复卡**（老项目 enterBackupMode，:9220-9234）。
 *
 * 🔴🔴 失败时**不写任何东西**：不 merge 收藏、不写 key-store、不动编辑器。
 * 🔴 这条路**必须**在 mountEditor 之前判完（见 handleScanRaw 的接线）：
 *   备份笔记一旦挂上编辑器，用户就能编辑它 —— 那就破了甲案误编辑三闸的第①闸。
 *
 * @returns true = 这是备份笔记，已进恢复卡（或已报错），调用方**不要**再挂编辑器
 */
export async function tryEnterBakMode(noteId: string, passphrase: string, f: typeof fetch = fetch): Promise<boolean> {
  // 🔴🔴 必须**先按篇名形状**判，而不是"解开看看是什么"：
  //   逐篇解密去问"你是不是备份笔记"会给每个篇名白跑一次 PBKDF2，
  //   而且失败文案会变成"口令不对" —— 用户扫的是一篇正常笔记也会看到那句。
  //   篇名形状是**零成本、可判定**的第一道闸（老项目 BAK_ID_RE 同款）。
  if (!isBakNoteId(noteId)) return false;

  let doc: Doc;
  let dk: DerivedKey;
  try {
    const r = await unlock({ noteId, passphrase, fetchImpl: f });
    if (!r.ok) {
      // 🔴 与手输口令**同一句文案**（ARCH 安全不变量）：绝因为"是从二维码来的"
      //   就换成更具体的原因 —— 那等于给暴力破解一个 oracle。
      showUploadNote('bad', r.message, COPY.uploadFailMs);
      return true;
    }
    doc = r.doc;
    dk = r.dk;
  } catch {
    showUploadNote('bad', PASS_ERROR, COPY.uploadFailMs);
    return true;
  }

  // 判定与呈现交给同一个函数 —— 扫码/手输/记忆三条路共用它（见 presentBakDoc 的注释）。
  return presentBakDoc(noteId, doc, dk, passphrase, f);
}

/** 开只读恢复卡，并把「恢复这 N 篇」接到生产合并链路。 */
function showBakRestoreCard(
  noteId: string,
  ids: readonly string[],
  ts: number,
  mats: readonly (BakMaterial | null)[],
  envs: readonly (Envelope | null)[],
  fallbackPass: string,
  f: typeof fetch = fetch,
): void {
  buildBakRestoreCard({
    ids,
    ts,
    // 🔴🔴 v4 恢复**零输入**：清单里的材料自带各篇口令（`p`），恢复端逐篇派生 + 自证，
    //   不再需要"本批共用口令"输入框。口令仍可能来自扫码那一下的 `sessionPass`
    //   （v1/v2/v3 老备份没有 `p`，只能靠它）—— 所以这里仍把它当回落值传下去。
    //   🔴 恢复卡上**没有**口令框了（用户报障：备份笔记携带各篇口令 ⇒ 不必再问）。
    onGo: async () => {
      // 🔴 回落口令 = **解开这篇备份笔记那把**（presentBakDoc 传下来的），
      //   而不是 sessionPass —— 扫码进备份笔记时 sessionPass 还没被赋值
      //   （handleScanRaw 在 tryEnterBakMode 之后才写它），靠 sessionPass 会让
      //   老备份（无 `p`）全部 needPass。v4 清单各篇自带 `p` 时这个回落用不上。
      const pass = fallbackPass;
      // 🔴🔴 先自证 + 写钥匙，**再**合并收藏夹。
      //   顺序不能反：自证要 100 篇次 PBKDF2（单次 62ms ⇒ 最坏 6 秒多），
      //   而恢复卡按钮已经先置灰成「正在恢复…」，用户看得见进度（老项目 :9242 同款）。
      //   先合并后自证的话，用户已经"恢复成功"跳走了，钥匙才在后台慢慢写 ——
      //   而 route() 早就跑完了，命中的是"没钥匙"分支，照样弹口令框。
      const r = await applyBakRestore(ids, mats, envs, pass, f);
      if (!r.ok) throw new Error(r.message);
      // 🔴 与老项目 :9274-9278 同款：恢复完整页跳第一篇。
      //   理由与老项目一致 —— 只 setStatus 的话，首页页脚会被落地页盖住，
      //   用户看着"粘完没反应"（老项目闸 R2-P1-2 的事故形状）。
      location.href = '/' + encodeURIComponent(r.first as string);
      return r.message;
    },
    onCancel: () => {
      // 🔴 只读态**刻意不归还编辑器焦点**（老项目 :9238 原话「故刻意不补」）：
      //   这篇根本不该编辑，还焦点等于把光标放进一篇锁死的笔记里。
      showUploadNote('ok', COPY.bakRestReadonly, COPY.uploadFailMs);
    },
  });
}

interface BakRestoreOutcome {
  ok: boolean;
  message: string;
  first?: string;
}

/**
 * 把清单并进本机收藏夹。与 applyFavBackupRestore **同一条生产合并口径**。
 *
 * 🔴🔴 为什么不复用 applyFavBackupRestore 那个函数本体：
 *   那条路的第一步是"解一个 nsfav1: 码"，而甲案的清单是从**云端那篇笔记**读出来的
 *   （已经解开了）。硬套会把"已经解开的清单"再塞进一个码里解一遍 ——
 *   600,000 次 PBKDF2 白跑一次，而且形状不合还会直接判 not-migrate。
 *   ⇒ 复用的是它**之后**那一段（合并 + 覆盖统计 + 写盘 + 如实报数），
 *     抽成本函数，两条路共用，绝不各写一份合并逻辑。
 *
 * 🔴🔴🔴 用户报障第 3 条在这里落地：**自证通过才写钥匙**（`onPutKey`）。
 *   口令优先取恢复卡输入框（`pass`），留空则由调用方回落到扫码那一下拿到的
 *   `sessionPass`（配对链接 `#p=` 里那个）——
 *   它就是全部收藏夹的通行证，与老项目"扫到即拿到全部钥匙"对用户是同一种体验，
 *   只是底下走的路不同（老项目装 raw key，这里口令现派生）。
 *   `pass` 为空（记忆解锁进来、保险箱里没口令）⇒ 一篇都不豁免，
 *   全部照常走正常口令框。**宁可多问一次，也不给错钥匙。**
 *
 * 🔴🔴 `pass` 由调用方解析（`entered || sessionPass`）后传入，本函数**不再自己读
 *   sessionPass** —— 否则恢复卡输入框会被无声忽略（用户填了别的口令也不生效）。
 */
async function applyBakRestore(
  ids: readonly string[],
  mats: readonly (BakMaterial | null)[],
  envs: readonly (Envelope | null)[],
  pass: string,
  f: typeof fetch = fetch,
): Promise<BakRestoreOutcome> {
  if (ids.length === 0) return { ok: false, message: COPY.migrateNothingRestored };

  // 篇名 → 这一篇**实际自证通过用的口令**（供后面 re-push 派生写入凭据复用）。
  // 🔴🔴 必须用 proveBakMaterials 回传的 effPass，不许自己再调 materialPass 重算：
  //   `p` 自证失败后回落到备份码口令并成功时，重算会拿到那个**没通过自证**的 `p`
  //   ⇒ 保险箱记错口令、凭据派生错 ⇒ 那篇改完存不进服务器（full 档 403）（对抗审 MAJOR 修）。
  const effPassById = new Map<string, string>();

  const pre = await proveBakMaterials(ids, mats, pass, async (id, dk, effPass) => {
    // 🔴 `savedAt` 用固定 0：那不是"解锁时间"，是"这次恢复顺手记住的"，
    //   与 unlock.ts:191 的写入同口径（走的是同一条 key-store 通路）。
    await putKey({ id, key: dk.key, salt: dk.saltB64, iter: dk.iter, savedAt: Date.now() });
    effPassById.set(id, effPass);
    // 🔴🔴 把该篇口令也存进保险箱（用户报障 v4 的配套）：恢复后这台设备就"记住了"
    //   这篇的口令 ⇒ 之后编辑保存能带 `x-note-key`（凭据闸 `full` 档才写得进服务器），
    //   与老项目"记忆过的设备永远拿得出凭据"等价。
    //   口令来源：v4 材料自带的 `p` 优先；`p` 自证失败回落到扫码口令并成功时用扫码口令。
    if (effPass !== '') await savePassVault(id, effPass, dk);
    // 🔴🔴 envs 传下去 ⇒ proveBakMaterials 会做**第二道自证**（钥匙必须真解得开该篇信封），
    //   挡住"材料自证通过、但那把钥匙打不开该篇正文"的陈旧 keystore ⇒ 空编辑器（对抗审 BLOCKER）。
  }, envs);

  // 🔴 hadBefore 必须在**写入前**取（老项目 :9262 v7.7.0「对抗审」）。
  //   写完再查就永远是 true ⇒ renewed 恒等于条数 ⇒
  //   「（覆盖 N 篇旧密钥）」成永远在喊的假警报，几次之后用户就不看了。
  const before = new Set(readFavs(favStore));
  let renewed = 0;
  for (const id of ids) if (before.has(id)) renewed++;

  // 合并顺序：备份优先序在前，本机已有并入尾部（老项目 :9265-9267）
  const merged = mergeFavs(ids, readFavs(favStore));
  const count = Math.min(merged.length, FAVS_MAX);
  const capped = merged.length > FAVS_MAX ? merged.length - FAVS_MAX : 0;

  const stored = writeFavs(favStore, merged);
  // 🔴 落盘后必须以**真存下去的东西**为准。writeFavs 在隐私模式/配额满时
  //   静默写不进去，此时报"已恢复 N 篇"就是**谎报**。
  if (stored.length === 0) return { ok: false, message: COPY.migrateFavWriteFail };

  menuState.favList = favListOf(favStore);
  menuRef?.render();

  // 🔴🔴🔴 自包含收藏备份（v3）落地：把每篇密文信封**写进本机缓存 + 必要时 re-push 服务器**。
  //   这样恢复后每篇收藏的正文**就在本机**，打开即见、不再逐篇问口令、也不再是空的 ——
  //   即便服务器恰好没正文，也能从备份里捞回来（"无论口令是否同一个都能正常恢复"）。
  //   🔴 顺序：先写本机缓存（离线也能读），再"服务器没正文才补推"，绝不覆盖服务器上更新的内容。
  let envRestored = 0;
  let noContent = 0;
  for (let i = 0; i < ids.length; i++) {
    const id = ids[i];
    if (id === undefined) continue; // noUncheckedIndexedAccess：下标越界保护
    const env = envs[i];
    if (!env) {
      // 这篇备份时没拿到正文 ⇒ 探一下服务器有没有；两处皆无就是"恢复后为空"，如实报。
      // 🔴 离线探不了 ⇒ 不计入 noContent（宁可不报，也不谎报"会是空的"）。
      try {
        const remote = await fetchBakNote(id, f);
        if (!remote.env) noContent++;
      } catch { /* 离线/失败：无法判定，不算 */ }
      continue;
    }
    // 🔴🔴 顺序：先探服务器，再决定缓存写哪份（对抗审计 A3 修订，原为"先写备份信封"）。
    //   服务器有正文 ⇒ 缓存**镜像服务器**（那才是最新版；用备份里的旧信封盖掉它
    //   等于把用户刚换机的笔记静默回滚到备份时刻）。服务器没有 ⇒ 备份信封
    //   re-push 补回服务器 + 写缓存。离线 ⇒ 备份信封先进缓存兜底（离线也能读）。
    try {
      const remote = await fetchBakNote(id, f);
      if (remote.env) {
        try {
          writeCache(id, remote.env);
        } catch { /* 隐私模式/配额满：忽略，在线时 unlock 会从服务器拿 */ }
      } else {
        try {
          // 每篇**自己的**凭据：口令 + 该篇信封里的 salt 派生（清单的材料不是备份笔记的钥匙，
          // 与上面 proveBakMaterials 同一口径）。🔴 口令取**自证通过那一篇实际用的 effPass**
          // （proveBakMaterials 回传）—— 用错口令派生出的凭据在 full 档会被服务端拒，那篇就推不上服务器。
          // 🔴 未免输的篇（needPass）这里取不到 ⇒ 无凭据 ⇒ putBakNote 不带 `x-note-key`：
          //   那篇本来就没验证出口令，宁可不带凭据（可能 403），也不拿错口令去派生。
          const effPass = effPassById.get(id) ?? '';
          const wkI = effPass ? await deriveWriteKey(id, effPass, { saltB64: env.kdf.salt, iter: env.kdf.iter }) : null;
          await putBakNote(id, env, 0, f, wkI);
          envRestored++;
        } catch { /* 推送失败：下面仍把备份信封写进缓存兜底 */ }
        try {
          writeCache(id, env);
        } catch { /* 隐私模式/配额满：忽略 */ }
      }
    } catch {
      /* 离线/失败：本机先把备份信封写进缓存兜底，恢复后离线也能读正文 */
      try {
        writeCache(id, env);
      } catch { /* 隐私模式/配额满：忽略 */ }
    }
  }

  return {
    ok: true,
    first: merged[0] as string,
    // 🔴 如实报数：免输几篇、还要口令几篇（用户报障第 3 条）。
    //   收藏夹那套口径（favRestoreTip，含覆盖/截断统计）也一起留着 ——
    //   用户真正要知道的是"我的收藏夹现在对不对"，免输只是附带的好消息。
    // 🔴🔴 v3 再补两段如实报数：envRestored（正文从备份直接救回几篇）与 noContent
    //   （备份没带正文、服务器也没有 ⇒ 恢复后必然空的几篇）——两头都不许静默。
    message: favRestoreTip(count, renewed, capped, FAVS_MAX) +
      COPY.bakRestExemptTip(pre.exempt.length, pre.needPass.length) +
      (envRestored > 0 ? COPY.bakEnvRestoredTip(envRestored) : '') +
      (noContent > 0 ? COPY.bakNoContentTip(noContent) : ''),
  };
}

/**
 * 备份侧：菜单「扫码换机」进来。
 *
 * 🔴🔴🔴 备份范围 = **收藏夹全部**（老项目 v10.1.7 定稿，index.html:8997-8998
 *   逐字：「备份范围（v10.1.7 定稿）：**只备份收藏夹**，没有例外、也没有开关。」）。
 *   本函数此前只打包**当前这一篇**（buildMigrateCode(doc)）——
 *   那是本项目自造的形态，老项目**根本没有"备份当前这一篇"这个功能**，
 *   所以它不是"多了一个功能"，而是**备份范围与老项目不一致**（用户报障第 4 条）。
 *
 * 🔴 沿革（写下来防止有人"顺手加个开关回来"）：老项目 v10.1.4 擅自把范围扩到全部笔记，
 *   v10.1.5 回退成"默认只收藏"并加了勾选框，v10.1.7 用户明确「只备份收藏夹」，
 *   勾选框一并删除 —— **少一个开关就是少一条状态**，多一个勾选框就多一份
 *   "上次备份和这次备份范围不一样"的悬念。
 *
 * 🔴 清单里**只有笔记名、不装密钥**（与老项目的架构性分叉，理由见 fav-backup.ts 文件头）：
 *   本项目的 CryptoKey 是 extractable:false，WebCrypto 层面物理上导不出raw 字节。
 *   恢复端按 PBKDF2(口令, 该篇信封里的 salt) 现派生，与 unlock.ts:174 同一条路。
 *
 * 🔴 锁定态仍要拦：老项目 index.html:9117 `if (!cryptoKey) { setStatus(false,'解锁后才可生成换机码') }`。
 *   本项目沿用既有口径 COPY.migrateNeedUnlock（「请先解锁」，老项目同款，不自造句子）。
 */
function openMigrateMake(): void {
  const doc = window.__NOTESYNC_DOC__?.();
  if (!doc) {
    setFootStatus?.('offline', COPY.migrateNeedUnlock);
    return;
  }
  // 本机收藏原序 = 用户优先级。🔴 甲案的清单要**剔掉备份槽自身**
  //   （老项目 collectBackupEntries 同款）—— 否则上一次备份生成的那篇 `nsbak-xxxxxx`
  //   会被当成一条普通笔记写进清单，换机后用户收藏夹里多出一篇他没收藏过的笔记。
  //   剔的动作交给 `makeBakBackup` 内部的 collectBakEntries（与钩子同源），
  //   这里只负责"有没有可备份的"这一层预判。
  const slot = readBakSlot();
  const ids = collectBakEntries(favBackupSourceIds(), slot ? slot.id : null);
  buildMigratePanel({
    mode: 'make',
    // 🔴 甲案的引导句（老项目 :801 那句的「密钥」改「篇名」，理由见 panel.ts 的注释）
    makeLeadHtml: COPY.migrateBakLeadHtml,
    // 🔴🔴 免口令直出码：本机当前会话**已持有口令**时直接出码，不再要口令框
    //   （老项目 index.html `if (preKey) { await doBakGenerate(preKey); return; }` 同款）。
    //   本项目口令在 `sessionPass` 里、面板不持有，所以由这里传进去；
    //   「记忆解锁」进来的会话 sessionPass 为空 ⇒ 传 null ⇒ 仍要口令框（与老项目一致）。
    preKey: sessionPass === '' ? null : sessionPass,
    // 🔴 预判放在生成之前：收藏夹是空的就别白跑 600,000 次 PBKDF2，
    //   也别往云端白写一篇 `nsbak-xxxxxx`（写了就是一篇谁也没备份的空笔记）。
    //   超限时**明说装不下**，绝不静默截断（截断 = 用户以为全备份了、实际丢了收藏且不会知道）。
    precheck: () => (ids.length > 0 ? null : COPY.migrateNoFav),
    onMake: async (passphrase) => {
      // 🔴🔴 必须回写 lastMigrateCode ——「取最近一次生成的码」只有一个真源。
      //   此前只有测试钩子 __NOTESYNC_MIGRATE_MAKE__ 会写它，而**面板走的不是那条路**
      //   ⇒ 走真实用户路径（点菜单 → 扫码换机）生成的码，从取码口读回来是空串。
      //   探针实测：DOM 里码明明在（#migrateQrHolder[data-code] 有完整内容），
      //   `__NOTESYNC_MIGRATE_CODE__()` 却返回 "" ——判据与产物脱节。
      //   免口令直出码（preKey）那条路同样经过这里，所以一并修好。
      //
      // 🔴🔴 传**本机清单**（ids，上面已剔掉备份槽），不是重新调 favBackupSourceIds()：
      //   precheck 判的是 ids 非空，若两处口径不同，会出现"预判说有、生成说没有"
      //   或者反过来 —— 而那只有点一次菜单才能复现。
      const r = await makeBakBackup(ids, passphrase);
      if (!r.ok) {
        // 🔴 失败文案按 reason 分派，**不**全部塌成一句"生成失败"：
        //   'key-lost'（本机那把备份钥失效）与 'offline'（离线）是两条完全不同的
        //   用户动作，前者要重输口令、后者要联网。塌成一句用户就只能反复重试。
        return { ok: false, reason: r.message };
      }
      lastMigrateCode = r.link;
      lastMigrateBakId = r.bakId;
      lastMigrateFavCount = r.count;
      lastMigrateBakSkipped = r.skipped;
      lastMigrateTip = COPY.migrateBakScanTip(r.count) +
        (r.skipped > 0 ? COPY.bakEnvSkipWarn(r.skipped) : '');
      return { ok: true, code: r.link };
    },
    // 🔴 出码提示的篇数**取自当次出码的真实结果**（lastMigrateFavCount，由上面那次
    //   onMake 写入），而不是闭包里那份 ids ——
    //   面板开着的时候用户可能又收藏/取消收藏，闭包那份 ids 已经过期，
    //   屏上会报"一键恢复 3 篇"而码里其实是 4 篇（老项目 :9187 用的是 col.f.length，
    //   同样是**出码那一刻**的清单，不是开面板那一刻的）。
    // 🔴🔴 skipped（没装进正文的篇数）必须跟着一起呈现 —— 现算 tip 时若只拼篇数，
    //   onMake 里拼好的警告会被这条重算覆盖掉，静默缺口又回来了。
    scanTip: () =>
      lastMigrateFavCount > 0
        ? COPY.migrateBakScanTip(lastMigrateFavCount) +
          (lastMigrateBakSkipped > 0 ? COPY.bakEnvSkipWarn(lastMigrateBakSkipped) : '')
        : lastMigrateTip || COPY.migrateScanTip,
    // 🔴 老项目 :9186 那行「备份笔记：nsbak-xxxxxx」是**独立一行**（#bakBakId），
    //   不是拼进 tip —— 换机时用户要靠它对号/手输，混在一句指引里就找不到了。
    scanIdLine: () => (lastMigrateBakId ? COPY.migrateBakIdLine(lastMigrateBakId) : ''),
    onClosed: () => {
      // 🔴 扫码换机弹层关闭：与其它浮层同款守卫（触屏不还焦点 = 不弹键盘）。
      restoreEditorFocusOnClose();
    },
  });
}

/**
 * 恢复侧：喂码 + 口令 → 解密 → 写进编辑器并落缓存。
 *
 * 🔴🔴 写入顺序是有讲究的，**不能反**：
 *   先解密成功（拿到可信 doc）→ 再写缓存 → 最后挂编辑器并通知同步推。
 *   反过来做（先挂编辑器再解密）的话，一次失败就会把用户**当前正文**换成空文档 ——
 *   而那次恢复本来就是失败的，等于"失败的换机把原文擦了"。
 */
async function applyMigrateRestore(code: string, passphrase: string): Promise<{ ok: true } | { ok: false; reason: string }> {
  const env = readMigrateEnvelope(code);
  if (env === null) return { ok: false, reason: COPY.migrateNotMigrate };

  const r = await restoreMigrateCode(code, passphrase);
  if (!r.ok) {
    // 口令错/码被改 → 同一句文案，不区分（ARCH 安全不变量）
    return { ok: false, reason: PASS_ERROR };
  }

  // 🔴 缓存与 key-store 用**重封**后的信封，不能直接用换机码那份
  //   （载荷是 pad 过的 JSON，塞进缓存会让"缓存 == 真源"这条不变量破掉，
  //   离线读到的与在线读到的会分叉。见 migrate/code.ts 的 resealMigrateDoc）。
  const resealed = await resealMigrateDoc(r.doc, passphrase, env);
  if (resealed) {
    const dk = await deriveKey(passphrase, env.kdf.salt);
    // 🔴 用 currentNote（模块级，main.ts:528）而不是函数局部的 name：
    //   恢复是**跨设备**动作，写入目标必须是"当前打开的这篇"，
    //   拿错变量会把密钥/缓存写到别的篇名上 —— 那症状是
    //   "恢复成功了，但换台设备打开还是空的"，极难自查。
    await putKey({ id: currentNote, key: dk.key, salt: dk.saltB64, iter: dk.iter, savedAt: Date.now() });
    writeCache(currentNote, resealed);
  }

  // 挂编辑器：走**现成的** docToLexical 反序列化（不另写一套，见 serialize.ts）
  editor?.update(
    () => {
      docToLexical(r.doc);
    },
    { discrete: true },
  );
  // 🔴 迁移回来的真源是**老项目格式**，正文里的裸网址带 ZWSP
  //   （老项目 linkify 插的，见 linkify/recognize.ts 的 stripZeroWidth 注释）。
  //   换机恢复后必须重跑识别，否则用户看到的是"恢复了但网址全没了格式"。
  linkifyNowRef?.();
  // 🔴 不在这里赋值 latestDoc：它是 mountEditor 的闭包局部变量（main.ts:989），
  //   而 registerUpdateListener 会在 docToLexical 触发的那次 update 里
  //   **自动**把最新真源写回 latestDoc（main.ts:1015 `latestDoc = rec.doc`）。
  //   在这里另写一份是多余的，而且会与监听器形成两个写入口 ——
  //   那种"两个地方都以为自己是真源"的局面正是 main.ts:958-977 记的那类静默故障。
  //
  // 通知同步把恢复出来的内容推上云端 —— 否则换机后的内容只活在这一台设备上。
  // 🔴 走 noteEdit 而不是直连 push：那是生产推送的唯一入口，
  //   自己另调一条会把去抖/版本协商/409 重试全绕过去。
  syncRef?.noteEdit();
  return { ok: true };
}

/** 恢复侧：从菜单/落地页进来（扫到码或手粘码都走它）。 */
function openMigrateTake(initialCode?: string): void {
  buildMigratePanel({
    mode: 'take',
    onTake: (code, passphrase) => applyMigrateRestore(code, passphrase),
    onClosed: () => {
      // 🔴 扫码换机弹层关闭：与其它浮层同款守卫（触屏不还焦点 = 不弹键盘）。
      restoreEditorFocusOnClose();
    },
  });
  if (initialCode) {
    const el = document.getElementById('migrateCodeIn') as HTMLTextAreaElement | null;
    if (el) el.value = initialCode;
  }
}

/* ─────────────────────────────────────────────────────────────────────────
 * 收藏备份码的恢复侧（用户报障第 4 条的另一半）
 *
 * 🔴🔴🔴 与单篇换机恢复**根本不同**：
 *   单篇恢复动的是**当前这一篇正文**（decrypt → 挂编辑器 → 推同步）；
 *   收藏恢复动的是**收藏夹名单**，**一个字正文都不碰**。
 *   把两条路混起来写会出现最恶心的症状：扫一次收藏码，当前正在写的笔记被覆盖。
 *   ——所以这里是独立函数，不是 applyMigrateRestore 加个分支。
 *
 * 🔴 老项目形状（index.html:9218-9280，三段照抄）：
 *   ① 只读恢复卡：先列篇名 + 「恢复这 N 篇」，用户**确认后**才写盘
 *   ② applyBackupEntries：先算覆盖（写前取）→ 合并收藏 → 写 → 如实报提示
 *   ③ 提示逐字：'已恢复 N 篇收藏' +（覆盖 N 篇旧密钥）+（收藏夹满…已丢弃最旧 N 项）
 *
 * 🔴🔴 **本项目的密钥不写回**（与老项目的架构性分叉，见 fav-backup.ts 文件头）：
 *   清单里只有笔记名，密钥在新设备上按 PBKDF2(口令, 该篇信封里的 salt) 现派生。
 *   所以"恢复"在本项目就是**把收藏名单装回去**这一步 ——
 *   用户随后打开其中任一篇时，走 unlock 那条路自然解开。
 *   ⇒ 因此**不写 key-store、不写缓存、不动编辑器、不推同步**。
 *   （动了反而危险：推同步会把"收藏夹变了"当正文编辑发上云端。）
 * ───────────────────────────────────────────────────────────────────────── */

/**
 * 喂收藏备份码 + 口令 → 合并进本机收藏夹。
 *
 * 🔴🔴 失败时**不写任何东西**（同 applyMigrateRestore 的硬要求）：
 *   {ok:false} 分支上没有 writeFavs 调用。
 *   「恢复失败但收藏夹被清空」比直接报错糟糕得多 ——
 *   用户会因为"看起来恢复成功过"而删掉旧设备上的收藏。
 */
async function applyFavBackupRestore(
  code: string,
  passphrase: string,
): Promise<
  | { ok: true; count: number; renewed: number; capped: number }
  | { ok: false; reason: string }
> {
  const r = await restoreFavBackupCode(code, passphrase);
  if (!r.ok) {
    // 口令错/码被改 → 同一句文案，不区分（ARCH 安全不变量）
    if (r.reason === 'pass') return { ok: false, reason: PASS_ERROR };
    if (r.reason === 'not-migrate') return { ok: false, reason: COPY.migrateNotMigrate };
    return { ok: false, reason: COPY.migrateRenderFail };
  }
  if (r.ids.length === 0) {
    return { ok: false, reason: COPY.migrateNothingRestored };
  }

  // 🔴🔴 hadBefore 必须在**写入前**取（老项目 index.html:9262 v7.7.0「对抗审」）。
  //   写完再查就永远是 true ⇒ renewed 恒等于条数 ⇒
  //   「（覆盖 N 篇旧密钥）」这句话就成了永远在喊的假警报，几次之后用户就不看了。
  const before = new Set(readFavs(favStore));
  let renewed = 0;
  for (const id of r.ids) {
    if (before.has(id)) renewed++;
  }

  // 合并顺序：备份优先序在前，本机已有并入尾部（老项目 :9265-9267；实现在 favs.ts mergeFavs）
  const merged = mergeFavs(r.ids, readFavs(favStore));
  // 老项目口径：'已恢复 ' + Math.min(ok.length, FAVS_MAX) + ' 篇收藏'，
  //   丢弃数 = 超出的那几篇（如实说，不静默）。
  const count = Math.min(merged.length, FAVS_MAX);
  const capped = merged.length > FAVS_MAX ? merged.length - FAVS_MAX : 0;

  const stored = writeFavs(favStore, merged);
  // 🔴 落盘后必须以**真存下去的东西**为准，不是以算出来的数为准。
  //   writeFavs 在隐私模式/配额满时会静默写不进去（favs.ts 有注释），
  //   此时报"已恢复 N 篇"就是**谎报**——用户以为收藏搬过来了，回头一看没有。
  if (stored.length === 0) {
    return { ok: false, reason: COPY.migrateFavWriteFail };
  }

  // 🔴 收藏夹变了 ⇒ 菜单的收藏视图必须重算（favs.ts:25 那条纪律的同一根）。
  //   不刷的症状：收藏夹视图还是旧列表，用户刚"恢复"完点开菜单看到的还是空。
  menuState.favList = favListOf(favStore);
  menuRef?.render();

  return { ok: true, count, renewed, capped };
}

/**
 * 收藏备份的恢复卡（老项目 index.html:9231 enterBackupMode 形态）。
 *
 * 🔴 老项目是**只读恢复卡**：先列篇名 + 「恢复这 N 篇」，用户点确认才写盘。
 *   理由不是谨慎过度 —— 恢复会**覆盖本机同名收藏的密钥**（老项目 v7.7.0 如实报"覆盖 N 篇"），
 *   不让用户先看一眼清单就直接写，等于让他在不知情下放弃本机那几篇。
 *   bj 的收藏恢复**只合并名单、不覆盖任何内容**（密钥现派生），
 *   风险低得多，但仍保留"先看清再点"的形状：多一次确认，代价是半秒。
 */
function openFavBackupTake(initialCode?: string): void {
  buildMigratePanel({
    mode: 'take',
    onTake: async (code, passphrase) => {
      const r = await applyFavBackupRestore(code, passphrase);
      if (!r.ok) return { ok: false, reason: r.reason };
      // 老项目 :9270-9273 逐字（含覆盖与丢弃两个括号）
      // 🔴🔴 追加"旧码不免输"的如实说明（C5）：`nsfav1:` 清单只有篇名、没有材料，
      //   恢复后进这些笔记仍要输一次口令 —— 不提示会让用户以为"恢复了却还要输口令=坏了"。
      return {
        ok: true,
        reason: favRestoreTip(r.count, r.renewed, r.capped, FAVS_MAX) + COPY.bakOldCodeNoExempt,
      };
    },
    onClosed: () => {
      // 🔴 扫码换机弹层关闭：与其它浮层同款守卫（触屏不还焦点 = 不弹键盘）。
      restoreEditorFocusOnClose();
    },
  });
  if (initialCode) {
    const el = document.getElementById('migrateCodeIn') as HTMLTextAreaElement | null;
    if (el) el.value = initialCode;
  }
}

/** 冲突提示。裁决入口在菜单里，这里只把冲突条目显示出来。 */
function showConflictHint(): void {
  const c = syncRef;
  if (!c) return;
  const list = c.getConflicts();
  if (list.length === 0) return;
  menuState.conflicts = list.map((x) => ({ at: x.at, label: x.right || x.left }));
  menuRef?.render();
  // 🔴 冲突必须**主动**把用户带到裁决处，不能只在下巴上写一行字。
  //   底栏那行字会被滚动、被切页面、被时间规则重绘冲掉；
  //   而冲突不裁决的后果是"两边内容反复互相覆盖"，用户还以为网络在抽风。
  //   这里自动打开菜单的冲突视图 —— 一次交互就能改完，不打断编辑。
  menuRef?.openView('conflict');
}

/** 口令错 / 数据坏 —— 同一句话，不区分（ARCH 安全不变量：区分开等于给暴力破解 oracle） */
const PASS_ERROR = '口令不对，或数据无法解密';

function showLanding(): void {
  hideDraftBar(); // 🔴 草稿条是常驻 DOM，离开编辑器必须收（否则盖在落地页上）
  buildLanding(app, {
    onOpen: (name, isEgg) => {
      if (isEgg) {
        // 🔴 S8 接彩蛋层。这里**先跳到该门牌对应的路由**而不是弹提示 ——
        //   点了没反应是最糟的体验；路由会由彩蛋层接管（S8 前是 404 提示页）。
        location.href = '/' + name;
        return;
      }
      location.href = '/' + encodeURIComponent(name);
    },
    onScan: () => {
      // 🔴 落地页的「扫码打开笔记」与顶栏 scanBtn 走**同一个** openScanner，
      //   判定与降级逻辑不许分叉（分叉迟早出一处认不出另一处的码）。
      openScanner();
    },
  });
  goto('landing');
}

function showHome(): void {
  hideDraftBar(); // 🔴 同 showLanding：常驻 DOM 不收会盖在首页上
  buildHome(app);
  goto('home');
}

function showPass(name: string): void {
  hideDraftBar(); // 🔴 同 showLanding：口令页不许残留上一条的草稿条
  buildPass(app, {
    onSubmit: async (pass) => {
      // 🔴🔴 这里必须真解锁，**不能**先放行再补。
      //   "解锁成功但正文是空的"是本项目最危险的故障形态：用户会以为云端没内容，
      //   重写一遍推上去，把另一台设备上的正文覆盖掉 —— 静默的数据丢失。
      const r = await unlock({ noteId: name, passphrase: pass });
      if (!r.ok) return r.message;
      // 🔴 会话口令在**解锁成功之后**才记：失败的尝试不该把口令留在内存里。
      sessionPass = pass;
      pendingFresh = r.fresh;
      // 🔴 v1.13.0 写入①（老项目 index.html:3437 applyUnlocked 逐字同款）：
      //   解锁成功即记住这一篇，供 APK 冷启动自动进入。
      rememberLastNote(name);
      // 🔴🔴 甲案分流（老项目 applyUnlocked:3464 同款）：手输口令打开一篇
      //   `nsbak-xxxxxx` 时，看到的必须是只读恢复卡而不是可编辑的清单。
      //   漏这条的症状：在旧设备上敲 URL 打开备份笔记 → 清单进 contenteditable
      //   → 用户改掉它 → 下次换机备份的就是被改过的清单（甲案三闸①被从后门打开）。
      if (presentBakDoc(name, r.doc, r.dk, pass)) return null;
      mountEditor(name, r.doc);
      // 🔴 解锁成功才弹 PWA 安装引导（老项目 index.html:3476 同位置）：
      //   落地页就弹 = 一进门先推安装广告，是最招人烦的那种。
      tryShowInstallBar();
      eggDraw.consume();
      greetThisNote(name);
      return null;
    },
    onClose: () => {
      // 🔴 v1.13.0（老项目 index.html:10104 逐字同款）：同样打"已跳转"标记，
      //   防 APK 冷启动自动跳转把用户弹回原笔记。
      markJumped();
      history.pushState({}, '', '/');
      showLanding();
    },
  });
  goto('pass');
}

/**
 * 改口令的完整流程：**弹窗两阶段**（验旧口令 → 设新口令）→ 换密钥 → 落盘。
 *
 * 🔴🔴 此前这里是 `window.prompt()` 连弹两次（用户报障第 12 条
 *   「修改口令弹窗和老版本不一样」）：
 *     · 没有弹窗 —— 老项目是 `#cpMask` 一张真正的浮层（index.html:780-793）；
 *     · 顺序颠倒 —— 老项目先问「当前口令」（`下一步`）验证通过后才展开新口令两框；
 *     · 文案全无 —— 老项目有「修改后本机立即用新口令重新加密…」这句说明，
 *       它讲清了"其他设备要用新口令重开"这一后果，不是装饰。
 *   window.prompt 还有个硬伤：它是**阻塞的原生框**，样式完全由系统决定，
 *   夜间模式下是一片白，与本项目整套主题毫无关系。
 */
async function doChangePassphrase(): Promise<void> {
  const doc = window.__NOTESYNC_DOC__?.() ?? emptyDoc();
  // 🔴 阶段一验证通过的口令要**留在闭包里**给阶段二用。
  //   弹窗是分两步问的（先旧、后新），中间没有第二个输入框可以回填 ——
  //   少存这一份，第二步就拿不到"用来证明身份"的那句口令。
  let verifiedOld = '';
  buildChangePass(app, {
    onVerifyOld: async (oldPass) => {
      // 🔴 阶段一**只验证，不换密钥**：解开旧密文 = 身份证明。
      //   验不过就停在阶段一，让用户重输，绝不��到设置新口令那一步。
      const r = await unlock({ noteId: currentNote, passphrase: oldPass });
      if (!r.ok) return r.message;
      verifiedOld = oldPass;
      return null;
    },
    onSubmitNew: async (next) => {
      const r = await changePassphrase(currentNote, verifiedOld, next, doc);
      if (!r.ok) return r.message;
      // 🔴 会话口令必须同步换成新的。忘了这一步的话，配对码里还是**旧口令**，
      //   另一台设备扫了必然解不开 —— 而本机一切正常，症状是"配对功能坏了"。
      sessionPass = next;
      setFootStatus?.('synced', COPY.cpDoneMsg);
      // 换完密钥必须重建同步实例：它持有的是旧密钥
      await startSyncFor(currentNote);
      // 🔴 改口令 = 换 AES 密钥。老项目 index.html:8338-8339 在 cpRotate 成功后
      //   专门重排一次 `scheduleReminders(); syncRemindersToNative();`。
      //   bj 这里同理：`schedule()` 会把当前提醒列表重新交给原生排程。
      //   为什么不能省：原生侧那份密文是**独立**存的（RemPlugin 自己一把 Keystore 钥，
      //   与笔记密钥无关），但换口令后 sync 实例重建、文档可能被重拉，
      //   不重排就可能停在旧列表上。漏挂的症状是"改完口令后提醒不响"，且零报错。
      reminderRef?.schedule();
      return null;
    },
    onClose: () => {
      // 弹窗关掉就把焦点还给编辑器（老项目 :8287 `cpCancel` 里 `editor.focus()` 同款动作）。
      // 🔴 桌面端失焦时光标不绘制（老项目红线10），不还焦点会看到"框还在但不能直接打字"。
      // 🔴🔴 但**触屏必须不还焦点** —— 这正是老项目 :8287 那行的 `if (CHIP_HOVER_OK)`。
      //   手机上"取消修改口令"就弹键盘（用户报障第 10 条第三条）。
      //   注意与"打开时聚焦当前口令框"配对：老项目 openChangePass 里
      //   `cpOld.focus()` 是**无条件**的（用户报障第 9 条要求聚焦），
      //   而取消时的还焦点是**有条件的** —— 两者方向相反，别抄反。
      restoreEditorFocusOnClose();
    },
  });
}

/**
 * 冷启动落在空路径时，APK 里自动进入上次打开的笔记（老项目 index.html:10148-10159）。
 *
 * @returns true = 已发起跳转，调用方必须**立刻 return**，别再 showLanding()
 *   （两个分支都 return 之后首页才真的进不去；少一个 return 的症状是
 *   "落地页闪一下又被跳走"，闪的那一下用户能看见）。
 *
 * 🔴 为什么不head 里内联抢跳：见 route/last-note.ts 文件头的竞速实证
 *   （老项目自己记的 "v6.3 P1 根治「点通知有时进错笔记」"）。
 */
function tryResumeLastNote(): boolean {
  const last = lastNoteToResume(isNativeApp());
  if (last === null) return false;
  // assign 而非 replace：留历史，用户按返回键可退回首页换笔记（老项目 :10156 注释逐字）。
  location.assign('/' + encodeURIComponent(last));
  return true;
}

/**
 * 从 `location.hash` 取 `#p=` 直链口令（B1）。
 *
 * 🔴 为什么需要它：扫码那条路走 `handleScanRaw`，而**把配对链接直接贴进地址栏 /
 *   收藏书签 / 别的 App 里点开**是另一条入口 —— 此前没有任何人读 `location.hash`，
 *   于是"链接发给自己点开"照样弹口令框（老项目 `#k=` 是直开的）。
 *
 * 返回 `present=false` = 地址里没有 `p=` fragment；`present=true, passphrase=null`
 * = 有 fragment 但载荷形状不对（域不符 / 非 `p=` / 笔记名非法 / base64 解不开）。
 * 🔴 只回口令本身，不回其它信息 —— 与 `__NOTESYNC_PARSE_PAIR__` 同款安全边界。
 */
function pairFragment(): { present: boolean; passphrase: string | null } {
  const h = location.hash.startsWith('#') ? location.hash.slice(1) : location.hash;
  if (!h.startsWith(PAIR_FRAGMENT_KEY + '=')) return { present: false, passphrase: null };
  // 🔴 必须走 `resolveScan` 这个唯一收口，不自己调 `parsePairLink`（判据 PAIR-17：
  //   解析口径只写一遍，分叉的根源从来不是"忘了改"，而是"改了一处"）。
  const { parsed } = resolveScan(location.href);
  if (!parsed.ok) return { present: true, passphrase: null };
  return { present: true, passphrase: parsed.link.passphrase };
}

/**
 * 落地一条 `#p=` 直链：解口令 → 挂编辑器（B1）。
 *
 * 🔴🔴 顺序与 `handleScanRaw` 的配对分支**逐条对齐**，两条入口不许分叉：
 *   ① 先 `history.replaceState` 清掉地址栏里的口令 —— fragment 虽不上行服务器，
 *      但会留在地址栏 / 历史 / 截图 / 复制出的链接里；口令用完即弃。
 *   ② 备份笔记（`nsbak-`）先进只读恢复卡，绝不挂编辑器（甲案三闸①）。
 *   ③ 口令错 / 数据坏给**与手输同一句**文案（ARCH 安全不变量，不给暴力破解 oracle），
 *      然后退回口令框让用户手输 —— 直链失败不该把人卡在空白页。
 */
async function landPairFragment(noteId: string, passphrase: string | null): Promise<void> {
  history.replaceState({}, '', '/' + encodeURIComponent(noteId));
  if (passphrase === null) {
    showUploadNote('bad', COPY.scanNotPair, COPY.uploadFailMs);
    showPass(noteId);
    return;
  }
  if (await tryEnterBakMode(noteId, passphrase)) return;
  showUploadNote('doing', COPY.pairLanded, 0);
  const r = await unlock({ noteId, passphrase });
  if (!r.ok) {
    showUploadNote('bad', r.message, COPY.uploadFailMs);
    showPass(noteId);
    return;
  }
  sessionPass = passphrase;
  pendingFresh = r.fresh;
  rememberLastNote(noteId);
  mountEditor(noteId, r.doc);
  tryShowInstallBar();
  // 🔴 此处**不**兑现开奖（DR-07b 钉着全项目恰两处 consume：手输口令 + 记忆解锁）。
  //   老版 `#k=` 直链是「存密钥 → location.replace 整页重载 → 自动解锁分支」，
  //   而那条分支（index.html:10258）**没有** nsDrawConsume —— 兑现只发生在
  //   applyUnlocked:3479 与离线解锁:3511。bj 的 `#p=` 是扫码同族的"配对落地"入口，
  //   与 handleScanRaw 一样不该在这里兑现；多写一条等于让直链入口凭空吞掉刷新开奖。
  greetThisNote(noteId);
}

function route(): void {
  const raw = noteNameFromPath();
  if (raw === '') {
    if (tryResumeLastNote()) return;
    showLanding();
    return;
  }
  const name = sanitizeNoteName(raw);
  if (name === '') {
    // 路径里只有非法字符（如 /中文）→净化后为空，回落地页而不是报错
    // 🔴 v1.13.0：这个分支**也要**试恢复末篇。老项目只有一个「无 noteId」分支，
    //   bj 拆成了两个（多一个 sanitize 后为空的兜底）；漏掉这个分支的症状是
    //   "杀进程重进后停在落地页"，但用户手动输名字能进 ⇒ 极难自查。
    if (tryResumeLastNote()) return;
    showLanding();
    return;
  }
  if (isEggRoute(name)) {
    // 🔴 彩蛋门牌：**不进编辑器**（老项目口径 —— 门牌是保留字，不新建笔记）。
    //   伪路由（about/help/api…）不是门牌，回首页提示页而不是进游戏。
    //   未实现的门牌由 openByRoute 自己给可见提示并回落地页，绝不静默白屏。
    //🔴🔴 必须**先 ensureEggLayer 再问 doorOfPath**：
    //   直接访问 /snake（分享链接、收藏书签、APK 冷启）时彩蛋层还没懒建，
    //   `eggLayer?.doorOfPath()` 返回 undefined ≠ 'snake'，于是掉进 showHome ——
    //   症状是"门牌链接打不开游戏，只看到一个首页提示"，而首页提示不会报错。
    //   （本条由 e2e EGG-E02 抓到：门牌直达是首屏路径，不是边角情况。）
    if (eggLayer === undefined) ensureEggLayer();
    if (eggLayer?.doorOfPath() === name.toLowerCase()) {
      ensureEggLayer();
      if (eggLayer && !eggLayer.openByRoute(name)) {
        // 门牌存在但没映射出实现 —— 回落地页，别停在一个什么都不做的编辑器
        showLanding();
      }
      goto('egg');
      return;
    }
    // 非门牌的保留字：至少不是白屏
    showHome();
    return;
  }
  // 🔴 "本机记不记得"由**能不能取到密钥**决定，不是 localStorage 里一个布尔标记。
  //   老项目用标记当记忆，于是"标记在、密钥没了"时依然进编辑器 = 假成功。
  //   resolveKey 走内存 → IndexedDB，都拿不到才要口令。
  void (async () => {
    // 🔴🔴 B1：`#p=` 直链（对齐老版 `#k=`「直接打开此笔记，无需输入口令」）。
    //   扫码那条路走 handleScanRaw；把链接**直接贴进地址栏/书签/别的 App** 是另一条入口，
    //   此前没有任何人处理 location.hash ⇒ 照样弹口令框。
    //   必须在"记忆解锁"之前取到口令：新设备上这条链接是**唯一**的钥匙来源。
    const pf = pairFragment();
    const rec = await unlockIfRemembered(name);
    if (rec && rec.ok) {
      // 🔴 本机已记得：记忆解锁优先 —— 直链里的口令可能已过期（改过口令），
      //   不能让一条过期链接把本机还能用的密钥顶掉。顺手清掉地址栏里的口令。
      if (pf.present) history.replaceState({}, '', '/' + encodeURIComponent(name));
      // 🔴 记忆解锁也要把口令交给 sessionPass，否则「点扫码配对/扫码换机还要输口令」。
      //   （此前只有"本次会话手输过口令"才有值 ⇒ 记忆进来的用户每次都被卡。）
      //   口令来自本机保险箱（./sync/pass-vault.ts），与密钥同生共死、锁定即失效。
      if (rec.passphrase) sessionPass = rec.passphrase;
      pendingFresh = false;
      // 🔴 v1.13.0 写入③（老项目 index.html:10298 的 v5.57 教训**正是这条**）：
      //   记住密钥进来的设备此前从不更新 last note ⇒ 冷启动自动跳转形同虚设。
      //   本条路径不经过任何用户动作，只在刷新时悄悄发生，最容易被漏。
      rememberLastNote(name);
      // 🔴🔴 甲案分流（同 showPass 那条）：记忆解锁也要在挂编辑器之前判。
      //   这条路径**最容易被漏** —— 它不经过任何用户动作，
      //   只要在旧设备上刷新一下 `/nsbak-xxxxxx` 就会走到。
      //   口令回落：保险箱里的（`rec.passphrase`）优先，没有才用直链 `#p=` 的
      //   （与上面"记忆解锁优先、过期直链不许顶掉本机密钥"同一口径）。
      if (presentBakDoc(name, rec.doc, rec.dk, rec.passphrase ?? pf.passphrase ?? '')) return;
      mountEditor(name, rec.doc);
      // 🔴 同上：记忆解锁也是"解锁成功"，同样该弹安装引导
      tryShowInstallBar();
      eggDraw.consume();
      greetThisNote(name);
      return;
    }
    if (pf.present) {
      await landPairFragment(name, pf.passphrase);
      return;
    }
    showPass(name);
  })();
}

function boot(): void {
  // 🔴🔴 P0-4：600k 次 PBKDF2 挪进 Worker（换机恢复 100 篇曾把主线程冻 13~26 秒）。
  //   必须**最早**装：解锁/恢复的任何派生都要走它。装不上（无 Worker / CSP 拦
  //   blob: / 老 WebView）只是回到原来的慢，`deriveKey` 内部会回落主线程，
  //   **绝不会变成解锁失败** —— 所以这里不判返回值、不弹错。
  installKdfWorker();
  applyTheme();
  // 🔴 离线草稿条（v3.1.1）：两个裁决按钮的监听只挂一次（标记是 build.mjs 静态壳）。
  //   「保留本机」= applyDraft 拿草稿内容回灌（与 restoreHistVersion 同一条链：
  //   docToLexical 触发的 update 会自动把真源写回 latestDoc，canonical 比较判定
  //   内容真变 ⇒ 自动 noteEdit 走正常推送链，不另开第二条推送路径）；
  //   🔴 **绝不在推送成功前 clearDraft** —— 草稿此刻仍是唯一底线（draft.ts 红线），
  //   清理由 onArchive 在推送成功后完成。
  document.getElementById('draftRestore')?.addEventListener('click', () => {
    const noteId = draftConflictNote;
    hideDraftBar();
    const got = noteId ? applyDraft(noteId) : undefined;
    const ed = editor;
    if (!got || !ed) return;
    ed.update(() => {
      docToLexical(got.doc);
    }, { discrete: true });
    // 🔴 草稿里的裸网址也要亮（与恢复历史版本同一收口，漏掉就是裸文本）。
    linkifyNowRef?.();
  });
  // 「使用云端」= 丢弃草稿，编辑器保持云端内容不动。
  document.getElementById('draftDiscard')?.addEventListener('click', () => {
    const noteId = draftConflictNote;
    hideDraftBar();
    if (noteId) discardDraft(noteId);
  });
  // 🔴 隐藏的 file input 必须在启动时就建好（见 ensureUploadInput 的注释）：
  //   懒创建会让"第一次点击"成为唯一能走通的机会，一旦那次失败按钮就永久是死的。
  ensureUploadInput();
  route();
  // 口令页关闭回落地页用的是 pushState，所以要监听 popstate
  window.addEventListener('popstate', () => {
    // 🔴 游戏外壳自己 push 了历史（进游戏时压一条，退出时 back回去）。
    //   不在这里重跑 route()，否则 popstate 会把用户又送回游戏页 ——
    //   症状是"退出游戏后又弹回游戏，循环往复且关不掉"。
    if (eggLayer?.shell.isOpen()) return;
    route();
  });
  //🔴 ?eggs 直开图鉴（老项目同款：与 ?diag 同一套路）。
  //   必须在 route 之后：门牌路径下 route 会进游戏，此时不该再叠图鉴。
  if (location.search.indexOf('eggs') >= 0 && !eggLayer?.shell.isOpen()) {
    ensureEggLayer()?.openCodex();
  }
  // 🔴 ?diag 直开常驻诊断浮层（老项目 :2079-2081：`location.search.indexOf('diag') !== -1`）。
  //   为什么放 boot 末尾而不是 route() 之前：门牌路径下 route 会进游戏，
  //   那里再叠一层浮层毫无意义（用户想看的是游戏）。
  //
  //   🔴 老项目同时支持 localStorage('notesync_diag')='1' 让浮层跨重载保持
  //   （:2080，理由是"真机反复取证"）。bj 同样支持，但**键名用 bj 前缀**
  //   （与 registry.EGG_KEY / favs 同款纪律，见 rem-native.test.mjs REMN-15）。
  //
  //   🔴 用精确的查询参数解析而不是 indexOf：后者会让
  //   `/note-diagnostic` 这类**笔记名**顺带把诊断浮层打开 ——
  //   老项目就有这个缺陷（`indexOf('diag')` 命中路径里的任意 diag），
  //   而症状是"打开某篇笔记后右下角莫名多一块黑底绿字"，用户完全无法自查。
  if (hasDiagFlag(location.search) || diagFlagStored()) {
    // 🔴 页URL 带来的也要记（老项目 :2080 同款）：否则用户先用 ?diag 取一次证，
    //   下次进来没带参数就浮层消失了——老项目里这两条路径共用同一个 if。
    rememberDiagFlag();
    ensureDiagPanel().boot();
  }
  // 🔴 v1.12.0：空闲时预拉扫码解码器（jsQR 127KB）。
  //   用户报障「老版本扫描识别更快」的根因之一：老项目有 prefetchHtml2CanvasIdle
  //   （index.html:2877），页面空闲即预热，所以点扫码是热的；bj 此前一次都没预热，
  //   loadJsQr 只在打开扫码浮层时才被调 ⇒ 打开扫码先干等一次网络往返。
  //   放在 boot 末尾：route() 之后，首屏该做的都做了，才让出主线程。
  //   内部自带 requestIdleCallback + setTimeout 双保险与去重，失败静默（见 engine.ts 注释）。
  prefetchJsQrIdle();
  document.getElementById('boot')?.remove();
}

/**
 * 注册 ServiceWorker。
 *
 * 🔴🔴 注册 URL **必须带 `?v=<APP_VERSION>`**，缓存名由 sw.js 从自身 URL 读它
 *   （老项目 index.html:10337 + sw.js:4-5 是同一套单源驱动）。
 *   不带版本号 ⇒ 缓存名写死在 sw.js 里 ⇒ 发版后用户永远拿旧壳，
 *   而且**零报错**（这正是 bj 此前 `const VERSION = 'v1'` 的状态）。
 *
 * 🔴 APK 内不注册（见文件头）。
 */
function registerSW(): void {
  // 🔴 v1.13.0：原来判`window.__NOTESYNC_NATIVE__`，那个标志从无赋值 ⇒ 这道早退**从未生效**，
  //   于是 APK 里也在注册 SW（缓存的是线上壳，与 MainActivity 的三段首载兜底叠加）。
  if (isNativeApp()) return;
  if (!('serviceWorker' in navigator)) return;
  const url = new URL('sw.js?v=' + encodeURIComponent(APP_VERSION), location.href);
  navigator.serviceWorker.register(url).catch((e: unknown) => {
    // 注册失败不能影响使用：离线能力是增强项，不是前提
    console.warn('[notesync] SW 注册失败（不影响使用）', e);
  });
}

try {
  // 🔴 飞行记录器全局钩子（v3.0.9 诊断版）：排除"丢字其实是页面重载/崩溃"。
  //   error/unhandledrejection/visibilitychange/pagehide 全部**同步落盘** ——
  //   丢字现场常伴随页面被杀，节流落盘会丢最后几条（恰恰是最重要的几条）。
  //   观察者纪律：只记录，绝不 preventDefault / 改时序。
  window.addEventListener('error', (e) => {
    recordFlight('err', String(e.message ?? '').slice(0, 100), true);
  });
  window.addEventListener('unhandledrejection', (e) => {
    recordFlight('err:rej', String(e.reason ?? '').slice(0, 100), true);
  });
  document.addEventListener('visibilitychange', () => {
    recordFlight('vis', document.visibilityState, document.visibilityState === 'hidden');
    // 🔴 离线草稿兜底（v3.1.1）：切后台（Android 上锁屏/切 App 都会触发）把活真源
    //   落一次草稿 —— 后台进程被杀时页面不会收到 pagehide，这里就是最后的机会。
    if (document.visibilityState === 'hidden' && draftActiveNote) flushDraftNow(draftActiveNote);
  });
  window.addEventListener('pagehide', () => {
    recordFlight('vis', 'pagehide', true);
  });
  boot();
  registerSW();
  // 🔴 PWA 安装引导：监听必须在 boot 之后立刻挂（`beforeinstallprompt` 可能很早来），
  //   但**显示**要等解锁成功（老项目 index.html:3476 的调用点在解锁回调里）。
  initInstallPrompt();
} catch (e) {
  console.error('[notesync] 启动失败', e);
  const box = document.createElement('div');
  box.className = 'ns-fatal';
  box.textContent = '启动失败：' + (e instanceof Error ? e.message : String(e));
  app.appendChild(box);
}

export {};
