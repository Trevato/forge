/** The shared pick list (#8929), with 150 repositories on /forges/new. */

import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRepo } from "../src/actions/repos.ts";
import { createApp, type App } from "../src/app.ts";
import { createUser } from "../src/core/users.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { shellJs } from "../src/web/client.ts";
import { pickList, pickJs } from "../src/web/pick.ts";
import { css } from "../src/web/style.ts";
import { quietLogs } from "./helpers/globals.ts";

quietLogs();

test("pickList: plain checkboxes, a count, and escaped labels", () => {
  const items = Array.from({ length: 150 }, (_, i) => ({ value: `o/r${i}`, label: `o/r${i}` }));
  const out = String(pickList({ legend: "Apps", name: "apps", items, chosen: ["o/r3", "o/r9"], noun: "repositories" }));
  expect(out.match(/type="checkbox"/g)?.length).toBe(150);
  expect(out.match(/ checked/g)?.length).toBe(2);
  expect(out).toContain("2 of 150 repositories picked");
  expect(out).toContain("data-pick-bar");
  const evil = String(pickList({ legend: "L", name: "n", items: [{ value: "<b>", label: "<script>x</script>" }], chosen: [] }));
  expect(evil).not.toContain("<script>");
});

test("the script and styles ship with the shell", () => {
  expect(shellJs).toContain(pickJs);
  expect(css).toContain(".pick-chip");
  expect(() => new Function(pickJs)).not.toThrow();
});

test("/forges/new with 150 repositories shows one bounded list", async () => {
  const dir = await mkdtemp(join(tmpdir(), "forge-pick-"));
  const app: App = createApp({ dataDir: dir, url: "https://forge.test", port: 0 });
  let servers: Servers | undefined;
  try {
    const u = await createUser(app.db, {
      origin: "seed", trusted: true, username: "alice", email: "a@x.test",
      password: "a-long-pick-passphrase", isAdmin: true,
    });
    if (!u.ok) throw new Error("user");
    for (let i = 0; i < 150; i++) {
      const r = await createRepo(app, u.value, { name: `app${i}` });
      if (!r.ok) throw new Error("repo");
    }
    servers = await serve(app);
    const si = await fetch(`${servers.url}/signin`, {
      method: "POST",
      body: new URLSearchParams({ username: "alice", password: "a-long-pick-passphrase" }),
      redirect: "manual",
    });
    const cookie = (si.headers.get("set-cookie") ?? "").split(";")[0]!;
    const text = await (await fetch(`${servers.url}/forges/new`, { headers: { cookie } })).text();
    expect(text.match(/name="apps"/g)?.length).toBe(150);
    expect(text).toContain("0 of 150 repositories picked");
    expect(text).toContain("data-pick-filter");
  } finally {
    servers?.stop();
    app.close();
    await rm(dir, { recursive: true, force: true });
  }
}, 60_000);

async function mount(n: number, chosen: string[] = []) {
  const { Window } = await import("happy-dom");
  const doc = new Window().document as any;
  const items = Array.from({ length: n }, (_, i) => ({ value: `o/r${i}`, label: `o/r${i}` }));
  doc.body.innerHTML = String(pickList({ legend: "Apps", name: "apps", noun: "repositories", items, chosen, error: "bad" }));
  new Function("document", pickJs)(doc);
  const shown = () => [...doc.querySelectorAll("[data-pick-item]")].filter((e: any) => !e.hidden).length;
  const type = (v: string) => {
    const f = doc.querySelector("[data-pick-filter]");
    f.value = v;
    f.dispatchEvent(new (doc.defaultView.Event)("input", { bubbles: true }));
  };
  return { doc, shown, type };
}

test("pickJs: filter narrows, ticking makes chips and the count, a chip unticks", async () => {
  const { doc, shown, type } = await mount(150, ["o/r1"]);
  expect(doc.querySelector("[data-pick-bar]").hidden).toBe(false);
  expect(doc.querySelectorAll(".pick-chip").length).toBe(1);
  type("r14");
  expect(shown()).toBe(11); // r14, r140..r149
  expect(doc.querySelector("[data-pick-count]").textContent).toContain("11 shown");
  expect(doc.querySelector("[data-pick-live]").textContent).toBe("");
  const box = [...doc.querySelectorAll("[data-pick-item] input")].find((i: any) => i.value === "o/r145") as any;
  box.checked = true;
  box.dispatchEvent(new (doc.defaultView.Event)("change", { bubbles: true }));
  expect(doc.querySelectorAll(".pick-chip").length).toBe(2);
  expect(doc.querySelector("[data-pick-live]").textContent).toBe("2 of 150 repositories picked");
  doc.querySelector(".pick-chip").click(); // o/r1
  expect(doc.querySelectorAll(".pick-chip").length).toBe(1);
  expect(doc.querySelector("[data-pick-live]").textContent).toBe("1 of 150 repositories picked");
  type("");
  expect(shown()).toBe(150);
  expect(doc.querySelector("[data-pick-count]").textContent).toBe("1 of 150 repositories picked");
});

test("pickList: the error is described to the fieldset", async () => {
  const { doc } = await mount(3);
  expect(doc.querySelector("fieldset").getAttribute("aria-describedby")).toBe("f-apps-err");
  expect(doc.getElementById("f-apps-err").textContent).toBe("bad");
  expect(doc.querySelector("[role=group]")).toBeNull();
});
