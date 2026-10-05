/**
 * 测试用的最小浏览器垫片 —— localStorage + IndexedDB
 *
 * 🔴🔴 为什么必须自己写，而不能用现成的 fake-indexeddb：
 *
 *  1. **零依赖是本项目的投毒防线**。运行时零依赖，测试也尽量不引第三方 ——
 *     测试依赖会让人下意识以为"运行时也可以引"，那正是要防的事。
 *
 *  2. 🔴 垫片写错 = 测试全绿但线上坏。IndexedDB 垫片最容易错在**事务语义**上：
 *       真IDB 的 request 成功 ≠ 事务提交；`t.oncomplete` 才算提交。
 *       写不成这个形状，代码里 `await putKey(...)` 就会在事务还没提交时就往下走，
 *       测试照样绿，线上偶发丢密钥。**下面刻意实现了 oncomplete 门闩。**
 *
 *  3. 只实现本项目真正用到的那几个方法。多写一个就多一处"看起来支持其实没实现"的坑。
 */

/* ---------------- localStorage ---------------- */

export function installLocalStorage(initial) {
  const map = new Map(Object.entries(initial ?? {}));
  const ls = {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => void map.set(k, String(v)),
    removeItem: (k) => void map.delete(k),
    clear: () => map.clear(),
    key: (i) => Array.from(map.keys())[i] ?? null,
    get length() {
      return map.size;
    },
    _dump: () => Object.fromEntries(map),
  };
  globalThis.localStorage = ls;
  return ls;
}

/* ---------------- IndexedDB ---------------- */

function req(result) {
  // 真实 IDBRequest：成功/失败异步触发，不能同步给值
  const r = { result, error: null, onsuccess: null, onerror: null, readyState: 'pending' };
  queueMicrotask(() => {
    r.readyState = 'done';
    if (r.onsuccess) r.onsuccess({ target: r });
  });
  return r;
}

export function installIndexedDB() {
  const dbs = new Map();

  function makeStore(store) {
    return {
      put(rec) {
        const key = rec[store.keyPath];
        store.data.set(String(key), rec);
        return req(key);
      },
      get(key) {
        return req(store.data.get(String(key)));
      },
      delete(key) {
        store.data.delete(String(key));
        return req(undefined);
      },
      getAll() {
        return req(Array.from(store.data.values()));
      },
      clear() {
        store.data.clear();
        return req(undefined);
      },
    };
  }

  const idb = {
    open(name, _ver) {
      const r = { result: null, error: null, onsuccess: null, onerror: null, onupgradeneeded: null };
      queueMicrotask(() => {
        let db = dbs.get(name);
        const isNew = !db;
        if (isNew) {
          db = { name, stores: new Map() };
          db.objectStoreNames = { contains: (s) => db.stores.has(s) };
          dbs.set(name, db);
        }
        // 🔴🔴 方法必须**在触发 onupgradeneeded 之前**挂到 db 上。
        //   真 IDB 里 createObjectStore 就是升级期间可用的（那正是它唯一能调用的时机），
        //   挂晚了 onupgradeneeded 会抛 "db.createObjectStore is not a function"，
        //   症状是所有 await putKey() 的用例集体 cancelled，根因却在垫片里。
        db.createObjectStore = (sname, opts) => {
          const st = { name: sname, keyPath: opts.keyPath, data: new Map() };
          db.stores.set(sname, st);
          return makeStore(st);
        };
        db.transaction = (storeNames, mode) => {
          const names = Array.isArray(storeNames) ? storeNames : [storeNames];
          void names;
          void mode;
          const t = {
            oncomplete: null,
            onerror: null,
            error: null,
            objectStore(sname) {
              const st = db.stores.get(sname);
              if (!st) throw new Error('objectStore 不存在: ' + sname);
              return makeStore(st);
            },
          };
          // 🔴 事务提交 = 所有 request 跑完之后才触发 oncomplete，且在**下一轮宏任务**，
          //   保证 await 拿到结果时事务确实已经提交。
          setTimeout(() => {
            if (t.oncomplete) t.oncomplete({ target: t });
          }, 0);
          return t;
        };
        db.close = () => {};
        r.result = db;
        if (isNew && r.onupgradeneeded) {
          r.onupgradeneeded({ target: r });
        }
        if (r.onsuccess) r.onsuccess({ target: r });
      });
      return r;
    },
    deleteDatabase(name) {
      dbs.delete(name);
      return req(undefined);
    },
  };
  globalThis.indexedDB = idb;
  return idb;
}

/** 一次性装齐并清空。返回 localStorage 便于断言。 */
export function installBrowserShims(initial) {
  const ls = installLocalStorage(initial);
  installIndexedDB();
  return ls;
}
