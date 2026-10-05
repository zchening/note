/**
 * 换机码（扫码换机的载荷）—— 把一篇笔记的**密文**打成一段定长字符
 *
 * ═══════════════════════════════════════════════════════════════════════
 * 🔴🔴🔴 本文件是**新旧项目的第二个架构性分叉点**，必须讲清楚为什么不能照抄老项目。
 * ═══════════════════════════════════════════════════════════════════════
 *
 * 老项目（index.html:8939-9094「甲案」）的换机码里装的是 **AES 密钥本身**：
 *   `pairingUrlFor(id, keyB64)` → `<origin>/<备份笔记名>#k=<base64(rawKey)>`
 * 它成立的前提是老项目把 raw key 明文写在 localStorage（`KEY_STORE`），
 * 于是"把密钥写进二维码"对它来说零成本 —— 密钥本来就已经躺在 localStorage 里了。
 *
 * 新项目的密钥是 `extractable:false` 的 CryptoKey（shared-schema/key-store.ts），
 * **WebCrypto 层面物理上导不出 raw 字节**。所以"把密钥放进码"这条路在本项目不存在，
 * 照抄老项目就必须先把密钥降级成可导出 —— 那等于亲手拆掉本项目最重要的一条安全属性。
 *
 * 于是本模块走**老项目 v7.7.0 之前那条更早的路**（index.html:8816 `notesync-backup:v1:`）：
 * **码里装密文，不装密钥。**
 *   码 = 前缀 + base64url(envelope JSON)
 *   envelope = AES-256-GCM(PBKDF2-HMAC-SHA256 600,000 次(用户口令) 派生的密钥, 文档 JSON)
 *
 * 换来的是一条比老项目**更强**的性质：
 *   老项目：扫到码 = 拿到密钥 = 拿到全部笔记的明文（且密钥永不变，改口令也救不回来）
 *   本项目：扫到码 = 只拿到一段密文。**没有口令就什么都解不开**，
 *           而口令按设计**不进码**（用户在新设备上手输），
 *           所以"二维码被人拍了"不再等于"笔记泄露"。
 *
 * 与 scan/pair-link.ts 的分叉是同一条线的延伸：
 *   配对码带**口令**（省一次输入，扫的是同一台设备上的同一篇）
 *   换机码带**密文**（跨设备搬数据，密钥不出 WebCrypto）
 *
 * ── 恒定密度码（老项目 v10.1.4 花了三轮才想明白的那件事）────────────────────
 * 老项目 10.1.4 的血泪注释（index.html:8941-8950）值得原文抄在这里：
 *   "旧路线把「收藏 + 全部密钥」整包塞进一张二维码：每篇固定约 80 字节，
 *    篇数一多格子数线性涨，而 drawQrTo 弹窗态把显示宽锁在 260px ——
 *    第 3~4 篇起每格已掉到 0.6mm 以下，手机屏对手机屏物理上解不出。"
 *
 * 本项目用**另一条路**达成同一目标：**定长padding**。
 * AES-GCM 密文长度 = 明文长度 + 16 字节 tag，所以只要把明文 pad 到**固定**字节数，
 * 密文长度恒定 → base64 长度恒定 → **二维码格子数与笔记内容完全无关**。
 * 于是"短笔记"与"长笔记"出的码是**同一个尺寸**，扫码体验不随内容漂移。
 *
 * padding 只能 pad 在 JSON **外面**（尾部空白），不能 pad 在字段里：
 *   - pad 在字段里会改变字符串内容，恢复出来的笔记里会多出一截空格
 *   - pad 在 JSON 外面是纯语法空白：JSON.parse 的语法本身就允许值之后有 JSONWhitespace，
 * 所以"定长"与"恢复出来的内容逐字等于源"这两条**不冲突**。
 *
 * ── 零 DOM 依赖 ──────────────────────────────────────────────────────────
 * 与 landing-logic / pair-link 同款纪律：纯计算部分可以单测，也可以塞进 e2e。
 */

import {
  canonicalize,
  decryptString,
  deriveKey,
  encryptString,
  parseDoc,
  type Doc,
  type Envelope,
} from '@bj/shared-schema';

/**
 * 换机码前缀。
 *
 * 🔴 为什么需要前缀（而不是"看着像 base64 就解"）：扫码结果与手动粘贴都走同一个入口，
 *   而那个入口同时还收配对链接（`https://…/#p=`）。没有前缀的话两类载荷必须靠
 *   "试解一次"来区分 —— 于是"配对链接被当换机码解"会走出一条
 *   用户完全想不到原因的错误路径（症状与"口令不对"一模一样）。
 *   前缀让分流变成**一眼可判**，这也正是老项目 `BACKUP_PREFIX` 的做法。
 */
export const MIGRATE_PREFIX = 'nsbak1:';

/**
 * 明文（文档 JSON）pad 到的**固定**字节数。
 *
 * 🔴🔴 这个数字是"扫码能不能成"与"一篇笔记装不装得下"的**唯一权衡点**，取值三条硬判据：
 *
 *  1. **必须装得下绝大多数真笔记**。文档 JSON 的大小主要由 blocks 决定，
 *     空文档约 30 字节，一段几百字的笔记约 300-500 字节。480 覆盖了绝大多数场景。
 *
 *  2. **必须让格子数停在手机屏扫得出的范围**。老项目实锤：260px 弹窗态下
 *     每格低于约 5px 就开始"扫半天没反应"。本项目的码走同一条展示路径
 *     （scan/panel.ts 的点码放大 + migrate 面板的定长码），
 *     480 字节明文 + GCM tag + 头部 ≈ 700 字节载荷，是版本 20 上下的格子数，
 *     配放大层能扫；再往上（1024+）格子数逼近 45×45 以上，
 *     手机对手机就回到老项目踩过的那条"物理上解不出"。
 *
 *  3. **超出必须有明确文案**，不能静默截断（截断 = 恢复出一篇被腰斩的笔记，
 *     用户以为换机成功了，内容却少了一截 —— 这是最坏的一种失败）。
 *     所以超限时抛 `too-long`，由面板显示"这篇笔记太长，扫码换机装不下"。
 *
 * 改这个数会改变码长 → 18-qr-migrate.test.js 的"定长"断言仍成立
 * （它断言的是**不同内容等长**，不是某个绝对值）。
 */
export const MIGRATE_PAYLOAD_CAP = 480;

/** 换机码的载荷上限（明文字节）。供 UI 在生成前预判，避免白跑一次 600,000 次 PBKDF2。 */
export function fitsInMigrateCode(docJson: string): boolean {
  return utf8Len(docJson) <= MIGRATE_PAYLOAD_CAP;
}

function utf8Len(s: string): number {
  return new TextEncoder().encode(s).length;
}

/* ---------------- base64url（复用 pair-link 的口径，但作用在字节上）---------------- */

/**
 * 标准 base64 → base64url（去padding）。
 *
 * 🔴 为什么不直接 import scan/pair-link 的 b64UrlEncode：那个签名是 `(string) => string`
 *   （内部 TextEncoder + atob），是给"口令这种文本"设计的；
 *   本模块要编的是**字节**（envelope JSON 的 UTF-8），走一遍 pair-link 的
 *   文本路径会多一次无谓的编码往返，且两处口径一旦分叉就查不出来。
 *   这里只做 base64 字符级变换，是同一套 base64url 定义的最小实现。
 */
function b64ToB64Url(b64: string): string {
  return b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/**
 * base64url → 标准 base64。
 *
 * 🔴 padding 必须按 `(4 - len % 4) % 4` **精确**补回：
 *   无脑补 `'==='` 会让 atob 对已自padding 的输入抛错
 *   （atob 对长度 %4 == 1 直接抛，那是补不回来的非法长度）。
 */
function b64UrlToB64(s: string): string {
  const pad = (4 - (s.length % 4)) % 4;
  return s.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat(pad);
}

/* ---------------- 生成 ---------------- */

/** 生成失败。**每一种都有对应文案**，不给"操作失败"这种无信息量的兜底。 */
export type MigrateBuildFail =
  /** 文档 JSON 超过定长容量，pad 不进去。 */
  | 'too-long'
  /** 文档为空（真源尚未初始化）。空文档换过去没有意义，且多半是调用顺序错了。 */
  | 'empty'
  /** 派生/加密失败（WebCrypto 不可用等）。 */
  | 'crypto';

export type MigrateBuildResult = { ok: true; code: string } | { ok: false; reason: MigrateBuildFail };

/**
 * 造换机码。
 *
 * 🔴🔴 **口令不出这个函数**：它只作为 PBKDF2 的输入被消费，
 *   既不进码、也不进 `code` 的任何一个字节、也不被 return 出去。
 *   这是本功能的核心安全不变量，由 18-qr-migrate.test.js 的安全断言守着。
 *
 * @param doc  要搬走的笔记（**真源模型**，不是 HTML —— 老项目搬的是 innerHTML，
 *   新项目的真源是 Doc JSON，见 serialize.ts）
 * @param passphrase 用户口令。**由用户在旧设备上手输**，不出码。
 */
export async function buildMigrateCode(doc: Doc, passphrase: string): Promise<MigrateBuildResult> {
  if (typeof passphrase !== 'string' || passphrase.length === 0) return { ok: false, reason: 'crypto' };
  const blocks = doc?.blocks;
  if (!Array.isArray(blocks)) return { ok: false, reason: 'empty' };

  // 🔴 走 canonicalize 而不是 JSON.stringify(doc)：
  //   canonical 形态是**同一篇笔记的唯一表示**（键序、空数组省略都归一），
  //   所以"源笔记"与"恢复出来的笔记"逐字相等这条断言才有意义 ——
  //   否则同一篇内容经 JSON.stringify 往返可能因键序不同而文本不等，
  //   测试就会逼我去写一个"忽略键序"的宽松断言，那正是假绿的来源。
  const json = canonicalize(doc);
  if (json.length === 0) return { ok: false, reason: 'empty' };
  if (!fitsInMigrateCode(json)) return { ok: false, reason: 'too-long' };

  // 🔴 定长pad：pad 在 JSON **外面**的语法空白上，parseDoc 天然容忍。
  //   见文件头「恒定密度码」一节的论证（pad 在字段里会往笔记里塞空格）。
  const padded = json + ' '.repeat(MIGRATE_PAYLOAD_CAP - utf8Len(json));

  let env: Envelope;
  try {
    const dk = await deriveKey(passphrase);
    // AAD 用 'note'：载荷语义就是一篇笔记正文，与真源同域。
    env = await encryptString(padded, dk.key, 'note', dk);
  } catch {
    return { ok: false, reason: 'crypto' };
  }

  // 🔴 信封形状自己校验一遍再出码：宁可这里返回 crypto 失败，
  //   也不要出一张"扫得出来但解不开"的码 —— 那等于让用户白扫一次。
  const shape = envelopeShape(env);
  if (!shape) return { ok: false, reason: 'crypto' };

  return { ok: true, code: MIGRATE_PREFIX + b64ToB64Url(btoa(envJsonCompact(env))) };
}

/** 信封 → 紧凑 JSON（键序固定）。定长码要求同一篇笔记的字节可复现。 */
function envJsonCompact(env: Envelope): string {
  // 🔴 手工拼而不是 JSON.stringify：键序由**代码**决定而不是对象属性插入顺序，
  //   后者在跨引擎/跨版本时没有保证。
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

/* ---------------- 恢复 ---------------- */

export type MigrateRestoreFail =
  /** 不是换机码（缺前缀/结构不对）。给"这不是换机码"，别给"口令不对"。 */
  | 'not-migrate'
  /** 口令不对，或密文被篡改（GCM 不可区分，也不该区分 —— 见 ARCH 安全不变量）。 */
  | 'pass'
  /** 载荷解开了但不是合法文档。 */
  | 'broken'
  /** WebCrypto 不可用。 */
  | 'crypto';

export type MigrateRestoreResult = { ok: true; doc: Doc } | { ok: false; reason: MigrateRestoreFail };

/** 信封形状校验。**任何一项不满足都不出码/不收码**。 */
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
  // 🔴 iter 下限与 decryptString 一致（那里卡 100_000）。
  //   这里**先**挡一道，是为了让"iter 被篡改成 1 次"这种码在**不跑 PBKDF2** 的前提下
  //   就被拒掉 —— 否则攻击者可以把一台设备变成"口令试错成本趋近 0"的 oracle。
  if (!Number.isInteger(kdf.iter) || kdf.iter < 100_000) return null;
  if (typeof kdf.salt !== 'string' || kdf.salt === '') return null;
  return e as Envelope;
}

/** 换机码 → 信封。结构不对返回 null。 */
export function readMigrateEnvelope(code: string): Envelope | null {
  if (typeof code !== 'string') return null;
  const text = code.trim();
  if (!text.startsWith(MIGRATE_PREFIX)) return null;
  const payload = text.slice(MIGRATE_PREFIX.length);
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

/** 换机码是不是形状合法的换机码（**不解密**，供 UI 与测试做前置判据）。 */
export function isMigrateCode(code: string): boolean {
  return readMigrateEnvelope(code) !== null;
}

/**
 * 恢复：换机码 + 用户手输的口令 → 文档。
 *
 * 🔴🔴 失败时**绝不返回半个文档**。`{ok:false}` 分支上没有任何"部分恢复"的出口，
 *   调用方据此**不写任何东西**（不建笔记、不写缓存、不写 key-store）。
 *   这是 18-qr-migrate.test.js 里两条反向闸（错误口令 / 篡改码）要守的东西：
 *   失败路径上一旦漏了一次写，"恢复失败但笔记被清空"就会发生 ——
 *   那比直接报错糟糕得多（用户原文没了他却不知道）。
 */
export async function restoreMigrateCode(code: string, passphrase: string): Promise<MigrateRestoreResult> {
  const env = readMigrateEnvelope(code);
  if (env === null) return { ok: false, reason: 'not-migrate' };
  if (typeof passphrase !== 'string' || passphrase.length === 0) return { ok: false, reason: 'pass' };

  let plain: string;
  try {
    // 🔴 必须用**信封里的 salt** 派生：换了 salt 就是另一把钥匙，必然失败。
    const dk = await deriveKey(passphrase, env.kdf.salt);
    plain = await decryptString(env, dk.key, 'note');
  } catch {
    // 口令错与密文被改在这里不可区分，也不该区分 —— 区分开等于给暴力破解一个 oracle。
    return { ok: false, reason: 'pass' };
  }

  let doc: Doc;
  try {
    // 🔴 去掉定长pad 造成的尾部空白再 parse。trim 是安全的：
    //   canonicalize 的输出是 JSON，JSON 语法本身不容许"字符串外的尾随空白"，
    //   所以被trim 掉的只有我们自己加的 pad。
    doc = parseDoc(plain.trim());
  } catch {
    return { ok: false, reason: 'broken' };
  }
  return { ok: true, doc };
}

/**
 * 把恢复出来的文档**重新封成一份干净的 note 域信封**，供本地缓存使用。
 *
 * 🔴🔴 为什么必须重封而不能直接把换机码的 envelope 写进缓存：
 *   缓存的载荷必须是一个**文档 JSON**（openCache 之后 parseDoc 直接吃它）。
 *   换机码的载荷是**pad 过的 JSON**，塞进缓存会让 openCache 解出一个带尾随空格的对象，
 *   后续 parseDoc 虽然能容忍，但缓存与真源就永远不是同一份字节了 ——
 *   "缓存 == 真源"这条不变量一破，离线读到的与在线读到的就会分叉。
 *
 * 🔴🔴 失败时返回 null 而不抛：调用方把"重封失败"当作"不写缓存"处理即可。
 *   缓存是增强项（unlock.ts 纪律 2），为它崩掉整次恢复是本末倒置。
 *
 * @param passphrase 与 `restoreMigrateCode` 同一个口令（调用方保证）
 * @param env 换机码的信封（salt/iter 与派生密钥必须与恢复时一致）
 */
export async function resealMigrateDoc(
  doc: Doc,
  passphrase: string,
  env: Envelope,
): Promise<Envelope | null> {
  try {
    const dk = await deriveKey(passphrase, env.kdf.salt);
    return await encryptString(canonicalize(doc), dk.key, 'note', dk);
  } catch {
    return null;
  }
}