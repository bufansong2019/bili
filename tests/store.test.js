import test from "node:test";
import assert from "node:assert/strict";
import {
  createMemoryStorage,
  createStore,
  favoriteKey,
  isFavorite,
  toggleFavorite,
} from "../public/store.js";

const KEY = "bili-web:favorites";
const PIC = "//i0.hdslb.com/bfs/archive/x.jpg";

const favorite = (bvid, extra = {}) => ({
  bvid,
  title: `视频 ${bvid}`,
  author: "作者",
  pic: PIC,
  parts: [{ page: 1, title: `视频 ${bvid}` }],
  ...extra,
});

const track = (bvid, page = 1, extra = {}) => ({
  bvid,
  page,
  title: `第 ${page} P`,
  author: "作者",
  pic: PIC,
  videoTitle: `视频 ${bvid}`,
  ...extra,
});

test("收藏写入后能原样读回", () => {
  const store = createStore(createMemoryStorage());
  const list = [
    favorite("BV1"),
    favorite("BV2", {
      parts: [
        { page: 1, title: "1. 上" },
        { page: 2, title: "2. 下" },
      ],
    }),
  ];
  store.writeFavorites(list);
  assert.deepEqual(store.readFavorites(), list);
});

test("没有存过收藏时返回空数组", () => {
  assert.deepEqual(createStore(createMemoryStorage()).readFavorites(), []);
});

test("存坏的 JSON 返回空数组而不是抛异常", () => {
  const storage = createMemoryStorage();
  storage.setItem(KEY, "{坏数据");
  assert.deepEqual(createStore(storage).readFavorites(), []);
});

test("非数组内容返回空数组", () => {
  const storage = createMemoryStorage();
  storage.setItem(KEY, JSON.stringify({ bvid: "BV1" }));
  assert.deepEqual(createStore(storage).readFavorites(), []);
});

test("过滤非法条目并补全缺省字段", () => {
  const storage = createMemoryStorage();
  storage.setItem(KEY, JSON.stringify([
    null,
    {},
    { bvid: "", title: "空 BV" },
    { bvid: "BV_OK", title: "有效", page: 0, author: 123, pic: null, parts: "坏" },
  ]));
  assert.deepEqual(createStore(storage).readFavorites(), [
    {
      bvid: "BV_OK",
      title: "有效",
      author: "",
      pic: "",
      parts: [{ page: 1, title: "有效" }],
    },
  ]);
});

test("旧版单 P 收藏能迁移成 parts", () => {
  const storage = createMemoryStorage();
  storage.setItem(KEY, JSON.stringify([
    { bvid: "BV_OLD", page: 3, title: "老收藏" },
  ]));
  assert.deepEqual(createStore(storage).readFavorites(), [
    {
      bvid: "BV_OLD",
      title: "老收藏",
      author: "",
      pic: "",
      parts: [{ page: 3, title: "老收藏" }],
    },
  ]);
});

test("存储读写抛异常时全部降级，不向调用方抛错", () => {
  // 模拟 Safari 无痕模式 / 配额写满：属性在，但一碰就抛
  const hostile = {
    getItem: () => { throw new Error("SecurityError"); },
    setItem: () => { throw new Error("QuotaExceededError"); },
    removeItem: () => { throw new Error("SecurityError"); },
  };
  const store = createStore(hostile);

  assert.deepEqual(store.readFavorites(), []);
  store.writeFavorites([favorite("BV1")]);
  assert.deepEqual(store.readFavorites(), []);
});

test("存储为 null 时同样不崩溃", () => {
  const store = createStore(null);
  assert.deepEqual(store.readFavorites(), []);
  store.writeFavorites([favorite("BV1")]);
  assert.deepEqual(store.readFavorites(), []);
});

test("favoriteKey 以视频为单位，与分 P 无关", () => {
  assert.equal(favoriteKey({ bvid: "BV1", page: 1 }), "BV1");
  assert.equal(favoriteKey({ bvid: "BV1", page: 9 }), "BV1");
});

test("isFavorite 命中同一视频的任意分 P", () => {
  const list = [
    favorite("BV1", {
      parts: [
        { page: 1, title: "1. 上" },
        { page: 2, title: "2. 下" },
      ],
    }),
  ];
  assert.ok(isFavorite(list, track("BV1", 2)));
  assert.ok(!isFavorite(list, track("BV2", 2)));
});

test("收藏单 P 时回落到单条 parts，并清理多余字段", () => {
  const next = toggleFavorite([], track("BV1", 1, { durationSeconds: 300 }));
  assert.deepEqual(next, [
    {
      bvid: "BV1",
      title: "视频 BV1",
      author: "作者",
      pic: PIC,
      parts: [{ page: 1, title: "第 1 P" }],
    },
  ]);
});

test("收藏多 P 时保存全部分 P，列表标题用视频标题", () => {
  const parts = [
    { page: 1, title: "1. 上" },
    { page: 2, title: "2. 下" },
  ];
  const next = toggleFavorite([], track("BV1", 2, { title: "2. 下", parts }));
  assert.equal(next.length, 1);
  assert.equal(next[0].title, "视频 BV1");
  assert.deepEqual(next[0].parts, parts);
});

test("取消收藏按视频移除，不受当前分 P 影响", () => {
  const list = [
    favorite("BV1", {
      parts: [
        { page: 1, title: "1. 上" },
        { page: 2, title: "2. 下" },
      ],
    }),
    favorite("BV2"),
  ];
  const next = toggleFavorite(list, track("BV1", 2));
  assert.deepEqual(next.map(favoriteKey), ["BV2"]);
});

test("取消后重新收藏能恢复全部分 P", () => {
  const parts = [
    { page: 1, title: "1. 上" },
    { page: 2, title: "2. 下" },
  ];
  let list = toggleFavorite([], track("BV1", 1, { parts }));
  list = toggleFavorite(list, track("BV1", 2, { parts }));
  assert.deepEqual(list, []);
  list = toggleFavorite(list, track("BV1", 2, { parts }));
  assert.equal(list[0].parts.length, 2);
});
