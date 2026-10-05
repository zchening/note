/**
 * HTML 转义 —— 内联 innerHTML 拼字符串时的唯一防线
 *
 * 🔴🔴 存在的理由（不是"防御性编程"，是已确认的漏洞）：
 *   菜单面板用 innerHTML 拼 DOM，而插进去的 label 来自**用户自己的笔记正文**
 *   （冲突条目、收藏夹名字、历史版本标题）。一个写了
 *   `<img src=x onerror=alert(1)>` 的笔记名，会在打开菜单的那一刻执行。
 *
 *   这在纯本地单人应用里看着"危害有限"，但新项目将来会接扫码配对
 *   （别人的设备能创建同名笔记）与 MCP（外部写入），入口就变成外部可控了。
 *
 * 🔴 纪律：**任何**来自笔记/文件名/用户输入的字符串进 innerHTML 前必须过这里。
 *   函数名故意取得很蠢（escapeHtml），就是为了让"grep 一下"能查全。
 *   查不到 = 有人在裸插。
 */

/** 转义 & < > " ' 五个字符。够覆盖属性值与文本节点两种上下文。 */
export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * 转义后**截断**，避免超长文本撑破面板。
 * 🔴 按字符截断而不是字节：中文按字节切会切出半个字，显示成豆腐块。
 */
export function escapeTrunc(s: string, max = 60): string {
  const t = s.length <= max ? s : `${s.slice(0, max - 1)}…`;
  return escapeHtml(t);
}
