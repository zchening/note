/**
 * 桌宠养成系统单测（PET 系列）
 *
 * 🔴🔴 这批判据保护的是一个**已经发生过、且不可能自查**的故障：
 *   bj 的 `PetState` 此前只有 `{adopted, asleep, last}` 三个字段，而老项目
 *   （index.html:11183 `petBlank()`）有 10 个。补字段是**破坏性**操作 ——
 *   老用户 localStorage 里躺着的就是那个三字段对象，读出来时缺 7 个字段。
 *   一旦 `readPet()` 不做逐字段兜底，症状是「打开 /pet 面板空白 / 数字显示
 *   `undefined`」，而且**只在老用户身上出现**（新用户走 blank() 看不出来），
 *   零报错、无法自愈。所以本批判据的第一优先级就是**老存档兼容**。
 *
 * 判据纪律（照本仓既有规矩）：
 *   1. 全部 **import 生产代码**（../src/egg/pet.ts），绝不把实现抄进测试 ——
 *      抄进来的断言恒真，等于没有断言。
 *   2. 断言"某段代码不存在"时，输入先去掉注释（注释里写着会假绿）。
 *   3. 每条"应该有"都配一条"不应该有"的反向断言，只写金标时
 *      "把金标和实现一起改"会让判据重新变绿。
 *
 * 老项目金标出处（逐字抄，非推理）：
 *   index.html:11183     petBlank() 的 10 个字段与缺省值
 *   index.html:11191     PET_TRINKET 16 件
 *   index.html:11217-24  petEat：`ate>9000?3:ate>3000?2:ate>600?1:0`，`if (st > PET.stage)`
 *   index.html:11281-89  petVend：满 16 格返回 -1，push 后升序
 *   index.html:11290-302 petTick：`since>7*day` 睡着、注释「永不死，只睡着」
 *   index.html:11296     睡着那一拍的 return（7 天那一次不再掷骰）
 *   index.html:11297     `if (since > 3 * 864e5) return;` 注释「睡过就不打扰」
 *   index.html:11298-301 roll<0.22 偷字 / <0.34 学舌 / <0.42 摆摊
 *   index.html:11326     形态名四档 + 「吃了 N 字 · 醒着 N 天 · 柜子 N / 16」
 *   index.html:11381-86  放归：只打 retiredAt，**不删任何数据**
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  PET_TRINKET,
  QUIET_AFTER_DAYS,
  RETIRE_KEEP_DAYS,
  SHELF_SIZE,
  SLEEP_AFTER_DAYS,
  adoptArchiveCode,
  adoptPet,
  daysSince,
  eatChars,
  parsePetArchiveCode,
  petArchiveCode,
  petArchiveLine,
  petTick,
  readPet,
  retirePet,
  sleepPet,
  stageForAte,
  stageName,
  vendTrinket,
  wakePet,
  withinRetireWindow,
  writePet,
} from '../src/egg/pet.ts';

const PET_KEY = 'notesync_bj_pet';
const DAY = 86_400_000;

/* ------------------------------------------------------------------ *
 * localStorage 垫片
 *
 * 🔴 必须在 import 被测模块**之前**装好 —— `eggBrowserStore()` 在**调用时**
 *   才去取 `window.localStorage`，所以先装再调即可。
 * ------------------------------------------------------------------ */
const mem = new Map();
globalThis.window = {
  localStorage: {
    getItem: (k) => (mem.has(k) ? mem.get(k) : null),
    setItem: (k, v) => void mem.set(k, String(v)),
    removeItem: (k) => void mem.delete(k),
  },
  setInterval: () => 0,
  clearInterval: () => {},
  setTimeout: () => 0,
};

/** 复位：清空存档，让每条判据从"未领养"起跑（判据之间不许互相污染）。 */
function reset() {
  mem.clear();
}

/** 直接往 localStorage 塞一份**原始**存档（用来模拟老用户的历史数据）。 */
function seedRaw(obj) {
  mem.set(PET_KEY, typeof obj === 'string' ? obj : JSON.stringify(obj));
}

/** 读存档里**原始**的 JSON（不经过 normalize），用来验证"有没有被写坏"。 */
function rawPet() {
  return JSON.parse(mem.get(PET_KEY) ?? 'null');
}

/** 用确定的随机序列驱动 vendTrinket / petTick。 */
function seqRand(values) {
  let i = 0;
  return () => values[i++ % values.length];
}

/* ================================================================== *
 * PET-01 四档形态的边界值
 *
 * 🔴🔴 这是本批最容易被"顺手改成 >=" 弄坏的一条。老项目 :11219 三处全是 `>`：
 *   `ate > 9000 ? 3 : ate > 3000 ? 2 : ate > 600 ? 1 : 0`
 *   差一个等号 ⇒ 恰好 600 字那天提前升档，而"恰好"正是用户会去数的那个数。
 *   8 个边界值（4 个阈值 × 恰好/刚过）全部钉死。
 * ================================================================== */
test('PET-01 🔴🔴 吃字升 4 档：阈值全是 `>` 不是 `>=`（老项目 :11219 逐字）', () => {
  // 恰好等于阈值 ⇒ **不**升档
  assert.equal(stageForAte(0), 0, '0 字 ⇒ 幼体');
  assert.equal(stageForAte(600), 0, '恰好 600 字仍是幼体（`600 > 600` 为假）');
  assert.equal(stageForAte(3000), 1, '恰好 3000 字仍是成体');
  assert.equal(stageForAte(9000), 2, '恰好 9000 字仍是胖体');
  // 刚过阈值 ⇒ 升档
  assert.equal(stageForAte(601), 1, '601 字 ⇒ 成体');
  assert.equal(stageForAte(3001), 2, '3001 字 ⇒ 胖体');
  assert.equal(stageForAte(9001), 3, '9001 字 ⇒ 长老');
  // 🔴 反向：绝不能出现第 5 档。老项目只有 4 档，ate 再大也是 3。
  assert.equal(stageForAte(1e9), 3, '再多的字也封顶在长老（老项目没有第 5 档）');
  // 🔴 反向：负数吃字不能把档位打到 -1（stageName 会返回 undefined）
  assert.equal(stageForAte(-100), 0, '负数不应产出负档位');
});

test('PET-02 🔴🔴 形态名四档逐字（老项目 :11326 `["幼体","成体","胖体","长老"]`）', () => {
  assert.equal(stageName(0), '幼体');
  assert.equal(stageName(1), '成体');
  assert.equal(stageName(2), '胖体');
  assert.equal(stageName(3), '长老');
  // 🔴 反向：越界回退「幼体」而不是 undefined —— 存档被写坏时面板上
  //   出现字面量 "undefined" 是最难自查的一类显示 bug。
  assert.equal(stageName(9), '幼体', '越界档位不许渲染出 undefined');
  assert.equal(stageName(-1), '幼体', '负档位不许渲染出 undefined');
});

test('PET-03 🔴🔴 吃字升档走真实状态机，且形态**只升不降**（老项目 :11220 `if (st > PET.stage)`）', () => {
  reset();
  adoptPet();

  // 逐档爬升，每档都断言"落盘的那个数"
  eatChars(601);
  assert.equal(rawPet().stage, 1, '601 字后落盘 stage 必须是 1');
  assert.equal(rawPet().ate, 601, 'ate 要真累加，不是只记档位');

  eatChars(2400); // 累计 3001
  assert.equal(rawPet().stage, 2, '累计 3001 字 ⇒ 胖体');

  eatChars(6000); // 累计 9001
  assert.equal(rawPet().stage, 3, '累计 9001 字 ⇒ 长老');

  // 🔴 反向：档位封顶后继续吃，stage 不变，ate 继续涨
  eatChars(10_000);
  assert.equal(rawPet().stage, 3, '封顶后不许出现第 4 档');
  assert.equal(rawPet().ate, 601 + 2400 + 6000 + 10_000, 'ate 必须继续累加');

  // 🔴🔴 只升不降：把 ate 弄小（模拟换养成吃字少的档案）后 stage 不许掉
  writePet({ ...readPet(), ate: 10 });
  const s = eatChars(1);
  assert.equal(s.stage, 3, '形态只升不降（老项目 `st > PET.stage` 才写）');
  assert.equal(s.ate, 11, 'ate 仍然按累加走');
});

/* ================================================================== *
 * PET-04 老存档兼容（**本批最高优先级**）
 *
 * 🔴🔴🔴 场景：用户升级前就领养过，localStorage 里是
 *   `{"adopted":true,"asleep":false,"last":1700000000000}` —— 只有 3 个字段。
 *   判据必须证明：读出来不崩、7 个新字段全被补成合法默认值、
 *   **且原来那 3 个字段一个都没丢**（尤其 adopted —— 丢了螃蟹就消失）。
 * ================================================================== */
test('PET-04 🔴🔴🔴 三字段老存档读出来能补默认值、且不崩（本批最高优先级）', () => {
  reset();
  // 🔴 逐字模拟 bj 升级前的真实存档形状：只有 adopted/asleep/last
  seedRaw({ adopted: true, asleep: false, last: 1700000000000 });

  let s;
  // 🔴 这一行就是"不崩"的全部含义：任何一个字段没兜住，这里就抛。
  assert.doesNotThrow(() => {
    s = readPet();
  }, '三字段老存档读出来抛异常 ⇒ 老用户的螃蟹变空壳/白屏');

  // 原有 3 字段必须**原样保留**（丢 adopted ⇒ 顶栏螃蟹再也不出现）
  assert.equal(s.adopted, true, 'adopted 必须保住（丢了螃蟹就消失，零报错）');
  assert.equal(s.asleep, false, 'asleep 必须保住');
  assert.equal(s.last, 1700000000000, 'last 必须保住（否则 7 天守卫判错，螃蟹刚访问就睡着）');

  // 7 个新字段补成合法默认值
  assert.equal(s.stage, 0, '缺 stage ⇒ 补 0（幼体）');
  assert.equal(s.ate, 0, '缺 ate ⇒ 补 0（面板不能显示 undefined 字）');
  assert.deepEqual(s.shelf, [], '缺 shelf ⇒ 补空数组（不能是 undefined，.length 会抛）');
  assert.equal(s.retiredAt, 0, '缺 retiredAt ⇒ 补 0（= 没放归过）');
  assert.equal(s.talked, 0, '缺 talked ⇒ 补 0');
  assert.ok(s.born > 0, '缺 born ⇒ 补一个正数（days 的基准，给 0 会算出天文数字天数）');
  assert.ok(Number.isInteger(s.days) && s.days >= 1, 'days 必须是 ≥1 的整数（时钟超前不许算出 0/负）');

  // 🔴🔴 面板那行字必须能真的拼出来（不是 "吃了 undefined 字"）
  const line = petArchiveLine(s);
  assert.equal(line, '吃了 0 字 · 醒着 1 天 · 柜子 0 / 16');
});

test('PET-05 🔴🔴 存档被写坏时逐字段兜底（老项目 Object.assign 没有类型校验，这里更严）', () => {
  reset();
  // 老项目 `petLoad()` 是 `Object.assign(petBlank(), o)` —— **不校验类型**。
  //   所以老存档里完全可能躺着 `stage: "3"`（字符串）、`shelf: "abc"` 等。
  //   照抄的后果：形态名取 `STAGE_NAMES["3"]` ⇒ undefined（面板显示 undefined），
  //   `shelf` 是字符串时 `.length` 能过但 `.indexOf(i)` 语义全错。
  seedRaw({
    adopted: true,
    stage: '3',
    ate: -50,
    shelf: 'abc',
    born: 'yesterday',
    last: 1,
    talked: null,
    retiredAt: -1,
  });
  const s = readPet();
  assert.equal(s.stage, 0, 'string stage ⇒ 回退 0（不许 undefined）');
  assert.equal(s.ate, 0, '负数 ate ⇒ 回退 0');
  assert.deepEqual(s.shelf, [], '非数组 shelf ⇒ 回退空数组');
  assert.ok(s.born > 0, '非数字 born ⇒ 回退 now');
  assert.equal(s.talked, 0, 'null talked ⇒ 回退 0');
  assert.equal(s.retiredAt, 0, '负数 retiredAt ⇒ 回退 0');

  // 🔴 反向：合法值不许被"顺手"清掉
  reset();
  seedRaw({ adopted: true, stage: 2, ate: 5000, shelf: [0, 3, 7], born: 1700000000000, talked: 9 });
  const ok = readPet();
  assert.equal(ok.stage, 2, '合法 stage 必须保住');
  assert.equal(ok.ate, 5000, '合法 ate 必须保住');
  assert.deepEqual(ok.shelf, [0, 3, 7], '合法 shelf 必须原样保住');
  assert.equal(ok.born, 1700000000000, '合法 born 必须保住');
  assert.equal(ok.talked, 9, '合法 talked 必须保住');
});

test('PET-06 🔴🔴 柜子去重 / 升序 / 剔越界（`shelf.length` 是面板「柜子 N/16」与摆摊判据）', () => {
  reset();
  // 重复项会让「柜子 17 / 16」这种自相矛盾的数字出现；
  // 未升序会让同一柜子在面板上显示成另一批收藏品（名字按索引取）。
  seedRaw({ adopted: true, shelf: [7, 0, 7, 3, 0, 99, -1, 2.5, 15] });
  const s = readPet();
  assert.deepEqual(s.shelf, [0, 3, 7, 15], '去重 + 剔越界 + 升序');
  assert.ok(s.shelf.length <= SHELF_SIZE, '柜子格数不得超过 16');
});

/* ================================================================== *
 * PET-07 7 天睡但不死
 *
 * 🔴🔴 老项目 :11296 注释原文「永不死，只睡着」。这条不变量最容易被
 *   "顺手做成养成游戏" 的人破坏（加个 died / 死亡态 / 墓碑）。
 *   判据从**结构**上钉它：PetState 里根本没有死亡字段，
 *   睡过之后 stage/ate/shelf 一个都不许少。
 * ================================================================== */
test('PET-07 🔴🔴 7 天后 asleep=true，但**绝不**变成死亡态（老项目 :11296 逐字）', () => {
  reset();
  adoptPet();
  // 养到长老 + 柜子有件，验证"睡着"不吃掉任何养成数据
  seedRaw({
    adopted: true,
    stage: 2,
    ate: 5000,
    shelf: [1, 4],
    born: Date.now() - 30 * DAY,
    last: Date.now() - 8 * DAY, // 8 天没碰 ⇒ 超过 7 天
    asleep: false,
    retiredAt: 0,
    talked: 0,
  });

  // mountPet 内部走的就是 withSleep；这里用 petTick 触发同一拍
  const t = petTick(seqRand([0.5]));
  assert.equal(t.slept, true, '8 天没碰 ⇒ 这一拍必须睡着');

  const s = readPet();
  assert.equal(s.asleep, true, '7 天判据：asleep 必须为 true');

  // 🔴🔴🔴 「不死」的三重钉：
  //   1) 结构上就没有死亡字段
  assert.equal(
    'dead' in s || 'died' in s || 'death' in s || 'grave' in s,
    false,
    'PetState 里不许出现任何死亡字段 —— 老项目原文是「永不死，只睡着」',
  );
  //   2) 睡着不吃养成数据
  assert.equal(s.stage, 2, '睡着后形态必须保住（睡着不是死亡）');
  assert.equal(s.ate, 5000, '睡着后吃字必须保住');
  assert.deepEqual(s.shelf, [1, 4], '睡着后柜子必须保住');
  assert.equal(s.adopted, true, '睡着后仍然是"领养中"（没被注销）');
  //   3) 能被唤醒回到原状
  assert.equal(wakePet(), true, '点一下必须能唤醒');
  const w = readPet();
  assert.equal(w.asleep, false, '唤醒后 asleep=false');
  assert.equal(w.stage, 2, '唤醒后形态还在');
  assert.deepEqual(w.shelf, [1, 4], '唤醒后柜子还在');
});

test('PET-08 🔴🔴 睡着那一拍只睡不掷骰（老项目 :11296 的 return，:11297 另有 3 天守卫）', () => {
  reset();
  seedRaw({ adopted: true, last: Date.now() - 10 * DAY, asleep: false, shelf: [] });
  // 7 天 + 摆摊档（0.35~0.42）：老项目这一拍 return，**不会**带回 trinket
  const t = petTick(seqRand([0.35]));
  assert.equal(t.slept, true, '这一拍是睡着');
  assert.equal(t.got, -1, '睡着那一次不许同时掷骰带回 trinket（老项目 :11296 return）');
  assert.deepEqual(readPet().shelf, [], '柜子不该在睡着那一次被动过');

  // 🔴 反向：8 天 > 7 天 但 3 天守卫先命中时，两条都 return ⇒ 什么都不发生
  reset();
  seedRaw({ adopted: true, last: Date.now() - 4 * DAY, asleep: false, shelf: [] });
  const t2 = petTick(seqRand([0.35]));
  assert.equal(t2.slept, false, '4 天 < 7 天 ⇒ 还不睡');
  assert.equal(t2.got, -1, `>${QUIET_AFTER_DAYS} 天不动（老项目 :11297「睡过就不打扰」），但 4 天是档内`);

  // 🔴🔴 3 天守卫的真实作用：>3 天 ⇒ 即使掷中摆摊档也不发
  reset();
  seedRaw({ adopted: true, last: Date.now() - 5 * DAY, asleep: false, shelf: [] });
  const t3 = petTick(seqRand([0.35]));
  assert.equal(t3.got, -1, '5 天没碰 ⇒ 落进 3 天守卫，不摆摊（这不是"死了"）');
  assert.equal(readPet().asleep, false, '3~7 天之间只是"不打扰"，不是睡着');
});

/* ================================================================== *
 * PET-09 16 格柜子
 * ================================================================== */
test('PET-09 🔴🔴 柜子 16 格、摆摊带回不重复的件、集齐即封顶（老项目 :11281-89 逐字）', () => {
  reset();
  adoptPet();
  assert.equal(SHELF_SIZE, 16, '老项目柜子 16 格');

  // 16 件收藏品逐字（老项目 :11191）
  assert.equal(PET_TRINKET.length, 16, '必须正好 16 件');
  assert.equal(PET_TRINKET[0], '橡皮鸭');
  assert.equal(PET_TRINKET[15], '月亮碎片');
  assert.equal(
    PET_TRINKET.join('|'),
    '橡皮鸭|半块砖|1987 硬币|迷你恐龙|会响的勺|空白便签|亮的那颗|断齿梳子|' +
      '三叶草|旧车票|玻璃珠|铁环|贝壳|小螺丝|火柴盒|月亮碎片',
    '16 件的名字与顺序逐字（顺序即索引，存错索引面板就显示错件）',
  );

  // 逐格塞满：每次都必须是**还没有的**那一格
  for (let i = 0; i < 16; i++) {
    const r = vendTrinket(seqRand([0]));
    assert.ok(r.got >= 0, `第 ${i + 1} 次摆摊必须带回一件`);
    assert.equal(r.got, i, 'rand=0 时依次取最小空格 ⇒ 索引应逐一递增');
    assert.equal(new Set(r.shelf).size, r.shelf.length, '柜子里不许有重复件');
  }
  assert.equal(readPet().shelf.length, 16, '集齐 16 格');

  // 🔴 老项目 :11282 `if (PET.shelf.length >= 16) return -1` —— 集齐即封顶
  const over = vendTrinket(seqRand([0]));
  assert.equal(over.got, -1, '集齐后不再发新件（老项目返回 -1）');
  assert.equal(readPet().shelf.length, 16, '集齐后柜子不许变成 17 格');
});

test('PET-10 🔴🔴 每日事件的摆摊概率窗口是老项目那条 else-if 链（0.22~0.42，非 0.34~0.42）', () => {
  reset();
  adoptPet();
  // 🔴🔴 老项目 :11299-11301 是 **else-if 链**，不是三段互斥区间：
  //     if      (roll < 0.22) petSteal();
  //     else if (roll < 0.34 && petEcho.length) petBubble(...);
  //     else if (roll < 0.42) petVend();
  //   `petEcho` 为空时中间那支为假 ⇒ 0.22~0.34 **落穿**到摆摊支。
  //   ⇒ 没复制过时摆摊概率是 20%，复制过才是 8%。
  //   写成"三段互斥"会让老用户（从没复制过）**少发一半 trinket**，
  //   症状只是柜子永远集不齐，不报错不崩溃 —— 极难归因。
  const fresh = () => seedRaw({ adopted: true, last: Date.now(), asleep: false, shelf: [], born: Date.now() });

  // 未复制过（petEcho 空）⇒ 0.22~0.42 全是摆摊档
  fresh();
  assert.ok(petTick(seqRand([0.41]), false).got >= 0, 'roll=0.41 ⇒ 摆摊');
  fresh();
  assert.ok(petTick(seqRand([0.25]), false).got >= 0, '🔴 roll=0.25 落穿学舌支 ⇒ 仍摆摊（老项目语义）');
  fresh();
  assert.equal(petTick(seqRand([0.1]), false).got, -1, 'roll=0.1 落在偷字档 ⇒ 不摆摊（未移植，但空档保留）');
  fresh();
  assert.equal(petTick(seqRand([0.42]), false).got, -1, 'roll=0.42 不 < 0.42 ⇒ 不摆摊');
  fresh();
  assert.equal(petTick(seqRand([0.99]), false).got, -1, 'roll=0.99 ⇒ 不摆摊');

  // 复制过（petEcho 非空）⇒ 0.22~0.34 真的被学舌吃掉，只剩 0.34~0.42
  fresh();
  assert.equal(petTick(seqRand([0.25]), true).got, -1, '有 echo 时 roll=0.25 被学舌吃掉 ⇒ 不摆摊');
  fresh();
  assert.ok(petTick(seqRand([0.41]), true).got >= 0, '有 echo 时 roll=0.41 仍摆摊');
});

/* ================================================================== *
 * PET-11 手动睡 / 唤醒 / 放归
 * ================================================================== */
test('PET-11 🔴🔴 「让它去睡」必须同时刷 last（老项目 :11352 注释）', () => {
  reset();
  adoptPet();
  // 🔴🔴 只写 asleep 而不刷 last 是老项目**明确注释过**的坑：
  //   「睡眠必须刷 last，否则 petMount 的『3 天内』守卫会把它当场叫回来」。
  //   症状是"点了让它去睡，刷新一下又自己醒了"。
  const before = Date.now();
  const s = sleepPet();
  assert.equal(s.asleep, true, '点了要去睡');
  assert.ok(
    s.last >= before,
    '必须刷 last（不刷 ⇒ 3 天/7 天守卫仍按旧 last 判，当场叫回来）',
  );
  // 再跑一拍 tick：不该被守卫立刻翻回醒着
  const t = petTick(seqRand([0.35]));
  assert.equal(t.slept, false, '睡完这一拍不该自己醒（last 已刷新）');
  assert.equal(readPet().asleep, true, '仍然是睡着的');
});

test('PET-12 🔴🔴 放归只打 retiredAt，**不删任何养成数据**（老项目 :11381-86 逐字）', () => {
  reset();
  adoptPet();
  seedRaw({
    adopted: true,
    stage: 3,
    ate: 12000,
    shelf: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15],
    born: Date.now() - 40 * DAY,
    last: Date.now(),
    asleep: false,
    talked: 4,
  });
  const s = retirePet();
  assert.ok(s.retiredAt > 0, '放归必须打 retiredAt 时间戳');
  assert.equal(s.asleep, true, '放归同时睡着（老项目同款）');
  // 🔴🔴🔴 不删数据 —— 面板写的是「档案保留 30 天」，删了就变成骗人
  assert.equal(s.stage, 3, '放归不许掉形态');
  assert.equal(s.ate, 12000, '放归不许清吃字计数');
  assert.equal(s.shelf.length, 16, '🔴 放归不许清空柜子（16 格集齐是用户攒出来的，不可恢复）');
  assert.equal(s.talked, 4, '放归不许清 talked');

  // 30 天保留窗口
  const now = s.retiredAt;
  assert.equal(withinRetireWindow(s.retiredAt, now), true, '刚放归 ⇒ 在保留期内');
  assert.equal(
    withinRetireWindow(s.retiredAt, now + (RETIRE_KEEP_DAYS - 1) * DAY),
    true,
    '第 29 天仍在保留期内',
  );
  assert.equal(
    withinRetireWindow(s.retiredAt, now + (RETIRE_KEEP_DAYS + 1) * DAY),
    false,
    '超过 30 天才算过窗',
  );
  // 🔴 反向：没放归过（retiredAt=0）不许被判成"在保留期内"
  assert.equal(withinRetireWindow(0, now), false, 'retiredAt=0 ⇒ 没放归过，不在保留期');
});

test('PET-13 🔴🔴 领养幂等且**绝不重置养成数据**（老项目 :11348 逐字）', () => {
  reset();
  seedRaw({ adopted: true, stage: 2, ate: 5000, shelf: [2, 9], born: 1700000000000 });
  adoptPet();
  const s = readPet();
  // 🔴🔴 如果 adoptPet 写成 `writePet(blank())`，二次访问 /pet 会把
  //   「养了 300 天的胖体」清零回幼体 —— 最难自查的一类数据丢失。
  assert.equal(s.stage, 2, '重复领养不许把形态清回幼体');
  assert.equal(s.ate, 5000, '重复领养不许清吃字计数');
  assert.deepEqual(s.shelf, [2, 9], '重复领养不许清空柜子');
  assert.equal(s.born, 1700000000000, '重复领养不许重置 born（天数会归 1）');
});

/* ================================================================== *
 * PET-14 档案行文案
 * ================================================================== */
test('PET-14 🔴🔴 档案行逐字：吃了 N 字 · 醒着 N 天 · 柜子 N / 16（老项目 :11326）', () => {
  const s = { adopted: true, stage: 0, ate: 12345, days: 42, shelf: [0, 1, 2], born: 1, last: 0, asleep: false, retiredAt: 0, talked: 0 };
  // 🔴 千分位是 toLocaleString('en-US') ⇒ 12,345 带逗号
  assert.equal(petArchiveLine(s), '吃了 12,345 字 · 醒着 42 天 · 柜子 3 / 16');
  // 🔴 反向：分隔符是老项目的 ' · '（中间点两侧各**恰好一格**）。
  //   写成 '·' 或 '  ·  ' 都与老项目不符 —— 这行字是逐字比对的金标。
  assert.ok(!petArchiveLine(s).includes('  '), '不许出现连续空格（分隔符两侧恰好一格）');
  assert.equal(petArchiveLine(s).split(' · ').length, 3, '三段用 " · " 隔开（恰两处分隔符）');
  // 边界：0 字 0 天 0 格
  const z = { ...s, ate: 0, days: 1, shelf: [] };
  assert.equal(petArchiveLine(z), '吃了 0 字 · 醒着 1 天 · 柜子 0 / 16');
});

test('PET-15 🔴 days 按 born 现算且 clamp ≥1（老项目 :11319 v9.3.2 逐字）', () => {
  const now = Date.now();
  assert.equal(daysSince(now, now), 1, '当天领养 ⇒ 1 天');
  assert.equal(daysSince(now - 9.9 * DAY, now), 10, '9.9 天 ⇒ 10 天（1+floor）');
  assert.equal(daysSince(now - 40 * DAY, now), 41);
  // 🔴🔴 时钟超前（另一台设备时钟快 / born 被写成未来）不许算出 0 或负数 ——
  //   老项目 :11319 注释原文「clamp≥1 防某端时钟超前算出 0/负」。
  assert.equal(daysSince(now + 5 * DAY, now), 1, 'born 在未来 ⇒ clamp 到 1，不许是 0/负');
  assert.equal(daysSince(now + 999 * DAY, now), 1, 'born 远在未来也 clamp 到 1');

  // 🔴 反向：存档里的 days 字段**不信**，一律按 born 重算
  //   （老项目同款：多端 born 同步过，days 存本地会漂）
  reset();
  seedRaw({ adopted: true, born: Date.now() - 10 * DAY, days: 999 });
  assert.equal(readPet().days, 11, '存档里的 days 必须被 born 重算覆盖（防跨端漂移）');
});

/* ================================================================== *
 * PET-16 换养（档案串）
 * ================================================================== */
test('PET-16 🔴🔴 换养：接管档案、且剥掉零宽字符（老项目 v9.3.1 :11473）', () => {
  reset();
  seedRaw({ adopted: true, stage: 0, ate: 10, shelf: [0], born: Date.now() });
  const code = petArchiveCode(readPet());
  assert.ok(code.startsWith('ns2:'), '档案串带自有前缀');
  // 🔴🔴 linkify 断行会在长串里插 U+200B，老项目专门加了一行剥离
  //   （:11473 注释：粘进笔记再复制出来「永远格式不对」）。
  //   少了这一行，用户粘的内容肉眼完全正确却被判格式错误，离原因十万八千里。
  const dirty = '' + code + '';
  const r = adoptArchiveCode(dirty);
  assert.ok(r.state, '带零宽字符的档案串必须能解析（老项目 v9.3.1 同款修复）');
  assert.equal(readPet().stage, 0);

  // 换养：本地那只被**接管**
  reset();
  seedRaw({ adopted: true, stage: 0, ate: 0, shelf: [], born: Date.now() });
  const donor = parsePetArchiveCode('ns2:stage=3;ate=12000;days=40;born=1700000000000;talked=2;shelf=0,1,2');
  assert.ok(donor.state, '供体档案串应可解析');
  adoptArchiveCode('ns2:stage=3;ate=12000;days=40;born=1700000000000;talked=2;shelf=0,1,2');
  const s = readPet();
  assert.equal(s.stage, 3, '换养后形态按新档案接管');
  assert.equal(s.ate, 12000, '换养后吃字按新档案接管');
  assert.deepEqual(s.shelf, [0, 1, 2], '换养后柜子按新档案接管');
  assert.equal(s.adopted, true, '换养来的宠物是已领养状态');
});

test('PET-17 🔴🔴 换养：坏档案串必须报失败而不是静默把档案写空', () => {
  reset();
  seedRaw({ adopted: true, stage: 2, ate: 5000, shelf: [1, 2], born: Date.now() });
  // 🔴🔴 这些输入如果被"宽容处理"，会把用户养了半年的档案清成幼体且无法撤销。
  const bad = [
    ['', 'empty'],
    ['   ', 'empty'],
    ['hello world', 'format'],
    ['ns1:id=ABCDEFGH;key=12345678', 'format'], // 老项目的云端护照形状，本项目不认
    ['ns2:stage=99;ate=1;born=1700000000000', 'shape'],
    ['ns2:stage=abc;ate=1;born=1700000000000', 'shape'],
    ['ns2:stage=1;ate=-5;born=1700000000000', 'shape'],
    ['ns2:stage=1;ate=5;born=0', 'shape'],
  ];
  for (const [input, err] of bad) {
    const r = adoptArchiveCode(input);
    assert.equal(r.state, undefined, `坏档案串 ${JSON.stringify(input)} 必须解析失败`);
    assert.equal(r.err, err, `错误原因应为 ${err}，实际 ${r.err}`);
  }
  // 🔴 关键：失败之后**本机档案必须原封不动**
  const s = readPet();
  assert.equal(s.stage, 2, '换养失败不许动本机形态');
  assert.equal(s.ate, 5000, '换养失败不许动本机吃字');
  assert.deepEqual(s.shelf, [1, 2], '换养失败不许动本机柜子');
});

/* ================================================================== *
 * PET-18 面板 UI 与接线（源码层结构判据）
 *
 * 🔴 判据纪律：读源码前**必须去注释**。本文件 pet.ts 的注释里大量出现
 *   "7 天"、"sleeping"、"stage" 这些词（还专门解释了为什么是 `>` 不是 `>=`），
 *   用裸 indexOf 会被注释命中 ⇒ 判据假绿。
 * ================================================================== */
test('PET-18 🔴🔴 面板三按钮 + 档案行必须真在 /pet 页面里（去注释后判）', () => {
  const code = readFileSync(new URL('../src/egg/games.ts', import.meta.url), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^[ \t]*\/\/.*$/gm, '');
  const pet = code.slice(code.indexOf('export function petGame'));
  assert.ok(pet.length > 0, 'games.ts 里找不到 petGame');
  // 老项目 :11337 三个按钮：让它去睡 / 放归（档案保留 30 天）/ 换养这只
  // 🔴 类名逐字取老项目：面板按钮是 ns-pet-sleep / ns-pet-free，
  //   换养与复制是 ns-swap-go / ns-pet-copy（:11332/:11353）。
  for (const cls of ['ns-pet-sleep', 'ns-pet-free', 'ns-swap-go', 'ns-pet-copy']) {
    assert.match(pet, new RegExp(cls.replace(/-/g, '\\-')), `面板缺 ${cls} 按钮`);
  }
  // 🔴 16 格柜子必须由**常量**驱动，不能写死 16 —— 两处漂移就会出现「柜子 3 / 17」
  assert.match(pet, /i < SHELF_SIZE/, '柜子循环必须用 SHELF_SIZE');
  assert.match(pet, /stageName\(s\.stage\)/, '形态名必须走 stageName（不许直接索引数组）');
  assert.match(pet, /petArchiveLine\(s\)/, '档案行必须走 petArchiveLine');
  // 🔴 反向：空实现（只挂一只孤零零的大螃蟹、无养成面板）必须判红。
  //   这条是"面板真的做出来了"的正面证据 —— 少了它，把 dom() 清空只留
  //   一只螃蟹，上面那几条 find 也照样能过（类名可以写在死代码里）。
  assert.match(pet, /ns-shelf/, '面板必须有 16 格柜子容器');
  assert.match(pet, /PET_TRINKET\[i\]/, '已集齐的格子必须按索引取名字（存名字会与索引语义脱钩）');
  assert.match(pet, /'ns-sh'/, '单格类名逐字（老项目 :11345 `mk("div", "ns-sh" + …)`）');
  // 🔴 反向：形态名不许被直接索引数组（旧写法 STAGE_NAMES[p.stage] 越界即 undefined）
  assert.doesNotMatch(pet, /STAGE_NAMES\[/, '形态名必须走 stageName()，不许裸索引数组');
});

test('PET-19 🔴🔴 每日事件定时器常量与老项目一致（45 秒 / 3 天 / 7 天）', () => {
  // 老项目 :11303 `setInterval(petTick, 45000)`
  assert.equal(TICK_EVERY_MS_EXPECTED, 45_000, '老项目 :11303 是 45 秒');
  assert.equal(SLEEP_AFTER_DAYS, 7, '老项目 :11296 `since > 7*day`');
  assert.equal(QUIET_AFTER_DAYS, 3, '老项目 :11297 `since > 3*864e5`');
  assert.equal(RETIRE_KEEP_DAYS, 30, '面板文案「档案保留 30 天」');
});

/** 从 pet.ts 抠出 TICK_EVERY_MS 的字面值（不能用 import 再断言自己 —— 那是恒真）。 */
const TICK_EVERY_MS_EXPECTED = (() => {
  const src = readFileSync(new URL('../src/egg/pet.ts', import.meta.url), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^[ \t]*\/\/.*$/gm, '');
  const m = src.match(/TICK_EVERY_MS\s*=\s*([0-9_]+)/);
  assert.ok(m, 'pet.ts 里找不到 TICK_EVERY_MS');
  return Number(m[1].replace(/_/g, ''));
})();
