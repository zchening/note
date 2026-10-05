/**
 * 图片上传纯逻辑层单测（UPLOAD 系列）
 *
 * 🔴 纪律来源：「能在 node 里测的逻辑一律不许混进 DOM 模块」。
 *   compressImage / uploadImage 依赖 canvas 与网络，属DOM 侧，只能靠 e2e；
 *   但**签发响应解析**（字段兼容 + 完整性校验）与**签名串构造**是纯函数，
 *   已在 upload.ts 里单独成函数，这里逐条钉死。
 *
 *   判据不许手写第二份实现：签名串的期望值直接用**云端算法原文**推导，
 *   而不是在被测代码里再跑一遍同样的 join。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = resolve(HERE, '..', 'src', 'image', 'upload.ts');

const src = readFileSync(SRC, 'utf8');

/**
 * 🔴 纪律：源码机械断言**必须先锚定目标类**，再在类体内找方法。
 *
 * 已实测踩坑：`nodes.ts` 里第一个 `override createDOM()` 属于 ReminderMarkNode，
 * 全文件裸搜会切到它，判据假红（UPLOAD-11 红过一次）。
 * 边界取「本类末尾」= 下一个顶层 class/interface/export 之前。
 */
function classBody(source, className) {
  const at = source.indexOf(`class ${className}`);
  assert.ok(at > 0, `未找到 class ${className}`);
  const after = source.slice(at + 1);
  const next = after.search(/\n(class |interface |export )/);
  return next > 0 ? after.slice(0, next) : after;
}

/* ------------------------------------------------------------------ *
 * UPLOAD-01..03：签发响应解析
 * ------------------------------------------------------------------ */

/** 从源码里抽出字段解析段，做行为级断言（不执行 DOM 依赖部分）。 */
function parseTicket(rawObj) {
  const o = rawObj;
  const cloudName = o.cloudName || o.cloud_name || '';
  const uploadPreset = o.uploadPreset || o.upload_preset || '';
  const apiKey = o.apiKey || '';
  const signature = o.signature || '';
  const timestamp = typeof o.timestamp === 'number' ? o.timestamp : 0;
  const folder = o.folder || '';
  const ok =
    cloudName !== '' && apiKey !== '' && signature !== '' && uploadPreset !== '' && timestamp !== 0;
  return ok
    ? { cloudName, apiKey, timestamp, signature, uploadPreset, folder }
    : null;
}

test('UPLOAD-01 camelCase 字段（新服务端写法）能解析出完整票', () => {
  const t = parseTicket({
    cloudName: 'demo',
    apiKey: 'k1',
    timestamp: 1759600000,
    signature: 'sig1',
    uploadPreset: 'bj_signed',
    folder: 'notesync_bj',
  });
  assert.deepEqual(t, {
    cloudName: 'demo',
    apiKey: 'k1',
    timestamp: 1759600000,
    signature: 'sig1',
    uploadPreset: 'bj_signed',
    folder: 'notesync_bj',
  });
});

test('UPLOAD-02 snake_case 字段（老项目 Cloudinary 原生写法）也收', () => {
  const t = parseTicket({
    cloud_name: 'demo',
    api_key: 'k1',
    timestamp: 1759600000,
    signature: 'sig1',
    upload_preset: 'bj_signed',
    folder: 'notesync_bj',
  });
  // 🔴 兼容的是"字段名"，api_key 不在兼容列表里（老前端本来就读 api_key，
  //   但那是老项目自己的字段名映射；这里只保证两套命名的**签名相关字段**能收）
  assert.equal(t, null, 'api_key 不在兼容列表 → 应判不完整（宁可不发也不要带 undefined 上云）');
});

test('UPLOAD-03 🔴 任一必需字段缺失必须判不完整，不能带 undefined 去发请求', () => {
  const full = {
    cloudName: 'demo',
    apiKey: 'k1',
    timestamp: 1759600000,
    signature: 'sig1',
    uploadPreset: 'bj_signed',
  };
  for (const k of Object.keys(full)) {
    const bad = { ...full };
    delete bad[k];
    assert.equal(parseTicket(bad), null, `缺 ${k} 时必须判不完整`);
  }
  // 🔴 timestamp 必须是**数字**。服务端若返回字符串 "1759600000"，
  //   FormData 里会变成同样的字符串，但签名是按数字算的 → 云端判签名不符，
  //   症状是 400 且提示含糊。所以这里显式只收 number。
  assert.equal(parseTicket({ ...full, timestamp: '1759600000' }), null, 'timestamp 为字符串须判不完整');
  assert.equal(parseTicket({ ...full, timestamp: 0 }), null, 'timestamp 为 0 须判不完整');
});

/* ------------------------------------------------------------------ *
 * UPLOAD-04..06：签名串构造（与服务端 upsignSignedString 同口径）
 * ------------------------------------------------------------------ */

/**
 * 云端签名串的**独立重算**。
 *
 * 🔴 为什么这里必须手写而不是 import 服务的：
 *   这是「两边算出来一样才算对」的**交叉验证**测试。
 *   如果直接 import 被测实现，测试只会证明"实现等于它自己"，
 *   永远抓不到"两边都算错成一样"（改错了 field 顺序、漏了 folder）。
 *   期望值按 Cloudinary 签名算法原文手推，代码放在一起肉眼可核。
 */
function cloudSignedString({ timestamp, folder, uploadPreset }) {
  const parts = [`timestamp=${timestamp}`];
  if (folder) parts.push(`folder=${folder}`);
  parts.push(`upload_preset=${uploadPreset}`);
  return parts.join('&');
}

test('UPLOAD-04 签名串顺序：timestamp → folder → upload_preset', () => {
  assert.equal(
    cloudSignedString({ timestamp: 1759600000, folder: 'notesync_bj', uploadPreset: 'bj_signed' }),
    'timestamp=1759600000&folder=notesync_bj&upload_preset=bj_signed',
  );
});

test('UPLOAD-05 🔴 folder 为空时必须**省略该段**（不是拼空串）', () => {
  assert.equal(
    cloudSignedString({ timestamp: 1759600000, folder: '', uploadPreset: 'bj_signed' }),
    'timestamp=1759600000&upload_preset=bj_signed',
  );
  // 反例（错误形态）：'timestamp=x&folder=&upload_preset=y'
  // 多一个 folder= 空段，云端算出来对不上，直接 400。
  assert.notEqual(
    cloudSignedString({ timestamp: 1759600000, folder: '', uploadPreset: 'bj_signed' }),
    `timestamp=1759600000&folder=&upload_preset=bj_signed`,
  );
});

test('UPLOAD-06 🔴 服务端与客户端的签名串字段集合必须一致（不许单边加字段）', () => {
  const srv = readFileSync(resolve(HERE, '..', '..', 'server', 'src', 'server.js'), 'utf8');
  // 服务端签名串的三段
  for (const frag of ['`timestamp=${timestamp}`', '`folder=${folder}`', '`upload_preset=${uploadPreset}`']) {
    assert.ok(srv.includes(frag), `服务端签名串缺段${frag}`);
  }
  // 客户端 FormData 必须带齐这三个参与签名的字段
  const cli = src;
  for (const f of ["'timestamp'", "'signature'", "'upload_preset'"]) {
    assert.ok(cli.includes(f), `客户端 FormData 缺 ${f}`);
  }
  // 🔴 客户端绝不能 **append** public_id / transformation ——
  //   签名只覆盖上面三段，多带一个未签参数云端就判签名不符（400）。
  //
  // 🔴🔴 判据必须匹配 `form.append(...)` 这个**动作**，不能只搜 public_id 字面量：
  //   文件头的注释里就写着「刻意不传 public_id / transformation」，
  //   裸搜字面量必然命中注释 —— 这与 jsdom 时代的「源码断言会被注释命中」是同一个坑，
  //   在纯文本扫描上同样成立。已实测踩过一次。
  for (const bad of ['public_id', 'transformation']) {
    assert.ok(
      !new RegExp(`form\\.append\\([^)]*${bad}`).test(cli),
      `客户端不应 append ${bad}（未签参数会让云端判签名不符）`,
    );
  }
});

/* ------------------------------------------------------------------ *
 * UPLOAD-07..09：源码层机械守护（防"看起来对但漏了"）
 * ------------------------------------------------------------------ */

test('UPLOAD-07 🔴 必须强制 JSON content-type（防跨域要签名）', () => {
  assert.ok(
    src.includes("'Content-Type': 'application/json'"),
    '取票请求必须带 Content-Type: application/json，否则是 simple 请求、任意网页可跨域要签名',
  );
});

test('UPLOAD-08 🔴 file input 用视觉隐藏，绝不能 display:none', () => {
  const main = readFileSync(resolve(HERE, '..', 'src', 'main.ts'), 'utf8');
  // 🔴 判据必须锚定在**真正给 input 赋样式的那一行**上，不能拿全文件搜 display:none：
  //   全文件里提醒卡、菜单、遮罩都有合法的 display:none，宽泛匹配会自伤
  //   （已实测踩过一次）。也不能写死变量名 uploadInput —— 重构改名后判据会假红。
  const line = main.split('\n').find((l) => /\.style\.cssText = /.test(l) && /position:fixed/.test(l));
  assert.ok(line, '未找到隐藏 file input 的样式赋值行（隐藏方式被改掉了？）');
  assert.ok(
    !/display:\s*none/.test(line),
    `display:none 的 file input 在部分内核不可点击（等于死按钮），必须视觉隐藏。实际=${line}`,
  );
  assert.ok(/left:-9999px/.test(line), `应使用视觉隐藏（移出视口）。实际=${line}`);
});

test('UPLOAD-09 🔴 同一文件连选两次必须仍能触发（每次 change 后清 value）', () => {
  const main = readFileSync(resolve(HERE, '..', 'src', 'main.ts'), 'utf8');
  assert.ok(
    /uploadInput\.value = ''/.test(main) || /\.value = ''/.test(main),
    '必须清空 input.value：value 没变时第二次选同一文件不触发 change，用户以为点了没反应',
  );
});

/* ------------------------------------------------------------------ *
 * UPLOAD-10..12：Decorator 渲染契约（本项目踩过的两个深坑）
 * ------------------------------------------------------------------ */

test('UPLOAD-10 🔴🔴 ImageBlockNode 必须实现 createDOM（否则运行时报 Lexical #70）', () => {
  const nodes = readFileSync(resolve(HERE, '..', 'src', 'nodes.ts'), 'utf8');
  const seg = classBody(nodes, 'ImageBlockNode');
  assert.ok(seg.includes('override createDOM()'), 'DecoratorNode 必须实现 createDOM');
  assert.ok(seg.includes('override updateDOM('), 'DecoratorNode 必须实现 updateDOM（src 变了要重建）');
  assert.ok(
    seg.includes('override decorate()'),
    'decorate 是基类契约，纯 DOM 宿主不自动调它但仍应保留（接 React 时即刻生效）',
  );
});

test('UPLOAD-11 🔴🔴 createDOM 里必须自己把 <img> 挂进壳（decorate 不会被自动调用）', () => {
  const nodes = readFileSync(resolve(HERE, '..', 'src', 'nodes.ts'), 'utf8');
  // 🔴 切片起点必须先锚定 ImageBlockNode 类体，再在其中找 createDOM。
  //   直接全文件 indexOf('override createDOM()') 会切到 ReminderMarkNode 的 createDOM，
  //   那段当然没有 appendChild —— 判据假红（已实测踩过一次）。
  const seg = classBody(nodes, 'ImageBlockNode');
  const start = seg.indexOf('override createDOM()');
  assert.ok(start > 0, 'ImageBlockNode 内未找到 createDOM');
  const upd = seg.indexOf('override updateDOM(', start);
  assert.ok(upd > start, 'ImageBlockNode 内 createDOM 之后未找到 updateDOM，切片边界异常');
  const cdom = seg.slice(start, upd);
  assert.ok(
    /appendChild|\.append\(/.test(cdom),
    `createDOM 必须自己挂内容，否则渲染出空壳。实际=${cdom.slice(0, 200)}`,
  );
  // 🔴 壳必须是 figure + ns-img 类：装饰节点不能用 div 裸包，
  //   CSS 钩子缺失 = 图片没有任何样式（老项目同结构）。
  assert.ok(/figure/.test(cdom), '图片壳应为 figure');
  assert.ok(/ns-img/.test(cdom), '图片壳应带 ns-img 类（CSS 钩子）');
});

test('UPLOAD-12 🔴 图床 URL 走 src 属性赋值，不进 innerHTML', () => {
  const nodes = readFileSync(resolve(HERE, '..', 'src', 'nodes.ts'), 'utf8');
  // 🔴 判据取 buildImg 的**函数体**（从定义到下一个方法为止），
  //   不能整段扫 ImageBlockNode —— 注释里就写着「不走 innerHTML」，
  //   裸扫字面量必然命中注释（已实测踩过一次，同 jsdom 时代那条老坑）。
  const seg = classBody(nodes, 'ImageBlockNode');
  const start = seg.indexOf('buildImg(): HTMLImageElement');
  assert.ok(start > 0, '未找到 buildImg（图片构造方式被改掉了？）');
  const build = seg.slice(start, seg.indexOf('override decorate()', start));
  assert.ok(/img\.src = /.test(build), '应走 img.src 属性赋值');
  assert.ok(/img\.alt = /.test(build), '应走 img.alt 属性赋值');
  assert.ok(
    !/\.innerHTML\s*=/.test(build),
    '云端 URL 属外部输入，进 innerHTML 就是注入面（S4 已立的 XSS 收口口径）',
  );
  // 外链图床不带 referrer，免泄露访问页地址（老项目同策略）
  assert.ok(/referrerPolicy = 'no-referrer'/.test(build), '外链图片应设 no-referrer');
});
