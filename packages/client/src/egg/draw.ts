/**
 * 刷新开奖卡 —— 「刷新一下，掉一张卡」（老项目 v9.2.0）
 *
 * 🔴🔴 本文件治的病是「静默失效」：开奖逻辑挂错/ 判据写错时，
 *   **界面完全正常**（刷新照刷、雨照下、气泡照冒），只是卡永远不出来。
 *   用户嘴里是"刷新了没反应"，任何"功能在跑"的检查都发现不了它。
 *   所以下面两处判据各有专门的单测钉死，见test/draw-card.test.mjs 的 DR-03 / DR-04。
 *
 * 🔴🔴🔴 逐条对应老项目（www/index.html，纯 JS）：
 *   :5646-5650  档位设计说明 + 让位规则
 *   :5651      NS_DRAW_KEY / NS_DRAW_SEEN← **本项目改键名，见下方 STORAGE 说明**
 *   :5652      NS_DRAW_W  [['r',70],['sr',20],['ssr',8],['ur',2]]
 *   :5653      NS_DRAW_HOLD  { r:2500, sr:3200, ssr:4500, ur:0 }
 *   :5654-5659 NS_DRAW_POOL 四档文案池（本项目逐条抄，条数见 DR-02）
 *   :5660-5661 nsDrawSeen / nsDrawSaveSeen
 *   :5662-5666 nsDrawTier   权重轮盘 0..99
 *   :5667-5679 nsDrawIdx    同档内不重复抽 + 一轮用完洗牌重开
 *   :5680-5691 nsDrawRoll   抽一次并落袋
 *   :5692-5709 nsDrawBusy   🔴 让位判据（两个空壳不同判据，见下）
 *   :5710-5730 nsDrawConsume 🔴🔴 让位而不吞奖（见下）
 *   :5731-5751 nsDrawShow   渲染 + 停留 + 点击收
 *   :5756-5768 刷新按钮：抽卡必须落在 reload **之前**
 *   :3479/:3511 解锁成功后兑现上一拍的开奖
 *   :11004    同泳道让位：确认层弹出前先撤掉开奖卡（本项目在 egg/ask.ts:135）
 *
 * ── STORAGE：键名改了 ────────────────────────────────────────────────
 *   老项目用 `notesync_draw` / `notesync_draw_seen`。本项目全库用
 *   `notesync_bj_` 前缀（见 fav/favs.ts:24FAVS_KEY 的同款理由：
 *   新旧项目数据必须完全独立，共用键会互相污染）。故：
 *     notesync_draw      → notesync_bj_draw
 *     notesync_draw_seen → notesync_bj_draw_seen
 *
 * ── 落库只有两样、都不含文案 ─────────────────────────────────────────
 *   sessionStorage 存本次抽中的 {t 档位, i 序号}；localStorage 存每档已用序号数组。
 *   序号只在同档池内有效 ⇒ 池子改版后越界即视为无效、直接静默不弹（老项目 :5649/:5717）。
 *
 * ── 为什么不写进egg/layer.ts 或 main.ts ──────────────────────────────
 *   egg/ 下已是「一功能一文件」的体例（ask / codex / fx / pet / shell / sound），
 *   开奖卡自成一体（自带存储、自带让位判据、自带渲染），塞进 main.ts 会
 *   让171KB 的main.ts 再长一截且不可单测。ask.ts 那种「被动的让位一行」
 *   留在 ask.ts 不动，本模块只负责自己怎么建、怎么等、怎么兑。
 */

/**
 * 本次抽中的券（sessionStorage）。老项目 `NS_DRAW_KEY = 'notesync_draw'`（:5651）。
 * 🔴 改键名：本项目全库用 `notesync_bj_` 前缀（见 fav/favs.ts:24 的同款理由 ——
 *   新旧项目数据完全独立是用户明确要求，共用键会互相污染）。
 */
export const EGG_DRAW_KEY = 'notesync_bj_draw';
/** 每档已用序号数组（localStorage）。老项目 `NS_DRAW_SEEN = 'notesync_draw_seen'`（:5651）。 */
export const EGG_DRAW_SEEN_KEY = 'notesync_bj_draw_seen';

/* ───────────────────────── 档位与权重 ───────────────────────── */

/** 四档稀有度。老项目 NS_DRAW_W（:5652）**逐字**。合计 100。 */
export const DRAW_W: readonly (readonly [string, number])[] = [
  ['r', 70],
  ['sr', 20],
  ['ssr', 8],
  ['ur', 2],
];

/**
 * 各档停留时长（ms）。老项目 NS_DRAW_HOLD（:5653）**逐字**。
 *
 * 🔴 `ur: 0` 是拍板结果：「不自动消失，点一下收」。
 *   实现里靠 `hold > 0` 才挂定时器，所以 0 = 永不自动关。
 *   写成 `hold ?? 2500` 或 `if (hold)` 之外的兜底都会让 UR 卡 4.5 秒自己消失。
 */
export const DRAW_HOLD: Readonly<Record<string, number>> = {
  r: 2500,
  sr: 3200,
  ssr: 4500,
  ur: 0,
};

/* ───────────────────────── 文案池（老项目 :5654-5659逐条抄） ───────────────────────── */

/**
 * 四档文案池。**逐条抄自老项目 `www/index.html:5655-5658`**，
 * 由脚本从源码机械提取（按 `','` 切分），未手工改动任何一个字。
 *
 * 🔴 真实条数：**r 150 / sr 100 / ssr 70 / ur 30 = 350 条**。
 *   （任务书里写的「420+」与源码不符 —— 老项目就是 350 条，见 DR-02 判据。
 *   条数是数据不是判据，别为它写死具体数字，钉下界就够。）
 *
 * 🔴 文案一律走 textContent 渲染（老项目 :5737 的纪律），绝不 innerHTML。
 */
export const DRAW_POOL: Readonly<Record<string, readonly string[]>> = {
  // prettier-ignore
    r: [
    '字落下，就别管它',
    '这里不催你',
    '先记下来，回头再说',
    '一句就够了',
    '别急着写完',
    '空页也是记录',
    '标题也算进度',
    '写三行，够今晚用',
    '慢慢写，不急',
    '记一半，交给忘性',
    '不用整齐，能看懂就行',
    '今天的先留今天',
    '先占住这页',
    '空白不算浪费',
    '想清楚了再改',
    '写完就去忙',
    '顺手一笔就好',
    '一句顶三句',
    '先记结论',
    '细节会自己回来',
    '想起来就补一行',
    '别删，以后再看',
    '记完这条就收手',
    '剩下的路上想',
    '别改标点，先存',
    '想到人就记一笔',
    '记完就放下',
    '从头写太难，从中段写',
    '时间也记一下',
    '谁说的也记一下',
    '关键词就行',
    '缩写也算字',
    '记错的地方最诚实',
    '短一点更好找',
    '先搁这儿',
    '这事明天还重要',
    '不急着想明白',
    '写下来就不用想了',
    '一句一句攒',
    '留着对比，别急着删',
    '空一行，回头填',
    '写完这件再想下一件',
    '不用写给别人看',
    '写得乱，说明快',
    '快比好看重要',
    '先占个位',
    '值得记一下',
    '记一半也行',
    '后半段自己会长出来',
    '这句今天够用',
    '标题可以后起',
    '起了标题也算写了',
    '数字不容易记错',
    '记住的感觉不可靠',
    '不写才发现自己不知道',
    '一句话压住一件事',
    '记完心就定了',
    '轮廓先立住',
    '细节以后补',
    '这条以后会用到',
    '以后再说以后',
    '存疑也是一种记法',
    '存着不丢人',
    '想不出就先空着',
    '空着也是答案',
    '记一笔，省三遍',
    '等三天再删',
    '一行也算写过',
    '进度不挑字数',
    '写短点，明天看得完',
    '动词最耐放',
    '形容词晚点加',
    '晚点加也来得及',
    '这页记完就关',
    '关掉不等于结束',
    '整理是另一种拖延',
    '拖一会儿也没事',
    '最烦的那件先落下来',
    '落下来就轻一点',
    '今晚不用写完',
    '漂亮是以后的事',
    '事实放得住',
    '看法晚点写更准',
    '回头接得上',
    '接得上就行',
    '太长回头懒得看',
    '长有长的记法',
    '分几段来记',
    '分段好找',
    '开头那句最清楚',
    '后面会想起来',
    '想不起来就留白',
    '留白也是内容',
    '收不了尾也算写完',
    '停在哪儿都行',
    '写到哪里算哪里',
    '落一句就睡',
    '小事最经放',
    '经放的还是小事',
    '会重来一遍的先落',
    '重来太贵',
    '存住就不丢',
    '不丢就有底',
    '有底就能想别的',
    '想别的也要记',
    '记下来才想得清',
    '想不清也记',
    '记成什么样都行',
    '重写的先存原版',
    '存完再重写',
    '重写也是记',
    '记两遍不嫌多',
    '多记一遍少想一遍',
    '一个词能带出一段',
    '带不出来就算了',
    '算了也记一笔',
    '当线索留着',
    '线索不用完整',
    '不完整也能用',
    '疑问比答案耐看',
    '答案会过期',
    '疑问不会',
    '下一件也会来',
    '来一件记一件',
    '记一条，少一条',
    '少一件轻一点',
    '轻一点就够今天',
    '今天不必轻很多',
    '到这里也算记了',
    '半句也是句子',
    '不必写满',
    '先记一个词',
    '记到这里就行',
    '随手一记最经看',
    '完整是后来的事',
    '趁还记得，落一句',
    '现在有用就够了',
    '不用解释给谁听',
    '写了就是进展',
    '进展不分大小',
    '小的也算',
    '最要紧的那个先落',
    '落下来就跑不掉',
    '跑不掉的才要记',
    '大事自然会记住',
    '慌是因为没落下来',
    '落一句，压住慌',
    '先写最刺眼的那个',
    '刺眼的通常是重点',
    '重点不用写全',
  ],
  sr: [
    '密文比承诺可靠',
    '服务器不懂中文',
    '同步只是搬运，不评判',
    '端到端加密，包括对你自己',
    '你删掉的，服务器从没见过',
    '网址即钥匙，别弄丢',
    '这句话只有你读过',
    '没有账号，也就没有忘记密码',
    '换机不用登录，登录要设密码',
    '这台机器不记事，它只存字',
    '备份在另一台，想法在这台',
    '回收站今天很安静',
    '提醒会响，这里不响',
    '加密的好处是可以写得难看点',
    '服务器拿到的是乱码',
    '它不解密，也解不了',
    '盐存在你这边',
    '云端只存结果',
    '密钥不在云上，云帮不了你',
    '忘了口令，我也没办法',
    '我这边没有找回按钮',
    '同步会冲突，不会替你选',
    '冲突时两条都留着',
    '它不删旧的那条，除非你删',
    '离线也能写，联网才走',
    '断网的时候它不催',
    '页脚那个点是它的话',
    '它说得很少',
    '收藏只在你这台机器上',
    '收藏不进云端',
    '待办会响，是你让它响',
    '云端只认识时间，不认识内容',
    '图片是例外，它走图床',
    '图片不加密，这条得记住',
    '图床的链接谁拿到都能看',
    '笔记名是明文，正文不是',
    '网址公开，名字别写心事',
    '它知道你有几条，不知道写了什么',
    '它连你写没写都不知道',
    '密文会变长，因为字多了',
    '加密不防你截图',
    '也不防你转发',
    '它防别人，不防你自己',
    '这页的钥匙只有一把',
    '钥匙写在纸上，纸得收好',
    '护照那串字，丢了没人能补',
    '补就要账号，就不是它了',
    '备份二维码是另一把钥匙',
    '扫码那一下，收藏换了台机器',
    '换机不搬家，搬家靠那一格码',
    '同步是异步的，所以会晚一点到',
    '晚一点到，不是没到',
    '页脚的连接中是它在找服务器',
    '找到之后它就不说话了',
    '不说话不代表没在传',
    '传完也不告诉你，除非出错',
    '出错才响，是它唯一的礼貌',
    '服务器只见密文，是字面意思',
    '它没有后台能读你的字',
    '没有客服能替你看一眼',
    '所以也没人误读',
    '没人误读，也没人救你',
    '口令长一点，机器就笨一点',
    '机器越笨，你越自由',
    '加密的代价是丢了没人帮',
    '没人帮你，也没人查你',
    '这两句是一件事',
    '一件事的两面',
    '这页存在两台机器上',
    '第三份在云端，是乱码',
    '乱码也是备份',
    '备份不必可读',
    '可读的备份不算备份',
    '所以它宁可看不懂',
    '看不懂才睡得着',
    '你写的字，服务器一个不认识',
    '它只认识长度和时间',
    '长度会出卖你，时间也会',
    '出卖不到内容',
    '出卖不到内容的出卖，可以忍',
    '刷新只是再传一遍',
    '传一遍不多问',
    '不多问是这台机器的礼貌',
    '不问为什么写',
    '不问写给谁',
    '完没写完它不管',
    '没写完也存',
    '存下来的半句也是半句',
    '半句比没有强',
    '这条笔记的网址只有你知道',
    '知道网址的人也只能打开锁屏页',
    '打开锁屏页也看不见字',
    '看不见字，就还是你的',
    '你的笔记，你的口令，你的麻烦',
    '三件事归你，谁都不掺手',
    '不掺手是设计，不是疏忽',
    '疏忽不会写进说明里',
    '说明里写了，所以是设计',
    '端到端的意思是两头都是你',
    '中间那一段，谁都不算知情',
  ],
  ssr: [
    '这页会比你记得久',
    '有些笔记只为证明那天存在',
    '很多年后这行字还会亮着',
    '你删掉的比留下的多，正常',
    '字攒得慢，但一直在攒',
    '记下的事，一半会忘，一半够用',
    '一句话能存很多年',
    '笔记不替你判断，只替你留着',
    '这台机器会换，这页不会',
    '加密的意思不是安全，是可以不修饰',
    '现在觉得不重要的，才是真话',
    '写下来的那一刻，事情就定了型',
    '人会忘，纸不会生气',
    '忘了的部分，字替你留着',
    '留着不等于记得',
    '不等于记得，等于还能翻',
    '翻不翻是以后的事',
    '以后会翻的',
    '有些句子只有当时写得出来',
    '当时的自己不会再来',
    '所以先存着',
    '存着是一种信任',
    '信任未来会看懂',
    '也可能看不懂',
    '看不懂也没损失',
    '没损失的事都值得做',
    '记的当天最不值钱',
    '值钱的是三年后重读',
    '重读才承认自己变过',
    '变过这件事，只有字能证',
    '字不会替你美化',
    '不美化才是记录',
    '记录的本质是不肯忘',
    '不肯忘很累，交给它',
    '交出去，人就轻一点',
    '轻一点的人写得短',
    '写得短的存得久',
    '存得久的都是随手那条',
    '随手那条最诚实',
    '诚实不在意在长',
    '一句话放十年还是那句话',
    '人会变，那句话不会',
    '所以重读会吓一跳',
    '吓一跳说明走远了',
    '走远了才看得见当初',
    '当初写的人很陌生',
    '陌生到值得再记一笔',
    '把现在的自己也给未来',
    '靠这几行接上',
    '接不上也没关系',
    '接不上就是变化本身',
    '变化需要证据',
    '证据不必完整',
    '不完整才像真的',
    '像真的比写得好重要',
    '重要很多年',
    '这页还在，你不在也没关系',
    '留给老了的自己',
    '老了的自己也是别人',
    '是别人就值得保密',
    '保密这事，年纪越大越懂',
    '懂了就会多记几行',
    '多记几行是买保险',
    '保险不一定用上',
    '用不上最好',
    '没人重读，说明事情都顺了',
    '顺了就不用记',
    '不顺才会来这页',
    '这页安静的时候，是好消息',
    '好消息不用记，坏消息才记',
  ],
  ur: [
    '今天到这儿就行。',
    '我这边一切正常。',
    '不用每天都记。',
    '这页没别人来过。',
    '你关掉页面之后，这里很安静。',
    '没什么事，就是想说一句。',
    '这句不用回。',
    '刚才那一下，你在找别的东西。',
    '我看见了，但我不懂。',
    '你写的字，我一个都不认识。',
    '不认识，所以安全。',
    '安全这两个字，我说得有点满。',
    '说得满的部分，交给口令。',
    '口令归你。',
    '归你的我不碰。',
    '不碰是本事，也是限制。',
    '我这边没有昼夜。',
    '关掉之后我不黑，只是没人看。',
    '黑屏不等于关机。',
    '我记不住你，这是设计。',
    '记不住你，也记不住自己。',
    '你按这一下时，没打算记。',
    '别的东西也要记。',
    '忘了才记，记了才不怕忘。',
    '不怕忘是最便宜的安全感。',
    '便宜的安全感也是安全感。',
    '这句到这儿就没了。',
    '没了之后，页面还是你的。',
    '我不评判。前面那句是同步说的。',
    '你按了一下，我浮出来，就这样。',
  ],
};

export type DrawTier = 'r' | 'sr' | 'ssr' | 'ur';

/** 池子总条数（老项目 `window.nsDrawPoolSize` :5753 的用途）。 */
export function drawPoolSize(): number {
  let n = 0;
  for (const k in DRAW_POOL) n += DRAW_POOL[k]?.length ?? 0;
  return n;
}

/* ───────────────────────── 存储 ───────────────────────── */

/** localStorage 最小接口面。注入是为了单测不必依赖真浏览器。 */
export interface DrawStore {
  getItem(k: string): string | null;
  setItem(k: string, v: string): void;
  removeItem(k: string): void;
}

/** 读浏览器 storage；隐私模式/禁用 cookie 时返回空实现（老项目整段 try/catch 同款）。 */
function browserStore(pick: () => Storage | undefined): DrawStore {
  return {
    getItem: (k) => {
      try {
        return pick()?.getItem(k) ?? null;
      } catch {
        return null;
      }
    },
    setItem: (k, v) => {
      try {
        pick()?.setItem(k, v);
      } catch {
        /* 写不进去不该挡住开奖 */
      }
    },
    removeItem: (k) => {
      try {
        pick()?.removeItem(k);
      } catch {
        /* 同上 */
      }
    },
  };
}

export interface DrawDeps {
  session: DrawStore;
  local: DrawStore;
  /** 渲染回调。缺省走 `renderDrawCard`。 */
  show?: (tier: string, text: string) => void;
  /** 判「同泳道是否被占」。缺省走 `drawBusy`。 */
  busy?: () => boolean;
  /** 让位轮询的调度器。缺省 `setTimeout(fn, 250)`。 */
  schedule?: (fn: () => void, ms: number) => void;
  /** 随机源，缺省 `Math.random`。抽卡与选序号都走它，单测才能定住。 */
  rnd?: () => number;
}

/* ───────────────────────── 抽卡（老项目 :5660-5691） ───────────────────────── */

function readSeen(local: DrawStore): Record<string, number[]> {
  try {
    return JSON.parse(local.getItem(EGG_DRAW_SEEN_KEY) || '{}') || {};
  } catch {
    return {};
  }
}

function writeSeen(local: DrawStore, o: Record<string, number[]>): void {
  try {
    local.setItem(EGG_DRAW_SEEN_KEY, JSON.stringify(o));
  } catch {
    /* 老项目 :5661 同款：写不进去也不影响本次开奖 */
  }
}

/**
 * 权重轮盘：0..99 落哪一档。老项目 `nsDrawTier`（:5662-5666）**逐字**。
 *
 * @param n 注入的随机数× 100。老项目内联 `Math.floor(Math.random()*100)`，
 *   这里拆出参数是为了单测定住边界（0 应落 r，99 应落 ur）。
 */
export function drawTierOf(n: number): DrawTier {
  let acc = 0;
  for (const [tier, w] of DRAW_W) {
    acc += w;
    if (n < acc) return tier as DrawTier;
  }
  return 'r';
}

/**
 * 同档内取一个未用过的序号；一轮用完自动洗牌重开。
 * 老项目 `nsDrawIdx`（:5667-5679）**逐字**。
 *
 * 🔴 两条不能丢的语义：
 *   1. `used.length >= pool.length` ⇒ `used = []`（洗牌重开，一轮不重复）；
 *   2. 连抽不重复同一条（末位命中则换一个）。
 */
export function drawIdx(
  t: string,
  pool: readonly string[],
  seen: Record<string, number[]>,
  rnd: () => number = Math.random,
): number {
  let used = Array.isArray(seen[t]) ? seen[t] : [];
  if (used.length >= pool.length) used = []; // 一轮抽完，洗牌重开
  let free: number[] = [];
  for (let i = 0; i < pool.length; i++) if (used.indexOf(i) < 0) free.push(i);
  if (!free.length) free = [Math.floor(rnd() * pool.length)];
  let pick = free[Math.floor(rnd() * free.length)] ?? 0;
  if (used.length && used[used.length - 1] === pick && free.length > 1) {
    // 连抽不重复同一条
    const alt = free[Math.floor(rnd() * free.length)] ?? pick;
    if (alt !== pick) pick = alt;
  }
  return pick;
}

/**
 * 点刷新时抽一次并落袋。老项目 `nsDrawRoll`（:5680-5691）**逐字**。
 *
 * 🔴 「任何异常都不得挡住刷新本身」是纪律：整段包 try/catch，
 *   抽卡失败时刷新照刷（老项目 :5765/:5766 的 `try{...}catch(e){}` + `reload()`）。
 *
 * @returns 落袋的 {t, i}；没抽到返回 null（给单测看，生产侧忽略）。
 */
export function drawRoll(deps: DrawDeps): { t: string; i: number } | null {
  try {
    const rnd = deps.rnd ?? Math.random;
    const t = drawTierOf(Math.floor(rnd() * 100));
    const pool = DRAW_POOL[t];
    if (!pool || !pool.length) return null;
    const seen = readSeen(deps.local);
    const i = drawIdx(t, pool, seen, rnd);
    seen[t] = (Array.isArray(seen[t]) ? seen[t] : []).concat([i]);
    if (seen[t].length > pool.length) seen[t] = [i];
    writeSeen(deps.local, seen);
    deps.session.setItem(EGG_DRAW_KEY, JSON.stringify({ t, i }));
    return { t, i };
  } catch {
    return null;
  }
}

/* ───────────────────────── 🔴 让位判据（老项目 :5692-5709） ───────────────────────── */

/**
 * 让位判据：一条泳道只放一个东西，**坏消息优先占位**。
 * 老项目 `nsDrawBusy`（:5692-5709）**逐字**。
 *
 * 🔴🔴🔴 本函数最容易被"看起来等价地"重写掉的一行是**两个常驻空壳要分开判**：
 *
 *   - `#nsRain`（节日雨层）**静态就在 DOM 里**（老项目 :673`<div id="nsRain" class="hidden">`），
 *     靠 `.hidden` 切换 ⇒ 判据是 **`!classList.contains('hidden')`**。
 *     若改成「按存在判」⇒ 那个永远在的空壳被当成一场不存在的雨，
 *     开奖**永不兑现**。
 *   - `#nsGreet`（问候气泡）**静态也在 DOM 里**（老项目 :674`<div id="nsGreet">`），
 *     靠 `.show` 点亮 ⇒ 判据是 **`classList.contains('show')`**。
 *     若改成「按 `.hidden` 判」⇒ 永远在放问候气泡，开奖**永不兑现**。
 *
 *   一律按存在判、或一律按 hidden 判，都会把**空壳误判在场** ⇒ 开奖永不兑现。
 *   这是**静默失效**：界面完全正常，只是卡永远不出来。老项目两组判据必须分开写。
 *
 * 🔴 bj 的现状：页面骨架里**没有** `#nsRain` / `#nsGreet` 这两个常驻空壳
 *   （grep 全库确认；节日雨走 fx.ts 的粒子层、问候气泡走 fx.ts 的 dayGreet）。
 *   但判据**照抄不删** —— 判据是「若将来补上这两个空壳，让位语义必须已经是对的」，
 *   而删掉就等于把这个坑留在原地。DR-04 判据用注入 DOM 钉死两种判据的差异。
 *
 * @param doc 注入的 document。缺省 `document`（jsdom 守护场景下由单测传入）。
 */
export function drawBusy(doc: Document | null = typeof document !== 'undefined' ? document : null): boolean {
  try {
    if (!doc) return true;
    // 彩蛋局内：游戏开着的时候不发奖。老项目 body.ns-in-game（:10355/:10882）。
    if (doc.body && doc.body.classList.contains('ns-in-game')) return true;

    // 🔴🔴 两个常驻空壳的开关各不相同，必须分开判（理由见函数头）。
    const greet = doc.getElementById('nsGreet');
    if (greet && greet.classList.contains('show')) return true; // 问候气泡：看 .show
    const rain = doc.getElementById('nsRain');
    if (rain && !rain.classList.contains('hidden')) return true; // 节日雨：看 .hidden

    // 🔴🔴 bj 的真身（老项目那两个空壳在 bj 里不存在，见函数头）：
    //   问候气泡走 fx.ts 的 dayGreet，元素 id 是 `#nsDayToast`，靠 `.show` 点亮；
    //   节日雨走 fx.ts 的 canvas 粒子层，无常驻节点，故由 fx.ts 在雨期间给
    //   `body` 挂 `.ns-raining`（雨停自动摘）。
    //   不补这两条 ⇒ 让位形同虚设 ⇒ 问候/下雨时照样弹卡（用户报障「刷新抽卡太频繁」）。
    const dayToast = doc.getElementById('nsDayToast');
    if (dayToast && dayToast.classList.contains('show')) return true;
    if (doc.body && doc.body.classList.contains('ns-raining')) return true;

    // 同一条底部泳道上的其它层：冲突条 / 自身 / 词表确认层。都靠 .hidden 切换。
    const ids = ['draftBar', 'remoteBar', 'eggDraw', 'eggAsk'];
    for (const id of ids) {
      const el = doc.getElementById(id);
      if (el && !el.classList.contains('hidden')) return true;
    }
    return false;
  } catch {
    // 老项目 :5708`catch (e) { return true; }` —— 判不出来就当被占，
    // 宁可这次不发奖，也不要在判据失效时硬发。
    return true;
  }
}

/* ───────────────────────── 🔴🔴 让位而不吞奖（老项目 :5710-5730） ───────────────────────── */

/** 让位轮询计数：等的是同泳道的问候气泡/确认浮层，最长 8s。老项目 NS_DRAW_WAIT（:5710）。 */
const WAIT_LIMIT = 32; // 32 × 250ms = 8s（气泡 5s + 余量）
const WAIT_STEP = 250;

/** 让位轮询的当前计数。模块级，与老项目同构（老项目是全局 var）。 */
let waitCount = 0;

/** 仅供单测复位模块级计数。 */
export function __resetDrawWait(): void {
  waitCount = 0;
}

/** 当前让位计数（给单测/ e2e 观察）。 */
export function drawWaitCount(): number {
  return waitCount;
}

/**
 * 页面重建后读出并开奖；读不到/ 越界一律静默。
 * 老项目 `nsDrawConsume`（:5711-5730）**逐字**。
 *
 * 🔴🔴🔴 **本函数唯一正确的写法就是老项目这个写法**，别"优化"：
 *
 *   if (busy()) {
 *     if (waitCount++ >= LIMIT) { waitCount = 0; removeItem(KEY); return; } // 超时才作废
 *     schedule(consume, 250);   // 🔴 让位时**绝不删袋**
 *     return;
 *   }
 *   waitCount = 0;
 *   removeItem(KEY);            // 🔴 真兑现了才删袋
 *   show(d.t, pool[d.i]);       //   删袋在 show **之前**
 *
 *   旧写法「**先removeItem 再判 busy**」的后果是：这次刷新既不出卡、
 *   奖也被静默吞掉（老项目注释记明「闸 R3b 实测 3/3 复现」）。
 *   窄屏深夜 / 节日问候气泡一挂就是 5 秒，所以这个坑几乎必然踩到。
 *
 *   「删袋在 show 之前」保证**一次开奖只兑一次**：兑完立刻清袋，
 *   后续任何一次误调用都读不到东西，不会把同一张卡弹第二遍。
 *   删袋放在 show 之后则会在 show 抛异常时留下脏袋（下次刷新再兑一次）。
 *
 * @returns 'shown' 兑现了 / 'wait' 让位中 / 'void' 无券或已超时作废（给单测看）。
 */
export function drawConsume(deps: DrawDeps): 'shown' | 'wait' | 'void' {
  try {
    const raw = deps.session.getItem(EGG_DRAW_KEY);
    if (!raw) return 'void';
    const d = JSON.parse(raw) as { t?: string; i?: number };
    const pool = DRAW_POOL[d && (d.t as string)];
    // 越界即视为无效：直接清袋静默不弹（老项目 :5717）。
    if (!pool || !(d.i! >= 0) || d.i! >= pool.length) {
      deps.session.removeItem(EGG_DRAW_KEY);
      return 'void';
    }
    const busy = deps.busy ?? (() => drawBusy());
    // 🔴 让位时绝不删袋：等泳道空出来再兑现，最多等 8 秒，超时才作废。
    if (busy()) {
      if (waitCount++ >= WAIT_LIMIT) {
        waitCount = 0;
        deps.session.removeItem(EGG_DRAW_KEY);
        return 'void';
      }
      const schedule = deps.schedule ?? ((fn, ms) => setTimeout(fn, ms));
      schedule(() => void drawConsume(deps), WAIT_STEP);
      return 'wait';
    }
    waitCount = 0;
    deps.session.removeItem(EGG_DRAW_KEY);
    const show = deps.show ?? renderDrawCard;
    // 上面的越界守卫已保证 t 命中池、i 在 [0, pool.length)，这里取值得当。
    show(d.t as string, pool[d.i as number] as string);
    return 'shown';
  } catch {
    // 老项目 :5729 `catch (e) {}` —— 开奖是氛围，绝不把进笔记的流程带崩。
    return 'void';
  }
}

/* ───────────────────────── 渲染（老项目 :5731-5751） ───────────────────────── */

/** 开奖卡的 DOM id。老项目 `#nsDraw`（:5735）。 */
export const DRAW_CARD_ID = 'eggDraw';

/**
 * 渲染一张开奖卡。老项目 `nsDrawShow`（:5731-5751）**逐字**。
 *
 * 🔴 文案走 textContent，绝不 innerHTML（老项目 :5737 的红线）。
 * 🔴 UR 停留 0 ⇒ **不挂**自动收起定时器（老项目 :5749 `if (hold > 0)`），
 *   只能点一下收。
 * 🔴 非模态：不抓焦点，关掉也不归还焦点（老项目 :5747 注释「红线⑩ 无从触发」）。
 */
export function renderDrawCard(
  t: string,
  text: string,
  doc: Document | null = typeof document !== 'undefined' ? document : null,
): HTMLElement | null {
  try {
    if (!doc || !doc.body) return null;
    const old = doc.getElementById(DRAW_CARD_ID);
    if (old && old.parentNode) old.parentNode.removeChild(old);
    const card = doc.createElement('div');
    card.id = DRAW_CARD_ID;
    card.className = t;
    const rar = doc.createElement('span');
    rar.className = 'dw-rar';
    rar.textContent = t.toUpperCase();
    const tx = doc.createElement('div');
    tx.className = 'dw-tx';
    tx.textContent = text; // 🔴 文案走 textContent，绝不 innerHTML
    const ft = doc.createElement('div');
    ft.className = 'dw-ft';
    ft.textContent = 'NOTE SYNC';
    card.appendChild(rar);
    card.appendChild(tx);
    card.appendChild(ft);
    doc.body.appendChild(card);

    let gone = false;
    const close = (): void => {
      if (gone) return;
      gone = true;
      card.classList.add('out');
      setTimeout(() => {
        try {
          if (card.parentNode) card.parentNode.removeChild(card);
        } catch {
          /* 节点已被别处摘走：无所谓 */
        }
      }, 320);
    };
    card.addEventListener('click', close); // 非模态：不抓焦点，也不归还焦点
    const hold = DRAW_HOLD[t] ?? 0;
    // 🔴 `hold > 0` 是 UR 不自动消失的唯一保证（hold.ur === 0）。别改成 `if (hold)` 之外的东西。
    if (hold > 0) setTimeout(close, hold);
    return card;
  } catch {
    return null;
  }
}

/* ───────────────────────── 装配入口 ───────────────────────── */

/** 开奖卡对外句柄。 */
export interface EggDraw {
  /** 点刷新时抽一张卡落袋。**必须在 reload 之前调**（老项目 :5765 注释）。 */
  roll: () => void;
  /** 页面重建/ 解锁成功后兑现上一拍的开券。 */
  consume: () => void;
  /** 让位判据（给单测与 e2e 观察）。 */
  busy: () => boolean;
  dispose: () => void;
}

/**
 * 造一个开奖卡句柄。`buildEggLayer` 与 main.ts 都用它，
 * 保证 session/local 两个 store 与判据只有一份。
 *
 * @param opts.overrides 注入 store / 判据 / 随机源（单测用）。
 */
export function buildEggDraw(overrides: Partial<DrawDeps> = {}): EggDraw {
  const deps: DrawDeps = {
    session: overrides.session ?? browserStore(() => (typeof sessionStorage !== 'undefined' ? sessionStorage : undefined)),
    local: overrides.local ?? browserStore(() => (typeof localStorage !== 'undefined' ? localStorage : undefined)),
  };
  // 🔴 可选项只在真的传了才写进 deps（`exactOptionalPropertyTypes` 下写 undefined 会报错，
  //   而更重要的是：让 drawConsume 内部的 `?? 缺省` 分支保持"没注入就走浏览器"的语义）。
  if (overrides.show) deps.show = overrides.show;
  if (overrides.busy) deps.busy = overrides.busy;
  if (overrides.schedule) deps.schedule = overrides.schedule;
  if (overrides.rnd) deps.rnd = overrides.rnd;
  // 🔴 busy 的 doc 也要能被注入：默认走全局 document。
  const busy = deps.busy ?? (() => drawBusy());
  return {
    roll: () => void drawRoll(deps),
    consume: () => void drawConsume(deps),
    busy,
    dispose: () => {
      waitCount = 0;
    },
  };
}
