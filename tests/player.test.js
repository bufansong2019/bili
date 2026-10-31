import test from "node:test";
import assert from "node:assert/strict";
import {
  createPlayerState,
  loadQueue,
  currentTrack,
  nextTrack,
  previousTrack,
  setPlaybackMode,
} from "../public/player.js";

const tracks = (n) => Array.from({ length: n }, (_, i) => ({ bvid: `BV${i}` }));

test("装载队列后定位到起始项", () => {
  const state = createPlayerState();
  assert.equal(loadQueue(state, tracks(5), 2), 2);
  assert.equal(state.currentIndex, 2);
  assert.equal(currentTrack(state).bvid, "BV2");
});

test("起始索引越界时收敛到合法范围", () => {
  const state = createPlayerState();
  assert.equal(loadQueue(state, tracks(3), 99), 2);
  assert.equal(loadQueue(state, tracks(3), -5), 0);
});

test("空队列的当前曲目为 null", () => {
  const state = createPlayerState();
  assert.equal(loadQueue(state, [], 0), -1);
  assert.equal(currentTrack(state), null);
});

test("默认是顺序播放", () => {
  assert.equal(createPlayerState().mode, "sequence");
});

test("顺序模式到队尾返回 null", () => {
  const state = createPlayerState();
  loadQueue(state, tracks(3), 2);
  setPlaybackMode(state, "sequence");
  assert.equal(nextTrack(state), null);
});

test("列表模式到队尾回绕", () => {
  const state = createPlayerState();
  loadQueue(state, tracks(3), 2);
  setPlaybackMode(state, "list");
  assert.equal(nextTrack(state), 0);
});

test("随机模式覆盖全部曲目且不重复，且不含起始曲", () => {
  const state = createPlayerState();
  loadQueue(state, tracks(6), 0);
  setPlaybackMode(state, "shuffle");
  const picked = [];
  for (let i = 0; i < 5; i += 1) {
    const index = nextTrack(state);
    picked.push(index);
    state.currentIndex = index;
  }
  assert.equal(new Set(picked).size, 5, "不应重复");
  assert.ok(!picked.includes(0), "不应包含起始曲");
  assert.deepEqual([...picked].sort((a, b) => a - b), [1, 2, 3, 4, 5]);
});

test("随机池耗尽后重新洗牌并继续", () => {
  const state = createPlayerState();
  loadQueue(state, tracks(3), 0);
  setPlaybackMode(state, "shuffle");
  let current = 0;
  for (let i = 0; i < 2; i += 1) {
    current = nextTrack(state);
    state.currentIndex = current;
  }
  assert.ok(!state.randomRemaining.includes(current));
  const restarted = nextTrack(state);
  assert.ok(restarted !== null, "随机模式不应停下");
  assert.notEqual(restarted, current, "重洗后不应回到当前曲");
});

test("随机模式在单曲队列里重播当前曲", () => {
  const state = createPlayerState();
  loadQueue(state, tracks(1), 0);
  setPlaybackMode(state, "shuffle");
  assert.equal(nextTrack(state), 0);
});

test("切换回顺序模式后按索引前进", () => {
  const state = createPlayerState();
  loadQueue(state, tracks(4), 0);
  setPlaybackMode(state, "list");
  assert.equal(nextTrack(state), 1);
  setPlaybackMode(state, "sequence");
  assert.equal(state.randomRemaining.length, 0);
  assert.equal(nextTrack(state), 1);
});

test("上一首在队首的行为随模式变化", () => {
  const state = createPlayerState();
  loadQueue(state, tracks(3), 0);
  setPlaybackMode(state, "sequence");
  assert.equal(previousTrack(state), null);
  setPlaybackMode(state, "list");
  assert.equal(previousTrack(state), 2);
  setPlaybackMode(state, "shuffle");
  assert.equal(previousTrack(state), null);
});

test("多 P 视频的最后一 P 之后进入下一个视频", () => {
  const state = createPlayerState();
  const queue = [
    { bvid: "BV_A", page: 1 },
    { bvid: "BV_A", page: 2 },
    { bvid: "BV_B", page: 1 },
  ];
  loadQueue(state, queue, 1);
  setPlaybackMode(state, "list");
  assert.equal(nextTrack(state), 2);
});

test("顺序模式同样按队列顺序跨视频前进，到末尾才停", () => {
  const state = createPlayerState();
  const queue = [
    { bvid: "BV_A", page: 1 },
    { bvid: "BV_A", page: 2 },
    { bvid: "BV_B", page: 1 },
  ];
  loadQueue(state, queue, 1);
  setPlaybackMode(state, "sequence");
  assert.equal(nextTrack(state), 2);
  state.currentIndex = 2;
  assert.equal(nextTrack(state), null);
});

test("随机模式退回上一首后，下一首不会重播同一曲", () => {
  const state = createPlayerState();
  loadQueue(state, tracks(4), 0);
  setPlaybackMode(state, "shuffle");

  const first = nextTrack(state);
  state.currentIndex = first;
  const prev = previousTrack(state);
  state.currentIndex = prev;

  const next = nextTrack(state);
  assert.ok(next !== null);
  assert.notEqual(next, prev);
});

test("非法播放模式被忽略", () => {
  const state = createPlayerState();
  loadQueue(state, tracks(3), 1);
  setPlaybackMode(state, "single");
  assert.equal(state.mode, "sequence");
});

test("每次装载队列推进 requestVersion", () => {
  const state = createPlayerState();
  const before = state.requestVersion;
  loadQueue(state, tracks(2), 0);
  assert.equal(state.requestVersion, before + 1);
  loadQueue(state, tracks(2), 1);
  assert.equal(state.requestVersion, before + 2);
});

test("装载队列会重置随机池", () => {
  const state = createPlayerState();
  loadQueue(state, tracks(5), 0);
  setPlaybackMode(state, "shuffle");
  nextTrack(state);
  loadQueue(state, tracks(5), 3);
  assert.equal(state.randomRemaining.length, 4);
  assert.ok(!state.randomRemaining.includes(3));
});

test("随机池不包含当前曲，且每次装载都按新队列长度重建", () => {
  const state = createPlayerState();
  loadQueue(state, tracks(2), 0);
  setPlaybackMode(state, "shuffle");
  assert.equal(state.randomRemaining.length, 1);

  loadQueue(state, tracks(5), 0);
  assert.equal(state.randomRemaining.length, 4);
  assert.ok(!state.randomRemaining.includes(0));
});
