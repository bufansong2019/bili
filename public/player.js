// 播放器状态机。纯逻辑，不接触 DOM，也不发起网络请求。
// 调用方负责根据返回的索引去解析直链、驱动 audio 元素。

// 三种互斥的播放模式：顺序播完即停、列表循环、随机播放
export const PLAYBACK_MODES = ["sequence", "list", "shuffle"];

export function createPlayerState() {
  return {
    queue: [],
    currentIndex: -1,
    // 默认顺序播放，播到队列末尾就停；需要连续播放时手动切模式
    mode: "sequence",
    randomRemaining: [],
    requestVersion: 0,
  };
}

/** 生成除 exclude 外的全部索引，并洗牌 */
function shuffledExcept(count, exclude) {
  const pool = [];
  for (let i = 0; i < count; i += 1) if (i !== exclude) pool.push(i);
  for (let i = pool.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }
  return pool;
}

export function currentTrack(state) {
  if (state.currentIndex < 0 || state.currentIndex >= state.queue.length) return null;
  return state.queue[state.currentIndex];
}

/** 装载队列并定位到 startIndex，返回实际落点 */
export function loadQueue(state, tracks, startIndex = 0) {
  state.queue = Array.isArray(tracks) ? tracks.slice() : [];
  state.requestVersion += 1;

  if (state.queue.length === 0) {
    state.currentIndex = -1;
    state.randomRemaining = [];
    return -1;
  }

  const clamped = Math.min(Math.max(startIndex, 0), state.queue.length - 1);
  state.currentIndex = clamped;
  // 每次装载都重置随机池，避免池里残留上一份队列的索引
  state.randomRemaining = state.mode === "shuffle"
    ? shuffledExcept(state.queue.length, clamped)
    : [];
  return clamped;
}

/**
 * 下一首。三种模式：
 * - sequence：顺序前进，到队尾返回 null
 * - list：顺序前进，到队尾回绕
 * - shuffle：从待播池取，抽完重新洗牌，一直随机下去
 */
export function nextTrack(state) {
  const count = state.queue.length;
  if (count === 0) return null;

  if (state.mode === "shuffle") {
    if (state.randomRemaining.length === 0) {
      state.randomRemaining = shuffledExcept(count, state.currentIndex);
      // 队列只有一首时没有别的可播，重播当前曲
      if (state.randomRemaining.length === 0) return state.currentIndex;
    }
    return state.randomRemaining.shift();
  }

  const next = state.currentIndex + 1;
  if (next < count) return next;
  return state.mode === "list" ? 0 : null;
}

/** 上一首。随机模式下退化为顺序上一个，行为可预期。 */
export function previousTrack(state) {
  const count = state.queue.length;
  if (count === 0) return null;

  const prev = state.currentIndex - 1;
  const target = prev >= 0 ? prev : (state.mode === "list" ? count - 1 : null);

  // 随机模式下退回的曲目可能还在待播池里。不摘掉的话，下一次「下一首」
  // 会抽到当前曲，playNext 会把它当成单曲队列直接重播。
  if (target !== null && state.mode === "shuffle") {
    state.randomRemaining = state.randomRemaining.filter((i) => i !== target);
  }
  return target;
}

export function setPlaybackMode(state, mode) {
  if (!PLAYBACK_MODES.includes(mode)) return;
  state.mode = mode;
  state.randomRemaining = mode === "shuffle" && state.queue.length > 0
    ? shuffledExcept(state.queue.length, state.currentIndex)
    : [];
}
