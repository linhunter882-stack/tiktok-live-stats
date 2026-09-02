export type SortKey = "publishedAt" | "views" | "likes" | "comments" | "saves" | "shares" | "fetchedAt";
export type SortDirection = "asc" | "desc";

type SortableResult = {
  status: string;
  publishedAt: string;
  fetchedAt: string;
  views: number | null;
  likes: number | null;
  comments: number | null;
  saves: number | null;
  shares: number | null;
};

const numericKeys = new Set<SortKey>(["views", "likes", "comments", "saves", "shares"]);

function timestamp(value: string) {
  const match = value.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})[ T](\d{1,2}):(\d{2}):(\d{2})/);
  return match ? Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]), Number(match[4]), Number(match[5]), Number(match[6])) : null;
}

function sortValue(item: SortableResult, key: SortKey) {
  if (numericKeys.has(key)) return item.status === "success" ? item[key] as number | null : null;
  return timestamp(item[key] as string);
}

export function sortResults<T extends SortableResult>(results: T[], key: SortKey | null, direction: SortDirection) {
  if (!key) return results;
  return results.map((item, index) => ({ item, index })).sort((a, b) => {
    const left = sortValue(a.item, key);
    const right = sortValue(b.item, key);
    if (left === null) return right === null ? a.index - b.index : 1;
    if (right === null) return -1;
    const compared = direction === "asc" ? left - right : right - left;
    return compared || a.index - b.index;
  }).map(({ item }) => item);
}
