/**
 * `C` on the About card (#7443): the repository's crew, from the terminal.
 * The admin puts an agent on with `a` and a confirm, and Settings › Crew's
 * read sees it; `d` and a confirm take it off. Cancelling changes nothing,
 * and a person's name is refused in Settings › Crew's words. A reader sees
 * the list and is offered no key that changes it.
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { addToCrew, createAgent } from "../src/actions/crew.ts";
import { CREW_NO_SUCH_AGENT, CREW_NOT_AN_AGENT, crewRefusal } from "../src/actions/crew_words.ts";
import { createUser } from "../src/core/users.ts";
import { createRepo } from "../src/actions/repos.ts";
import { signUp } from "../src/actions/users.ts";
import { createApp, type App as Forge } from "../src/app.ts";
import { isCrew, listCrewRoles } from "../src/core/agents.ts";
import type { Repo } from "../src/core/repos.ts";
import type { User } from "../src/core/users.ts";
import { createForgeApp } from "../src/tui/forge.ts";
import { aboutScreen } from "../src/tui/screens/about.ts";
import { headlessTerminal } from "../src/tui/term/terminal.ts";
import { localSource } from "../src/view/local.ts";
import { quietLogs } from "./helpers/globals.ts";
import { settleApp } from "./helpers/tui.ts";
import { fixtureSlot } from "./helpers/slot.ts";
import { seedAdmin } from "./helpers/admin.ts";

quietLogs();

let dir: string;
let forge: Forge;
let alice: User;
let bob: User;
let bolt: User;
let repo: Repo;

const LEFT = "left";

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "forge-tui-crew-"));
  forge = createApp({ dataDir: dir, port: 0 });
  const a = await seedAdmin(forge, { username: "alice", email: "alice@forge.test", password: "a-long-passphrase" });
  if (!a.ok) throw new Error("signup failed");
  alice = a.value;
  const b = await signUp(forge, { username: "bob", email: "bob@forge.test", password: "a-long-passphrase" }, { slot: fixtureSlot(forge) });
  if (!b.ok) throw new Error("signup failed");
  bob = b.value;
  const r = await createRepo(forge, alice, { name: "lamp", visibility: "public" });
  if (!r.ok) throw new Error("repo failed");
  repo = r.value;
  for (const name of ["bolt", "quill"]) {
    const made = await createAgent(forge, alice, { username: name });
    if (!made.ok) throw new Error(String(made.error));
    if (name === "bolt") bolt = made.value.user;
  }
  expect(addToCrew(forge, alice, repo, "quill").ok).toBe(true);
});
afterAll(async () => {
  forge.close?.();
  await rm(dir, { recursive: true, force: true });
});

/** Open the About card as `who`, press each key in turn; every frame after the card's. */
async function open(who: User, keys: string[] = []): Promise<string[]> {
  const { app, session } = createForgeApp(
    forge,
    { sshUsername: who.username, remoteAddress: "127.0.0.1", user: who },
    { terminal: headlessTerminal(140, 40), exitHooks: false },
  );
  app.start();
  await settleApp(app);
  const src = localSource(forge, repo, who);
  app.push(aboutScreen(session, app.ctx, { render() {} } as never, src, undefined, "main"));
  await settleApp(app);
  const frames = [app.screen.toText()];
  for (const key of keys) {
    // A word is typed into a prompt; a single key is pressed.
    if ([...key].length > 1 && key !== LEFT && key !== "enter")
      for (const ch of key) app.dispatch({ type: "key", key: ch, ctrl: false, alt: false, shift: false });
    else app.dispatch({ type: "key", key, ctrl: false, alt: false, shift: false });
    await settleApp(app);
    frames.push(app.screen.toText());
  }
  app.stop();
  return frames;
}

const onCrew = (name: string): boolean =>
  listCrewRoles(forge.db, repo.id).some((c) => c.agent.user.username === name);

test("the About card offers `C crew`, and C lists the crew with their roles", async () => {
  const frames = await open(alice, ["C"]);
  expect(frames[0]).toMatch(/\bC\b[^\n]*crew/);
  expect(frames[1]).toContain("quill");
  expect(frames[1]).toContain("builder");
  expect(frames[1]).toMatch(/\ba\b[^\n]*put an agent on/);
});

test("`a` asks for a name and only the confirm puts the agent on, as the settings page reads it", async () => {
  expect(onCrew("bolt")).toBe(false);
  const asked = await open(alice, ["C", "a", "bolt", "enter"]);
  expect(asked.at(-1)).toContain("bolt joins the crew of alice/lamp");
  expect(onCrew("bolt")).toBe(false);
  // Cancel is one step left of the chosen action.
  await open(alice, ["C", "a", "bolt", "enter", LEFT, "enter"]);
  expect(onCrew("bolt")).toBe(false);
  const done = await open(alice, ["C", "a", "bolt", "enter", "enter"]);
  expect(onCrew("bolt")).toBe(true);
  expect(isCrew(forge.db, repo.id, bolt.id)).toBe(true);
  expect(done.at(-1)).toContain("bolt is on the crew. Assign it an issue and it starts.");
});

test("a person's name is refused in Settings › Crew's words, and nobody joins", async () => {
  const frames = await open(alice, ["C", "a", "bob", "enter", "enter"]);
  expect(frames.at(-1)).toContain(CREW_NOT_AN_AGENT);
  expect(listCrewRoles(forge.db, repo.id).map((c) => c.agent.user.username).sort()).toEqual(["bolt", "quill"]);
});

test("an unknown name is refused as no such agent, and nobody joins", async () => {
  const frames = await open(alice, ["C", "a", "nobody-here", "enter", "enter"]);
  expect(frames.at(-1)).toContain(CREW_NO_SUCH_AGENT);
  expect(onCrew("nobody-here")).toBe(false);
});

test("an admin whose email is unproven is told to verify first, and nobody joins", async () => {
  const made = await createUser(forge.db, {
    username: "ursa",
    email: "ursa@forge.test",
    password: "a-long-passphrase",
    origin: "seed",
    isAdmin: true,
  });
  if (!made.ok) throw new Error("user failed");
  const frames = await open(made.value, ["C", "a", "bolt", "enter", "enter"]);
  expect(frames.at(-1)).toContain(crewRefusal("unverified"));
  expect(frames.at(-1)).toContain("Verify");
  expect(crewRefusal("unverified")).not.toBe(CREW_NO_SUCH_AGENT);
  expect(crewRefusal("not_found")).toContain("admin");
});

test("`d` takes the selected agent off after a confirm", async () => {
  expect(onCrew("bolt")).toBe(true);
  // The cursor starts on the first row drawn; press `j` once per row above bolt's.
  const lines = (await open(alice, ["C"]))[1]!.split("\n");
  const drawn = ["bolt", "quill"]
    .map((name) => ({ name, line: lines.findIndex((l) => l.includes(name)) }))
    .sort((x, y) => x.line - y.line);
  expect(drawn.every((d) => d.line > -1)).toBe(true);
  const down = Array<string>(drawn.findIndex((d) => d.name === "bolt")).fill("j");
  const asked = await open(alice, ["C", ...down, "d"]);
  expect(asked.at(-1)).toContain("bolt leaves the crew of alice/lamp");
  expect(onCrew("bolt")).toBe(true);
  const done = await open(alice, ["C", ...down, "d", "enter"]);
  expect(onCrew("bolt")).toBe(false);
  expect(onCrew("quill")).toBe(true);
  expect(done.at(-1)).toContain("bolt is off the crew.");
});

test("a reader sees the crew and is offered no key that changes it", async () => {
  const frames = await open(bob, ["C", "a", "bolt", "enter", "enter", "d", "enter"]);
  expect(frames[1]).toContain("quill");
  expect(frames[1]).not.toMatch(/put an agent on/);
  expect(frames[1]).not.toMatch(/take it off/);
  for (const frame of frames.slice(2)) {
    expect(frame).not.toContain("joins the crew");
    expect(frame).not.toContain("leaves the crew");
  }
  expect(onCrew("bolt")).toBe(false);
  expect(onCrew("quill")).toBe(true);
});

test("an agent on the crew sees the list and is offered no key that changes it", async () => {
  const quill = listCrewRoles(forge.db, repo.id).find((c) => c.agent.user.username === "quill")!.agent.user;
  const frames = await open(quill, ["C", "d", "enter"]);
  expect(frames[1]).toContain("quill");
  expect(frames[1]).not.toMatch(/take it off/);
  expect(onCrew("quill")).toBe(true);
});
