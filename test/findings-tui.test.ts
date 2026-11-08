/**
 * Findings in the terminal (#9593): the page's list and its acceptance, from
 * the same reads and the same action. A guest sees nothing of a private
 * repository, a reader is refused the accept, and a writer's acceptance
 * shows on the web page.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRepo } from "../src/actions/repos.ts";
import { createApp, type App as Forge } from "../src/app.ts";
import { secretFindings } from "../src/checks/scan_rules.ts";
import { listFindings, recordFindings } from "../src/checks/scan_store.ts";
import type { Repo } from "../src/core/repos.ts";
import { createUser, type User } from "../src/core/users.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { createForgeApp } from "../src/tui/forge.ts";
import type { TuiIdentity } from "../src/tui/session.ts";
import { headlessTerminal } from "../src/tui/term/terminal.ts";
import { quietLogs } from "./helpers/globals.ts";
import { settleApp } from "./helpers/tui.ts";

quietLogs();

const AWS = "AKIA" + "QX7Z".repeat(4);

describe("findings in the terminal", () => {
  let dir: string;
  let forge: Forge;
  let servers: Servers;
  let ada: User;
  let eve: User;
  let arm: Repo;
  let vault: Repo;

  function boot(user: User | undefined) {
    const terminal = headlessTerminal(120, 32);
    const identity: TuiIdentity = { sshUsername: "t", remoteAddress: "127.0.0.1", user };
    const { app } = createForgeApp(forge, identity, { terminal, exitHooks: false });
    app.start();
    const key = (k: string) => app.dispatch({ type: "key", key: k, ctrl: false, alt: false, shift: false });
    const type = async (text: string) => {
      for (const ch of text) key(ch);
      await settleApp(app);
    };
    const open = async (name: string) => {
      await settleApp(app);
      app.dispatch({ type: "key", key: "k", ctrl: true, alt: false, shift: false });
      await settleApp(app);
      await type("Findings in a repository");
      key("enter");
      await settleApp(app);
      await type(name);
      key("enter");
      await settleApp(app);
    };
    const press = async (k: string) => {
      key(k);
      await settleApp(app);
    };
    return { text: () => app.screen.toText(), open, type, press, stop: () => app.stop() };
  }

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "forge-findings-tui-"));
    forge = createApp({ dataDir: dir, port: 0 });
    servers = await serve(forge);
    const make = async (username: string, adminIfFirst: boolean): Promise<User> => {
      const made = await createUser(forge.db, { origin: "seed", trusted: true, username, email: `${username}@forge.local`, password: "a-good-passphrase", adminIfFirst });
      if (!made.ok) throw new Error(made.error);
      return made.value;
    };
    ada = await make("ada", true);
    eve = await make("eve", false);
    const mk = async (name: string, visibility: "public" | "private"): Promise<Repo> => {
      const made = await createRepo(forge, ada, { name, owner: "ada", visibility, description: "" });
      if (!made.ok) throw new Error(JSON.stringify(made.error));
      return made.value;
    };
    arm = await mk("arm", "public");
    vault = await mk("vault", "private");
    for (const r of [arm, vault]) recordFindings(forge.db, r.id, "a".repeat(40), secretFindings("deploy.ts", `const k = "${AWS}";\n`));
  }, 60_000);
  afterAll(async () => {
    servers?.stop();
    forge?.close();
    await rm(dir, { recursive: true, force: true });
  });

  test("a guest sees nothing of a private repository's findings", async () => {
    const guest = boot(undefined);
    await guest.open("ada/vault");
    expect(guest.text()).not.toContain("AWS access key");
    expect(guest.text()).not.toContain("deploy.ts");
    guest.stop();
    // The door is open to a guest where the page is: a public repository's list.
    const passer = boot(undefined);
    await passer.open("ada/arm");
    expect(passer.text()).toContain("AWS access key");
    passer.stop();
  });

  test("a reader sees the list without the match, and is refused the accept", async () => {
    const reader = boot(eve);
    await reader.open("ada/arm");
    expect(reader.text()).toContain("AWS access key");
    expect(reader.text()).toContain("deploy.ts:1");
    expect(reader.text()).not.toContain(AWS.slice(4));
    await reader.press("a");
    expect(reader.text()).toContain("Only a person with write access accepts a finding.");
    expect(listFindings(forge.db, arm.id)[0]!.accepted).toBeNull();
    reader.stop();
  });

  test("a writer accepts with a reason, a blank reason is refused, and the page shows it", async () => {
    const writer = boot(ada);
    await writer.open("ada/arm");
    await writer.press("a");
    await writer.press("enter");
    expect(writer.text()).toContain("Say why it may stand");
    await writer.type("Rotated in the vault");
    await writer.press("enter");
    expect(listFindings(forge.db, arm.id)[0]!.accepted).toMatchObject({ by: "ada", reason: "Rotated in the vault" });
    expect(writer.text()).toContain("accepted by ada: Rotated in the vault");
    writer.stop();
    const page = await (await fetch(`${servers.url}/ada/arm/findings`)).text();
    expect(page).toContain("accepted by ada");
    expect(page).toContain("Rotated in the vault");
  });
});
