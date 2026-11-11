/**
 * The first ask of a spawned forge (#11342): "What do you want built?" makes
 * a new app named from the ask and files the ask there as an issue; no
 * thought is kept on `forge`, and the person lands on the new app.
 */

import { afterAll, beforeAll, expect, test } from "bun:test";
import { listIssues, MAX_BODY } from "../src/core/issues.ts";
import { TOO_LONG_WORDS } from "../src/actions/tell.ts";
import { FORGE_REPO_WORDS, SAY_SOMETHING_WORDS } from "../src/actions/tell_words.ts";
import { listReposOwnedBy } from "../src/core/repos.ts";
import { autonomyStatus } from "../src/crew/autonomy.ts";
import { listCrewRoles } from "../src/core/agents.ts";
import { recentThoughts } from "../src/core/thoughts.ts";
import { fundingOf, keepFunding } from "../src/spawn/funding.ts";
import { crewCanRun, crewKeyCard } from "../src/web/studio/crew_key.ts";
import { getUserByName } from "../src/core/users.ts";
import { deriveAppName } from "../src/web/pages/apps-name.ts";
import { claimedForge, type ClaimedForge } from "./helpers/claimed-forge.ts";
import { quietLogs } from "./helpers/globals.ts";

quietLogs();

let forge: ClaimedForge;
beforeAll(async () => {
  forge = await claimedForge("forge-first-ask-");
}, 60_000);
afterAll(() => forge.stop());

test("the first-tell form targets a new app, not the forge", async () => {
  const html = await (await fetch(`${forge.base}/`, { headers: { cookie: forge.owner } })).text();
  const card = html.slice(html.indexOf("data-first-tell"));
  expect(card).toContain('value="new-app"');
  expect(card).not.toContain('value="forge"');
});

test("the first tell makes one app, files one open issue on it, keeps no thought", async () => {
  const db = forge.child.db;
  const maria = getUserByName(db, "maria")!;
  const before = listReposOwnedBy(db, maria.id).length;
  const ask = "A weekly menu page for the bakery";
  const res = await forge.post(forge.owner, "/tell", { app: "new-app", text: ask });
  expect(res.status).toBe(303);
  const made = listReposOwnedBy(db, maria.id);
  expect(made.length).toBe(before + 1);
  const repo = made.find((r) => r.name.includes("menu"))!;
  expect(repo).toBeDefined();
  expect(res.headers.get("location")).toContain(`/maria/${repo.name}`);
  const issues = listIssues(db, repo.id, { state: "open" });
  expect(issues.length).toBe(1);
  expect(issues[0]!.body + issues[0]!.title).toContain("weekly menu page");
  // The forge's included credit lets the crew run: the new app starts autonomous (box 2).
  expect(crewCanRun(forge.child)).toBe(true);
  expect(repo.autonomy).toBe("autonomous");
  // Autonomy is on as the asker and a builder and reviewer are seated: the tick does not pause (#11508).
  expect(repo.autonomyBy).toBe(maria.id);
  expect(autonomyStatus(forge.child, repo).paused).toBeNull();
  expect(listCrewRoles(db, repo.id).map((c) => c.role).sort()).toEqual(["builder", "reviewer"]);
  // With credit left the app's page asks for no key and says nobody is missing.
  const page = await (await fetch(`${forge.base}/maria/${repo.name}`, { headers: { cookie: forge.owner } })).text();
  expect(page).not.toContain("needs a model key");
  expect(page).not.toContain("Nobody on the crew yet");
  expect(recentThoughts(db, maria.id, 10).length).toBe(0);
});

test("with no credit the app is made and filed, and left as it was made", async () => {
  const db = forge.child.db;
  const maria = getUserByName(db, "maria")!;
  const dir = forge.child.config.dataDir;
  const funding = fundingOf(dir)!;
  keepFunding(dir, { token: funding.token, capUsd: 2, spentUsd: 2 });
  try {
    expect(crewCanRun(forge.child)).toBe(false);
    const res = await forge.post(forge.owner, "/tell", { app: "new-app", text: "A parking map for the market" });
    expect(res.status).toBe(303);
    const repo = listReposOwnedBy(db, maria.id).find((r) => r.name.includes("parking"))!;
    expect(listIssues(db, repo.id, { state: "open" }).length).toBe(1);
    expect(repo.autonomy).not.toBe("autonomous");
  } finally {
    keepFunding(dir, funding);
  }
});

function flashOf(res: Response): string {
  return decodeURIComponent(res.headers.getSetCookie().join(";"));
}

test("an empty ask makes no app and says so", async () => {
  const db = forge.child.db;
  const before = listReposOwnedBy(db, getUserByName(db, "maria")!.id).length;
  const res = await forge.post(forge.owner, "/tell", { app: "new-app", text: "   " });
  expect(res.status).toBe(303);
  expect(flashOf(res)).toContain(SAY_SOMETHING_WORDS);
  expect(listReposOwnedBy(db, getUserByName(db, "maria")!.id).length).toBe(before);
});

test("an over-long ask makes no app and says so", async () => {
  const db = forge.child.db;
  const before = listReposOwnedBy(db, getUserByName(db, "maria")!.id).length;
  const res = await forge.post(forge.owner, "/tell", { app: "new-app", text: "zebra ".repeat(MAX_BODY) });
  expect(res.status).toBe(303);
  expect(flashOf(res)).toContain(TOO_LONG_WORDS);
  expect(listReposOwnedBy(db, getUserByName(db, "maria")!.id).length).toBe(before);
});

test("an ask that would name the forge's own repository is refused and makes no app", async () => {
  const db = forge.child.db;
  const maria = getUserByName(db, "maria")!;
  const ask = "Quokka census tracker";
  const before = forge.child.config.forgeRepo;
  forge.child.config.forgeRepo = `maria/${deriveAppName(ask)!}`;
  const count = listReposOwnedBy(db, maria.id).length;
  try {
    const res = await forge.post(forge.owner, "/tell", { app: "new-app", text: ask });
    expect(res.status).toBe(303);
    expect(flashOf(res)).toContain(FORGE_REPO_WORDS);
    expect(listReposOwnedBy(db, maria.id).length).toBe(count);
  } finally {
    if (before === undefined) delete forge.child.config.forgeRepo;
    else forge.child.config.forgeRepo = before;
  }
});

const cardCtx = (admin: boolean) =>
  ({ app: forge.child, auth: { user: { isAdmin: admin } } }) as unknown as Parameters<typeof crewKeyCard>[0];

test("an app's page never asks for a key while included credit is left (#11508)", () => {
  expect(crewCanRun(forge.child)).toBe(true);
  for (const admin of [true, false]) expect(crewKeyCard(cardCtx(admin), true)).toBeNull();
});

test("with credit left the home card, not the app's page, still offers the key to an admin only", () => {
  expect(String(crewKeyCard(cardCtx(true), false))).toContain("crew-key-form");
  expect(String(crewKeyCard(cardCtx(false), false))).not.toContain("crew-key-form");
});

test("with the credit spent an app's page says a key is needed, with the link for an admin only", () => {
  const dir = forge.child.config.dataDir;
  const funding = fundingOf(dir)!;
  keepFunding(dir, { token: funding.token, capUsd: 2, spentUsd: 2 });
  try {
    expect(String(crewKeyCard(cardCtx(true), true))).toContain("needs a model key");
    expect(String(crewKeyCard(cardCtx(true), true))).toContain("/#crew-key-note");
    const person = String(crewKeyCard(cardCtx(false), true));
    expect(person).toContain("needs a model key");
    expect(person).not.toContain("/#crew-key-note");
  } finally {
    keepFunding(dir, funding);
  }
});
