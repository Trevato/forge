/** A forge preview seeds disk readings for the sample's machine and looks at them as the owner, closed and open (#10466). */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { createSession } from "../src/core/sessions.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { PREVIEW_DISK_OPEN_LOOK, PREVIEW_MACHINES_PAGE, PREVIEW_OWNER_LOOKS } from "../src/spawn/preview-looks.ts";
import { previewAdmin, seedPreview } from "../src/spawn/preview-seed.ts";
import { quietLogs } from "./helpers/globals.ts";

quietLogs();

let dir: string;
let app: App;
let servers: Servers;
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "forge-preview-disks-"));
  app = createApp({ dataDir: dir, port: 0 });
  const seeded = await seedPreview(app, { FORGE_APP_ENV: "preview" });
  if (!seeded.ok) throw new Error(seeded.error);
  servers = await serve(app);
}, 30_000);
afterAll(async () => {
  servers.stop();
  app.close();
  await rm(dir, { recursive: true, force: true });
});

test("the machines page and its open alerting line are owner looks at desk and phone", () => {
  for (const page of [PREVIEW_MACHINES_PAGE, PREVIEW_DISK_OPEN_LOOK])
    expect(PREVIEW_OWNER_LOOKS.filter((l) => l.page === page).map((l) => l.kind).sort()).toEqual(["desktop", "phone"]);
});

test("the owner sees a healthy, an alerting and a behind-controller line, and the open look's fragment is inside the alerting fold", async () => {
  const cookie = `forge_session=${createSession(app.db, previewAdmin(app)!.id).token}`;
  const res = await fetch(`${servers.url}${PREVIEW_MACHINES_PAGE}`, { headers: { cookie } });
  expect(res.status).toBe(200);
  const html = await res.text();
  for (const dev of ["nvme0", "nvme1", "sda"]) expect(html).toContain(`data-disk="${dev}"`);
  const alerting = html.split('data-disk="nvme1"')[1]!.split("</li>")[0]!;
  const fragment = PREVIEW_DISK_OPEN_LOOK.split("#")[1]!;
  expect(alerting.split("</details>")[0]).toContain(`id="${fragment}"`);
  expect(alerting.split("</details>")[1]).toContain("data-disk-reasons");
});

test("a second seed records no second reading", async () => {
  const count = () => (app.db.query("SELECT COUNT(*) AS n FROM disk_reading WHERE machine = 'standard'").get() as { n: number }).n;
  const before = count();
  const again = await seedPreview(app, { FORGE_APP_ENV: "preview" });
  expect(again.ok).toBe(true);
  expect(count()).toBe(before);
});
