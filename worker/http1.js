// HTTP/1.1 响应的最小解析器。
// 单独成文件是为了能在 Node 单测里跑 —— socket-fetch.js 依赖 cloudflare:sockets，Node 加载不了。

const HEADER_TERMINATOR = [13, 10, 13, 10];

function findHeaderEnd(bytes) {
  outer: for (let i = 0; i + 3 < bytes.length; i += 1) {
    for (let j = 0; j < HEADER_TERMINATOR.length; j += 1) {
      if (bytes[i + j] !== HEADER_TERMINATOR[j]) continue outer;
    }
    return i;
  }
  return -1;
}

/** 把原始响应字节拆成状态行、响应头、Set-Cookie 列表和 body 字节 */
export function splitResponse(bytes) {
  const end = findHeaderEnd(bytes);
  const headBytes = end >= 0 ? bytes.subarray(0, end) : bytes;
  const bodyBytes = end >= 0 ? bytes.subarray(end + HEADER_TERMINATOR.length) : new Uint8Array(0);

  const lines = new TextDecoder("utf-8").decode(headBytes).split("\r\n");
  const status = Number((lines[0] ?? "").split(" ")[1]);

  const headers = {};
  const setCookies = [];
  for (const line of lines.slice(1)) {
    const index = line.indexOf(":");
    if (index <= 0) continue;
    const name = line.slice(0, index).trim().toLowerCase();
    const value = line.slice(index + 1).trim();
    if (name === "set-cookie") {
      setCookies.push(value);
    } else {
      headers[name] = headers[name] ? `${headers[name]}, ${value}` : value;
    }
  }

  return { status, headers, setCookies, bodyBytes };
}

/**
 * 解 Transfer-Encoding: chunked。
 * 必须在字节层面做：chunk size 是字节数，而 UTF-8 中文是多字节，
 * 先解码成字符串再按 size 切会错位，把 chunk 边框当成数据。
 */
export function decodeChunkedBytes(input) {
  const parts = [];
  let index = 0;

  while (index < input.length) {
    let lineEnd = index;
    while (lineEnd + 1 < input.length && !(input[lineEnd] === 13 && input[lineEnd + 1] === 10)) {
      lineEnd += 1;
    }
    if (lineEnd + 1 >= input.length) break;

    const line = new TextDecoder("utf-8").decode(input.subarray(index, lineEnd));
    const size = Number.parseInt(line.split(";")[0].trim(), 16);
    if (!Number.isInteger(size) || size <= 0) break;

    const start = lineEnd + 2;
    const end = Math.min(start + size, input.length);
    parts.push(input.subarray(start, end));
    index = end + 2;
  }

  let total = 0;
  for (const part of parts) total += part.length;
  const output = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    output.set(part, offset);
    offset += part.length;
  }
  return output;
}
