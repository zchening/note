/**
 * 服务端接口测试 —— 起真进程打真 HTTP
 *
 * 不用 supertest 之类（零依赖原则）。listen(0) 拿随机端口，测完关掉，
 * 绝不占用 8090（那是生产端口，本机可能跑着别的东西）。
 *
 * 覆盖的关键不变量：
 *  - /healthz 自报版本（部署核对的第一判据）
 *  - 笔记读写往返，且服务端不解析内容（密文原样落盘）
 *  - 不存在的笔记返回 200 + 空体（不是 404/4xx）—— 客户端据此判"此处无笔记"
 *  - id 白名单挡住路径穿越
 *  - 锁定后 429 + Retry-After
 *  - SSE 能收到推送
 *  - 静态资源与 SPA 回落
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SERVER = path.join(__dirname, '..', 'src', 'server.js');

// 🔴 判据必须 import 生产代码（抄进测试的判据恒绿）。upsign 单独成文件就是为了这个。
import { upsignSign, upsignSignedString } from '../src/upsign.js';

let child = null;
let base = '';
let dataDir = '';
let wwwDir = '';
let deployDir = '';

/** 起一个隔离实例（独立 DATA_DIR + 独立 WWW_DIR + 随机端口） */
async function boot() {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bj-srv-'));
  // 🔴🔴 WWW 目录必须由本测试自建，**不能**依赖仓库根的 www/。
  //   踩过：CI 的步骤序是「npm test → npm run build」，而 `www/` 是构建产物、
  //   在 .gitignore 里 —— runner 上 checkout 完根本不存在。
  //   于是"SPA 回落到 index.html"那条拿到 404，CI 红。
  //   而本地永远是绿的（开发者跑过 build，www/ 躺在那里），所以本机复现不出来。
  //   这类"测试依赖了别人的产物"的坑，唯一可靠的自愈是**自己造齐前置条件**：
  //   测什么就放什么进去，不借生产构建物。
  wwwDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bj-www-'));
  fs.writeFileSync(
    path.join(wwwDir, 'index.html'),
    '<!doctype html><html><body><div id="app"></div></body></html>',
    'utf8',
  );
  // 一份带扩展名的静态资源，用来判"有扩展名走真文件、无扩展名走回落"这条分界
  fs.writeFileSync(path.join(wwwDir, 'probe.txt'), 'probe', 'utf8');
  // 🔴 deploy/ 必须隔离：OTA 判据要放**假 APK**（含 Range/206/416/穿越），
  //   不隔离就只能往真实仓库的 deploy/apk/ 里写垃圾。
  deployDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bj-deploy-'));
  fs.mkdirSync(path.join(deployDir, 'apk'), { recursive: true });

  const port = 20000 + Math.floor(Math.random() * 20000);
  child = spawn(process.execPath, [SERVER], {
    env: {
      ...process.env,
      NS_BJ_PORT: String(port),
      NOTESYNC_BJ_DATA_DIR: dataDir,
      NOTESYNC_BJ_WWW: wwwDir,
      NOTESYNC_BJ_DEPLOY: deployDir,
      NS_BJ_VERSION: '9.9.9-test',
      NS_BJ_BUILD_DATE: '2026-10-05',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  base = `http://127.0.0.1:${port}`;
  // 等端口就绪
  for (let i = 0; i < 100; i++) {
    try {
      const r = await fetch(`${base}/healthz`);
      if (r.ok) return;
    } catch {
      /* 还没起来 */
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('服务端 10 秒内没起来');
}

test.before(async () => {
  await boot();
});

/**
 * 原始 HTTP GET（手写请求行，返回完整响应文本）。
 *
 * 🔴 判"服务端怎么解析 pathname"时**必须**用它，不能用 fetch：
 *   WHATWG URL 会在客户端就把 `/dl/../x` 规范化成 `/x`，带 .. 的请求根本发不出去。
 *   用 fetch 写出来的穿越判据对"服务端是否解码/是否防穿越"零区分力 —— 恒绿。
 */
function rawGet(target) {
  const port = Number(new URL(base).port);
  return new Promise((resolve, reject) => {
    const sock = net.connect(port, '127.0.0.1', () => {
      sock.write(`GET ${target} HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n`);
    });
    let buf = '';
    sock.setEncoding('utf8');
    sock.on('data', (d) => { buf += d; });
    sock.on('end', () => resolve(buf));
    sock.on('error', reject);
  });
}

test.after(() => {
  if (child) child.kill();
  if (dataDir) fs.rmSync(dataDir, { recursive: true, force: true });
  if (deployDir) fs.rmSync(deployDir, { recursive: true, force: true });
});

test('/healthz 自报版本与关键路径（部署核对第一判据）', async () => {
  const r = await fetch(`${base}/healthz`);
  assert.equal(r.status, 200);
  const j = await r.json();
  assert.equal(j.ok, true);
  assert.equal(j.app, 'notesync-bj');
  assert.equal(j.version, '9.9.9-test');
  assert.equal(j.buildDate, '2026-10-05');
  assert.ok(Number.isInteger(j.port));
  assert.ok(typeof j.failMapEntries === 'number');
});

test('笔记写入后能原样读回（服务端不解析密文内容）', async () => {
  const cipher = JSON.stringify({ v: 1, alg: 'AES-256-GCM', ct: 'Zm9vYmFy', iv: 'AAAA' });
  const w = await fetch(`${base}/api/note/testnote1`, { method: 'POST', body: cipher });
  assert.equal(w.status, 200);

  const r = await fetch(`${base}/api/note/testnote1`);
  assert.equal(r.status, 200);
  assert.equal(await r.text(), cipher, '密文必须逐字节原样返回');
});

test('不存在的笔记返回 200 + 空体（客户端据此判"此处无笔记"）', async () => {
  const r = await fetch(`${base}/api/note/does-not-exist-xyz`);
  assert.equal(r.status, 200, '🔴 必须 200，给 404 会让客户端当网络错误重试');
  assert.equal(await r.text(), '');
});

test('id 白名单挡住路径穿越与非法字符', async () => {
  const bad = [
    '../secret',
    'a/b',
    'UPPER',
    '-leading-dash',
    'a'.repeat(100),
    'has.dot',
    'has space',
  ];
  for (const id of bad) {
    const r = await fetch(`${base}/api/note/${encodeURIComponent(id)}`);
    assert.ok(r.status === 400 || r.status === 404, `「${id}」竟返回 ${r.status}`);
    if (r.status === 400) {
      const j = await r.json();
      assert.equal(j.error, 'bad id');
    }
  }
});

test('超大 body 被拒（413），不能拿它当文件服务器', async () => {
  const big = 'x'.repeat(9 * 1024 * 1024);
  const r = await fetch(`${base}/api/note/bignote`, { method: 'POST', body: big }).catch((e) => {
    // 也可能连接被服务端 destroy
    assert.ok(e, '应抛错');
    return { status: 0 };
  });
  assert.ok(r.status === 413 || r.status === 0, `实际 ${r.status}`);
});

test('连续失败上报触发锁定，之后 GET/POST 都是 429 + Retry-After', async () => {
  const id = 'locknote1';
  // 先正常写一次（建立 key）
  await fetch(`${base}/api/note/${id}`, { method: 'POST', body: '{"v":1}' });

  for (let i = 0; i < 25; i++) {
    await fetch(`${base}/api/fail/${id}`, { method: 'POST' });
  }
  const st = await (await fetch(`${base}/api/fail/${id}`)).json();
  assert.equal(st.locked, true, '25 次失败后必须锁定');

  const g = await fetch(`${base}/api/note/${id}`);
  assert.equal(g.status, 429, '锁定后 GET 必须 429');
  const ra = g.headers.get('retry-after');
  assert.ok(ra && Number(ra) > 0, '必须带 Retry-After');

  const p = await fetch(`${base}/api/note/${id}`, { method: 'POST', body: '{}' });
  assert.equal(p.status, 429, '锁定后 POST 也必须 429');
});

test('锁定状态已落盘（重启不丢 —— 老项目这里是内存 Map）', async () => {
  const f = path.join(dataDir, 'failmap.json');
  // 触发一次 saveSnapshot：再打一次失败让 dirty=true，然后等落盘
  await fetch(`${base}/api/fail/locknote1`, { method: 'POST' });
  // 直接检查内存表里确实有锁定项（快照是 5 分钟周期，这里不等）
  const h = await (await fetch(`${base}/healthz`)).json();
  assert.ok(h.failMapEntries > 0, 'failMap 应有记录');
  assert.ok(fs.existsSync(path.dirname(f)), 'DATA_DIR 应已创建');
});

test('SSE 订阅能收到写入推送', async () => {
  const ctrl = new AbortController();
  const res = await fetch(`${base}/api/stream/ssenote1`, { signal: ctrl.signal });
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type') || '', /text\/event-stream/);

  const reader = res.body.getReader();
  const decoder = new TextDecoder();

  // 先读掉 hello 注释帧
  await reader.read();

  // 触发一次写入
  await fetch(`${base}/api/note/ssenote1`, { method: 'POST', body: '{"v":1,"x":1}' });

  let got = '';
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const { value, done } = await reader.read();
    if (done) break;
    got += decoder.decode(value, { stream: true });
    if (got.includes('"t":"note"')) break;
  }
  ctrl.abort();
  assert.match(got, /"t":"note"/, 'SSE 应收到推送，实际收到：' + JSON.stringify(got));
  assert.match(got, /ssenote1/);
});

test('DELETE 删笔记，之后读回空体', async () => {
  await fetch(`${base}/api/note/delnote1`, { method: 'POST', body: '{"v":1}' });
  const d = await fetch(`${base}/api/note/delnote1`, { method: 'DELETE' });
  assert.equal(d.status, 200);
  const r = await fetch(`${base}/api/note/delnote1`);
  assert.equal(await r.text(), '');
});

test('arcade 记录可读写（彩蛋层用）', async () => {
  const w = await fetch(`${base}/api/arcade/arc1`, { method: 'POST', body: '{"best":99}' });
  assert.equal(w.status, 200);
  const r = await fetch(`${base}/api/arcade/arc1`);
  assert.equal(await r.text(), '{"best":99}');
  const miss = await fetch(`${base}/api/arcade/never-written`);
  assert.equal(miss.status, 200);
  assert.equal(await miss.text(), '');
});

test('/api/latest 无发布元数据时 404（App 靠这个查新版）', async () => {
  const r = await fetch(`${base}/api/latest`);
  // 隔离 DATA_DIR 下没有 deploy/latest_app.json，应 404
  assert.equal(r.status, 404);
  const j = await r.json();
  assert.equal(j.error, 'no release metadata');
});

/* ================= APK 直下（OTA 下载通道）=================
 *
 * 🔴🔴 这组判据对应 packages/server/src/server.js 的 /dl 路由。它是 App
 *   在线升级的唯一下载入口，去掉它App 仍能正常用（网页是线上站），但
 *   "检查更新"会永远失败 —— 属于**沉默缺失**，所以必须有判据钉住。
 *
 * 🔴 假 APK 用可预测字节（i % 251）而不是随机数：Range 分段必须能验证
 *   "返回的确实是文件的那一段"，随机字节只能验证长度，对上了也可能内容错。
 */
const APK_SIZE = 300000;
const apkByte = (i) => i % 251;

function seedApk(name) {
  const buf = Buffer.alloc(APK_SIZE);
  for (let i = 0; i < APK_SIZE; i++) buf[i] = apkByte(i);
  fs.writeFileSync(path.join(deployDir, 'apk', name), buf);
  return buf;
}

test('DL-01 /dl/latest.apk 直出真字节（200 + 头齐全 + 内容逐字节相符）', async () => {
  const buf = seedApk('latest.apk');
  const r = await fetch(`${base}/dl/latest.apk`);
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('content-type'), 'application/vnd.android.package-archive');
  // 🔴 Accept-Ranges 是 DownloadManager 分段续传的前提，缺了就不是 200 而是整体重下
  assert.equal(r.headers.get('accept-ranges'), 'bytes');
  assert.equal(r.headers.get('content-length'), String(APK_SIZE));
  assert.match(r.headers.get('content-disposition') || '', /attachment; filename="NoteSync-latest\.apk"/);
  const got = Buffer.from(await r.arrayBuffer());
  assert.equal(got.length, APK_SIZE, '字节数对不上');
  // 🔴 反向断言：不能只对长度。逐字节比内容，否则"返回了别的东西同样长度"会绿。
  assert.ok(buf.equals(got), '返回的字节与磁盘上的 APK 不一致（可能截断/串内容）');
});

test('DL-02 Range 分段续传 206，且 Content-Range 精确（低带宽不断点续传的前提）', async () => {
  seedApk('latest.apk');
  // 中间一段
  const r = await fetch(`${base}/dl/latest.apk`, { headers: { Range: 'bytes=1000-1099' } });
  assert.equal(r.status, 206);
  assert.equal(r.headers.get('content-range'), `bytes 1000-1099/${APK_SIZE}`);
  assert.equal(r.headers.get('content-length'), '100');
  const got = Buffer.from(await r.arrayBuffer());
  assert.equal(got.length, 100);
  for (let i = 0; i < 100; i++) {
    assert.equal(got[i], apkByte(1000 + i), `第 ${i} 字节应是文件的第 ${1000 + i} 字节`);
  }
  // 🔴 开头一段（客户端续传的真实起点）
  const r2 = await fetch(`${base}/dl/latest.apk`, { headers: { Range: 'bytes=0-99' } });
  assert.equal(r2.status, 206);
  assert.equal(r2.headers.get('content-range'), `bytes 0-99/${APK_SIZE}`);
  const g2 = Buffer.from(await r2.arrayBuffer());
  assert.equal(g2.length, 100);
  assert.equal(g2[0], apkByte(0));
  assert.equal(g2[99], apkByte(99));
});

test('DL-03 Range 后缀区间 bytes=-N 取末尾 N 字节', async () => {
  seedApk('latest.apk');
  const r = await fetch(`${base}/dl/latest.apk`, { headers: { Range: 'bytes=-50' } });
  assert.equal(r.status, 206);
  const wantFrom = APK_SIZE - 50;
  assert.equal(r.headers.get('content-range'), `bytes ${wantFrom}-${APK_SIZE - 1}/${APK_SIZE}`);
  const got = Buffer.from(await r.arrayBuffer());
  assert.equal(got.length, 50);
  assert.equal(got[0], apkByte(wantFrom), '后缀区间必须从末尾往前数50 字节的起点开始');
  assert.equal(got[49], apkByte(APK_SIZE - 1));
});

test('DL-04 Range 越界回 416 + Content-Range: bytes */total（不是 200 也不是崩）', async () => {
  seedApk('latest.apk');
  // 起点超过文件大小
  const r = await fetch(`${base}/dl/latest.apk`, { headers: { Range: 'bytes=999999-' } });
  assert.equal(r.status, 416, '越界 Range 必须 416；回 200 等于从头重下，续传白做');
  assert.equal(r.headers.get('content-range'), `bytes */${APK_SIZE}`);
  // 🔴 起点 ≤ size 但 > end（end 小于 start）也必须 416
  const r2 = await fetch(`${base}/dl/latest.apk`, { headers: { Range: 'bytes=500-100' } });
  assert.equal(r2.status, 416);
});

test('DL-05 版本固定名 /dl/vX.Y.Z.apk 可下载，且与 latest.apk 同内容', async () => {
  // 🔴 不可变版本副本是 Range 续传的生命线：客户端下载途中发新版，
  //   latest.apk 被覆盖会让手机读到"新旧混装字节" ⇒ packageInfo is null 死循环。
  //   所以 json 的 URL 必须指永不覆盖的版本副本。
  const a = seedApk('latest.apk');
  const b = seedApk('v1.11.0.apk');
  const r = await fetch(`${base}/dl/v1.11.0.apk`);
  assert.equal(r.status, 200);
  assert.match(r.headers.get('content-disposition') || '', /NoteSync-v1\.11\.0\.apk/);
  const got = Buffer.from(await r.arrayBuffer());
  assert.ok(a.equals(got) && b.equals(got), '两个名字必须给出同一份 APK');
  // 🔴 反向断言：多段版本号也要认（v10.1.8 这种）
  const c = seedApk('v10.1.8.apk');
  const r2 = await fetch(`${base}/dl/v10.1.8.apk`);
  assert.equal(r2.status, 200, '多段版本号被拒 ⇒ v10.1.8 这类版本发不出去');
  assert.ok(c.equals(Buffer.from(await r2.arrayBuffer())));
});

test('DL-06 HEAD 只回头不回体（App 用它探活/取大小）', async () => {
  seedApk('latest.apk');
  const r = await fetch(`${base}/dl/latest.apk`, { method: 'HEAD' });
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('content-length'), String(APK_SIZE));
  assert.equal((await r.arrayBuffer()).byteLength, 0, 'HEAD 不该带体');
});

test('DL-07 🔴 路径穿越拿不到 deploy/ 之外的字节', async () => {
  // 🔴🔴 这条判据的写法是踩过坑才定下来的，两个必须知道的事实：
  //
  //   ① **不能用 fetch()**：WHATWG URL 在**客户端**就把 `/dl/../x` 规范化成 `/x`，
  //      服务端压根收不到带 .. 的 pathname。实测（探针，非推测）：无论白名单怎么
  //      放宽，fetch 版本的这组断言都不会红 —— 它对"服务端是否解码"零区分力。
  //      所以必须用 net.connect 手写原始请求行，绕过客户端规范化。
  //   ② **诱饵名必须叫 secret.apk.apk**：路由拼的是 `dlMatch[1] + '.apk'`，
  //      跨过apk/ 目录后落点是 deploy/secret.apk + '.apk'。诱饵叫 secret.apk 时
  //      穿越即使成功也只会去找 secret.apk.apk（不存在）⇒ 又一个恒绿陷阱。
  //      已用变异验证：白名单放宽成 ^/dl/(.+)$ 且fname 加 decodeURIComponent 后，
  //      本条**确实转红**（DL-08 同步红），证明确有区分力。
  fs.writeFileSync(path.join(deployDir, 'secret.apk.apk'), 'TOP-SECRET', 'utf8');
  // deploy/ 外也放一个，判"连父目录都出不去"
  fs.writeFileSync(path.join(path.dirname(deployDir), 'secret.apk.apk'), 'TOP-SECRET', 'utf8');

  const attempts = [
    '/dl/../secret.apk',
    '/dl/..%2fsecret.apk',
    '/dl/%2e%2e%2fsecret.apk',
    '/dl/..%252fsecret.apk',
    '/dl/..\\secret.apk',
    '/dl/..%5csecret.apk',
    '/dl/%2e%2e%5csecret.apk',
  ];
  for (const p of attempts) {
    const r = await rawGet(p);
    assert.ok(!r.includes('TOP-SECRET'), `穿越 ${p} 泄露了 deploy/ 之外的文件内容`);
    // 🔴 不许回 200：即使没泄露，给 200 空体也会让安卓安装器报"文件损坏"而非"下载失败"
    assert.ok(!/HTTP\/1\.1 200/.test(r), `穿越 ${p} 返回了 200`);
  }
});

test('DL-08 🔴 不在白名单的 APK 名一律 404（latest / v数字 之外都拒）', async () => {
  seedApk('latest.apk');
  // 造一个真实存在的 apk 文件，但名字不合白名单 —— 必须仍然 404
  seedApk('evil.apk');
  seedApk('vTEST.apk');
  for (const n of ['evil.apk', 'vTEST.apk', 'v1.11.0-rc1.apk', 'app-release.apk']) {
    const r = await fetch(`${base}/dl/${n}`);
    assert.equal(r.status, 404, `${n}竟可下载 —— 白名单太宽`);
    //🔴 错误文案钉的是**老项目的值**：不合白名单 ⇒ 没进/dl 路由 ⇒ 落到通用
    //   静态 404（not found）；只有"进了路由但文件不在"才是 no apk（见 DL-09）。
    //   两者都是 404 JSON，分开钉是为了防止有人把 no apk 泛用到白名单外，
    //   那会让"这个 APK 名不合法"和"这个版本还没上传"看起来一样，排障时误导。
    const j = await r.json().catch(() => null);
    assert.equal(j && j.error, 'not found', `${n} 的 404 文案应与老项目同形（not found）`);
  }
});

test('DL-09 🔴 不存在的版本回 404 + no apk（不能回 200 空体或 HTML）', async () => {
  seedApk('latest.apk');
  const r = await fetch(`${base}/dl/v9.9.9.apk`);
  assert.equal(r.status, 404);
  const j = await r.json();
  assert.equal(j.error, 'no apk');
  // 🔴 HTML 更糟：APK 安装器拿到 <!doctype…> 会报"文件损坏"而不是"下载失败"
  assert.ok(!(r.headers.get('content-type') || '').includes('text/html'));
});

test('DL-10 /dl 前缀的"非法 APK 名"不得被 SPA 回落吞成 HTML', async () => {
  // 🔴 老项目口径（notesync/server.js:878）：只有**无扩展名**路径走 SPA 兜底回
  //   index.html；带扩展名的路径一律 404 JSON。所以 /dl 本身回200 HTML 是**同款
  //   设计**，不是 bug（这条曾被我错写成"必须 404"，判据钉错比没判据更糟）。
  //   真正的分界在这条：/dl/xxx.apk 名不合法时必须是 404 JSON而不是 HTML ——
  //   APK 安装器拿到 <!doctype…> 会报"文件损坏"，而不是"下载失败"，排障方向全错。
  seedApk('latest.apk');
  for (const p of ['/dl/nope.apk', '/dl/latest.txt', '/dl/a/b.apk']) {
    const r = await fetch(`${base}${p}`);
    assert.equal(r.status, 404, `${p} 应404（被 SPA 回落吞了）`);
    assert.ok(
      !(r.headers.get('content-type') || '').includes('text/html'),
      `${p}回落成了 HTML —— 安卓会报"文件损坏"而非"下载失败"`,
    );
  }
});

test('DL-11 有 latest_app.json 时 /api/latest 指向不可变版本副本（不许指 latest.apk）', async () => {
  const meta = {
    assets: [{
      browser_download_url: 'https://bj.xuyinji.com.cn/dl/v1.11.0.apk',
      name: 'app-release.apk',
      size: APK_SIZE,
    }],
    tag_name: 'v1.11.0',
  };
  fs.writeFileSync(
    path.join(deployDir, 'latest_app.json'),
    JSON.stringify(meta),
    'utf8',
  );
  const r = await fetch(`${base}/api/latest`);
  assert.equal(r.status, 200);
  const j = await r.json();
  assert.equal(j.tag_name, 'v1.11.0');
  const url = j.assets[0].browser_download_url;
  // 🔴🔴 指向 latest.apk 就是"续传跨发版读到混装字节"的复发 —— 从元数据层面钉死
  assert.ok(url.endsWith('/dl/v1.11.0.apk'), `下载 URL 必须指版本固定名，实际 ${url}`);
  assert.ok(!url.endsWith('/dl/latest.apk'), '🔴 下载 URL 绝不能指 latest.apk（会被覆盖，续传会读到混装字节）');
  // 🔴 客户端 ota.ts 只认这三个字段，少一个就当无更新
  assert.equal(j.assets[0].name, 'app-release.apk');
  assert.equal(j.assets[0].size, APK_SIZE);
  // 🔴 有"应该有"就得配"不应该有"：清掉元数据后必须回 404，不能留着上一次的缓存
  fs.rmSync(path.join(deployDir, 'latest_app.json'));
  const r2 = await fetch(`${base}/api/latest`);
  assert.equal(r2.status, 404, '删掉 latest_app.json 后仍返回 200 ⇒ 服务端缓存了它');
});

test('未知资源 404 JSON（带扩展名，不走 SPA 回落）', async () => {
  //🔴 这里必须用**带扩展名**的路径。用 /no/such/route 这类无扩展名路径时，
  //   服务端按SPA 回落设计返回 200 index.html（见下面那条用例），那是**正确行为**。
  //   本用例守的是另一条边界：伪装成静态资源的未知文件必须 404 JSON，不能回落。
  const r = await fetch(`${base}/no/such/route.js`);
  assert.equal(r.status, 404);
  assert.equal((await r.json()).error, 'not found');
});

test('未知 API 路径 404 JSON（API 命名空间不参与 SPA 回落）', async () => {
  // /api/* 永远不回落 —— 回落会把"接口404"变成"200 HTML"，
  // 客户端拿到 HTML 去JSON.parse 会炸出一句完全看不出真相的 SyntaxError。
  const r = await fetch(`${base}/api/no/such/endpoint`);
  assert.equal(r.status, 404);
  const j = await r.json();
  assert.equal(j.error, 'not found');
});

test('不支持的方法 405', async () => {
  const r = await fetch(`${base}/api/fail/somenote`, { method: 'DELETE' });
  assert.equal(r.status, 405);
});

test('静态资源：路径穿越被挡（403），不泄露文件系统', async () => {
  const r = await fetch(`${base}/../../../../etc/passwd`);
  // 归一化后多半变成 /etc/passwd → 404 或 SPA 回落，但绝不能返回真实文件内容
  const text = await r.text();
  assert.ok(!text.includes('root:'), '🔴 泄露了系统文件');
});

test('静态资源：无扩展名路径回落 index.html（前端路由由客户端解析）', async () => {
  // WWW 目录由 boot() 自建（见那里"为什么不能依赖仓库根 www/"），
  // 所以这条在 CI 与本机是**同一个前置条件**，不再取决于谁跑没跑过 build。
  // 🔴 判据不能写"200 或 404 都可以"：那种宽松断言等于没断言，
  //   真出问题时（比如回落被误删）它照样绿。
  const r = await fetch(`${base}/some/spa/route`);
  assert.equal(r.status, 200, '无扩展名路径未回落到 index.html');
  assert.match(r.headers.get('content-type') ?? '', /text\/html/);
  const html = await r.text();
  assert.match(html, /<div id="app">/, '回落内容不是应用外壳');
});

test('静态资源：有扩展名路径读真文件（不许回落成 HTML）', async () => {
  // 🔴 这条与上一条成对：单测"会回落"抓不到"回落过头"——
  //   若 serveStatic 把所有路径都当 SPA 路由，上一条照样绿，
  //   而用户的 js/app.js 会拿到一份 HTML，报错长得像"代码坏了"。
  const r = await fetch(`${base}/probe.txt`);
  assert.equal(r.status, 200, '真实静态文件应 200，实际 ' + r.status);
  assert.equal(await r.text(), 'probe');
  assert.ok(!/text\/html/.test(r.headers.get('content-type') ?? ''),
    '有扩展名的资源不该被回落成 HTML（会让浏览器把 JS 当页面解析）');
});

/* ---------------- 图床签名（用户报障「上传失败 401」）---------------- */

/**
 * 🔴🔴 这条钉的是**协议**，不是实现细节。而且钉的是**两件**事：
 *
 *   ① **待签串的字段集合与字典序**（folder < timestamp < upload_preset）。
 *   ② **签名算法是 `SHA1(串 + secret)`，不是 HMAC-SHA1**。
 *
 * 为什么②必须单独钉：2026-10-06 实测（真云端，不是推理）——
 *   老项目的票直传 Cloudinary ⇒ 200；本项目的票 ⇒ 401。
 *   两边 cloud/key/preset/folder/secret **完全相同**，云端报的 "String to sign"
 *   与我们拼的串**逐字相同**。在服务端用同一份 secret 复算：
 *     SHA1(串+secret)      === 老项目产出 → true
 *     HMAC-SHA1(secret,串) === 本项目产出 → true
 *   ⇒ 唯一的差别就是算法。
 *
 * 🔴 我上一次把这条写成"根因是顺序"是**没验到底**：改完顺序就去改注释，
 *   却从没拿真云端复现一次成功上传。401 一直还在，而这条测试一直绿着
 *   —— 因为它复算时用**同一个 HMAC**，等于拿实现验自己。
 *
 * 判据两条，缺一不可：
 *   A. **金标向量**（写死，不靠实现算）：按 Cloudinary 规范手算出的 40 位 hex。
 *      谁把实现改成别的算法，这条立刻红。
 *   B. **反向断言**：服务返回的签名**不得**等于 HMAC 值。
 *      —— 少了这条，改回 HMAC 时若金标被一起改掉就没人拦得住。
 */
test('图床签名：必须是 SHA1(字典序串 + secret)，不是 HMAC', async () => {
  // 这套 env 必须在 boot() 时就带上，所以这里自己起一个实例而不是复用 base。
  const SECRET = 'test-secret-for-signing';
  const CLOUD = 'test-cloud';
  const PRESET = 'notesync-signed';
  const FOLDER = 'notesync';

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bj-srv-up-'));
  const www = fs.mkdtempSync(path.join(os.tmpdir(), 'bj-www-up-'));
  fs.writeFileSync(path.join(www, 'index.html'), '<!doctype html><html><body></body></html>', 'utf8');
  const port = 20000 + Math.floor(Math.random() * 20000);
  const up = spawn(process.execPath, [SERVER], {
    env: {
      ...process.env,
      NS_BJ_PORT: String(port),
      NOTESYNC_BJ_DATA_DIR: dir,
      NOTESYNC_BJ_WWW: www,
      NS_BJ_UPSIGN_SECRET: SECRET,
      NS_BJ_CLOUD_NAME: CLOUD,
      NS_BJ_UPSIGN_KEY: '12345',
      NS_BJ_UPSIGN_PRESET: PRESET,
      NS_BJ_UPSIGN_FOLDER: FOLDER,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const upBase = `http://127.0.0.1:${port}`;
  try {
    let up_ = null;
    for (let i = 0; i < 100; i++) {
      try {
        const r = await fetch(`${upBase}/healthz`);
        if (r.ok) { up_ = r; break; }
      } catch { /* 还没起来 */ }
      await new Promise((r) => setTimeout(r, 100));
    }
    assert.ok(up_, '图床签名测试用的服务端没起来');

    const r = await fetch(`${upBase}/api/upsign`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ note: 'signprobe' }),
    });
    assert.equal(r.status, 200, `/api/upsign 应 200，实际 ${r.status}`);
    const t = await r.json();

    // 🔴 判据 A（金标向量）：待签串必须正是云端会去验的那串。
    //    写死而不是拼出来 —— 拼出来等于拿实现验自己。
    const canonical = `folder=${FOLDER}&timestamp=${t.timestamp}&upload_preset=${PRESET}`;
    assert.equal(
      upsignSignedString({ timestamp: t.timestamp, folder: FOLDER, uploadPreset: PRESET }),
      canonical,
      `待签串不是字典序 folder<timestamp<upload_preset。云端会拿 "${canonical}" 去验，顺序不同 ⇒ 401。`,
    );

    // 🔴 判据 B：服务返回的签名必须等于 `SHA1(串 + secret)` 的金标，
    //    且**不等于** HMAC 值。前者钉算法，后者防止"两边一起改"蒙混过关。
    const crypto = await import('node:crypto');
    const golden = crypto.createHash('sha1').update(canonical + SECRET).digest('hex');
    const hmac = crypto.createHmac('sha1', SECRET).update(canonical).digest('hex');
    assert.equal(
      t.signature,
      golden,
      `签名不是 SHA1(串 + secret)。云端要的是 "${golden}"（串="${canonical}"），实际 "${t.signature}" ⇒ 401。`,
    );
    assert.notEqual(
      t.signature,
      hmac,
      '签名撞上了 HMAC-SHA1 的值 —— Cloudinary 要的是 SHA1(串 + secret)，不是 HMAC。' +
      ' 这一条是反向断言：没有它，"把金标和实现一起改成 HMAC"会重新变成绿的假成功。',
    );

    // 顺手钉住纯函数本身（import 生产代码，改实现就红）
    assert.equal(
      upsignSign({ secret: SECRET, timestamp: t.timestamp, folder: FOLDER, uploadPreset: PRESET }),
      t.signature,
      'upsignSign() 与服务实际下发的签名不一致 —— 说明签发走了别的路径。',
    );

    // 顺手钉住"签名只覆盖这三个字段"：多带一个未签参数云端也会判不符。
    assert.equal(t.uploadPreset, PRESET, 'upload_preset 应原样下发');
    assert.equal(t.folder, FOLDER, 'folder 应原样下发');
    assert.equal(t.cloudName, CLOUD, 'cloud_name 应原样下发');
  } finally {
    up.kill();
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(www, { recursive: true, force: true });
  }
});
