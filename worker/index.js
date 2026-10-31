// HTTP 路由层：把 core/ 的能力暴露成接口。
// 音频经由 /api/stream/<token> 代理 —— B站 CDN 要求 Referer 是 bilibili.com，
// 而浏览器的 Referer 由页面地址决定且无法伪造，只能由 Worker 代取。

import { BILIBILI_BASE_HEADERS, fetchMixinKey, WBI_CACHE_TTL_MS } from "../core/wbi.js";
import {
  issueGuestIdentity,
  fetchView,
  resolveAudio,
  isValidBvid,
} from "../core/bili.js";
import { signStreamToken, verifyStreamToken } from "../core/token.js";
import { socketFetch } from "./socket-fetch.js";

// 游客身份与签名密钥缓存在模块作用域，随 isolate 复用而长期有效。
// Cloudflare 会随时回收 isolate，所以这里只是尽力而为的缓存，
// 每条请求路径都必须在缓存为空时也能正确工作。
let guestCache = null;
let mixinCache = null;

function json(body, status = 200, extraHeaders = null) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Access-Control-Allow-Origin": "*",
      ...extraHeaders,
    },
  });
}

// headers 只有 405 用得上 —— RFC 9110 §15.5.6 要求 405 必须带 Allow，
// 400/500 不能带，所以默认不传。
function failure(message, status = 500, headers = null) {
  return json({ error: message }, status, headers);
}

// 只允许代理 B站 自己的 CDN —— 签名 token 已经能防篡改，
// 这层白名单是纵深防御：万一密钥泄露，也不至于变成任意 URL 的开放代理。
const ALLOWED_CDN_SUFFIXES = ["bilivideo.com", "bilivideo.cn"];
const ALLOWED_CDN_EXACT = ["upos-hz-mirrorakam.akamaized.net"];

function isAllowedCdnUrl(url) {
  let host;
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    return false;
  }
  if (ALLOWED_CDN_EXACT.includes(host)) return true;
  return ALLOWED_CDN_SUFFIXES.some((suffix) => host === suffix || host.endsWith(`.${suffix}`));
}

// 代理 token 有效期。B站 自己的直链是 2 小时，取 1 小时足够 —— playurl
// 是点播时才调的，token 拿到就立刻用上了。
const STREAM_TOKEN_TTL_SECONDS = 60 * 60;

// core/ 抛出的错误信息是英文原文 —— 那几个模块必须与对着官方向量验证过的版本
// 保持字节一致，所以不往里加中文。改成在 HTTP 边界统一翻译，
// 保证用户永远看不到英文，且以后改文案只改这一处。
// 顺序要紧：具体服务的错误排在通用的 /412/ 前面，否则 412 会把它们全吞掉，
// 用户看到的是笼统的「B站拒绝了请求」，无从判断是签名问题还是身份问题。
const ERROR_TRANSLATIONS = [
  [/v_voucher/, "B站要求人机验证，请稍后重试"],
  // ↓ WBI 与游客身份这两条里的 412 含义明确，必须排在通用 /412/ 之前
  [/WBI key/i, "签名密钥获取失败，请稍后重试"],
  // 身份相关的规则必须排在 /page/ 之前 —— "homepage" 里就含 "page"，
  // 顺序颠倒会把游客身份领取失败误报成视频信息获取失败。
  // 这里匹配的是 "SPI" 本身而不是 "SPI buvid" —— 取游客身份有两条失败路径，
  // 一条是 "SPI buvid failed with code ..."，另一条是 "Bilibili SPI returned HTTP 412"，
  // 后者不含 "buvid"，用窄 pattern 会让它掉到下面笼统的 /412/ 去。
  [/SPI|buvid3|homepage/i, "游客身份领取失败，请稍后重试"],
  // ↓ 到这里的 412 才是笼统的风控
  [/412/, "B站拒绝了请求，可能是游客身份失效或触发了风控"],
  [/view|page/i, "视频信息获取失败，请检查 BV 号"],
  [/playurl|stream/i, "音频解析失败，这首歌可能无法播放"],
  [/fetch|network|ECONN|timeout|abort/i, "网络请求失败，请检查网络后重试"],
];

function toChineseMessage(raw) {
  const text = String(raw ?? "");
  for (const [pattern, message] of ERROR_TRANSLATIONS) {
    if (pattern.test(text)) return message;
  }
  return "请求失败，请稍后重试";
}

/**
 * B 站 API 调用统一走 socketFetch。
 * Workers 的 fetch 会注入 cf-*（含 cf-worker），B 站风控会直接 412；
 * socket 自己拼 HTTP 不走那条管道。socket 失败时回落到 fetch，避免全站不可用。
 */
async function biliFetch(url, init) {
  try {
    return await socketFetch(url, init);
  } catch (error) {
    console.error("socket fetch failed, falling back:", error.message);
    return fetch(url, init);
  }
}

/** 取游客身份，失败时清缓存重领一次 */
async function getGuest() {
  if (guestCache) return guestCache;
  guestCache = await issueGuestIdentity(biliFetch);
  return guestCache;
}

/**
 * 判断错误是否属于「身份或签名失效」这类能靠重试自愈的问题。
 * 只有这类才重试 —— 网络超时、风控限流（code -509）重试没有意义，
 * 反而会在最容易触发风控的时候把请求量放大数倍。
 *
 * 这张表与上面的 ERROR_TRANSLATIONS 长得很像但职责不同，**刻意不合并**：
 * 文案的顺序要按「哪个提示对用户更有用」排，而重试的顺序要按「哪些错误重试有意义」排，
 * 两者的最优顺序会冲突 —— 合并就得让其中一张迁就另一张。改任何一张时，记得看一眼另一张。
 *
 * -403 必须包含：B站对失效签名返回的就是「访问权限不足」(-403)，
 * 这是取流接口上签名失效的典型症状。它同时也表示区域限制/付费内容，
 * 那种情况多试一次没意义，但只多花一个请求，比漏掉签名失效卡住一小时划算。
 */
function isRecoverableAuthError(message) {
  return /WBI key|sign|412|v_voucher|-403/i.test(String(message ?? ""));
}

/**
 * 跑一次请求；遇到身份或签名失效时清缓存重试一次。
 * 两份缓存一起清：签名失效和身份失效的症状经常无法从错误信息上区分，
 * 都重新领一次的代价很低，比猜错之后卡住一小时划算。
 */
async function withAuthRetry(run) {
  try {
    return await run(await getGuest());
  } catch (error) {
    if (!isRecoverableAuthError(error.message)) throw error;
    guestCache = null;
    mixinCache = null;
    return run(await getGuest());
  }
}

/** 取 WBI 签名密钥，超过 1 小时重新拉取 */
async function getMixinKey() {
  const now = Date.now();
  if (mixinCache && now - mixinCache.at < WBI_CACHE_TTL_MS) return mixinCache.key;
  const key = await fetchMixinKey(biliFetch);
  mixinCache = { key, at: now };
  return key;
}

async function handleVideo(url) {
  const bvid = url.searchParams.get("bvid") ?? "";
  if (!isValidBvid(bvid)) return failure("BV 号格式不正确", 400);

  const info = await withAuthRetry(async (guest) => {
    const meta = await fetchView(bvid, guest.header, biliFetch);
    return {
      bvid,
      title: meta.title,
      author: meta.author,
      pic: meta.pic,
      // 前端只需要页码和分 P 标题，cid 是内部取流用的，不外传
      pages: meta.pages.map((p) => ({ page: p.page, part: p.part })),
    };
  });

  return json(info);
}

async function handlePlayurl(url, env) {
  const bvid = url.searchParams.get("bvid") ?? "";
  if (!isValidBvid(bvid)) return failure("BV 号格式不正确", 400);

  // 分 P 参数。缺省或非法都回落到第 1 个分 P —— 单 P 视频就是这种情况。
  const requested = Number(url.searchParams.get("page"));
  const wanted = Number.isInteger(requested) && requested > 0 ? requested : 1;

  const info = await withAuthRetry(async (guest) => {
    const mixinKey = await getMixinKey();
    const meta = await fetchView(bvid, guest.header, biliFetch);
    const target = meta.pages.find((p) => p.page === wanted) ?? meta.pages[0];
    if (!target) throw new Error("view response has no usable page");

    const audio = await resolveAudio(bvid, target.cid, guest.header, mixinKey, biliFetch);
    return {
      bvid,
      page: target.page,
      title: target.part,
      // 不能把 CDN 直链直接交给浏览器：B站 CDN 要求 Referer 是 bilibili.com，
      // 而浏览器的 Referer 由页面地址决定且无法伪造。所以换成经过本 Worker 的地址。
      streamUrl: `/api/stream/${await signStreamToken(audio.url, env.TOKEN_SECRET, STREAM_TOKEN_TTL_SECONDS)}`,
    };
  });

  return json(info);
}

/**
 * 音频代理。唯一的职责是补上 B站 CDN 要求的 Referer，然后把流原样透传。
 * 不自作主张缓存、不改内容、不重编码。
 */
async function handleStream(request, token, env) {
  let target;
  try {
    target = await verifyStreamToken(token, env.TOKEN_SECRET);
  } catch (error) {
    return failure(error.message, 403);
  }
  if (!isAllowedCdnUrl(target)) return failure("链接不在允许的范围内", 403);

  // 复用 core/wbi.js 里那一份 —— 这两个头必须成对出现，不能各写一份
  const headers = { ...BILIBILI_BASE_HEADERS };
  // Range 与 If-Range 必须原样透传，否则拖动进度条会失效
  const range = request.headers.get("Range");
  if (range) headers.Range = range;
  const ifRange = request.headers.get("If-Range");
  if (ifRange) headers["If-Range"] = ifRange;

  let upstream;
  try {
    upstream = await fetch(target, { method: request.method, headers });
  } catch (error) {
    console.error("stream upstream failed:", error.message);
    return failure("音频源连接失败，请重试");
  }

  if (!upstream.ok && upstream.status !== 206) {
    console.error(`stream upstream HTTP ${upstream.status}`);
    return failure("音频源返回异常，请重试", 502);
  }

  const responseHeaders = new Headers();
  responseHeaders.set("Access-Control-Allow-Origin", "*");
  responseHeaders.set("Accept-Ranges", "bytes");
  for (const name of ["Content-Length", "Content-Range", "ETag", "Last-Modified", "Cache-Control"]) {
    const value = upstream.headers.get(name);
    if (value) responseHeaders.set(name, value);
  }

  // B站部分 CDN 节点把音轨标成 application/octet-stream，
  // 部分浏览器（尤其 macOS 上的 WKWebView）拒绝把它当媒体解码。
  // 上游给的信息不足时统一改写成 audio/mp4。
  const upstreamType = upstream.headers.get("Content-Type") ?? "";
  responseHeaders.set(
    "Content-Type",
    !upstreamType || upstreamType === "application/octet-stream" ? "audio/mp4" : upstreamType,
  );

  // HEAD 不要 body，GET 流式回传，边下边播不落盘
  const body = request.method === "HEAD" ? null : upstream.body;
  return new Response(body, { status: upstream.status, headers: responseHeaders });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // 部署时忘了设密钥是很容易犯的错，而它会导致全站播不了。
    // 提前拦一道并给出能直接定位的提示，别让它伪装成普通网络错误。
    if (!env.TOKEN_SECRET) {
      console.error("TOKEN_SECRET 未配置：请执行 npx wrangler secret put TOKEN_SECRET");
      // 这条只会被部署者本人看到，所以把变量名带上，方便直接定位
      return failure("服务未配置签名密钥，音频无法播放（部署时需设置 TOKEN_SECRET）", 500);
    }

    if (url.pathname === "/api/video") {
      if (request.method !== "GET") return failure("只支持 GET", 405, { Allow: "GET" });
      try {
        return await handleVideo(url);
      } catch (error) {
        // 英文原文只进日志，返回给前端的一律是中文
        console.error("video failed:", error.message);
        return failure(toChineseMessage(error.message));
      }
    }

    if (url.pathname === "/api/playurl") {
      if (request.method !== "GET") return failure("只支持 GET", 405, { Allow: "GET" });
      try {
        return await handlePlayurl(url, env);
      } catch (error) {
        console.error("playurl failed:", error.message);
        return failure(toChineseMessage(error.message));
      }
    }

    if (url.pathname.startsWith("/api/stream/")) {
      const token = url.pathname.slice("/api/stream/".length);
      try {
        return await handleStream(request, token, env);
      } catch (error) {
        console.error("stream failed:", error.message);
        return failure(toChineseMessage(error.message));
      }
    }

    // 其余请求交给静态资源
    return env.ASSETS.fetch(request);
  },
};
