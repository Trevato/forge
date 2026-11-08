/**
 * The load test (#9405): an open-loop reader of code pages against a copy of
 * the forge, run from any machine that can reach it.
 *
 *   bun bench/load.ts --url https://copy.example --repo owner/name \
 *     --rate 500 --seconds 20 --version 0.7.386 --out bench/results/0.7.386.json
 *   bun bench/load.ts ... --compare bench/results/0.7.385.json   # exits 1 on a >20% fall
 *
 * It reads the repository's front page, collects its commit-pinned tree and
 * blob links, then asks for them at `--rate` a second regardless of how fast
 * the forge answers (open loop: a slow forge queues, as strangers would).
 * Each request is a tree, blob or raw page of a pinned commit, anonymous.
 * Point it only at a copy you run; never at a forge you do not own.
 *
 * Where the edge cache sits (#9514): a run without flags reads through it,
 * so a pinned page the edge already holds never reaches the forge. With
 * `--bypass` each request carries a cookie (`forge_load=bypass`): the edge
 * must pass any request with a Cookie to the forge (`http/addressed.ts`), so
 * the forge answers all of it, at the same URLs strangers ask. The cookie
 * names no one, so the forge still serves it as a stranger's page. (A
 * unique query would bust the edge too, but it lands in the page's sign-in
 * link, making every body unique: that measures a forge no stranger sees.)
 * The result names which it was (`cache: "edge" | "bypass"`).
 *
 * `--warm S` asks at the same rate for S seconds first and keeps none of it,
 * so the result is the forge's steady state; the warm-up's own per-second
 * line is printed, so a cold start is never hidden.
 *
 * `--addresses N` spreads the requests over N made-up client addresses in
 * X-Forwarded-For (198.18.0.0/15, the range kept for benchmarks), the way
 * strangers arrive. Only a forge that trusts the hop reads it: in-process,
 * where the hop is this machine (`http/peer.ts`). Through a real edge the
 * header is the client's own words and is ignored, as it must be.
 *
 * With a session cookie in FORGE_LOAD_COOKIE (an environment variable, so it
 * never shows in a process list), a second stream runs alongside (#9513): a
 * signed-in `/` and repository home every `--every` ms (default 50), timed
 * on their own and printed as `signedIn` next to the anonymous result.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { fell, missed, summarize, type LoadResult } from "../src/perf/load_verdict.ts";

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
const version = arg("version", "unversioned");
const bypass = process.argv.includes("--bypass");
const addresses = Number(arg("addresses", "1"));
if (!/^[\w.-]+\/[\w.-]+$/.test(repo) || !(rate > 0) || !(seconds > 0)) throw new Error("bad --repo, --rate or --seconds");
if (!Number.isInteger(addresses) || addresses < 1 || addresses > 131_072) throw new Error("bad --addresses (1..131072)");
/** The n-th made-up client: 198.18.0.0/15 holds 131072 addresses. */
const addressOf = (n: number): string => `198.${18 + ((n >> 16) & 1)}.${(n >> 8) & 255}.${n & 255}`;

const escaped = repo.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const linkPattern = new RegExp(`/${escaped}/(?:tree|blob)/[0-9a-f]{40}[^"'<> ]*`, "g");
const pinned = new Set<string>();
const collect = (html: string): string[] => {
  const found: string[] = [];
  for (const m of html.matchAll(linkPattern)) {
    const link = m[0].replace(/&amp;/g, "&");
    if (pinned.has(link)) continue;
    pinned.add(link);
    found.push(link);
    // Raw bytes exist for a file, not a directory: only a blob link has a raw twin.
    if (link.includes("/blob/")) pinned.add(link.replace("/blob/", "/raw/"));
  }
  return found;
};
collect(await (await fetch(`${base}/${repo}`)).text());
collect(await (await fetch(`${base}/${repo}/tree/main`)).text());
// `--crawl N` walks pinned folders breadth-first until N links are known, so
// the run spreads over a repository the way strangers do, not its top folder.
// Signed out and unhurried: one page at a time before the clock starts.
const crawl = Number(arg("crawl", "0"));
if (!Number.isInteger(crawl) || crawl < 0) throw new Error("bad --crawl");
const folders = [...pinned].filter((p) => p.includes("/tree/"));
while (pinned.size < crawl && folders.length > 0) {
  const r = await fetch(`${base}${folders.shift()!}`, { headers: addresses > 1 ? { "x-forwarded-for": addressOf(pinned.size % addresses) } : {} });
  if (r.status !== 200) continue;
  for (const link of collect(await r.text())) if (link.includes("/tree/")) folders.push(link);
}
const paths = [...pinned].filter((p) => !p.includes("/raw/") || p.split("/").length > 5);
if (paths.length === 0) throw new Error("no commit-pinned links found on the repository's pages");

const warm = Number(arg("warm", "0"));
if (!(warm >= 0)) throw new Error("bad --warm");
const latencies: number[] = [];
let started = performance.now();
let refused = 0;
const refusedBy: Record<string, number> = {};
const inflight = new Set<Promise<void>>();
/** Per second: [served, refused], to tell a cold start from a forge that never keeps up. */
const seconds_ = (n: number): [number, number][] => Array.from({ length: Math.ceil(n) + 1 }, () => [0, 0]);
const warmPerSecond = seconds_(warm);
const perSecond = seconds_(seconds);
/** False during `--warm`: answers are tallied by second and nothing else is kept. */
let counting = false;
const tally = (began: number, ok: boolean) => {
  const line = counting ? perSecond : warmPerSecond;
  line[Math.min(line.length - 1, Math.floor((began - started) / 1000))]![ok ? 0 : 1]++;
};
const ask = (path: string, n: number): Promise<void> => {
  const measured = counting;
  const began = performance.now();
  const headers: Record<string, string> = addresses > 1 ? { "x-forwarded-for": addressOf(n % addresses) } : {};
  if (bypass) headers.cookie = "forge_load=bypass";
  return fetch(`${base}${path}`, { redirect: "manual", headers })
    .then(async (r) => {
      await r.arrayBuffer();
      tally(began, r.status < 400);
      if (!measured) return;
      if (r.status < 400) latencies.push(performance.now() - began);
      else (refused++, (refusedBy[r.status] = (refusedBy[r.status] ?? 0) + 1));
    })
    .catch(() => {
      tally(began, false);
      if (!measured) return;
      refused++;
      refusedBy.failed = (refusedBy.failed ?? 0) + 1;
    });
};

const cookie = process.env.FORGE_LOAD_COOKIE;
const every = Number(arg("every", "50"));
if (!(every > 0)) throw new Error("bad --every");
const people = [`/`, `/${repo}`];
const signedIn: number[] = [];
let signedInRefused = 0;
const askSignedIn = (path: string): Promise<void> => {
  const began = performance.now();
  return fetch(`${base}${path}`, { redirect: "manual", headers: { cookie: cookie ?? "" } })
    .then(async (r) => {
      await r.arrayBuffer();
      if (r.status === 200) signedIn.push(performance.now() - began);
      else signedInRefused++;
    })
    .catch(() => {
      signedInRefused++;
    });
};

let sent = 0;
let asked = 0;
/** Open loop for `span` seconds; the signed-in stream runs only while counting. */
const flood = async (span: number): Promise<void> => {
  started = performance.now();
  const due0 = sent;
  while (performance.now() - started < span * 1000) {
    const due = due0 + Math.floor(((performance.now() - started) / 1000) * rate);
    while (sent < due) {
      const p = ask(paths[Math.floor(Math.random() * paths.length)]!, sent);
      inflight.add(p);
      void p.finally(() => inflight.delete(p));
      sent++;
    }
    const dueSignedIn = cookie === undefined || !counting ? 0 : Math.floor((performance.now() - started) / every);
    for (; asked < dueSignedIn; asked++) {
      const p = askSignedIn(people[asked % people.length]!);
      inflight.add(p);
      void p.finally(() => inflight.delete(p));
    }
    await Bun.sleep(2);
  }
};
if (warm > 0) {
  await flood(warm);
  await Promise.all(inflight);
  console.log(`warm-up, per second, served/refused (not counted): ${warmPerSecond.map(([a, b]) => `${a}/${b}`).join(" ")}`);
}
counting = true;
await flood(seconds);
await Promise.all(inflight);

const result: LoadResult = { ...summarize(version, rate, seconds, latencies, refused), cache: bypass ? "bypass" : "edge", refusedBy };
console.log(JSON.stringify(result, null, 2));
console.log(`per second, served/refused: ${perSecond.map(([a, b]) => `${a}/${b}`).join(" ")}`);
const short = missed(result);
console.log(short === undefined ? "target met: none refused, p95 under 100 ms" : `target missed: ${short}`);
if (cookie !== undefined) {
  const s = [...signedIn].sort((a, b) => a - b);
  const at = (p: number) => (s.length === 0 ? null : Math.round(s[Math.min(s.length - 1, Math.floor(p * s.length))]! * 10) / 10);
  console.log(JSON.stringify({ signedIn: { sent: asked, answered: s.length, notOk: signedInRefused, p50Ms: at(0.5), p95Ms: at(0.95), maxMs: at(1) } }, null, 2));
}
const out = process.argv.includes("--out") ? arg("out") : undefined;
// The file says itself whether the run met the goal, so a kept result can be read without rerunning it.
if (out !== undefined) writeFileSync(out, JSON.stringify({ ...result, verdict: short ?? "target met" }, null, 2) + "\n");
const last = process.argv.includes("--compare") ? (JSON.parse(readFileSync(arg("compare"), "utf8")) as LoadResult) : undefined;
const why = last === undefined ? undefined : fell(last, result);
if (why !== undefined) {
  console.error(`LOAD REGRESSION: ${why}`);
  process.exit(1);
}
