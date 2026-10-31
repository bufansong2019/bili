// localStorage 读写封装。
// 接受注入的 storage 对象而非直接引用 window，这样可以在 Node 下单测。

// localStorage 键前缀。改名会让已有收藏全部读不到，即使产品名换成 bili 也不要动。
const PREFIX = "bili-web:";
const KEY_FAVORITES = `${PREFIX}favorites`;

function safeParse(raw, fallback) {
  if (raw === null) return fallback;
  try {
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

/** 内存兜底存储。存储不可用时用它顶上，保证应用照常能用，只是不持久化。 */
export function createMemoryStorage() {
  const map = new Map();
  return {
    getItem: (key) => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => { map.set(key, String(value)); },
    removeItem: (key) => { map.delete(key); },
  };
}

/**
 * 取得一个可用的 localStorage，拿不到就返回 null。
 *
 * 不能只判断 `typeof localStorage === "undefined"` —— 那个守卫挡不住真正会炸的情况：
 *   · Safari 无痕模式 / 存储被禁：访问 localStorage 这个 getter 会**直接抛异常**，
 *     typeof 拦不住它，异常会从模块求值阶段冒出来，导致整个 app.js 导入失败、页面全死。
 *   · 存储被策略禁止：getter 返回 null，而 `typeof null === "object"` 会让守卫误判为可用。
 * 所以这里用 try/catch 包住，并且实际写一次探测 —— 有些环境属性存在但一写就抛。
 */
function detectStorage() {
  try {
    const candidate = globalThis.localStorage;
    if (!candidate) return null;
    const probe = `${PREFIX}__probe__`;
    candidate.setItem(probe, "1");
    candidate.removeItem(probe);
    return candidate;
  } catch {
    return null;
  }
}

/** 收藏以视频为单位 —— 多 P 视频整条收藏，不按分 P 拆。 */
export function favoriteKey(track) {
  return String(track.bvid);
}

/** 统一成分 P 列表。兼容旧版只存单个 page 的收藏。 */
function normalizeParts(item) {
  const raw = Array.isArray(item.parts) && item.parts.length > 0
    ? item.parts
    : [{ page: item.page ?? 1, title: item.title }];

  const parts = raw
    .filter((part) => part !== null && typeof part === "object")
    .map((part) => ({
      page: Number.isInteger(part.page) && part.page > 0 ? part.page : 1,
      title: typeof part.title === "string" && part.title ? part.title : item.title,
    }));

  if (parts.length === 0) parts.push({ page: 1, title: item.title });
  return parts;
}

function toFavorite(track) {
  return {
    bvid: track.bvid,
    title: track.videoTitle ?? track.title,
    author: track.author ?? "",
    pic: track.pic ?? "",
    parts: normalizeParts(track),
  };
}

export function isFavorite(favorites, track) {
  const key = favoriteKey(track);
  return favorites.some((item) => favoriteKey(item) === key);
}

/** 已收藏则移除，否则加到最前。返回新数组，不修改入参。 */
export function toggleFavorite(favorites, track) {
  const key = favoriteKey(track);
  if (favorites.some((item) => favoriteKey(item) === key)) {
    return favorites.filter((item) => favoriteKey(item) !== key);
  }
  return [toFavorite(track), ...favorites];
}

function isValidFavorite(item) {
  return item !== null
    && typeof item === "object"
    && typeof item.bvid === "string"
    && item.bvid.length > 0
    && typeof item.title === "string";
}

export function createStore(storage) {
  // 每次访问都包一层。存储可能在运行中失效（配额写满、权限被改），
  // 读写失败一律降级为「没存过 / 存不进去」，绝不让异常冒到调用方。
  const read = (key) => {
    try {
      return storage?.getItem(key) ?? null;
    } catch {
      return null;
    }
  };
  const write = (key, value) => {
    try {
      storage?.setItem(key, value);
    } catch {
      // 存储已满或不可用，静默放弃
    }
  };

  return {
    readFavorites() {
      const value = safeParse(read(KEY_FAVORITES), []);
      if (!Array.isArray(value)) return [];
      return value.filter(isValidFavorite).map((item) => ({
        bvid: item.bvid,
        title: item.title,
        author: typeof item.author === "string" ? item.author : "",
        pic: typeof item.pic === "string" ? item.pic : "",
        parts: normalizeParts(item),
      }));
    },

    writeFavorites(list) {
      write(KEY_FAVORITES, JSON.stringify(Array.isArray(list) ? list : []));
    },
  };
}

// 浏览器环境下的默认实例：优先真实存储，不可用则退到内存，保证页面永远能跑起来
export const store = createStore(detectStorage() ?? createMemoryStorage());
