/**
 * The followed sources join the shell's j/k traversal (#10796): one focusable
 * row each on the real settings page, Enter opening the source's own link.
 * Left out: the check history (no link to open) and the forms around it,
 * which keep their fields and buttons.
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { addFollowSources } from "../src/actions/follow_sources.ts";
import { createRepo } from "../src/actions/repos.ts";
import { createUser } from "../src/core/users.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { expectListKeys, mainOf, navHrefs, shellPage } from "./helpers/shell-page.ts";

let dataDir = "";
let app: App;
let servers: Servers;
let cookie = "";
const urls = ["https://example.com/a/one.git", "https://example.com/b/two.git"];

const page = async (): Promise<string> =>
  mainOf(await (await fetch(`${servers.url}/alice/square/settings`, { headers: { cookie } })).text());
/** The sources card of the real page: the settings tabs above it are the page's own rows. */
const settings = async (): Promise<string> => {
  const whole = await page();
  const at = whole.indexOf('id="sources"');
  return whole.slice(whole.lastIndexOf("<section", at), whole.indexOf("</section>", at) + 10);
};

beforeAll(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "forge-keys-follow-"));
  app = createApp({ dataDir, port: 0 });
  const made = await createUser(app.db, {
    origin: "seed", trusted: true, username: "alice", email: "alice@forge.local",
    password: "a-good-passphrase", adminIfFirst: true,
  });
  if (!made.ok) throw new Error(JSON.stringify(made.error));
  const repo = await createRepo(app, made.value, { name: "square", visibility: "public" });
  if (!repo.ok) throw new Error(JSON.stringify(repo.error));
  const added = addFollowSources(app, made.value, repo.value, urls.map((u) => `${u} main`).join("\n"));
  if (!added.ok) throw new Error(JSON.stringify(added.error));
  servers = await serve(app);
  const res = await fetch(`${servers.url}/signin`, {
    method: "POST", body: new URLSearchParams({ username: "alice", password: "a-good-passphrase" }), redirect: "manual",
  });
  cookie = (res.headers.get("set-cookie") ?? "").split(";")[0]!;
}, 30_000);

afterAll(async () => {
  servers?.stop();
  app?.close();
  await rm(dataDir, { recursive: true, force: true });
});

test("each followed source is a focusable row; j/k focus it, Enter opens it, Esc has nowhere to go, fields keep their keys", async () => {
  const html = await settings();
  const hrefs = await navHrefs(html);
  expect(hrefs).toEqual(urls);
  await expectListKeys({ path: "/alice/square/settings", html, hrefs, opened: null });
});

test("a focused source row is reachable by script only (tabindex -1)", async () => {
  const p = await shellPage("/alice/square/settings", await settings());
  p.key("j");
  expect(p.doc.activeElement.getAttribute("tabindex")).toBe("-1");
  expect(p.doc.activeElement.hasAttribute("data-nav")).toBe(true);
});

test("on the whole page the sources follow the settings tabs in the same traversal", async () => {
  const hrefs = await navHrefs(await page());
  expect(hrefs.slice(-urls.length)).toEqual(urls);
});
