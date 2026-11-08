/**
 * A token that lacks a scope is told which one, in the words of the page
 * that makes tokens; the token form says what a token needs, and links to
 * that page with the scopes already chosen.
 *
 * Forgejo answers a missing scope with a 403 whose body names it
 * (`token does not have at least one of required scope(s): [read:user]`).
 * Read as a bare "forbidden" that became "That token was refused by the
 * origin", and a person could not tell a wrong token from a narrow one.
 */

import { everyoneIsAMember } from "./helpers/members.ts";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { connectOrigin } from "../src/actions/origins.ts";
import { listOrigins } from "../src/core/origins.ts";
import { createSession } from "../src/core/sessions.ts";
import { createUser, type User } from "../src/core/users.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { missingScopes, scopeWords } from "../src/origins/providers/http.ts";
import { forgetProviders } from "../src/origins/providers/index.ts";
import { quietLogs } from "./helpers/globals.ts";
import { newFakeState, serveFakeForge, type FakeForge } from "./fake-origin.ts";

quietLogs();

const TOKEN = "octo-scope-words-token";

describe("a scope refusal, read", () => {
  test("Forgejo's 403 names the scopes; anything else names none", () => {
    expect(
      missingScopes(
        '{"message":"token does not have at least one of required scope(s): [read:user]"}',
      ),
    ).toEqual(["read:user"]);
    expect(
      missingScopes("required scope(s): [read:issue write:issue, <script>]"),
    ).toEqual(["read:issue", "write:issue"]);
    expect(missingScopes('{"message":"forbidden"}')).toEqual([]);
    expect(missingScopes("")).toEqual([]);
  });

  test("scopes in the token page's words", () => {
    expect(scopeWords(["read:user"])).toBe("User: Read");
    expect(scopeWords(["write:issue"])).toBe("Issue: Read and write");
    expect(scopeWords(["read:repository", "read:organization"])).toBe(
      "Repository: Read or Organization: Read",
    );
  });
});

describe("connecting with a token that lacks a scope", () => {
  let dir: string;
  let app: App;
  let servers: Servers;
  let fake: FakeForge;
  let user: User;
  let cookie = "";

  beforeAll(async () => {
    fake = serveFakeForge(newFakeState("forgejo", "octo", TOKEN));
    dir = await mkdtemp(join(tmpdir(), "forge-token-scopes-"));
    app = createApp({ dataDir: dir, port: 0 });
    everyoneIsAMember(app.db);
    servers = await serve(app);
    const made = await createUser(app.db, {
      username: "ada",
      email: "ada@forge.test",
      password: "a-long-token-passphrase",
      origin: "seed",
      trusted: true,
    });
    if (!made.ok) throw new Error(made.error);
    user = made.value;
    cookie = `forge_session=${createSession(app.db, user.id).token}`;
  });

  afterAll(async () => {
    fake.stop();
    servers.stop();
    app.close();
    forgetProviders(dir);
    await rm(dir, { recursive: true, force: true });
  });

  test("is told which scope, and nothing is stored", async () => {
    fake.state.userScopeMissing = "read:user";
    const refused = await connectOrigin(app, user, { host: fake.url, token: TOKEN });
    delete fake.state.userScopeMissing;
    if (refused.ok || typeof refused.error === "string")
      throw new Error("not a scope refusal");
    expect(refused.error.error).toBe("missing_scopes");
    expect(refused.error.message).toContain("This token is missing User: Read.");
    expect(listOrigins(app.db, user.id)).toHaveLength(0);
  });

  test("the API says the same, as a code a client can branch on", async () => {
    fake.state.userScopeMissing = "read:user";
    const response = await fetch(`${servers.url}/api/v1/user/origins`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        cookie,
        origin: new URL(servers.url).origin,
      },
      body: JSON.stringify({ host: fake.url, token: TOKEN }),
    });
    delete fake.state.userScopeMissing;
    expect(response.status).toBe(422);
    const body = (await response.json()) as { error: string; message: string };
    expect(body.error).toBe("missing_scopes");
    expect(body.message).toContain("User: Read");
    expect(JSON.stringify(body)).not.toContain(TOKEN);
  });

  test("the token form says what a token needs, and links to a prefilled one", async () => {
    const page = await (
      await fetch(`${servers.url}/settings/origins?host=${encodeURIComponent(fake.url)}`, {
        headers: { cookie },
      })
    ).text();
    expect(page).toContain("Repository: Read and write");
    expect(page).toContain(
      `${fake.url}/user/settings/applications/tokens/new?name=forge&amp;resource=all&amp;scope=read:user&amp;scope=write:repository&amp;scope=write:issue`,
    );
  });
});
