/**
 * App 在线升级纯逻辑层单测（OTA 系列）
 *
 * 🔴 判据不许手写第二份实现：版本上限/清单常量一律从被测模块导入。
 *
 * 🔴🔴 本文件专门钉四类"不报错但静默失灵"的缺陷，每一类都真实发生过：
 *   1. 版本比较的段数口径 —— "1.0"（APK versionName）与 "1.0.0"（tag）
 *      是同一版本的两种写法，按段数判不同会让装着 1.0 的用户永远看到
 *      "有新版本 1.0.0"，点完装到的还是同版。
 *   2. 不可解析时的返回值 —— 返回 0（"一样新"）会让脏版本号设备永远收不到更新，
 *      返回 null 才是安全侧。
 *   3. 缺 expectedBytes —— 原生侧退回"文件 >1MB 即复用"，截断 APK 会被当已下完，
 *      反复复用后安装器报 packageInfo is null。
 *   4. 老壳无桥的降级 —— 上一版 APK 装的用户点「立即更新」必须退到下载页，不装死。
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { compareVersions, isNewer, pickApk, parseLatest, extractNotes } from '../src/update/ota.ts';
import { checkUpdate, runUpdate } from '../src/update/ota-native.ts';

/** 🔴 类型只走 JSDoc（.mjs 里写不了 TS 内联类型，项目老坑） */

/** 造一个 /api/latest 响应。tag 形如 v1.2.0。 */
function latestJson(opts) {
  const o = { tag_name: opts.tag, body: opts.body || '', assets: [] };
  if (opts.apk !== false) {
    o.assets.push({
      name: opts.apkName || 'NoteSyncBJ-' + opts.tag + '.apk',
      browser_download_url: 'https://example.test/' + opts.tag + '.apk',
      size: opts.size === undefined ? 26 * 1048576 : opts.size,
    });
  }
  if (opts.summary) o.summary = opts.summary;
  return JSON.stringify(o);
}

/* ══════════ 版本比较 ══════════ */

test('OTA-01 段数不同的同一版本必须判相等（1.0 与 1.0.0）', () => {
  // 🔴 这条是血泪：APK 的 versionName 是 "1.0"，tag 是 "v1.0.0"。
  //   早先按段数判不同，用户点"立即更新"装到同版，白折腾一次。
  assert.equal(compareVersions('1.0', '1.0.0'), 0, '1.0 与 1.0.0 是同一版本');
  assert.equal(compareVersions('1.0.0', '1.0'), 0);
  assert.equal(compareVersions('1.0', '1.0'), 0);
});

test('OTA-02 缺段按 0 补齐，不是判"无法比较"', () => {
  assert.equal(compareVersions('1.1', '1.0.9'), 1, '1.1 > 1.0.9（第二段 1 > 0）');
  assert.equal(compareVersions('1.0.1', '1.0'), 1, '1.0.1 > 1.0（第三段 1 > 0）');
});

test('OTA-03 带 v 前缀与不带等价', () => {
  assert.equal(compareVersions('v1.2.0', '1.2.0'), 0);
  assert.equal(compareVersions('V1.2.1', 'v1.2.0'), 1);
});

test('OTA-04 不可解析必须返回 null 而非 0（0 = "一样新" = 永远收不到更新）', () => {
  for (const bad of ['', '  ', 'abc', '1.2.3-beta', '1.2.3.4', '1..2', 'v', '99999999']) {
    assert.equal(compareVersions(bad, '1.0.0'), null, `'${bad}' 应判不可解析`);
    assert.equal(compareVersions('1.0.0', bad), null, `右侧 '${bad}' 应判不可解析`);
  }
  // 段长上限 6：超长数字会撑爆精度变成 0（0 < 任何版本），
  // 那会让一个"未来的大版本"被判成最旧，升级永远推不出去。
  assert.equal(compareVersions('1234567.0.0', '1.0.0'), null);
});

test('OTA-05 isNewer：只有严格更新才算，可解析不了就 false', () => {
  assert.equal(isNewer('1.0.1', '1.0.0'), true);
  assert.equal(isNewer('1.0.0', '1.0.0'), false);
  assert.equal(isNewer('1.0.0', '1.0.1'), false);
  assert.equal(isNewer('bad', '1.0.0'), false, '远端不可解析 → 不提示升级（安全侧）');
  assert.equal(isNewer('1.0.1', 'bad'), false, '本机不可解析 → 不提示升级（安全侧）');
});

/* ══════════ pickApk ══════════ */

test('OTA-06 pickApk 取第一个 .apk，大小写不敏感', () => {
  const a = pickApk([
    { name: 'notes.txt', browser_download_url: 'https://e.test/a.txt' },
    { name: 'App-v1.APK', browser_download_url: 'https://e.test/a.apk', size: 1234 },
  ]);
  assert.ok(a);
  assert.equal(a.url, 'https://e.test/a.apk');
  assert.equal(a.size, 1234);
});

test('OTA-07 pickApk：没有 apk / 结构不对 / url 缺失都返回 null', () => {
  assert.equal(pickApk([]), null);
  assert.equal(pickApk(null), null);
  assert.equal(pickApk('not-array'), null);
  assert.equal(pickApk([{ name: 'a.zip', browser_download_url: 'https://e.test/a.zip' }]), null);
  // 🔴 名字是 apk 但没有下载地址：返回它会让点"立即更新"去下载 undefined
  assert.equal(pickApk([{ name: 'a.apk' }]), null);
});

test('OTA-08 size 为 0 或负数时归一为 0（弹窗据此不显示大小）', () => {
  const a = pickApk([{ name: 'a.apk', browser_download_url: 'https://e.test/a', size: 0 }]);
  assert.equal(a.size, 0);
  const b = pickApk([{ name: 'a.apk', browser_download_url: 'https://e.test/a', size: -5 }]);
  assert.equal(b.size, 0);
});

/* ══════════ 摘要提取 ══════════ */

test('OTA-09 优先用 summary，退回 body 头部', () => {
  const s = extractNotes({ summary: ['第一条', '第二条'] });
  assert.deepEqual(s, ['第一条', '第二条']);
  const b = extractNotes({ body: '## 更新内容\n- 甲\n- 乙\n- 丙\n- 丁\n- 戊' });
  assert.equal(b.length, 4, '最多 4 条（第 5 条起在手机上要滚动才看得到）');
  assert.equal(b[0], '更新内容', 'Markdown 标题符号应被剥掉');
  assert.equal(b[1], '甲');
});

test('OTA-10 滤掉 GitHub 自动生成的那些行', () => {
  const notes = extractNotes({
    body: [
      '## 更新内容',
      '- 修复了提醒不响',
      '**完整变更日志**: https://github.com/x/y/compare/v1.0.0...v1.1.0',
      'Full Changelog: https://github.com/x/y/compare/v1.0.0...v1.1.0',
      'https://example.test/some/link',
      '- [某条带链接的](https://example.test)',
    ].join('\n'),
  });
  // 🔴 「更新内容」是 Release 自己在正文顶部写的小标题，留着是对的；
  //   要滤的是 compare 链接 / 裸 URL / Markdown 链接 / 变更日志措辞这四类。
  //   初版期望只留一条，其实漏滤了 "完整变更日志**: .../compare/..." ——
  //   剥掉前导 ** 之后它不再以 ** 开头，按前缀枚举措辞就漏了。
  //   现规则改为「出现 compare/ 就整条丢」，措辞会变、链接形态不会。
  assert.deepEqual(notes, ['更新内容', '修复了提醒不响']);
  assert.ok(!notes.some((n) => /compare\//.test(n)), 'compare 链接必须整条滤掉');
});

test('OTA-11 全被滤光时给兜底句，不给空白弹窗', () => {
  assert.deepEqual(extractNotes({ body: 'Full Changelog: https://x' }), ['详见发布页']);
  assert.deepEqual(extractNotes({}), ['详见发布页']);
});

/* ══════════ parseLatest ══════════ */

test('OTA-12 正常路径：解析出版本与下载地址', () => {
  const r = parseLatest(latestJson({ tag: 'v1.1.0' }), '1.0.0');
  assert.ok(r.ok);
  assert.equal(r.rel.version, '1.1.0');
  assert.equal(r.rel.tag, 'v1.1.0');
  assert.ok(r.rel.hasUpdate);
  assert.equal(r.rel.size, 26 * 1048576);
});

test('OTA-13 四种失败必须可区分（混淆会导致"服务挂了"被显示成"已是最新"）', () => {
  assert.equal(parseLatest('{不是json', '1.0.0').reason, 'bad-json');
  assert.equal(parseLatest(latestJson({ tag: '' }), '1.0.0').reason, 'no-tag');
  assert.equal(parseLatest(latestJson({ tag: 'v1.1.0', apk: false }), '1.0.0').reason, 'no-apk');
  assert.equal(parseLatest(latestJson({ tag: 'v1.0.0' }), '1.0.0').reason, 'not-newer');
});

test('OTA-14 本机版本更新时不提示（不能倒退提示降级）', () => {
  assert.equal(parseLatest(latestJson({ tag: 'v1.0.0' }), '2.0.0').reason, 'not-newer');
  // 🔴 本机版本不可解析时也不提示：宁可漏提示也不给装不上的包
  assert.equal(parseLatest(latestJson({ tag: 'v1.1.0' }), 'bad').reason, 'not-newer');
});

/* ══════════ checkUpdate（注入假依赖） ══════════ */

function fakeDeps(over) {
  return Object.assign(
    {
      isNativeApp: true,
      getUpdateBridge: () => null,
      getNativeVersion: async () => '1.0.0',
      fetchJson: async () => ({ ok: true, status: 200, text: latestJson({ tag: 'v1.1.0' }) }),
      openExternal: () => {},
    },
    over,
  );
}

test('OTA-15 网页版直接短路：不给按钮，也不发请求', async () => {
  let fetched = 0;
  const r = await checkUpdate(
    fakeDeps({
      isNativeApp: false,
      fetchJson: async () => { fetched++; return { ok: true, status: 200, text: '' }; },
    }),
    '1.0.0',
  );
  assert.equal(r.kind, 'no-app');
  assert.equal(fetched, 0, '网页版不该打 /api/latest');
});

test('OTA-16 网络异常与 404 是两回事（文案不同，用户要能分辨）', async () => {
  const netErr = await checkUpdate(
    fakeDeps({ fetchJson: async () => { throw new Error('offline'); } }),
    '1.0.0',
  );
  assert.deepEqual(netErr, { kind: 'network', status: 0 });

  const notFound = await checkUpdate(
    fakeDeps({ fetchJson: async () => ({ ok: false, status: 404, text: '' }) }),
    '1.0.0',
  );
  assert.deepEqual(notFound, { kind: 'network', status: 404 });
});

test('OTA-17 有新版时以**原生版本**比较，不是网页版', async () => {
  // 原生 1.0.0 / 网页 9.9.9，服务器发 1.1.0 → 仍应提示升级
  const r = await checkUpdate(
    fakeDeps({
      getNativeVersion: async () => '1.0.0',
      fetchJson: async () => ({ ok: true, status: 200, text: latestJson({ tag: 'v1.1.0' }) }),
    }),
    '9.9.9',
  );
  assert.equal(r.kind, 'update');
  assert.equal(r.native, '1.0.0', '判据应是原生版本');
});

test('OTA-18 原生版本取不到时退回网页版 APP_VERSION', async () => {
  const r = await checkUpdate(
    fakeDeps({
      getNativeVersion: async () => '',
      fetchJson: async () => ({ ok: true, status: 200, text: latestJson({ tag: 'v1.1.0' }) }),
    }),
    '1.0.0',
  );
  assert.equal(r.kind, 'update');
});

test('OTA-19 "已是最新"与"发了版但没挂 APK"必须分开报', async () => {
  const latest = await checkUpdate(
    fakeDeps({ fetchJson: async () => ({ ok: true, status: 200, text: latestJson({ tag: 'v1.0.0' }) }) }),
    '1.0.0',
  );
  assert.equal(latest.kind, 'latest');

  const noApk = await checkUpdate(
    fakeDeps({ fetchJson: async () => ({ ok: true, status: 200, text: latestJson({ tag: 'v1.1.0', apk: false }) }) }),
    '1.0.0',
  );
  // 🔴 这两种混淆的后果：用户永远等不到包，却看到"已是最新版本"
  assert.equal(noApk.kind, 'no-apk');
});

/* ══════════ runUpdate ══════════ */

const REL = { tag: 'v1.1.0', version: '1.1.0', notes: ['x'], url: 'https://e.test/a.apk', size: 26 * 1048576, hasUpdate: true };

/** 造一个可控的假桥：状态按脚本逐次返回 */
function fakeBridge(script) {
  const calls = { download: [], state: [], install: [] };
  const br = {
    downloadApk: async (o) => { calls.download.push(o); return script.download; },
    downloadState: async (o) => { calls.state.push(o); const s = script.states.shift(); return s; },
    install: async (o) => { calls.install.push(o); return script.install; },
  };
  return { br, calls };
}

test('OTA-20 downloadApk 必须收到 expectedBytes（少了它原生退回粗判，截断 APK 会被反复复用）', async () => {
  const { br, calls } = fakeBridge({ download: { ok: false, error: 'stop-here' } });
  await runUpdate(fakeDeps({ getUpdateBridge: () => br }), REL, () => {});
  assert.equal(calls.download.length, 1);
  assert.equal(calls.download[0].expectedBytes, REL.size, '精确字节必须传下去');
  assert.equal(calls.download[0].tag, '1.1.0');
  assert.equal(calls.download[0].url, REL.url);
});

test('OTA-21 老壳无桥：退到打开下载页，不装死', async () => {
  let opened = '';
  const msg = await runUpdate(
    fakeDeps({ getUpdateBridge: () => null, openExternal: (u) => { opened = u; } }),
    REL,
    () => {},
  );
  assert.equal(opened, REL.url, '应打开下载页');
  assert.match(msg, /不支持一键升级|打开下载页/);
});

test('OTA-22 非 https 地址被原生拒下时，UI 要说人话', async () => {
  const { br } = fakeBridge({ download: { ok: false, error: 'not-https' } });
  const msg = await runUpdate(fakeDeps({ getUpdateBridge: () => br }), REL, () => {});
  assert.match(msg, /https/);
});

test('OTA-23 非 Wi-Fi 静默跳过要说清（否则用户以为坏了）', async () => {
  const { br } = fakeBridge({ download: { ok: false, error: 'not-wifi' } });
  const msg = await runUpdate(fakeDeps({ getUpdateBridge: () => br }), REL, () => {});
  assert.match(msg, /Wi-Fi/);
});

test('OTA-24 轮询到 done 后拉安装器', async () => {
  const { br, calls } = fakeBridge({
    download: { ok: true, id: 7, path: '/tmp/a.apk' },
    states: [{ ok: true, status: 'running', downloaded: 100, total: 200 },
             { ok: true, status: 'done', path: '/tmp/a.apk' }],
    install: { ok: true },
  });
  const msg = await runUpdate(fakeDeps({ getUpdateBridge: () => br }), REL, () => {});
  assert.match(msg, /安装程序/);
  assert.deepEqual(calls.install, [{ path: '/tmp/a.apk' }]);
});

test('OTA-25 进度回调：原生报 total=0 时用 /api/latest 的 size 兜底', async () => {
  const seen = [];
  const { br } = fakeBridge({
    download: { ok: true, id: 7, path: '/p' },
    states: [{ ok: true, status: 'running', downloaded: 50, total: 0 },
             { ok: true, status: 'done', path: '/p' }],
    install: { ok: true },
  });
  await runUpdate(fakeDeps({ getUpdateBridge: () => br }), REL, (d, t) => seen.push([d, t]));
  assert.equal(seen.length, 1);
  // 🔴 DownloadManager 的 COLUMN_TOTAL_SIZE_BYTES 只在响应头带 Content-Length 时有值，
  //   拿不到就是 0。此时用 /api/latest 里的 asset.size 兜底，
  //   目的是让进度条能显示百分比（“正在下载 37%” 比一条空进度有用得多）。
  assert.equal(seen[0][0], 50, '已下载字节原样上报');
  assert.equal(seen[0][1], REL.size, 'total=0 时退回用 Release 里的包大小');
});

test('OTA-25b total 完全未知（原生 0 + Release 也没 size）时上报 0，UI 不显示百分比', async () => {
  const noSizeRel = { ...REL, size: 0 };
  const seen = [];
  const { br } = fakeBridge({
    download: { ok: true, id: 7, path: '/p' },
    states: [{ ok: true, status: 'running', downloaded: 50, total: 0 },
             { ok: true, status: 'done', path: '/p' }],
    install: { ok: true },
  });
  await runUpdate(fakeDeps({ getUpdateBridge: () => br }), noSizeRel, (d, t) => seen.push([d, t]));
  assert.deepEqual(seen[0], [50, 0]);
});

test('OTA-26 复用路径（reused/attached）无 id 时直接装，不进轮询', async () => {
  const { br, calls } = fakeBridge({
    download: { ok: true, reused: true, path: '/cached/a.apk' },
    install: { ok: true },
  });
  const msg = await runUpdate(fakeDeps({ getUpdateBridge: () => br }), REL, () => {});
  assert.match(msg, /安装程序/);
  assert.equal(calls.state.length, 0, '复用路径不该空跑轮询');
});

test('OTA-27 downloadState 报 gone 但有路径：照样能装（记录被清理不等于文件没了）', async () => {
  const { br, calls } = fakeBridge({
    download: { ok: true, id: 7, path: '/p/a.apk' },
    states: [{ ok: true, status: 'gone', path: '/p/a.apk' }],
    install: { ok: true },
  });
  const msg = await runUpdate(fakeDeps({ getUpdateBridge: () => br }), REL, () => {});
  assert.match(msg, /安装程序/);
  assert.equal(calls.install.length, 1);
});

test('OTA-28 downloadState 报 gone 且无路径：只能说失败', async () => {
  const { br } = fakeBridge({
    download: { ok: true, id: 7, path: '/p/a.apk' },
    states: [{ ok: true, status: 'gone' }],
  });
  const msg = await runUpdate(fakeDeps({ getUpdateBridge: () => br }), REL, () => {});
  assert.match(msg, /丢失|重试/);
});

test('OTA-29 未授权安装：跳设置页，且提示用户需再点一次（授权结果无法回传）', async () => {
  let asked = 0;
  const { br } = fakeBridge({
    download: { ok: true, reused: true, path: '/p/a.apk' },
    install: { ok: false, needPermission: true },
  });
  const br2 = Object.assign({}, br, { requestInstallPermission: async () => { asked++; } });
  const msg = await runUpdate(fakeDeps({ getUpdateBridge: () => br2 }), REL, () => {});
  assert.equal(asked, 1, '必须跳一次系统设置页');
  assert.match(msg, /安装未知应用/);
});

test('OTA-30 桥抛异常不许崩页面（升级失败绝不该白屏）', async () => {
  const br = {
    downloadApk: async () => { throw new Error('boom'); },
    downloadState: async () => { throw new Error('boom'); },
    install: async () => { throw new Error('boom'); },
  };
  const m1 = await runUpdate(fakeDeps({ getUpdateBridge: () => br }), REL, () => {});
  assert.match(m1, /下载失败/);

  const { br: br2 } = fakeBridge({
    download: { ok: true, id: 1, path: '/p' },
    states: [{ ok: true, status: 'running', downloaded: 1, total: 2 }],
    install: { ok: true },
  });
  const br3 = Object.assign({}, br2, {
    downloadState: async () => { throw new Error('boom2'); },
  });
  const m2 = await runUpdate(fakeDeps({ getUpdateBridge: () => br3 }), REL, () => {});
  assert.match(m2, /状态失败|失败/);
});
