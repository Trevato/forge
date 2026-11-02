/**
 * "New organization" in the terminal (#7260): `createOrg` through one field,
 * refused with MCP `org_create`'s words, and the new-repository screen then
 * offers the organization as an owner. A person's, never an agent's.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createOrgWords, type CreateOrgRefusal } from "../src/actions/orgs.ts";
import { createApp, type App } from "../src/app.ts";
import { getOrg } from "../src/core/orgs.ts";
import { createUser, type User } from "../src/core/users.ts";
import { tool as orgCreate } from "../src/http/mcp/tools/org_create.ts";
import { createForgeApp, forgeCommands, Session } from "../src/tui/forge.ts";
import { newOrgScreen } from "../src/tui/screens/neworg.ts";
import { newOrgSubmit } from "../src/web/pages/org.ts";
import { headlessTerminal } from "../src/tui/term/terminal.ts";
import { quietLogs } from "./helpers/globals.ts";
import { settleApp } from "./helpers/tui.ts";

quietLogs();

let dir: string;
let app: App;
let alice: User;
let unproven: User;
let robot: User;

const identity = (user?: User) => ({
  sshUsername: user?.username ?? "git",
  remoteAddress: "127.0.0.1",
  fingerprint: "SHA256:test",
  user,
});

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "forge-tui-neworg-"));
  app = createApp({ dataDir: dir, url: "https://forge.test", port: 0 });
  const made = await createUser(app.db, {
    origin: "seed",
    trusted: true,
    username: "alice",
    email: "alice@forge.local",
    password: "a-good-passphrase",
  });
  if (!made.ok) throw new Error(made.error);
  alice = made.value;
  const fresh = await createUser(app.db, {
    origin: "seed",
    username: "nell",
    email: "nell@forge.local",
    password: "a-good-passphrase",
  });
  if (!fresh.ok) throw new Error(fresh.error);
  unproven = fresh.value;
  const agent = await createUser(app.db, {
    origin: "agent",
    agent: true,
    username: "robo",
    email: "robo@forge.local",
  });
  if (!agent.ok) throw new Error(agent.error);
  robot = agent.value;
});
afterAll(async () => {
  app.db.close();
  await rm(dir, { recursive: true, force: true });
});

async function withScreen(
  user: User,
  body: (h: { text: () => string; feed: (s: string) => Promise<void> }) => Promise<void>,
) {
  const terminal = headlessTerminal(120, 30);
  const { app: tui, session } = createForgeApp(app, identity(user), { terminal, exitHooks: false });
  tui.start();
  tui.ctx.push(newOrgScreen(session, tui.ctx));
  try {
    await settleApp(tui);
    await body({
      text: () => tui.screen.toText(),
      feed: async (s) => {
        terminal.feed(s);
        await settleApp(tui);
      },
    });
  } finally {
    tui.stop?.();
  }
}

/** What MCP `org_create` answers for `name`, as `user` (alice by default). */
function mcpAnswer(name: string, user: User = alice): { error?: string; message?: string } {
  return orgCreate.run({ app } as never, user, { name }) as { error?: string; message?: string };
}
const mcpWords = (name: string, user?: User): string => mcpAnswer(name, user).message ?? "";

/** The page's answer to POST /organizations/new with `name`, as `user`. */
async function pageAnswer(name: string, user: User): Promise<{ status: number; body: string }> {
  const url = new URL("https://forge.test/organizations/new");
  const request = new Request(url.href, {
    method: "POST",
    headers: { origin: url.origin, "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ name }),
  });
  const res = await newOrgSubmit({
    app,
    request,
    url,
    params: {},
    auth: { user, scope: "rw", via: "session" },
    theme: undefined,
  } as never);
  return { status: res.status, body: await res.text() };
}

describe("the new organization screen", () => {
  test("the palette offers it to a signed-in person, and never to an agent or a guest", () => {
    const ids = (u?: User) => forgeCommands(new Session(app, identity(u)))({} as never).map((c) => c.id);
    expect(ids(alice)).toContain("new-org");
    expect(ids({ ...alice, kind: "agent" })).not.toContain("new-org");
    expect(ids()).not.toContain("new-org");
  });

  test("makes one, says where it lives, and the new-repository screen offers it as owner", () =>
    withScreen(alice, async ({ text, feed }) => {
      await feed("acme\r");
      expect(getOrg(app.db, "acme")).toBeDefined();
      expect(text()).toContain("Made acme. You are its first owner.");
      expect(text()).toContain("It lives at https://forge.test/acme.");
      await feed("n");
      expect(text()).toContain("Name (under acme)");
    }));

  test("a taken name is refused with MCP's words, nothing is made, and the name stays", () =>
    withScreen(alice, async ({ text, feed }) => {
      await feed("alice\r");
      expect(getOrg(app.db, "alice")).toBeUndefined();
      expect(text()).toContain(createOrgWords("name_taken"));
      expect(mcpWords("alice")).toBe(createOrgWords("name_taken"));
      await feed("-co");
      expect(text()).toContain("alice-co");
    }));

  test("a reserved name is refused with MCP's words, and nothing is made", () =>
    withScreen(alice, async ({ text, feed }) => {
      await feed("admin\r");
      expect(getOrg(app.db, "admin")).toBeUndefined();
      expect(text()).toContain(createOrgWords("name_reserved"));
      expect(mcpWords("admin")).toBe(createOrgWords("name_reserved"));
      expect(text()).toContain("admin");
    }));

  test("an invalid name is refused with MCP's words", () =>
    withScreen(alice, async ({ text, feed }) => {
      await feed("not valid!\r");
      expect(text()).toContain(createOrgWords("invalid_name"));
      expect(mcpWords("not valid!")).toBe(createOrgWords("invalid_name"));
    }));

  test("MCP's message is the sentence, never the bare code", () => {
    const answer = mcpAnswer("alice");
    expect(answer.error).toBe("name_taken");
    expect(answer.message).not.toBe("name_taken");
    expect(answer.message).toBe(createOrgWords("name_taken"));
  });

  const refused: [string, () => User, CreateOrgRefusal][] = [
    ["an unverified person", () => unproven, "unverified"],
    ["an agent", () => robot, "agent_cannot_own"],
  ];
  for (const [who, user, code] of refused)
    test(`${who} is told why by the page and by MCP, and nothing is made`, async () => {
      const name = `${code.replace(/_/g, "-")}-co`;
      const page = await pageAnswer(name, user());
      expect(page.status).toBe(422);
      expect(page.body).toContain(createOrgWords(code));
      expect(page.body).not.toContain("That name won't work.");
      const answer = mcpAnswer(name, user());
      expect(answer.error).toBe(code);
      expect(answer.message).toBe(createOrgWords(code));
      expect(getOrg(app.db, name)).toBeUndefined();
    });
});
