/** The Flows page speaks the home page's language (#9903): headings and rows, no card boxes. */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { PREVIEW_ADMIN, PREVIEW_REPO } from "../src/spawn/preview-looks.ts";
import { seedPreview } from "../src/spawn/preview-seed.ts";
import { serve } from "../src/http/server.ts";
import { readFileSync } from "node:fs";

let dir: string;
let app: App;
let servers: Awaited<ReturnType<typeof serve>>;
const KEY = "flows-language-key";
const sign = (id: string, name: string, role: string) => {
  const said = `${id}|${name}|${role}|${Date.now() + 60_000}`;
  return { "x-forge-identity": said, "x-forge-signature": createHmac("sha256", KEY).update(said).digest("base64url") };
};
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "forge-flows-lang-"));
  app = createApp({ dataDir: dir, port: 0, previewIdentityKey: KEY });
  const seeded = await seedPreview(app, { FORGE_APP_ENV: "preview" });
  if (!seeded.ok) throw new Error(seeded.error);
  servers = await serve(app);
}, 30_000);
afterAll(async () => {
  servers.stop();
  app.close();
  await rm(dir, { recursive: true, force: true });
});

const url = () => `${servers.url}/${PREVIEW_ADMIN}/${PREVIEW_REPO}/flows`;

test("one h1; in and out are plain sections under h2; no card boxes", async () => {
  const html = await (await fetch(url(), { headers: sign("u1", "trevato", "admin") })).text();
  expect(html.match(/<h1[ >]/g)?.length).toBe(1);
  expect(html).toMatch(/<h2>Flows in<\/h2>/);
  expect(html).toMatch(/<h2>Flows out<\/h2>/);
  expect(html).toMatch(/<h2>Packages<\/h2>/);
  expect(html).toContain("flow-map");
  expect(html).not.toContain('class="card');
  expect(html).not.toContain("card-body");
});

test("the page source no longer calls card(", () => {
  expect(readFileSync(join(import.meta.dir, "../src/web/pages/flows.ts"), "utf8")).not.toMatch(/\bcard\(/);
});

test("an admin has the same-origin read form; a guest has none", async () => {
  const admin = sign("u1", "trevato", "admin");
  expect(await (await fetch(url(), { headers: admin })).text()).toContain("Read upstream releases now");
  const post = await fetch(`${url()}/check`, { method: "POST", redirect: "manual", headers: { ...admin, origin: "https://evil.example" } });
  expect(post.status).toBe(403);
  const guest = await (await fetch(url())).text();
  expect(guest).not.toContain("Read upstream releases now");
  expect(guest).not.toContain("/flows/check");
  expect(guest).not.toContain("/flows/probe");
});
