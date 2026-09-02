export function collectAccounts(text: string) {
  const seen = new Set<string>();
  const accounts: string[] = [];
  let invalid = 0;

  for (const token of text.split(/[\s,，;；]+/).filter(Boolean)) {
    let value = token.trim().replace(/^@/, "");
    if (/^https?:\/\//i.test(value)) {
      try {
        const url = new URL(value);
        const match = /(?:^|\.)tiktok\.com$/i.test(url.hostname) && url.pathname.match(/^\/@([^/]+)/);
        value = match ? decodeURIComponent(match[1]) : "";
      } catch { value = ""; }
    }
    if (value.length > 24 || value.includes("..") || !/^[A-Za-z0-9_](?:[A-Za-z0-9._]{0,22}[A-Za-z0-9_])?$/.test(value)) {
      invalid += 1;
      continue;
    }
    const key = value.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key); accounts.push(value);
  }
  return { accounts, invalid };
}
