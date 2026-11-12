/**
 * No button spins at rest on Home (#3067, the browser half of #3039).
 *
 * `test/button-rest.test.ts` reads the source for `icon: "loader"`; this loads
 * `/feed` as an admin in a real headless Chromium, with a stalled step's card on
 * the page, and asks the computed style: no `button` or `.btn` is
 * `aria-busy`, and nothing inside one runs an animation. It goes red if
 * `flow_card.ts` goes back to the loader icon.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openPull } from "../src/actions/pulls.ts";
import { commitToBranch, createRepo } from "../src/actions/repos.ts";
import { createApp, type App } from "../src/app.ts";
import { createSession } from "../src/core/sessions.ts";
import { createUser } from "../src/core/users.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { findChromium } from "../src/looks/capture.ts";
import { chromiumRuns, findBusyButtons } from "./helpers/chrome.ts";
import { quietLogs } from "./helpers/globals.ts";
import { promote } from "./helpers/members.ts";

quietLogs();

const found = findChromium();
const chromium = found !== undefined && chromiumRuns(found) ? found : undefined;
if (chromium === undefined) {
  console.log(
    "SKIPPING: no chromium that starts on this machine, so the Home buttons-at-rest test cannot run",
  );
}

describe.skipIf(chromium === undefined)("Home's buttons rest", () => {
  let dataDir: string;
  let app: App;
  let servers: Servers;
  let cookies: { name: string; value: string }[] = [];

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-home-rest-"));
    app = createApp({ dataDir, port: 0 });
    servers = await serve(app);
    const made = await createUser(app.db, {
      origin: "seed",
      trusted: true,
      username: "keeper",
      email: "keeper@forge.local",
      password: "a-good-passphrase",
      adminIfFirst: true,
    });
    if (!made.ok) throw new Error(made.error);
    promote(app.db, made.value);
    const admin = made.value;
    cookies = [
      { name: "forge_session", value: createSession(app.db, admin.id).token },
      { name: "forge_mode", value: "studio" },
    ];
    const repo = await createRepo(app, admin, { name: "garden", visibility: "public" });
    if (!repo.ok) throw new Error("repo");
    const seeded = await commitToBranch(app, admin, repo.value, {
      message: "seed",
      files: [{ path: "README.md", content: "# garden\n" }],
    });
    if (!seeded.ok) throw new Error(JSON.stringify(seeded.error));
    const c = await commitToBranch(app, admin, repo.value, {
      branch: "stalled",
      base: "main",
      message: "stalled",
      files: [{ path: "s.md", content: "x\n" }],
    });
    if (!c.ok) throw new Error(JSON.stringify(c.error));
    const pull = await openPull(app, admin, repo.value, {
      title: "A stalled change",
      body: "",
      baseBranch: "main",
      headBranch: "stalled",
    });
    if (!pull.ok) throw new Error(String(pull.error));
    // Old enough that nobody asking for a check is a stall.
    app.db
      .query("UPDATE issue SET created_at = ?2 WHERE id = ?1")
      .run(pull.value.id, new Date(Date.now() - 5 * 3_600_000).toISOString());
  }, 30_000);

  afterAll(async () => {
    servers.stop();
    app.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  for (const [label, width] of [
    ["desktop", 1280],
    ["360px", 360],
  ] as const)
    for (const scheme of ["light", "dark"] as const)
      test(`${label}, ${scheme}: with a stalled step on the page, no button is busy or animating`, async () => {
        const page = await findBusyButtons(
          chromium!,
          `${servers.url}/feed`,
          { width, height: 800 },
          cookies,
          scheme,
        );
        // The stalled step's button is on the page, so the check has teeth.
        const html = await (
          await fetch(`${servers.url}/feed`, {
            headers: { cookie: cookies.map((c) => `${c.name}=${c.value}`).join("; ") },
          })
        ).text();
        expect(html).toContain("data-flow-card=");
        expect(page.buttons).toBeGreaterThan(0);
        expect(page.busy).toEqual([]);
      }, 20_000);
});
