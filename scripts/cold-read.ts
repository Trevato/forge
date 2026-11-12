/**
 * `bun scripts/cold-read.ts <forge-url> [--repo owner/name] [--write [--allow-text-only]]
 *   [--file-issues <parent> [--file-into owner/name] [--max N]]`
 *
 * A no-context agent reads each top page at 390 px and 1440 px and says, in
 * under 100 words, what is confusing and what it would click first. The prompt
 * is `docs/design/cold-read-prompt.md`. The reader is signed in with
 * `FORGE_TOKEN` (a bearer the forge honours on pages), so /migrate and
 * /settings show their real first run. A page that is not a 200 at its own
 * URL (a redirect, a 404) is refused, never scored. `--repo` adds that
 * repository's page, pulls and issues after checking it exists. The fetched
 * server-rendered HTML is shot with headless Chromium at the width (its text
 * when there is no browser; `--write` then refuses unless `--allow-text-only`, which marks the score `text-only`) and sent, with the prompt, to the model named by `COLD_READ_MODEL`
 * (default claude-sonnet-5-5) through `ANTHROPIC_API_KEY` / `ANTHROPIC_BASE_URL`.
 *
 * `FORGE_TOKEN` goes only to the forge `FORGE_URL` names; any other <forge-url> is refused before a request.
 * Privacy: the signed-in pages (/settings can show an email, token names, linked accounts) are sent in full to the
 * model endpoint, `ANTHROPIC_BASE_URL` included. Use a throwaway account's token unless that is acceptable. The shot
 * is loaded from file://, so it carries no CSP header, and Chromium runs `--no-sandbox`: read only your own forge.
 *
 * It prints a score per page. `--write` stores them under `coldRead` in
 * `docs/design/baseline.json`; `--file-issues N` files each confusion as an
 * issue in `--file-into` (default `--repo`) on `FORGE_URL` (which must be the forge read), linking back to #N: at most `--max` (default 20), and
 * none whose title is already open.
 */
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { findChromium } from "../src/looks/capture.ts";
import { PAGES, REPO, filingPlan, repoPages, tokenRefusal, withColdRead, writeRefusal, type ColdRead } from "../src/design/coldread.ts";
import { coldRead, type Shot } from "../src/design/coldrun.ts";

const BASELINE = "docs/design/baseline.json";
const args = process.argv.slice(2);
const base = args.find((a) => /^https?:\/\//.test(a))?.replace(/\/$/, "");
const write = args.includes("--write");
const opt = (name: string) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);
const parent = opt("--file-issues") === undefined ? undefined : Number(opt("--file-issues"));
const repo = opt("--repo");
const into = opt("--file-into") ?? repo;
const cap = Number(opt("--max") ?? 20);
if (!base || (parent !== undefined && !Number.isInteger(parent)) || (repo !== undefined && !REPO.test(repo)) || (into !== undefined && !REPO.test(into)) || !Number.isInteger(cap) || cap < 0) {
  console.error("usage: bun scripts/cold-read.ts <url> [--repo owner/name] [--write [--allow-text-only]] [--file-issues <issue number> [--file-into owner/name] [--max N]]");
  process.exit(2);
}
const token = process.env["FORGE_TOKEN"];
if (!token) {
  console.error("FORGE_TOKEN is not set: the reader must be signed in, or /migrate and /settings are the sign-in page");
  process.exit(2);
}
const unsafe = tokenRefusal(base, process.env["FORGE_URL"]);
if (unsafe) {
  console.error(unsafe);
  process.exit(2);
}
const auth = { authorization: `Bearer ${token}` };
if (repo !== undefined) {
  const r = await fetch(`${base}/api/v1/repos/${repo}`, { headers: auth, redirect: "manual" });
  if (r.status !== 200) {
    console.error(`--repo ${repo}: ${base} answered ${r.status}`);
    process.exit(2);
  }
}
const key = process.env["ANTHROPIC_API_KEY"];
if (!key) {
  console.error("ANTHROPIC_API_KEY is not set: the audit needs a model to read the pages");
  process.exit(2);
}
const api = (process.env["ANTHROPIC_BASE_URL"] ?? "https://api.anthropic.com").replace(/\/$/, "");
const model = process.env["COLD_READ_MODEL"] ?? "claude-sonnet-5-5";
const prompt = readFileSync(new URL("../docs/design/cold-read-prompt.md", import.meta.url), "utf8");

async function shoot(html: string, path: string, w: { width: number; height: number }): Promise<Shot> {
  const binary = findChromium();
  if (binary) {
    const dir = mkdtempSync(join(process.env["TMPDIR"] ?? tmpdir(), "coldread-"));
    try {
      // The first paint is server-rendered; <base> lets its stylesheets load from the forge.
      await Bun.write(join(dir, "p.html"), html.replace(/<head[^>]*>/i, (h) => `${h}<base href="${base + path}">`));
      const out = join(dir, "p.png");
      const p = Bun.spawn([binary, "--headless", "--no-sandbox", "--hide-scrollbars", "--virtual-time-budget=5000", `--window-size=${w.width},${w.height}`, `--screenshot=${out}`, `file://${join(dir, "p.html")}`], { stdout: "ignore", stderr: "ignore" });
      const timer = setTimeout(() => p.kill(), 15_000); // a page that never settles must not hang the run
      await p.exited;
      clearTimeout(timer);
      const data = Buffer.from(readFileSync(out)).toString("base64");
      return { kind: "image", block: { type: "image", source: { type: "base64", media_type: "image/png", data } } };
    } catch {
      /* fall through to text */
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
  const text = html.replace(/<(script|style)[\s\S]*?<\/\1>/gi, " ").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").slice(0, 8000);
  return { kind: "text", block: { type: "text", text: `The page's text:\n${text}` } };
}

async function ask(shot: unknown, text: string): Promise<string> {
  const content = [shot, { type: "text", text }];
  const res = await fetch(`${api}/v1/messages`, {
    method: "POST",
    headers: { "x-api-key": key!, "anthropic-version": "2023-06-01", "content-type": "application/json" },
    body: JSON.stringify({ model, max_tokens: 400, messages: [{ role: "user", content }] }),
  });
  if (!res.ok) throw new Error(`model answered ${res.status}`);
  const j = (await res.json()) as { content?: { type: string; text?: string }[] };
  return j.content?.find((c) => c.type === "text")?.text ?? "";
}

const run = await coldRead([...PAGES, ...(repo ? repoPages(repo) : [])], prompt, {
  fetchPage: async (path) => {
    const res = await fetch(base + path, { headers: auth, redirect: "manual" });
    return { status: res.status, location: res.headers.get("location"), html: res.status === 200 ? await res.text() : "" };
  },
  shoot,
  ask,
  log: (l) => console.error(l),
});
const { pages, findings } = run;
for (const [page, why] of Object.entries(run.failed)) console.error(`NOT SCORED ${page}: ${why.join("; ")}`);
if (run.mode === "text-only") console.error("text-only: no Chromium, so 390 and 1440 were sent the same words; phone and desktop are not comparable");
const refused = write ? writeRefusal(run, args.includes("--allow-text-only")) : null;
if (refused) {
  console.error(refused);
  process.exit(1);
}

if (write) {
  const record: ColdRead = { at: new Date().toISOString(), ...(parent !== undefined ? { issue: parent } : {}), mode: run.mode, pages };
  writeFileSync(BASELINE, JSON.stringify(withColdRead(JSON.parse(readFileSync(BASELINE, "utf8")), record), null, 2) + "\n");
  console.log(`wrote coldRead to ${BASELINE}`);
}
if (parent !== undefined) {
  const forge = process.env["FORGE_URL"];
  // The target is checked before anything is fetched; the open list then decides what is filed.
  const early = filingPlan({ forge, base, into, open: [], findings: [], parent, cap });
  if ("error" in early) {
    console.error(early.error);
    process.exit(2);
  }
  const list = await fetch(`${early.url}?state=open&limit=200`, { headers: auth });
  if (!list.ok) {
    console.error(`could not list open issues (${list.status}); filing nothing`);
    process.exit(1);
  }
  const open = (((await list.json()) as { items?: { title?: string }[] }).items ?? []).flatMap((i) => (i.title ? [i.title] : []));
  const plan = filingPlan({ forge, base, into, open, findings, parent, cap }) as Exclude<ReturnType<typeof filingPlan>, { error: string }>;
  console.log(`${findings.length} findings, ${plan.filing.length} to file (cap ${cap}, ${plan.skipped} skipped as open or over the cap)`);
  for (const f of plan.filing) {
    const r = await fetch(plan.url, {
      method: "POST",
      headers: { ...auth, "content-type": "application/json" },
      body: JSON.stringify({ title: f.title, body: f.body }),
    });
    console.log(`${r.status} ${f.page} ${f.device}`);
  }
}
