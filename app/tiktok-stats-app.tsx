"use client";

import { ChangeEvent, DragEvent, useEffect, useMemo, useRef, useState } from "react";

type Status = "queued" | "running" | "success" | "error";
type Mode = "links" | "profile";
type RangeMode = "sevenDays" | "month";
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
type ProfileResult = Result & { createdAt: number };
type ProfileInfo = { username: string; nickname: string; followerCount: number | null; videoCount: number | null };
type ProfilePage = {
  profile?: ProfileInfo;
  secUid: string;
  deviceId: string;
  cursor: number;
  nextCursor: number;
  hasMore: boolean;
  items: ProfileResult[];
  error?: string;
};

const TIKTOK_URL = /https?:\/\/(?:(?:www|m|vm|vt)\.)?tiktok\.com\/[^\s<>"'\]\)]+/gi;
const CONTENT_ID = /\/(video|photo)\/(\d{15,25})/i;
const PAGE_SIZE = 50;
const CONCURRENCY = 4;
const EMPTY_METRICS: Metrics = { views: 0, likes: 0, comments: 0, saves: 0, shares: 0 };
const DAY_SECONDS = 86_400;

function beijingMonth() {
  return new Date(Date.now() + 8 * 3600_000).toISOString().slice(0, 7);
}

function selectedRange(mode: RangeMode, month: string) {
  const now = Math.floor(Date.now() / 1000);
  if (mode === "sevenDays") return { start: now - 7 * DAY_SECONDS, end: now + 1, label: "近 7 天" };
  const match = month.match(/^(\d{4})-(\d{2})$/);
  if (!match) throw new Error("请选择查询月份");
  const year = Number(match[1]);
  const monthIndex = Number(match[2]) - 1;
  const start = Date.UTC(year, monthIndex, 1) / 1000 - 8 * 3600;
  const end = Math.min(Date.UTC(year, monthIndex + 1, 1) / 1000 - 8 * 3600, now + 1);
  if (start > now) throw new Error("不能查询未来月份");
  return { start, end, label: `${year} 年 ${monthIndex + 1} 月` };
}

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

function friendlyError(message: string) {
  const value = message.toLowerCase();
  if (value.includes("item doesn't exist") || value.includes("not found")) return "内容不存在或已下架";
  if (value.includes("status_deleted") || value.includes("deleted")) return "内容已被删除";
  if (value.includes("privacy") || value.includes("private")) return "内容为私密或账号无权访问";
  if (value.includes("403") || value.includes("429") || value.includes("限制访问")) return "TikTok 暂时限制访问，请稍后重试";
  if (value.includes("timeout") || value.includes("timed out") || value.includes("aborted")) return "请求超时，请稍后重试";
  if (value.includes("network") || value.includes("连接")) return "网络连接失败，请稍后重试";
  return message || "未知错误，请稍后重试";
}

export function TikTokStatsApp() {
  const [accessCode, setAccessCode] = useState("");
  const [authorized, setAuthorized] = useState(false);
  const [checking, setChecking] = useState(false);
  const [gateError, setGateError] = useState("");
  const [mode, setMode] = useState<Mode>("links");
  const [input, setInput] = useState("");
  const [profileInput, setProfileInput] = useState("");
  const [rangeMode, setRangeMode] = useState<RangeMode>("sevenDays");
  const [month, setMonth] = useState(beijingMonth);
  const [profileInfo, setProfileInfo] = useState<ProfileInfo | null>(null);
  const [profileProgress, setProfileProgress] = useState({ pages: 0, scanned: 0 });
  const [activeRangeLabel, setActiveRangeLabel] = useState("");
  const [taskError, setTaskError] = useState("");
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

  function changeMode(next: Mode) {
    if (running || next === mode) return;
    setMode(next); setResults([]); setPage(1); setCancelled(false); setTaskError("");
    setProfileInfo(null); setProfileProgress({ pages: 0, scanned: 0 }); setActiveRangeLabel("");
  }

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
      updateResult(item.key, { status: "error", error: friendlyError(error instanceof Error ? error.message : "获取失败"), fetchedAt: new Date().toLocaleString("zh-CN", { hour12: false }) });
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

  async function startProfile() {
    if (!profileInput.trim() || running) return;
    let range: ReturnType<typeof selectedRange>;
    try { range = selectedRange(rangeMode, month); }
    catch (error) { setTaskError(error instanceof Error ? error.message : "时间范围不正确"); return; }

    cancelledRef.current = false; setCancelled(false); setRunning(true); setTaskError("");
    setResults([]); setPage(1); setProfileInfo(null); setProfileProgress({ pages: 0, scanned: 0 });
    setActiveRangeLabel(range.label);
    const seenIds = new Set<string>();
    const seenCursors = new Set<number>();
    let cursor = range.end * 1000;
    let secUid = "";
    let deviceId = "";

    try {
      for (let pageNumber = 1; pageNumber <= 100 && !cancelledRef.current; pageNumber += 1) {
        if (seenCursors.has(cursor)) throw new Error("TikTok 分页游标停滞，请重新查询");
        seenCursors.add(cursor);
        const response = await fetch("/api/profile", {
          method: "POST",
          headers: { "Content-Type": "application/json", "x-access-code": accessCode },
          body: JSON.stringify({ username: secUid ? undefined : profileInput, secUid: secUid || undefined, cursor, deviceId: deviceId || undefined }),
        });
        const data = await response.json() as ProfilePage;
        if (response.status === 401) { setAuthorized(false); sessionStorage.removeItem("tt-access-code"); throw new Error("访问口令已失效，请重新输入"); }
        if (!response.ok) throw new Error(data.error || "账号数据获取失败");
        secUid = data.secUid; deviceId = data.deviceId;
        if (data.profile) setProfileInfo(data.profile);
        const matched = data.items.filter((item) => item.createdAt >= range.start && item.createdAt < range.end && !seenIds.has(item.key));
        matched.forEach((item) => seenIds.add(item.key));
        if (matched.length) setResults((current) => [...current, ...matched].sort((a, b) => (Number((b as ProfileResult).createdAt) || 0) - (Number((a as ProfileResult).createdAt) || 0)));
        setProfileProgress((current) => ({ pages: pageNumber, scanned: current.scanned + data.items.length }));
        if (!data.hasMore || data.nextCursor <= range.start * 1000) break;
        if (!Number.isFinite(data.nextCursor) || data.nextCursor >= cursor) throw new Error("TikTok 分页未向前推进，请重新查询");
        cursor = data.nextCursor;
      }
    } catch (error) {
      if (!cancelledRef.current) setTaskError(friendlyError(error instanceof Error ? error.message : "账号数据获取失败"));
    } finally {
      setRunning(false);
    }
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
    const form = document.createElement("form");
    form.method = "POST";
    form.action = "/api/export";
    form.target = "_self";
    form.hidden = true;
    for (const [name, value] of Object.entries({ accessCode, payload: JSON.stringify({ results, summary }) })) {
      const field = document.createElement("input");
      field.type = "hidden"; field.name = name; field.value = value; form.appendChild(field);
    }
    document.body.appendChild(form);
    form.submit();
    window.setTimeout(() => form.remove(), 1000);
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
        <div className={`card input-card ${mode === "links" && dragging ? "drop-active" : ""}`} onDragEnter={(event) => { if (mode === "links") { event.preventDefault(); setDragging(true); } }} onDragOver={(event) => { if (mode === "links") event.preventDefault(); }} onDragLeave={() => setDragging(false)} onDrop={(event) => { if (mode === "links") onDrop(event); }}>
          <div className="mode-tabs" role="tablist" aria-label="查询方式">
            <button type="button" role="tab" aria-selected={mode === "links"} className={mode === "links" ? "active" : ""} disabled={running} onClick={() => changeMode("links")}>批量链接查询</button>
            <button type="button" role="tab" aria-selected={mode === "profile"} className={mode === "profile" ? "active" : ""} disabled={running} onClick={() => changeMode("profile")}>账号时间段查询</button>
          </div>

          {mode === "links" ? <>
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
            <p className="inline-note"><strong>已识别 {formatNumber(parsed.links.length)} 条 TikTok 内容</strong>{parsed.ignored ? `，忽略 ${formatNumber(parsed.ignored)} 个其他平台链接` : ""}。支持批量链接，系统会自动排队处理；处理期间请保持页面打开。</p>
          </> : <>
            <div className="input-head"><div><h2>查询账号公开视频</h2><p className="helper">输入 @用户名或 TikTok 主页链接，自动按时间筛选并汇总</p></div><span className="count-pill">单账号</span></div>
            <div className="profile-form">
              <label className="field" htmlFor="profile-input"><span>TikTok 账号</span><input id="profile-input" type="text" spellCheck={false} value={profileInput} disabled={running} onChange={(event) => setProfileInput(event.target.value)} placeholder="@_vanybunny_ 或主页链接" /></label>
              <fieldset className="range-field"><legend>时间范围</legend><div className="range-options">
                <label><input type="radio" name="range" value="sevenDays" checked={rangeMode === "sevenDays"} disabled={running} onChange={() => setRangeMode("sevenDays")} />近 7 天</label>
                <label><input type="radio" name="range" value="month" checked={rangeMode === "month"} disabled={running} onChange={() => setRangeMode("month")} />指定月份</label>
              </div></fieldset>
              <label className={`field month-field ${rangeMode === "month" ? "" : "field-muted"}`} htmlFor="profile-month"><span>月份</span><input id="profile-month" type="month" value={month} max={beijingMonth()} disabled={running || rangeMode !== "month"} onChange={(event) => setMonth(event.target.value)} /></label>
            </div>
            <div className="actions">
              <div className="action-group"><button className="btn btn-primary" type="button" disabled={!profileInput.trim() || running} onClick={() => void startProfile()}>查询账号数据</button>{running && <button className="btn btn-secondary" type="button" onClick={stop}>停止查询</button>}</div>
              <button className="btn btn-quiet" type="button" disabled={running} onClick={() => setProfileInput("")}>清空</button>
            </div>
            <p className="inline-note"><strong>统计该时间段发布内容的当前累计数据</strong>，不是该时间段内新增的播放量；公开账号无需登录。</p>
          </>}
        </div>

        <aside className="card task-card" aria-label="任务进度">
          <div className="task-head"><h2>本次任务</h2><span className={`task-state ${taskError ? "task-state-error" : ""}`}>{running ? (mode === "profile" ? "扫描中" : "处理中") : taskError ? "查询失败" : cancelled ? "已停止" : (mode === "profile" ? profileInfo !== null : summary.total > 0) ? "已完成" : "等待开始"}</span></div>
          {mode === "links" ? <>
            <div className="summary">
              <div className="stat"><span className="stat-label">总链接</span><strong>{formatNumber(summary.total)}</strong></div>
              <div className="stat"><span className="stat-label">已完成</span><strong>{formatNumber(summary.done)}</strong></div>
              <div className="stat"><span className="stat-label">成功</span><strong>{formatNumber(summary.success)}</strong></div>
              <div className="stat"><span className="stat-label">失败</span><strong>{formatNumber(summary.failed)}</strong></div>
            </div>
            <div className="progress-wrap"><div className="progress-meta"><span>处理进度</span><span>{percent}%</span></div><div className="progress" role="progressbar" aria-label="处理进度" aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent}><div className="progress-bar" style={{ width: `${percent}%` }} /></div></div>
            <div className="task-message" aria-live="polite">{running ? `正在批量获取，剩余 ${formatNumber(summary.total - summary.done)} 条。` : summary.total ? `本次成功 ${formatNumber(summary.success)} 条，失败 ${formatNumber(summary.failed)} 条。` : "提交后数据会逐条显示在下方。"}</div>
            <div className="action-group"><button className="btn btn-secondary" type="button" disabled={running || !summary.failed} onClick={() => void retryFailed()}>重试失败项</button><button className="btn btn-secondary" type="button" disabled={!summary.total} onClick={exportCsv}>导出 CSV</button></div>
          </> : <>
            <div className="summary">
              <div className="stat"><span className="stat-label">匹配内容</span><strong>{formatNumber(summary.success)}</strong></div>
              <div className="stat"><span className="stat-label">已扫描</span><strong>{formatNumber(profileProgress.scanned)}</strong></div>
              <div className="stat"><span className="stat-label">已翻页</span><strong>{formatNumber(profileProgress.pages)}</strong></div>
              <div className="stat stat-text"><span className="stat-label">查询范围</span><strong>{activeRangeLabel || (rangeMode === "sevenDays" ? "近 7 天" : month)}</strong></div>
            </div>
            <div className="progress-wrap"><div className="progress-meta"><span>账号扫描</span><span>{running ? "进行中" : profileInfo ? "完成" : "等待"}</span></div><div className="progress" role="progressbar" aria-label="账号扫描进度" aria-valuetext={running ? "正在扫描" : "扫描结束"}><div className={`progress-bar ${running ? "progress-scanning" : ""}`} style={{ width: running ? "58%" : profileInfo ? "100%" : "0%" }} /></div></div>
            <div className="task-message" aria-live="polite">{taskError ? <span className="task-error" role="alert">{taskError}</span> : running ? `正在扫描${profileInfo?.username ? ` @${profileInfo.username}` : "账号"}，已查看 ${formatNumber(profileProgress.scanned)} 条。` : cancelled ? "查询已停止，当前结果可以继续查看或导出。" : profileInfo ? `@${profileInfo.username} 在${activeRangeLabel}内共有 ${formatNumber(summary.success)} 条公开内容。` : "输入账号和时间范围后开始查询。"}</div>
            <div className="action-group"><button className="btn btn-secondary" type="button" disabled={running || !profileInput.trim()} onClick={() => void startProfile()}>重新查询</button><button className="btn btn-secondary" type="button" disabled={!summary.total} onClick={exportCsv}>导出 CSV</button></div>
          </>}
        </aside>
      </section>

      <section className="card results" aria-labelledby="results-title">
        <div className="results-head"><div><h2 id="results-title">{mode === "profile" ? "账号查询结果" : "抓取结果"}</h2><div className="results-meta">{mode === "profile" ? `${profileInfo ? `@${profileInfo.username} · ` : ""}${activeRangeLabel || "等待查询"} · ${formatNumber(summary.success)} 条` : `共 ${formatNumber(summary.total)} 条 · 成功 ${formatNumber(summary.success)} · 失败 ${formatNumber(summary.failed)}`}</div></div><div className="results-meta">{mode === "profile" ? "以下为查询时的累计公开数据" : "合计仅包含成功结果"}</div></div>
        <div className="aggregate" aria-label="成功结果数据合计">
          <div className="aggregate-item"><span>总播放量</span><strong title={String(summary.totals.views)}>{formatMetric(summary.totals.views)}</strong></div>
          <div className="aggregate-item"><span>总点赞</span><strong title={String(summary.totals.likes)}>{formatMetric(summary.totals.likes)}</strong></div>
          <div className="aggregate-item"><span>总评论</span><strong title={String(summary.totals.comments)}>{formatMetric(summary.totals.comments)}</strong></div>
          <div className="aggregate-item"><span>总收藏</span><strong title={String(summary.totals.saves)}>{formatMetric(summary.totals.saves)}</strong></div>
          <div className="aggregate-item"><span>总分享</span><strong title={String(summary.totals.shares)}>{formatMetric(summary.totals.shares)}</strong></div>
        </div>
        <div className="table-wrap">
          <table><thead><tr><th>#</th><th>状态</th><th>失败原因</th><th>内容</th><th>发布时间</th><th>播放量</th><th>点赞</th><th>评论</th><th>收藏</th><th>分享</th><th>抓取时间</th><th>链接</th></tr></thead>
            <tbody>{visibleResults.length ? visibleResults.map((item, index) => (
              <tr key={item.key}><td>{(page - 1) * PAGE_SIZE + index + 1}</td><td><span className={`status status-${item.status}`}>{item.status === "queued" ? "等待" : item.status === "running" ? "获取中" : item.status === "success" ? "成功" : "失败"}</span></td><td className="reason-cell" title={item.error}>{item.status === "error" ? item.error : "—"}</td><td className="video-cell"><strong>{item.author ? `@${item.author}` : `${item.contentType === "photo" ? "图文" : "视频"} ${item.videoId}`}</strong><span className="description">{item.description || "等待获取内容信息"}</span></td><td>{item.publishedAt || "—"}</td><td>{item.status === "success" ? formatMetric(item.views) : "—"}</td><td>{item.status === "success" ? formatMetric(item.likes) : "—"}</td><td>{item.status === "success" ? formatMetric(item.comments) : "—"}</td><td>{item.status === "success" ? formatMetric(item.saves) : "—"}</td><td>{item.status === "success" ? formatMetric(item.shares) : "—"}</td><td>{item.fetchedAt || "—"}</td><td><a className="link" href={item.url || item.sourceUrl} target="_blank" rel="noopener noreferrer">打开</a></td></tr>
            )) : <tr><td className="empty-row" colSpan={12}>{mode === "profile" ? "账号内容会在扫描后显示在这里" : "结果会在这里逐条出现"}</td></tr>}</tbody>
          </table>
        </div>
        <div className="pager"><button className="page-button" type="button" aria-label="上一页" disabled={page <= 1} onClick={() => setPage((value) => value - 1)}>‹</button><span>第 {page} / {pages} 页</span><button className="page-button" type="button" aria-label="下一页" disabled={page >= pages} onClick={() => setPage((value) => value + 1)}>›</button></div>
      </section>
      <footer className="footer"><span>仅处理 TikTok 公开内容；私密、删除或地区受限内容无法获取。</span><span>数据为每次查询时 TikTok 返回的公开快照。</span></footer>
    </main>
  );
}
