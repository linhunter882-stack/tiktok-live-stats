import { matchesAccessCode } from "../verify/route";

export const dynamic = "force-dynamic";

const contentPattern = /\/(video|photo)\/(\d{15,25})/i;
const noStore = { "Cache-Control": "no-store" };
const userAgent = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36";

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
  return Number.isFinite(parsed) ? parsed : null;
}

function beijingTime(timestamp: unknown) {
  const seconds = Number(timestamp);
  if (!Number.isFinite(seconds) || !seconds) return "";
  return new Date((seconds + 8 * 3600) * 1000).toISOString().slice(0, 19).replace("T", " ");
}

function parsePage(page: string, fallbackId: string, contentType: "video" | "photo") {
  const hydration = scriptJson(page, "__UNIVERSAL_DATA_FOR_REHYDRATION__");
  const detail = hydration?.__DEFAULT_SCOPE__?.["webapp.video-detail"] ?? {};
  let item = detail?.itemInfo?.itemStruct;

  if (!item) {
    const sigi = scriptJson(page, "SIGI_STATE") ?? {};
    item = sigi?.ItemModule?.[fallbackId] ?? Object.values(sigi?.ItemModule ?? {})[0];
  }
  if (!item) throw new Error(detail?.statusMsg || "页面没有返回公开数据，内容可能已删除、设为私密或受到地区限制");

  const stats = item.statsV2 ?? item.stats ?? {};
  const author = item.author?.uniqueId ?? item.author?.nickname ?? "";
  const id = String(item.id ?? fallbackId);
  return {
    key: id,
    videoId: id,
    contentType,
    url: `https://www.tiktok.com/@${author || "_"}/${contentType}/${id}`,
    author,
    description: item.desc ?? "",
    publishedAt: beijingTime(item.createTime),
    views: metric(stats.playCount),
    likes: metric(stats.diggCount),
    comments: metric(stats.commentCount),
    saves: metric(stats.collectCount),
    shares: metric(stats.shareCount),
    fetchedAt: new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 19).replace("T", " "),
  };
}

function parseEmbedPage(page: string, fallbackId: string, contentType: "video" | "photo") {
  const state = scriptJson(page, "__FRONTITY_CONNECT_STATE__");
  const entries = Object.values(state?.source?.data ?? {}) as Array<{ videoData?: { itemInfos?: Record<string, unknown>; authorInfos?: Record<string, unknown> } }>;
  const videoData = entries.find((entry) => entry?.videoData)?.videoData;
  const item = videoData?.itemInfos;
  const authorInfo = videoData?.authorInfos;
  if (!item) throw new Error("页面没有返回公开数据，内容可能已删除、设为私密或受到地区限制");
  const id = String(item.id ?? fallbackId);
  const author = String(authorInfo?.uniqueId ?? authorInfo?.nickName ?? "");
  return {
    key: id,
    videoId: id,
    contentType,
    url: `https://www.tiktok.com/@${author || "_"}/${contentType}/${id}`,
    author,
    description: String(item.text ?? ""),
    publishedAt: beijingTime(item.createTime),
    views: metric(item.playCount),
    likes: metric(item.diggCount),
    comments: metric(item.commentCount),
    saves: metric(item.collectCount),
    shares: metric(item.shareCount),
    fetchedAt: new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 19).replace("T", " "),
  };
}

async function fetchTikTok(url: string) {
  const response = await fetch(url, {
    headers: {
      "User-Agent": userAgent,
      "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
      "Accept-Language": "en-US,en;q=0.9",
      "Cache-Control": "no-cache",
      "Pragma": "no-cache",
    },
    cache: "no-store",
    signal: AbortSignal.timeout(25_000),
    redirect: "follow",
  });
  if (!response.ok) throw new Error(response.status === 403 || response.status === 429 ? "TikTok 暂时限制访问，请稍后重试" : `TikTok 请求失败（HTTP ${response.status}）`);
  return response.text();
}

export async function POST(request: Request) {
  if (!matchesAccessCode(request.headers.get("x-access-code") ?? "")) return Response.json({ error: "访问口令不正确" }, { status: 401, headers: noStore });
  try {
    const body = await request.json() as { url?: string };
    const source = String(body.url ?? "").trim();
    if (source.length > 1200 || !/^https?:\/\//i.test(source)) throw new Error("链接格式不正确");
    const match = source.match(contentPattern);
    if (!match || !/tiktok\.com/i.test(source)) throw new Error("不是有效的 TikTok 视频或图文链接");
    const contentType = match[1].toLowerCase() as "video" | "photo";
    const id = match[2];
    const target = contentType === "photo"
      ? `https://www.tiktok.com/embed/v2/${id}?_ts=${Date.now()}`
      : `https://www.tiktok.com/@_/${contentType}/${id}?_ts=${Date.now()}`;
    let lastError: unknown;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const page = await fetchTikTok(target);
        const parsed = contentType === "photo" ? parseEmbedPage(page, id, contentType) : parsePage(page, id, contentType);
        return Response.json(parsed, { headers: noStore });
      }
      catch (error) { lastError = error; if (!attempt) await new Promise((resolve) => setTimeout(resolve, 450)); }
    }
    throw lastError;
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "获取失败" }, { status: 400, headers: noStore });
  }
}
