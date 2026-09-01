"use client";

import { ChangeEvent, DragEvent, useEffect, useMemo, useRef, useState } from "react";

type Status = "queued" | "running" | "success" | "error";
type Metrics = { views: number | null; likes: number | null; comments: number | null; saves: number | null; shares: number | null };
type Result = Metrics & {
  key: string;
  sourceUrl: string;
  url: string;
  contentType: "video" | "photo";
  videoId: string;
  author: string;
  description: string;
  publishedAt: string;
  fetchedAt: string;
  status: Status;
  error: string;
};

const TIKTOK_URL = /https?:\/\/(?:(?:www|m|vm|vt)\.)?tiktok\.com\/[^\s<>"'\]\)]+/gi;
const CONTENT_ID = /\/(video|photo)\/(\d{15,25})/i;
const PAGE_SIZE = 50;
const CONCURRENCY = 4;
const EMPTY_METRICS: Metrics = { views: 0, likes: 0, comments: 0, saves: 0, shares: 0 };

function collectLinks(text: string) {
  const seen = new Set<string>();
  const links: { key: string; url: string; type: "video" | "photo"; id: string }[] = [];
  for (const value of text.match(TIKTOK_URL) ?? []) {
    const match = value.match(CONTENT_ID);
    if (!match) continue;
    const [, rawType, id] = match;
    if (seen.has(id)) continue;
    seen.add(id);
    links.push({ key: id, url: value, type: rawType.toLowerCase() as "video" | "photo", id });
  }
  const allExternal = text.match(/https?:\/\/[^\s<>"'\]\)]+/gi) ?? [];
  const ignored = new Set(allExternal.filter((value) => !/tiktok\.com/i.test(value))).size;
  return { links, ignored };
}

function emptyResult(link: ReturnType<typeof collectLinks>["links"][number]): Result {
  return {
    ...EMPTY_METRICS,
    key: link.key,
    sourceUrl: link.url,
    url: link.url,
    contentType: link.type,
    videoId: link.id,
    author: "",
    description: "",
    publishedAt: "",
    fetchedAt: "",
    status: "queued",
    error: "",
  };
}

function formatNumber(value: number) {
  return new Intl.NumberFormat("zh-CN").format(value || 0);
}

function formatMetric(value: number | null) {
  return value === null ? "—" : formatNumber(value);
}

function csvCell(value: unknown) {
  const text = String(value ?? "");
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

export function TikTokStatsApp() {
  const [accessCode, setAccessCode] = useState("");
  const [authorized, setAuthorized] = useState(false);
  const [checking, setChecking] = useState(false);
  const [gateError, setGateError] = useState("");
  const [input, setInput] = useState("");
  const [results, setResults] = useState<Result[]>([]);
  const [running, setRunning] = useState(false);
  const [cancelled, setCancelled] = useState(false);
  const [page, setPage] = useState(1);
  const [dragging, setDragging] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const cancelledRef = useRef(false);
  const parsed = useMemo(() => collectLinks(input), [input]);

  useEffect(() => {
    const saved = sessionStorage.getItem("tt-access-code");
    if (saved) void verify(saved, false);
  }, []);

  const summary = useMemo(() => {
    const success = results.filter((item) => item.status === "success");
    const failed = results.filter((item) => item.status === "error").length;
    const done = success.length + failed;
    const totals = success.reduce<Metrics>((sum, item) => ({
      views: (sum.views ?? 0) + (item.views ?? 0),
      likes: (sum.likes ?? 0) + (item.likes ?? 0),
      comments: (sum.comments ?? 0) + (item.comments ?? 0),
      saves: (sum.saves ?? 0) + (item.saves ?? 0),
      shares: (sum.shares ?? 0) + (item.shares ?? 0),
    }), { ...EMPTY_METRICS });
    return { total: results.length, success: success.length, failed, done, totals };
  }, [results]);

  const percent = summary.total ? Math.round(summary.done / summary.total * 100) : 0;
  const pages = Math.max(1, Math.ceil(results.length / PAGE_SIZE));
  const visibleResults = results.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);

  async function verify(code = accessCode, showError = true) {
    if (!code.trim()) { setGateError("请输入访问口令"); return; }
    setChecking(true); if (showError) setGateError("");
    try {
      const response = await fetch("/api/verify", { headers: { "x-access-code": code.trim() }, cache: "no-store" });
      if (!response.ok) throw new Error("访问口令不正确");
      sessionStorage.setItem("tt-access-code", code.trim());
      setAccessCode(code.trim()); setAuthorized(true); setGateError("");
    } catch (error) {
      sessionStorage.removeItem("tt-access-code");
      if (showError) setGateError(error instanceof Error ? error.message : "验证失败");
    } finally { setChecking(false); }
  }

  function updateResult(key: string, patch: Partial<Result>) {
    setResults((current) => current.map((item) => item.key === key ? { ...item, ...patch } : item));
  }

  async function scrapeOne(item: Result) {
    updateResult(item.key, { status: "running", error: "" });
    try {
      const response = await fetch("/api/scrape", {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-access-code": accessCode },
        body: JSON.stringify({ url: item.sourceUrl }),
      });
      const data = await response.json() as Partial<Result> & { error?: string };
      if (response.status === 401) { setAuthorized(false); sessionStorage.removeItem("tt-access-code"); throw new Error("访问口令已失效，请重新输入"); }
      if (!response.ok) throw new Error(data.error || "获取失败");
      updateResult(item.key, { ...data, status: "success", error: "" });
    } catch (error) {
      updateResult(item.key, { status: "error", error: error instanceof Error ? error.message : "获取失败", fetchedAt: new Date().toLocaleString("zh-CN", { hour12: false }) });
    }
  }

  async function runQueue(queue: Result[]) {
    cancelledRef.current = false; setCancelled(false); setRunning(true);
    let cursor = 0;
    const worker = async () => {
      while (!cancelledRef.current) {
        const index = cursor++;
        if (index >= queue.length) return;
        await scrapeOne(queue[index]);
      }
    };
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, queue.length) }, worker));
    setRunning(false);
  }

  async function start() {
    if (!parsed.links.length || running) return;
    const initial = parsed.links.map(emptyResult);
    setResults(initial); setPage(1);
    await runQueue(initial);
  }

  async function retryFailed() {
    if (running) return;
    const failed = results.filter((item) => item.status === "error");
    await runQueue(failed);
  }

  function stop() {
    cancelledRef.current = true; setCancelled(true);
  }

  async function readFiles(files: FileList | File[]) {
    const chunks = await Promise.all(Array.from(files).map((file) => file.text()));
    setInput((current) => [current, ...chunks].filter(Boolean).join("\n"));
  }

  function onFiles(event: ChangeEvent<HTMLInputElement>) {
    if (event.target.files) void readFiles(event.target.files);
    event.target.value = "";
  }

  function onDrop(event: DragEvent<HTMLDivElement>) {
    event.preventDefault(); setDragging(false);
    if (event.dataTransfer.files.length) void readFiles(event.dataTransfer.files);
  }

  function exportCsv() {
    const headings = ["序号", "类型", "视频链接", "作者", "发布时间（北京时间）", "播放量", "点赞数", "评论数", "收藏数", "分享数", "抓取时间", "状态", "错误"];
    const rows = results.map((item, index) => [index + 1, item.contentType === "photo" ? "图文" : "视频", item.url, item.author, item.publishedAt, item.views, item.likes, item.comments, item.saves, item.shares, item.fetchedAt, item.status === "success" ? "成功" : item.status === "error" ? "失败" : "未完成", item.error]);
    rows.push(["合计", "", "", `成功 ${summary.success} 条`, "", summary.totals.views, summary.totals.likes, summary.totals.comments, summary.totals.saves, summary.totals.shares, "", "", ""]);
    const content = "\ufeff" + [headings, ...rows].map((row) => row.map(csvCell).join(",")).join("\r\n");
    const link = document.createElement("a");
    link.href = URL.createObjectURL(new Blob([content], { type: "text/csv;charset=utf-8" }));
    link.download = `tiktok-data-${new Date().toISOString().slice(0,10)}.csv`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    window.setTimeout(() => URL.revokeObjectURL(link.href), 1000);
  }

  if (!authorized) {
    return (
      <main className="gate">
        <section className="card gate-card" aria-labelledby="gate-title">
          <div className="gate-mark" aria-hidden="true">T</div>
          <h1 id="gate-title">TikTok 实时数据助手</h1>
          <p className="subtitle">输入团队访问口令后使用</p>
          <label htmlFor="access-code">访问口令</label>
          <input id="access-code" type="password" autoComplete="current-password" value={accessCode} onChange={(event) => setAccessCode(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") void verify(); }} aria-describedby="gate-error" />
          <p id="gate-error" className="gate-error" role="alert">{gateError}</p>
          <button className="btn btn-primary" type="button" disabled={checking} onClick={() => void verify()}>{checking ? "正在验证…" : "进入工具"}</button>
        </section>
      </main>
    );
  }

  return (
    <main className="app-shell">
      <header className="topbar">
        <div className="brand"><div className="brand-mark" aria-hidden="true">T</div><div><h1>TikTok 实时数据助手</h1><p className="subtitle">批量获取公开视频与图文的最新互动数据</p></div></div>
        <div className="online-badge">公网在线版</div>
      </header>

      <section className="main-grid">
        <div className={`card input-card ${dragging ? "drop-active" : ""}`} onDragEnter={(event) => { event.preventDefault(); setDragging(true); }} onDragOver={(event) => event.preventDefault()} onDragLeave={() => setDragging(false)} onDrop={onDrop}>
          <div className="input-head"><div><h2>添加 TikTok 链接</h2><p className="helper">一行一个，也可粘贴整段文本；自动去重并忽略其他平台</p></div><span className="count-pill">{formatNumber(parsed.links.length)} 条</span></div>
          <label className="sr-only" htmlFor="url-input">TikTok 视频或图文链接</label>
          <textarea id="url-input" spellCheck={false} value={input} onChange={(event) => setInput(event.target.value)} placeholder={"https://www.tiktok.com/@creator/video/1234567890123456789\nhttps://www.tiktok.com/@creator/photo/9876543210987654321"} />
          <input ref={fileInput} className="sr-only" type="file" accept=".txt,.csv,text/plain,text/csv" multiple onChange={onFiles} />
          <div className="actions">
            <div className="action-group">
              <button className="btn btn-primary" type="button" disabled={!parsed.links.length || running} onClick={() => void start()}>开始获取</button>
              <button className="btn btn-secondary" type="button" disabled={running} onClick={() => fileInput.current?.click()}>上传 TXT / CSV</button>
              {running && <button className="btn btn-secondary" type="button" onClick={stop}>停止排队</button>}
            </div>
            <button className="btn btn-quiet" type="button" disabled={running} onClick={() => setInput("")}>清空</button>
          </div>
          <p className="inline-note"><strong>已识别 {formatNumber(parsed.links.length)} 条 TikTok 内容</strong>{parsed.ignored ? `，忽略 ${formatNumber(parsed.ignored)} 个其他平台链接` : ""}。最多同时处理 {CONCURRENCY} 条，请保持页面打开。</p>
        </div>

        <aside className="card task-card" aria-label="任务进度">
          <div className="task-head"><h2>本次任务</h2><span className="task-state">{running ? "处理中" : summary.total && summary.done === summary.total ? "已完成" : cancelled ? "已停止" : "等待开始"}</span></div>
          <div className="summary">
            <div className="stat"><span className="stat-label">总链接</span><strong>{formatNumber(summary.total)}</strong></div>
            <div className="stat"><span className="stat-label">已完成</span><strong>{formatNumber(summary.done)}</strong></div>
            <div className="stat"><span className="stat-label">成功</span><strong>{formatNumber(summary.success)}</strong></div>
            <div className="stat"><span className="stat-label">失败</span><strong>{formatNumber(summary.failed)}</strong></div>
          </div>
          <div className="progress-wrap"><div className="progress-meta"><span>处理进度</span><span>{percent}%</span></div><div className="progress" role="progressbar" aria-label="处理进度" aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent}><div className="progress-bar" style={{ width: `${percent}%` }} /></div></div>
          <div className="task-message">{running ? `正在批量获取，剩余 ${formatNumber(summary.total - summary.done)} 条。` : summary.total ? `本次成功 ${formatNumber(summary.success)} 条，失败 ${formatNumber(summary.failed)} 条。` : "提交后数据会逐条显示在下方。"}</div>
          <div className="action-group"><button className="btn btn-secondary" type="button" disabled={running || !summary.failed} onClick={() => void retryFailed()}>重试失败项</button><button className="btn btn-secondary" type="button" disabled={!summary.total} onClick={exportCsv}>导出 CSV</button></div>
        </aside>
      </section>

      <section className="card results" aria-labelledby="results-title">
        <div className="results-head"><div><h2 id="results-title">抓取结果</h2><div className="results-meta">共 {formatNumber(summary.total)} 条 · 成功 {formatNumber(summary.success)} · 失败 {formatNumber(summary.failed)}</div></div><div className="results-meta">合计仅包含成功结果</div></div>
        <div className="aggregate" aria-label="成功结果数据合计">
          <div className="aggregate-item"><span>总播放量</span><strong title={String(summary.totals.views)}>{formatMetric(summary.totals.views)}</strong></div>
          <div className="aggregate-item"><span>总点赞</span><strong title={String(summary.totals.likes)}>{formatMetric(summary.totals.likes)}</strong></div>
          <div className="aggregate-item"><span>总评论</span><strong title={String(summary.totals.comments)}>{formatMetric(summary.totals.comments)}</strong></div>
          <div className="aggregate-item"><span>总收藏</span><strong title={String(summary.totals.saves)}>{formatMetric(summary.totals.saves)}</strong></div>
          <div className="aggregate-item"><span>总分享</span><strong title={String(summary.totals.shares)}>{formatMetric(summary.totals.shares)}</strong></div>
        </div>
        <div className="table-wrap">
          <table><thead><tr><th>#</th><th>状态</th><th>内容</th><th>发布时间</th><th>播放量</th><th>点赞</th><th>评论</th><th>收藏</th><th>分享</th><th>抓取时间</th><th>链接</th></tr></thead>
            <tbody>{visibleResults.length ? visibleResults.map((item, index) => (
              <tr key={item.key}><td>{(page - 1) * PAGE_SIZE + index + 1}</td><td><span className={`status status-${item.status}`}>{item.status === "queued" ? "等待" : item.status === "running" ? "获取中" : item.status === "success" ? "成功" : "失败"}</span>{item.error && <span className="error-text" title={item.error}>{item.error}</span>}</td><td className="video-cell"><strong>{item.author ? `@${item.author}` : `${item.contentType === "photo" ? "图文" : "视频"} ${item.videoId}`}</strong><span className="description">{item.description || "等待获取内容信息"}</span></td><td>{item.publishedAt || "—"}</td><td>{item.status === "success" ? formatMetric(item.views) : "—"}</td><td>{item.status === "success" ? formatMetric(item.likes) : "—"}</td><td>{item.status === "success" ? formatMetric(item.comments) : "—"}</td><td>{item.status === "success" ? formatMetric(item.saves) : "—"}</td><td>{item.status === "success" ? formatMetric(item.shares) : "—"}</td><td>{item.fetchedAt || "—"}</td><td><a className="link" href={item.url || item.sourceUrl} target="_blank" rel="noopener noreferrer">打开</a></td></tr>
            )) : <tr><td className="empty-row" colSpan={11}>结果会在这里逐条出现</td></tr>}</tbody>
          </table>
        </div>
        <div className="pager"><button className="page-button" type="button" aria-label="上一页" disabled={page <= 1} onClick={() => setPage((value) => value - 1)}>‹</button><span>第 {page} / {pages} 页</span><button className="page-button" type="button" aria-label="下一页" disabled={page >= pages} onClick={() => setPage((value) => value + 1)}>›</button></div>
      </section>
      <footer className="footer"><span>仅处理 TikTok 公开内容；私密、删除或地区受限内容会标记失败。</span><span>数据为每次请求时 TikTok 返回的公开快照。</span></footer>
    </main>
  );
}
