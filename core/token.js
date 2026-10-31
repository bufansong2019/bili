// 音频代理用的无状态签名 token。
//
// 为什么不用「内存里存 token→URL 映射」：Cloudflare 会在任意时刻回收 isolate，
// 而且浏览器的流请求可能落到另一个 colo 的另一个 isolate 上，那份映射根本看不见。
// 所以把 URL 直接签名后编码进 token，验签即可还原，不需要任何存储。

const encoder = new TextEncoder();

function toBase64Url(bytes) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromBase64Url(text) {
  const padded = text.replace(/-/g, "+").replace(/_/g, "/")
    + "=".repeat((4 - (text.length % 4)) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

async function importKey(secret) {
  return crypto.subtle.importKey(
    "raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"],
  );
}

async function signature(body, secret) {
  const key = await importKey(secret);
  return new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder.encode(body)));
}

/**
 * 把音频直链封装成带签名的 token。
 * 格式：<过期秒级时间戳>.<base64url(URL)>.<base64url(HMAC)>
 */
export async function signStreamToken(url, secret, ttlSeconds) {
  if (!secret) throw new Error("缺少签名密钥");
  const expiresAt = Math.floor(Date.now() / 1000) + ttlSeconds;
  const body = `${expiresAt}.${toBase64Url(encoder.encode(url))}`;
  return `${body}.${toBase64Url(await signature(body, secret))}`;
}

/** 验签并还原 URL。任何异常都抛错，不返回半可信的结果。 */
export async function verifyStreamToken(token, secret) {
  if (!secret) throw new Error("缺少签名密钥");
  const parts = String(token ?? "").split(".");
  if (parts.length !== 3) throw new Error("token 格式不正确");

  const [expiresText, urlText, sigText] = parts;
  const body = `${expiresText}.${urlText}`;

  // 先验签再解析内容 —— 未经验证的字段一律不信任
  const expected = await signature(body, secret);
  let provided;
  try {
    provided = fromBase64Url(sigText);
  } catch {
    throw new Error("token 签名格式不正确");
  }
  if (provided.length !== expected.length) throw new Error("token 签名不匹配");
  let diff = 0;
  for (let i = 0; i < expected.length; i += 1) diff |= expected[i] ^ provided[i];
  if (diff !== 0) throw new Error("token 签名不匹配");

  const expiresAt = Number(expiresText);
  if (!Number.isInteger(expiresAt)) throw new Error("token 格式不正确");
  if (expiresAt * 1000 < Date.now()) throw new Error("音频链接已过期，请重新播放");

  return new TextDecoder().decode(fromBase64Url(urlText));
}
