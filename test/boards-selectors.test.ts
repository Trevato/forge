/**
 * /boards/data and a board's forms: every selector is in the page with a
 * visible label, none sits in the hover-only `.row-actions` (opacity 0 until
 * a `.row` is hovered, which hid them), and each theme's label, field and
 * border colours are a readable pair.
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../src/app.ts";
import { createToken } from "../src/core/tokens.ts";
import { createUser } from "../src/core/users.ts";
import { THEMES } from "../src/design/themes.ts";
import { serve } from "../src/http/server.ts";
import { content } from "../src/web/style/content.ts";
import { components } from "../src/web/style/components.ts";

let dir: string;
let app: ReturnType<typeof createApp>;
let servers: Awaited<ReturnType<typeof serve>>;
let token: string;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "forge-boards-selectors-"));
  app = createApp({ dataDir: dir, port: 0 });
  servers = await serve(app);
  const r = await createUser(app.db, {
    origin: "seed", trusted: true, username: "alice", email: "alice@forge.local",
    password: "a-good-passphrase", adminIfFirst: true,
  });
  if (!r.ok) throw new Error(r.error);
  token = createToken(app.db, r.value.id, "t", "admin").token;
});

afterAll(async () => {
  servers.stop();
  app.close();
  await rm(dir, { recursive: true, force: true });
});

const lum = (hex: string) => {
  const c = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
    .map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * c[0]! + 0.7152 * c[1]! + 0.0722 * c[2]!;
};
const ratio = (a: string, b: string) => {
  const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x);
  return (hi! + 0.05) / (lo! + 0.05);
};

test("every query selector has a visible label and sits outside .row-actions", async () => {
  const res = await fetch(`${servers.url}/boards/data`, { headers: { authorization: `Bearer ${token}` } });
  expect(res.status).toBe(200);
  const html = await res.text();
  const form = [...html.matchAll(/<form method="get" action="\/boards\/data"[^>]*>([\s\S]*?)<\/form>/g)].find((m) => m[0].includes('name="chart"'));
  expect(form).not.toBeNull();
  expect(form![0]).not.toContain("row-actions");
  expect(form![0]).toContain('class="bar"');
  expect(html).not.toContain("bform");
  for (const name of ["chart", "source", "aggregate", "column", "by", "series", "from", "to", "fcolumn", "fop", "fvalue"]) {
    const m = form![1]!.match(new RegExp(`<label for="f-${name}-\\d+">([^<]+)</label>\\s*<(?:select|input)[^>]* name="${name}"`));
    expect(m, name).not.toBeNull();
    expect(m![1]!.trim().length, name).toBeGreaterThan(0);
  }
});

test("no .bform rule is left in the stylesheet or the boards pages", async () => {
  expect(components + content).not.toContain("bform");
  for (const f of ["boards-view.ts", "boards.ts"]) {
    expect(await Bun.file(`${import.meta.dir}/../src/web/pages/${f}`).text()).not.toContain("bform");
  }
});

test("in every theme the label, field text and border read against their ground", () => {
  for (const [name, theme] of Object.entries(THEMES)) {
    const t = theme.tokens;
    expect(ratio(t.fg, t.bg), `${name} label`).toBeGreaterThanOrEqual(4.5);
    expect(ratio(t.fg, t.card), `${name} field text`).toBeGreaterThanOrEqual(4.5);
    expect(ratio(t["border-strong"], t.card), `${name} border`).toBeGreaterThan(1.3);
    expect(t.card.toLowerCase(), `${name} field ground`).not.toBe(t.fg.toLowerCase());
  }
});
