/**
 * 扫码换机·备份全部收藏夹 —— 收藏清单码（用户报障第 4 条）
 *
 * ═══════════════════════════════════════════════════════════════════════
 * 🔴🔴🔴 本模块是老项目「甲案」的**等价重写**，不是照抄。分叉点必须写清楚，
 *否则后人会以为"少做了功能"而去把它补成老项目的样子 —— 那会把本项目最重要的
 * 一条安全属性拆掉。
 *
 * ── 老项目怎么做（index.html，只读）──────────────────────────────────
 *   备份范围（:8997-8998v10.1.7 定稿，逐字）：
 *     「备份范围（v10.1.7 定稿）：**只备份收藏夹**，没有例外、也没有开关。」
 *     沿革：v10.1.4 擅自扩范围 → v10.1.5 回退成默认只收藏并加勾选框
 *     → v10.1.7 用户明确「只备份收藏夹」，勾选框一并删除——「少一个开关就是少一条状态」。
 *   清单内容（:9001 collectBackupEntries）：`[[笔记名, rawKeyBase64], …]`
 *     —— **装的是密钥本身**。
 *   出码提示（:9187-9190）：
 *     '新设备首页「扫码打开笔记」对准它，一键恢复 ' + n + ' 篇'
 *     +（skipped ? '（' + skipped + ' 篇无密钥未含）' : '')
 *     +（capped  ? '（超 ' + BAK_MAX + ' 篇未含 ' + capped + ' 篇）' : '')
 *     + '。看不清就点一下码'
 *   恢复提示（:9270-9273）：
 *     '已恢复 ' + n + ' 篇收藏' +（renewed ? '（覆盖 ' + renewed + ' 篇旧密钥）' : '')
 *     +（capped ? '，收藏夹满 ' + FAVS_MAX + ' 篇已丢弃最旧 ' + capped + ' 项' : ''）
 *   排除三条（:9010-9016）：① 备份笔记自身（否则密钥套密钥死循环）
 *                        ② id 不合法 `/^[A-Za-z0-9_-]{1,64}$/`（与服务端 ID_RE 同规则）
 *                        ③ 本机无该篇合法密钥 → skipped++
 *   合并顺序（:9265-9267）：**备份在前，本机并入尾部**（见 favs.ts mergeFavs 注释）
 *
 * ── 本项目为什么**不装密钥**（架构性分叉，理由与 migrate/code.ts 同源）────
 *   老项目装 rawKey 是因为它的密钥明文躺在 localStorage（`KEY_STORE`），
 *   "把密钥写进二维码"对它零成本。
 *   本项目的密钥是 `extractable:false` 的 CryptoKey（shared-schema/key-store.ts:26），
 *   **WebCrypto 层面物理上导不出 raw 字节**。要照抄就必须先把它降级成可导出，
 *   那是亲手拆掉"XSS 拿不到长期密钥"这条本项目最重要的属性。
 *
 *   ⇒ 本模块的清单装**笔记名**，不装密钥。
 *   这比老项目**更强**，不是更弱：
 *     老项目：扫到码 = 拿到密钥 = 拿到全部笔记的明文（且密钥永不变，改口令也救不回来）
 *     本项目：扫到码 = 只拿到一段**密文**；没有口令什么都解不开，
 *             而口令按设计**不进码**（用户在新设备上手输）。
 *
 *   恢复端因此不必"写回密钥"，只要**把收藏名单装回去**：
 *   每篇的密钥在新设备上按 `PBKDF2(口令, 该篇信封里的 salt)` 现派生
 *   —— 与 sync/unlock.ts:174 同一条路。salt 本来就在服务端信封里（`kdf.salt`，非机密）。
 *
 * ── 为什么不写进"一篇备份笔记"（老项目 v10.1.4 甲案的载体）──────────────
 *   老项目把清单加密后**写进云端一篇专用笔记**，二维码只装那篇的链接
 *   （这样码恒定约 86 字节，与篇数无关）。
 *   本项目走**另一条路**达成同一目标：清单直接进码，但**清单里只有笔记名**，
 *   100 篇也只有约 1.2KB 明文，仍在可扫范围内（见 FAV_BACKUP_MAX 的取值论证）。
 *   少一个"往云端写一篇特殊笔记"的副作用，也少一份"那篇笔记被误当普通笔记编辑"的风险。
 *
 * ── 零 DOM 依赖 ──────────────────────────────────────────────────────────
 * 与 code.ts / pair-link.ts 同款纪律：纯计算，可 node --test 直跑。
 */

import {
  decryptString,
  deriveKey,
  encryptString,
  type Envelope,
} from '@bj/shared-schema';

/**
 * 收藏备份码前缀。
 *
 * 🔴 必须与单篇换机码（`nsbak1:`）**分流**：
 *   扫码结果与手动粘贴共用同一个入口，而那个入口同时收单篇换机码与配对链接
 *   （`https://…/#p=`）。若靠"试解一次"来区分类型，用户会撞上完全想不到原因的错误路径
 *   （症状与"口令不对"一模一样）。前缀让分流一眼可判 —— 与 code.ts 同理。
 */
export const FAV_BACKUP_PREFIX = 'nsfav1:';

/**
 * 清单容量上限（篇）。
 *
 * 🔴🔴 取值三条硬判据（与 migrate/code.ts 的 MIGRATE_PAYLOAD_CAP 同一套权衡）：
 *
 *  1. **与老项目同值**：老项目 `BAK_MAX = 100`（:8952，注释「100 篇 ≈ 8KB 明文；
 *     服务端 PUT 上限 1MB」）。而本项目收藏夹上限 `FAVS_MAX` 也是 100（favs.ts:25，
 *     老项目 v10.1.4 由 20 上调到 100，理由原样承接：「换机备份是『一篇码带走全部』的
 *     设计，收藏列表卡 20 篇等于换机只能搬得走 20 篇」）。
 *     ⇒ 上限与收藏夹同值 = **收藏夹里的每一篇都必然能被备份**，一个都不漏。
 *     这比老项目更干净：老项目的 BAK_MAX 与 FAVS_MAX 是两个独立数字，
 *     收藏超过 100 时会出现"收藏夹里有、但备份码装不下"的静默缺口。
 *
 *  2. **码长仍在可扫范围**：清单里只有笔记名（老项目是「名字 + 44 字符密钥」），
 *     单篇约 12 字节 → 100 篇约 1.2KB 明文 → 加密+base64 约 1.7KB。
 *     对照老项目 v10.1.4 的血泪（index.html:8941）：
 *     「旧路线把「收藏 + 全部密钥」整包塞进一张二维码：每篇固定约 80 字节，
 *      篇数一多格子数线性涨…第 3~4 篇起每格已掉到 0.6mm 以下。」
 *     本项目每篇只有它的 1/6，且面板支持点码全屏放大（migrate/panel.ts 同款）。
 *
 *  3. **超出必须明说**：抛 `too-long` 由面板显示，**绝不静默截断**。
 *     截断 = 用户以为全备份了、实际丢了收藏，且他不会知道 —— 最坏的一种失败。
 */
export const FAV_BACKUP_MAX = 100;

/** 笔记名合法性。与服务端 ID_RE 同规则（老项目 :9014 也用同一条正则）。 */
const NOTE_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

/* ---------------- base64url（与 code.ts 同一套定义，最小实现）---------------- */

function b64ToB64Url(b64: string): string {
  return b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function b64UrlToB64(s: string): string {
  const pad = (4 - (s.length % 4)) % 4;
  return s.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat(pad);
}

function utf8Len(s: string): number {
  return new TextEncoder().encode(s).length;
}

/* ---------------- 清单形态 ---------------- */

/** 清单明文。键序固定，compact 序列化，不走 JSON.stringify（与 code.ts envJsonCompact 同理）。 */
interface FavManifest {
  v: 1;
  ts: number;
  /** 笔记名，保序去重 */
  f: string[];
}

function manifestJson(m: FavManifest): string {
  return (
    '{"v":' +
    m.v +
    ',"ts":' +
    m.ts +
    ',"f":[' +
    m.f.map((s) => JSON.stringify(s)).join(',') +
    ']}'
  );
}

/** 清单解析。**任何一项不满足返回 null**，绝不返回半个清单。 */
function parseManifest(o: unknown): FavManifest | null {
  if (typeof o !== 'object' || o === null) return null;
  const m = o as Partial<FavManifest>;
  if (m.v !== 1) return null;
  if (!Array.isArray(m.f)) return null;
  const out: string[] = [];
  for (const it of m.f) {
    if (typeof it !== 'string' || !NOTE_ID_RE.test(it)) return null;
    if (out.indexOf(it) < 0) out.push(it);
  }
  return { v: 1, ts: typeof m.ts === 'number' ? m.ts : 0, f: out };
}

/* ---------------- 入口过滤 ---------------- */

/**
 * 该备份本机要收录哪些笔记名。
 *
 * 🔴 剔除「备份槽自身」（老项目 :9012 `if (slot && slot.id === id) return;`）：
 *   备份笔记自己进了清单，就成了「用备份的密钥解备份的密钥」——
 *   老项目注释管这叫「密钥套密钥死循环」。本项目清单里没有密钥，
 *   但备份槽若进了清单，恢复端会把它当普通收藏塞回去，
 *   用户收藏夹里凭空多出一个自己从没收藏过的条目 —— 同样要剔。
 *
 * 🔴🔴 **这里绝不按 FAV_BACKUP_MAX 截断**（老项目 `collectBackupEntries` 会截，要分清）：
 *   老项目截断是因为它还要往云端写一篇笔记、码得尽量短；本项目的码直接装清单，
 *   而本项目 `FAV_BACKUP_MAX === FAVS_MAX === 100`，收藏夹本身就装不下第 101 篇，
 *   所以出码侧超限在正常流程里**根本不可达**（备份槽自身还要先被剔掉一篇）。
 *
 *   那么到这一步还超限，只可能是**收藏夹数据被外部写坏**（localStorage 被手改/别的脚本污染）。
 *   这时**静默截断 = 用户以为 101 篇全备份了、实际丢了 1 篇且永远不会知道**。
 *   截断的职责在**恢复侧**（`mergeFavs` → `normalizeFavs` 按老项目语义砍尾，
 *   并由 `favRestoreTip` 的 capped 分支如实告知丢了哪几篇）；
 *   出码侧则把超限**明说**成 `too-long`（见 buildFavBackupCode）。
 *
 *   ⛔ 若哪天有人为了"防溢出"在这里加回 `if (out.length >= MAX) break;`，
 *   `buildFavBackupCode` 里的 `f.length > FAV_BACKUP_MAX` 就变成**永假死分支**，
 *   `too-long` 永不触发 ⇒ 静默截断回归。BAK-FAV-04 与 BAK-FAV-13 两条判据
 *   都在盯这件事，改这里之前先跑它们。
 *
 * @param favs 本机收藏名单（原始顺序 = 用户优先级）
 * @param slotId 本机备份槽的笔记名；null = 本机还没有备份（第一次生成）
 */
export function collectFavBackupIds(favs: readonly string[], slotId: string | null): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const id of favs) {
    if (!id || seen.has(id)) continue;
    // 反向：空/非法名一律剔掉（老项目 :9014 同样剔，且计入 skipped）
    if (!NOTE_ID_RE.test(id)) continue;
    seen.add(id);
    if (slotId && id === slotId) continue;
    out.push(id);
  }
  return out;
}

/* ---------------- 生成 ---------------- */

export type FavBackupBuildFail =
  /** 清单超过 FAV_BACKUP_MAX。**明说，不截断**。 */
  | 'too-long'
  /** 收藏夹为空（或全被过滤掉了）—— 空码扫过去恢复不出任何东西。 */
  | 'empty'
  /** 口令为空 / WebCrypto 不可用。 */
  | 'crypto';

export type FavBackupBuildResult =
  | { ok: true; code: string; ids: string[] }
  | { ok: false; reason: FavBackupBuildFail };

/**
 * 造收藏备份码。
 *
 * 🔴🔴 口令不出这个函数：只作为 PBKDF2 的输入被消费，既不进码、
 *   也不进任何一个字节、也不被 return 出去（同 migrate/code.ts 的不变量）。
 *
 * @param ids 要备份的笔记名（已过滤）。顺序即收藏优先级，恢复后原样还原。
 * @param passphrase 用户口令。由用户在**本机**输入，不进码。
 * @param now 生成时刻（毫秒）。显式传入便于判据固定时间戳。
 */
export async function buildFavBackupCode(
  ids: readonly string[],
  passphrase: string,
  now: number = Date.now(),
): Promise<FavBackupBuildResult> {
  if (typeof passphrase !== 'string' || passphrase.length === 0) {
    return { ok: false, reason: 'crypto' };
  }
  // 防御性地再过一遍过滤：调用方可能直接把 readFavs() 的原始结果传进来。
  const f = collectFavBackupIds(ids, null);
  if (f.length === 0) return { ok: false, reason: 'empty' };
  // 🔴 容量判断在 PBKDF2 **之前**：600,000 次迭代不是免费的，
  //   超限时早退是省用户 1~2 秒。
  if (f.length > FAV_BACKUP_MAX) return { ok: false, reason: 'too-long' };

  const json = manifestJson({ v: 1, ts: now, f });
  let env: Envelope;
  try {
    const dk = await deriveKey(passphrase);
    // AAD 用 'note'：与单篇换机码同一个域标签。
    // 🔴 不另开AAD 标签是有意的 —— 开新标签要改 shared-schema 的 AadTag 联合类型，
    //   而两个码走的是同一种"用户口令派生"的载荷，语义上同类。
    //   （真要分开也该在**前缀**上分，那已经做了。）
    env = await encryptString(json, dk.key, 'note', dk);
  } catch {
    return { ok: false, reason: 'crypto' };
  }
  if (!envelopeShape(env)) return { ok: false, reason: 'crypto' };
  return { ok: true, code: FAV_BACKUP_PREFIX + b64ToB64Url(btoa(envJsonCompact(env))), ids: f };
}

/** 信封 → 紧凑 JSON（键序由代码决定，与 code.ts envJsonCompact 同款）。 */
function envJsonCompact(env: Envelope): string {
  return (
    '{"v":' +
    env.v +
    ',"alg":"' +
    env.alg +
    '","kdf":{"name":"' +
    env.kdf.name +
    '","iter":' +
    env.kdf.iter +
    ',"salt":"' +
    env.kdf.salt +
    '"},"iv":"' +
    env.iv +
    '","ct":"' +
    env.ct +
    '"}'
  );
}

/** 信封形状校验。任何一项不满足即拒收。 */
function envelopeShape(o: unknown): Envelope | null {
  if (typeof o !== 'object' || o === null) return null;
  const e = o as Partial<Envelope>;
  if (e.v !== 1) return null;
  if (e.alg !== 'AES-256-GCM') return null;
  if (typeof e.iv !== 'string' || e.iv === '') return null;
  if (typeof e.ct !== 'string' || e.ct === '') return null;
  const kdf = e.kdf;
  if (typeof kdf !== 'object' || kdf === null) return null;
  if (kdf.name !== 'PBKDF2-HMAC-SHA256') return null;
  // 🔴 iter 下限与 decryptString 一致（那里卡 100_000）。先挡一道是为了让
  //   "iter 被篡改成 1 次"的码**不跑 PBKDF2** 就被拒 —— 否则它就是个口令试错 oracle。
  if (!Number.isInteger(kdf.iter) || kdf.iter < 100_000) return null;
  if (typeof kdf.salt !== 'string' || kdf.salt === '') return null;
  return e as Envelope;
}

/* ---------------- 恢复 ---------------- */

export type FavBackupRestoreFail =
  /** 不是收藏备份码（缺前缀/结构不对）。 */
  | 'not-migrate'
  /** 口令不对，或密文被篡改（GCM 不可区分，也不该区分 —— 分开等于给暴力破解一个 oracle）。 */
  | 'pass'
  /** 载荷解开了但不是合法清单。 */
  | 'broken'
  /** WebCrypto 不可用。 */
  | 'crypto';

export type FavBackupRestoreResult =
  | { ok: true; ids: string[]; ts: number }
  | { ok: false; reason: FavBackupRestoreFail };

/** 收藏备份码 → 信封。结构不对返回 null。 */
export function readFavBackupEnvelope(code: string): Envelope | null {
  if (typeof code !== 'string') return null;
  const text = code.trim();
  if (!text.startsWith(FAV_BACKUP_PREFIX)) return null;
  const payload = text.slice(FAV_BACKUP_PREFIX.length);
  if (payload === '') return null;
  let json: string;
  try {
    json = atob(b64UrlToB64(payload));
  } catch {
    return null;
  }
  let o: unknown;
  try {
    o = JSON.parse(json);
  } catch {
    return null;
  }
  return envelopeShape(o);
}

/** 收藏备份码形状是否合法（**不解密**，供 UI 前置判据）。 */
export function isFavBackupCode(code: string): boolean {
  return readFavBackupEnvelope(code) !== null;
}

/**
 * 恢复：收藏备份码 + 用户口令 → 笔记名清单。
 *
 * 🔴🔴 失败时**绝不返回半个清单**：`{ok:false}` 分支上没有任何 `ids` 出口。
 *   调用方据此**不写收藏夹**（不 merge、不 writeFavs）。
 *   「恢复失败但收藏夹被清空/写坏」比直接报错糟糕得多 ——
 *   用户会以为备份成功过、于是删了旧设备上的收藏。
 */
export async function restoreFavBackupCode(
  code: string,
  passphrase: string,
): Promise<FavBackupRestoreResult> {
  const env = readFavBackupEnvelope(code);
  if (env === null) return { ok: false, reason: 'not-migrate' };
  if (typeof passphrase !== 'string' || passphrase.length === 0) {
    return { ok: false, reason: 'pass' };
  }

  let plain: string;
  try {
    // 🔴 必须用**信封里的 salt** 派生：换了 salt 就是另一把钥匙，必然失败。
    const dk = await deriveKey(passphrase, env.kdf.salt);
    plain = await decryptString(env, dk.key, 'note');
  } catch {
    return { ok: false, reason: 'pass' };
  }

  let o: unknown;
  try {
    o = JSON.parse(plain);
  } catch {
    return { ok: false, reason: 'broken' };
  }
  const m = parseManifest(o);
  if (m === null) return { ok: false, reason: 'broken' };
  return { ok: true, ids: m.f, ts: m.ts };
}

/* ---------------- 文案（逐字对齐老项目） ---------------- */

/**
 * 出码提示。老项目 :9187-9190 逐字：
 *   '新设备首页「扫码打开笔记」对准它，一键恢复 ' + n + ' 篇'
 *   +（skipped ? '（' + skipped + ' 篇无密钥未含）' : '')
 *   +（capped  ? '（超 ' + BAK_MAX + ' 篇未含 ' + capped + ' 篇）' : '')
 *   + '。看不清就点一下码'
 *
 * 🔴 一处**刻意保留**的老项目差异：老项目写「首页「扫码打开笔记」对准它」，
 *   本项目改成「首页「扫码换机」对准它」——
 *   因为老项目扫的是"一篇备份笔记的链接"（甲案载体），
 *   而本项目扫的是"清单码"本身，入口文案必须指向真正能扫它的那个按钮。
 *   其余逐字照抄，包括那半句与 skipped 括号。
 *
 * 🔴🔴 **刻意没有 `capped` 参数**（老项目有，本项目删了）：老项目那个分支存在，
 *     只因为它会截断清单；本项目出码侧改成"超限就明说 `too-long`"（见
 *   `collectFavBackupIds` 的注释与 `buildFavBackupCode`），
 *   所以出码时**永远不会丢篇**，"超 N 篇未含 M 篇"这个括号在出码侧不可达。
 *   留着这个参数会变成**恒 0 的死参数**，让后人以为"出码还会截断"——
 *   而真截断发生在**恢复侧**，那条路走`favRestoreTip(count, renewed, capped, favsMax)`
 *   的第三个参数，那里capped 是活的（`mergeFavs` → `normalizeFavs` 按老项目语义砍尾）。
 *
 * @param count 实际装进码里的篇数
 * @param skipped 因名不合法而未含的篇数（老项目第三条排除在本项目不适用，见文件头）
 */
export function favBackupTip(count: number, skipped: number): string {
  return (
    '新设备首页「扫码换机」对准它，一键恢复 ' +
    count +
    ' 篇' +
    (skipped > 0 ? '（' + skipped + ' 篇无密钥未含）' : '') +
    '。看不清就点一下码'
  );
}

/**
 * 恢复提示。老项目 :9270-9273 逐字：
 *   '已恢复 ' + n + ' 篇收藏'
 *   +（renewed ? '（覆盖 ' + renewed + ' 篇旧密钥）' : '')
 *   +（capped ? '，收藏夹满 ' + FAVS_MAX + ' 篇已丢弃最旧 ' + capped + ' 项' : ''）
 *
 * @param count 实际恢复进收藏夹的篇数（已含被丢弃的，按老项目口径是 `min(ok.length, FAVS_MAX)`）
 * @param renewed 覆盖了本机已有条目的篇数
 * @param capped 因收藏夹满而丢弃的篇数
 * @param favsMax 本机收藏夹上限（注入便于判据，不写死）
 */
export function favRestoreTip(
  count: number,
  renewed: number,
  capped: number,
  favsMax: number,
): string {
  return (
    '已恢复 ' +
    count +
    ' 篇收藏' +
    (renewed > 0 ? '（覆盖 ' + renewed + ' 篇旧密钥）' : '') +
    (capped > 0 ? '，收藏夹满 ' + favsMax + ' 篇已丢弃最旧 ' + capped + ' 项' : '')
  );
}