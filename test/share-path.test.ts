import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp as createForge, type App } from "../src/app.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { getPlans } from "../src/settings/plans.ts";
import { SIZES } from "../src/spawn/sizes.ts";
import { SITE_PATH, START_BUTTON } from "../src/web/site_line.ts";

let dataDir: string;
let app: App;
let servers: Servers;
let base: string;

beforeAll(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "forge-sharepath-"));
  app = createForge({ dataDir, port: 0 });
  servers = await serve(app);
  base = servers.url;
});
afterAll(async () => {
  await servers.stop();
  await rm(dataDir, { recursive: true, force: true });
});

const get = async (path: string): Promise<string> => (await fetch(`${base}${path}`)).text();

test("/, /pricing, /agents and /llms.txt each give the one-line path with the one button name", async () => {
  const line = SITE_PATH(base);
  expect(line).toContain(`press ${START_BUTTON}.`);
  for (const path of ["/", "/pricing", "/agents", "/llms.txt"]) {
    const text = (await get(path)).replaceAll("&#39;", "'");
    expect(text, path).toContain(line);
    expect(text, path).toContain(START_BUTTON);
    expect(text, path).not.toContain("Spawn");
    expect(text, path).not.toContain("New app");
  }
  const llms = await get("/llms.txt");
  expect(llms.split("\n").slice(0, 8).join("\n")).toContain(line);
  for (const path of ["/", "/pricing"]) {
    const head = await get(path);
    expect(head).toContain(`<meta name="description" content="${path === "/" ? "Open Platform Forge gives you a forge of your own where an AI crew builds your apps. " : ""}${line}`);
  }
});

test("/pricing's free start is the home form's one step: a name and the same button, posted to the same door", async () => {
  const text = await get("/pricing");
  expect(text).toMatch(/<button[^>]*formaction="\/forges\/start"[^>]*>\s*Start my forge\s*<\/button>/);
  expect(text).not.toContain("Start free");
});

test("the plan facts in /pricing's Offer data and /llms.txt's table are the plans setting", async () => {
  const plans = getPlans(app.db);
  const page = await get("/pricing");
  const ld = JSON.parse(page.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/)![1]!);
  expect(ld.offers).toHaveLength(plans.length);
  const llms = await get("/llms.txt");
  plans.forEach((p, i) => {
    const s = SIZES[p.size];
    const offer = ld.offers[i];
    expect(offer.price).toBe(String(p.priceUsd));
    const prop = (n: string) => offer.additionalProperty.find((x: { name: string }) => x.name === n).value;
    expect(prop("CPUs")).toBe(s.cpu);
    expect(prop("Memory (GB)")).toBe(s.memoryMiB / 1024);
    expect(prop("Crew credit (USD a month)")).toBe(p.creditUsd);
    expect(llms).toContain(`| ${p.name} | ${p.priceUsd} | ${s.cpu} | ${s.memoryMiB / 1024} | ${s.diskMiB / 1024} | ${p.creditUsd} |`);
  });
});

test("the share tags name the full product and the image resolves to a 1200×630 PNG under 300 KB", async () => {
  for (const path of ["/", "/pricing"]) {
    const head = await get(path);
    expect(head).toContain('<meta property="og:site_name" content="Open Platform Forge" />');
    expect(head).toMatch(/<title>Open Platform Forge: /);
    const image = head.match(/<meta name="twitter:image" content="([^"]+)"/)![1]!;
    expect(head).toMatch(new RegExp(`property="og:image"\\s+content="${image}"`));
    expect(head).toContain(`name="twitter:image" content="${base}/og/site.png"`);
    const res = await fetch(image);
    expect(res.status).toBe(200);
    const bytes = new Uint8Array(await res.arrayBuffer());
    expect(bytes.length).toBeLessThan(300 * 1024);
    const dv = new DataView(bytes.buffer);
    expect([dv.getUint32(16), dv.getUint32(20)]).toEqual([1200, 630]);
  }
});
