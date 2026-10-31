import test from "node:test";
import assert from "node:assert/strict";
import { decodeChunkedBytes, splitResponse } from "../worker/http1.js";

const encode = (text) => new TextEncoder().encode(text);
const decode = (bytes) => new TextDecoder("utf-8").decode(bytes);

/** 按字节段拼一个完整的 chunked body */
function chunked(parts) {
  const bytes = [];
  for (const part of parts) {
    bytes.push(...encode(part.length.toString(16)), 13, 10, ...part, 13, 10);
  }
  bytes.push(48, 13, 10, 13, 10); // 0\r\n\r\n
  return new Uint8Array(bytes);
}

test("解析响应头、状态码、多条 Set-Cookie 与 body", () => {
  const raw = encode(
    "HTTP/1.1 200 OK\r\n" +
      "Content-Type: application/json\r\n" +
      "Set-Cookie: buvid3=a; Path=/\r\n" +
      "Set-Cookie: buvid4=b; Path=/\r\n" +
      "\r\n" +
      '{"code":0}',
  );

  const response = splitResponse(raw);
  assert.equal(response.status, 200);
  assert.equal(response.headers["content-type"], "application/json");
  assert.deepEqual(response.setCookies, ["buvid3=a; Path=/", "buvid4=b; Path=/"]);
  assert.equal(decode(response.bodyBytes), '{"code":0}');
});

test("解 chunked 响应体", () => {
  const body = chunked([encode("hello"), encode(" world")]);
  assert.equal(decode(decodeChunkedBytes(body)), "hello world");
});

test("chunk 边界切开 UTF-8 多字节字符也能正确还原", () => {
  // "你" = E4 BD A0，故意切成 1 字节 + 2 字节
  const body = chunked([[0xe4], [0xbd, 0xa0]]);
  assert.equal(decode(decodeChunkedBytes(body)), "你");
});

test("chunk 扩展与截断数据不会死循环", () => {
  const withExtension = encode("3;v=1\r\nabc\r\n0\r\n\r\n");
  assert.equal(decode(decodeChunkedBytes(withExtension)), "abc");

  const truncated = encode("5\r\nab");
  assert.equal(decode(decodeChunkedBytes(truncated)), "ab");
});
