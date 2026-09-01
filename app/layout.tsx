import type { Metadata } from "next";
import { headers } from "next/headers";
import "./globals.css";

export async function generateMetadata(): Promise<Metadata> {
  const requestHeaders = await headers();
  const host = requestHeaders.get("x-forwarded-host") ?? requestHeaders.get("host") ?? "localhost";
  const protocol = requestHeaders.get("x-forwarded-proto") ?? (host.startsWith("localhost") ? "http" : "https");
  const image = `${protocol}://${host}/og.png`;
  return {
    title: "TikTok 实时数据助手",
    description: "批量获取 TikTok 公开视频的播放、点赞、评论、收藏和分享数据。",
    openGraph: { title: "TikTok 实时数据助手", description: "批量获取公开数据", images: [image] },
    twitter: { card: "summary_large_image", title: "TikTok 实时数据助手", description: "批量获取公开数据", images: [image] },
  };
}

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="zh-CN">
      <body>{children}</body>
    </html>
  );
}
