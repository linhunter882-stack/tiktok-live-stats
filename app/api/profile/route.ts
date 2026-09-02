import { matchesAccessCode } from "../verify/route";

export const dynamic = "force-dynamic";

type RequestBody = {
  username?: string;
  secUid?: string;
  cursor?: number;
  deviceId?: string;
};

type Profile = {
  username: string;
  nickname: string;
  avatar: string;
  signature: string;
  verified: boolean;
  privateAccount: boolean;
  followerCount: number | null;
  followingCount: number | null;
  likesCount: number | null;
  videoCount: number | null;
  url: string;
};

const noStore = { "Cache-Control": "no-store" };
const userAgent = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36";
const apiUrl = "https://www.tiktok.com/api/creator/item_list/";
const earliestCursor = 1_472_706_000_000;

class ApiError extends Error {
  constructor(message: string, readonly status = 400) {
    super(message);
  }
}

function scriptJson(page: string, id: string) {
  const escaped = id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = page.match(new RegExp(`<script\\b[^>]*\\bid=["']${escaped}["'][^>]*>(.*?)<\\/script>`, "is"));
  if (!match) return null;
  try { return JSON.parse(match[1]); }
  catch { return null; }
}

function metric(value: unknown) {
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

function createdAt(value: unknown) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

function beijingTime(timestamp: number) {
  return new Date((timestamp + 8 * 3600) * 1000).toISOString().slice(0, 19).replace("T", " ");
}

function normalizeUsername(input: string) {
  let value = input.trim();
  if (!value) throw new ApiError("请输入 TikTok 账号");

  if (/^https?:\/\//i.test(value)) {
    let url: URL;
    try { url = new URL(value); }
    catch { throw new ApiError("TikTok 账号主页链接格式不正确"); }
    const hostname = url.hostname.toLowerCase();
    if (!['tiktok.com', 'www.tiktok.com', 'm.tiktok.com'].includes(hostname) || url.port || url.username || url.password) {
      throw new ApiError("只支持 TikTok 账号主页链接");
    }
    const match = url.pathname.match(/^\/@([^/]+)\/?$/);
    if (!match) throw new ApiError("请输入 TikTok 账号主页链接，不要输入视频链接");
    try { value = decodeURIComponent(match[1]); }
    catch { throw new ApiError("TikTok 用户名格式不正确"); }
  } else {
    value = value.replace(/^@/, "");
  }

  if (value.length > 24 || value.includes("..") || !/^[A-Za-z0-9_](?:[A-Za-z0-9._]{0,22}[A-Za-z0-9_])?$/.test(value)) {
    throw new ApiError("TikTok 用户名格式不正确");
  }
  return value;
}

function validateSecUid(value: unknown) {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]{20,200}$/.test(value)) throw new ApiError("账号标识格式不正确");
  return value;
}

function generateDeviceId() {
  const values = new Uint8Array(16);
  crypto.getRandomValues(values);
  return `725${Array.from(values, (value) => value % 10).join("")}`;
}

function validateDeviceId(value: unknown) {
  if (value === undefined) return generateDeviceId();
  if (typeof value !== "string" || !/^72\d{17}$/.test(value)) throw new ApiError("设备标识格式不正确");
  return value;
}

function validateCursor(value: unknown) {
  if (value === undefined) return Date.now();
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < earliestCursor || value > Date.now() + 86_400_000) {
    throw new ApiError("分页位置格式不正确");
  }
  return value;
}

function upstreamError(message: string, fallback = "TikTok 返回异常，请稍后重试") {
  const normalized = message.toLowerCase();
  if (normalized.includes("private") || normalized.includes("permission") || normalized.includes("10222")) {
    return new ApiError("该账号为私密账号，无法获取公开视频", 403);
  }
  if (normalized.includes("not found") || normalized.includes("doesn't exist") || normalized.includes("not exist") || normalized.includes("10221")) {
    return new ApiError("TikTok 账号不存在或已停用", 404);
  }
  return new ApiError(message || fallback, 502);
}

async function fetchTikTok(url: string, accept: string, referer?: string) {
  const response = await fetch(url, {
    headers: {
      "User-Agent": userAgent,
      "Accept": accept,
      "Accept-Language": "en-US,en;q=0.9",
      "Cache-Control": "no-cache",
      "Pragma": "no-cache",
      ...(referer ? { "Referer": referer } : {}),
    },
    cache: "no-store",
    signal: AbortSignal.timeout(25_000),
    redirect: "follow",
  });
  if (response.status === 403 || response.status === 429) throw new ApiError("TikTok 暂时限制访问，请稍后重试", 429);
  if (!response.ok) {
    if (response.status === 404) throw new ApiError("TikTok 账号不存在或已停用", 404);
    throw new ApiError(`TikTok 请求失败（HTTP ${response.status}）`, 502);
  }
  const text = await response.text();
  if (!text.trim()) throw new ApiError("TikTok 返回空响应，请稍后重试", 502);
  return text;
}

async function fetchProfile(username: string) {
  const url = `https://www.tiktok.com/@${username}`;
  const page = await fetchTikTok(url, "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8");
  const hydration = scriptJson(page, "__UNIVERSAL_DATA_FOR_REHYDRATION__");
  const detail = hydration?.__DEFAULT_SCOPE__?.["webapp.user-detail"];
  const statusCode = Number(detail?.statusCode ?? 0);
  const statusMessage = String(detail?.statusMsg ?? "");
  if (statusCode || !detail?.userInfo?.user) {
    if (!detail) throw new ApiError("TikTok 暂时限制访问，请稍后重试", 429);
    throw upstreamError(`${statusMessage} ${statusCode}`.trim(), "TikTok 账号不存在或已停用");
  }

  const user = detail.userInfo.user;
  if (user.privateAccount || user.secret) throw new ApiError("该账号为私密账号，无法获取公开视频", 403);
  const secUid = validateSecUid(user.secUid);
  const stats = detail.userInfo.statsV2 ?? detail.userInfo.stats ?? {};
  const resolvedUsername = String(user.uniqueId ?? username);
  const profile: Profile = {
    username: resolvedUsername,
    nickname: String(user.nickname ?? ""),
    avatar: String(user.avatarLarger ?? user.avatarMedium ?? user.avatarThumb ?? ""),
    signature: String(user.signature ?? ""),
    verified: Boolean(user.verified),
    privateAccount: false,
    followerCount: metric(stats.followerCount),
    followingCount: metric(stats.followingCount),
    likesCount: metric(stats.heartCount ?? stats.heart),
    videoCount: metric(stats.videoCount),
    url: `https://www.tiktok.com/@${resolvedUsername}`,
  };
  return { profile, secUid };
}

function itemResult(item: Record<string, unknown>, fallbackUsername: string) {
  const id = String(item.id ?? "");
  const timestamp = createdAt(item.createTime);
  if (!/^\d{15,25}$/.test(id) || timestamp === null) return null;
  const author = item.author && typeof item.author === "object" ? item.author as Record<string, unknown> : {};
  const stats = (item.statsV2 && typeof item.statsV2 === "object" ? item.statsV2 : item.stats) as Record<string, unknown> | undefined ?? {};
  const username = String(author.uniqueId ?? fallbackUsername);
  const contentType = item.imagePost && typeof item.imagePost === "object" ? "photo" : "video";
  const url = `https://www.tiktok.com/@${username || "_"}/${contentType}/${id}`;
  return {
    key: id,
    sourceUrl: url,
    url,
    contentType,
    videoId: id,
    author: username,
    description: String(item.desc ?? ""),
    publishedAt: beijingTime(timestamp),
    createdAt: timestamp,
    views: metric(stats.playCount),
    likes: metric(stats.diggCount),
    comments: metric(stats.commentCount),
    saves: metric(stats.collectCount),
    shares: metric(stats.shareCount),
    fetchedAt: new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 19).replace("T", " "),
    status: "success" as const,
    error: "",
  };
}

function buildFeedUrl(secUid: string, cursor: number, deviceId: string) {
  const verifyFp = `verify_${crypto.getRandomValues(new Uint32Array(1))[0].toString(16).padStart(8, "0").slice(0, 7)}`;
  const query = new URLSearchParams({
    aid: "1988",
    app_language: "en",
    app_name: "tiktok_web",
    browser_language: "en-US",
    browser_name: "Mozilla",
    browser_online: "true",
    browser_platform: "Win32",
    browser_version: "5.0 (Windows)",
    channel: "tiktok_web",
    cookie_enabled: "true",
    count: "15",
    cursor: String(cursor),
    device_id: deviceId,
    device_platform: "web_pc",
    focus_state: "true",
    from_page: "user",
    history_len: "2",
    is_fullscreen: "false",
    is_page_visible: "true",
    language: "en",
    os: "windows",
    priority_region: "",
    referer: "",
    region: "US",
    screen_height: "1080",
    screen_width: "1920",
    secUid,
    type: "1",
    tz_name: "UTC",
    verifyFp,
    webcast_language: "en",
  });
  return `${apiUrl}?${query}`;
}

function hasMoreValue(value: unknown) {
  return value === true || value === 1 || value === "1";
}

export async function POST(request: Request) {
  if (!matchesAccessCode(request.headers.get("x-access-code") ?? "")) {
    return Response.json({ error: "访问口令不正确" }, { status: 401, headers: noStore });
  }

  try {
    const body = await request.json() as RequestBody;
    if (!body || typeof body !== "object" || Array.isArray(body)) throw new ApiError("请求数据格式不正确");
    if (body.username !== undefined && typeof body.username !== "string") throw new ApiError("TikTok 用户名格式不正确");

    let profile: Profile | null = null;
    let username = "";
    let secUid = body.secUid === undefined ? "" : validateSecUid(body.secUid);
    if (body.username !== undefined) {
      username = normalizeUsername(body.username);
      const resolved = await fetchProfile(username);
      if (secUid && secUid !== resolved.secUid) throw new ApiError("账号标识与用户名不匹配");
      profile = resolved.profile;
      username = profile.username;
      secUid = resolved.secUid;
    }
    if (!secUid) throw new ApiError("请输入 TikTok 账号或账号标识");

    const cursor = validateCursor(body.cursor);
    const deviceId = validateDeviceId(body.deviceId);
    const referer = username ? `https://www.tiktok.com/@${username}` : "https://www.tiktok.com/";
    const raw = await fetchTikTok(buildFeedUrl(secUid, cursor, deviceId), "application/json, text/plain, */*", referer);
    let data;
    try { data = JSON.parse(raw); }
    catch { throw new ApiError("TikTok 返回的数据格式异常，请稍后重试", 502); }

    const statusCode = Number(data?.statusCode ?? data?.status_code ?? 0);
    const statusMessage = String(data?.statusMsg ?? data?.status_msg ?? "");
    if (statusCode) throw upstreamError(`${statusMessage} ${statusCode}`.trim());
    if (!Array.isArray(data?.itemList)) throw new ApiError("TikTok 未返回账号视频数据，请稍后重试", 502);

    const items = data.itemList
      .map((item: unknown) => item && typeof item === "object" ? itemResult(item as Record<string, unknown>, username) : null)
      .filter((item: ReturnType<typeof itemResult>): item is NonNullable<ReturnType<typeof itemResult>> => item !== null);
    const lastTimestamp = [...data.itemList].reverse().map((item: unknown) => item && typeof item === "object" ? createdAt((item as Record<string, unknown>).createTime) : null).find((value) => value !== null);
    let nextCursor = lastTimestamp ? lastTimestamp * 1000 : cursor - 7 * 86_400_000;
    if (nextCursor === cursor) nextCursor -= 7 * 86_400_000;
    nextCursor = Math.max(earliestCursor, nextCursor);
    const hasMore = nextCursor > earliestCursor && hasMoreValue(data.hasMorePrevious ?? data.hasMore);

    return Response.json({ profile, secUid, deviceId, cursor, nextCursor, hasMore, items }, { headers: noStore });
  } catch (error) {
    if (error instanceof ApiError) return Response.json({ error: error.message }, { status: error.status, headers: noStore });
    const name = error instanceof Error ? error.name : "";
    const message = name === "TimeoutError" || name === "AbortError"
      ? "TikTok 请求超时，请稍后重试"
      : "获取 TikTok 账号数据失败，请稍后重试";
    return Response.json({ error: message }, { status: name === "TimeoutError" || name === "AbortError" ? 504 : 400, headers: noStore });
  }
}
