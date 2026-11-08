/**
 * A repository's Findings page speaks the home page's language (#9869): the
 * list is a plain `<section>` under one `<h2>`, no card; with none, one plain
 * sentence. Accept-with-reason is there for a writer and absent for a reader,
 * and the matched text is never drawn.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRepo } from "../src/actions/repos.ts";
import { createApp, type App } from "../src/app.ts";
import { secretFindings } from "../src/checks/scan_rules.ts";
import { recordFindings } from "../src/checks/scan_store.ts";
import { createUser, type User } from "../src/core/users.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { quietLogs } from "./helpers/globals.ts";

quietLogs();

const AWS = "AKIA" + "QX7Z".repeat(4);

describe("findings page shape", () => {
  let dir: string;
  let forge: App;
  let servers: Servers;
  let adaCookie = "";
  let eveCookie = "";

  const signIn = async (username: string): Promise<string> => {
    const res = await fetch(`${servers.url}/signin`, {
      method: "POST",
      body: new URLSearchParams({ username, password: "a-good-passphrase" }),
      redirect: "manual",
    });
    return (res.headers.get("set-cookie") ?? "").split(";")[0]!;
  };
  const get = async (path: string, cookie: string): Promise<string> =>
    (await fetch(`${servers.url}${path}`, { headers: cookie ? { cookie } : {} })).text();
  const main = (page: string): string => page.slice(page.indexOf("<main"), page.indexOf("</main>"));

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "forge-findings-language-"));
    forge = createApp({ dataDir: dir, port: 0 });
    servers = await serve(forge);
    const make = async (username: string, adminIfFirst: boolean): Promise<User> => {
      const made = await createUser(forge.db, { origin: "seed", trusted: true, username, email: `${username}@forge.local`, password: "a-good-passphrase", adminIfFirst });
      if (!made.ok) throw new Error(made.error);
      return made.value;
    };
    const ada = await make("ada", true);
    await make("eve", false);
    for (const name of ["arm", "calm"]) {
      const made = await createRepo(forge, ada, { name, owner: "ada", visibility: "public", description: "" });
      if (!made.ok) throw new Error(JSON.stringify(made.error));
      if (name === "arm") recordFindings(forge.db, made.value.id, "a".repeat(40), secretFindings("deploy.ts", `const k = "${AWS}";\n`));
    }
    adaCookie = await signIn("ada");
    eveCookie = await signIn("eve");
  }, 60_000);
  afterAll(async () => {
    servers?.stop();
    forge?.close();
    await rm(dir, { recursive: true, force: true });
  });

  test("the list is a section under one h2, with no card", async () => {
    const body = main(await get("/ada/arm/findings", adaCookie));
    expect(body).toContain("deploy.ts:1");
    expect(body).not.toContain('class="card');
    expect(body.match(/<h2[\s>]/g)?.length).toBe(1);
    expect(body).toMatch(/<section[^>]*>\s*<h2>Findings<\/h2>/);
    expect(body).not.toContain(AWS.slice(4));
  });

  test("a writer sees accept-with-reason; a reader does not", async () => {
    expect(main(await get("/ada/arm/findings", adaCookie))).toContain("/ada/arm/findings/");
    const reader = main(await get("/ada/arm/findings", eveCookie));
    expect(reader).toContain("deploy.ts:1");
    expect(reader).not.toContain("/accept");
    expect(reader).not.toContain("Why it may stand");
  });

  test("with none, one plain sentence and no box", async () => {
    const body = main(await get("/ada/calm/findings", adaCookie));
    expect(body).toContain("Nothing found.");
    expect(body).not.toContain('class="card');
    expect(body).not.toContain('<ul class="list"');
  });
});
