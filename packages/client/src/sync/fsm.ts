/**
 * 同步冲突状态机
 *
 * ARCH.md §4.4：转移表写成数据、可单测，不用事件总线。
 *
 * 为什么不用事件总线：老项目的"同步"是一条 2000 行的隐式状态流，出问题时只能靠
 * 打日志猜现在处于哪个阶段。字符串事件名在代码里散落各处时，重命名必漏一处、
 * 漏一处就是一条静默 bug。
 *
 * 这里用「边表 EDGES + 纯函数 reduce」两份结构：
 *  - EDGES 是数据，回答"哪些转移合法"，可被穷举完备性测试覆盖
 *  - reduce 是代码，回答"这条边通到哪"，是一段能一眼读完的 switch
 * 两份对不上就是 bug，由 client/test/fsm.test.mjs 的完备性用例钉死。
 */

export type SyncState =
  /** 未解锁：没有内存中的 CryptoKey，正文不可读写 */
  | 'locked'
  /** 正在向服务端取远端版本（含 首次拉取 / 手动刷新 / SSE 触发的重拉） */
  | 'syncing'
  /** 本地有未推送的改动 */
  | 'dirty'
  /** 合并完成，正在推送 */
  | 'pushing'
  /** 网络不可达，改动留在本地 */
  | 'offline'
  /** 合并出现真冲突，需用户裁决 */
  | 'conflict'
  /** 已解锁且与服务端一致 */
  | 'idle';

export type SyncEvent =
  /** 口令正确，解锁 */
  | 'unlock'
  /** 拉取完成，且本地无改动 */
  | 'pulled'
  /** 本地编辑 */
  | 'edit'
  /** 去抖到期，发起推送 */
  | 'push'
  /** 推送成功 */
  | 'pushed'
  /** 网络失败 */
  | 'network-fail'
  /** 网络恢复 */
  | 'online'
  /** 远端有新版本（SSE 通知） */
  | 'remote-arrived'
  /** 合并无冲突，且本地确有改动需要推上去 */
  | 'merge-clean'
  /** 合并有冲突 */
  | 'merge-conflict'
  /** 用户裁决：保留远端 */
  | 'resolve-remote'
  /** 用户裁决：保留本地 */
  | 'resolve-local'
  /** 手动刷新 */
  | 'refresh'
  /** 锁定退出 */
  | 'lock';

export const ALL_STATES: readonly SyncState[] = [
  'locked',
  'syncing',
  'dirty',
  'pushing',
  'offline',
  'conflict',
  'idle',
];

export const ALL_EVENTS: readonly SyncEvent[] = [
  'unlock',
  'pulled',
  'edit',
  'push',
  'pushed',
  'network-fail',
  'online',
  'remote-arrived',
  'merge-clean',
  'merge-conflict',
  'resolve-remote',
  'resolve-local',
  'refresh',
  'lock',
];

const edge = (from: SyncState, ev: SyncEvent): string => `${from}>${ev}`;

/**
 * 合法边全集。8 状态 × 14 事件 = 112 种组合，只有这些合法。
 *
 * 设计要点：**没有"任何状态都能做的事"**。locked 态只有 unlock / lock 两条边 ——
 * 没有密钥时编辑、重拉、推送在语义上都是无意义的。老项目就是在这里让人
 * "锁着也能改、改了不保存"，最后靠用户自己发现，已知 bug。
 *
 * 🔴🔴 判据是「这条边在**真实网络时序**下会不会发生」，不是「理论上能否想象」。
 *   本文件此前漏了 6 条必然踩到的边（offline--remote-arrived、pushing--push、
 *   dirty--pushed/pulled/merge-clean/merge-conflict），
 *   症状统一是 main.ts:1567 把内部异常消息当用户文案推到底栏，
 *   用户看到「最后同步：非法状态转移：…」+ 红点 —— 探针实测见 client.ts send() 的注释。
 *   补边的依据一律是老项目对应行号，逐条写在各边注释里，不靠推理。
 */
const EDGES: ReadonlySet<string> = new Set<string>([
  // 未解锁：只有解锁一条路
  edge('locked', 'unlock'),

  // idle（已同步）：远端推送到达或用户刷新 → 去拉；本地打字 → dirty
  edge('idle', 'remote-arrived'),
  edge('idle', 'refresh'),
  edge('idle', 'edit'),
  // 🔴🔴 idle --network-fail-->：**静默轮询**（client.ts quietPoll）在 idle 态拉失败时踩到。
  //   老项目 poll 的 catch 把 fetch 失败归成"离线"（index.html:10026-10030）——
  //   也就是说"已同步"态下一次失败轮询**必须**能把底栏切成"离线中"。
  //   此前无此边 ⇒ 只能走 `idle --remote-arrived--> syncing --network-fail--> offline`
  //   两条边，但那会先闪一下"连接中…"（正是用户报障第 7 条要消除的抖动）。
  edge('idle', 'network-fail'),

  // syncing（正在拉）：拉回且本地无改动 → idle；合并后有改动 → 直接去推；
  // 冲突 → conflict；网络挂 → offline；拉的过程中用户又打字 → dirty
  edge('syncing', 'pulled'),
  edge('syncing', 'merge-clean'),
  edge('syncing', 'merge-conflict'),
  edge('syncing', 'network-fail'),
  edge('syncing', 'edit'),
  edge('syncing', 'remote-arrived'),

  // dirty（有未推送改动）：去抖到期 → 推送；远端到达/手动刷新 → 先拉后推
  edge('dirty', 'push'),
  edge('dirty', 'remote-arrived'),
  edge('dirty', 'refresh'),
  edge('dirty', 'edit'),
  edge('dirty', 'network-fail'),
  // 🔴🔴 dirty 的**迟到结论**三条边。共同成因：pull() 是异步的，
  //   等它 await 回来时用户可能又打字了（syncing --edit--> dirty）。
  //   探针实测（tools/probe 系列的 E5）：这么打一次，
  //   onError 里就多一条「非法状态转移：dirty --merge-clean-->」⇒ 底栏闪红点。
  //   老项目同一时序的处理见 index.html:9306
  //   `if (busy) { ...; pendingResave = true; return; }`
  //   —— 在途期间的新输入**挂起重存**，绝不报错。所以这三条必须是合法边。
  edge('dirty', 'pulled'),
  edge('dirty', 'merge-clean'),
  edge('dirty', 'merge-conflict'),
  // 🔴 dirty --pushed-->：push 在途时用户又打了字（pushing --edit--> dirty），
  //   POST 回来才发 pushed。此时**那批字还没推上去**，绝不能因为一次
  //   pushed 就宣称已同步 —— 那是"静默降级"的典型：用户以为存上了。
  //   ⇒ 停在 dirty，交给 noteEdit 已经挂好的去抖定时器再推一次。
  edge('dirty', 'pushed'),

  // pushing：成功 → idle；网络挂 → offline；推的过程中用户又打字 → dirty（回到 dirty 重推）
  edge('pushing', 'pushed'),
  edge('pushing', 'network-fail'),
  edge('pushing', 'edit'),
  edge('pushing', 'remote-arrived'),
  // 🔴🔴 pushing --push-->：**合并干净后自动重推**那条路径必然踩到。
  //   client.ts decryptAndMerge 末尾 `send('merge-clean')` 把状态推到 pushing，
  //  紧接着 `await this.push()`，而 push() 第一句就是 `send('push')`
  //   —— 于是变成 pushing --push-->，之前无此边，抛异常。
  //   探针实测 E1'：PC 与手机改**不同处**（不是冲突路径，是最常见的正常协作路径）
  //   必红一次。老项目允许这个重入且写明了理由，见 index.html:9486-9490：
  //   「PUT 期间占住保存互斥……busy 重复置位无害」，
  //   且 :9488 明确说「入口拦会误杀 409 合并路径」。
  //   ⇒ 语义上确实该有，且只能自环（仍在推，不许倒退）。
  edge('pushing', 'push'),

  // offline：编辑照常留本地；网络恢复或手动刷新 → 去拉
  edge('offline', 'edit'),
  edge('offline', 'online'),
  edge('offline', 'refresh'),
  // 🔴🔴🔴 offline --remote-arrived-->：**用户报障第1 条的正身**。
  //   SSE 连接还活着（所以推送收得到），但先前某次 fetch 失败把状态落在 offline。
  //   client.ts openStream 只挡 pushing/syncing（:518），offline 漏在挡外，
  //   于是 `send('remote-arrived')` 抛异常 → onError → main.ts:1567
  //   footStatus('offline', 内部消息) ⇒ 底栏闪红点 +「非法状态转移：…」。
  //
  //   老项目口径：收到推送**一律重拉，从不报状态错误** ——
  //     index.html:10047 `sseSource.onmessage = () => { poll(); }`（无任何状态判断）
  //     index.html:9930-9932 poll 的守卫只有 busy / inflightWrites / !cryptoKey / bakMode
  //     index.html:10026-10030 poll 的 catch 把失败归成
  //       已锁定 / 离线 / 同步中断 —— **30 句白名单里没有"非法状态转移"**
  //   ⇒ 对应到 bj 就是这条边：去重拉一次。拉不成pull 自己会 network-fail 回offline
  //   （syncing --network-fail--> offline 是既有边），闭环。
  edge('offline', 'remote-arrived'),
  // 🔴🔴 offline --pulled-->：静默轮询（client.ts quietPoll）在 offline 态拉成功、
  //   且本机无改动 ⇒ 网络恢复、回『已同步』。老项目 poll 成功无条件
  //   `setStatus(true,'已同步')`（index.html:9933-9937）。
  //   不发这条边的话，offline 只能靠 window 'online' 事件或用户手动刷新回 idle ——
  //   而"navigator.onLine 恒 true 但服务端不可达"（隧道/半死 socket）时浏览器
  //   根本不派发 'online' ⇒ 底栏永久停在『离线中』。
  edge('offline', 'pulled'),

  // conflict：只能由用户裁决或重拉解除，不许自己恢复
  //（自己恢复 = 用户根本不知道自己的内容被合并改过）
  edge('conflict', 'resolve-local'),
  edge('conflict', 'resolve-remote'),
  edge('conflict', 'refresh'),
  edge('conflict', 'network-fail'),
  // 🔴 conflict 态**故意没有** remote-arrived / pulled / merge-* 边。
  //   不是漏了，是老项目的对应行为根本不是"再合并一次"，而是**存起来等用户拍板**：
  //     index.html:9947 `if (pendingRemoteNote) { pendingRemoteNote = note; return; }`
  //     index.html:9955、:9966 三处同款守卫，注释写"挂起期不消费版本、不应用 rem"
  //   ⇒ bj 侧由 client.ts openStream 在 conflict 时**不重拉**来对齐（见该处注释），
  //     而不是给状态机开一条边让pull() 在用户没拍板时又改一次文档。
  //   探针实测 E3'：开着这条边时，冲突期间一次 SSE 会连抛两条
  //   （conflict --remote-arrived--> 与随后的 conflict --merge-conflict-->）。

  // 锁定：任何非锁态都能发生（用户点"退出锁定"）
  edge('idle', 'lock'),
  edge('syncing', 'lock'),
  edge('dirty', 'lock'),
  edge('pushing', 'lock'),
  edge('offline', 'lock'),
  edge('conflict', 'lock'),
]);

/** 这条边合法吗 */
export function canTransition(from: SyncState, ev: SyncEvent): boolean {
  return EDGES.has(edge(from, ev));
}

export class IllegalTransitionError extends Error {
  readonly from: SyncState;
  readonly ev: SyncEvent;
  constructor(from: SyncState, ev: SyncEvent) {
    super(`非法状态转移：${from} --${ev}-->（无此边）`);
    this.name = 'IllegalTransitionError';
    this.from = from;
    this.ev = ev;
  }
}

/**
 * 纯函数 reducer。非法转移抛 IllegalTransitionError。
 *
 * 抛而不静默兜底：非法转移是代码 bug，静默吞掉等于把同步状态变成不可观测的黑洞，
 * 也就是老项目里"同步偶尔不推、也不报错、也不提示"那类问题的温床。
 */
export function reduce(from: SyncState, ev: SyncEvent): SyncState {
  if (!canTransition(from, ev)) throw new IllegalTransitionError(from, ev);
  switch (from) {
    case 'locked':
      return 'syncing'; // 唯一合法事件 unlock：解锁后立即拉一次远端

    case 'idle':
      if (ev === 'remote-arrived' || ev === 'refresh') return 'syncing';
      if (ev === 'edit') return 'dirty';
      if (ev === 'network-fail') return 'offline'; // 静默轮询拉失败（见 EDGES 该边注释）
      return 'locked'; // lock

    case 'syncing':
      if (ev === 'pulled') return 'idle';
      if (ev === 'merge-clean') return 'pushing';
      if (ev === 'merge-conflict') return 'conflict';
      if (ev === 'network-fail') return 'offline';
      if (ev === 'edit') return 'dirty';
      if (ev === 'remote-arrived') return 'syncing'; // 已在拉，幂等重入
      return 'locked'; // lock

    case 'dirty':
      if (ev === 'push') return 'pushing';
      if (ev === 'remote-arrived' || ev === 'refresh') return 'syncing';
      if (ev === 'edit') return 'dirty';
      if (ev === 'network-fail') return 'offline';
      // 🔴 迟到的结论：绝不清 dirty（见 EDGES 里那几条边的注释）。
      //   pulled  保持 dirty：那批字还没推，绝不能宣称已同步。
      //   merge-clean     → pushing：合并干净，本地确有改动要推上去。
      //   merge-conflict  → conflict：真冲突，回退到"等用户裁决"。
      if (ev === 'merge-clean') return 'pushing';
      if (ev === 'merge-conflict') return 'conflict';
      //🔴 pulled / pushed 落回 dirty，但**lock 必须仍然回 locked**——
      //   写成 `return 'dirty'` 会把 lock 一起吞掉，用户点"退出锁定"于是锁不掉。
      //   （S3-37 钉的就是这条；这条边界是补边时最容易踩的坑。）
      if (ev === 'lock') return 'locked';
      return 'dirty'; // pulled / pushed

    case 'pushing':
      if (ev === 'pushed') return 'idle';
      if (ev === 'network-fail') return 'offline';
      if (ev === 'edit') return 'dirty';
      if (ev === 'remote-arrived') return 'syncing';
      if (ev === 'push') return 'pushing'; // 合并干净后的自动重推：仍在推，自环
      return 'locked'; // lock

    case 'offline':
      if (ev === 'edit') return 'offline'; // 继续攒本地改动，不尝试推送
      if (ev === 'lock') return 'locked';
      if (ev === 'pulled') return 'idle'; // 静默轮询拉成功且无改动 ⇒ 网络恢复，回已同步
      return 'syncing'; // online / refresh / remote-arrived（老项目：收到推送就重拉）

    case 'conflict':
      if (ev === 'resolve-local') return 'dirty';
      if (ev === 'resolve-remote') return 'syncing';
      if (ev === 'refresh') return 'syncing';
      if (ev === 'network-fail') return 'offline';
      return 'locked'; // lock
  }
}

/** 状态机的可观测投影：UI 只读这个，不直接读转移表 */
export interface SyncSnapshot {
  state: SyncState;
  /** 是否还锁着（未解锁，正文尚不可编辑） */
  locked: boolean;
  /** 正文是否只读（locked 或 conflict 时不能直接编辑，避免覆盖对方） */
  readOnly: boolean;
  /** 是否显示"未同步" */
  unsaved: boolean;
  offline: boolean;
  /** 必须让用户看见并裁决 */
  needResolve: boolean;
}

export function snapshotOf(state: SyncState): SyncSnapshot {
  return {
    state,
    locked: state === 'locked',
    readOnly: state === 'locked' || state === 'conflict',
    unsaved: state === 'dirty' || state === 'pushing',
    offline: state === 'offline',
    needResolve: state === 'conflict',
  };
}


/**
 * 🔴🔴 这里曾有一个 `STATE_LABEL`（locked/syncing/dirty/... 的中文短标签表），
 *   **全仓零引用**，是死代码 —— 而它里面恰好就写着 `idle: '已同步'`。
 *   也就是说：底栏该显示什么，源码里明明有一份表，却没人读；
 *   真正渲染底栏的 shell.ts 走的是另一条路，而那条路当时把 synced 渲染成了空串。
 *   两份映射各说各话 ⇒ 用户报障「底部没有已同步三个字」，而 444 条单测全绿。
 *
 *   现已**删除**：可见文案统一归 `ui/copy.ts`（COPY.statusSynced / footSaving 等），
 *   fsm 只负责状态迁移，不碰文案 —— 免得再多一份"看着权威其实没人用"的表。
 *   要给状态加中文标签，改 copy.ts，不要在这里加。
 */
