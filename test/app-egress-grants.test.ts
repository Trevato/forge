/**
 * A site admin grants or revokes the private destinations an app's forge.json
 * asks for (#3433), on its settings page and through the API: a non-admin is
 * refused, a grant shows with who and when, a revoke removes it and is still
 * on the page, and a destination forge.json does not name is refused.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { commitToBranch, createRepo } from "../src/actions/repos.ts";
import {
  egressView,
  grantAppEgress,
  revokeAppEgress,
} from "../src/actions/egress_grants.ts";
import { createApp as insertApp } from "../src/core/apps.ts";
import { listEgressGrants } from "../src/core/egress_grants.ts";
import { eventVerb } from "../src/design/activity.ts";
import { listEvents } from "../src/core/events.ts";
import type { Repo } from "../src/core/repos.ts";
import { createToken } from "../src/core/tokens.ts";
import { createUser, type User } from "../src/core/users.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { quietLogs } from "./helpers/globals.ts";
import { promote } from "./helpers/members.ts";

quietLogs();

const ARM = "100.89.95.68:8101";
const CAMERA = "100.89.95.68:8102";
const FORGE_JSON = JSON.stringify({
  app: { run: "bun run src/server.ts" },
  egress: [ARM, CAMERA, "api.example.com", "*.example.org"],
});

let dataDir: string;
let app: App;
let servers: Servers;
let ada: User; // site admin
let bob: User; // owns nothing here, is not a site admin
let cy: User; // owns the repository but is no site admin
let repo: Repo;
let adaCookie = "";
let cyCookie = "";
let adaToken = "";
let bobToken = "";
let cyToken = "";

const ROUTE = "/api/v1/repos/cy/arm/egress-grants";
const api = (method: string, token: string, destination?: string) =>
  fetch(`${servers.url}${ROUTE}`, {
    method,
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    ...(destination === undefined ? {} : { body: JSON.stringify({ destination }) }),
  });
const web = (cookie: string, path: string, origin = servers.url) =>
  fetch(`${servers.url}${path}`, {
    method: path.endsWith("/grant") || path.endsWith("/revoke") ? "POST" : "GET",
    headers: { cookie, origin },
    redirect: "manual",
  });
const signIn = async (username: string): Promise<string> => {
  const response = await fetch(`${servers.url}/signin`, {
    method: "POST",
    body: new URLSearchParams({ username, password: "a-good-passphrase" }),
    redirect: "manual",
  });
  return `${(response.headers.get("set-cookie") ?? "").split(";")[0]!}; forge_mode=dev`;
};
const words = (html: string) => html.replace(/\s+/g, " ");

beforeAll(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "forge-egress-grants-"));
  app = createApp({ dataDir, port: 0, host: "forge.test" });
  servers = await serve(app);
  const make = async (username: string, adminIfFirst = false): Promise<User> => {
    const made = await createUser(app.db, {
      origin: "seed",
      trusted: true,
      username,
      email: `${username}@forge.local`,
      password: "a-good-passphrase",
      adminIfFirst,
    });
    if (!made.ok) throw new Error(made.error);
    return made.value;
  };
  ada = await make("ada", true);
  bob = await make("bob");
  cy = await make("cy");
  promote(app.db, cy);
  const made = await createRepo(app, cy, { name: "arm", visibility: "public", description: "" });
  if (!made.ok) throw new Error(String(made.error));
  repo = made.value;
  const committed = await commitToBranch(app, cy, repo, {
    message: "Ask for the arm",
    files: [{ path: "forge.json", content: FORGE_JSON }],
  });
  if (!committed.ok) throw new Error(JSON.stringify(committed.error));
  const row = insertApp(app.db, { repoId: repo.id, slug: "arm", access: "public" });
  if (!row.ok) throw new Error(row.error);
  adaCookie = await signIn("ada");
  cyCookie = await signIn("cy");
  adaToken = createToken(app.db, ada.id, "admin", "admin").token;
  bobToken = createToken(app.db, bob.id, "admin", "admin").token;
  cyToken = createToken(app.db, cy.id, "admin", "admin").token;
}, 60_000);

afterAll(async () => {
  servers?.stop();
  app?.close();
  if (dataDir) await rm(dataDir, { recursive: true, force: true });
});

describe("private destinations asked for", () => {
  test("only the exact host:port entries are listed, none granted yet", async () => {
    const view = await egressView(app, ada, repo);
    expect(view.ok && view.value.rows.map((r) => [r.destination, r.granted])).toEqual([
      [ARM, false],
      [CAMERA, false],
    ]);
  });

  test("a non-admin is refused, and the grants stay empty", async () => {
    // The repository's owner is no site admin: told so, nothing written.
    const viaAction = await grantAppEgress(app, cy, repo, ARM);
    expect(!viaAction.ok && viaAction.error).toBe("forbidden");
    expect((await api("POST", cyToken, ARM)).status).toBe(403);
    // A stranger to the repository learns nothing of it.
    expect((await api("POST", bobToken, ARM)).status).toBe(404);
    expect((await api("GET", bobToken)).status).toBe(404);
    const viaPage = await web(cyCookie, `/cy/arm/settings/app/egress/${encodeURIComponent(ARM)}/grant`);
    expect(viaPage.status).toBe(303);
    expect(listEgressGrants(app.db, repo.id)).toEqual([]);
    const revoked = revokeAppEgress(app, cy, repo, ARM);
    expect(!revoked.ok && revoked.error).toBe("forbidden");
  });

  test("a destination forge.json does not name is refused", async () => {
    for (const bad of [
      "100.89.95.68:22", // same host, another port
      "100.89.95.99:8101",
      "api.example.com:443", // forge.json names it without a port
      "100.89.95.0/24",
      "*.example.org:80",
      "169.254.169.254:80",
      "",
      "nonsense",
    ]) {
      const response = await api("POST", adaToken, bad);
      expect(`${bad}: ${response.status}`).toBe(`${bad}: 422`);
    }
    expect(listEgressGrants(app.db, repo.id)).toEqual([]);
  });

  test("an admin grants and the list and the page show it, with who and when", async () => {
    const response = await api("POST", adaToken, ` ${ARM.toUpperCase()} `);
    expect(response.status).toBe(201);
    expect(await response.json()).toMatchObject({ destination: ARM, granted: true, grantedBy: "ada" });
    expect(listEgressGrants(app.db, repo.id).map((g) => g.destination)).toEqual([ARM]);

    const listed = (await (await api("GET", adaToken)).json()) as {
      items: { destination: string; granted: boolean; grantedBy: string | null; grantedAt: string | null }[];
    };
    const arm = listed.items.find((i) => i.destination === ARM)!;
    expect([arm.granted, arm.grantedBy]).toEqual([true, "ada"]);
    expect(arm.grantedAt).not.toBeNull();
    expect(listed.items.find((i) => i.destination === CAMERA)!.granted).toBe(false);

    const adaPage = words(await (await web(adaCookie, "/cy/arm/settings/app")).text());
    expect(adaPage).toContain("Private destinations asked for");
    expect(adaPage).toContain(`/settings/app/egress/${encodeURIComponent(CAMERA)}/grant`);
    const revokeTo = `/cy/arm/settings/app/egress/${encodeURIComponent(ARM)}/revoke`;
    expect(adaPage).toContain(`/-/confirm?to=${encodeURIComponent(revokeTo)}`);
    const confirm = await web(adaCookie, `/-/confirm?to=${encodeURIComponent(revokeTo)}`);
    expect(confirm.status).toBe(200);
    expect(words(await confirm.text())).toContain("Revoke the app&#39;s grant on 100.89.95.68:8101");
    expect(adaPage).toContain("Granted by ada");
    expect(adaPage).toContain("ada granted");
    // Someone else who administers the repository sees who granted, and no buttons.
    const cyPage = words(await (await web(cyCookie, "/cy/arm/settings/app")).text());
    expect(cyPage).toContain("Granted by ada");
    expect(cyPage).not.toContain("/settings/app/egress/");
    expect(cyPage).not.toContain(">Grant<");
  });

  test("the section is a setting list: an outline Grant for a site admin, no buttons for anyone else", async () => {
    const section = async (cookie: string) => {
      const page = await (await web(cookie, "/cy/arm/settings/app")).text();
      const from = page.indexOf("Private destinations asked for");
      return page.slice(from, page.indexOf("</ul>", from));
    };
    const admin = await section(adaCookie);
    expect(admin).toContain('<ul class="list setting-list">');
    expect(admin).toContain('class="row-fields"');
    expect(admin).toMatch(/<button[^>]*data-variant="outline"[^>]*>\s*Grant\s*<\/button>/);
    expect(admin).toContain("Revoke");
    const owner = await section(cyCookie);
    expect(owner).toContain('<ul class="list setting-list">');
    expect(owner).toContain(CAMERA);
    expect(owner).not.toContain("Grant<");
    expect(owner).not.toContain("Revoke");
    expect(owner).not.toContain("/settings/app/egress/");
  });

  test("the page grants too, and refuses a foreign origin", async () => {
    const path = `/cy/arm/settings/app/egress/${encodeURIComponent(CAMERA)}/grant`;
    await web(adaCookie, path, "https://evil.example");
    expect(listEgressGrants(app.db, repo.id).map((g) => g.destination)).toEqual([ARM]);
    const granted = await web(adaCookie, path);
    expect(granted.status).toBe(303);
    expect(listEgressGrants(app.db, repo.id).map((g) => g.destination)).toEqual([ARM, CAMERA]);
  });

  test("a revoke removes the grant and is recorded with who", async () => {
    expect((await api("DELETE", adaToken, "100.89.95.68:9999")).status).toBe(422);
    expect((await api("DELETE", adaToken, ARM)).status).toBe(200);
    expect(listEgressGrants(app.db, repo.id).map((g) => g.destination)).toEqual([CAMERA]);
    const view = await egressView(app, ada, repo);
    expect(view.ok && view.value.rows.find((r) => r.destination === ARM)?.granted).toBe(false);
    const page = words(await (await web(adaCookie, "/cy/arm/settings/app")).text());
    expect(page).toContain("ada revoked");
    const kinds = listEvents(app.db, { repoId: repo.id, limit: 50 })
      .filter((e) => e.kind.startsWith("app.egress."))
      .map((e) => [e.kind, e.actorId, e.payload["destination"]]);
    expect(kinds).toContainEqual(["app.egress.revoked", ada.id, ARM]);
    expect(kinds).toContainEqual(["app.egress.granted", ada.id, ARM]);
    const verbs = listEvents(app.db, { repoId: repo.id, limit: 50 })
      .filter((e) => e.kind.startsWith("app.egress."))
      .map((e) => eventVerb(e));
    expect(verbs).toContain(`granted the app ${ARM}`);
    expect(verbs).toContain(`revoked the app's grant on ${ARM}`);
  });
});

describe("the egress section speaks the home page's language", () => {
  const section = async (cookie: string, path: string) => {
    const page = await (await web(cookie, path)).text();
    const from = page.indexOf('<section class="settings-block" id="egress">');
    expect(from).toBeGreaterThan(-1);
    return words(page.slice(from, page.indexOf("</section>", from)));
  };

  test("with destinations: a heading, the refusal sentence and rows, no card", async () => {
    const s = await section(adaCookie, "/cy/arm/settings/app");
    expect(s).toContain("<h2>Private destinations asked for</h2>");
    expect(s).toContain("every other host is refused");
    expect(s).not.toContain('class="card');
    expect(s).toContain(`/settings/app/egress/${encodeURIComponent(ARM)}/grant`);
  });

  test("with none asked for: one plain line, no list, no card", async () => {
    const made = await createRepo(app, cy, { name: "plain", visibility: "public", description: "" });
    if (!made.ok) throw new Error(String(made.error));
    const row = insertApp(app.db, { repoId: made.value.id, slug: "plain", access: "public" });
    if (!row.ok) throw new Error(row.error);
    const s = await section(adaCookie, "/cy/plain/settings/app");
    expect(s).toContain("This app reaches only the forge; every other host is refused.");
    expect(s).not.toContain('class="card');
    expect(s).not.toContain("setting-list");
    expect(s).not.toContain('data-tone="danger"');
  });
});
