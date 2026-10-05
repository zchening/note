/**
 * 收藏夹 —— **纯逻辑层**，不碰 DOM，可在 node --test 里直接单测
 *
 * 🔴 为什么是「本机键」而不是真源字段：
 *   老项目 v5.55 拍板：收藏是**本机偏好**，不进笔记真源。
 *   理由是收藏表达的是「这台设备上我常看哪几篇」，属个人偏好；
 *   塞进真源会让每台设备的收藏互相覆盖（合并时打架），
 *   而且换机备份走「扫码换机」那条路（把收藏名一起带走），已经够用。
 *   所以本模块**只碰 localStorage**，绝不进 canonical，也绝不参与同步。
 *
 * 🔴🔴 排序语义：**新收藏的排最前**（老项目 `favs.unshift`）。
 *   这一点是有意为之 —— 收藏夹是「最近关注」列表，
 *   排末尾等于让用户每次都要滚到底才能看到刚收藏的那篇。
 *
 * 🔴🔴 FAVS_MAX = 100（老项目 v10.1.4 由 20 上调到 100）：
 *   换机备份是「一篇码带走全部」的设计，收藏列表卡 20 篇等于
 *   换机只能搬得走 20 篇。老项目的理由原样承接。
 */

/** localStorage 键。**独立前缀**（notesync_bj_），与老项目的 notesync_favs 刻意不共用
 *  —— 新旧项目数据完全独立是用户明确要求，共用键会互相污染。 */
export const FAVS_KEY = 'notesync_bj_favs';

/** 收藏上限（老项目 v10.1.4：20 → 100）。超出时新收藏不再入列。 */
export const FAVS_MAX = 100;

/** localStorage 的最小接口面。传注入是为了单测不必依赖真浏览器。 */
export interface FavStore {
  getItem(k: string): string | null;
  setItem(k: string, v: string): void;
}

/** 读浏览器 localStorage；不可用（隐私模式/禁用 cookie）时返回空实现。 */
export function browserStore(): FavStore {
  try {
    const ls = window.localStorage;
    // 真探一次：Safari 隐私模式下 localStorage 存在但 setItem 抛 QuotaExceeded
    ls.getItem(FAVS_KEY);
    return ls;
  } catch {
    return { getItem: () => null, setItem: () => {} };
  }
}

/**
 * 归一成合法收藏列表。
 *
 * 🔴🔴 必须**过滤非字符串**：老项目这里就是 `a.filter(n => typeof n === 'string')`，
 *   但它没解释为什么 —— 实际后果是：localStorage 被别的脚本（或用户手改、或
 *   早期版本写坏）污染成 `["a", 42, null, {}]` 时，若不滤，
 *   渲染时会拿数字去 `encodeURIComponent(name)` 得到 "42"，
 *   于是**点收藏夹跳到一篇名叫 42 的笔记**（不存在），
 *   症状是"点了收藏夹里的某一条，进去是空的"。零报错。
 *   归一收在这一处，渲染层拿到的永远是 string[]。
 */
export function normalizeFavs(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  for (const n of raw) {
    if (typeof n !== 'string') continue;
    // 空白名一律丢：空串/纯空格是「净化前」的中间态，绝不该进收藏
    if (n.trim() === '') continue;
    if (out.indexOf(n) >= 0) continue; // 去重
    out.push(n);
    if (out.length >= FAVS_MAX) break;
  }
  return out;
}

/** 读收藏列表。解析失败一律当空（老项目行为：坏数据不该让应用崩）。 */
export function readFavs(store: FavStore): string[] {
  try {
    return normalizeFavs(JSON.parse(store.getItem(FAVS_KEY) ?? '[]'));
  } catch {
    return [];
  }
}

/**
 * 写收藏列表。
 *
 * 🔴 截断在**写入前**做（而不是读时做）：读时截断能防渲染爆多，
 *   但存储会一直变大；写时截断才是根治。
 *   这里仍然按老项目语义 `slice(0, FAVS_MAX)` 收口。
 */
export function writeFavs(store: FavStore, list: readonly string[]): string[] {
  const norm = normalizeFavs(list).slice(0, FAVS_MAX);
  try {
    store.setItem(FAVS_KEY, JSON.stringify(norm));
  } catch {
    // 🔴 配额满/隐私模式：写不进去也不能让"点收藏"变成抛异常白屏。
    //   本次会话内状态由调用方的内存副本继续持有，下次刷新丢，
    //   症状是"收藏了但刷新就没了" —— 比白屏好，且有明确语义。
  }
  return norm;
}

/**
 * 切收藏态，返回**新列表**（老项目 unshift 新增 / splice 移除）。
 *
 * @param list 返回写入后的最终列表
 * @param faved 该名字在返回列表里吗
 * @param evicted 因超上限被挤掉的名字（老项目静默丢弃，这里如实报出）
 *
 * 🔴 超上限时的语义：新收藏**一定排第 0**，所以它自己一定进得去，
 *   被挤掉的是**最旧的那一条**。老项目就是 `unshift` + `writeFavs` 里 slice 砍尾，
 *   行为完全一致；区别是老项目不告诉任何人被砍了谁。
 *   这里把 evicted 报出来，是为了让调用方在超上限时能给一句提示 ——
 *   否则用户点了 101 次收藏、第 101 篇却查不到，且与"收藏坏了"无法区分。
 */
export function toggleFav(
  store: FavStore,
  name: string,
): { list: string[]; faved: boolean; evicted: string | null } {
  const cur = readFavs(store);
  const i = cur.indexOf(name);
  if (i >= 0) {
    const list = cur.slice();
    list.splice(i, 1);
    return { list: writeFavs(store, list), faved: false, evicted: null };
  }
  const next = [name, ...cur];
  const list = writeFavs(store, next);
  const evicted = list.length < next.length ? next[list.length] ?? null : null;
  return { list, faved: list.indexOf(name) >= 0, evicted };
}

/** 是否已收藏。 */
export function isFav(store: FavStore, name: string): boolean {
  return readFavs(store).indexOf(name) >= 0;
}

/** 菜单收藏夹视图需要的形态：{name} 列表（MenuState.favList 的类型）。 */
export function favListOf(store: FavStore): Array<{ name: string }> {
  return readFavs(store).map((n) => ({ name: n }));
}

/**
 * 扫码换机：把本机收藏并进收到的列表。
 *
 * 🔴 口径来自老项目 v？ backup 合并：**收到的（备份）优先排前，本机已有并入尾部**。
 *   反过来（本机在前）会让"刚恢复的收藏"排在一堆旧收藏后面，
 *   刚换完机的人第一眼看不到自己刚导入的东西 —— 换机的意义就没了。
 *   去重按 normalizeFavs 的规则（保序去重），本机与备份同名时保留备份那份。
 */
export function mergeFavs(backup: unknown, mine: readonly string[]): string[] {
  return normalizeFavs([...(Array.isArray(backup) ? backup : []), ...mine]);
}
