// 调用自家 API 的统一入口。
// 存在的意义：浏览器自己抛的网络错误是英文（"Failed to fetch"），
// 直接拼进提示里会破坏全中文的界面，所以在这一层统一翻掉。

/** 发起请求并解析 JSON。任何失败都抛出中文 Error。 */
export async function requestJson(path) {
  let response;
  try {
    response = await fetch(path);
  } catch {
    throw new Error("网络请求失败，请检查网络后重试");
  }

  let body;
  try {
    body = await response.json();
  } catch {
    // 边缘节点出错时返回的是 HTML 错误页，json() 会抛解析异常
    throw new Error("服务返回了无法解析的内容，请稍后重试");
  }

  if (!response.ok) {
    throw new Error(body?.error || "请求失败，请稍后重试");
  }
  return body;
}
