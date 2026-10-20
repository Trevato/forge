/** `/`'s Server-Timing phases for the owner, p50 and p95 in ms over warm hits: `bun run bench/home-phases.ts [n]`. */
import { snappyFixture } from "./snappy.ts";

const n = Number(process.argv[2]) > 0 ? Number(process.argv[2]) : 30;
const f = await snappyFixture();
try {
  const seen = new Map<string, number[]>();
  for (let i = 0; i < n + 1; i++) {
    const res = await fetch(`${f.base}/`, { headers: { cookie: f.ownerCookie } });
    await res.arrayBuffer();
    if (i === 0) continue;
    for (const m of (res.headers.get("server-timing") ?? "").matchAll(/([a-z-]+);dur=([\d.]+)/g))
      (seen.get(m[1]!) ?? seen.set(m[1]!, []).get(m[1]!)!).push(Number(m[2]));
  }
  console.log("| `GET /` phase | owner p50 | owner p95 |\n| ------------- | --------: | --------: |");
  for (const [name, xs] of seen) {
    xs.sort((a, b) => a - b);
    const at = (p: number) => xs[Math.min(xs.length - 1, Math.floor((xs.length * p) / 100))]!;
    console.log(`| \`${name}\` | ${at(50).toFixed(1)} | ${at(95).toFixed(1)} |`);
  }
} finally {
  await f.close();
}
