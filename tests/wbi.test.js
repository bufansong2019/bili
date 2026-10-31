import test from "node:test";
import assert from "node:assert/strict";
import { genMixinKey, signParameters } from "../core/wbi.js";

test("mixinKey 置换表与官方文档一致", () => {
  const raw = "7cd084941338484aae1ad9425b84077c4932caff0ff746eab6f01bf08b70ac45";
  assert.equal(genMixinKey(raw), "ea1db124af3c7062474693fa704f4ff8");
});

test("WBI 签名与官方文档一致", () => {
  const signed = signParameters(
    { foo: "114", bar: "514", zab: "1919810" },
    "ea1db124af3c7062474693fa704f4ff8",
    1702204169,
  );
  assert.equal(
    signed,
    "bar=514&foo=114&wts=1702204169&zab=1919810&w_rid=8f6f2b5b3d485fe1886cec6a0be8c5d4",
  );
});

test("百分号编码与 encodeURIComponent 对齐", () => {
  const signed = signParameters({ bar: "五一四", foo: "one one four" }, "mixin", 1);
  assert.ok(
    signed.startsWith("bar=%E4%BA%94%E4%B8%80%E5%9B%9B&foo=one%20one%20four&wts=1&"),
    `实际得到 ${signed}`,
  );
});

test("参数按 key 字典序排序，与传入顺序无关", () => {
  const a = signParameters({ zebra: "1", alpha: "2" }, "k", 100);
  const b = signParameters({ alpha: "2", zebra: "1" }, "k", 100);
  assert.equal(a, b);
});
