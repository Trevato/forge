/**
 * The first ask's flash names the app and the issue it made, in each state
 * (#11788): a builder took it, nobody is on the crew, no credit; and the
 * terminal's home opens on the same status line as the card.
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { listReposOwnedBy } from "../src/core/repos.ts";
import { getUserByName } from "../src/core/users.ts";
import { fundingOf, keepFunding } from "../src/spawn/funding.ts";
import { prefixed, tellFlashWords } from "../src/web/studio/actions.ts";
import { createForgeApp } from "../src/tui/forge.ts";
import { headlessTerminal } from "../src/tui/term/terminal.ts";
import { settleApp } from "./helpers/tui.ts";
import { claimedForge, type ClaimedForge } from "./helpers/claimed-forge.ts";
import { quietLogs } from "./helpers/globals.ts";

quietLogs();

let forge: ClaimedForge;
beforeAll(async () => {
  forge = await claimedForge("forge-first-flash-");
}, 60_000);
afterAll(() => forge.stop());

const flashOf = (res: Response) => decodeURIComponent(res.headers.getSetCookie().join(";")).replace(/\+/g, " ");

test("prefixed names the subject, or leaves the message alone", () => {
  expect(prefixed("atlas is on it", "menu, issue #1")).toBe("menu, issue #1: atlas is on it");
  expect(prefixed("atlas is on it", "")).toBe("atlas is on it");
});

test("nobody on the crew: the flash names the app and issue, and says to add someone", () => {
  expect(tellFlashWords(undefined, null, "menu, issue #1")).toBe(
    "menu, issue #1: Opened as an issue. Nobody is on the crew to take it yet — add someone under Settings → Crew.",
  );
});

test("with credit the flash names the app and the issue", async () => {
  const res = await forge.post(forge.owner, "/tell", { app: "new-app", text: "A weekly menu page for the bakery" });
  const maria = getUserByName(forge.child.db, "maria")!;
  const repo = listReposOwnedBy(forge.child.db, maria.id).find((r) => r.name.includes("menu"))!;
  expect(flashOf(res)).toContain(`${repo.name}, issue #1: `);
});

test("with no credit the flash still names them, and keeps the way forward", async () => {
  const dir = forge.child.config.dataDir;
  const funding = fundingOf(dir)!;
  keepFunding(dir, { token: funding.token, capUsd: 2, spentUsd: 2 });
  try {
    const res = await forge.post(forge.owner, "/tell", { app: "new-app", text: "A parking map for the market" });
    const maria = getUserByName(forge.child.db, "maria")!;
    const repo = listReposOwnedBy(forge.child.db, maria.id).find((r) => r.name.includes("parking"))!;
    const flash = flashOf(res);
    expect(flash).toContain(`${repo.name}, issue #1: Saved, but`);
    const home = await (await fetch(`${forge.base}/`, { headers: { cookie: forge.owner } })).text();
    expect(home).toContain("data-ask-status");
    expect(home).toContain("No AI account and no included credit left");
    const card = home.slice(home.indexOf('id="next-steps"'));
    const status = card.slice(card.indexOf("data-ask-status"), card.indexOf("data-step="));
    expect(status).toContain("Add a model key");
    expect(status).not.toContain('data-variant="primary"');
  } finally {
    keepFunding(dir, funding);
  }
});

test("the terminal's home opens on the first ask's status line", async () => {
  const maria = getUserByName(forge.child.db, "maria")!;
  const repo = listReposOwnedBy(forge.child.db, maria.id).find((r) => r.name.includes("menu"))!;
  const terminal = headlessTerminal(200, 40);
  const { app } = createForgeApp(
    forge.child,
    { sshUsername: maria.username, remoteAddress: "127.0.0.1", fingerprint: "SHA256:t", user: maria },
    { terminal, exitHooks: false },
  );
  app.start();
  await settleApp(app);
  const text = app.screen.toText();
  app.stop();
  expect(text).toContain(`(${repo.name}, issue #1)`);
});
