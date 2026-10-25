/**
 * Apps: who the app is told is asking, and a deploy that never answers.
 * Starts from `hello` serving in production (`helpers/apps-forge.ts`);
 * split from `apps.test.ts` so each part runs apart (#1798).
 */

import { createHmac } from "node:crypto";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { App } from "../src/app.ts";
import { AppsRuntime } from "../src/apps/runtime.ts";
import { openEnvUrl } from "../src/actions/apps.ts";
import { setIssueState } from "../src/actions/issues.ts";
import { openPull } from "../src/actions/pulls.ts";
import { commitToBranch } from "../src/actions/repos.ts";
import type { AppRecord } from "../src/core/apps.ts";
import { listEvents } from "../src/core/events.ts";
import type { Repo } from "../src/core/repos.ts";
import type { Run } from "../src/core/runs.ts";
import type { User } from "../src/core/users.ts";
import type { Servers } from "../src/http/server.ts";

import { identityKey } from "../src/apps/proxy.ts";
/** The scaffold's suites that boot its real `serve`: a test that swaps in a toy server drops them. */
const SERVER_SUITES = [
  "src/audit.test.ts",
  "src/openapi.test.ts",
  "src/security.test.ts",
  "src/site.test.ts",
];
import {
  APPS_DOMAIN,
  deploySettled,
  fetchAsHost,
  startAppsForge,
  startHello,
  stopAppsForge,
  type AppsForge,
} from "./helpers/apps-forge.ts";

describe("apps: identity, and a deploy that never answers", () => {
  let forge: AppsForge;
  let dataDir: string;
  let app: App;
  let servers: Servers;
  let runtime: AppsRuntime;
  let alice: User;
  let repo: Repo;
  let record: AppRecord;
  const DOMAIN = APPS_DOMAIN;

  const viaHost = (host: string, path = "/", init: RequestInit = {}) =>
    fetchAsHost(servers, host, path, init);

  /** Wait for the newest run matching `where` to finish, and return it. */
  const settled = (where: (run: Run) => boolean, timeoutMs?: number) =>
    deploySettled(app, repo.id, where, timeoutMs);

  const latest = (env: string) => (run: Run) => run.env === env;

  beforeAll(async () => {
    forge = await startAppsForge();
    ({ dataDir, app, servers, runtime, alice } = forge);
    ({ repo, record } = await startHello(forge));
    // Where `apps.test.ts`'s require_checks test leaves main: the app's own
    // server test is one that passes whatever the server is, so the toy
    // server the identity test deploys gets through its tests.
    const passing = await commitToBranch(app, alice, repo, {
      message: "Fix the test",
      files: [
        {
          path: "src/server.test.ts",
          content:
            'import { expect, test } from "bun:test";\ntest("passes", () => { expect(1).toBe(1); });\n',
        },
      ],
    });
    if (!passing.ok) throw new Error(JSON.stringify(passing.error));
    const deployed = await settled(
      (r) => r.env === "production" && r.commitOid === passing.value.commitOid,
    );
    if (deployed.state !== "ok") throw new Error(deployed.summary);
  }, 60_000);

  afterAll(async () => {
    await runtime.stop();
    await stopAppsForge(forge);
  });

  test("identity: a granted person is named to the app, signed with the app's key; a client's own claim is dropped; the two doors work", async () => {
    // An app that says who it hears.
    const committed = await commitToBranch(app, alice, repo, {
      message: "Echo who is here",
      files: [
        // The app's own suites that boot its real server go with it.
        ...SERVER_SUITES.map((path) => ({ path, content: null })),
        {
          path: "src/server.ts",
          content: `Bun.serve({
  port: Number(process.env.PORT),
  hostname: "127.0.0.1",
  fetch(request) {
    return Response.json({
      identity: request.headers.get("x-forge-identity"),
      signature: request.headers.get("x-forge-signature"),
      key: process.env.FORGE_APP_IDENTITY_KEY ?? "",
    });
  },
});
`,
        },
      ],
    });
    expect(committed.ok).toBe(true);
    if (!committed.ok) return;
    const run = await settled(
      (r) =>
        r.env === "production" && r.commitOid === committed.value.commitOid,
    );
    expect(run.state).toBe("ok");

    const link = openEnvUrl(app, alice, repo, "production", "/who");
    expect(link.ok).toBe(true);
    if (!link.ok) return;
    const url = new URL(link.value);
    const granted = await viaHost(url.host, `${url.pathname}${url.search}`);
    expect(granted.status).toBe(303);
    expect(granted.headers.get("location")).toBe("/who");
    const cookie = (granted.headers.get("set-cookie") ?? "").split(";")[0]!;

    // Named, and the signature verifies under the key the app was given.
    const heard = (await (
      await viaHost(`hello.${DOMAIN}`, "/who", {
        headers: {
          cookie,
          // A client's own claim never reaches the app.
          "x-forge-identity": "evil|mallory|admin|9999999999999",
          "x-forge-signature": "AAAA",
        },
      })
    ).json()) as { identity: string; signature: string; key: string };
    expect(heard.key).toBe(identityKey(dataDir, record.id));
    const [id, name, role, expires] = heard.identity.split("|");
    expect(id).toBe(alice.id);
    expect(name).toBe("alice");
    expect(role).toBe("admin"); // alice can write the repository
    expect(Number(expires)).toBeGreaterThan(Date.now());
    const expected = createHmac("sha256", heard.key)
      .update(heard.identity)
      .digest("base64url");
    expect(heard.signature).toBe(expected);

    // The doors: sign in goes to the forge and comes back to the page
    // asked for; sign out drops the grant.
    const signin = await viaHost(
      `hello.${DOMAIN}`,
      "/__forge/signin?to=/who%3Fq%3D1",
    );
    expect(signin.status).toBe(303);
    const open = new URL(signin.headers.get("location") ?? "");
    expect(open.pathname).toBe("/apps/open");
    expect(open.searchParams.get("host")).toBe(`hello.${DOMAIN}`);
    expect(open.searchParams.get("to")).toBe("/who?q=1");
    const signout = await viaHost(
      `hello.${DOMAIN}`,
      "/__forge/signout?to=//evil",
      {
        headers: { cookie },
      },
    );
    expect(signout.status).toBe(303);
    expect(signout.headers.get("location")).toBe("/");
    expect(signout.headers.get("set-cookie") ?? "").toContain("Max-Age=0");
  }, 90_000);

  test("a deploy that never answers leaves servingAt null", async () => {
    const committed = await commitToBranch(app, alice, repo, {
      branch: "never-answers",
      base: repo.defaultBranch,
      message: "Never answers",
      files: [
        {
          path: "forge.json",
          content: `${JSON.stringify(
            { app: { run: "sleep 30", health: "/", ready: 1 } },
            null,
            2,
          )}\n`,
        },
      ],
    });
    expect(committed.ok).toBe(true);
    if (!committed.ok) return;
    const opened = await openPull(app, alice, repo, {
      title: "Never answers",
      baseBranch: repo.defaultBranch,
      headBranch: "never-answers",
    });
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;

    const failed = await settled(latest(`pull-${opened.value.number}`));
    expect(failed.state).toBe("failed");
    expect(failed.servingAt).toBeNull();
    // It never swapped in, so it never published the event a look is
    // taken from — the same reason it is pictureless.
    expect(
      listEvents(app.db, { repoId: repo.id, limit: 200 }).some(
        (e) =>
          e.kind === "app.serving" &&
          e.payload["env"] === `pull-${opened.value.number}`,
      ),
    ).toBe(false);

    // Close it — a pull that never comes up is not this test's to leave
    // open for the next one, which counts what git still has open.
    expect(setIssueState(app, alice, repo, opened.value, "closed").ok).toBe(
      true,
    );
  }, 20_000);
});
