#!/usr/bin/env node
/**
 * NoteSync(bj) MCP server —— 让 AI 直接读写 bj.xuyinji.com.cn 上的加密笔记。
 *
 * 🔴 与老项目 MCP 的关系：**协议层沿用，实现层全部重做**。
 *   沿用的：stdio 手写 JSON-RPC、零第三方依赖、协议版本 2024-11-05、
 *   工具命名（locate/read/edit/image/remind/search/export/import）、
 *   错误用 isError + 纯文本、注册表记账。
 *   重做的：全部针对新架构 —— 操作对象是模型 JSON 而非 HTML、
 *   写入走 POST 而非 PUT、没有 baseV/x-note-key/403、
 *   搜索不做本机倒排索引、提醒直接落在 doc.reminders 而非"回写正文行再正则解析"。
 *
 * 🔴🔴 工具 description 是**给大模型读的说明书**，不是注释。
 *   写得含糊的代价是模型用错参数（给 HTML、给字符偏移），
 *   而症状是"工具报错"，模型会归因到自己没看清，然后反复重试。
 *   所以每一处与老项目不同的地方，都必须在 description 里写明。
 */
import { loadConfig, isValidId } from './config.ts';
import { Remote } from './remote.ts';
import { Vault, Registry } from './vault.ts';
import { plainOf, toolLocate, toolRead, toolEdit, toolSearch } from './tools-doc.ts';
import type { ToolCtx } from './tools-doc.ts';
import { toolRemind, REM_MAX } from './tools-remind.ts';
import { toolImage } from './tools-image.ts';
import { toolExport, toolImport } from './tools-backup.ts';
import { serveStdio, rpcResult, rpcError, callTool, PROTOCOL_VERSION, SERVER_INFO } from './rpc.ts';
import type { RpcRequest, ToolDef } from './rpc.ts';
import * as path from 'node:path';

const cfg = loadConfig();
const remote = new Remote({ base: cfg.base });
const vault = new Vault(remote, cfg.passphrase);
const registry = new Registry(path.join(cfg.cacheDir, 'registry.json'), cfg.seedNotes);

const docCtx: ToolCtx = {
  vault,
  defaultNote: cfg.defaultNote,
  listNames: () => registry.list(),
  plainTextOf: async (id) => {
    const n = await vault.load(id);
    return n === null ? null : { text: plainOf(n.doc) };
  },
};

const backupCtx = {
  vault,
  defaultNote: cfg.defaultNote,
  listNames: () => registry.list(),
  outDir: cfg.outDir,
};

/* ---------------- 工具声明 ---------------- */

const NAME_DESC = '笔记名（英文/数字/下划线/连字符，1-64 字符，会自动转小写）';

const TOOLS: ToolDef[] = [
  {
    name: 'note_locate',
    description:
      '按名称定位笔记，返回是否存在/大小/块数/提醒数。不存在时返回 exists:false（不是报错）。' +
      '服务端没有"列出全部笔记"的接口（无鉴权的列表等于公开广播所有笔记名），' +
      '所以本工具只能查你给出名字的那一篇。',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: NAME_DESC },
      },
    },
  },
  {
    name: 'note_read',
    description:
      '读笔记内容。format=text（默认）返回可读纯文本与提醒列表；' +
      'format=markdown 同 text（模型 JSON 的块结构本就接近 markdown，转换是无损的）；' +
      'format=json 返回完整模型 JSON（blocks/reminders），需要精确改动结构时用这个。' +
      '注意：这里的正文是**结构化块**（段落/标题/列表/引用/代码/图片/折叠），不是 HTML —— ' +
      '不要传 HTML，也不要用字符偏移定位。',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: NAME_DESC },
        format: { type: 'string', enum: ['text', 'markdown', 'json'] },
      },
    },
  },
  {
    name: 'note_edit',
    description:
      '编辑正文。按**行**操作，不按字符偏移（模型 JSON 里偏移不稳定）。' +
      'op=append 末尾追加；op=prepend 开头插入；op=insert_before / insert_after 在含 match 的那一行前后插入；' +
      'op=delete 删掉含 match 的那一行；op=replace 用 body 整篇替换（一行一段）。' +
      'match 是**纯文本子串**，命中多行时报错并列出行号（不会猜）。' +
      'heading 可把写入的行变成 h1/h2/h3（默认 p）。text 里的换行会拆成多行。',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: NAME_DESC },
        op: {
          type: 'string',
          enum: ['append', 'prepend', 'insert_before', 'insert_after', 'delete', 'replace'],
        },
        text: { type: 'string', description: '要写入的文字（append/prepend/insert_* 用）' },
        match: { type: 'string', description: '锚点：纯文本子串（insert_*/delete 用）' },
        body: { type: 'string', description: '整篇新正文，一行一段（replace 用）' },
        heading: { type: 'string', enum: ['p', 'h1', 'h2', 'h3'], description: '写入行的类型，默认 p' },
      },
      required: ['op'],
    },
  },
  {
    name: 'note_remind',
    description:
      '提醒管理。op=add（默认）设提醒：at 写中文时间句（"明天下午三点""下周五 10:30"）' +
      '或 ISO 串，text 是事项（≤20 字）。同一时刻同一事项会覆盖更新而不重复添加。' +
      `未来提醒上限 ${REM_MAX} 条。时间必须是将来的（至少 30 秒之后）。` +
      'op=list 列出全部（含 id，cancel/done 要用）；op=cancel 按 id 删一条（不动正文）；' +
      'op=done 按 id 标记完成；op=clear 只清理已过期/已完成的，不动未来的。' +
      '中文时间规则与网页端**同一份代码**，所以"网页端认得出的时间，这里也认得出"。',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: NAME_DESC },
        op: { type: 'string', enum: ['add', 'list', 'cancel', 'done', 'clear'] },
        at: { type: 'string', description: 'add：中文时间句或 ISO 串' },
        text: { type: 'string', description: 'add：提醒事项（≤20 字）' },
        id: { type: 'string', description: 'cancel/done：提醒 id（先用 op=list 拿）' },
      },
    },
  },
  {
    name: 'note_image',
    description:
      '把本机图片加入笔记：先上传图床，再作为图片块插入。png/jpg/jpeg/gif/webp，≤8MB，直传不压缩。' +
      '默认追加到末尾；给 match（纯文本子串）+ where=before/after 可插在指定行旁。' +
      'op=remove 按 match（图片 URL 或其子串）删掉那张图，匹配到多张时报错。' +
      '注意：若上传成功但写正文失败，返回的错误里会带上已上传的 URL —— 那种情况下图已在云端，不要重复上传。',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: NAME_DESC },
        op: { type: 'string', enum: ['add', 'remove'] },
        path: { type: 'string', description: '本机图片绝对路径（add 用）' },
        match: { type: 'string', description: 'add：锚点纯文本子串；remove：图片 URL 或其子串' },
        where: { type: 'string', enum: ['before', 'after'], description: 'add：插在锚点前还是后，默认 after' },
      },
    },
  },
  {
    name: 'note_search',
    description:
      '全文检索。对本机注册表里的每篇笔记逐篇拉取并解密比对（服务端无索引，所以是"每篇一次请求"）。' +
      'query 按空格分词，任一段原样命中即算命中。返回命中笔记、命中次数与±30字摘要。' +
      '局限：只能搜到**本工具碰过**的笔记（注册表靠工具调用记账）—— ' +
      '要用某篇请先 note_read 一次。',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '检索词；空格分隔的多词任一命中即返回' },
        names: { type: 'array', items: { type: 'string' }, description: '限定范围（默认注册表全部）' },
        limit: { type: 'number', description: '返回上限，默认 5，最大 20' },
      },
      required: ['query'],
    },
  },
  {
    name: 'note_export',
    description:
      '备份成zip。mode=plain（默认）含每篇的 .md（可读）与 .json（结构化），**是明文，落盘即裸奔**；' +
      'mode=raw 只含 .json。同样是明文但结构完整、便于程序处理 —— ' +
      '注意：本系统的密文只存在于服务端，本工具任何模式都不会导出服务端密文。' +
      '只有本工具打开过（注册表里）的笔记会被导出。',
    inputSchema: {
      type: 'object',
      properties: {
        names: { type: 'array', items: { type: 'string' }, description: '导出范围（默认注册表全部）' },
        mode: { type: 'string', enum: ['plain', 'raw'] },
        out: { type: 'string', description: '输出 zip 绝对路径（必须 .zip 结尾）' },
      },
    },
  },
  {
    name: 'note_import',
    description:
      '从 note_export 的 zip 恢复。mode=preview（默认）只报告计划、不写任何东西；mode=apply 才写。' +
      'apply 时逐篇先读远端：内容相同则跳过；内容不同且远端非空时**默认跳过**并列进 skipped，' +
      '只有 force=true 才覆盖。to 可把单篇导入改到另一个名字。' +
      '导入是逐篇独立的，一篇失败不影响其它篇。',
    inputSchema: {
      type: 'object',
      properties: {
        from: { type: 'string', description: '备份 zip 绝对路径' },
        mode: { type: 'string', enum: ['preview', 'apply'] },
        names: { type: 'array', items: { type: 'string' }, description: '只导入指定笔记' },
        to: { type: 'string', description: '改名的目标笔记名（仅单篇导入时可用）' },
        force: { type: 'boolean', description: '远端已有不同内容时仍覆盖（默认跳过）' },
      },
      required: ['from'],
    },
  },
];

/* ---------------- 工具实现表 ---------------- */

const impls: Record<string, (args: Record<string, unknown>) => Promise<unknown>> = {
  note_locate: (a) => {
    registry.add(String(a.name || cfg.defaultNote || ''));
    return toolLocate(docCtx, { name: a.name as string | undefined });
  },
  note_read: async (a) => {
    const name = String(a.name || cfg.defaultNote || '');
    registry.add(name);
    return toolRead(docCtx, { name: a.name as string | undefined, format: a.format as 'text' | 'json' | 'markdown' });
  },
  note_edit: async (a) => {
    const name = String(a.name || cfg.defaultNote || '');
    registry.add(name);
    return toolEdit(docCtx, a as never);
  },
  note_remind: async (a) => {
    const name = String(a.name || cfg.defaultNote || '');
    registry.add(name);
    return toolRemind(docCtx, a as never);
  },
  note_image: async (a) => {
    const name = String(a.name || cfg.defaultNote || '');
    registry.add(name);
    return toolImage({ vault, remote, defaultNote: cfg.defaultNote }, a as never);
  },
  note_search: (a) => toolSearch(docCtx, a as never),
  note_export: async (a) => {
    if (Array.isArray(a.names)) registry.addMany(a.names as string[]);
    return toolExport(backupCtx, a as never);
  },
  note_import: (a) => toolImport(backupCtx, a as never),
};

/* ---------------- 方法分发 ---------------- */

async function handle(req: RpcRequest): Promise<unknown | null> {
  const hasId = req.id !== undefined;
  const id = hasId ? (req.id as number | string | null) : null;
  switch (req.method) {
    case 'initialize':
      return rpcResult(id, {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: SERVER_INFO,
      });
    case 'notifications/initialized':
    case 'notifications/cancelled':
      return null; // 通知无响应
    case 'ping':
      return rpcResult(id, {});
    case 'tools/list':
      return rpcResult(id, { tools: TOOLS });
    case 'tools/call': {
      const p = (req.params ?? {}) as { name?: unknown; arguments?: unknown };
      const name = typeof p.name === 'string' ? p.name : '';
      const args =
        p.arguments && typeof p.arguments === 'object' ? (p.arguments as Record<string, unknown>) : {};
      return rpcResult(id, await callTool(impls, name, args));
    }
    default:
      if (!hasId) {
        //🔴 通知类未知方法：协议上不能回响应，但必须留痕（见 rpc.ts 文件头）
        if (!req.method.startsWith('notifications/')) {
          process.stderr.write('[notesync-bj-mcp] 未知方法：' + req.method + '\n');
        }
        return null;
      }
      return rpcError(id, -32601, 'method not found: ' + req.method);
  }
}

const io = {
  write: (obj: unknown) => {
    process.stdout.write(JSON.stringify(obj) + '\n');
  },
  error: (msg: string) => {
    process.stderr.write(msg + '\n');
  },
};

serveStdio(io, handle);

// 启动自检写stderr。**绝不能写 stdout** —— 那里是协议通道，
// 混进一行非JSON 会让客户端解析失败，而症状是"客户端说服务启动失败"。
process.stderr.write(
  `[notesync-bj-mcp] ready base=${cfg.base} note=${cfg.defaultNote || '(per-call)'} ` +
    `pass=${cfg.passphrase ? 'set' : 'MISSING'} cache=${cfg.cacheDir}\n`,
);

export { TOOLS, impls, handle, isValidId };
