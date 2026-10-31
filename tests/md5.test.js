import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { md5 } from "../core/md5.js";

const VECTORS = [
  "",
  "abc",
  "The quick brown fox jumps over the lazy dog",
  "wts=1702204169中文",
];

test("md5 与 Node 内建 crypto 结果一致", () => {
  for (const input of VECTORS) {
    const reference = createHash("md5").update(input, "utf8").digest("hex");
    assert.equal(md5(input), reference, `输入 ${JSON.stringify(input)} 不匹配`);
  }
});
