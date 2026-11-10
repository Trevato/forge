/**
 * A bearer token opens the preview of a repository its person may enter
 * (#7829): a crew run fetches its own pull's preview with the FORGE_TOKEN
 * it holds, no browser. A token that cannot read the repository learns
 * nothing; the token itself never reaches the app.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { openIssue } from "../src/actions/issues.ts";
import { newApp, updateAppSettings } from "../src/actions/apps.ts";
import { commitToBranch } from "../src/actions/repos.ts";
import type { App } from "../src/app.ts";
import { NOT_ENTITLED_WORDS } from "../src/apps/proxy.ts";
import type { AppRecord } from "../src/core/apps.ts";
import type { Repo } from "../src/core/repos.ts";
import { mintRunToken } from "../src/core/run_token.ts";
import { mintProposalToken } from "../src/core/proposal_token.ts";
import { mintViaToken } from "../src/core/via_token.ts";
import { createIssue } from "../src/core/issues.ts";
import { createToken } from "../src/core/tokens.ts";
import { createUser, type User } from "../src/core/users.ts";
import { systemPrompt, type BriefInput } from "../src/crew/brief.ts";
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

describe("a bearer token on an app's host", () => {
  let forge: AppsForge;
  let app: App;
  let alice: User;
  let bob: User;
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
    const made = await createUser(app.db, {
      origin: "seed",
      trusted: true,
      username: "bob",
      email: "bob@forge.local",
      password: "a-good-passphrase",
    });
    if (!made.ok) throw new Error(made.error);
    bob = made.value;
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
    updateAppSettings(app, alice, open.repo, { access: "private" });
  }, 120_000);

  afterAll(async () => {
    await forge.runtime.stop();
    await stopAppsForge(forge);
  });

  test("a reader's token sees the page; the token never reaches the app", async () => {
    const token = createToken(app.db, alice.id, "t", "ro").token;
    const res = await get(host(), token);
    expect(res.status).toBe(200);
    const heard = (await res.json()) as { page: string; authorization: string | null };
    expect(heard.page).toBe("secret page");
    expect(heard.authorization).toBeNull();
  });

  test("no token, a stranger's token and a made-up token get the plain 404", async () => {
    const stranger = createToken(app.db, bob.id, "t", "ro").token;
    for (const token of [undefined, stranger, "forge_nope"]) {
      const res = await get(host(), token);
      expect(res.status).toBe(404);
      expect(await res.text()).toBe("not found");
    }
  });

  test("a run token works on its own repository; an expired one does not", async () => {
    const live = mintRunToken(
      app.db,
      alice.id,
      "run1",
      { repoId: repo.id, forkId: repo.id },
      new Date(Date.now() + 3_600_000).toISOString(),
    ).token;
    expect((await get(host(), live)).status).toBe(200);
    const expired = mintRunToken(
      app.db,
      alice.id,
      "run2",
      { repoId: repo.id, forkId: repo.id },
      new Date(Date.now() - 1000).toISOString(),
    ).token;
    const res = await get(host(), expired);
    expect(res.status).toBe(404);
    expect(await res.text()).toBe("not found");
    // Bound to another repository, it opens nothing here.
    const elsewhere = mintRunToken(
      app.db,
      alice.id,
      "run3",
      { repoId: open.repo.id, forkId: open.repo.id },
      new Date(Date.now() + 3_600_000).toISOString(),
    ).token;
    expect((await get(host(), elsewhere)).status).toBe(404);
  });

  test("a proposal token and a conversation's token never enter an app as the writer who minted them", async () => {
    // A proposal token is a writer's rw token held by a child forge; a via
    // token is for /mcp alone. Neither is a person at an app's door.
    const proposal = mintProposalToken(app.db, alice.id, repo.id, { child: "kid", origin: "https://kid.test" });
    if (!proposal.ok) throw new Error(proposal.error);
    const via = mintViaToken(app.db, alice.id, "conversation:c1", "hi", new Date(Date.now() + 600_000).toISOString());
    if (!via.ok) throw new Error(via.error);
    for (const token of [proposal.value.token, via.value.token]) {
      const res = await get(host(), token);
      expect(res.status).toBe(404);
      expect(await res.text()).toBe("not found");
    }
  });

  test("a reader who may not enter is told what to do; a stranger is not", async () => {
    const lobby = `lobby.${forge.runtime.options.domain}`;
    const reader = createToken(app.db, bob.id, "t", "ro").token;
    for (const accept of ["application/json", "text/html"]) {
      const told = await get(lobby, reader, accept);
      expect(told.status).toBe(404);
      expect(await told.text()).toBe(NOT_ENTITLED_WORDS);
    }
    const none = await get(lobby);
    expect(await none.text()).toBe("not found");
  });

  test("a read-only token of a writer is a user in the app, and reads only", async () => {
    const ro = createToken(app.db, alice.id, "t", "ro").token;
    const rw = createToken(app.db, alice.id, "t", "rw").token;
    const roleOf = async (token: string) => {
      const res = await get(host(), token);
      const heard = (await res.json()) as { identity: string };
      return heard.identity.split("|")[2];
    };
    expect(await roleOf(ro)).toBe("user");
    expect(await roleOf(rw)).toBe("admin");
    const post = (token: string) =>
      fetchAsHost(forge.servers, host(), "/", {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, accept: "application/json" },
        body: "x",
      });
    expect((await post(ro)).status).toBe(403);
    expect((await post(rw)).status).toBe(200);
  });

  test("a token that cannot read gets the plain 404 on a page navigation, not a redirect or a hint", async () => {
    const stranger = createToken(app.db, bob.id, "t", "ro").token;
    const res = await get(host(), stranger, "text/html");
    expect(res.status).toBe(404);
    expect(res.headers.get("location")).toBeNull();
    expect(await res.text()).toBe("not found");
  });

  test("a sealed pull's preview on a public app admits a writer's token and tells a reader's why not", async () => {
    const plaza = await newApp(app, alice, {
      name: "plaza",
      description: "Public",
      visibility: "public",
    });
    if (!plaza.ok) throw new Error(String(plaza.error));
    const report = openIssue(app, alice, plaza.value.repo, {
      title: "Hole",
      sealed: true,
    });
    if (!report.ok) throw new Error(String(report.error));
    const sealed = createIssue(app.db, {
      repoId: plaza.value.repo.id,
      authorId: alice.id,
      title: "Fix",
      body: `Closes #${report.value.number}`,
      kind: "pull",
      sealed: true,
    });
    if (!sealed.ok) throw new Error("pull");
    const sealedHost = forge.runtime.hostFor(
      plaza.value.app.slug,
      `pull-${sealed.value.number}` as never,
    );
    const reader = createToken(app.db, bob.id, "t", "ro").token;
    const told = await get(sealedHost, reader);
    expect(told.status).toBe(404);
    expect(await told.text()).toBe(NOT_ENTITLED_WORDS);
    const writer = createToken(app.db, alice.id, "t", "ro").token;
    const past = await get(sealedHost, writer);
    expect(await past.text()).not.toBe(NOT_ENTITLED_WORDS);
  });

  test("the brief says how a run opens its preview", () => {
    const prompt = systemPrompt({
      agent: { user: { username: "bot", displayName: "" }, brief: "" },
      repo: { ownerName: "alice", name: "square", defaultBranch: "main" },
      issue: { number: 1 },
      branch: "bot/1",
      forgeUrl: "http://forge.test",
      isApp: true,
      previewUrl: "http://square--2.apps.test/",
    } as unknown as BriefInput);
    expect(prompt).toContain(
      'curl -H "authorization: Bearer $FORGE_TOKEN" http://square--2.apps.test/',
    );
  });

  test("a client that keeps presenting bad tokens is slowed down; a good token is not counted", async () => {
    let last = 0;
    for (let i = 0; i < 40; i++) {
      last = (await get(host(), `forge_bad${i}`)).status;
      if (last === 429) break;
    }
    expect(last).toBe(429);
    const res = await get(host(), "forge_more");
    expect(res.status).toBe(429);
    expect(Number(res.headers.get("retry-after"))).toBeGreaterThan(0);
  });
});
