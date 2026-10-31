import test from "node:test";
import assert from "node:assert/strict";
import { isValidBvid, issueGuestIdentity } from "../core/bili.js";

test("BV 号格式校验", () => {
  assert.ok(isValidBvid("BV1BZbSzZEGT"));
  assert.ok(!isValidBvid("bv1BZbSzZEGT"), "小写前缀不合法");
  assert.ok(!isValidBvid("BV1BZbSzZEG"), "长度不足");
  assert.ok(!isValidBvid("BV1BZbSzZEGTT"), "长度超限");
  assert.ok(!isValidBvid("AV123456"), "非 BV 号");
  assert.ok(!isValidBvid(""));
  assert.ok(!isValidBvid(null));
});

const SPI_URL = "https://api.bilibili.com/x/frontend/finger/spi";
const HOME_URL = "https://www.bilibili.com/";

function fakeResponse({ status = 200, json, setCookies = [] }) {
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: {
      getSetCookie: () => setCookies,
      get: () => null,
    },
    json: async () => json,
  };
}

test("游客身份优先走 SPI，不再请求首页", async () => {
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(url);
    if (url === SPI_URL) {
      return fakeResponse({ json: { code: 0, data: { b_3: "B3", b_4: "B4" } } });
    }
    throw new Error("首页不应被请求");
  };

  const guest = await issueGuestIdentity(fetchImpl);
  assert.deepEqual(calls, [SPI_URL]);
  assert.equal(guest.header, "buvid3=B3; buvid4=B4");
});

test("SPI 被 412 时回落到首页 Set-Cookie", async () => {
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(url);
    if (url === SPI_URL) return fakeResponse({ status: 412 });
    return fakeResponse({
      setCookies: [
        "buvid3=HOME3; Path=/",
        "buvid4=HOME4; Path=/",
        "b_nut=1700000000; Path=/",
      ],
    });
  };

  const guest = await issueGuestIdentity(fetchImpl);
  assert.deepEqual(calls, [SPI_URL, HOME_URL]);
  assert.equal(guest.header, "buvid3=HOME3; buvid4=HOME4; b_nut=1700000000");
});

test("SPI 与首页都失败时，错误信息同时带上两边的线索", async () => {
  const fetchImpl = async (url) => fakeResponse({ status: 412, json: { code: -412 } });

  await assert.rejects(
    () => issueGuestIdentity(fetchImpl),
    (error) => /SPI/.test(error.message) && /homepage/.test(error.message),
  );
});
