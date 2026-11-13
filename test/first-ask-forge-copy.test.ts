/**
 * A person who takes the forge's own name owns the child's copy of the forge (`<name>/forge`):
 * an ask naming no repository still makes a new app, on the web home, the terminal and `tell`
 * without a repo, and one that names the copy still files there.
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { appsFirst, asksMakeANewApp, forgeCopyTest, isForgeCopy } from "../src/actions/first_ask.ts";
import { createRepo } from "../src/actions/repos.ts";
import { listIssues } from "../src/core/issues.ts";
import { deleteRepo, getRepo, listReposOwnedBy } from "../src/core/repos.ts";
import { getUserByName } from "../src/core/users.ts";
import { nextStepsFor } from "../src/core/next-steps.ts";
import { createToken } from "../src/core/tokens.ts";
import { setForgeSource } from "../src/settings/forge_source.ts";
import { startedForge, type StartedForge } from "./helpers/claimed-forge.ts";
import { quietLogs } from "./helpers/globals.ts";

quietLogs();

let forge: StartedForge;
let cookie = "";
let name = "";
beforeAll(async () => {
  forge = await startedForge("forge-copy-ask-");
  name = forge.child.db.query<{ username: string }, []>("SELECT username FROM user WHERE kind = 'org' LIMIT 1").get()!.username;
  const res = await fetch(`${forge.base}/claim`, {
    method: "POST",
    headers: { origin: forge.base },
    body: new URLSearchParams({ token: forge.token, username: name, email: "maria@bakery.test", password: "a-long-enough-password" }),
    redirect: "manual",
  });
  if (res.status !== 303) throw new Error(`claim ${res.status}`);
  cookie = (res.headers.get("set-cookie") ?? "").split(";")[0]!;
  // A forge made for someone with no apps of its own: the apps the test parent carried over go.
  for (const r of listReposOwnedBy(forge.child.db, getUserByName(forge.child.db, name)!.id)) await deleteRepo(forge.child.db, forge.child.reposRoot, r);
  // The child's copy of the forge's own source, owned by the name the person took.
  const owner = getUserByName(forge.child.db, name)!;
  const made = await createRepo(forge.child, owner, { name: "forge" });
  if (!made.ok) throw new Error("forge copy");
  setForgeSource(forge.child.db, `${name}/forge`, owner.id);
}, 60_000);
afterAll(() => forge.stop());

test("after the person took the forge's name, the first-ask box is still the home", async () => {
  const owner = getUserByName(forge.child.db, name)!;
  expect(owner.kind).toBe("user");
  expect((await nextStepsFor(forge.child, owner))?.some((s) => s.key === "tell" && !s.done)).toBe(true);
  const html = await (await fetch(`${forge.base}/`, { headers: { cookie } })).text();
  const card = html.slice(html.indexOf("data-first-tell"));
  expect(card).toContain('value="new-app"');
  expect(card).not.toContain(`value="${name}/forge"`);
});

test("the forge's own copy is recognised, and an ask naming no repository makes an app", async () => {
  const owner = getUserByName(forge.child.db, name)!;
  const copy = getRepo(forge.child.db, name, "forge")!;
  expect(isForgeCopy(forge.child, copy)).toBe(true);
  expect(await asksMakeANewApp(forge.child, owner)).toBe(true);
});

test("tell without a repository, over MCP, makes a new app too, and names no forge copy", async () => {
  const owner = getUserByName(forge.child.db, name)!;
  const copy = getRepo(forge.child.db, name, "forge")!;
  const token = createToken(forge.child.db, owner.id, "rw", "rw").token;
  const res = await fetch(`${forge.base}/mcp`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "tell", arguments: { text: "A page for the bakery's opening hours" } } }),
  });
  const said = JSON.parse(((await res.json()) as { result: { content: { text: string }[] } }).result.content[0]!.text) as { issue?: number; page?: string };
  expect(said.issue).toBe(1);
  expect(said.page).not.toContain(`/${name}/forge/`);
  expect(listIssues(forge.child.db, copy.id, {}).length).toBe(0);
  const made = listReposOwnedBy(forge.child.db, owner.id).filter((r) => r.name !== "forge");
  expect(made.length).toBe(1);
  expect(said.page).toContain(`/${name}/${made[0]!.name}/issues/1`);
  // Remove it so the web ask below starts as a first ask again.
  await deleteRepo(forge.child.db, forge.child.reposRoot, made[0]!);
});

test("a web ask makes a new app, not an issue on the forge copy; a second ask has an app of its own", async () => {
  const owner = getUserByName(forge.child.db, name)!;
  const copy = getRepo(forge.child.db, name, "forge")!;
  const res = await forge.post(cookie, "/tell", { app: "new-app", text: "A page that says hello and shows today's date" });
  expect(res.status).toBe(303);
  expect(listIssues(forge.child.db, copy.id, {}).length).toBe(0);
  const made = listReposOwnedBy(forge.child.db, owner.id).filter((r) => r.name !== "forge");
  expect(made.length).toBe(1);
  expect(listIssues(forge.child.db, made[0]!.id, { state: "open" }).length).toBe(1);
  expect(await asksMakeANewApp(forge.child, owner)).toBe(false);
});

test("naming the forge copy still files the ask on it", async () => {
  const copy = getRepo(forge.child.db, name, "forge")!;
  const res = await forge.post(cookie, "/tell", { app: `${name}/forge`, text: "Fix the footer on the forge" });
  expect(res.status).toBe(303);
  expect(listIssues(forge.child.db, copy.id, {}).length).toBe(1);
});

test("forgeCopyTest agrees with isForgeCopy on several repositories, and appsFirst orders by it", () => {
  const repos = [
    { ownerName: name, name: "forge" },
    { ownerName: name.toUpperCase(), name: "FORGE" },
    { ownerName: name, name: "bakery" },
    { ownerName: "someone", name: "forge" },
  ];
  const test = forgeCopyTest(forge.child);
  for (const r of repos) expect(test(r)).toBe(isForgeCopy(forge.child, r));
  expect(repos.map(test)).toEqual([true, true, false, false]);
  const { ordered, onlyForgeCopy } = appsFirst(forge.child, repos);
  expect(ordered.map((r) => r.name)).toEqual(["bakery", "forge", "forge", "FORGE"]);
  expect(onlyForgeCopy).toBe(false);
  expect(appsFirst(forge.child, repos.slice(0, 2)).onlyForgeCopy).toBe(true);
  expect(appsFirst(forge.child, []).onlyForgeCopy).toBe(false);
});
