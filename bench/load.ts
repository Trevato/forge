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
 * With a session cookie in FORGE_LOAD_COOKIE (an environment variable, so it
 * never shows in a process list), a second stream runs alongside (#9513): a
 * signed-in `/` and repository home every `--every` ms (default 50), timed
 * on their own and printed as `signedIn` next to the anonymous result.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { fell, summarize, type LoadResult } from "../src/perf/load_verdict.ts";

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
if (!/^[\w.-]+\/[\w.-]+$/.test(repo) || !(rate > 0) || !(seconds > 0)) throw new Error("bad --repo, --rate or --seconds");

const front = await (await fetch(`${base}/${repo}`)).text();
const home = await (await fetch(`${base}/${repo}/tree/main`)).text();
const pinned = new Set<string>();
for (const m of (front + home).matchAll(new RegExp(`/${repo.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/(?:tree|blob)/[0-9a-f]{40}[^"'<> ]*`, "g"))) {
  pinned.add(m[0]);
  // Raw bytes exist for a file, not a directory: only a blob link has a raw twin.
  if (m[0].includes("/blob/")) pinned.add(m[0].replace("/blob/", "/raw/"));
}
const paths = [...pinned].filter((p) => !p.includes("/raw/") || p.split("/").length > 5);
if (paths.length === 0) throw new Error("no commit-pinned links found on the repository's pages");

const latencies: number[] = [];
let refused = 0;
const refusedBy: Record<string, number> = {};
const inflight = new Set<Promise<void>>();
const ask = (path: string): Promise<void> => {
  const began = performance.now();
  return fetch(`${base}${path}`, { redirect: "manual" })
    .then(async (r) => {
      await r.arrayBuffer();
      if (r.status < 400) latencies.push(performance.now() - began);
      else (refused++, (refusedBy[r.status] = (refusedBy[r.status] ?? 0) + 1));
    })
    .catch(() => {
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

const started = performance.now();
let sent = 0;
let asked = 0;
while (performance.now() - started < seconds * 1000) {
  const due = Math.floor(((performance.now() - started) / 1000) * rate);
  while (sent < due) {
    const p = ask(paths[Math.floor(Math.random() * paths.length)]!);
    inflight.add(p);
    void p.finally(() => inflight.delete(p));
    sent++;
  }
  const dueSignedIn = cookie === undefined ? 0 : Math.floor((performance.now() - started) / every);
  for (; asked < dueSignedIn; asked++) {
    const p = askSignedIn(people[asked % people.length]!);
    inflight.add(p);
    void p.finally(() => inflight.delete(p));
  }
  await Bun.sleep(2);
}
await Promise.all(inflight);

const result: LoadResult = summarize(version, rate, seconds, latencies, refused);
console.log(JSON.stringify(result, null, 2));
if (refused > 0) console.log(JSON.stringify({ refusedBy }));
if (cookie !== undefined) {
  const s = [...signedIn].sort((a, b) => a - b);
  const at = (p: number) => (s.length === 0 ? null : Math.round(s[Math.min(s.length - 1, Math.floor(p * s.length))]! * 10) / 10);
  console.log(JSON.stringify({ signedIn: { sent: asked, answered: s.length, notOk: signedInRefused, p50Ms: at(0.5), p95Ms: at(0.95), maxMs: at(1) } }, null, 2));
}
const out = process.argv.includes("--out") ? arg("out") : undefined;
if (out !== undefined) writeFileSync(out, JSON.stringify(result, null, 2) + "\n");
const last = process.argv.includes("--compare") ? (JSON.parse(readFileSync(arg("compare"), "utf8")) as LoadResult) : undefined;
const why = last === undefined ? undefined : fell(last, result);
if (why !== undefined) {
  console.error(`LOAD REGRESSION: ${why}`);
  process.exit(1);
}
