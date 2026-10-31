import test from "node:test";
import assert from "node:assert/strict";
import { signStreamToken, verifyStreamToken } from "../core/token.js";

const SECRET = "test-secret-do-not-use-in-production";
const URL_A = "https://upos-sz-mirrorcos.bilivideo.com/v1/resource/abc.m4s?deadline=1&upsig=2";

test("签发的 token 能被验回原始 URL", async () => {
  const token = await signStreamToken(URL_A, SECRET, 3600);
  assert.equal(await verifyStreamToken(token, SECRET), URL_A);
});

test("URL 里的特殊字符不会破坏 token", async () => {
  const tricky = "https://x.bilivideo.com/a.m4s?e=abc%3D&orderid=0%2C3&s=+/=&";
  const token = await signStreamToken(tricky, SECRET, 3600);
  assert.equal(await verifyStreamToken(token, SECRET), tricky);
});

test("token 里不含未编码的斜杠（要能安全放进 URL 路径）", async () => {
  const token = await signStreamToken(URL_A, SECRET, 3600);
  assert.ok(!token.includes("/"), `token 里出现了斜杠：${token}`);
  assert.ok(!token.includes("+"), `token 里出现了加号：${token}`);
  assert.ok(!token.includes("="), `token 里出现了等号：${token}`);
});

test("换一个密钥就验不过", async () => {
  const token = await signStreamToken(URL_A, SECRET, 3600);
  await assert.rejects(() => verifyStreamToken(token, "另一个密钥"));
});

test("篡改 URL 部分会导致验签失败", async () => {
  const token = await signStreamToken(URL_A, SECRET, 3600);
  const [expires, , sig] = token.split(".");
  const forged = await signStreamToken("https://evil.test/x.m4s", SECRET, 3600);
  const forgedBody = forged.split(".")[1];
  await assert.rejects(() => verifyStreamToken(`${expires}.${forgedBody}.${sig}`, SECRET));
});

test("过期的 token 被拒绝", async () => {
  const token = await signStreamToken(URL_A, SECRET, -1);
  await assert.rejects(() => verifyStreamToken(token, SECRET), /过期/);
});

test("格式不对的 token 被拒绝", async () => {
  for (const bad of ["", "abc", "a.b", "a.b.c.d", "..", "not-a-token"]) {
    await assert.rejects(() => verifyStreamToken(bad, SECRET), undefined, `应拒绝：${bad}`);
  }
});
