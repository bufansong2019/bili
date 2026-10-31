// 基于 cloudflare:sockets 的最小 HTTPS 客户端。
//
// 为什么需要它：Workers 的 fetch 会在出站请求上自动加 cf-* 头（含 cf-worker），
// B 站风控看到这些头会直接返回 412 —— 实测 Cloudflare 出口访问 SPI 与首页都是 412，
// 而同样在 AWS 日本机房的普通 curl 是 200。走 socket 自己拼 HTTP/1.1 就不经过
// Workers 的 HTTP 管道，也就没有这些头。
//
// 只实现 GET —— 本项目对 B 站 API 的调用全是 GET。流媒体仍走 fetch。

import { connect } from "cloudflare:sockets";
import { decodeChunkedBytes, splitResponse } from "./http1.js";

const TIMEOUT_MS = 15_000;
const NULL_BODY_STATUS = new Set([204, 205, 304]);

export async function socketFetch(url, init = {}, depth = 0) {
  const target = new URL(url);
  if (target.protocol !== "https:") throw new Error(`socketFetch 只支持 https：${target.protocol}`);

  const method = (init.method ?? "GET").toUpperCase();
  if (method !== "GET") throw new Error(`socketFetch 只支持 GET：${method}`);

  const headers = new Headers(init.headers ?? {});
  headers.set("Connection", "close");
  // 原始 socket 不会帮我们解压，必须要求明文
  if (!headers.has("Accept-Encoding")) headers.set("Accept-Encoding", "identity");

  const socket = connect(
    { hostname: target.hostname, port: Number(target.port) || 443 },
    { secureTransport: "on", allowHalfOpen: false },
  );

  const lines = [`${method} ${target.pathname}${target.search} HTTP/1.1`, `Host: ${target.hostname}`];
  for (const [name, value] of headers.entries()) lines.push(`${name}: ${value}`);
  const payload = new TextEncoder().encode(`${lines.join("\r\n")}\r\n\r\n`);

  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      try {
        socket.close();
      } catch {}
      reject(new Error(`socketFetch 超时（${TIMEOUT_MS}ms）：${target.hostname}`));
    }, TIMEOUT_MS);
  });

  const work = (async () => {
    await socket.opened;
    const writer = socket.writable.getWriter();
    await writer.write(payload);
    writer.releaseLock();

    const reader = socket.readable.getReader();
    const chunks = [];
    let total = 0;
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      if (!value) continue;
      chunks.push(value);
      total += value.length;
    }

    const bytes = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.length;
    }

    const { status, headers: responseHeaders, setCookies, bodyBytes } = splitResponse(bytes);
    if (!Number.isInteger(status) || status < 200) {
      const preview = new TextDecoder("utf-8").decode(bodyBytes.subarray(0, 120));
      throw new Error(`socketFetch 收到无法解析的响应（status=${status}）：${target.hostname} ${preview}`);
    }

    const location = responseHeaders.location;
    if (location && [301, 302, 303, 307, 308].includes(status)) {
      if (depth >= 3) throw new Error(`socketFetch 重定向次数过多：${target.hostname}`);
      try {
        socket.close();
      } catch {}
      return socketFetch(new URL(location, target).toString(), init, depth + 1);
    }

    const encoding = (responseHeaders["content-encoding"] ?? "identity").toLowerCase();
    if (encoding !== "identity") {
      throw new Error(`socketFetch 收到未预期压缩（${encoding}）：${target.hostname}`);
    }

    const isChunked = (responseHeaders["transfer-encoding"] ?? "").toLowerCase().includes("chunked");
    const rawBody = isChunked ? decodeChunkedBytes(bodyBytes) : bodyBytes;
    const body = new TextDecoder("utf-8").decode(rawBody);

    const outgoing = new Headers();
    for (const [name, value] of Object.entries(responseHeaders)) {
      if (name === "connection" || name === "transfer-encoding" || name === "content-length") continue;
      outgoing.set(name, value);
    }
    for (const cookie of setCookies) outgoing.append("set-cookie", cookie);

    return new Response(NULL_BODY_STATUS.has(status) ? null : body, { status, headers: outgoing });
  })();

  try {
    return await Promise.race([work, timeout]);
  } catch (error) {
    try {
      socket.close();
    } catch {}
    throw error;
  } finally {
    clearTimeout(timer);
  }
}
