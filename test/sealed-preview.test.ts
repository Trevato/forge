/**
 * A sealed report's fix is not served to strangers by its preview (#621).
 * On a public app, a pull's preview is normally anyone's to open; a sealed
 * pull's is held like a private app's — opened only through a grant, by
 * someone who may see the report, asked again on every request — and its
 * pictures are the writers'.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { newApp, openEnvUrl } from "../src/actions/apps.ts";
import { openIssue } from "../src/actions/issues.ts";
import { createApp, type App } from "../src/app.ts";
import { grantUrl } from "../src/apps/proxy.ts";
import { AppsRuntime } from "../src/apps/runtime.ts";
import type { AppRecord } from "../src/core/apps.ts";
import type { Look } from "../src/core/looks.ts";
import { createIssue } from "../src/core/issues.ts";
import { getRepoById, type Repo } from "../src/core/repos.ts";
import { createUser, type User } from "../src/core/users.ts";
import type { Ctx } from "../src/http/context.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { mayFetchLook } from "../src/web/pages/looks.ts";
import { quietLogs } from "./helpers/globals.ts";

quietLogs();

const DOMAIN = "apps.test";

let dataDir: string;
let app: App;
let servers: Servers;
let runtime: AppsRuntime;
let alice: User;
let carol: User;
let record: AppRecord;
let sealedEnv = "";
let openEnv = "";

const repo = (): Repo => getRepoById(app.db, record.repoId)!;

/** Ask the app host for `/` as a script would, carrying `cookie`. */
const knock = (host: string, cookie = "") =>
  fetch(`${servers.url}/`, {
    headers: {
      host,
      accept: "application/json",
      ...(cookie ? { cookie } : {}),
    },
    redirect: "manual",
  });

/** The grant cookie a signed grant URL sets on the app host. */
const cookieFrom = async (link: string): Promise<string> => {
  const url = new URL(link);
  const res = await fetch(`${servers.url}${url.pathname}${url.search}`, {
    headers: { host: url.host },
    redirect: "manual",
  });
  return (res.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
};

beforeAll(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "forge-sealed-preview-"));
  app = createApp({ dataDir, port: 0, host: "forge.test" });
  servers = await serve(app);
  runtime = new AppsRuntime(app, {
    domain: DOMAIN,
    scheme: "http",
    publicPort: servers.port,
    forgeUrl: servers.url,
    concurrency: 1,
  });
  await runtime.start();
  for (const [username, first] of [
    ["alice", true],
    ["carol", false],
  ] as const) {
    const made = await createUser(app.db, {
      origin: "seed",
      trusted: true,
      username,
      email: `${username}@forge.local`,
      password: "a-good-passphrase",
      adminIfFirst: first,
    });
    if (!made.ok) throw new Error(made.error);
    if (username === "alice") alice = made.value;
    else carol = made.value;
  }
  const made = await newApp(app, alice, {
    name: "square",
    description: "A public app",
    visibility: "public",
  });
  if (!made.ok) throw new Error(String(made.error));
  record = made.value.app;
  expect(record.access).toBe("public");
  // A sealed report and the pull row that fixes it, and an ordinary pull.
  const report = openIssue(app, alice, repo(), { title: "Hole", sealed: true });
  if (!report.ok) throw new Error(String(report.error));
  const sealed = createIssue(app.db, {
    repoId: repo().id,
    authorId: alice.id,
    title: "Fix",
    body: `Closes #${report.value.number}`,
    kind: "pull",
    sealed: true,
  });
  const open = createIssue(app.db, {
    repoId: repo().id,
    authorId: alice.id,
    title: "Public work",
    kind: "pull",
  });
  if (!sealed.ok || !open.ok) throw new Error("pulls");
  sealedEnv = `pull-${sealed.value.number}`;
  openEnv = `pull-${open.value.number}`;
}, 120_000);

afterAll(async () => {
  await runtime.stop();
  servers.stop();
  app.close();
  await rm(dataDir, { recursive: true, force: true });
});

describe("a sealed pull's preview on a public app", () => {
  test("opening it is refused to a reader and to nobody; a writer is given a grant", () => {
    for (const who of [carol, undefined]) {
      const opened = openEnvUrl(app, who, repo(), sealedEnv);
      expect(opened.ok).toBe(false);
      if (!opened.ok) expect(opened.error).toBe("not_found");
    }
    const writer = openEnvUrl(app, alice, repo(), sealedEnv);
    expect(writer.ok).toBe(true);
    if (writer.ok) expect(writer.value).toContain("/__forge/grant");
    // An ordinary pull's preview stays open to anyone, as before.
    expect(openEnvUrl(app, undefined, repo(), openEnv).ok).toBe(true);
  });

  test("its host answers a stranger and a reader's old grant with the gate's 404", async () => {
    const host = runtime.hostFor(record.slug, sealedEnv as never);
    // The gate's own answer, before anything about the preview is said.
    const gated = async (cookie = "") => {
      const res = await knock(host, cookie);
      return { status: res.status, text: await res.text() };
    };
    expect(await gated()).toEqual({ status: 404, text: "not found" });
    // A grant naming the reader, minted before the pull was sealed, is asked
    // again on every request and admits nobody.
    const minted = grantUrl(
      runtime,
      { app: record, env: sealedEnv as never },
      "/",
      host,
      { id: carol.id, name: carol.username, role: "user" },
    );
    const readerCookie = await cookieFrom(minted);
    expect(readerCookie).not.toBe("");
    expect(await gated(readerCookie)).toEqual({ status: 404, text: "not found" });
    // The writer's grant gets past the gate, to the preview's own answer
    // (none is deployed here).
    const writer = openEnvUrl(app, alice, repo(), sealedEnv);
    if (!writer.ok) throw new Error(writer.error);
    const past = await gated(await cookieFrom(writer.value));
    expect(past.text).not.toBe("not found");
    // An ordinary pull's preview is not held at the gate at all.
    const open = await knock(runtime.hostFor(record.slug, openEnv as never));
    expect(await open.text()).not.toBe("not found");
  });

  test("its pictures are the writers'", () => {
    const look = {
      id: "l1",
      appId: record.id,
      env: sealedEnv,
      commitOid: "a".repeat(40),
      page: "/",
      kind: "thumb",
      path: "",
      createdAt: new Date().toISOString(),
      error: null,
      takenAs: "nobody",
    } as unknown as Look;
    const ctxOf = (user: User | undefined) =>
      ({ app, auth: { user } }) as unknown as Ctx;
    expect(mayFetchLook(ctxOf(carol), repo(), record, look)).toBe(false);
    expect(mayFetchLook(ctxOf(undefined), repo(), record, look)).toBe(false);
    expect(mayFetchLook(ctxOf(alice), repo(), record, look)).toBe(true);
  });
});
