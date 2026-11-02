/**
 * `bun scripts/home-eval.ts <base-url>` scores the owner's home against
 * ground truth (#5805), the deterministic half of #5735's loop: it reads `/`
 * as text (`pageText`, #5765), asks the forge's own API for the five facts
 * that mattered, and prints each as `stated`, `missing` or `wrong` with the
 * page's words beside it, then coverage, errors, characters and fetch time.
 * `FORGE_COOKIE` is sent as the cookie and `FORGE_TOKEN` as a bearer token;
 * neither is printed. Exits 1 when the page or the API will not answer.
 */
import { pageText } from "../src/web/page_text.ts";
import { coverage, errors, scoreHome, type Truth } from "../src/system/home_eval.ts";

const base = process.argv[2]?.replace(/\/+$/, "");
if (!base || !/^https?:\/\//i.test(base)) {
  console.error("usage: bun scripts/home-eval.ts <http(s)://forge>");
  process.exit(2);
}
const cookie = process.env.FORGE_COOKIE;
const token = process.env.FORGE_TOKEN;
const headers: Record<string, string> = { ...(cookie ? { cookie } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}) };
const DAY = 86_400_000;

async function get(path: string): Promise<any> {
  const res = await fetch(`${base}${path}`, { headers, redirect: "manual", signal: AbortSignal.timeout(15_000) });
  if (res.status !== 200) throw new Error(`${path} answered ${res.status}`);
  return res.json();
}

async function truth(): Promise<Truth> {
  const home = await get("/api/v1/telemetry/home");
  const repos: { ownerName: string; name: string; archivedAt?: string | null }[] = [];
  for (let cursor: string | null = null, page = 0; page < 10; page++) {
    const r: { items: typeof repos; next_cursor: string | number | null } = await get(`/api/v1/repos?limit=100${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`);
    repos.push(...r.items);
    if (r.next_cursor === null) break;
    cursor = String(r.next_cursor);
  }
  const live = repos.filter((r) => !r.archivedAt).map((r) => `${r.ownerName}/${r.name}`);
  const quiet: string[] = [];
  for (let i = 0; i < live.length; i += 8) {
    await Promise.all(
      live.slice(i, i + 8).map(async (full) => {
        const log: { date: string }[] = await get(`/api/v1/repos/${full}/commits?limit=1`);
        if (log[0] !== undefined && Date.now() - Date.parse(log[0].date) > 3 * DAY) quiet.push(full);
      }),
    );
  }
  return { ...home, repos: live, quiet: quiet.sort() };
}

try {
  const started = performance.now();
  const res = await fetch(`${base}/`, { headers, redirect: "manual", signal: AbortSignal.timeout(15_000) });
  const html = await res.text();
  const ms = Math.round(performance.now() - started);
  if (res.status !== 200) throw new Error(`/ answered ${res.status}`);
  const text = pageText(html);
  const facts = scoreHome(text, await truth());
  for (const f of facts) {
    console.log(`${f.verdict.padEnd(7)} ${f.label}`);
    console.log(`        page:  ${f.words === "" ? "—" : `“${f.words}”`}`);
    console.log(`        forge: ${f.truth}`);
  }
  console.log(`coverage ${coverage(facts)} of 5 · errors ${errors(facts)} · chars ${text.length} · fetched in ${ms} ms`);
} catch (e) {
  console.error(e instanceof Error ? e.message : String(e));
  process.exit(1);
}
