/**
 * 构建期注入的全局常量
 *
 * 唯一来源是仓库根 package.json 的 version —— 由 tools/build.mjs 通过 esbuild `define`
 * 注入。任何地方都不许出现字面版本号（ARCH.md 红线 R5）。
 */

declare const __APP_VERSION__: string;
declare const __BUILD_DATE__: string;
declare const __SCHEMA_VERSION__: number;

export const APP_VERSION: string =
  typeof __APP_VERSION__ === 'string' ? __APP_VERSION__ : '0.0.0-dev';
export const BUILD_DATE: string =
  typeof __BUILD_DATE__ === 'string' ? __BUILD_DATE__ : '1970-01-01';
export const SCHEMA_VERSION: number =
  typeof __SCHEMA_VERSION__ === 'number' ? __SCHEMA_VERSION__ : 1;