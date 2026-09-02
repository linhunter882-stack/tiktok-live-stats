"use client";

import { ChangeEvent, DragEvent, useEffect, useMemo, useRef, useState } from "react";
import { collectAccounts } from "./account-input";
import { beijingDate, beijingMonth, selectedRange, type RangeMode } from "./date-range";
import { sortResults, type SortDirection, type SortKey } from "./result-sort";

type Status = "queued" | "running" | "success" | "error";
type Mode = "links" | "profile";
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
type FollowerGrowth = { username: string; current: number; ready: boolean; startCount: number | null; endCount: number | null; netGrowth: number | null; growthRate: number | null; startObservedAt: string | null; endObservedAt: string | null; trackedSince: string | null };
type ProfileBatch = { total: number; done: number; success: number; failed: number; current: string };
type ProfilePage = {
  profile?: ProfileInfo;
  followerGrowth?: FollowerGrowth | null;
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

function formatSignedMetric(value: number | null) {
  return value === null ? "待积累" : `${value > 0 ? "+" : ""}${formatNumber(value)}`;
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
  const [customStart, setCustomStart] = useState(beijingDate);
  const [customEnd, setCustomEnd] = useState(beijingDate);
  const [profileInfo, setProfileInfo] = useState<ProfileInfo | null>(null);
  const [followerGrowths, setFollowerGrowths] = useState<FollowerGrowth[]>([]);
  const [profileProgress, setProfileProgress] = useState({ pages: 0, scanned: 0 });
  const [profileBatch, setProfileBatch] = useState<ProfileBatch>({ total: 0, done: 0, success: 0, failed: 0, current: "" });
  const [profileErrors, setProfileErrors] = useState<string[]>([]);
  const [activeRangeLabel, setActiveRangeLabel] = useState("");
  const [taskError, setTaskError] = useState("");
  const [results, setResults] = useState<Result[]>([]);
  const [running, setRunning] = useState(false);
  const [cancelled, setCancelled] = useState(false);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState<50 | 100 | 200>(50);
  const [sortKey, setSortKey] = useState<SortKey | null>(null);
  const [sortDirection, setSortDirection] = useState<SortDirection>("desc");
  const [dragging, setDragging] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const cancelledRef = useRef(false);
  const parsed = useMemo(() => collectLinks(input), [input]);
  const parsedAccounts = useMemo(() => collectAccounts(profileInput), [profileInput]);

  useEffect(() => {
    const saved = sessionStorage.getItem("tt-access-code");
    if (saved) void verify(saved, false);
    // Restore the saved code only on first mount; later checks are user initiated.
    // eslint-disable-next-line react-hooks/exhaustive-deps
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
  const followerGrowthSummary = useMemo(() => {
    const ready = followerGrowths.filter((item) => item.ready && item.netGrowth !== null);
    return { netGrowth: ready.length ? ready.reduce((sum, item) => sum + (item.netGrowth ?? 0), 0) : null, ready: ready.length, tracked: followerGrowths.length };
  }, [followerGrowths]);
  const sortedResults = useMemo(() => sortResults(results, sortKey, sortDirection), [results, sortKey, sortDirection]);
  const pages = Math.max(1, Math.ceil(results.length / pageSize));
  const visibleResults = sortedResults.slice((page - 1) * pageSize, page * pageSize);
  const draftRangeLabel = rangeMode === "sevenDays" ? "近 7 天" : rangeMode === "month" ? month : customStart === customEnd ? `${customStart}（单日）` : `${customStart} 至 ${customEnd}`;
  const taskFinished = mode === "profile" ? profileBatch.total > 0 && profileBatch.done === profileBatch.total : summary.total > 0 && summary.done === summary.total;
  const profilePercent = profileBatch.total ? Math.round(profileBatch.done / profileBatch.total * 100) : 0;
  const profileHasFailures = mode === "profile" && taskFinished && profileBatch.failed > 0;
  const taskTone = taskError ? "error" : running ? "running" : cancelled || profileHasFailures ? "warning" : taskFinished ? "success" : "idle";
  const taskLabel = running ? (mode === "profile" ? "扫描中" : "处理中") : taskError ? "查询失败" : cancelled ? "已停止" : profileHasFailures ? (profileBatch.success ? "部分失败" : "全部失败") : taskFinished ? "已完成" : "等待开始";
  const profileScope = profileBatch.total > 1 ? `${profileBatch.success} 个账号` : profileInfo ? `@${profileInfo.username}` : "";

  function changeSort(key: SortKey) {
    setSortDirection(sortKey === key && sortDirection === "desc" ? "asc" : "desc");
    setSortKey(key); setPage(1);
  }

  function sortableHeader(label: string, key: SortKey) {
    const active = sortKey === key;
    const ariaSort: "none" | "ascending" | "descending" = active ? (sortDirection === "asc" ? "ascending" : "descending") : "none";
    return <th className="sortable-th" aria-sort={ariaSort}><button className={`sort-button ${active ? "active" : ""}`} type="button" aria-label={`按${label}排序${active ? `，当前${sortDirection === "desc" ? "从高到低" : "从低到高"}` : "，默认从高到低"}`} onClick={() => changeSort(key)}><span>{label}</span><span className="sort-mark" aria-hidden="true">{active ? (sortDirection === "desc" ? "↓" : "↑") : "↕"}</span></button></th>;
  }

  function changeMode(next: Mode) {
    if (running || next === mode) return;
    setMode(next); setResults([]); setPage(1); setCancelled(false); setTaskError("");
    setProfileInfo(null); setFollowerGrowths([]); setProfileProgress({ pages: 0, scanned: 0 }); setActiveRangeLabel("");
    setProfileBatch({ total: 0, done: 0, success: 0, failed: 0, current: "" }); setProfileErrors([]);
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
    if (running) return;
    if (!parsedAccounts.accounts.length) { setTaskError("请输入至少一个有效的 TikTok 账号"); return; }
    let range: ReturnType<typeof selectedRange>;
    try { range = selectedRange(rangeMode, month, customStart, customEnd); }
    catch (error) { setTaskError(error instanceof Error ? error.message : "时间范围不正确"); return; }

    cancelledRef.current = false; setCancelled(false); setRunning(true); setTaskError("");
    setResults([]); setPage(1); setProfileInfo(null); setFollowerGrowths([]); setProfileProgress({ pages: 0, scanned: 0 });
    setProfileErrors([]); setActiveRangeLabel(range.label);
    setProfileBatch({ total: parsedAccounts.accounts.length, done: 0, success: 0, failed: 0, current: parsedAccounts.accounts[0] });
    const seenIds = new Set<string>();
    const errors: string[] = [];
    let totalPages = 0;
    let totalScanned = 0;
    let done = 0;
    let succeeded = 0;
    let failed = 0;
    let firstProfile: ProfileInfo | null = null;

    try {
      for (const account of parsedAccounts.accounts) {
        if (cancelledRef.current) break;
        setProfileBatch({ total: parsedAccounts.accounts.length, done, success: succeeded, failed, current: account });
        const seenCursors = new Set<number>();
        let cursor = range.end * 1000;
        let secUid = "";
        let deviceId = "";
        let accountFinished = false;
        let accountSucceeded = false;
        let stopAll = false;

        try {
          for (let pageNumber = 1; pageNumber <= 100 && !cancelledRef.current; pageNumber += 1) {
            if (seenCursors.has(cursor)) throw new Error("TikTok 分页游标停滞，请重新查询");
            seenCursors.add(cursor);
            const response = await fetch("/api/profile", {
              method: "POST",
              headers: { "Content-Type": "application/json", "x-access-code": accessCode },
              body: JSON.stringify({ username: secUid ? undefined : account, secUid: secUid || undefined, cursor, deviceId: deviceId || undefined, rangeStart: range.start, rangeEnd: range.end }),
            });
            const data = await response.json() as ProfilePage;
            if (response.status === 401) { setAuthorized(false); sessionStorage.removeItem("tt-access-code"); stopAll = true; throw new Error("访问口令已失效，请重新输入"); }
            if (!response.ok) throw new Error(data.error || "账号数据获取失败");
            secUid = data.secUid; deviceId = data.deviceId;
            if (data.profile && !firstProfile) { firstProfile = data.profile; setProfileInfo(data.profile); }
            if (data.followerGrowth) setFollowerGrowths((current) => [...current.filter((item) => item.username.toLowerCase() !== data.followerGrowth!.username.toLowerCase()), data.followerGrowth!]);
            const matched = data.items.filter((item) => item.createdAt >= range.start && item.createdAt < range.end && !seenIds.has(item.key));
            matched.forEach((item) => seenIds.add(item.key));
            if (matched.length) setResults((current) => [...current, ...matched].sort((a, b) => (Number((b as ProfileResult).createdAt) || 0) - (Number((a as ProfileResult).createdAt) || 0)));
            totalPages += 1; totalScanned += data.items.length;
            setProfileProgress({ pages: totalPages, scanned: totalScanned });
            if (!data.hasMore || data.nextCursor <= range.start * 1000) { accountFinished = true; break; }
            if (!Number.isFinite(data.nextCursor) || data.nextCursor >= cursor) throw new Error("TikTok 分页未向前推进，请重新查询");
            cursor = data.nextCursor;
          }
          if (!cancelledRef.current && !accountFinished) throw new Error("该账号内容过多，请缩短查询范围");
          accountSucceeded = !cancelledRef.current;
        } catch (error) {
          const message = friendlyError(error instanceof Error ? error.message : "账号数据获取失败");
          errors.push(`@${account}：${message}`); setProfileErrors([...errors]);
          if (stopAll) setTaskError(message);
        }

        if (cancelledRef.current) break;
        done += 1;
        if (accountSucceeded) succeeded += 1; else failed += 1;
        setProfileBatch({ total: parsedAccounts.accounts.length, done, success: succeeded, failed, current: "" });
        if (stopAll) break;
      }
    } finally {
      setRunning(false);
      setProfileBatch((current) => ({ ...current, current: "" }));
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
    for (const [name, value] of Object.entries({ accessCode, payload: JSON.stringify({ results: sortedResults, summary }) })) {
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
        <div className="brand"><div className="brand-mark" aria-hidden="true">T</div><div><h1>TikTok 实时数据助手</h1><p className="subtitle">专注 TikTok 公开数据、实时查询与分析</p></div></div>
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
                <button className="btn btn-primary" type="button" disabled={!parsed.links.length || running} onClick={() => void start()}>{running ? "正在获取…" : "开始获取"}</button>
                <button className="btn btn-secondary" type="button" disabled={running} onClick={() => fileInput.current?.click()}>上传 TXT / CSV</button>
                {running && <button className="btn btn-secondary" type="button" onClick={stop}>停止排队</button>}
              </div>
              <button className="btn btn-quiet" type="button" disabled={running} onClick={() => setInput("")}>清空</button>
            </div>
            <p className="inline-note"><strong>已识别 {formatNumber(parsed.links.length)} 条 TikTok 内容</strong>{parsed.ignored ? `，忽略 ${formatNumber(parsed.ignored)} 个其他平台链接` : ""}。支持批量链接，系统会自动排队处理；处理期间请保持页面打开。</p>
          </> : <>
            <div className="input-head profile-input-head"><div><h2>添加 TikTok 账号</h2><p className="helper">每行输入一个账号（或账号链接），也支持空格、逗号隔开</p></div><span className="count-pill">{formatNumber(parsedAccounts.accounts.length)} 个</span></div>
            <div className={`profile-form ${rangeMode === "custom" ? "profile-form-custom" : rangeMode === "sevenDays" ? "profile-form-quick" : ""}`}>
              <div className="field"><label htmlFor="profile-input">TikTok 账号</label><div className="field-control"><textarea id="profile-input" className="account-textarea" spellCheck={false} value={profileInput} disabled={running} onChange={(event) => setProfileInput(event.target.value)} placeholder={"@lacebabe_lingerie\n@_vanybunny_\nhttps://www.tiktok.com/@creator"} />{profileInput && <button className="input-clear input-clear-top" type="button" aria-label="清空 TikTok 账号" disabled={running} onClick={() => setProfileInput("")}>×</button>}</div></div>
              <fieldset className="range-field"><legend>时间范围</legend><div className="range-options">
                <label><input type="radio" name="range" value="sevenDays" checked={rangeMode === "sevenDays"} disabled={running} onChange={() => setRangeMode("sevenDays")} />近 7 天</label>
                <label><input type="radio" name="range" value="month" checked={rangeMode === "month"} disabled={running} onChange={() => setRangeMode("month")} />整月</label>
                <label><input type="radio" name="range" value="custom" checked={rangeMode === "custom"} disabled={running} onChange={() => setRangeMode("custom")} />自定义</label>
              </div></fieldset>
              {rangeMode === "sevenDays" && <div className="custom-date-fields preset-date-fields"><label className="field" htmlFor="profile-preset-start"><span>开始日期</span><input id="profile-preset-start" type="date" value={beijingDate(-7)} readOnly aria-readonly="true" aria-describedby="profile-range-note" /></label><label className="field" htmlFor="profile-preset-end"><span>结束日期（截至当前）</span><input id="profile-preset-end" type="date" value={beijingDate()} readOnly aria-readonly="true" aria-describedby="profile-range-note" /></label></div>}
              {rangeMode === "month" && <label className="field month-field" htmlFor="profile-month"><span>月份</span><input id="profile-month" type="month" value={month} max={beijingMonth()} disabled={running} aria-describedby="profile-range-note" onChange={(event) => setMonth(event.target.value)} /></label>}
              {rangeMode === "custom" && <div className="custom-date-fields"><label className="field" htmlFor="profile-start-date"><span>开始日期</span><input id="profile-start-date" type="date" value={customStart} max={beijingDate()} disabled={running} aria-describedby="profile-range-note" onChange={(event) => { const value = event.target.value; setCustomStart(value); if (customEnd && value > customEnd) setCustomEnd(value); }} /></label><label className="field" htmlFor="profile-end-date"><span>结束日期（包含当天）</span><input id="profile-end-date" type="date" value={customEnd} min={customStart} max={beijingDate()} disabled={running} aria-describedby="profile-range-note" onChange={(event) => setCustomEnd(event.target.value)} /></label></div>}
            </div>
            <div className="actions profile-actions">
              <div className="action-group"><button className="btn btn-primary" type="button" disabled={!parsedAccounts.accounts.length || running} onClick={() => void startProfile()}>{running ? "正在查询…" : `查询 ${formatNumber(parsedAccounts.accounts.length)} 个账号`}</button>{running && <button className="btn btn-secondary" type="button" onClick={stop}>停止查询</button>}</div>
            </div>
            <p id="profile-range-note" className="inline-note"><strong>一行一个账号，系统会逐个排队</strong>{parsedAccounts.invalid ? `；已忽略 ${formatNumber(parsedAccounts.invalid)} 个无法识别项` : ""}。自定义范围支持单日查询，最长连续 3 个月。</p>
          </>}
        </div>

        <aside className="card task-card" aria-label="任务进度">
          <div className="task-head"><h2>本次任务</h2><span className={`task-state task-state-${taskTone}`}>{taskLabel}</span></div>
          {mode === "links" ? <>
            <div className="summary">
              <div className="stat"><span className="stat-label">总链接</span><strong>{formatNumber(summary.total)}</strong></div>
              <div className="stat"><span className="stat-label">已完成</span><strong>{formatNumber(summary.done)}</strong></div>
              <div className="stat"><span className="stat-label">成功</span><strong>{formatNumber(summary.success)}</strong></div>
              <div className="stat"><span className="stat-label">失败</span><strong>{formatNumber(summary.failed)}</strong></div>
            </div>
            <div className="progress-wrap"><div className="progress-meta"><span>处理进度</span><span>{percent}%</span></div><div className="progress" role="progressbar" aria-label="处理进度" aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent}><div className="progress-bar" style={{ width: `${percent}%` }} /></div></div>
            <div className="task-message" aria-live="polite">{running ? `正在批量获取，剩余 ${formatNumber(summary.total - summary.done)} 条。` : summary.total ? `本次成功 ${formatNumber(summary.success)} 条，失败 ${formatNumber(summary.failed)} 条。` : "提交后数据会逐条显示在下方。"}</div>
            <div className="action-group"><button className="btn btn-secondary" type="button" disabled={running || !summary.failed} onClick={() => void retryFailed()}>重试失败项</button></div>
          </> : <>
            <div className="summary">
              <div className="stat"><span className="stat-label">匹配内容</span><strong>{formatNumber(summary.success)}</strong></div>
              <div className="stat"><span className="stat-label">已扫描</span><strong>{formatNumber(profileProgress.scanned)}</strong></div>
              <div className="stat stat-text"><span className="stat-label">账号进度</span><strong>{formatNumber(profileBatch.done)} / {formatNumber(profileBatch.total || parsedAccounts.accounts.length)}</strong></div>
              <div className="stat stat-text"><span className="stat-label">查询范围</span><strong>{activeRangeLabel || draftRangeLabel}</strong></div>
            </div>
            <div className="progress-wrap"><div className="progress-meta"><span>账号扫描</span><span>{running ? "进行中" : taskFinished ? "完成" : "等待"}</span></div><div className="progress" role="progressbar" aria-label="账号扫描进度" aria-valuemin={0} aria-valuemax={100} aria-valuenow={profilePercent}><div className="progress-bar" style={{ width: `${profilePercent}%` }} /></div></div>
            <div className="task-message" aria-live="polite">{taskError ? <span className="task-error" role="alert">{taskError}</span> : running ? `正在查询 @${profileBatch.current || "账号"}，已完成 ${formatNumber(profileBatch.done)} / ${formatNumber(profileBatch.total)} 个账号。` : cancelled ? "查询已停止，当前结果可以继续查看或导出。" : profileErrors.length ? <span className="task-warning" title={profileErrors.join("\n")}>{profileBatch.failed} 个账号失败：{profileErrors.slice(0, 2).join("；")}{profileErrors.length > 2 ? "…" : ""}</span> : taskFinished ? `已完成 ${formatNumber(profileBatch.success)} 个账号，共匹配 ${formatNumber(summary.success)} 条公开内容。` : "输入账号和时间范围后开始查询。"}</div>
            <div className="action-group"><button className="btn btn-secondary" type="button" disabled={running || !parsedAccounts.accounts.length} onClick={() => void startProfile()}>重新查询</button></div>
          </>}
        </aside>
      </section>

      <section className="card results" aria-labelledby="results-title">
        <div className="results-head"><div><h2 id="results-title">{mode === "profile" ? "账号查询结果" : "抓取结果"}</h2><div className="results-meta">{mode === "profile" ? `${profileScope ? `${profileScope} · ` : ""}${activeRangeLabel || "等待查询"} · ${formatNumber(summary.success)} 条` : `共 ${formatNumber(summary.total)} 条 · 成功 ${formatNumber(summary.success)} · 失败 ${formatNumber(summary.failed)}`}</div></div><div className="results-actions"><span className="results-meta">{mode === "profile" ? "视频为查询时数据；涨粉来自历史快照" : "合计仅包含成功结果"}</span><button className="btn btn-secondary" type="button" disabled={!summary.total} onClick={exportCsv}>导出 CSV</button></div></div>
        <div className={`aggregate ${mode === "profile" ? "aggregate-profile" : ""}`} aria-label={mode === "profile" ? "账号内容与粉丝增长合计" : "成功结果数据合计"}>
          <div className="aggregate-item"><span>总播放量</span><strong title={String(summary.totals.views)}>{formatMetric(summary.totals.views)}</strong></div>
          <div className="aggregate-item"><span>总点赞</span><strong title={String(summary.totals.likes)}>{formatMetric(summary.totals.likes)}</strong></div>
          <div className="aggregate-item"><span>总评论</span><strong title={String(summary.totals.comments)}>{formatMetric(summary.totals.comments)}</strong></div>
          <div className="aggregate-item"><span>总收藏</span><strong title={String(summary.totals.saves)}>{formatMetric(summary.totals.saves)}</strong></div>
          <div className="aggregate-item"><span>总分享</span><strong title={String(summary.totals.shares)}>{formatMetric(summary.totals.shares)}</strong></div>
          {mode === "profile" && <div className="aggregate-item follower-growth" aria-live="polite"><span>净增粉</span><strong className={followerGrowthSummary.netGrowth === null ? "" : followerGrowthSummary.netGrowth >= 0 ? "growth-positive" : "growth-negative"}>{formatSignedMetric(followerGrowthSummary.netGrowth)}</strong><small>{followerGrowthSummary.ready ? `覆盖 ${formatNumber(followerGrowthSummary.ready)} / ${formatNumber(profileBatch.success || followerGrowthSummary.tracked)} 个账号` : followerGrowthSummary.tracked ? "已保存首次快照，后续自动计算" : "查询后开始记录粉丝快照"}</small></div>}
        </div>
        <div className="table-wrap">
          <table className={mode === "profile" ? "profile-table" : "link-table"}><thead><tr>{mode === "links" && <><th>#</th><th>状态</th><th>失败原因</th></>}<th>内容</th>{sortableHeader("发布时间", "publishedAt")}{sortableHeader("播放量", "views")}{sortableHeader("点赞", "likes")}{sortableHeader("评论", "comments")}{sortableHeader("收藏", "saves")}{sortableHeader("分享", "shares")}{sortableHeader("抓取时间", "fetchedAt")}<th>链接</th></tr></thead>
            <tbody>{visibleResults.length ? visibleResults.map((item, index) => (
              <tr key={item.key}>{mode === "links" && <><td>{(page - 1) * pageSize + index + 1}</td><td><span className={`status status-${item.status}`}>{item.status === "queued" ? "等待" : item.status === "running" ? "获取中" : item.status === "success" ? "成功" : "失败"}</span></td><td className="reason-cell" title={item.error}>{item.status === "error" ? item.error : "—"}</td></>}<td className="video-cell"><strong>{item.description || `${item.contentType === "photo" ? "图文" : "视频"} ${item.videoId}`}</strong><span className="description">{item.author ? `@${item.author}` : "等待获取账号信息"}</span></td><td>{item.publishedAt || "—"}</td><td>{item.status === "success" ? formatMetric(item.views) : "—"}</td><td>{item.status === "success" ? formatMetric(item.likes) : "—"}</td><td>{item.status === "success" ? formatMetric(item.comments) : "—"}</td><td>{item.status === "success" ? formatMetric(item.saves) : "—"}</td><td>{item.status === "success" ? formatMetric(item.shares) : "—"}</td><td>{item.fetchedAt || "—"}</td><td><a className="link" href={item.url || item.sourceUrl} target="_blank" rel="noopener noreferrer">查看链接 ↗</a></td></tr>
            )) : <tr><td className="empty-row" colSpan={mode === "profile" ? 9 : 12}>{mode === "profile" ? "账号内容会在扫描后显示在这里" : "结果会在这里逐条出现"}</td></tr>}</tbody>
          </table>
        </div>
        <div className="pager"><div className="pager-nav"><div className="page-size" role="group" aria-label="每页显示条数"><span>每页显示</span>{([50, 100, 200] as const).map((size) => <button key={size} className={`page-size-button ${pageSize === size ? "active" : ""}`} type="button" aria-pressed={pageSize === size} onClick={() => { setPageSize(size); setPage(1); }}>{size}</button>)}</div><span>共 {formatNumber(summary.total)} 条</span><button className="page-button" type="button" aria-label="上一页" disabled={page <= 1} onClick={() => setPage((value) => value - 1)}>‹</button><span>第 {page} / {pages} 页</span><button className="page-button" type="button" aria-label="下一页" disabled={page >= pages} onClick={() => setPage((value) => value + 1)}>›</button></div></div>
      </section>
      <footer className="footer"><span>仅处理 TikTok 公开内容；私密、删除或地区受限内容无法获取。</span><span>数据为每次查询时 TikTok 返回的公开快照。</span></footer>
    </main>
  );
}
