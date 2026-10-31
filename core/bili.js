// B 站游客链路 —— 对照 src-tauri/src/guest_playurl.rs 移植。
// 目标：验证「零后端、纯 Worker」能否走通 取身份 → 签名 → 取视频信息 → 取流。

import { BILIBILI_BASE_HEADERS, signParameters } from "./wbi.js";

const HOME_URL = "https://www.bilibili.com/";
const SPI_URL = "https://api.bilibili.com/x/frontend/finger/spi";
const VIEW_URL = "https://api.bilibili.com/x/web-interface/view";
const PLAYURL_URL = "https://api.bilibili.com/x/player/wbi/playurl";

const PREFERRED_AUDIO_IDS = [30232, 30216];
const SPECIAL_AUDIO_IDS = [30250, 30251];

const BVID_PATTERN = /^BV[0-9A-Za-z]{10}$/;

/** BV 号格式校验 */
export function isValidBvid(value) {
  return typeof value === "string" && BVID_PATTERN.test(value);
}

function cookieHeader(cookies) {
  return Object.entries(cookies)
    .map(([name, value]) => `${name}=${value}`)
    .join("; ");
}

/** 解析单条 Set-Cookie 的 name=value —— 对应 guest_playurl.rs 的 parse_set_cookie */
function parseSetCookie(raw) {
  const pair = raw.split(";")[0] ?? "";
  const index = pair.indexOf("=");
  if (index <= 0) return null;
  return [pair.slice(0, index).trim(), pair.slice(index + 1).trim()];
}

/** 读 Set-Cookie。Workers 与 undici 都提供 getSetCookie()，回退到 get()。 */
function readSetCookies(response) {
  if (typeof response.headers.getSetCookie === "function") {
    return response.headers.getSetCookie();
  }
  const single = response.headers.get("set-cookie");
  return single ? [single] : [];
}

/** SPI 领 buvid —— 对应 guest_playurl.rs:635-681 */
async function issueSpiBuvid(fetchImpl, existing) {
  const headers = { ...BILIBILI_BASE_HEADERS };
  if (Object.keys(existing).length > 0) headers.Cookie = cookieHeader(existing);

  const response = await fetchImpl(SPI_URL, { headers });
  if (!response.ok) throw new Error(`Bilibili SPI returned HTTP ${response.status}`);

  let envelope;
  try {
    envelope = await response.json();
  } catch {
    throw new Error("Bilibili SPI returned a non-JSON response");
  }
  if (envelope.code !== 0) {
    throw new Error(`SPI buvid failed with code ${envelope.code}: ${envelope.message}`);
  }

  const issued = {};
  if (envelope.data?.b_3) issued.buvid3 = envelope.data.b_3;
  if (envelope.data?.b_4) issued.buvid4 = envelope.data.b_4;
  return issued;
}

/** 首页 Set-Cookie 领 buvid —— 对应 guest_playurl.rs:599-633 */
async function issueHomepageBuvid(fetchImpl) {
  const response = await fetchImpl(HOME_URL, { headers: BILIBILI_BASE_HEADERS });
  if (!response.ok) {
    throw new Error(`Bilibili homepage returned HTTP ${response.status} while issuing guest buvid`);
  }

  const cookies = {};
  for (const raw of readSetCookies(response)) {
    const parsed = parseSetCookie(raw);
    if (!parsed) continue;
    const [name, value] = parsed;
    if (name === "buvid3" || name === "buvid4" || name === "b_nut") {
      cookies[name] = value;
    }
  }
  return cookies;
}

function mergeMissing(target, source) {
  for (const [name, value] of Object.entries(source)) {
    if (!(name in target)) target[name] = value;
  }
}

/**
 * 游客身份。
 *
 * 先打 SPI：一次请求就同时返回 buvid3/buvid4，且这是个轻量接口，
 * 风控比首页松得多 —— Cloudflare 这类机房出口访问 www.bilibili.com
 * 经常直接 412，但 api.bilibili.com 往往仍能通过。
 * SPI 失败时再回落到首页 Set-Cookie（对应 guest_playurl.rs:599-633 的原始路径）。
 */
export async function issueGuestIdentity(fetchImpl = fetch) {
  const cookies = {};
  const failures = [];

  try {
    mergeMissing(cookies, await issueSpiBuvid(fetchImpl, cookies));
  } catch (error) {
    failures.push(error);
  }

  if (!cookies.buvid3 || !cookies.buvid4) {
    try {
      mergeMissing(cookies, await issueHomepageBuvid(fetchImpl));
      // 首页缺项时带着已拿到的 cookie 再补一次 SPI
      if (!cookies.buvid3 || !cookies.buvid4) {
        mergeMissing(cookies, await issueSpiBuvid(fetchImpl, cookies));
      }
    } catch (error) {
      failures.push(error);
    }
  }

  if (!cookies.buvid3) {
    const detail = failures.map((error) => error.message).join("; ");
    throw new Error(`failed to issue guest buvid3: ${detail || "no buvid returned"}`);
  }
  return { cookies, header: cookieHeader(cookies) };
}

/** 取视频元信息（含 cid）—— 对应 guest_playurl.rs:683-730 */
export async function fetchView(bvid, cookieString, fetchImpl = fetch) {
  const response = await fetchImpl(`${VIEW_URL}?bvid=${bvid}`, {
    headers: { ...BILIBILI_BASE_HEADERS, Cookie: cookieString },
  });
  const envelope = await response.json();
  if (envelope.code !== 0) {
    throw new Error(`view failed (code ${envelope.code}): ${envelope.message}`);
  }
  const rawPages = envelope.data.pages ?? [];
  return {
    title: envelope.data.title,
    author: envelope.data.owner?.name ?? "",
    pic: envelope.data.pic ?? "",
    // 没有 pages 时（单 P 视频的接口返回）补一个默认分 P，
    // 让前端永远能拿到统一的队列结构
    pages: rawPages.length > 0
      ? rawPages.map((p) => ({ page: p.page, cid: p.cid, part: p.part }))
      : [{ page: 1, cid: envelope.data.cid, part: envelope.data.title }],
  };
}

/** 解析音频直链 —— 对应 guest_playurl.rs:767-825 + select_audio */
export async function resolveAudio(bvid, cid, cookieString, mixinKey, fetchImpl = fetch) {
  const params = { bvid, cid: String(cid), fnval: "4048", fnver: "0", qn: "0" };
  const query = signParameters(params, mixinKey, Math.floor(Date.now() / 1000));

  const response = await fetchImpl(`${PLAYURL_URL}?${query}`, {
    headers: { ...BILIBILI_BASE_HEADERS, Cookie: cookieString },
  });
  if (response.status !== 200) throw new Error(`playurl returned HTTP ${response.status}`);

  const envelope = await response.json();
  if (envelope.code !== 0) {
    throw new Error(`playurl failed (code ${envelope.code}): ${envelope.message}`);
  }

  const audio = envelope.data?.dash?.audio ?? [];
  if (!audio.length) throw new Error("playurl response has no data.dash.audio");

  // 优先 30232 / 30216，否则挑第一条非杜比/非 Hi-Res 的轨
  let selected = null;
  for (const id of PREFERRED_AUDIO_IDS) {
    selected = audio.find((stream) => stream.id === id);
    if (selected) break;
  }
  if (!selected) {
    selected = audio.find((stream) => !SPECIAL_AUDIO_IDS.includes(stream.id));
  }
  if (!selected) throw new Error("no usable audio stream");

  const urls = [
    selected.baseUrl ?? selected.base_url,
    ...(selected.backupUrl ?? selected.backup_url ?? []),
  ].filter(Boolean);
  if (urls.length === 0) throw new Error("playurl response has no usable audio url");

  return { url: urls[0] };
}
