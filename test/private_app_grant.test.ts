/**
 * A crew run's token at a private app's door (#11789): it enters as a plain user,
 * reads with GET and HEAD only, reaches only the app of the repository or fork the
 * run was minted for, and stops working when the run ends. The brief says so.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { newApp, updateAppSettings } from "../src/actions/apps.ts";
import { commitToBranch } from "../src/actions/repos.ts";
import type { App } from "../src/app.ts";
import type { AppRecord } from "../src/core/apps.ts";
import type { Repo } from "../src/core/repos.ts";
import { mintRunToken } from "../src/core/run_token.ts";
import { deleteToken } from "../src/core/tokens.ts";
import type { OwnApp } from "../src/crew/app_hosts.ts";
import { type User } from "../src/core/users.ts";
import { ownAppLines } from "../src/crew/brief.ts";
import {
  deploySettled,
  fetchAsHost,
  startAppsForge,
  stopAppsForge,
  type AppsForge,
} from "./helpers/apps-forge.ts";

const SERVER_SUITES = [
  "src/audit.test.ts",
  "src/openapi.test.ts",
  "src/security.test.ts",
  "src/site.test.ts",
];

describe("a run's read-only grant to a private app", () => {
  let forge: AppsForge;
  let app: App;
  let alice: User;

  let repo: Repo;
  let record: AppRecord;
  let open: { repo: Repo; record: AppRecord };
  const host = () => `vault.${forge.runtime.options.domain}`;
  const get = (h: string, token?: string, accept = "application/json") =>
    fetchAsHost(forge.servers, h, "/", {
      headers: {
        accept,
        ...(token === undefined ? {} : { authorization: `Bearer ${token}` }),
      },
    });

  beforeAll(async () => {
    forge = await startAppsForge();
    ({ app, alice } = forge);
    const vault = await newApp(app, alice, {
      name: "vault",
      description: "Private",
      visibility: "private",
    });
    if (!vault.ok) throw new Error(String(vault.error));
    ({ repo, app: record } = vault.value);
    expect(record.access).toBe("private");
    await deploySettled(app, repo.id, (r) => r.env === "production");
    const committed = await commitToBranch(app, alice, repo, {
      message: "Echo the request",
      files: [
        ...SERVER_SUITES.map((path) => ({ path, content: null })),
        {
          path: "src/server.test.ts",
          content:
            'import { expect, test } from "bun:test";\ntest("passes", () => { expect(1).toBe(1); });\n',
        },
        {
          path: "src/server.ts",
          content: `Bun.serve({
  port: Number(process.env.PORT),
  hostname: "127.0.0.1",
  fetch(request) {
    return Response.json({
      page: "secret page",
      authorization: request.headers.get("authorization"),
      identity: request.headers.get("x-forge-identity"),
    });
  },
});
`,
        },
      ],
    });
    if (!committed.ok) throw new Error(JSON.stringify(committed.error));
    const run = await deploySettled(
      app,
      repo.id,
      (r) => r.env === "production" && r.commitOid === committed.value.commitOid,
    );
    if (run.state !== "ok") throw new Error(run.summary);
    // A public repository whose app is private: its readers may read the code, not enter.
    const second = await newApp(app, alice, {
      name: "lobby",
      description: "Public code",
      visibility: "public",
    });
    if (!second.ok) throw new Error(String(second.error));
    open = { repo: second.value.repo, record: second.value.app };
    const closed = updateAppSettings(app, alice, open.repo, { access: "private" });
    if (!closed.ok) throw new Error(String(closed.error));
  }, 120_000);

  afterAll(async () => {
    await forge.runtime.stop();
    await stopAppsForge(forge);
  });

  const run = (id: string, repoId: string, expires = Date.now() + 3_600_000) =>
    mintRunToken(app.db, alice.id, id, { repoId, forkId: repoId }, new Date(expires).toISOString());

  test("a run's token opens the private app's pages, as a user", async () => {
    const res = await get(host(), run("g1", repo.id).token);
    expect(res.status).toBe(200);
    const heard = (await res.json()) as { page: string; identity: string };
    expect(heard.page).toBe("secret page");
    expect(heard.identity.split("|")[2]).toBe("user");
  });

  test("it refuses every mutation", async () => {
    const t = run("g2", repo.id).token;
    for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
      const res = await fetchAsHost(forge.servers, host(), "/", {
        method,
        headers: { authorization: `Bearer ${t}`, accept: "application/json" },
        body: method === "DELETE" ? null : "x",
      });
      expect(res.status).toBe(403);
    }
  });

  test("it is refused for another app", async () => {
    const t = run("g3", open.repo.id).token;
    expect((await get(host(), t)).status).toBe(404);
  });

  test("it is refused after the run ends", async () => {
    const minted = run("g4", repo.id);
    expect((await get(host(), minted.token)).status).toBe(200);
    deleteToken(app.db, alice.id, minted.id);
    expect((await get(host(), minted.token)).status).toBe(404);
    expect((await get(host(), run("g5", repo.id, Date.now() - 1000).token)).status).toBe(404);
  });

  test("the brief says the app is private and the token read-only", () => {
    const own: OwnApp = { production: "http://vault.apps.test/", previews: [], access: "private" };
    const lines = ownAppLines(own).join("\n");
    expect(lines).toContain("This app is private");
    expect(lines).toContain("read-only");
    expect(lines).toContain("stops working when your run ends");
  });
});
