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
 */
const EDGES: ReadonlySet<string> = new Set<string>([
  // 未解锁：只有解锁一条路
  edge('locked', 'unlock'),

  // idle（已同步）：远端推送到达或用户刷新 → 去拉；本地打字 → dirty
  edge('idle', 'remote-arrived'),
  edge('idle', 'refresh'),
  edge('idle', 'edit'),

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

  // pushing：成功 → idle；网络挂 → offline；推的过程中用户又打字 → dirty（回到 dirty 重推）
  edge('pushing', 'pushed'),
  edge('pushing', 'network-fail'),
  edge('pushing', 'edit'),
  edge('pushing', 'remote-arrived'),

  // offline：编辑照常留本地；网络恢复或手动刷新 → 去拉
  edge('offline', 'edit'),
  edge('offline', 'online'),
  edge('offline', 'refresh'),

  // conflict：只能由用户裁决或重拉解除，不许自己恢复
  //（自己恢复 = 用户根本不知道自己的内容被合并改过）
  edge('conflict', 'resolve-local'),
  edge('conflict', 'resolve-remote'),
  edge('conflict', 'refresh'),
  edge('conflict', 'network-fail'),

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
      return 'locked'; // lock

    case 'pushing':
      if (ev === 'pushed') return 'idle';
      if (ev === 'network-fail') return 'offline';
      if (ev === 'edit') return 'dirty';
      if (ev === 'remote-arrived') return 'syncing';
      return 'locked'; // lock

    case 'offline':
      if (ev === 'edit') return 'offline'; // 继续攒本地改动，不尝试推送
      if (ev === 'lock') return 'locked';
      return 'syncing'; // online / refresh

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
