/**
 * NAT- 原生（APK壳内）判据闸
 *
 * 🔴🔴🔴 本文件修的是一个**静默失效**的真实缺陷，形态与"用了类名 ≠ 样式命中它"同族：
 *   bj 此前4 处读`window.__NOTESYNC_NATIVE__ === true` 判「在不在 APK 里」，
 *   而**那个标志全仓从未被赋值**（6 处读、0 处写，android 侧也没注入）
 *   ⇒ 恒 `undefined` ⇒ `=== true` 恒假 ⇒ **真机 APK 里也判不出来**。
 *
 *   静默失效的三个后果（都不是"报错"，是"该走的分支永远走不到"）：
 *     ① APK 里也在注册 Service Worker（`registerSW` 的早退永不触发）；
 *     ② APK 里导出长图走不到原生复制那一档；
 *     ③ APK 里顶栏品牌位永远不显示当前笔记名（老项目 v7.3.2 的口径）。
 *
 * 🔴🔴 本文件最大的纪律：**判据必须能区分"模拟原生"与"真网页"两种页面**。
 *   只写 `assert.equal(isNativeApp(), false)` 的话，
 *   把实现换成 `return false` 也能全绿 —— 恒真断言等于没有断言。
 *   所以下面每条正向都配一条反向（注入 Capacitor 后必须翻成true）。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { isNativeApp } from '../src/platform/native-detect.ts';

/**
 * 在一个**干净的 window 形状**上求值 isNativeApp()。
 *
 * 🔴 为什么每次都重建 window 而不是改一个全局：
 *   判据若复用同一个对象，前一条用例注入的 Capacitor 会漏给下一条 ——
 *   顺序一换，"真网页"那条就会莫名其妙地绿。
 */
function probe(capacitor) {
  const saved = globalThis.window;
  if (capacitor === undefined) {
    delete globalThis.window;
  } else {
    globalThis.window = { Capacitor: capacitor };
  }
  try {
    return isNativeApp();
  } finally {
    if (saved === undefined) delete globalThis.window;
    else globalThis.window = saved;
  }
}

/* ---------------- NAT-1 正反成对 ---------------- */

/*
 * 🔴 这两条是本文件的**承重项**：只有成对出现，才能证明 isNativeApp()
 *   真的读了 Capacitor，而不是碰巧恒返回某个值。
 */
test('NAT-1 🔴 注入 Capacitor 且 isNativePlatform() 为 true → 判原生（正向）', () => {
  assert.equal(
    probe({ isNativePlatform: () => true }),
    true,
    'APK 壳内必须判成原生 —— 这是修__NOTESYNC_NATIVE__ 恒 undefined 的全部意义',
  );
});

test('NAT-1 🔴 反向：无 Capacitor（真网页）→ 判非原生', () => {
  assert.equal(
    probe(undefined),
    false,
    '真网页必须判成非原生，否则网页端会走进 APK 分支（不注册 SW / 走原生复制）',
  );
});

test('NAT-1 🔴 反向：Capacitor 存在但 isNativePlatform() 为 false（网页端同款桥）→ 判非原生', () => {
  assert.equal(
    probe({ isNativePlatform: () => false }),
    false,
    '只看 window.Capacitor 存在就判原生是错的 —— 网页端若注了同名全局会整体误判',
  );
});

/* ---------------- NAT-2 畸形输入不许崩 ---------------- */

test('NAT-2 🔴 Capacitor 在但 isNativePlatform 不是函数 → 判非原生，不抛', () => {
  // 真实来源：Android 侧桥注入失败/半注入时 Plugins 已挂上但方法还没到位
  assert.equal(probe({}), false, '缺 isNativePlatform 应降级为非原生');
  assert.equal(probe({ isNativePlatform: 'yes' }), false, '非函数应降级为非原生而不是被当成真');
});

test('NAT-2 🔴 isNativePlatform() 自己抛异常 → 判非原生，不把异常漏给调用方', () => {
  // 🔴 为什么这条是承重项：四处调用点全在**启动路径**上
  //   （registerSW / 挂编辑器 / 顶栏渲染）。判据函数抛异常 = 整页白屏。
  assert.equal(
    probe({
      isNativePlatform: () => {
        throw new Error('bridge not ready');
      },
    }),
    false,
    '原生判据抛异常会让整页白屏（调用点在启动路径上），必须降级为非原生',
  );
});

/* ---------------- NAT-3 不得依赖那个从未被赋值的标志 ---------------- */

/*
 * 🔴 这条是**回归守卫**：防止有人把 `__NOTESYNC_NATIVE__` 又请回来。
 *   那�� flag 的问题不是"写法不对"，是**没有任何一行给它赋值** ——
 *   读它永远读到 undefined，而类型声明（main.ts 的 `__NOTESYNC_NATIVE__?: boolean`）
 *   让它看起来像个正常开关。类型系统在��里帮了倒忙。
 */
test('NAT-3 🔴🔴 生产代码不得再读 window.__NOTESYNC_NATIVE__（该标志从无赋值）', () => {
  const files = [
    'src/main.ts',
    'src/ui/shell.ts',
    'src/platform/native-detect.ts',
    'src/export/render.ts',
    'src/export/index.ts',
    'src/image/native-img-save.ts',
    'src/reminder/native-rem.ts',
    'src/update/ota-native.ts',
    'src/diag/collect.ts',
  ];
  const offenders = [];
  for (const rel of files) {
    const abs = new URL('../' + rel, import.meta.url);
    let txt = '';
    try {
      txt = readFileSync(abs, 'utf8');
    } catch {
      continue; // 文件不存在不构成本条要抓的事
    }
    // 🔴 判"代码不存在"必须**先去注释**：注释里写着这个标志会让 doesNotMatch 命中警告本身。
    const code = stripComments(txt);
    if (code.includes('__NOTESYNC_NATIVE__')) offenders.push(rel);
  }
  assert.deepEqual(
    offenders,
    [],
    `这些文件仍在读 __NOTESYNC_NATIVE__（恒 undefined）：${offenders.join(', ')}。改用 platform/native-detect.ts 的 isNativeApp()`,
  );
});

/** 去掉行注释与块注释，避免「注释里提到标志」被当成「代码里在用」。 */
function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

/* ---------------- NAT-4 口径与老项目逐字一致 ---------------- */

test('NAT-4 🔴🔴 判据形态照老项目 index.html:10125-10127（isNativePlatform，不是 isNative）', () => {
  // 老项目原文：
  //   function isNativeApp() {
  //     return !!(window.Capacitor && window.Capacitor.isNativePlatform && window.Capacitor.isNativePlatform());
  //   }
  // 🔴 为什么单独钉这一条：Capacitor 还有个 `isNative()`，它看的是"运行环境是不是原生"
  //   （PWA/SSR 都可能 true）。拿它当判据 ⇒ 网页版PWA 也被判成 APK ⇒
  //   网页端开始走原生分支。这类错不会报错，只会让两个分支的行为慢慢分叉。
  const abs = new URL('../src/platform/native-detect.ts', import.meta.url);
  const code = stripComments(readFileSync(abs, 'utf8'));
  assert.ok(
    code.includes('isNativePlatform'),
    '必须用 isNativePlatform（老项目口径）',
  );
  assert.ok(
    !/\bisNative\s*\(\s*\)/.test(code),
    '不得用 Capacitor.isNative()：它判的是运行环境不是平台，网页 PWA 也会命中',
  );
});