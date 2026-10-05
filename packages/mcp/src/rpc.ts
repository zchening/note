/**
 * MCP stdio JSON-RPC 传输层。
 *
 * 🔴 沿用老项目"手写 JSON-RPC、零 SDK"的做法。理由与老项目一致，
 *   但有一处**刻意不同**（老项目的做法在这份代码里是个真问题）：
 *   老项目对「id 缺失的未知方法」静默丢弃。静默丢弃在客户端看来是
 *   "我发了个请求，永远等不到回答也没人报错"——
 *   而 stdio 协议里客户端是**一定**会等响应的。
 *   所以这里仍然不回响应（通知本来就无响应，这是协议），
 *   但会把未知方法打到 stderr：无声的丢弃最难自查。
 *
 * 🔴🔴 一行一条 JSON、不能有跨行请求。stdin 常见 chunk 边界在任意字节位置，
 *   所以必须**自己缓冲到换行再解析**。直接 `JSON.parse(chunk)` 的写法
 *   会在"一次 data 事件里带了半条消息"时抛错，且表现为随机失败。
 */
export type RpcId = number | string | null;

export interface RpcRequest {
  jsonrpc: '2.0';
  id?: RpcId;
  method: string;
  params?: unknown;
}

export interface ToolDef {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
  };
}

export interface Stdio {
  write: (obj: unknown) => void;
  error: (msg: string) => void;
}

export function rpcResult(id: RpcId, result: unknown): unknown {
  return { jsonrpc: '2.0', id, result };
}

export function rpcError(id: RpcId, code: number, message: string): unknown {
  return { jsonrpc: '2.0', id, error: { code, message } };
}

/** MCP 协议版本。老项目硬编码 2024-11-05，新项目沿用（宿主兼容面最广的那个）。 */
export const PROTOCOL_VERSION = '2024-11-05';

export const SERVER_INFO = { name: 'notesync-bj', version: '0.1.0' };

export type ToolImpl = (args: Record<string, unknown>) => Promise<unknown>;

/**
 * 组装一次 tools/call 的响应。
 *
 * 🔴🔴 错误**必须**是 `isError:true` + 纯文本，不能是 JSON。
 *   协议里 content 是给模型读的文本块；把错误包成 JSON 会让模型
 *   先解析一遍才知道失败了，而它在失败时往往直接放弃重试。
 *   老项目这个做法是对的，照搬。
 */
export async function callTool(impls: Record<string, ToolImpl>, name: string, args: Record<string, unknown>): Promise<unknown> {
  const fn = impls[name];
  if (!fn) {
    return { content: [{ type: 'text', text: `ERROR: 没有这个工具：${name}` }], isError: true };
  }
  try {
    const result = await fn(args);
    return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
  } catch (e) {
    const msg = e instanceof Error ? e.message || e.name : String(e);
    return { content: [{ type: 'text', text: 'ERROR: ' + msg }], isError: true };
  }
}

/** 挂上 stdin 读循环。返回 unregister 函数（测试要用）。 */
export function serveStdio(io: Stdio, handle: (req: RpcRequest) => Promise<unknown | null>): () => void {
  let buf = '';
  const onData = (chunk: Buffer | string): void => {
    buf += typeof chunk === 'string' ? chunk : chunk.toString('utf8');
    let idx: number;
    while ((idx = buf.indexOf('\n')) !== -1) {
      const line = buf.slice(0, idx).trim();
      buf = buf.slice(idx + 1);
      if (line === '') continue;
      let req: RpcRequest;
      try {
        req = JSON.parse(line) as RpcRequest;
      } catch {
        //🔴 解析不了的行不能回错误：id 都不知道回给谁，
        //   而乱回一个 {id:null} 会让客户端以为它的某个请求收到了"不支持"。
        io.error('[notesync-bj-mcp] 收到无法解析的一行，已忽略：' + line.slice(0, 200));
        continue;
      }
      void handle(req).then((res) => {
        if (res !== null) io.write(res);
      });
    }
  };
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', onData);
  const onEnd = (): void => {
    process.exit(0);
  };
  process.stdin.on('end', onEnd);
  return () => {
    process.stdin.off('data', onData);
    process.stdin.off('end', onEnd);
  };
}
