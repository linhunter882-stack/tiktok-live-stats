import { matchesAccessCode } from "../verify/route";

export const dynamic = "force-dynamic";

function csvCell(value: unknown) {
  const text = String(value ?? "");
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

export async function POST(request: Request) {
  try {
    const form = await request.formData();
    if (!matchesAccessCode(String(form.get("accessCode") ?? ""))) return new Response("Unauthorized", { status: 401 });
    const raw = String(form.get("payload") ?? "");
    if (!raw || raw.length > 5_000_000) throw new Error("导出数据为空或过大");
    const data = JSON.parse(raw) as { results?: Array<Record<string, unknown>>; summary?: { success?: number; totals?: Record<string, unknown> } };
    const results = Array.isArray(data.results) ? data.results.slice(0, 10_000) : [];
    const totals = data.summary?.totals ?? {};
    const headings = ["序号", "类型", "视频链接", "作者", "发布时间（北京时间）", "播放量", "点赞数", "评论数", "收藏数", "分享数", "抓取时间", "状态", "错误"];
    const rows = results.map((item, index) => [index + 1, item.contentType === "photo" ? "图文" : "视频", item.url, item.author, item.publishedAt, item.views, item.likes, item.comments, item.saves, item.shares, item.fetchedAt, item.status === "success" ? "成功" : item.status === "error" ? "失败" : "未完成", item.error]);
    rows.push(["合计", "", "", `成功 ${data.summary?.success ?? 0} 条`, "", totals.views, totals.likes, totals.comments, totals.saves, totals.shares, "", "", ""]);
    const content = "\ufeff" + [headings, ...rows].map((row) => row.map(csvCell).join(",")).join("\r\n");
    return new Response(content, {
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="tiktok-data-${new Date().toISOString().slice(0, 10)}.csv"`,
        "Cache-Control": "no-store",
      },
    });
  } catch (error) {
    return new Response(error instanceof Error ? error.message : "导出失败", { status: 400 });
  }
}
