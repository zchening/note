/**
 * 与 bj 服务端的 HTTP 契约层。
 *
 * 🔴🔴 这里的方法名/路径/body 字段**必须与新服务端逐字对齐**
 *   （packages/server/src/server.js），对齐了才有下面这三条：
 *   1. 读是 `GET /api/note/<id>`，**不存在的笔记返回 200 + 空体**（不是 404）。
 *      服务端注释写明理由：给 4xx 会让客户端当成网络错误去重试。
 *      所以"读不到"在这里表示为 `null`，不是抛错 —— 把空体当 404 处理会让
 *      每次读新笔记都走错误分支。
 *   2. 写是 `POST`（不是老项目的 PUT），body 是**整份信封 JSON**，
 *      服务端不做 409/乐观并发，是last-write-wins + 写后 SSE 广播。
 *   3. **没有 `x-note-key`、没有 `baseV`、没有 403**。
 *      老项目 v10.0.0 引入的 HMAC 写入凭据属于"服务端有鉴权"的前提，
 *      新服务端不设鉴权（数据全在密文里），所以这一整套都不存在。
 *      照抄老项目的 403 重试在这里会永远不触发，删掉。
 *
 * 那新服务端"谁能写"由什么挡？由 Caddy 前置 + 密文本身：
 * 拿不到口令的人写进去的是自己解不开的垃圾，而**真客户端**读到后
 * 合并会把它当噪声块处理。用户可见层面的影响是"多一条乱码行"，
 * 不是"数据泄漏"。这一条记在ARCH 里，验收时按这个口径判。
 */
import type { Envelope } from '@bj/shared-schema';

export interface RemoteNote {
  /** 服务端上的原文（整份信封 JSON 的字符串形态） */
  raw: string;
  /** 能解析成信封时给出，解析不出给 null（老数据/被写坏） */
  env: Envelope | null;
}

export class RemoteError extends Error {
  readonly status: number;
  constructor(msg: string, status: number) {
    super(msg);
    this.name = 'RemoteError';
    // 🔴🔴 这里刻意**不用** TypeScript 的参数属性语法
    //   （`constructor(msg: string, readonly status: number)`）。
    //   参数属性需要"生成代码"，而 node 的类型剥离是 strip-only 模式 ——
    //   它只擦类型、不改代码，碰到参数属性直接报
    //   ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX。
    //   🔴 最阴的地方是**tsc 完全不报错**（那是合法 TS），
    //   所以 typecheck 全绿也照样起不来。症状：只有真跑这个进程才会炸。
    this.status = status;
  }
}

export interface RemoteDeps {
  base: string;
  fetchImpl?: typeof fetch;
}

export class Remote {
  private readonly base: string;
  private readonly f: typeof fetch;

  constructor(deps: RemoteDeps) {
    this.base = deps.base;
    this.f = deps.fetchImpl ?? fetch;
  }

  /**
   * 读一篇笔记。**不存在返回 null**（不是抛错）。
   * 🔴 无超时是刻意的？不 —— 必须加。老项目这里完全没超时，
   *   后果是网络挂住时 MCP 工具调用永远不返回，宿主只能等它超时。
   *   这里统一给超时，且超时报成一句人话（用户看到的是"读超时"而不是进程挂住）。
   */
  async get(id: string, timeoutMs = 20000): Promise<RemoteNote | null> {
    const url = `${this.base}/api/note/${encodeURIComponent(id)}`;
    let res: Response;
    try {
      res = await this.f(url, { cache: 'no-store', signal: AbortSignal.timeout(timeoutMs) });
    } catch (e) {
      throw new Error(`读 ${id} 超时或网络不可达（${timeoutMs}ms）：${msgOf(e)}`);
    }
    if (res.status === 429) {
      throw new RemoteError('尝试太频繁（服务端限流），稍后再试', 429);
    }
    if (!res.ok) throw new Error(`GET /api/note failed: HTTP ${res.status}`);
    const text = await res.text();
    if (text.trim() === '') return null;
    return { raw: text, env: parseEnvelope(text) };
  }

  /**
   * 写一篇笔记（整份信封覆盖）。
   * 🔴 服务端响应是 `{ok:true,size}`，**没有版本号**。
   *   老项目返回的 `v` 是单调递增版本号（因为它有 baseV 乐观并发），
   *   新服务端 last-write-wins 不需要，所以这里**不编造** v ——
   *   编一个假的"版本号"会让调用方的成功判据变成永远为真。
   *   要判断"是不是我这份写上去了"，用 size 与本地 canonical 长度对一下即可。
   */
  async put(id: string, env: Envelope, noteChars: number, timeoutMs = 20000): Promise<{ bytes: number }> {
    const url = `${this.base}/api/note/${encodeURIComponent(id)}`;
    let res: Response;
    try {
      res = await this.f(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ...env, n: noteChars }),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (e) {
      throw new Error(`写 ${id} 超时或网络不可达（${timeoutMs}ms）：${msgOf(e)}`);
    }
    if (res.status === 429) throw new RemoteError('尝试太频繁（服务端限流），稍后再试', 429);
    if (!res.ok) throw new Error(`POST /api/note failed: HTTP ${res.status}`);
    const j = (await res.json().catch(() => ({}))) as { ok?: boolean; size?: number };
    if (j.ok !== true) throw new Error('写已返回但响应未确认成功（缺 ok:true），不当作写成功');
    return { bytes: typeof j.size === 'number' ? j.size : 0 };
  }

  async del(id: string, timeoutMs = 20000): Promise<void> {
    const url = `${this.base}/api/note/${encodeURIComponent(id)}`;
    let res: Response;
    try {
      res = await this.f(url, { method: 'DELETE', signal: AbortSignal.timeout(timeoutMs) });
    } catch (e) {
      throw new Error(`删 ${id} 超时或网络不可达（${timeoutMs}ms）：${msgOf(e)}`);
    }
    if (!res.ok) throw new Error(`DELETE /api/note failed: HTTP ${res.status}`);
  }

  /**
   * 取图床一次性签名。
   * 🔴 与老项目一致的纪律：**签发失败绝不降级**。
   *   降级成"免签直投"看着是让功能继续可用，实际是把整个图床暴露成公开可写 ——
   *   那不是"降级"，是把安全属性悄悄换掉了。
   */
  async upsign(id: string, timeoutMs = 15000): Promise<UpsignResult> {
    const url = `${this.base}/api/upsign`;
    let res: Response;
    try {
      res = await this.f(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ note: id }),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (e) {
      throw new Error(`取上传签名失败（${timeoutMs}ms）：${msgOf(e)}`);
    }
    if (!res.ok) throw new Error(`POST /api/upsign failed: HTTP ${res.status}`);
    const j = (await res.json().catch(() => ({}))) as Partial<UpsignResult>;
    if (!j.signature || !j.api_key) throw new Error('上传签名响应不完整（缺 signature 或 api_key）');
    return {
      signature: String(j.signature),
      api_key: String(j.api_key),
      timestamp: String(j.timestamp ?? ''),
      upload_preset: String(j.upload_preset ?? ''),
      folder: String(j.folder ?? ''),
      cloud_name: j.cloud_name ? String(j.cloud_name) : undefined,
    };
  }
}

export interface UpsignResult {
  signature: string;
  api_key: string;
  timestamp: string;
  upload_preset: string;
  folder: string;
  cloud_name?: string;
}

/** 宽容解析：服务端存的必须是合法信封，但"解析不出"不该让整个读操作失败。 */
export function parseEnvelope(text: string): Envelope | null {
  try {
    const j = JSON.parse(text) as Partial<Envelope>;
    if (typeof j.ct !== 'string' || typeof j.iv !== 'string' || !j.kdf) return null;
    if (typeof j.kdf.salt !== 'string' || typeof j.kdf.iter !== 'number') return null;
    return j as Envelope;
  } catch {
    return null;
  }
}

function msgOf(e: unknown): string {
  if (e instanceof Error) return e.message || e.name;
  return String(e);
}
