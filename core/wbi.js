// WBI 签名 —— 逐行对照 src-tauri/src/wbi.rs 移植，含官方向量断言。
// 纯函数，无 IO，可直接用于 Worker。

import { md5 } from "./md5.js";

const NAV_URL = "https://api.bilibili.com/x/web-interface/nav";
export const WBI_CACHE_TTL_MS = 60 * 60 * 1000;

// 与 Rust 的 MIXIN_KEY_ENC_TAB 完全一致（wbi.rs:15-19）
const MIXIN_KEY_ENC_TAB = [
  46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35, 27, 43, 5, 49, 33, 9, 42, 19, 29,
  28, 14, 39, 12, 38, 41, 13, 37, 48, 7, 16, 24, 55, 40, 61, 26, 17, 0, 1, 60, 51, 30, 4, 22, 25,
  54, 21, 56, 59, 6, 63, 57, 62, 11, 36, 20, 34, 44, 52,
];

/**
 * 等价于 Rust 的 utf8_percent_encode(.., WBI_ENCODE_SET)。
 * Rust 的集合：除 A-Za-z0-9 与 `- _ . ~` 外全部转义。
 * encodeURIComponent 恰好也保留 `- _ . ~`，只是额外放过了 `! * ' ( )`，
 * 而这四个字符在 Rust 侧已被提前剔除（见 signParameters），故二者等价。
 */
function encodeWbi(value) {
  return encodeURIComponent(value).replace(/[!'()*]/g, (c) =>
    `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

/** 剔除 `!'()*` —— 对应 wbi.rs:66-69 */
function stripForbidden(value) {
  return value.replace(/[!'()*]/g, "");
}

/**
 * signParameters —— 对应 wbi.rs:61-80。
 * 入参是普通对象，按 key 的字典序排序（等价于 Rust 的 BTreeMap）。
 * @returns {string} `k=v&...&w_rid=<md5>`
 */
export function signParameters(params, mixinKey, wts) {
  const merged = { ...params, wts: String(wts) };
  const query = Object.keys(merged)
    .sort()
    .map((key) => `${encodeWbi(key)}=${encodeWbi(stripForbidden(String(merged[key])))}`)
    .join("&");
  return `${query}&w_rid=${md5(query + mixinKey)}`;
}

/** 取 URL 文件名去扩展名 —— 对应 wbi.rs:100-111 */
function keyFromUrl(url) {
  const filename = url.split("/").pop() ?? "";
  const key = filename.split(".")[0] ?? "";
  if (!key) throw new Error(`WBI key URL has an empty key: ${url}`);
  return key;
}

/** 64 项置换表取前 32 —— 对应 wbi.rs:113-124 */
export function genMixinKey(rawKey) {
  const bytes = new TextEncoder().encode(rawKey);
  if (bytes.length < 64) throw new Error("combined WBI key is shorter than 64 bytes");
  return MIXIN_KEY_ENC_TAB.slice(0, 32)
    .map((index) => String.fromCharCode(bytes[index]))
    .join("");
}

/** 拉 nav 拿 img_key + sub_url 并合成 mixinKey —— 对应 wbi.rs:21-59 */
export async function fetchMixinKey(fetchImpl = fetch) {
  const response = await fetchImpl(NAV_URL, { headers: { ...BILIBILI_BASE_HEADERS } });
  if (response.status === 412) throw new Error("Bilibili rejected the WBI key request with HTTP 412");

  const envelope = await response.json();
  // code -101 = 未登录，对游客是正常状态
  if (envelope.code !== 0 && envelope.code !== -101) {
    throw new Error(`failed to fetch WBI keys (code ${envelope.code}): ${envelope.message}`);
  }
  if (!envelope.data) throw new Error("WBI key response has no data");

  const { img_url, sub_url } = envelope.data.wbi_img;
  return genMixinKey(keyFromUrl(img_url) + keyFromUrl(sub_url));
}

const BILIBILI_REFERER = "https://www.bilibili.com";
const DESKTOP_USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

/**
 * 打 B站 接口时要带的基础请求头。
 *
 * 这两个值必须**成对出现** —— 实测：B站 CDN 只给 Referer 或只给 UA 都是 403，
 * 两个都给才放行。历史上它们在多个文件里各写了一份字面量，任何一处漂移都会
 * 导致全站音频取不到流，所以收成这一处。
 */
export const BILIBILI_BASE_HEADERS = {
  "Accept-Encoding": "identity",
  "User-Agent": DESKTOP_USER_AGENT,
  Referer: BILIBILI_REFERER,
};
