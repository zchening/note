/**
 * 口令 → 密钥 → 明文，以及本机注册表。
 *
 * 🔴🔴 复用真源层的 deriveKey/encryptString/decryptString，**一个字都不重写**。
 *   踩过的坑：自己写一遍 PBKDF2 时把迭代次数写成200000（老项目值），
 *   而真源层是 600000 —— 后果是"MCP 写的笔记网页端解不开"，且没有任何报错
 *   （GCM 认证失败才报错，而错误信息长得和口令错一模一样，极难自查）。
 *   这类"两处各写一份"的账，账本就是 bug 本身。
 *
 * 🔴 密钥缓存的 key 含 salt —— 换 salt 必须重新派生。
 *   缓存 key 只用笔记名会返回**上一把**密钥，症状是"改完口令后 MCP 写的东西全废了"。
 */
import { deriveKey, decryptString, encryptString, bytesToB64, b64ToBytes } from '@bj/shared-schema';
import type { CryptoKey, DerivedKey, Envelope } from '@bj/shared-schema';
import { canonicalize, parseDoc, validateDoc, NotCanonicalError } from '@bj/shared-schema';
import type { Doc } from '@bj/shared-schema';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Remote } from './remote.ts';
import { assertId } from './config.ts';

export const AAD_NOTE = 'note' as const;

export class VaultError extends Error {
  constructor(msg: string) {
    super(msg);
    this.name = 'VaultError';
  }
}

export class Vault {
  /** key = `id|saltB64`；不设上限是因为笔记数有限，而淘汰逻辑写错会造成间歇性解密失败 */
  private readonly keyCache = new Map<string, DerivedKey>();

  private readonly remote: Remote;
  private passphrase: string;

  constructor(remote: Remote, passphrase: string) {
    // 🔴 不用参数属性（见 remote.ts RemoteError 处的说明：strip-only 模式不支持，
    //   而 tsc 不报错 —— 只能靠"真跑一次"发现）。
    this.remote = remote;
    this.passphrase = passphrase;
  }

  setPassphrase(p: string): void {
    if (p !== this.passphrase) {
      //🔴 换口令必须清缓存：留着旧密钥的话，解出来的还是旧口令的内容，
      //   症状是"改了口令但读到的还是旧笔记"。
      this.keyCache.clear();
      this.passphrase = p;
    }
  }

  mustPass(): string {
    if (!this.passphrase) {
      throw new VaultError('未配置口令：无法解密。请设置环境变量 BJ_PASSPHRASE 后重启 MCP。');
    }
    return this.passphrase;
  }

  private async keyFor(id: string, saltB64: string): Promise<DerivedKey> {
    const ck = `${id}|${saltB64}`;
    const hit = this.keyCache.get(ck);
    if (hit) return hit;
    const dk = await deriveKey(this.mustPass(), saltB64);
    this.keyCache.set(ck, dk);
    return dk;
  }

  /**
   * 读一篇笔记并解密。
   * 🔴 口令对/数据坏**必须报同一句**（ARCH 安全不变量）：
   *   分开说"口令不对"和"数据损坏"，等于给暴力破解一个 oracle。
   *   老项目在这个位置栽过，措辞沿用。
   */
  async load(id: string): Promise<{ doc: Doc; env: Envelope; bytes: number } | null> {
    const r = await this.remote.get(id);
    if (r === null) return null;
    if (r.env === null) {
      throw new VaultError('解密失败：口令不对或密文损坏（服务器上的这篇笔记格式无法识别）');
    }
    const dk = await this.keyFor(id, r.env.kdf.salt);
    let plain: string;
    try {
      plain = await decryptString(r.env, dk.key, AAD_NOTE);
    } catch {
      throw new VaultError('解密失败：口令不对或密文损坏');
    }
    let doc: Doc;
    try {
      doc = parseDoc(plain);
    } catch (e) {
      // 🔴 这里是唯一一处值得区分"格式不对"的地方 —— 因为它不是口令问题，
      //   而是"有人往这个笔记名下面写了一篇本系统解不开的东西"（比如用 MCP 的
      //   错误口令写进去的）。不说清楚，用户会去反复试口令，而真因在别处。
      throw new VaultError(
        `解密成功但内容不是合法笔记（${e instanceof Error ? e.message : String(e)}）。` +
          '常见原因：这个笔记名下的内容是别处写坏的，本工具写不进合法笔记。',
      );
    }
    return { doc, env: r.env, bytes: r.raw.length };
  }

  /** 写入一篇笔记。**永远写 canonical 形态** —— 不写的话下次读回来会触发归一，表现为"内容凭空变了"。 */
  async save(id: string, doc: Doc): Promise<{ bytes: number; chars: number }> {
    // 🔴 validateDoc 是**抛错**而不是返回问题列表（真源层的契约）。
    //   这里必须先过它再加密：把结构不合法的文档写上服务端，
    //   网页端读回来时会在 normalize/validate 里炸，而那时已经晚了 ——
    //   用户看到的是"网页打开就白屏"，真因在几分钟前的一次 MCP 调用。
    try {
      validateDoc(doc);
    } catch (e) {
      throw new VaultError('笔记结构不合法，拒绝写入：' + (e instanceof Error ? e.message : String(e)));
    }
    const text = canonicalize(doc);
    let canonical: string;
    try {
      canonical = canonicalize(parseDoc(text));
    } catch (e) {
      if (e instanceof NotCanonicalError) throw new VaultError('canonical 往返不自洽，拒绝写入');
      throw e;
    }
    if (canonical !== text) {
      //🔴 这条不该可能发生。它真发生了 = canonicalize 不是幂等的，
      //   而那会变成"读回来内容变了"这种查不出的bug。宁可写失败也不能写出去。
      throw new VaultError('canonical 序列化未达幂等（内部一致性检查失败），拒绝写入');
    }
    const dk = await deriveKey(this.mustPass());
    const env = await encryptString(canonical, dk.key, AAD_NOTE, dk);
    const r = await this.remote.put(id, env, canonical.length);
    return { bytes: r.bytes, chars: canonical.length };
  }
}

/* ---------------- 本机注册表 ---------------- */

/**
 * 笔记名清单。**服务端故意没有列表 API**（老项目的注释理由是对的：
 * 无鉴权的列表接口等于公开广播全部笔记名），所以枚举只能靠本机记账。
 *
 * 🔴🔴 任何一次工具调用成功后都把涉笔的名字记进来 —— 这样"AI 改过的笔记"
 *   下次就还能被搜到/导出。反过来说，**没被 AI 碰过的笔记，MCP 看不见**，
 *   这是"服务端零索引"架构的固有代价，不是 bug。验收时要用 MCP 写过的笔记验。
 */
export class Registry {
  private names: string[] = [];
  private readonly file: string;

  constructor(file: string, seeds: string[] = []) {
    this.file = file;
    for (const s of seeds) this.add(s);
  }

  private load(): void {
    try {
      const j = JSON.parse(fs.readFileSync(this.file, 'utf8')) as { names?: unknown };
      if (Array.isArray(j.names)) {
        for (const n of j.names) if (typeof n === 'string') this.names.push(n);
      }
    } catch {
      // 读不到/读坏了就当空。老项目同款：注册表坏了不能挡住读写正文。
    }
  }

  private save(): void {
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      const uniq = [...new Set(this.names)].sort();
      fs.writeFileSync(
        this.file,
        JSON.stringify({ names: uniq, updatedAt: Date.now() }, null, 2),
        'utf8',
      );
    } catch {
      // 写失败不挡返回：正文已经存到服务端了，为此报失败会让用户以为没存上
    }
  }

  add(name: string): void {
    try {
      const n = assertId(name);
      if (!this.names.includes(n)) {
        this.names.push(n);
        this.save();
      }
    } catch {
      // 非法名不入册（调用方会自己报出来）
    }
  }

  addMany(names: string[]): void {
    const before = this.names.length;
    for (const n of names) this.add(n);
    if (this.names.length !== before) this.save();
  }

  list(): string[] {
    if (this.names.length === 0) this.load();
    return [...new Set(this.names)].sort();
  }
}

/**
 * 🔴 提醒 id **必须由 makeRemId 生成，不得自己造随机 id**。
 *   它的规则是"时间戳 + 事项摘要哈希"，所以同一时间同一事项天然得到同一 id。
 *   MCP 自己造随机 id 的话，"AI 设的提醒"和"网页端认出的提醒"就成了两条 ——
 *   症状是提醒弹两次，或删一条另一条还在，而两处代码都觉得自己是对的。
 */
export { makeRemId } from '../../client/src/reminder/reconcile.ts';
