/**
 * shared-schema 公开入口
 *
 * 真源层的唯一出口。客户端、服务端、MCP 三边都只从这里 import，
 * 禁止深层路径 import —— 否则将来加一层 shim 会有漏网的调用点。
 */

export * from './types.ts';
export * from './canonical.ts';
export * from './validate.ts';
export * from './merge.ts';
export * from './crypto.ts';
export * from './key-store.ts';

export const SCHEMA_VERSION = 1;
/** 本仓代码版本由 package.json 注入，见 tools/build.mjs 的 define */
export const BUILD_COMMIT = 'dev';
