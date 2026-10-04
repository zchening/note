/**
 * 密钥库 —— CryptoKey 存 IndexedDB，extractable:false，raw key 永不落盘
 *
 * 老项目的 6 处密钥落盘（index.html 3350/3440/3503/9090/9003/8334）都是
 * `localStorage.setItem(KEY_STORE, bufToB64(rawKey))` —— 一旦 XSS，密钥被读走，
 * 攻击者可以离线解开用户全部历史密文，且用户改口令也救不回来（历史密文已被解开）。
 *
 * 本模块的做法：
 *  - 口令只在内存里参与 PBKDF2，派生出的 CryptoKey 以 extractable:false 存 IndexedDB
 *  - raw key 字节永不 JS 可读，XSS 拿到的也只是一把"能用但不能导出"的句柄
 *  - 要解密必须过 WebCrypto 的权限检查，恶意代码可以直接调 decrypt()，
 *    但拿不到密钥去离线爆破别的数据 —— 攻击面从"永久脱机失守"缩到"当次会话可用"
 *  - IndexedDB 不可被爬虫/其他源读取（不跨源），比 localStorage 安全一档
 *
 * 明确不做（ARCH.md §7）：不加主密钥 wrap 层。老项目没有共享笔记需求，
 * 为臆测需求加一层 wrap = 多 3-5 人日 + 一次可写错的安全代码，收益为负。
 */

const DB_NAME = 'notesync-bj';
const DB_VER = 1;
const STORE = 'keystore';

export interface StoredKey {
  id: string;
  /** 不可导出的 CryptoKey */
  key: CryptoKey;
  /** 派生用的 salt，供重算与展示 */
  salt: string;
  iter: number;
  savedAt: number;
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VER);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: 'id' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('IndexedDB 打开失败'));
  });
}

function tx<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return openDb().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const t = db.transaction(STORE, mode);
        const req = fn(t.objectStore(STORE));
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error ?? new Error('IndexedDB 操作失败'));
        t.oncomplete = () => db.close();
      }),
  );
}

/** 存一把派生好的不可导出密钥 */
export async function putKey(rec: StoredKey): Promise<void> {
  await tx('readwrite', (s) => s.put(rec) as IDBRequest<IDBValidKey>);
}

export async function getKey(id: string): Promise<StoredKey | undefined> {
  return tx<StoredKey | undefined>('readonly', (s) => s.get(id) as IDBRequest<StoredKey | undefined>);
}

export async function delKey(id: string): Promise<void> {
  await tx('readwrite', (s) => s.delete(id) as IDBRequest<undefined>);
}

export async function listKeys(): Promise<StoredKey[]> {
  return tx<StoredKey[]>('readonly', (s) => s.getAll() as IDBRequest<StoredKey[]>);
}

export async function clearKeys(): Promise<void> {
  await tx('readwrite', (s) => s.clear() as IDBRequest<undefined>);
}

/**
 * 会话内缓存：避免每次解密都读一次 IndexedDB。
 * 只缓存 CryptoKey 句柄（不可导出），不缓存任何 raw 字节。
 */
const mem = new Map<string, StoredKey>();

export function cacheKey(rec: StoredKey): void {
  mem.set(rec.id, rec);
}

export function cachedKey(id: string): StoredKey | undefined {
  return mem.get(id);
}

export function dropCache(id?: string): void {
  if (id === undefined) mem.clear();
  else mem.delete(id);
}

/**
 * 取密钥：内存 → IndexedDB → 都没有则返回 undefined（让上层弹口令框）。
 * 这一层是"用户输一次口令，本次会话内不再问"的实现。
 */
export async function resolveKey(id: string): Promise<StoredKey | undefined> {
  const m = mem.get(id);
  if (m) return m;
  const r = await getKey(id);
  if (r) mem.set(id, r);
  return r;
}

export const KEYSTORE_DB = DB_NAME;
export const KEYSTORE_STORE = STORE;
