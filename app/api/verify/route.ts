const noStore = { "Cache-Control": "no-store" };

function matchesAccessCode(value: string) {
  const expected = process.env.ACCESS_CODE ?? "";
  if (!expected || value.length !== expected.length) return false;
  let mismatch = 0;
  for (let index = 0; index < expected.length; index += 1) mismatch |= value.charCodeAt(index) ^ expected.charCodeAt(index);
  return mismatch === 0;
}

export async function GET(request: Request) {
  if (!process.env.ACCESS_CODE) return Response.json({ error: "服务尚未配置访问口令" }, { status: 503, headers: noStore });
  return matchesAccessCode(request.headers.get("x-access-code") ?? "")
    ? Response.json({ ok: true }, { headers: noStore })
    : Response.json({ error: "访问口令不正确" }, { status: 401, headers: noStore });
}

export { matchesAccessCode };
