/** Account settings: fields are a label and a value; their explanations sit behind one help toggle per page (#10302). */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { quietLogs } from "./helpers/globals.ts";

quietLogs();

let dir = "";
let app: App, servers: Servers, cookie = "";

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "forge-acchelp-"));
  app = createApp({ dataDir: dir, port: 0 });
  servers = await serve(app);
  const signup = await fetch(`${servers.url}/signup`, {
    method: "POST",
    body: new URLSearchParams({ username: "ada", email: "ada@f.dev", password: "account-password" }),
    redirect: "manual",
  });
  cookie = (signup.headers.get("set-cookie") ?? "").split(";")[0]!;
});
afterAll(async () => {
  servers.stop();
  app.close();
  await rm(dir, { recursive: true, force: true });
});

const get = async (path: string): Promise<string> => (await fetch(`${servers.url}${path}`, { headers: { cookie } })).text();

const helpOf = (body: string): string => {
  const at = body.indexOf("data-page-help");
  return body.slice(at, body.indexOf("</details>", at));
};

test.each(["/settings", "/settings/password", "/settings/tokens"])("%s has one named help toggle, closed", async (path) => {
  const body = await get(path);
  expect(body.match(/data-page-help/g)?.length).toBe(1);
  expect(body.match(/<details class="disclosure/g)?.length).toBe(1);
  expect(body).toContain("<summary>Help with these fields</summary>");
  expect(body).not.toMatch(/<details[^>]*\sopen/);
});

test("the profile's explanations, with the role's abilities, live inside the help toggle", async () => {
  const body = await get("/settings");
  const help = helpOf(body);
  expect(help).toContain("Never shown to other people");
  expect(help).toContain("Create a repository or copy an app");
  expect(body.replace(help, "")).not.toContain("Never shown to other people");
  expect(body.replace(help, "")).not.toContain("Create a repository or copy an app");
});

test("the password and token explanations live inside the help toggle, before the block", async () => {
  const pw = await get("/settings/password");
  expect(helpOf(pw)).toContain("A passphrase beats a puzzle");
  expect(pw.replace(helpOf(pw), "")).not.toContain("A passphrase beats a puzzle");
  expect(pw.indexOf("data-page-help")).toBeLessThan(pw.indexOf("Change password</h2>"));
  const tk = await get("/settings/tokens");
  expect(helpOf(tk)).toContain("can never make another access code");
  expect(helpOf(tk)).toContain("laptop, CI, deploy box");
  expect(tk.replace(helpOf(tk), "")).not.toContain("laptop, CI, deploy box");
});

test("constraints stay as one-line hints tied by aria-describedby", async () => {
  const pw = await get("/settings/password");
  expect(pw).toContain("At least 10 characters.");
  expect(pw).toMatch(/aria-describedby="[^"]*-hint"/);
  const profile = await get("/settings");
  expect(profile).toContain("https: only.");
});

test("a saved notify URL shows only its host, as a hint", async () => {
  const set = await fetch(`${servers.url}/settings/notify`, {
    method: "POST",
    headers: { cookie, origin: servers.url },
    body: new URLSearchParams({ url: "https://ntfy.sh/secret-topic" }),
    redirect: "manual",
  });
  expect(set.status).toBeLessThan(400);
  const body = await get("/settings");
  expect(body).toContain("Sending to ntfy.sh. https: only.");
  expect(body).not.toContain("secret-topic");
});
