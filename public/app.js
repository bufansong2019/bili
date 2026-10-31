// 视图层：把数据渲染成 DOM，把交互翻译成状态变更。

import { favoriteKey, isFavorite, store, toggleFavorite } from "./store.js";
import { requestJson } from "./api.js";
import {
  PLAYBACK_MODES,
  createPlayerState,
  loadQueue,
  currentTrack,
  nextTrack,
  previousTrack,
  setPlaybackMode,
} from "./player.js";

const $ = (id) => document.getElementById(id);

const els = {
  form: $("bvid-form"),
  input: $("bvid-input"),
  button: $("bvid-button"),
  status: $("status"),
  player: $("player"),
  cover: $("player-cover"),
  title: $("player-title"),
  author: $("player-author"),
  play: $("ctl-play"),
  prev: $("ctl-prev"),
  next: $("ctl-next"),
  mode: $("ctl-mode"),
  seek: $("seek"),
  timeCurrent: $("time-current"),
  timeTotal: $("time-total"),
  audio: $("audio"),
  fav: $("ctl-fav"),
  favList: $("favorites-list"),
  favEmpty: $("favorites-empty"),
  toast: $("toast"),
  toastUndo: $("toast-undo"),
};

const MODE_ICON_IDS = {
  sequence: "#icon-arrow-right-to-line",
  list: "#icon-repeat",
  shuffle: "#icon-shuffle",
};
const MODE_LABELS = { sequence: "顺序播放", list: "列表循环", shuffle: "随机播放" };
const MAX_CONSECUTIVE_FAILURES = 5;
const UNDO_TIMEOUT_MS = 5000;

const playerState = createPlayerState();
let consecutiveFailures = 0;
let audioVersion = null;      // 与 requestVersion 对应，用于丢弃迟到的 audio 事件
let seeking = false;
let reResolvedForCurrentTrack = false; // 本轮是否已经为「链接过期」重解析过
let favorites = store.readFavorites();
const expandedFavorites = new Set(); // 展开了分 P 的收藏，按 bvid 记
let undoRemoval = null; // { favorite, index, anchor }，等待撤销的最近一次删除
let undoTimer = null;
let openRequestVersion = 0; // 防止并发打开时旧结果覆盖新选择

// ---------- 状态提示 ----------

function setStatus(text, kind = "") {
  if (!text) {
    els.status.hidden = true;
    return;
  }
  els.status.hidden = false;
  els.status.className = kind ? `status is-${kind}` : "status";
  els.status.textContent = text;
}

// ---------- 工具 ----------

function formatDuration(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return "0:00";
  const total = Math.floor(seconds);
  const minutes = Math.floor(total / 60);
  return `${minutes}:${String(total % 60).padStart(2, "0")}`;
}

// B站图片 CDN 支持在地址后面直接缀尺寸参数来裁剪。
// 原图有 440KB 左右，播放条只显示 44px —— 不裁剪的话一屏就是好几 MB。
const COVER_PLAYER = "@256w_256h_1c.webp"; // ~11KB

/**
 * 归一化封面地址。
 * B站返回的可能是 `//` 开头，也可能是 `http://` 开头 ——
 * 部署后页面在 HTTPS 下，http 图片会被浏览器当混合内容直接拦掉，所以一律升到 https。
 */
function coverUrl(raw, size = "") {
  if (!raw) return "";
  const base = raw.startsWith("//")
    ? `https:${raw}`
    : raw.replace(/^http:\/\//i, "https://");

  // 有些地址本身已经带了尺寸后缀，再追加会拼出无效路径，那就原样用
  if (!size || base.includes("@")) return base;
  return `${base}${size}`;
}

/** 播放接口的地址。 */
function playurlUrl(track) {
  return `/api/playurl?bvid=${encodeURIComponent(track.bvid)}&page=${track.page ?? 1}`;
}

/**
 * 从任意输入里抠出 BV 号。接受裸 BV 号，也接受含 BV 号的完整链接。
 *
 * 这是全仓唯一一份实现，只能放在这里：Worker 的静态资源目录是 ./public，
 * 浏览器够不到 /core/，从前端 import core/ 会让整个 app.js 加载失败。
 */
const BVID_IN_TEXT = /BV[0-9A-Za-z]{10}/;

function parseBvidInput(text) {
  const match = String(text ?? "").match(BVID_IN_TEXT);
  return match ? match[0] : null;
}

// ---------- 播放 ----------

/** 播放条高度随内容/字体/安全区变化，量出来再喂给布局，别硬编码 */
function syncPlayerHeight() {
  if (els.player.hidden) return;
  document.documentElement.style.setProperty("--player-height", `${els.player.offsetHeight}px`);
}

function showPlayer(track) {
  els.player.hidden = false;
  els.title.textContent = track.title;
  els.author.textContent = track.author ?? "";

  const cover = coverUrl(track.pic, COVER_PLAYER);
  if (cover) els.cover.src = cover;
  else els.cover.removeAttribute("src");
  els.cover.alt = track.title;

  syncPlayerHeight();
  updateFavoriteButton();
  markActiveFavorite();
}

function setIcon(button, href) {
  button.querySelector("use")?.setAttribute("href", href);
}

function updateControls() {
  const paused = els.audio.paused;

  els.mode.classList.toggle("is-on", playerState.mode !== "sequence");
  setIcon(els.mode, MODE_ICON_IDS[playerState.mode]);
  els.mode.title = MODE_LABELS[playerState.mode];
  els.mode.setAttribute("aria-label", els.mode.title);

  setIcon(els.play, paused ? "#icon-play" : "#icon-pause");
  els.play.title = paused ? "播放" : "暂停";
  els.play.setAttribute("aria-label", els.play.title);
}

function updateMediaSession(track) {
  if (!("mediaSession" in navigator)) return;
  navigator.mediaSession.metadata = new MediaMetadata({
    title: track.title,
    artist: track.author ?? "",
    // 已知限制：锁屏封面这张图是浏览器自己去取的，MediaMetadata 没有
    // referrerPolicy 可设，所以很可能因为防盗链 403 而不显示。
    // 留在这里是因为个别浏览器行为不同，且没有它也不影响播放。
    artwork: track.pic ? [{ src: coverUrl(track.pic) }] : [],
  });
}

function registerMediaSessionHandlers() {
  if (!("mediaSession" in navigator)) return;
  const handlers = {
    play: () => els.audio.play().catch(() => {}),
    pause: () => els.audio.pause(),
    previoustrack: playPrevious,
    nexttrack: () => playNext(),
    seekbackward: () => { els.audio.currentTime = Math.max(0, els.audio.currentTime - 10); },
    seekforward: () => { els.audio.currentTime = Math.min(els.audio.duration || 0, els.audio.currentTime + 10); },
    seekto: (details) => {
      if (typeof details.seekTime === "number") els.audio.currentTime = details.seekTime;
    },
  };
  for (const [action, handler] of Object.entries(handlers)) {
    try {
      navigator.mediaSession.setActionHandler(action, handler);
    } catch {
      // 浏览器不支持该动作时忽略，不影响其余动作
    }
  }
}

/** 开始时解析当前曲目的直链并播放 */
async function loadCurrentTrack({ positionSeconds = 0, loadingLabel = "正在解析…" } = {}) {
  const track = currentTrack(playerState);
  if (!track) return;

  // 换歌即重置「已重解析」门闩，让每首歌都有一次机会。
  // 但**不能**无条件重置：重解析走的也是这个函数（positionSeconds > 0），
  // 在函数开头无条件清掉门闩，等于让重解析把自己的门闩擦掉 ——
  // 「播起来之后又挂掉」的那首歌照样无限重解析。只有从头开始（换歌、
  // 首次播放）才重置，带播放位置的重解析调用必须保留门闩。
  if (positionSeconds <= 0) reResolvedForCurrentTrack = false;

  // 每次加载自增代号，任何 await 之后都要复核，迟到的旧结果一律作废
  const version = ++playerState.requestVersion;
  showPlayer(track);
  // 解析提示写在作者行，不再占用顶部状态栏 —— 后者只在报错时出现，
  // 避免正常播放时状态条一出现又消失、把下面的列表顶来顶去。
  els.author.textContent = loadingLabel;

  try {
    const info = await requestJson(playurlUrl(track));
    if (version !== playerState.requestVersion) return;

    if (positionSeconds > 0) {
      // 只对这一次加载生效：如果这轮重解析失败/被换歌取代，
      // 迟到的 loadedmetadata 不能把下一首歌 seek 到旧位置。
      els.audio.addEventListener(
        "loadedmetadata",
        () => {
          if (version !== playerState.requestVersion) return;
          els.audio.currentTime = positionSeconds;
        },
        { once: true },
      );
    }

    audioVersion = version;
    els.audio.src = info.streamUrl;
    els.audio.load();

    await els.audio.play();
    if (version !== playerState.requestVersion) return;

    consecutiveFailures = 0;
    els.author.textContent = track.author ?? "";
    updateMediaSession(track);
    setStatus("");
  } catch (error) {
    if (version !== playerState.requestVersion) return;
    // 无论是主动暂停导致的 AbortError 还是真的失败，都不能停在加载文案上
    els.author.textContent = track.author ?? "";
    if (error.name === "AbortError") return;
    // 不把 error.message 传进去：那是英文原文（浏览器的 DOMException、core/ 的
    // 错误串），漏到界面上就破坏了全中文的约束。文案由这里统一决定。
    handlePlaybackFailure();
  }
}

function handlePlaybackFailure() {
  consecutiveFailures += 1;
  if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
    // 连败到底就停下，并且给一个重置连击计数的重试入口，
    // 否则用户手动重试也没法突破已经攒满的失败计数
    showRetry("队列中多首无法播放，已停止", () => {
      consecutiveFailures = 0;
      loadCurrentTrack();
    });
    return;
  }
  setStatus(`第 ${consecutiveFailures} 首播放失败，跳到下一首`, "error");
  playNext({ preserveFailureStreak: true });
}

function playNext({ preserveFailureStreak = false } = {}) {
  const index = nextTrack(playerState);
  if (index === null) {
    setStatus("队列播放完毕");
    els.audio.pause();
    updateControls();
    return;
  }
  if (!preserveFailureStreak) consecutiveFailures = 0;

  // 列表循环或随机模式下队列只有一首时，nextTrack 会返回当前索引本身。
  // 这时直接重播，不要走 loadCurrentTrack —— 那会重新解析一次直链，
  // 既白跑一次网络请求，又会让音频中断一下。
  if (index === playerState.currentIndex) {
    els.audio.currentTime = 0;
    els.audio.play().catch(() => {});
    return;
  }

  playerState.currentIndex = index;
  loadCurrentTrack();
}

function playPrevious() {
  // 播放超过 3 秒时，"上一首"先回到本曲开头
  if (els.audio.currentTime > 3) {
    els.audio.currentTime = 0;
    return;
  }
  const index = previousTrack(playerState);
  if (index === null) return;
  consecutiveFailures = 0;
  playerState.currentIndex = index;
  loadCurrentTrack();
}

// ---------- 收藏夹 ----------

function updateFavoriteButton() {
  const track = currentTrack(playerState);
  const on = track ? isFavorite(favorites, track) : false;
  els.fav.classList.toggle("is-on", on);
  els.fav.disabled = !track;
  els.fav.title = on ? "取消收藏" : "收藏";
  els.fav.setAttribute("aria-label", els.fav.title);
}

function markActiveFavorite() {
  const track = currentTrack(playerState);
  const key = track ? favoriteKey(track) : "";
  const page = track ? String(track.page ?? 1) : "";
  for (const item of els.favList.children) {
    const active = key !== "" && item.dataset.key === key;
    item.classList.toggle("is-active", active);
    for (const part of item.querySelectorAll(".fav-part")) {
      part.classList.toggle("is-current", active && part.dataset.page === page);
    }
  }
  scrollCurrentPartIntoView();
}

/** 展开区限高滚动时，把当前分 P 带进可视范围（只滚内部容器，不滚页面） */
function scrollCurrentPartIntoView() {
  const current = els.favList.querySelector(".fav-part.is-current");
  const list = current?.closest(".fav-parts");
  if (!current || !list) return;

  const offset = current.getBoundingClientRect().top - list.getBoundingClientRect().top;
  const visible = offset >= 0 && offset + current.offsetHeight <= list.clientHeight;
  if (!visible) list.scrollTop += offset - 8;
}

function createFavoriteRow(favorite, index) {
  const item = document.createElement("li");
  item.className = "fav-item";
  item.dataset.key = favoriteKey(favorite);

  const row = document.createElement("div");
  row.className = "fav-row";

  const play = document.createElement("button");
  play.type = "button";
  play.className = "fav-play";
  play.addEventListener("click", () => playFavorite(index));

  const cover = document.createElement("img");
  cover.className = "fav-cover";
  cover.alt = "";
  // 与播放条封面同一套防盗链：不带 Referer 才不会被 B站图片 CDN 403
  cover.referrerPolicy = "no-referrer";
  cover.loading = "lazy";
  const coverSrc = coverUrl(favorite.pic, COVER_PLAYER);
  if (coverSrc) cover.src = coverSrc;

  const meta = document.createElement("div");
  meta.className = "fav-meta";
  const title = document.createElement("div");
  title.className = "fav-title";
  title.textContent = favorite.title;
  const author = document.createElement("div");
  author.className = "fav-author";

  // readFavorites / toggleFavorite 保证每个收藏都有非空 parts
  const parts = favorite.parts;
  author.textContent = parts.length > 1
    ? [favorite.author, `${parts.length} P`].filter(Boolean).join(" · ")
    : favorite.author ?? "";
  meta.append(title, author);
  play.append(cover, meta);
  row.append(play);

  const expanded = parts.length > 1 && expandedFavorites.has(favoriteKey(favorite));
  if (parts.length > 1) {
    const toggle = document.createElement("button");
    toggle.type = "button";
    toggle.className = "fav-toggle";
    toggle.classList.toggle("is-open", expanded);
    toggle.title = expanded ? "收起分 P" : "展开分 P";
    toggle.setAttribute("aria-label", toggle.title);
    toggle.setAttribute("aria-expanded", String(expanded));
    toggle.innerHTML = '<svg class="icon" aria-hidden="true"><use href="#icon-chevron-down"></use></svg>';
    toggle.addEventListener("click", () => toggleFavoriteExpanded(index));
    row.append(toggle);
  }

  const remove = document.createElement("button");
  remove.type = "button";
  remove.className = "fav-remove";
  remove.title = "取消收藏";
  remove.setAttribute("aria-label", `取消收藏：${favorite.title}`);
  remove.innerHTML = '<svg class="icon" aria-hidden="true"><use href="#icon-x"></use></svg>';
  remove.addEventListener("click", (event) => {
    // 双击的第二下会落在下一行的删除键上，直接忽略
    if (event.detail > 1) return;
    removeFavorite(index);
  });
  row.append(remove);

  item.append(row);

  if (expanded) {
    const list = document.createElement("ul");
    list.className = "fav-parts";
    for (const part of parts) {
      const partItem = document.createElement("li");
      const button = document.createElement("button");
      button.type = "button";
      button.className = "fav-part";
      button.dataset.page = String(part.page);
      button.textContent = part.title;
      button.addEventListener("click", () => playFavoritePart(index, part.page));
      partItem.append(button);
      list.append(partItem);
    }
    item.append(list);
  }

  return item;
}

function renderFavorites() {
  const scrollTops = new Map();
  for (const item of els.favList.children) {
    const parts = item.querySelector(".fav-parts");
    if (parts) scrollTops.set(item.dataset.key, parts.scrollTop);
  }

  els.favEmpty.hidden = favorites.length > 0;
  els.favList.replaceChildren(...favorites.map(createFavoriteRow));
  markActiveFavorite();

  // 恢复各展开区原来的滚动位置；新展开的没有记录，保留滚到当前曲的结果
  for (const item of els.favList.children) {
    const top = scrollTops.get(item.dataset.key);
    if (top === undefined) continue;
    const parts = item.querySelector(".fav-parts");
    if (parts) parts.scrollTop = top;
  }
  updateFavoriteButton();
}

/** 收藏和 BV 输入共用同一套曲目结构，避免两处字段定义漂移。 */
function makeTracks({ bvid, title, author, pic, parts }) {
  return parts.map((part) => ({
    bvid,
    page: part.page,
    title: part.title,
    author,
    pic,
    videoTitle: title,
    parts,
  }));
}

/** 一条收藏 = 一个视频；多 P 视频在这里展开成多条曲目。 */
function tracksFromFavorite(favorite) {
  return makeTracks({
    bvid: favorite.bvid,
    title: favorite.title,
    author: favorite.author,
    pic: favorite.pic,
    parts: favorite.parts,
  });
}

function buildFavoriteQueue() {
  const queue = [];
  const starts = [];
  favorites.forEach((favorite) => {
    starts.push(queue.length);
    queue.push(...tracksFromFavorite(favorite));
  });
  return { queue, starts };
}

function toggleFavoriteExpanded(index) {
  const favorite = favorites[index];
  if (!favorite) return;
  const key = favoriteKey(favorite);
  if (expandedFavorites.has(key)) expandedFavorites.delete(key);
  else expandedFavorites.add(key);

  // 只重建这一行：整表重渲染会重载所有封面、重置其它展开区的滚动位置
  const item = [...els.favList.children].find((el) => el.dataset.key === key);
  if (item) item.replaceWith(createFavoriteRow(favorite, index));
  else renderFavorites();
  markActiveFavorite();
}

/** 装载队列并开始播放，三条入口共用 */
function startQueue(queue, startIndex) {
  loadQueue(playerState, queue, startIndex);
  consecutiveFailures = 0;
  setStatus("");
  loadCurrentTrack();
}

function playFavorite(index) {
  if (!favorites[index]) return;
  // 整份收藏展开成队列；点中的那条从它的第 1 P 开始
  const { queue, starts } = buildFavoriteQueue();
  startQueue(queue, starts[index]);
}

/** 从某个收藏的指定分 P 开始播 */
function playFavoritePart(index, page) {
  const favorite = favorites[index];
  if (!favorite) return;
  const offset = favorite.parts.findIndex((part) => part.page === page);
  if (offset < 0) return;
  const { queue, starts } = buildFavoriteQueue();
  startQueue(queue, starts[index] + offset);
}

function removeFavorite(index) {
  const removed = favorites[index];
  if (!removed) return;
  const anchor = index > 0 ? favoriteKey(favorites[index - 1]) : null;
  favorites = favorites.filter((_, i) => i !== index);
  store.writeFavorites(favorites);
  renderFavorites();
  showUndoToast(removed, index, anchor);
}

function showUndoToast(favorite, index, anchor) {
  undoRemoval = { favorite, index, anchor };
  els.toast.hidden = false;
  clearTimeout(undoTimer);
  undoTimer = setTimeout(() => {
    undoTimer = null;
    undoRemoval = null;
    els.toast.hidden = true;
  }, UNDO_TIMEOUT_MS);
}

function undoRemove() {
  if (!undoRemoval) return;
  const { favorite, index, anchor } = undoRemoval;
  undoRemoval = null;
  clearTimeout(undoTimer);
  undoTimer = null;
  els.toast.hidden = true;

  // 期间可能已经用星标重新收藏过，避免插出重复项
  if (isFavorite(favorites, favorite)) return;

  // 优先插回原来前一项的后面；前一项也被删了就退回旧下标
  let at = index;
  if (anchor !== null) {
    const anchorIndex = favorites.findIndex((item) => favoriteKey(item) === anchor);
    if (anchorIndex >= 0) at = anchorIndex + 1;
  }
  at = Math.min(Math.max(at, 0), favorites.length);

  favorites = [...favorites.slice(0, at), favorite, ...favorites.slice(at)];
  store.writeFavorites(favorites);
  renderFavorites();
}

function toggleCurrentFavorite() {
  const track = currentTrack(playerState);
  if (!track) return;
  favorites = toggleFavorite(favorites, track);
  store.writeFavorites(favorites);
  renderFavorites();
}

// ---------- 事件绑定 ----------

els.form.addEventListener("submit", (event) => {
  event.preventDefault();
  openByBvid(els.input.value);
});

els.play.addEventListener("click", () => {
  // 首次解析失败时 audio 还没有 src，播放键此时是唯一的重试入口
  if (!els.audio.src) {
    loadCurrentTrack();
    return;
  }
  if (els.audio.paused) {
    els.audio.play().catch(() => handlePlaybackFailure());
  } else {
    els.audio.pause();
  }
});

els.next.addEventListener("click", () => playNext());
els.prev.addEventListener("click", playPrevious);
els.fav.addEventListener("click", toggleCurrentFavorite);
els.toastUndo.addEventListener("click", undoRemove);

els.mode.addEventListener("click", () => {
  const next = PLAYBACK_MODES[
    (PLAYBACK_MODES.indexOf(playerState.mode) + 1) % PLAYBACK_MODES.length
  ];
  setPlaybackMode(playerState, next);
  updateControls();
});

els.seek.addEventListener("input", () => {
  seeking = true;
  if (Number.isFinite(els.audio.duration)) {
    els.timeCurrent.textContent = formatDuration(
      (Number(els.seek.value) / 1000) * els.audio.duration,
    );
  }
});

els.seek.addEventListener("change", () => {
  if (Number.isFinite(els.audio.duration)) {
    els.audio.currentTime = (Number(els.seek.value) / 1000) * els.audio.duration;
  }
  seeking = false;
});

els.audio.addEventListener("play", () => {
  updateControls();
  if ("mediaSession" in navigator) navigator.mediaSession.playbackState = "playing";
});
els.audio.addEventListener("pause", () => {
  updateControls();
  if ("mediaSession" in navigator) navigator.mediaSession.playbackState = "paused";
});
els.audio.addEventListener("timeupdate", () => {
  if (!seeking && Number.isFinite(els.audio.duration) && els.audio.duration > 0) {
    els.seek.value = String((els.audio.currentTime / els.audio.duration) * 1000);
  }
  els.timeCurrent.textContent = formatDuration(els.audio.currentTime);
});

els.audio.addEventListener("loadedmetadata", () => {
  els.timeTotal.textContent = formatDuration(els.audio.duration);
});

els.audio.addEventListener("ended", () => {
  // 只有当前这一轮加载的 audio 才允许触发跳曲，避免旧元素的迟到事件打断新曲
  if (audioVersion !== playerState.requestVersion) return;
  playNext();
});

els.audio.addEventListener("error", () => {
  if (audioVersion !== playerState.requestVersion) return;
  // 直链有效期 1 小时。暂停较久后继续播放可能撞上过期，重解析一次再试
  const position = els.audio.currentTime;
  // 每首歌只给一次重解析机会。不加这个门闩的话，如果一首歌每次都在
  // position > 0 之后挂掉，就会无限重解析 —— 因为这条分支不递增失败计数，
  // 永远到不了停机阈值，用户也永远看不到报错。
  if (position > 0 && !reResolvedForCurrentTrack) {
    reResolvedForCurrentTrack = true;
    loadCurrentTrack({
      positionSeconds: position,
      loadingLabel: "链接已过期，正在重新解析…",
    });
    return;
  }
  handlePlaybackFailure();
});

// ---------- BV 号输入 ----------

/** 输入 BV 号 → 拉分P → 整条入队 → 从第一首开始播 */
async function openByBvid(raw) {
  const bvid = parseBvidInput(raw);
  if (!bvid) {
    showRetry("没找到 BV 号，请检查后重试", () => els.button.click());
    return;
  }

  const version = ++openRequestVersion;
  els.button.disabled = true;
  els.button.textContent = "获取中…";
  // 清掉上一次的错误和它的重试按钮，避免连点重试并发多个请求
  setStatus("");

  try {
    const info = await requestJson(`/api/video?bvid=${encodeURIComponent(bvid)}`);
    if (version !== openRequestVersion) return;

    const parts = info.pages.map((p) => ({
      page: p.page,
      title: info.pages.length > 1 ? `${p.page}. ${p.part}` : info.title,
    }));
    const tracks = makeTracks({
      bvid: info.bvid,
      title: info.title,
      author: info.author,
      pic: info.pic,
      parts,
    });
    startQueue(tracks, 0);
    els.input.value = "";
  } catch (error) {
    if (version !== openRequestVersion) return;
    showRetry(error.message, () => openByBvid(raw));
  } finally {
    // 旧请求收尾时不能动新请求的按钮状态
    if (version === openRequestVersion) {
      els.button.disabled = false;
      els.button.textContent = "播放";
    }
  }
}

function showRetry(message, onRetry) {
  els.status.hidden = false;
  els.status.className = "status is-error";
  els.status.replaceChildren();

  const text = document.createElement("span");
  text.textContent = message;

  const retry = document.createElement("button");
  retry.type = "button";
  retry.className = "retry";
  retry.textContent = "重试";
  retry.addEventListener("click", onRetry);

  els.status.append(text, retry);
}

// ---------- 启动 ----------

registerMediaSessionHandlers();

// 封面图必须声明 no-referrer，否则加载不出来：
// B站的图片 CDN 和音频 CDN 是同一套防盗链 —— 只放行「不带 Referer」或
// 「Referer 是 bilibili.com」。浏览器默认会把我们页面的地址当 Referer 发过去，
// 于是图片一律 403。声明后浏览器干脆不发 Referer，实测返回 200。
els.cover.referrerPolicy = "no-referrer";

// 播放条高度由内容决定（字体、安全区、换行都会变），量出来同步给布局
if ("ResizeObserver" in globalThis) {
  new ResizeObserver(syncPlayerHeight).observe(els.player);
}

renderFavorites();
updateControls();
