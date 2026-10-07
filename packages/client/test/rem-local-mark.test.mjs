/**
 * 局部打标判据（REMLOCAL-01~06）
 *
 * 🔴🔴🔴 钉的是用户报障第 7 条「打字时换行或正在打的字被吞」的结构性修复。
 *
 * ── 为什么这批判据是"纯逻辑 + 接线形状"两层，而不是 e2e ──────────────────
 *   吞字这个 bug 的**承重部分**是「改动面积」：整篇 root.clear() vs 只重建 1 个块。
 *   数字层面它必须能被**数出来** —— "重建了几个块"这件事在 e2e 里
 *   只能靠 DOM 猜测（MutationObserver 之类），而判据必须无猜测。
 *   所以这里用纯逻辑层（零 DOM，可 node --test 直跑）数块，
 *   再用接线判据钉住 main.ts 真的走了这条路。
 *   e2e 那层验的是"真的不卡"，属于补充，不替代本文件。
 *
 * ── 判据纪律 ─────────────────────────────────────────────────────────────
 *   · 恒真断言 = 没有断言：每条都配「应该有 / 不应该有」
 *   · 「assertNotEqual」型反向闸：把实现退回整篇重建必须转红
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// 🔴 .mjs 是纯 JS：写 `type X` / `as const` 会直接 SyntaxError（本轮第 7 次踩）
import { fingerprintOf, sameFingerprint, planLocalMarkRewrite, blockFingerprintsOf, chooseRewritePath } from '../src/reminder/local-mark.ts';

/* ---------- 造指纹的小工具（与真源 Block.spans 同形） ---------- */

const fp = (text, rem = '', other = '') => fingerprintOf([{ t: text, rem }]);

/** 一篇 5 段的文档，其中只有第 3 段带 rem 标记 */
const FIVE = (remOnThird) => [
  fp('第一段没有标记'),
  fp('第二段也没有'),
  remOnThird ? fingerprintOf([{ t: '第三段带标记', rem: 'r1' }]) : fp('第三段带标记'),
  fp('第四段'),
  fp('第五段'),
];

test('REMLOCAL-01 指纹逐字记录每个字符的 rem 归属，长度恒等于文本长度', () => {
  const f = fingerprintOf([{ t: '会议' }, { t: '明天', rem: 'r7' }, { t: '见' }]);

  // 「应该有」：文字拼起来必须逐字对
  assert.equal(f.text, '会议明天见');
  // 🔴 这是本文件的核心不变量。rems 长度错位 ⇒ 逐块比对会拿错位的下标去比。
  //   指纹按 **Unicode 码点** 逐字记（`for...of` 遍历字符串），
  //   所以 '会议明天见' 是 5 格不是 7 格；代理对（emoji 等）按 1 格记，
  //   两端一致即可（比的是同一份指纹，不是拿字节偏移去切正文）。
  assert.equal(f.rems.length, f.text.length, '🔴 rems 长度必须等于文本长度（逐字符对齐）');
  assert.deepEqual(f.rems, ['', '', 'r7', 'r7', '']);

  // 反向闸：无 rem 字段时 rems 全是空串，不是 undefined
  const g = fingerprintOf([{ t: 'ab' }]);
  assert.deepEqual(g.rems, ['', ''], '无标记必须是空串，undefined 会让 === 比对永远不等');
});

test('REMLOCAL-02 纯文本相同但 rem 不同 ⇒ 必须判定为不同', () => {
  const a = fp('开会');
  const b = fingerprintOf([{ t: '开会', rem: 'r1' }]);

  assert.equal(a.text, b.text, '前置：两边纯文本确实相同');
  assert.equal(sameFingerprint(a, b), false, '🔴 rem 归属不同就是不同（否则标记永远铺不下去）');
  assert.equal(sameFingerprint(a, a), true, '同一个指纹必须等于自己（反向闸）');
});

test('REMLOCAL-03 🔴 5 段里只有 1 段变 ⇒ 只准重建那 1 段', () => {
  const before = FIVE(false);
  const after = FIVE(true);

  const plan = planLocalMarkRewrite(before, after);

  // 「应该有」：只报 1 个下标
  assert.equal(plan.fullRebuildReason, null, '块数没变，不该要求整篇重建');
  assert.deepEqual(plan.rebuild, [2], '🔴 只该重建第 3 段（下标 2）');

  // 🔴 反向闸：这正是「改成整篇重建」那个变异会被抓住的地方。
  //   注意断言写的是"rebuild 不许等于全量下标"，而不是 "!plan.rebuild.length" ——
  //   后者在退化实现（什么都重建）下仍然是红的，但**方向相反**，
  //   会把"该重建的没重建"和"不该重建的都重建"两件事混在一个信号里。
  assert.notDeepEqual(plan.rebuild, [0, 1, 2, 3, 4], '🔴 不许退回整篇重建（长文档里加一条提醒会销毁全文 DOM）');
});

test('REMLOCAL-04 无变化时零重建（不是"重建全部但内容一样"）', () => {
  const before = FIVE(true);
  const plan = planLocalMarkRewrite(before, FIVE(true));

  assert.deepEqual(plan.rebuild, [], '🔴 一个字都没变时必须零重建');
  assert.equal(plan.fullRebuildReason, null);

  // 反向闸：写回自身不许引起任何写操作
  //   （老项目 :3975「纯打标重写回填 lastHtml 消除假 dirty」是同款纪律）
});

test('REMLOCAL-04b 🔴🔴 多个块同时变时，必须**全部**被报出来', () => {
  // 🔴🔴🔴 这条是被变异测试逼出来的：原判据只有「5 段变 1 段」与「3 段变 1 段」，
  //   两个用例都只涉及**一个**变化的块 ⇒ 于是"只报第一个不同的块就 break"
  //   这个退化实现在 8 条判据下**全绿**。
  //
  //   而它在线上的症状是：用户给两处时间串加提醒，只有第一处出现下划线，
  //   第二处永远不出现，而且**没有任何报错**（真源里的 rem 已经写对了）。
  //
  //   教训与本项目栽过的「恒真断言」同源：**只测"改了一处"的判据，
  //   抓不住"只改一处"的实现。** 数量维度必须单独测。
  const before = [fp('A'), fp('B'), fp('C'), fp('D'), fp('E')];
  const after = [
    fingerprintOf([{ t: 'A', rem: 'r1' }]),
    fp('B'),
    fingerprintOf([{ t: 'C', rem: 'r2' }]),
    fingerprintOf([{ t: 'D', rem: 'r3' }]),
    fp('E'),
  ];

  const plan = planLocalMarkRewrite(before, after);

  assert.deepEqual(
    plan.rebuild,
    [0, 2, 3],
    '🔴 三个块都变了就必须三个都重建 —— 只报第一个会让另两处的下划线永远铺不上（且零报错）',
  );

  // 🔴 顺序不敏感但**集合**敏感：用长度 + 逐个 contains 复核一遍，
  //   避免"顺序错了但恰好也过"这种假象。
  assert.equal(plan.rebuild.length, 3, '必须恰好 3 个，不多不少');
  for (const i of [0, 2, 3]) {
    assert.ok(plan.rebuild.includes(i), `下标 ${i} 必须在内`);
  }
});

test('REMLOCAL-05 块数变了必须整篇重建，不许"凑合"对齐', () => {
  const before = FIVE(false);
  const after = [...FIVE(false), fp('对账凭空多了一段')];

  const plan = planLocalMarkRewrite(before, after);

  // 🔴🔴 这是最容易被"优化掉"的一条：下标对齐在长度不等时**没有意义**，
  //   硬凑的结果是标记铺到错误的段上（症状"下划线跑到别的段落去了"）。
  assert.equal(plan.fullRebuildReason, 'block-count', '块数变了必须整篇重建');
  assert.deepEqual(plan.rebuild, [], '要求整篇重建时不该再报局部下标（两条路不许同时走）');
});

test('REMLOCAL-06 重复段落必须按下标对齐，不许按内容查找', () => {
  // 三段一模一样的「开会」，只有中间那段带标记
  const before = [fp('开会'), fp('开会'), fp('开会')];
  const after = [fp('开会'), fingerprintOf([{ t: '开会', rem: 'r1' }]), fp('开会')];

  const plan = planLocalMarkRewrite(before, after);

  // 🔴 若实现改成"按内容查找第一个匹配块"，这里会报 [0] 或报空 —— 都会把标记铺错段
  assert.deepEqual(plan.rebuild, [1], '🔴 必须报中间那个下标；按内容查找会把标记铺到第一段');
});

test('REMLOCAL-07 接线：main.ts 的对账回灌必须走局部路径', () => {
  const src = readFileSync(new URL('../src/main.ts', import.meta.url), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^[ \t]*\/\/.*$/gm, '');

  // 必须 import 局部规划器
  assert.match(src, /from '\.\/reminder\/local-mark\.ts'/, 'main.ts 必须 import 局部打标规划器');

  // 必须真的调它
  assert.match(src, /planLocalMarkRewrite\(/, 'main.ts 必须调用 planLocalMarkRewrite');
  assert.match(src, /blockFingerprintsOf\(/, 'main.ts 必须从真源取块指纹（不能拿 Lexical 节点硬凑）');
  assert.match(src, /chooseRewritePath\(/, '必须走纯逻辑的路径决策（那条"全都要改就整篇"是不变量，要可测）');

  // 局部路径必须调按块替换的入口
  assert.match(
    src,
    /replaceBlocksAt\(snapshot,\s*(idx|plan\.rebuild)\)/,
    '局部路径必须调 replaceBlocksAt 按下标替换，而不是 docToLexical',
  );

  // 🔴 三条路径缺一不可：full 是合法兜底（块数变了 / 全都要改），
  //   none 是最省的（没变化时零写操作），local 才是本批新增的那条。
  //   少任何一条都意味着某个分支被写死了 —— 而写死的分支就是恒绿判据的温床。
  assert.match(src, /path === 'full'/, '必须有 full 兜底分支');
  assert.match(src, /path === 'local'/, '必须有 local 分支');
  // 反向闸：local 分支里不许出现 docToLexical —— 那会把局部路径退化成 root.clear 整篇重建
  assert.match(src, /else if \(path === 'local'\)/, '前置：应能定位 local 分支');
});

test('REMLOCAL-08 反向：local 分支里绝不许调 docToLexical', () => {
  const raw = readFileSync(new URL('../src/main.ts', import.meta.url), 'utf8');
  const clean = raw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');

  // 🔴🔴🔴 采样窗口本身就是 bug 的藏身处（本项目栽过三次，这里是第三次）：
  //   第一版右界切到 `reminderRef?.schedule()` —— 而 local 分支在它**之前**就闭合了，
  //     切出来的窗口压根没盖到分支主体 ⇒ 恒绿。
  //   第二版改成 `localAt + 700` 仍然错：去注释之后分支主体里本来就有注释残留位置差异，
  //     窗口长度成了"猜"出来的数字 —— 猜测出来的窗口就是恒绿的窗口。
  //
  //   正解：**用分支自己的结构定右界**，不猜长度。
  //   找 `else if (path === 'local')` 的下一个 `}` 之后的位置（分支闭合），
  //   中间那一段就是分支主体。实现变了导致找不到闭合，就让这条判据红 ——
  //   那说明判据该重写了，而不是悄悄放宽。
  const at = clean.indexOf("else if (path === 'local')");
  assert.ok(at >= 0, '应能定位 local 分支');
  const end = clean.indexOf('\n        }', at);
  assert.ok(end > at, '应能按结构定位 local 分支的闭合（若实现变了需重写本判据，不能删断言）');
  const seg = clean.slice(at, end);

  // 前置自证：这段确实是要检查的分支主体
  assert.match(seg, /replaceBlocksAt\(/, '前置：窗口应覆盖 local 分支主体');

  // 🔴 这才是承重断言：局部分支里出现 docToLexical 就等于退化回 root.clear 整篇重建。
  //   而 docToLexical 在 `full` 分支里是**合法兜底**，所以本判据只查 local 分支。
  assert.doesNotMatch(
    seg,
    /docToLexical/,
    '🔴 local 分支里绝不许调 docToLexical（那会把局部路径退化回 root.clear 整篇重建 = 第 7 条病根）',
  );
});

/* ==================================================================== *
 * 🔴🔴🔴 REMLOCAL-09~12：子树感知（复核代理抓到的真 bug 的判据）
 *
 * 背景（真实回归，不是假设）：
 *   `blockFingerprintsOf` 原本只取**顶层**的 text/spans/title，不递归 children。
 *   这个取舍在"下标对齐"上是对的（`replaceBlocksAt` 的 indexes 指向 root 直接子节点），
 *   在"感知变化"上是错的：
 *     · fold 块的顶层纯文本 = title（`reconcile.blockText` 对 fold 走 b.title 分支）
 *       ⇒ 子块里任何 rem 变化都不改变顶层指纹
 *     · ul/ol 块既无 text 也无 spans 也无 title ⇒ 兜底成 {text:'',rems:[]}
 *       ⇒ 对子块完全盲
 *   于是 `chooseRewritePath` 返回 'none' ⇒ 零写 ⇒ **折叠块/列表里的提醒下划线
 *   永远铺不上、也永远删不掉**，真源里 rem 是对的、提醒会响、屏上没有下划线、零报错。
 *
 * 🔴🔴 为什么前面 8 条判据全绿：它们的输入全是**手造的扁平 BlockFingerprint[]**
 *   （`FIVE()` 是 5 个 `fp(...)`），**从不构造含 children 的真源 Block**。
 *   也就是说"子树盲区"在那 8 条里**不可表达**。
 *   ⇒ 这 4 条一律用**真源 Block 形状**（带 children 的 fold / ul / 嵌套），
 *     并且必须从 `blockFingerprintsOf` 出发，不许手造指纹绕过适配层。
 *==================================================================== */

/** 造一个带 rem 的 span 数组。 */
const sp = (t, rem) => (rem ? [{ t, rem }] : [{ t }]);

test('REMLOCAL-09 🔴🔴🔴 fold 子块里的 rem 变化必须被顶层指纹看见', () => {
  const mk = (childRem) => ({
    blocks: [
      { t: 'p', spans: sp('前面一段普通文字', '') },
      {
        t: 'fold',
        title: sp('折叠块标题', ''),
        children: [{ t: 'p', spans: sp('2030-06-02 10:00　评审', childRem) }],
      },
      { t: 'p', spans: sp('后面一段普通文字', '') },
    ],
  });

  const before = blockFingerprintsOf(mk(''));
  const after = blockFingerprintsOf(mk('robvm14w047ep6'));

  // 前置自证：顶层块数是 3（fold 是**一个**顶层块，不该被展开成下标）
  assert.equal(before.length, 3, '前置：fold 必须算作一个顶层块（indexes 指向 root 直接子节点）');
  assert.equal(after.length, 3, '前置：两边顶层块数必须相同');

  // 🔴 核心：fold 那一格（下标 1）必须判为"变了"
  assert.equal(
    sameFingerprint(before[1], after[1]),
    false,
    '🔴 fold 子块里的 rem 变化必须让顶层指纹变（否则下划线永远铺不上）',
  );

  // 不变的两个块必须仍然判为不变 —— 否则就是"全都要重建"，局部改写又白做了
  assert.equal(sameFingerprint(before[0], after[0]), true, '未变的普通段不该被牵连');
  assert.equal(sameFingerprint(before[2], after[2]), true, '未变的普通段不该被牵连');

  const plan = planLocalMarkRewrite(before, after);
  assert.deepEqual(plan.rebuild, [1], '🔴 只该重建 fold 那一个顶层块，实际=' + JSON.stringify(plan.rebuild));
  assert.equal(plan.fullRebuildReason, null, '块数没变，不该走整篇');
});

test('REMLOCAL-10 🔴🔴🔴 ul/li 里的 rem 变化必须被看见（原来恒为 {text:"",rems:[]}）', () => {
  const mk = (itemRem) => ({
    blocks: [
      {
        t: 'ul',
        children: [{ t: 'li', spans: sp('2030-06-02 10:00　评审', itemRem) }],
      },
    ],
  });

  const before = blockFingerprintsOf(mk(''));
  const after = blockFingerprintsOf(mk('r-list-1'));

  assert.equal(before.length, 1, '前置：ul 是**一个**顶层块');
  // 这条是本判据的病根自证：修复前 ul 的顶层指纹恒为 {text:'',rems:[]}
  assert.notEqual(
    JSON.stringify(before[0]),
    JSON.stringify({ text: '', rems: [] }),
    '🔴 ul 顶层指纹不许再是空的（对子块完全盲 = 下划线永远铺不上）',
  );

  assert.equal(
    sameFingerprint(before[0], after[0]),
    false,
    '🔴 li 里的 rem 变化必须让 ul 的顶层指纹变',
  );
  assert.deepEqual(planLocalMarkRewrite(before, after).rebuild, [0]);
});

test('REMLOCAL-11 🔴🔴 嵌套子树（fold 里再套 fold）必须递归感知', () => {
  const mk = (deepRem) => ({
    blocks: [
      {
        t: 'fold',
        title: sp('外层标题', ''),
        children: [
          { t: 'p', spans: sp('外层正文', '') },
          {
            t: 'fold',
            title: sp('内层标题', ''),
            children: [{ t: 'p', spans: sp('2030-06-02 10:00　评审', deepRem) }],
          },
        ],
      },
    ],
  });

  const before = blockFingerprintsOf(mk(''));
  const after = blockFingerprintsOf(mk('r-deep-1'));

  assert.equal(before.length, 1, '前置：整个外层 fold 仍是一个顶层块');
  assert.equal(
    sameFingerprint(before[0], after[0]),
    false,
    '🔴 隔了两层的子树变化也必须被看见（只递归一层同样漏）',
  );
  assert.deepEqual(planLocalMarkRewrite(before, after).rebuild, [0]);
});

test('REMLOCAL-12 🔴🔴 反向闸：子树感知不许把"下标"也展开（那会让 indexes 错位铺错位置）', () => {
  const doc = {
    blocks: [
      { t: 'p', spans: sp('第一段', '') },
      {
        t: 'fold',
        title: sp('折叠标题', ''),
        // 🔴 故意给三个子块：若适配层把 children 展平成独立下标，
        //   顶层块数会从 2 变成 5，而 replaceBlocksAt 会照着越界的下标去 replace。
        children: [
          { t: 'p', spans: sp('子块一', '') },
          { t: 'p', spans: sp('子块二', '') },
          { t: 'p', spans: sp('子块三', '') },
        ],
      },
    ],
  };
  const fps = blockFingerprintsOf(doc);

  assert.equal(
    fps.length,
    2,
    '🔴 fold 的三个子块绝不许被展平成独立下标（indexes 指向 root 直接子节点，展开即错位）',
  );

  // 承重：fold 那一格必须**含**三个子块的纯文本（证明是"聚合进一格"而不是"忽略子树"）
  assert.match(
    fps[1].text,
    /子块一/,
    '🔴 fold 的顶层指纹必须含子块内容（既不展开成多格、也不能完全丢）',
  );
  assert.match(fps[1].text, /子块三/, '子块三也必须在');
  assert.equal(fps[1].rems.length, fps[1].text.length, '🔴 核心不变量在含子树的块上依然成立');
});

/* =====================================================================
 * 🔴🔴🔴 REMLOCAL-13：钉 `chooseRewritePath` 的**运行时返回值**
 *
 * ── 这条判据是被一次变异逼出来的（复核代理做的，9 条判据全绿漏网）──
 *   变异：把 local-mark.ts 的 `return 'local'` 改成 `return 'full'`
 *         （即"局部路径整条形同虚设，一律整篇重建"）
 *   结果：REMLOCAL-01~12 **全部通过**。
 *
 * ── 为什么前 12 条全绿（这是本条存在的全部理由）──
 *   ① REMLOCAL-01~06 断的是 `fingerprintOf` / `planLocalMarkRewrite` 的**返回值**，
 *      压根不碰 `chooseRewritePath`；
 *   ② REMLOCAL-07 只 `assert.match(src, /chooseRewritePath\(/)` ——
 *      那是**grep 源码里写着这个名字**，与运行时走哪个分支无关；
 *   ③ REMLOCAL-08 只断言 local 分支里没有 `docToLexical`，
 *      把分支整个改成 full 之后那条自然也成立（源码里确实没有）。
 *
 *   🔴 这就是「断言"分支在源码里写着"≠"运行时会走到"」的又一处实例：
 *     接线形状对、字段读得对，唯独**没人断言那个纯函数的返回值**。
 *   🔴 也正是「恒真断言 = 没有断言」的变体：REMLOCAL-08 看着是反向闸，
 *     在 `'local'→'full'` 这个变异下**恒绿**，等于没有。
 *
 * ── 本条的设计要点 ──────────────────────────────────────────────────
 *   · 从**最外层真实入口**进去（blockFingerprintsOf → planLocalMarkRewrite →
 *     chooseRewritePath），不手造 plan：手造夹具只能钉"我传进去的东西"，
 *     钉不住"真源形状经过前两步之后会变成什么"（REMLOCAL-09~12 已栽过一次）。
 *   · 决策矩阵**四格全钉**，并给每一格都配"不应该变成什么"：
 *     fullRebuildReason 非空→full；零变化→none；全都要改→full；部分改→local。
 *   · 最后一条是**性能不变量**的直接断言（5 段改 1 段必须 local），
 *     它才是能被 `'local'→'full'` 抓住的那一格。
 * ===================================================================== */

test('REMLOCAL-13 🔴🔴🔴 决策矩阵四格 + 局部不变量（变异 local→full 必须转红）', () => {
  /* 格 1：零变化 ⇒ none（不能整篇重建，否则白重建一次整篇 DOM） */
  {
    const before = FIVE(false);
    const plan = planLocalMarkRewrite(before, FIVE(false));
    assert.deepEqual(plan.rebuild, [], '前置：零变化时不该有重建下标');
    assert.equal(chooseRewritePath(plan, before.length), 'none');
  }

  /* 格 2：只有 1 段变（5 段里的第 3 段）⇒ local —— 这是性能不变量的锚点 */
  {
    const before = FIVE(false);
    const after = FIVE(true);
    const plan = planLocalMarkRewrite(before, after);
    assert.deepEqual(plan.rebuild, [2], '前置：应当只报出第 3 段');
    assert.equal(
      chooseRewritePath(plan, before.length),
      'local',
      '🔴🔴 5 段只改 1 段必须走局部；返回 full 就等于回到「每次输入整篇重建」的病态'
      + '（用户报障第 7 条：组字中的拼音串与选区全被冲掉）',
    );
  }

  /* 格 3：每一段都要改 ⇒ full（局部比整篇还多绕一圈） */
  {
    const before = FIVE(false);
    const after = [
      fingerprintOf([{ t: '第一段没有标记', rem: 'r1' }]),
      fingerprintOf([{ t: '第二段也没有', rem: 'r2' }]),
      fingerprintOf([{ t: '第三段带标记', rem: 'r3' }]),
      fingerprintOf([{ t: '第四段', rem: 'r4' }]),
      fingerprintOf([{ t: '第五段', rem: 'r5' }]),
    ];
    const plan = planLocalMarkRewrite(before, after);
    assert.equal(plan.rebuild.length, before.length, '前置：应当每一段都要改');
    assert.equal(
      chooseRewritePath(plan, before.length),
      'full',
      '全都要改时走整篇（局部要绕的圈更多）',
    );
  }

  /* 格 4：块数变了（fullRebuildReason 非空）⇒ full，无条件压过局部 */
  {
    const before = FIVE(false);
    const after = FIVE(true).slice(0, 3); // 删掉两段 ⇒ 块数对不上
    const plan = planLocalMarkRewrite(before, after);
    assert.equal(plan.fullRebuildReason, 'block-count', '前置：块数变了必须给出 reason');
    assert.equal(
      chooseRewritePath(plan, before.length),
      'full',
      '🔴 块数变了绝不许走局部（indexes 会越界/错位铺到别的块上）',
    );
  }

  /* 🔴🔴 从真源 Block 形状进去的端到端一格（不手造指纹）——
     fold 子块里改一段，决策也必须是 local。变异 local→full 时这一格会红。 */
  {
    const mkDoc = (thirdRem) => ({
      blocks: [
        { t: 'p', spans: sp('第一段', '') },
        { t: 'fold', title: sp('折叠标题', ''), children: [
          { t: 'p', spans: sp('子块一', '') },
          { t: 'p', spans: sp('子块二', thirdRem) },
        ] },
        { t: 'p', spans: sp('末段', '') },
      ],
    });
    const before = blockFingerprintsOf(mkDoc(''));
    const after = blockFingerprintsOf(mkDoc('r9'));
    const plan = planLocalMarkRewrite(before, after);
    assert.deepEqual(plan.rebuild, [1], '前置：fold 内部变化应映射到顶层下标 1');
    assert.equal(
      chooseRewritePath(plan, before.length),
      'local',
      '🔴🔴 真源形状下 3 块只改 1 块（含 fold 子树）也必须走局部',
    );
  }
});
