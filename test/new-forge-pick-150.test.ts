/** /forges/new with 150 repositories (#8968): search narrows, picks survive filtering, the page costs a bounded, counted amount of work (#7824). */

import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRepo } from "../src/actions/repos.ts";
import { createApp, type App } from "../src/app.ts";
import { createUser } from "../src/core/users.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { pickJs } from "../src/web/pick.ts";
import { quietLogs } from "./helpers/globals.ts";
import { expectWork, requestStatements } from "./helpers/work.ts";

quietLogs();

const PASSWORD = "a-long-pick-150-passphrase";
let dir = "";
let app: App;
let servers: Servers;
let cookie = "";

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "forge-pick-150-"));
  app = createApp({ dataDir: dir, url: "https://forge.test", port: 0 });
  const u = await createUser(app.db, {
    origin: "seed", trusted: true, username: "alice", email: "a@x.test", password: PASSWORD, isAdmin: true,
  });
  if (!u.ok) throw new Error("user");
  for (let i = 0; i < 150; i++) {
    const r = await createRepo(app, u.value, { name: `app${i}` });
    if (!r.ok) throw new Error("repo");
  }
  servers = await serve(app);
  const si = await fetch(`${servers.url}/signin`, {
    method: "POST",
    body: new URLSearchParams({ username: "alice", password: PASSWORD }),
    redirect: "manual",
  });
  cookie = (si.headers.get("set-cookie") ?? "").split(";")[0]!;
}, 120_000);

afterAll(async () => {
  servers.stop();
  app.close();
  await rm(dir, { recursive: true, force: true });
});

test("the page with 150 repositories costs a handful of statements, not one per repository", async () => {
  const url = `${servers.url}/forges/new`;
  const text = await (await fetch(url, { headers: { cookie } })).text();
  expect(text.match(/name="apps"/g)?.length).toBe(150);
  const n = await requestStatements(app.db, url, { headers: { cookie } });
  expectWork(n, { max: 20 });
});

test("picks made before a re-render stay ticked among the 150, and the count says so", async () => {
  const res = await fetch(`${servers.url}/forges/new`, {
    method: "POST",
    headers: { cookie, origin: "https://forge.test" },
    body: new URLSearchParams([["name", "kid"], ["apps", "alice/app3"], ["apps", "alice/app120"], ["do", "plan"]]),
  });
  const text = await res.text();
  expect(text.match(/name="apps"[^>]*checked|checked[^>]*name="apps"/g)?.length).toBe(2);
  expect(text).toContain("2 of 150 repositories picked");
});

test("searching narrows the 150 while the ticked ones stay ticked, shown as chips and still submitted", async () => {
  const { Window } = await import("happy-dom");
  const text = await (await fetch(`${servers.url}/forges/new`, { headers: { cookie } })).text();
  const body = text.slice(text.indexOf('<fieldset class="field pick"'), text.indexOf("</fieldset>", text.indexOf('<fieldset class="field pick"')) + 11);
  const doc = new Window().document as any;
  doc.body.innerHTML = `<form>${body.replace('value="alice/app3"', 'value="alice/app3" checked').replace('value="alice/app120"', 'value="alice/app120" checked')}</form>`;
  new Function("document", pickJs)(doc);
  const Ev = doc.defaultView.Event;
  const shown = () => [...doc.querySelectorAll("[data-pick-item]")].filter((e: any) => !e.hidden).length;
  const type = (v: string) => {
    const f = doc.querySelector("[data-pick-filter]");
    f.value = v;
    f.dispatchEvent(new Ev("input", { bubbles: true }));
  };
  type("app12"); // app12, app120..app129
  expect(shown()).toBe(11);
  type("app3"); // app3, app30..app39
  expect(shown()).toBe(11);
  type("app12");
  // app3 is hidden by the search but stays ticked and is in the form's data.
  const ticked = [...doc.querySelectorAll("input[name=apps]")].filter((i: any) => i.checked).map((i: any) => i.value);
  expect(ticked.sort()).toEqual(["alice/app120", "alice/app3"]);
  expect(doc.querySelectorAll(".pick-chip").length).toBe(2);
  expect(doc.querySelector("[data-pick-count]").textContent).toBe("2 of 150 repositories picked; 11 shown");
  type("");
  expect(shown()).toBe(150);
  expect(doc.querySelectorAll(".pick-chip").length).toBe(2);
});
