/**
 * 解锁 —— 把「用户输入的口令」变成「一把可用的密钥 + 一个可用的本地缓存」
 *
 * 🔴🔴 本文件是整个应用里最容易出现"看起来解锁了、其实没解"的地方。三条铁律：
 *
 *  1. **口令不能只判非空**。必须真的派生密钥并尝试解开远端信封。
 *     假成功的症状：用户看到空编辑器，以为"云端没内容"，重写一遍推上去，
 *     把另一台设备上的正文覆盖掉。**静默的数据丢失比报错糟糕得多。**
 *
 *  2. **口令错与数据坏必须同一句错误文案**。区分开等于给暴力破解一个 oracle：
 *     能分辨"口令对但数据坏"的人可以用它探测口令空间。
 *
 *  3. **salt 决定一切**。`decryptString` 用**信封里的 salt** 重算密钥，
 *     所以「同一口令」必须意味着「同一 salt」。生产环境由两处保证：
 *       - 首次创建：随机生成 salt，随密钥一起存进 IndexedDB
 *       - 再次进入：远端信封自带 salt，用它重算
 *     测试里必须手工共享同一把 dk（否则报出来的是"口令不对"，与病因十万八千里）。
 *
 * 本模块**零 DOM 依赖**，可以在 node 里单测。fetch 由外部注入。
 */

import {
  canonicalize,
  decryptString,
  deriveKey,
  emptyDoc,
  encryptString,
  normalize,
  parseDoc,
  type Doc,
  type DerivedKey,
  type Envelope,
  putKey,
  resolveKey,
  delKey,
} from '@bj/shared-schema';
import {
  clearCache,
  envelopeOf,
  openCache,
  readCache,
  writeCache,
  cacheKeyOf,
  type CachedEnvelope,
} from './local-cache.ts';
import { dropPassVault, readPassVault, savePassVault } from './pass-vault.ts';
import { deriveWriteKey } from './write-key.ts';

export { clearCache, readCache, writeCache, cacheKeyOf };
export type { CachedEnvelope };

/** 口令错 / 数据坏 —— 同一句话，不区分（ARCH 安全不变量） */
export const PASS_ERROR = '口令不对，或数据无法解密';
export interface UnlockDeps {
  noteId: string;
  passphrase: string;
  /** 注入 fetch，便于测试与日后接 Cloudflare 通道 */
  fetchImpl?: typeof fetch;
}

export interface UnlockOk {
  ok: true;
  key: CryptoKey;
  dk: DerivedKey;
  /**
   * 远端**确实没有**这篇笔记（首次创建），调用方应立刻把空文档推上去，
   * 否则另一台设备永远看不到"这篇笔记存在"。
   */
  fresh: boolean;
  /** 远端已有的文档（若能解密）。新笔记为空文档。 */
  doc: Doc;
  /** 本次是否需要立刻落缓存（新笔记 or 远端版本更新） */
  shouldCache: boolean;
  /**
   * 从本机保险箱里解出来的口令（记忆解锁时才有）。
   *
   * 🔴 有它 ⇒ 配对码/换机码**免输口令**即可生成（用户报障：每次点都要输）。
   *   没有（undefined）⇒ 与老项目"本机没留"同款，退回问一次口令。
   *   见 ./pass-vault.ts 的安全口径注释：它与密钥同生共死，锁定即失效。
   *
   * 🔴 显式含 `| undefined` 而不是 `?:`：本仓开了 `exactOptionalPropertyTypes`，
   *   `?:` 不接受"显式赋值 undefined"，而 readPassVault 解不开时正是这么表达。
   */
  passphrase: string | undefined;
}

export interface UnlockFail {
  ok: false;
  /** 唯一一种用户可见失败：口令错或数据坏。offline 单独区分，因为处置方式不同。 */
  reason: 'pass' | 'offline' | 'broken';
  message: string;
}

export type UnlockResult = UnlockOk | UnlockFail;

const OFFLINE_MSG = '连不上服务器，请检查网络';

/** 取远端信封。返回 'empty' 表示 200 + 空体（确实没有这篇笔记）。 */
async function fetchRemote(
  noteId: string,
  f: typeof fetch,
): Promise<{ kind: 'empty' } | { kind: 'env'; env: Envelope } | { kind: 'offline' } | { kind: 'broken' }> {
  let res: Response;
  try {
    res = await f(`/api/note/${encodeURIComponent(noteId)}`, {
      headers: { accept: 'application/json' },
      cache: 'no-store',
    });
  } catch {
    // 🔴 网络层失败。**不能**当成"笔记为空"—— 那会把用户已有正文清空。
    return { kind: 'offline' };
  }
  if (res.status === 429) return { kind: 'offline' };
  if (!res.ok) return { kind: 'offline' };
  const text = await res.text();
  if (text.trim() === '') return { kind: 'empty' };
  try {
    const o = JSON.parse(text) as Partial<Envelope>;
    if (typeof o.iv !== 'string' || typeof o.ct !== 'string' || !o.kdf || typeof o.kdf.salt !== 'string') {
      return { kind: 'broken' };
    }
    return { kind: 'env', env: o as Envelope };
  } catch {
    return { kind: 'broken' };
  }
}

/**
 * 已在 key-store 里存过密钥 → 直接复用，不再问口令。
 * 🔴 这一步是"本机记住口令"的真身。老项目用 localStorage 布尔标记当记住，
 *   结果是"标记在但密钥没了"时依然进编辑器 = 假成功。新项目必须拿得到密钥才算记住。
 */
export async function unlockIfRemembered(noteId: string): Promise<UnlockOk | undefined> {
  const rec = await resolveKey(noteId);
  if (!rec) return undefined;
  const dk: DerivedKey = { key: rec.key, saltB64: rec.salt, iter: rec.iter };
  // 🔴 记忆解锁也必须拿得出**口令**，否则配对码/换机码会退化成"每次都要输"
  //   （用户报障原话）。保险箱解不开（换过口令/清过 IndexedDB）就当没有，
  //   退回问一次 —— 与"记忆失效"同一条兜底路径，不新增失败形态。
  const vaultPass = await readPassVault(noteId, rec.key);
  // 🔴🔴 必须**先**判断缓存存在，再去解。
  //   顺序反了会踩这个坑：openCache 解不开时会顺手清掉坏缓存，
  //   于是"本来就没缓存"与"缓存坏了被清掉"两种情况读出来都是 undefined，
  //   分不出来 → 坏缓存被当成"记忆有效"，用户拿着空文档进编辑器，
  //   看上去一切正常，实际上正文丢了。
  const cached = readCache(noteId);
  if (cached === undefined) {
    // 只有密钥没有缓存：记忆有效，文档暂空，交给 sync 去拉远端
    return { ok: true, key: rec.key, dk, fresh: false, doc: emptyDoc(), shouldCache: false, passphrase: vaultPass };
  }
  const plain = await openCache(noteId, rec.key);
  if (plain === undefined) {
    // 缓存有却解不开（换过口令 / 缓存被篡改）→ 记忆无效，退回要求输入口令
    return undefined;
  }
  return { ok: true, key: rec.key, dk, fresh: false, doc: parseDoc(plain), shouldCache: false, passphrase: vaultPass };
}

/** 真正的解锁：用户刚输了口令。 */
export async function unlock(deps: UnlockDeps): Promise<UnlockResult> {
  const { noteId, passphrase } = deps;
  if (passphrase.length === 0) {
    return { ok: false, reason: 'pass', message: PASS_ERROR };
  }
  const f = deps.fetchImpl ?? fetch;
  const remote = await fetchRemote(noteId, f);

  /* --- 情况一：远端有信封 --- */
  if (remote.kind === 'env') {
    const iter = remote.env.kdf.iter;
    let dk: DerivedKey;
    try {
      // 🔴 用**远端信封里的 salt** 派生。换了 salt 就是另一把钥匙，必然失败。
      dk = await deriveKey(passphrase, remote.env.kdf.salt);
    } catch {
      return { ok: false, reason: 'pass', message: PASS_ERROR };
    }
    let plain: string;
    try {
      plain = await decryptString(remote.env, dk.key, 'note');
    } catch {
      // 🔴 口令错与数据坏在这一刻是无法区分的，也不该区分。
      return { ok: false, reason: 'pass', message: PASS_ERROR };
    }
    let doc: Doc;
    try {
      doc = parseDoc(plain);
    } catch {
      return { ok: false, reason: 'broken', message: '云端数据无法解析' };
    }
    await putKey({ id: noteId, key: dk.key, salt: dk.saltB64, iter: dk.iter, savedAt: Date.now() });
        // 🔴 记住口令（封在本笔记密钥里）—— 否则下次「记忆解锁」进来点配对/换机又要输一次。
        await savePassVault(noteId, passphrase, dk);
    // 远端是权威版本，本地缓存必须跟着更新（否则下次离线打开是旧内容）
    writeCache(noteId, remote.env);
    return { ok: true, key: dk.key, dk, fresh: false, doc, shouldCache: true, passphrase };
  }

  /* --- 情况二：远端是空的（新笔记），但本地有缓存 --- */
  if (remote.kind === 'empty') {
    const c = readCache(noteId);
    if (c) {
      // 本机有内容但云端空：多半是"换设备时先建后推"被打断。
      // 用缓存的 salt 派生同一把钥匙，把本地内容**推回云端**。
      try {
        const dk = await deriveKey(passphrase, c.salt);
        const plain = await decryptString(envelopeOf(c), dk.key, 'note');
        const doc = parseDoc(plain);
        await putKey({ id: noteId, key: dk.key, salt: dk.saltB64, iter: dk.iter, savedAt: Date.now() });
        // 🔴 记住口令（封在本笔记密钥里）—— 否则下次「记忆解锁」进来点配对/换机又要输一次。
        await savePassVault(noteId, passphrase, dk);
        return { ok: true, key: dk.key, dk, fresh: false, doc, shouldCache: false, passphrase };
      } catch {
        clearCache(noteId);
        // 落到下面"全新笔记"分支
      }
    }
    // 全新笔记：随机 salt，派生，存起来
    let dk: DerivedKey;
    try {
      dk = await deriveKey(passphrase);
    } catch {
      return { ok: false, reason: 'pass', message: PASS_ERROR };
    }
    await putKey({ id: noteId, key: dk.key, salt: dk.saltB64, iter: dk.iter, savedAt: Date.now() });
        // 🔴 记住口令（封在本笔记密钥里）—— 否则下次「记忆解锁」进来点配对/换机又要输一次。
        await savePassVault(noteId, passphrase, dk);
    return { ok: true, key: dk.key, dk, fresh: true, doc: emptyDoc(), shouldCache: true, passphrase };
  }

  /* --- 情况三：断网 --- */
  if (remote.kind === 'offline') {
    // 🔴 断网时**只要本机有缓存**就放行（老项目离线可读是核心体验之一），
    //   但绝不用新 salt 派生 —— 那会造出一把解不开旧缓存的钥匙。
    const c = readCache(noteId);
    const rec = await resolveKey(noteId);
    if (c && rec) {
      const plain = await openCache(noteId, rec.key);
      if (plain !== undefined) {
        return {
          ok: true,
          key: rec.key,
          dk: { key: rec.key, saltB64: rec.salt, iter: rec.iter },
          fresh: false,
          doc: parseDoc(plain),
          shouldCache: false,
          passphrase: await readPassVault(noteId, rec.key),
        };
      }
    }
    if (c) {
      // 有缓存但没密钥（换了浏览器/清了 IndexedDB）：用缓存 salt 派生
      try {
        const dk = await deriveKey(passphrase, c.salt);
        const plain = await decryptString(envelopeOf(c), dk.key, 'note');
        return { ok: true, key: dk.key, dk, fresh: false, doc: parseDoc(plain), shouldCache: false, passphrase };
      } catch {
        // 口令确实不对
      }
    }
    return { ok: false, reason: 'offline', message: OFFLINE_MSG };
  }

  /* --- 情况四：远端数据坏了 --- */
  return { ok: false, reason: 'broken', message: '云端数据无法解析' };
}

/** 改口令：解开旧的、用新口令重新加密整篇文档。 */
export async function changePassphrase(
  noteId: string,
  oldPass: string,
  newPass: string,
  doc: Doc,
  f: typeof fetch = fetch,
): Promise<{ ok: true } | { ok: false; message: string }> {
  const before = await unlock({ noteId, passphrase: oldPass, fetchImpl: f });
  if (!before.ok) return { ok: false, message: before.message };
  if (newPass.length === 0) return { ok: false, message: PASS_ERROR };
  let dk: DerivedKey;
  try {
    dk = await deriveKey(newPass);
  } catch {
    return { ok: false, message: PASS_ERROR };
  }
  const plain = canonicalize(normalize(doc));
  const env = await encryptString(plain, dk.key, 'note', dk);
  // 凭据原子换绑（老项目 apiPut 的 wkKey/wkOld 同款）：新凭据走新口令+新盐，
  // wkOld 出示旧凭据自证——换绑与写入同批完成，无自锁窗口。
  // 派生失败=按无凭据降级（off 档照写成功，full 档服务端拒 → 下面 403 分支如实报）。
  const wkNew = await deriveWriteKey(noteId, newPass, dk);
  const wkOld = await deriveWriteKey(noteId, oldPass, before.dk);
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (wkNew) headers['x-note-key'] = wkNew;
  const res = await f(`/api/note/${encodeURIComponent(noteId)}`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ ...env, n: plain.length, ...(wkOld ? { wkOld } : {}) }),
  });
  if (res.status === 403) {
    // 凭据被服务端拒：本机密钥已作废（多半是口令又在别处改过）。文案与老项目 claim 同款。
    return { ok: false, message: '本机保存的密钥已失效（口令可能在其他设备改过）。请退出锁定、重新输入口令解锁本篇，否则无法保存。' };
  }
  if (!res.ok) return { ok: false, message: OFFLINE_MSG };
  await putKey({ id: noteId, key: dk.key, salt: dk.saltB64, iter: dk.iter, savedAt: Date.now() });
  // 🔴 记住**新**口令（封在新密钥里）。此处必须是 newPass 而不是 oldPass：
  //   改完口令后旧的那团保险箱密文已经被新密钥解不开了，不重存就会出现
  //   "改了口令之后点配对码又变成要输口令"。
  await savePassVault(noteId, newPass, dk);
  writeCache(noteId, env);
  return { ok: true };
}

/** 锁定：删掉本机密钥与缓存。**只清本机**，云端数据不动。 */
export async function lockNote(noteId: string): Promise<void> {
  clearCache(noteId);
  // 🔴 口令保险箱必须与密钥一起删。只删密钥不删它，下次解锁时会残留一团
  //   解不开的密文（无害）；只删它不删密钥，则"锁定后仍能出配对码"复活。
  dropPassVault(noteId);
  try {
    await delKey(noteId);
  } catch {
    /* ignore */
  }
}
