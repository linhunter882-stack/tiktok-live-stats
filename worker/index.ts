/** Cloudflare Worker entry point for the vinext-starter template. */
import { handleImageOptimization, DEFAULT_DEVICE_SIZES, DEFAULT_IMAGE_SIZES } from "vinext/server/image-optimization";
import handler from "vinext/server/app-router-entry";

interface Env {
  ASSETS: Fetcher;
  ACCESS_CODE?: string;
  DB: D1Database;
  IMAGES: {
    input(stream: ReadableStream): {
      transform(options: Record<string, unknown>): {
        output(options: { format: string; quality: number }): Promise<{ response(): Response }>;
      };
    };
  };
}

interface ExecutionContext {
  waitUntil(promise: Promise<unknown>): void;
  passThroughOnException(): void;
}

async function snapshotTrackedAccounts(env: Env) {
  if (!env.ACCESS_CODE || !env.DB) return;
  const cutoff = Date.now() - 20 * 60 * 60 * 1000;
  const accounts = await env.DB.prepare("SELECT username FROM follower_snapshots GROUP BY username HAVING MAX(observed_at) < ? ORDER BY MAX(observed_at) ASC LIMIT 50")
    .bind(cutoff).all<{ username: string }>();
  const rows = accounts.results ?? [];
  for (let index = 0; index < rows.length; index += 5) {
    const now = Math.floor(Date.now() / 1000);
    await Promise.allSettled(rows.slice(index, index + 5).map(({ username }) => fetch("https://tiktok-data.tuli7.com/api/profile", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-access-code": env.ACCESS_CODE! },
      body: JSON.stringify({ username, cursor: Date.now(), rangeStart: now - 86_400, rangeEnd: now + 1 }),
    })));
  }
}

// Image security config. SVG sources with .svg extension auto-skip the
// optimization endpoint on the client side (served directly, no proxy).
// To route SVGs through the optimizer (with security headers), set
// dangerouslyAllowSVG: true in next.config.js and uncomment below:
// const imageConfig: ImageConfig = { dangerouslyAllowSVG: true };

const worker = {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    if (env.ACCESS_CODE) process.env.ACCESS_CODE = env.ACCESS_CODE;
    globalThis.__TIKTOK_DATA_DB__ = env.DB;
    const url = new URL(request.url);

    if (url.pathname === "/_vinext/image") {
      const allowedWidths = [...DEFAULT_DEVICE_SIZES, ...DEFAULT_IMAGE_SIZES];
      return handleImageOptimization(request, {
        fetchAsset: (path) => env.ASSETS.fetch(new Request(new URL(path, request.url))),
        transformImage: async (body, { width, format, quality }) => {
          const result = await env.IMAGES.input(body).transform(width > 0 ? { width } : {}).output({ format, quality });
          return result.response();
        },
      }, allowedWidths);
    }

    const response = await handler.fetch(request, env, ctx);
    const headers = new Headers(response.headers);
    headers.set("X-Content-Type-Options", "nosniff");
    headers.set("X-Frame-Options", "DENY");
    headers.set("Referrer-Policy", "no-referrer");
    headers.set("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
    return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
  },
  async scheduled(_controller: ScheduledController, env: Env, ctx: ExecutionContext) {
    ctx.waitUntil(snapshotTrackedAccounts(env));
  },
};

export default worker;
