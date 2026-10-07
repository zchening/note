/**
 * 「换机恢复后免输口令」的材料生产与自证（用户报障第 3 条）
 *
 * ══════════════════════════════════════════════════════════════════════════
 * 🔴🔴🔴 本模块是**唯一**一处「凭据自证」的实现，出码侧与恢复侧共用同一段代码 ——
 *   出码时用它造自证块，恢复时用它验自证块。两侧各写一份的话，
 *   迟早出现"造的时候用 AAD='note'、验的时候用 'meta'"这种**恒绿**的错配：
 *   两处代码都"看着对"，单测也各自绿，但真机上每一篇都免输不了。
 *
 * ── 它解决什么 ─────────────────────────────────────────────────────────────
 *   用户报障第 3 条：新设备扫描换机备份码恢复收藏夹后，进那些笔记
 *   **不应该再次要求输入口令**。
 *
 *   bj 的密钥是 `extractable:false` 的 CryptoKey，**物理上导不出 raw 字节**
 *   （老项目能装 raw key 是因为它的密钥明文躺在 localStorage）。
 *   ⇒ 这里装的是 **salt + 自证密文**：salt 让恢复端能派生出候选钥匙，
 *     自证密文让恢复端能**证明**这把候选钥匙就是那一把。
 *
 * ── 🔴🔴🔴 为什么"自证"是承重墙，不是可选优化 ──────────────────────────────
 *   bj 是每篇一把独立锁。**只装 salt 是不够的**：
 *   `deriveKey(备份码口令, salt)` 永远算得出一把钥匙，但算得出 ≠ 是那一把。
 *   用户给不同笔记设了不同口令时，派生出来的是一把**错**钥匙。
 *   而 `unlockIfRemembered`（sync/unlock.ts:147-149）那条
 *   "只有密钥、没有正文缓存"的分支**照样返回 ok:true** ⇒
 *   用户看到的是一个**空编辑器**，而正文在云端好好躺着。
 *
 *   **空编辑器 + 零报错 = 静默的数据丢失。** 用户会以为云端没内容，
 *   重新写一遍推上去，把旧设备上的正文覆盖掉。
 *   所以本模块的铁律是：**自证不通过 ⇒ 一律不写钥匙**，
 *   让那篇走正常口令框（多问一次，只是麻烦；给错钥匙，是丢数据）。
 *
 * ── 与老项目的分叉（必须保留，别在后人"优化"时抹平）─────────────────────
 *   老项目清单装的是 raw key 本身（`out.push([id, k])`）
 *   ⇒ 扫到清单 = 拿到全部钥匙 = 零输入。
 *   bj 做不到也不该做。本模块装的东西**不增加任何离线爆破能力**：
 *   攻击者本来就能拿云端信封里的 salt 去试口令（unlock.ts:174 同款），
 *   自证块只是把"试出来了"这件事**证明**出来，不给"试不出来"任何额外阻力。
 *
 * ── 零 DOM 依赖 ────────────────────────────────────────────────────────────
 * 与 bak-note.ts / fav-backup.ts 同款纪律：纯逻辑 + 注入依赖，
 * 可 `node --test` 直跑（判据见 test/bak-materials.test.mjs）。
 */

import { decryptString, deriveKey, encryptString, type DerivedKey } from '@bj/shared-schema';
import { BAK_PROOF_TEXT, PROOF_AAD, type BakMaterial } from './bak-note.ts';

/* ------------------------------------------------------------------ *
 * 出码侧：为某篇的真密钥造一段自证密文
 * ------------------------------------------------------------------ */

/**
 * 用该篇的真密钥加密 `BAK_PROOF_TEXT`，产出一份可离线验证的材料。
 *
 * 🔴 传进来的是**已派生的那把钥匙**（`resolveKey` 的结果），不是口令 ——
 *   因为出码那台机器上每篇的钥匙早就躺在 keystore 里了，重新派生 600,000 次
 *   PBKDF2 是纯浪费（实测单次 62ms，100 篇就是 6 秒白等）。
 *   派生发生在**用户当初设口令那一次**，出码只负责"用现成的钥匙签个名"。
 *
 * @param dk 该篇的真密钥记录。`key` 解不开自证块就是材料错，不做任何兜底。
 */
export async function makeBakMaterial(dk: DerivedKey): Promise<BakMaterial> {
  const env = await encryptString(BAK_PROOF_TEXT, dk.key, PROOF_AAD, dk);
  // 🔴 自证块存**整个 envelope 的 JSON**，不是裸 ct —— 因为 `decryptString`
  //   要 iv 与 kdf 参数才能验 AAD。少存一项，恢复端就只能"猜"，
  //   而"猜对了"的判据恒绿（这正是本项目栽过的那类坑）。
  return { s: dk.saltB64, c: JSON.stringify(env) };
}

/* ------------------------------------------------------------------ *
 * 恢复侧：验自证
 * ------------------------------------------------------------------ */

/**
 * 拿备份码的口令 + 一份材料，**证明**出那把该篇的钥匙。
 *
 * @returns 自证通过 ⇒ 该篇的 `DerivedKey`；**任何**不通过 ⇒ `null`。
 *   🔴🔴 约定死：**不抛**。抛的话调用方每个调用点都得 try/catch，
 *   而漏掉一处 catch 的后果是整个恢复流程崩掉 —— 而那篇本该只是"多问一次口令"。
 *
 * 三条不通过的口径（对调用方是同一件事：这篇要口令）：
 *   ① 没材料（v1 老备份 / 本机出码时没这把钥匙）
 *   ② 口令错（用户给这篇单独设了别的口令）
 *   ③ 材料被改过（云端密文被篡改 ⇒ GCM 认证失败）
 */
export async function proveBakMaterial(
  passphrase: string,
  mat: BakMaterial | null | undefined,
): Promise<DerivedKey | null> {
  if (!mat || typeof passphrase !== 'string' || passphrase === '') return null;
  try {
    // 只认材料里那两个字段（清单是**外部输入**，多出来的键不许混进来）
    const env = JSON.parse(mat.c) as Parameters<typeof decryptString>[0];
    const dk = await deriveKey(passphrase, mat.s);
    const plain = await decryptString(env, dk.key, PROOF_AAD);
    // 🔴🔴 双重判据：GCM 通过**不等于**内容对。
    //   只查"能解开"的话，把 A 篇的自证块塞进 B 篇的材料里也会通过 ——
    //   因为同一把钥匙当然解得开自己签的任何东西。必须比对明文是那个常量。
    if (plain !== BAK_PROOF_TEXT) return null;
    return dk;
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------------ *
 * 批量：出码侧逐篇取钥匙
 * ------------------------------------------------------------------ */

/**
 * 为清单里的每一篇取一份材料。
 *
 * @param ids 篇名，与返回数组**同下标**。
 * @param deriveFor 取该篇真密钥的通路（生产是 `deriveKeyFor`）。
 *   抽成参数是为了判据能注入，也为了让本模块不依赖 key-store（零 DOM / 零 IDB）。
 *
 * 🔴🔴 **下标必须严格跟随篇名**：返回的第 i 项永远是 ids[i] 那篇的材料。
 *   错位的症状是"恢复后随机的某篇打不开"，而且极难自查 ——
 *   所以 BAK-MAT-03 专门钉这一条，且用两篇不同 salt 来承重。
 *
 * 🔴 **单篇失败不许连坐**：某篇取不到钥匙 ⇒ 那一项是 `null`，
 *   它恢复后照常要口令；绝不能 throw 让整份备份失败
 *   （为了 1 篇把 99 篇的备份一起搞砸，是最坏的一种失败）。
 */
export async function collectBakMaterials(
  ids: readonly string[],
  deriveFor: (id: string) => Promise<DerivedKey | undefined>,
): Promise<(BakMaterial | null)[]> {
  const out: (BakMaterial | null)[] = [];
  for (const id of ids) {
    try {
      const dk = await deriveFor(id);
      out.push(dk ? await makeBakMaterial(dk) : null);
    } catch {
      out.push(null);
    }
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * 批量：恢复侧逐篇自证 + 写钥匙
 * ------------------------------------------------------------------ */

export interface BakProveResult {
  /** 自证通过、已写入钥匙的篇名（恢复后进这些篇不���再问口令）。 */
  exempt: string[];
  /** 自证没通过、仍需用户输口令的篇名。 */
  needPass: string[];
}

/**
 * 逐篇自证，**自证通过才调 onPutKey**。
 *
 * 🔴🔴🔴 本函数是用户报障第 3 条的**全部安全边界**所在：
 *   `onPutKey` 一旦在自证之前被调用，用户就会拿到一把可能错的钥匙，
 *   而 `unlockIfRemembered` 会拿它当"本机记不记得"的凭据返回 ok:true
 *   ⇒ **空编辑器 + 零报错**。所以顺序是死的：先验，再写。
 *
 * @param passphrase 备份码口令（配对链接 `#p=` 里那个）。空 ⇒ 全部 needPass。
 * @param onPutKey 写钥匙的回调。**由本函数在自证通过后才调用**，
 *   调用方绝不许自己另写一条 putKey 路径（那正是这条纪律要防的事）。
 *
 * @returns 报数。`exempt.length` 必须等于 onPutKey 的实际调用次数 ——
 *   恢复卡上要如实报"N 篇已免输"，两者不一致就是谎报（BAK-MAT-04 钉这条）。
 */
export async function proveBakMaterials(
  ids: readonly string[],
  mats: readonly (BakMaterial | null)[],
  passphrase: string,
  onPutKey: (id: string, dk: DerivedKey) => Promise<void> | void,
): Promise<BakProveResult> {
  const exempt: string[] = [];
  const needPass: string[] = [];
  for (let i = 0; i < ids.length; i++) {
    const id = ids[i] as string;
    const dk = await proveBakMaterial(passphrase, mats[i] ?? null);
    if (!dk) {
      needPass.push(id);
      continue;
    }
    await onPutKey(id, dk);
    exempt.push(id);
  }
  return { exempt, needPass };
}
