export type RangeMode = "sevenDays" | "month" | "custom";

const DAY_SECONDS = 86_400;
const BEIJING_OFFSET_SECONDS = 8 * 3600;

function parseDate(value: string, label: string) {
  const match = value.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) throw new Error(`请选择${label}`);
  const year = Number(match[1]);
  const monthIndex = Number(match[2]) - 1;
  const day = Number(match[3]);
  const utc = Date.UTC(year, monthIndex, day);
  const parsed = new Date(utc);
  if (parsed.getUTCFullYear() !== year || parsed.getUTCMonth() !== monthIndex || parsed.getUTCDate() !== day) throw new Error(`${label}格式不正确`);
  return { year, monthIndex, day, seconds: utc / 1000 - BEIJING_OFFSET_SECONDS };
}

export function beijingDate(offsetDays = 0) {
  return new Date(Date.now() + BEIJING_OFFSET_SECONDS * 1000 + offsetDays * DAY_SECONDS * 1000).toISOString().slice(0, 10);
}

export function beijingMonth() {
  return beijingDate().slice(0, 7);
}

export function selectedRange(mode: RangeMode, month: string, customStart: string, customEnd: string) {
  const now = Math.floor(Date.now() / 1000);
  if (mode === "sevenDays") return { start: now - 7 * DAY_SECONDS, end: now + 1, label: "近 7 天" };
  if (mode === "month") {
    const match = month.match(/^(\d{4})-(\d{2})$/);
    if (!match) throw new Error("请选择查询月份");
    const year = Number(match[1]);
    const monthIndex = Number(match[2]) - 1;
    if (monthIndex < 0 || monthIndex > 11) throw new Error("查询月份格式不正确");
    const start = Date.UTC(year, monthIndex, 1) / 1000 - BEIJING_OFFSET_SECONDS;
    const end = Math.min(Date.UTC(year, monthIndex + 1, 1) / 1000 - BEIJING_OFFSET_SECONDS, now + 1);
    if (start > now) throw new Error("不能查询未来月份");
    return { start, end, label: `${year} 年 ${monthIndex + 1} 月` };
  }

  const first = parseDate(customStart, "开始日期");
  const last = parseDate(customEnd, "结束日期");
  const today = parseDate(beijingDate(), "日期");
  if (last.seconds < first.seconds) throw new Error("结束日期不能早于开始日期");
  if (last.seconds > today.seconds) throw new Error("不能查询未来日期");
  const rawEnd = last.seconds + DAY_SECONDS;
  const maximumEnd = Date.UTC(first.year, first.monthIndex + 3, first.day) / 1000 - BEIJING_OFFSET_SECONDS;
  if (rawEnd > maximumEnd) throw new Error("自定义时间范围最长为 3 个月");
  return {
    start: first.seconds,
    end: Math.min(rawEnd, now + 1),
    label: customStart === customEnd ? `${customStart}（单日）` : `${customStart} 至 ${customEnd}`,
  };
}
