/**
 * 扫码配对纯逻辑层单测（PAIR / ENGINE 系列）
 *
 * 🔴 纪律来源同 FAV 系列：**能在 node 里测的逻辑不许混进 DOM 模块**。
 *   pair-link.ts / engine.ts 里可测的部分（编解码、同源判定、可见区裁剪、
 *   像素分级、降级判据）都不碰 document/window，所以这里能逐条钉死。
 *
 * 🔴 本组测试最核心的一条是 **PAIR-01：载荷是口令不是密钥**。
 *   它钉的是一次架构决策，不是实现细节 ——
 *   哪天有人"为了少输一次口令"改成塞 raw key，PAIR-01 必须立刻红。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

import {
  PAIR_FRAGMENT_KEY,
  b64UrlDecode,
  b64UrlEncode,
  buildPairLink,
  isPlainNoteName,
  parsePairLink,
} from '../src/scan/pair-link.ts';
import {
  downgradeWhy,
  gapFor,
  newDiag,
  shouldDowngrade,
  tierFor,
  tierLabel,
  visibleCrop,
} from '../src/scan/engine.ts';
import { scaleFor, largeTargetPx } from '../src/scan/qr-draw.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const STATIC = resolve(HERE, '..', 'static');
const ORIGIN = 'https://bj.xuyinji.com.cn';

/* ────────────────────────── 配对链接 ────────────────────────── */

test('PAIR-01 🔴🔴 载荷必须是**口令**而不是密钥（架构决策钉）', () => {
  // 这条钉的是"为什么新项目不能照抄老项目"这个决策本身。
  // 老项目的二维码装 raw AES 密钥（#k=），它成立的前提是密钥可导出、可落盘。
  // 新项目的 CryptoKey 是 extractable:false，导不出 —— 所以只能传口令。
  const link = buildPairLink(ORIGIN, 'mydoc', 'hunter2');
  const hash = link.slice(link.indexOf('#') + 1);
  assert.equal(hash.split('=')[0], PAIR_FRAGMENT_KEY, '载荷键必须是 p（口令），不是 k（密钥）');
  // 🔴 绝不能出现老项目的 k= 载荷：那是**另一把钥匙的字节**，
  //   当口令喂进 PBKDF2 只会得到"口令不对"，用户完全想不到真正原因。
  assert.ok(!link.includes('#k='), '配对链接不得带老项目的 #k= 密钥载荷');
  // 载荷是口令的 base64url，不是 43/44 字符的 AES 密钥长度
  const payload = hash.slice(2);
  assert.equal(b64UrlDecode(payload), 'hunter2');
  assert.notEqual(payload.length, 43, '载荷长度不应是 AES-256 密钥的 base64 长度');
});

test('PAIR-02 口令走 fragment 不走 query（fragment 不随请求上行）', () => {
  const link = buildPairLink(ORIGIN, 'doc', 'pw');
  assert.ok(link.includes('#p='), '口令必须在 fragment 里');
  assert.ok(!link.includes('?'), '口令绝不能进 query —— 那会随 HTTP 请求发到服务器');
});

test('PAIR-03 口令含中文/符号/emoji/空格都能往返', () => {
  for (const pw of ['中文口令', 'a b c', 'p@ss!#$%^&*()', '😀🔑', ' 前后空格  ', '1234']) {
    const link = buildPairLink(ORIGIN, 'doc', pw);
    const got = parsePairLink(link, ORIGIN);
    assert.ok(got.ok, '应能解析：' + pw);
    assert.equal(got.link.passphrase, pw, '口令必须逐字往返：' + pw);
    assert.equal(got.link.noteId, 'doc');
  }
});

test('PAIR-04 base64url 必须补回 padding（atob 长度 %4==1 直接抛）', () => {
  // 长度 1 的输入：btoa('a') = 'YQ==' → 去 padding 后 'YQ'（长 2）
  // 长度 3 的输入：'YWJj'（长 4，无需补）
  for (const s of ['a', 'ab', 'abc', 'abcd', 'abcde', '一二三', '😀']) {
    const enc = b64UrlEncode(s);
    assert.ok(!enc.includes('='), 'base64url 不得含 padding');
    assert.ok(!enc.includes('+') && !enc.includes('/'), 'base64url 不得含 + /');
    assert.equal(b64UrlDecode(enc), s, '往返失败：' + s);
  }
});

test('PAIR-05 笔记名合法性必须判**原样**，不是净化后非空', () => {
  // 🔴 这条是老项目"净化器静默删字符"陷阱的护栏：
  //   /a b 会被 sanitize 成 ab —— 若只判"净化后非空"，
  //   就会悄悄出一张指向 ab 的码，用户站在 a b 前扫它却打开 ab。
  assert.equal(isPlainNoteName('mydoc'), true);
  assert.equal(isPlainNoteName('my-doc_1'), true);
  assert.equal(isPlainNoteName('a b'), false, '含空格 = 非法（净化后会变成 ab）');
  assert.equal(isPlainNoteName('中文'), false);
  assert.equal(isPlainNoteName(''), false);
  assert.equal(isPlainNoteName('a/b'), false);
  assert.equal(isPlainNoteName('..'), false);
});

test('PAIR-06 只信同源，异域一律 not-pair（不做开放重定向）', () => {
  const evil = 'https://evil.example.com/doc#p=' + b64UrlEncode('pw');
  const got = parsePairLink(evil, ORIGIN);
  assert.equal(got.ok, false);
  assert.equal(got.ok === false && got.reason, 'not-pair');

  // 端口不同也不同源
  const port = 'https://bj.xuyinji.com.cn:8443/doc#p=' + b64UrlEncode('pw');
  assert.equal(parsePairLink(port, ORIGIN).ok, false);
});

test('PAIR-07 非法输入的 reason 分类要能区分"扫错了"与"链接坏了"', () => {
  const at = (s) => parsePairLink(s, ORIGIN);
  // 扫错：根本不是链接 / 不是本系统
  assert.equal(at('hello world').ok, false);
  assert.equal(at('').ok, false);
  assert.equal(at(ORIGIN + '/doc').ok, false, '无 fragment = 不是配对码');
  assert.equal(at(ORIGIN + '/doc#k=AAAA').ok, false, '老项目密钥码不是本系统配对码');
  // 链接坏了：载荷解不开 / 空载荷
  assert.equal(at(ORIGIN + '/doc#p=').ok, false);
  assert.equal(at(ORIGIN + '/doc#p=!!!!').ok, false);
  assert.equal(at(ORIGIN + '/a/b#p=' + b64UrlEncode('pw')).ok, false, '路径多段不是配对码');
});

test('PAIR-08 路径里的百分号编码要正确解码', () => {
  // 合法笔记名只有 A-Za-z0-9_-，但 encodeURIComponent 对它们不会转义 ——
  //   所以这条实际测的是"解码失败要判 bad-name 而不是抛"。
  const link = ORIGIN + '/%E4%B8%AD%E6%96%87#p=' + b64UrlEncode('pw');
  const got = parsePairLink(link, ORIGIN);
  assert.equal(got.ok, false, '中文名非法（净化器只留 A-Za-z0-9_-）');
  assert.equal(got.ok === false && got.reason, 'bad-name');
});

test('PAIR-09 origin 尾部斜杠不影响判定（/ 与 https://x.com 等价）', () => {
  const link = buildPairLink(ORIGIN, 'doc', 'pw');
  assert.equal(parsePairLink(link, ORIGIN + '/').ok, true);
  assert.equal(parsePairLink(link, ORIGIN + '///').ok, true);
  // 出码侧也要容忍带斜杠的 origin（否则会出 //doc 的双斜杠路径）
  const l2 = buildPairLink(ORIGIN + '/', 'doc', 'pw');
  assert.ok(!l2.includes('//doc'), '出码不得产生双斜杠路径：' + l2);
});

/* ────────────────────────── 取景判据 ────────────────────────── */

test('ENGINE-01 可见区裁剪：只解 object-fit:cover 真正露出来的那一块', () => {
  // video 1280x720，stage 是竖屏（360x560）→ 可见内容是中心竖条
  const c = visibleCrop(1280, 720, 360, 560);
  // aspect = 360/560 = 0.643；按 vw/aspect = 1991 > vh → 取 sh=720, sw=463
  assert.equal(c.sh, 720, '可见高度就是全高');
  assert.ok(c.sw < 1280, '可见宽度必须窄于视频宽（竖屏 stage 只露中间一条）');
  assert.equal(c.sx, Math.round((1280 - c.sw) / 2), '水平居中裁剪');
  assert.equal(c.sy, 0, '垂直不裁（已占满）');
  // 🔴 这条是性能护栏：整帧解在中端机 150~300ms/帧，实际只有 2~3 次/秒
  assert.ok(c.sw * c.sh < 1280 * 720, '可见面积必须小于整帧');
});

test('ENGINE-02 可见区裁剪：stage 比视频「更方」时裁上下', () => {
  // stage 560x360（aspect 1.556）比视频 1280x720（1.778）更方
  //   → 按 stage 宽反推高会超出视频高，于是改为按高反推宽：sw=1120
  // 🔴 这条判据的价值是**方向**：两种 stage 形状各裁一次，
  //   只测一种的话，另一种的分支一旦写反（比如把 sh/sw 弄反）
  //   在真机上表现为"竖屏能扫、横屏永远扫不出" —— 只在特定机型上复现。
  const c = visibleCrop(1280, 720, 560, 360);
  assert.equal(c.sh, 720, '高度占满视频高');
  assert.equal(c.sw, Math.round(720 * (560 / 360)), '宽度按 stage 宽高比反推');
  assert.ok(c.sw < 1280, '宽度必须被裁');
  assert.equal(c.sy, 0, '垂直不裁');
});

test('ENGINE-02b 可见区裁剪：stage 比视频「更宽」时裁左右', () => {
  // stage 1000x360（aspect 2.78）比视频更宽 → 按宽反推高得 461 < 720，取 sw=1280
  const c = visibleCrop(1280, 720, 1000, 360);
  assert.equal(c.sw, 1280, '宽度占满');
  assert.ok(c.sh < 720, '高度被裁');
  assert.equal(c.sx, 0, '水平不裁');
  assert.ok(c.sw * c.sh < 1280 * 720, '可见面积仍小于整帧');
});

test('ENGINE-03 退化输入不得崩（0 宽高 / 未出帧）', () => {
  for (const args of [[0, 0, 360, 560], [1280, 720, 0, 0], [1280, 720, 0, 560], [-1, -1, -1, -1]]) {
    const c = visibleCrop(...args);
    assert.equal(typeof c.sx, 'number');
    assert.equal(typeof c.sw, 'number');
  }
});

// 🔴 v1.12.0：数值由老项目基线（TIER_FAST 560 / TIER_UP_MISS 8 / GAP_MIN 120）
//   调为 640 / 14 / 90（用户拍板"跳过真机验证直接改"）。
//   ⇒ 本条判据必须跟着更新，否则它钉的正是"我们不想改的那套数值"。
//
//   🔴 但只钉**行为不变式**，不钉绝对数字：真正不能坏的是
//      ①"起始档比清档小"（帧率优先的方向）
//      ②"存在一个明确的升档门槛"（不是一上来就清档）
//      ③升档后确实变大了（分辨率优先）
//   数值本身是调优参数，允许调；钉死数值等于把调优路径也一起钉死。
const FAST_TIER = tierFor(0);
const CLEAR_TIER = tierFor(1000);

test('ENGINE-04 像素分级：先快后清（帧率优先 → 分辨率优先）', () => {
  assert.ok(FAST_TIER < CLEAR_TIER, `起始档必须小于清档（${FAST_TIER} !< ${CLEAR_TIER}）`);
  assert.equal(tierFor(0), FAST_TIER, 'miss=0 用快档');
  assert.equal(tierFor(1000), CLEAR_TIER, 'miss 足够多用清档');

  // 🔴 升档门槛必须落在"多帧"上：一上来就清档= 慢机型饿死（老项目 v10.1.6血泪）。
  let first = -1;
  for (let m = 0; m <= 200; m += 1) {
    if (tierFor(m) === CLEAR_TIER) {
      first = m;
      break;
    }
  }
  assert.ok(first >= 2, `升档门槛不能是 0 或 1 帧（实际 ${first}）`);
  assert.ok(first <= 60, `升档门槛不能太大，否则迟迟不解（实际 ${first}）`);
});

test('ENGINE-04b v1.12.0 调优取值：小档 640 / 升档门槛 14 帧', () => {
  //🔴 这三条是本版的**具体调优取值**，显式钉住，避免以后被无意改回。
  //   用户拍板依据是「老版本扫描识别更快」，方向＝更高帧率 + 更久保持快档。
  assert.equal(tierFor(0), 640, '快档预算 v1.12.0 调为 640');
  assert.equal(tierFor(13), 640, 'miss=13 仍在快档（门槛比老项目 8 帧宽）');
  assert.equal(tierFor(14), 1120, 'miss=14 升清档');
});

test('ENGINE-04c tierLabel 必须与 tierFor 同源（不能复制魔法数）', () => {
  // 🔴 回归防护：layer.ts 原来写 `tier > 560` 判断显示"清/快"，
  //   而 TIER_FAST 调成 640 后该判断**恒真** ⇒ 诊断字段恒显示"清"。
  assert.equal(tierLabel(tierFor(0)), '快', '快档必须显示"快"');
  assert.equal(tierLabel(tierFor(1000)), '清', '清档必须显示"清"');
  // 反向断言：照抄老写法`> 560` 在新参数下会给出错误答案 ——
  //   640 > 560 恒真，快档会被误标成"清"。这条钉住"我们没退回老写法"。
  assert.notEqual(tierLabel(tierFor(0)) === '清', 640 > 560);
});

test('ENGINE-05 自排队间隔 = clamp(耗时 + 余量, 下限, 上限)', () => {
  // 🔴 v1.12.0：老版钉的是 `gapFor(0) === 120`，而本版调了参数，
  //   照抄那个断言只会让判据钉住"我们不想改的那套数值"。改为钉**公式形状**：
  //   ① 极快帧也必须 > 0（不许空转烧电）
  //   ② 耗时越长间隔越大（自适应的意义）
  //   ③ 慢帧必须被夹上限（否则用户以为死了）
  //   ④ 夹紧后的值不得越界
  const fast = gapFor(0);
  const mid = gapFor(100);
  const slow = gapFor(1000);
  assert.ok(fast > 0, `帧很快也要留间隔下限（实际 ${fast}）`);
  assert.ok(fast < mid, `耗时越长间隔越大（fast=${fast} mid=${mid}）`);
  assert.equal(slow, 400, '慢帧要夹上限 400ms，否则用户以为死了');
  for (const v of [fast, mid, slow, gapFor(50_000)]) {
    assert.ok(v >= 0 && v <= 400, `间隔必须落在 [0,400]，实际 ${v}`);
  }
});

test('ENGINE-05b v1.12.0 调优取值：余量 60ms（真正的帧率杠杆）', () => {
  // 🔴 显式钉住余量而非下限：上一版只改 GAP_MIN 120→90 几乎等于空操作
  //   （costMs + 余量早已大于下限），真杠杆是这个加数。首跑 ENGINE-05
  //   `120 !== 90` 就是"常量改了公式没改"抓出来的 —— 已改为具名 GAP_PAD。
  //   老项目余量 120ms ⇒ 本版 60ms。
  //
  // 🔴 注意 gapFor(0) 不是 60：公式是 clamp(cost + 余量, GAP_MIN=90, GAP_MAX)，
  //   极快帧落到下限上（90）。别把它写成 60 —— 首跑就是这么错的。
  assert.equal(gapFor(0), 90, '极快帧落到下限 90ms');
  assert.equal(gapFor(40), 100, 'cost 40 + 余量 60 > 下限，取计算值');
  assert.equal(gapFor(100), 160, '耗时 100ms + 余量 60ms');
  // 真正的等价性断言：余量真的变小了（老基线 120）
  assert.ok(gapFor(100) < 220, `耗时 100ms 时间隔应小于老基线 220，实际 ${gapFor(100)}`);
});

test('ENGINE-06 降级判据：连错 3 帧 或 40 帧零命中', () => {
  const base = () => ({ ...newDiag(), engine: 'detector' });

  let d = base();
  d.frames = 2;
  d.errs = 2;
  assert.equal(shouldDowngrade(d), false, '还没到 3 帧');

  d.errs = 3;
  assert.equal(shouldDowngrade(d), true, '连错 3 帧必须降级');
  assert.equal(downgradeWhy(d), '解码器连错 3 帧');

  // 更阴的形态：detect() 不抛错但永远返回空数组
  let z = base();
  z.frames = 39;
  z.hits = 0;
  assert.equal(shouldDowngrade(z), false);
  z.frames = 40;
  assert.equal(shouldDowngrade(z), true, '40 帧零命中必须降级（否则永远扫不出）');

  // 已经降级过就不再降级（否则无限重复）
  const j = { ...base(), engine: 'jsqr(降级)', errs: 99, frames: 99 };
  assert.equal(shouldDowngrade(j), false, '已是 jsqr 就不再降级');

  // 🔴 零命中分支才有 hits 例外：已经出过货说明引擎活着，不因 40 帧数字而降级。
  //   但「连错 3 帧」**不看 hits** —— 出过货的引擎照样可能在大多数帧上抛错，
  //   那种情况下留在它上面等于让用户对着一个时灵时不灵的解码器（老项目 v10.1.5 症状）。
  const h = { ...base(), frames: 100, hits: 1, errs: 0 };
  assert.equal(shouldDowngrade(h), false, '零命中分支：已出过货就不降级');
  assert.equal(downgradeWhy({ ...base(), frames: 40, hits: 0 }), '解码器 40 帧零命中');
});

test('ENGINE-07 newDiag 必须给全零初值（不继承上一场）', () => {
  const d = newDiag();
  assert.deepEqual(d, {
    engine: '',
    frames: 0,
    hits: 0,
    miss: 0,
    errs: 0,
    cam: '0x0',
    dec: '0x0',
    err0: '',
    result: '',
  });
});

/* ────────────────────────── 出码几何 ────────────────────────── */

test('PAIR-10 scale 下限 4（低于此摄像头必扫不出）', () => {
  assert.equal(scaleFor(33), 5, '弹窗态固定 5');
  assert.equal(scaleFor(33, 600), 14);
  // 小目标宽也必须保底 4：scale=2 时每格不到 4 设备像素，边缘被插值糊掉
  assert.equal(scaleFor(100, 100), 4, '目标太小时必须保底 4');
  assert.equal(scaleFor(100, 1000), 9);
});

test('PAIR-11 放大态目标位图宽 = 视口短边 88% × DPR，下限 480', () => {
  assert.equal(largeTargetPx(390, 3), Math.floor(390 * 0.88 * 3));
  // 极小视口也保底 480（老项目 v7.5.1 实锤：低于此识别率断崖）
  assert.equal(largeTargetPx(100, 1), 480);
  // DPR 缺失按 2 算
  assert.equal(largeTargetPx(1000, 0), 1760);
});

/* ────────────────────────── 入库与构建 ────────────────────────── */

test('PAIR-12 🔴🔴 三个 vendor 库必须**入库**（www/ 整个被 gitignore）', () => {
  // 与 EXPORT-19 同源的一条纪律：www/ 是构建产物，不在版本控制里。
  // 曾经 html2canvas.min.js 只存在于本机 www/ —— CI 拉下来的仓库没有它，
  // 于是部署后导出整体不可用，而失败文案只说"组件未加载"，用户只会觉得功能坏了。
  for (const [f, min] of [
    ['jsQR.js', 50000],
    ['qrcode-generator.js', 10000],
    ['html2canvas.min.js', 50000],
    ['sw.js', 500],
  ]) {
    const p = join(STATIC, f);
    assert.ok(existsSync(p), f + ' 未入库到 packages/client/static/');
    assert.ok(statSync(p).size > min, f + ' 体积异常小（可能截断）：' + statSync(p).size);
  }
});

test('PAIR-13 🔴 构建脚本必须点名三个 vendor 库（缺文件时有人知道）', () => {
  const src = readFileSync(resolve(HERE, '..', '..', '..', 'tools', 'build.mjs'), 'utf8');
  assert.match(src, /materializeStatic/, '构建未物化静态资源');
  for (const f of ['sw.js', 'html2canvas.min.js', 'jsQR.js', 'qrcode-generator.js']) {
    assert.ok(src.includes(f), '构建未点名 ' + f + '（缺文件时无人知道）');
  }
});

test('PAIR-14 gitignore 不得把 static 源目录排除掉', () => {
  const gi = readFileSync(resolve(HERE, '..', '..', '..', '.gitignore'), 'utf8');
  assert.match(gi, /^www\/$/m, 'www/ 应继续被忽略（它是构建产物）');
  assert.ok(!/packages\/client\/static/.test(gi), '静态资源源目录被 gitignore 了（CI 产物必然缺文件）');
});

/* ────────────────────────── 源码级回归钉 ────────────────────────── */

const read = (rel) => readFileSync(resolve(HERE, '..', rel), 'utf8');

/**
 * 从 `decl` 处按**花括号配平**截出函数体（不含结尾 `}`）。
 *
 * 🔴🔴 为什么不能 `main.slice(main.indexOf(decl))` 一路切到文件尾：
 *   v1.13.0 加了 `tryResumeLastNote()`（"恢复最后一篇"，里面**必须**用
 *   `location.assign`——那是页面内跳转，不是扫码落地），它定义在
 *   `handleScanRaw` **之后**。按文件尾切片会把那段正确代码一起吃进来，
 *   于是 PAIR-15 红在一个**与扫码毫无关系**的新功能上。
 *
 *   这是本项目第二次栽在同一个形状上（另一次见 last-note.test.mjs 的
 *   `sliceBlock`）：**判据切片的边界必须等于语义边界**。
 *   判据红在别人的正确代码上，比判据恒绿更浪费时间 —— 它会把人引去改产品代码。
 */
function bodyOf(code, decl) {
  const start = code.indexOf(decl);
  assert.ok(start >= 0, `源码里应能找到 ${decl}`);
  const open = code.indexOf('{', start);
  assert.ok(open > 0, `${decl} 后面应该有一个 {`);
  let depth = 0;
  for (let i = open; i < code.length; i += 1) {
    if (code[i] === '{') depth += 1;
    else if (code[i] === '}') {
      depth -= 1;
      if (depth === 0) return code.slice(open, i);
    }
  }
  throw new Error(`${decl} 的花括号不配平，判据自身有问题`);
}

test('PAIR-15 🔴 配对链接不得有任何 location.assign / href 跳转落地', () => {
  // 老项目用 location.assign(dest) 整页重载，那会把口令带进地址栏
  //   → 进浏览器历史、进"最近访问"、可能被同步到别的设备。
  // 新项目必须原地 unlock()，口令只经过内存。
  const src = read('src/scan/pair-link.ts');
  assert.ok(!/location\s*\.\s*assign/.test(src), '配对链接模块不得跳地址');
  assert.ok(!/\.href\s*=/.test(src), '配对链接模块不得写 href');
  const main = read('src/main.ts');
  // 🔴 只切 `handleScanRaw` **自己的函数体**（见 bodyOf 的注释）
  const seg = bodyOf(main, 'async function handleScanRaw');
  assert.ok(!seg.includes('location.assign'), '扫码落地不得用 location.assign（口令会进地址栏）');
  assert.ok(seg.includes('unlock('), '扫码落地必须走 unlock()，与手输口令同一条路径');
});

test('PAIR-16 🔴 会话口令只在内存，锁定与改口令必须同步维护', () => {
  const main = read('src/main.ts');
  // 锁定时清
  assert.match(
    main.slice(main.indexOf('onLock: () =>')),
    /sessionPass\s*=\s*''/,
    '锁定时必须清会话口令（否则"退出锁定"是假的，配对码还能出）',
  );
  // 改口令后换新
  const chg = main.slice(main.indexOf('async function doChangePassphrase'));
  assert.match(
    chg,
    /sessionPass\s*=\s*next/,
    '改口令后必须更新会话口令（否则配对码里还是旧口令，别的设备必然解不开）',
  );
  // 🔴 绝不能落 localStorage / sessionStorage
  const setItem = main.match(/localStorage\.setItem\([^)]*sessionPass[^)]*\)/);
  assert.equal(setItem, null, '会话口令绝不能写 localStorage（那就等于长期窃取后门）');
  assert.ok(!/sessionPass/.test(read('src/scan/pair-link.ts')), '口令模块不该知道 main 的内存态');
});

test('PAIR-17 🔴 扫码结果判定必须只有一个收口（分叉迟早一边不认另一边）', () => {
  const main = read('src/main.ts');
  // 🔴 计数必须排除 import 行与函数定义行，否则这条钉会随代码挪位置而假红。
  //   真正要钉的是「**调用点**只有一个」：分叉的根源是同一个判定写了两遍。
  const calls = main
    .split('\n')
    .filter((l) => /parsePairLink\(/.test(l) && !/^\s*import\b/.test(l) && !/export function/.test(l));
  assert.equal(calls.length, 1, 'parsePairLink 的调用点必须只有一处（唯一收口），实得：' + JSON.stringify(calls));

  // 落地页 onScan 与顶栏 case 'scan' 必须走同一个 openScanner（不得各建一层取景框）
  const sc = main.split('openScanner()').length - 1;
  // 3 = 顶栏 case + 落地页 onScan + 函数定义内部那一次不算；这里精确定位两处调用
  const openCalls = main
    .split('\n')
    .filter((l) => /openScanner\(\)/.test(l) && !/^\s*function\s+openScanner/.test(l));
  assert.equal(openCalls.length, 2, '落地页与顶栏两处都应调 openScanner，实得 ' + openCalls.length);
  assert.ok(sc >= 3, 'openScanner 至少应出现三次（两处调用 + 定义）');
});

test('PAIR-18 🔴 重入锁必须是带过期的时间戳而不是布尔', () => {
  const src = read('src/main.ts');
  const seg = src.slice(src.indexOf('const SCAN_BUSY_MS'));
  assert.match(seg, /scanBusyAt\s*&&\s*now\s*-\s*scanBusyAt\s*<\s*SCAN_BUSY_MS/,
    '重入锁必须判过期（布尔锁在权限框永不返回时会把扫一扫永久锁死）');
  assert.match(seg, /SCAN_BUSY_MS\s*=\s*90_000|SCAN_BUSY_MS\s*=\s*90000/,
    '过期时间必须是 90 秒（老项目闸 R2 口径）');
});

test('PAIR-19 🔴 取景层必须在取消时收口并停流（否则叠层 + 摄像头常亮）', () => {
  const src = read('src/scan/layer.ts');
  // 停流
  assert.match(src, /for\s*\(const\s+t\s+of\s+stream\.getTracks\(\)\)\s*t\.stop\(\)/,
    'cleanup 必须停掉所有轨道（漏停 = 红色指示灯常亮）');
  // 拆层
  assert.match(src, /overlay\.parentNode\.removeChild\(overlay\)/, 'cleanup 必须拆浮层');
  // 取消/点遮罩/Esc 都收口
  assert.match(src, /cancel\.addEventListener\('click',\s*abortScan\)/, '取消键必须收口');
  assert.match(src, /e\.key === 'Escape'/, 'Esc 必须能关（桌面端没有手机返回键）');
  // 浮层 z-index 必须显式给（落地页遮罩是 z30）
  assert.match(src, /overlay\.style\.zIndex = '40'/, '取景层 z-index 必须显式给，否则被落地页压住');
});

test('PAIR-20 🔴 出码浮层的 document 级监听必须成对摘除', () => {
  const src = read('src/scan/panel.ts');
  assert.match(src, /addEventListener\('keydown',\s*onKey,\s*true\)/, '必须绑 Esc');
  assert.match(src, /removeEventListener\('keydown',\s*onKey,\s*true\)/,
    'Esc 监听必须摘除（残留监听会在浮层关掉后继续劫持按键）');
  assert.match(src, /removeEventListener\('visibilitychange',\s*onVis\)/,
    'visibilitychange 监听必须摘除');
  // 打开新层前先关旧层
  assert.match(src, /buildPairPanel[\s\S]{0,200}closePairPanel\(\)/,
    '开新层前必须先关旧层（否则连点两下叠两层，关掉上面那层后底下那层关不掉）');
  // 开关常亮要有开→秒关竞态守卫
  assert.match(src, /if\s*\(!isPanelOpen\(\)\s*\|\|\s*document\.hidden\)/,
    '申请常亮后必须检查弹窗是否已关（否则申请到的下一秒就被漏着不释放）');
});


test('PAIR-21 扫码反馈必须分流（落地页那条路写到了不存在的元素上）', () => {
  // 这条钉的是 e2e SCAN-E06 抓到的真缺陷：
  //   扫码反馈原先一律走 setFootStatus，而底栏 #foot 属于编辑器外壳，
  //   **在落地页根本不存在** —— 可选调用 setFootStatus?.() 静默跳过，
  //   于是「点扫码 → 相机起不来 → 提示写在不存在的地方」= 用户什么都没看到。
  //   静默跳过是这类 bug 最难查的形态：代码读起来完全合理，运行时零报错。
  const main = read('src/main.ts');
  assert.match(main, /function scanFeedback/, '必须有统一反馈口');
  const seg = main.slice(main.indexOf('function scanFeedback'), main.indexOf('function openScanner'));
  assert.match(seg, /currentPage === 'editor'/, '编辑器页走底栏');
  assert.match(seg, /landingScanMsg/, '落地页必须走专用提示位');

  // 落地页分支里不得再出现裸的 setFootStatus?.() 调用
  const at = seg.indexOf('landingScanMsg');
  assert.ok(at > 0, '未找到落地页提示位');
  const tail = seg.slice(at);
  const bare = tail.match(/setFootStatus\?\./g);
  assert.equal(bare, null, '落地页分支里不得调 setFootStatus?.（元素不存在时静默跳过）');

  // 自动收回必须带「文案仍是它才清」守卫（老项目红线 15）
  assert.match(tail, /w\.textContent === msg/, '自动收回必须带文案守卫，否则错误信息闪一下就没了');

  // pages.ts 必须真的有这个元素，且与输入校验位分开
  const pages = read('src/ui/pages.ts');
  assert.match(pages, /id="landingScanMsg"/, '落地页缺 #landingScanMsg');
  assert.ok(pages.includes('id="landingWarn"'), '输入校验提示位应保留');
});

test('PAIR-22 落地页扫码入口与顶栏必须同源（不得两处各建一层）', () => {
  const main = read('src/main.ts');
  const landing = main.slice(main.indexOf('function showLanding'), main.indexOf('function showHome'));
  assert.ok(landing.includes('openScanner()'), '落地页 onScan 必须调 openScanner');
  const topbar = main.slice(main.indexOf("case 'scan':"), main.indexOf("case 'qr':"));
  assert.ok(topbar.includes('openScanner()'), '顶栏 case scan 必须调 openScanner');
  // 两处都不得直接调 buildScanLayer（绕过重入锁 = 叠层）
  const callers = main
    .split('\n')
    .filter((l) => /buildScanLayer\(/.test(l) && !/^\s*import\b/.test(l));
  assert.equal(callers.length, 1, 'buildScanLayer 的调用点必须只有一处（重入锁的唯一入口）');
});

test('PAIR-23 解析器钩子只回显结构、不回显口令（不是泄露入口）', () => {
  const main = read('src/main.ts');
  const anchor = main.indexOf('__NOTESYNC_PARSE_PAIR__ = ');
  assert.ok(anchor > 0, '应存在正式钩子 __NOTESYNC_PARSE_PAIR__');
  // 🔴 切片要从钩子一路带到 resolveScan 收尾 —— 口令长度是在 resolveScan 里
  //   组装的，只截钩子那一行会漏检（这正是本条判据第一版假绿的原因）。
  // 🔴🔴 收尾定位**必须与行尾无关**：本文件(main.ts)在 Windows checkout 下是 CRLF,
  //   写死\n}\n 永远匹配不到 \r\n}\r\n ⇒ end === -1 ⇒ 这条判据恒红。
  //   （实测：它在我改动之前就已经红了，是判据自身的脆弱点，不是产品问题。）
  //   正解：用正则找**行首**的 }，两种行尾都能命中。
  const relEnd = /\r?\n\}/.exec(main.slice(main.indexOf('function resolveScan', anchor)));
  const end = relEnd ? main.indexOf('function resolveScan', anchor) + relEnd.index : -1;
  assert.ok(end > anchor, '应存在 resolveScan 且其收尾可定位');
  const seg = main.slice(anchor, end);
  assert.ok(seg.includes('passLen'), '应回显口令长度供 e2e 判往返');
  // 🔴 钩子的返回值里不得出现口令字段。
  //   用 includes 而不是正则：正则里的转义在多层 shell 传递中极易被吞，
  //   而本文件已经因此栽过一次（正则被改写成 /passphrase:/s*(...)/ 才发现）。
  assert.ok(
    !seg.includes('passphrase:'),
    '钩子返回值里不得有 passphrase 字段，只给 passLen',
  );
  // 形状对象里必须只有长度，不许把口令本体带出来
  assert.ok(seg.includes('passLen:'), '应回显 passLen');
  assert.ok(
    !seg.includes('passphrase: parsed') && !seg.includes('passphrase: raw'),
    '形状对象不得携带口令本体',
  );
});

/* ─────────────────────v1.12.0：扫码提速三条 ───────────────────── */

/**
 * 🔴 去掉注释再看。
 *
 * 本组要断言"预热被调用了""160ms 不在了"，而这两个词**都写在注释里**
 * （engine.ts 的 prefetchJsQrIdle 注释、layer.ts 的"原先有 setTimeout(...,160)"）。
 * 直接在原文里 includes 搜，**判据会恒绿** —— 匹配到的全是注释，
 * 把实现删了照样通过。这正是本仓反复栽过的坑（见 MEMORY.md「恒真断言 = 没有断言」）。
 */
const stripComments = (src) =>
  src
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');

test('ENGINE-10 🔴 v1.12.0 boot() 必须调 prefetchJsQrIdle（扫码前预拉 jsQR）', () => {
  // 动机：老项目 index.html:2877 有空闲预热，所以点扫码是热的；
  //   bj 此前零预热（loadJsQr 只在打开浮层时才调）⇒ 打开扫码先干等 127KB 下载。
  const main = stripComments(read('src/main.ts'));
  assert.ok(
    main.includes('prefetchJsQrIdle()'),
    'boot() 必须调用 prefetchJsQrIdle()，否则扫码仍要先等网络往返',
  );
  // 必须是**值导入**（真去调），不是 type-only import
  assert.ok(
    /import\s*\{[^}]*\bprefetchJsQrIdle\b[^}]*\}\s*from\s*['"]\.\/scan\/engine\.ts['"]/.test(main),
    '必须从 scan/engine.ts 值导入 prefetchJsQrIdle（type-only import 调不到）',
  );
});

test('ENGINE-11 🔴 预热必须双保险（rIC + setTimeout 兜底）且幂等', () => {
  const src = stripComments(read('src/scan/engine.ts'));
  // 移动内核（尤其国产 WebView）可能压根不调 requestIdleCallback，只靠 rIC 会永远不预热
  assert.ok(src.includes('requestIdleCallback'), '预热必须用 requestIdleCallback');
  assert.ok(src.includes('setTimeout'), '预热必须有 setTimeout 兜底（rIC 可能不来）');
  // 兜底那道必须在 rIC 分支之外：写成 if/else 就等于「rIC 存在时没有定时兜底」
  const fn = src.slice(src.indexOf('export function prefetchJsQrIdle'));
  assert.ok(fn.length > 0, '应存在 prefetchJsQrIdle');
  const rICAt = fn.indexOf('requestIdleCallback');
  const timeoutAt = fn.indexOf('setTimeout(go, 8000)');
  assert.ok(rICAt >= 0 && timeoutAt >= 0, '两处都应存在');
  assert.ok(timeoutAt > rICAt, '8000ms 兜底必须写在 rIC 分支之后（照抄老项目 index.html:2877 的顺序）');
  // 复用 loadJsQr 才有in-flight 去重，否则预热与扫码并发会拉两次 127KB
  assert.ok(fn.includes('loadJsQr'), '预热必须复用 loadJsQr（它自带 in-flight 去重）');
  // 预热失败不许 console.error —— 那时 loadJsQr 自己会打，重复打只干扰真排查
  assert.ok(!/console\.(error|warn)/.test(fn), '预热失败不许打日志（loadJsQr 自己会报）');
});

/**
 * 🔴 取出某个 `const NAME = (...) => {` 声明的**函数体原文**（已去注释）。
 *
 * 🔴🔴 为什么不能直接 `src.slice(src.indexOf('const hit ='))` 就完事：
 *   那样会把**后面所有函数**一起吃进来。本条判据首跑就是这么红的 ——
 *   `hit()` 本身干净，但切片一路带进了 `tick()` 里的
 *   `timer = window.setTimeout(...)`（那是帧循环的排队，不是命中停顿）。
 *   断言 `/setTimeout/` 于是对着一段不属于 hit 的代码开火 ⇒ **判据自己错了**。
 *
 * 🔴 不手写括号配对（正是本仓栽过的坑：缩进层级才是可靠信号）。
 *   锚点用「声明行」到**下一个同缩进声明行**之间的区间。
 *   本仓统一 2 空格缩进 ⇒ 同级声明行 = 缩进 4 空格且以`const `/`function ` 开头。
 */
const fnBody = (src, decl) => {
  const start = src.indexOf(decl);
  assert.ok(start >= 0, `应存在声明 ${decl}`);
  // 🔴 从**声明所在那一行的行首**切，不能用 indexOf 的落点：
  //   去注释会把声明前的缩进吃成空串，`slice(start)` 的首行缩进变成 0，
  //   下面的同缩进判定随之全失效（首跑就是这样：hit() 判据一直红）。
  const lineStart = src.lastIndexOf('\n', start) + 1;
  const lines = src.slice(lineStart).split('\n');
  const indent = (lines[0].match(/^\s*/) || [''])[0];
  const out = [lines[0]];
  for (let i = 1; i < lines.length; i += 1) {
    const l = lines[i];
    const ind = (l.match(/^\s*/) || [''])[0];
    // 同缩进（或更浅）的下一条声明/收尾 = 本函数结束
    if (ind.length <= indent.length && i > 1) {
      if (/^\s*(\}|const|let|function|async function)/.test(l)) break;
    }
    out.push(l);
  }
  return out.join('\n');
};

test('ENGINE-12 🔴 命中后不得再有 160ms 收场停顿（用户拍板，且不加开关）', () => {
  // 用户原话：扫码的判断标准是「扫到就立刻开」。
  const layer = stripComments(read('src/scan/layer.ts'));
  const fn = fnBody(layer, 'const hit = (value: string)');
  assert.ok(fn.includes('deps.onResult(value)'), 'hit() 必须调 onResult');
  // 关键：hit() 体内不得有任何 setTimeout（旧写法是 setTimeout(..., 160)）
  assert.ok(
    !/setTimeout/.test(fn),
    'hit() 内不得有 setTimeout —— 命中必须同步收场，否则每次扫码白付一次延迟',
  );
  // 反馈没丢：文案仍要写一次
  assert.ok(fn.includes('COPY.scanHit'), 'hit() 仍应写一次"已识别"文案（反馈不因去停顿而消失）');
});

test('ENGINE-13 🔴 命中收场顺序：先 cleanup 再 onResult', () => {
  // 顺序反了会怎样：onResult 触发上层跳转，而浮层还挂在 DOM 上 →
  // 跳转后残留一层遮罩，下一次点任何键都像"没反应"。
  const layer = stripComments(read('src/scan/layer.ts'));
  const fn = fnBody(layer, 'const hit = (value: string)');
  const iCleanup = fn.indexOf('cleanup()');
  const iResult = fn.indexOf('deps.onResult(value)');
  assert.ok(iCleanup >= 0 && iResult >= 0, '两者都要出现');
  assert.ok(iCleanup < iResult, '必须先 cleanup() 再 onResult()');
});

test('ENGINE-04d 🔴 layer.ts 必须真的用 tierLabel，不许自己比魔法数', () => {
  // 🔴🔴 上一版 ENGINE-04c **是假绿**（变异测试抓到：把 layer.ts 改回
  //   `tier > 560` 硬编码，38 条全过）。原因：04c 只测了 tierLabel 这个函数
  //   自己的对错，没钉住**调用方真的在用它**。
  //   这正是本仓的老坑：「断言某行为存在」与「断言某实现被使用」是两件事。
  //
  //   ⚠️ 必须去注释后再搜：layer.ts 的注释里就写着 `tier > 560`（解释历史），
  //   不去注释的话这条判据会恒绿。
  const layer = stripComments(read('src/scan/layer.ts'));
  assert.ok(
    layer.includes('tierLabel(tier)'),
    'layer.ts 必须调 tierLabel(tier)，不许自己复制 `tier > 560` 这类魔法数',
  );
  // 反向断言：实现里不得再出现裸的 560 分界
  assert.ok(
    !/tier\s*>\s*560/.test(layer),
    'layer.ts 不得再用硬编码 560 判断档位（TIER_FAST 已是 640，该判断恒真）',
  );
});
