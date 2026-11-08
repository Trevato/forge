/**
 * The per-phase profile of tree, blob, raw and media pages (#9503), measured
 * under load: it holds `--rate` requests a second against a copy of the forge
 * (as bench/load.ts does, open loop) and tallies each answer's Server-Timing
 * by page kind.
 *
 *   bun bench/code-phases.ts --url https://copy.example --repo owner/name --rate 500 --seconds 20
 *
 * Run it for each repository of the copy and attach the tables to the issue.
 * A private copy needs the forge token: `--token` or FORGE_TOKEN, sent on every request.
 * Redirects and refusals are not samples; they are counted and printed.
 * Point it only at a copy you run. A kind with no link on the repository's
 * pages (a repo without an image or PDF has no media link) shows n = 0.
 */
import { KINDS, dropped, gatherLinks, kindOf, parseTiming, profile, table, type Observation } from "../src/perf/phase_profile.ts";

const arg = (name: string, fallback?: string): string => {
  const at = process.argv.indexOf(`--${name}`);
  const v = at >= 0 ? process.argv[at + 1] : fallback;
  if (v === undefined) throw new Error(`--${name} is required`);
  return v;
};
const base = arg("url").replace(/\/$/, "");
const repo = arg("repo");
const rate = Number(arg("rate", "100"));
const seconds = Number(arg("seconds", "10"));
const token = process.argv.includes("--token") ? arg("token") : process.env.FORGE_TOKEN;
const headers: Record<string, string> = token ? { authorization: `Bearer ${token}` } : {};
const MAX_INFLIGHT = 2000;
if (!/^[\w.-]+\/[\w.-]+$/.test(repo) || !(rate > 0) || !(seconds > 0)) throw new Error("bad --repo, --rate or --seconds");

const page = async (path: string): Promise<string> => {
  const r = await fetch(`${base}${path}`, { headers, redirect: "manual" });
  if (!r.ok) throw new Error(`${path} answered ${r.status}${r.status === 401 || r.status === 403 ? " (a private copy needs --token or FORGE_TOKEN)" : ""}`);
  return r.text();
};
const pages = new Set<string>();
for (const path of [`/${repo}`, `/${repo}/tree/main`]) for (const l of gatherLinks(await page(path), repo)) pages.add(l);
// Blob pages name their media (an image or PDF is drawn from /media/…): follow the first files.
for (const p of [...pages].filter((p) => p.includes("/blob/")).slice(0, 40)) {
  try {
    for (const l of gatherLinks(await page(p), repo)) if (l.includes("/media/")) pages.add(l);
  } catch (e) {
    console.error(`skipped ${p}: ${(e as Error).message}`);
  }
}
const byKind = Object.fromEntries(KINDS.map((k) => [k, [...pages].filter((p) => kindOf(p) === k)]));
console.error(Object.entries(byKind).map(([k, v]) => `${k}: ${v.length} links`).join(", "));
const all = [...pages];
if (all.length === 0) throw new Error("no commit-pinned links found on the repository's pages");

const seen: Observation[] = [];
let failed = 0;
let skipped = 0;
const inflight = new Set<Promise<void>>();
const ask = async (path: string) => {
  const began = performance.now();
  try {
    const r = await fetch(`${base}${path}`, { headers, redirect: "manual" });
    await r.arrayBuffer();
    seen.push({ kind: kindOf(path)!, wall: performance.now() - began, phases: parseTiming(r.headers.get("server-timing")), status: r.status });
  } catch {
    failed++;
  }
};
const started = performance.now();
let sent = 0;
while (performance.now() - started < seconds * 1000) {
  const due = Math.floor(((performance.now() - started) / 1000) * rate);
  while (sent < due) {
    // Capped, so a slow copy is not buried and this client is not the bottleneck: what it could not send is counted.
    if (inflight.size >= MAX_INFLIGHT) {
      skipped += due - sent;
      sent = due;
      break;
    }
    const p = ask(all[sent % all.length]!);
    inflight.add(p);
    void p.finally(() => inflight.delete(p));
    sent++;
  }
  await Bun.sleep(2);
}
await Promise.all(inflight);
const drop = Object.entries(dropped(seen)).map(([k, n]) => `${k}: ${n}`).join(", ");
console.log(`asked ${sent} at ${rate}/s for ${seconds}s, answered ${seen.length}, connection failures ${failed}, not sent (client cap ${MAX_INFLIGHT}) ${skipped}`);
console.log(`not counted as samples (by status): ${drop === "" ? "none" : drop}\n`);
console.log(table(profile(seen)));
