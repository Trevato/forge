/**
 * `/:owner/:name/flows` at 200 lines (#9670), warm, as the admin: p50 and p95
 * of the whole request and of every Server-Timing phase, as a markdown table.
 * 100 followed sources flow in, 100 forks flow out. The first request is
 * thrown away (it warms the page's caches); the next `n` are measured.
 *
 *   bun run bench/flows-200.ts [n]     # n defaults to 200
 */
import { createRepo } from "../src/actions/repos.ts";
import { setForkFollowMode } from "../src/core/fork_follow.ts";
import { snappyFixture } from "./snappy.ts";

const n = Number(process.argv[2]) > 0 ? Number(process.argv[2]) : 200;
const LINES = 200;
const f = await snappyFixture({ repos: 1, issuesPerRepo: 0 });
try {
  const repo = f.repos[0]!;
  const ins = f.app.db.query(
    "INSERT INTO repo_source (id, repo_id, url, branch, by_id, created_at, checked_at, behind) VALUES (?1, ?2, ?3, 'main', ?4, ?5, ?6, ?7)",
  );
  for (let i = 0; i < LINES / 2; i++)
    ins.run(`s${i}`, repo.id, `https://src${i}.example/x/y${i}.git`, f.owner.id, `2026-11-01T00:00:${String(i % 60).padStart(2, "0")}Z`, "2026-11-07T00:00:00Z", i % 4);
  for (let i = 0; i < LINES / 2; i++) {
    const kid = await createRepo(f.app, f.owner, { name: `fork-${i}`, visibility: "public", description: "" });
    if (!kid.ok) throw new Error(JSON.stringify(kid.error));
    f.app.db.query("UPDATE repo SET fork_parent_id = ?1 WHERE id = ?2").run(repo.id, kid.value.id);
    if (i % 2 === 0) setForkFollowMode(f.app.db, kid.value.id, "take-updates");
  }
  const url = `${f.base}/${f.owner.username}/${repo.name}/flows`;
  const total: number[] = [];
  const seen = new Map<string, number[]>();
  let rows = 0;
  for (let i = 0; i < n + 1; i++) {
    const t = performance.now();
    const res = await fetch(url, { headers: { cookie: f.ownerCookie } });
    const body = await res.text();
    const ms = performance.now() - t;
    if (res.status !== 200) throw new Error(`status ${res.status}`);
    if (i === 0) { rows = new Set(body.match(/src\d+\.example|olive\/fork-\d+/g)).size; continue; }
    total.push(ms);
    for (const m of (res.headers.get("server-timing") ?? "").matchAll(/([a-z-]+);dur=([\d.]+)/g))
      (seen.get(m[1]!) ?? seen.set(m[1]!, []).get(m[1]!)!).push(Number(m[2]));
  }
  const at = (xs: number[], p: number) => {
    const s = [...xs].sort((a, b) => a - b);
    return s[Math.min(s.length - 1, Math.floor((s.length * p) / 100))]!;
  };
  console.log(`flow lines on the page: ${rows}, requests: ${n}`);
  console.log("| measure | p50 ms | p95 ms |\n| ------- | -----: | -----: |");
  console.log(`| whole request (client) | ${at(total, 50).toFixed(1)} | ${at(total, 95).toFixed(1)} |`);
  for (const [name, xs] of seen) console.log(`| Server-Timing \`${name}\` | ${at(xs, 50).toFixed(1)} | ${at(xs, 95).toFixed(1)} |`);
} finally {
  await f.close();
}
