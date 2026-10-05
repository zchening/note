/**
 * MCP 配置 —— 只从环境变量读，不读配置文件、不解析命令行参数。
 *
 * 🔴 为什么沿用"环境变量唯一入口"（老项目也是这么做的）：
 *   MCP 进程的启动方式由宿主（MCP client）决定，它只会照mcp.json 里写的
 *   command/args/env 起进程 —— 配置文件和命令行参数在那种启动方式下根本到不了。
 *   做成"读配置文件"只会让人以为配了就能生效。
 *
 * 🔴🔴 BJ_BASE 的默认值**不能**写成 https://bj.xuyinji.com.cn 然后"顺带"复用
 *   老项目的 CACHE_DIR：老项目的注册表与索引里存着老笔记的**真名**，
 *   新项目读它就等于"新项目能看到老项目的笔记清单"—— 这正是必须彻底独立的东西。
 *   所以缓存目录另起一个根，且不共用。
 */
import * as os from 'node:os';
import * as path from 'node:path';

export interface McpConfig {
  /** 服务基址，尾部斜杠已 strip */
  base: string;
  /** 默认笔记名；工具入参缺省时用它，空串表示必须每次显式给 */
  defaultNote: string;
  /** 口令。为空则一切需要明文的操作都拒（不静默失败） */
  passphrase: string;
  /** 长图 / 备份 zip 落盘目录 */
  outDir: string;
  /** 注册表与检索索引的持久目录（**与老项目不同根**） */
  cacheDir: string;
  /** 索引明文落盘，仅调试用 */
  indexPlain: boolean;
  /** 种子笔记名，逗号分隔 */
  seedNotes: string[];
}

/** 老项目的缓存根。新项目**绝不能**读它。 */
const LEGACY_CACHE_DIR = path.join(os.homedir(), '.notesync-mcp');

/**
 * 笔记名白名单。与老项目同为 `/^[A-Za-z0-9_-]{1,64}$/`，但**含义不同**：
 * 老项目那是"文件名安全 + 下发给服务端的名"，新项目它同时决定 API path 的一段，
 * 而服务端 `validId` 还会再拒一次。两边都留着是刻意的：MCP 这层早拒，
 * 能省掉一次注定失败的往返。
 */
const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

export function isValidId(name: string): boolean {
  return ID_RE.test(name);
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): McpConfig {
  const base = (env.BJ_BASE || 'https://bj.xuyinji.com.cn').replace(/\/+$/, '');
  const rawCache = env.BJ_CACHE_DIR || path.join(os.homedir(), '.notesync-bj-mcp');
  // 🔴 兜底：万一有人把 BJCACHE_DIR 指到老项目根上，宁可报错也不要读。
  //   症状会是"新项目的MCP 报列出老笔记的名字"，症状离原因很远。
  if (path.resolve(rawCache) === path.resolve(LEGACY_CACHE_DIR)) {
    throw new Error('BJ_CACHE_DIR 不得指向老项目的缓存目录（' + LEGACY_CACHE_DIR + '）');
  }
  return {
    base,
    defaultNote: env.BJ_NOTE || '',
    passphrase: env.BJ_PASSPHRASE || '',
    outDir: env.BJ_OUT_DIR || path.join(os.tmpdir(), 'notesync-bj-mcp'),
    cacheDir: rawCache,
    indexPlain: env.BJ_INDEX_PLAIN === '1',
    seedNotes: (env.BJ_NOTES || '').split(',').map((s) => s.trim()).filter((s) => s !== ''),
  };
}

/** 归一化 + 校验笔记名。大小写归一是老项目 v10.1.1 的做法，必须照做。 */
export function assertId(name: string): string {
  const n = String(name || '').trim().toLowerCase();
  if (!ID_RE.test(n)) {
    throw new Error('笔记名只允许 1-64 位的英文/数字/下划线/连字符：' + JSON.stringify(name));
  }
  return n;
}
