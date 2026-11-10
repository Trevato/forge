/** The machines page lists each machine's disks (#10466): healthy, alerting, behind a controller, unknown model, no reading. */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { createRepo } from "../src/core/repos.ts";
import { createSession } from "../src/core/sessions.ts";
import { createUser } from "../src/core/users.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { recordReading } from "../src/machines/disk_readings.ts";
import { quietLogs } from "./helpers/globals.ts";

quietLogs();

const DAY = 86_400_000;
const T0 = Date.parse("2026-10-01T00:00:00Z");
function smart(o: { units: number; model?: string; spare?: number; used?: number; name?: string }) {
  return JSON.stringify({
    smartctl: { version: [7, 4] },
    device: { name: "/dev/nvme0", type: "nvme", protocol: "NVMe" },
    model_name: o.model ?? "Samsung SSD 980 PRO 1TB",
    firmware_version: "5B2QGXA7",
    user_capacity: { bytes: 1_000_204_886_016 },
    nvme_smart_health_information_log: {
      critical_warning: 0, temperature: 41, available_spare: o.spare ?? 100, available_spare_threshold: 10,
      percentage_used: o.used ?? 1, data_units_written: o.units, media_errors: 0, power_on_hours: 1234,
      unsafe_shutdowns: 7, warning_temp_time: 3, critical_comp_time: 0,
    },
  });
}
const controller = JSON.stringify({ smartctl: { version: [7, 4] }, device: { name: "/dev/sda", type: "megaraid,0" } });

let app: App;
let servers: Servers;
const cookies: Record<string, string> = {};

beforeAll(async () => {
  app = createApp({ dataDir: mkdtempSync(join(tmpdir(), "machines-disks-")), port: 0 });
  const ids: Record<string, string> = {};
  for (const name of ["alice", "bob", "carol"]) {
    const made = await createUser(app.db, { username: name, email: `${name}@x.test`, password: "correct horse battery", origin: "seed", trusted: true });
    if (!made.ok) throw new Error(String(made.error));
    ids[name] = made.value.id;
    cookies[name] = `forge_session=${createSession(app.db, made.value.id).token}`;
  }
  app.db.query("UPDATE user SET is_admin = 1 WHERE username = 'alice'").run();
  // Two repositories declare the same built-in machine name, "standard".
  for (const [owner, name] of [["alice", "lab"], ["bob", "lab"]] as const) {
    const repo = await createRepo(app.db, app.reposRoot, { ownerId: ids[owner]!, name, visibility: "public" });
    if (!repo.ok) throw new Error(String(repo.error));
  }
  servers = await serve(app);
});
afterAll(() => {
  servers.stop();
  app.close();
});
const get = (path: string, who: string) => fetch(`${servers.url}${path}`, { headers: { cookie: cookies[who]! } });
const page = async (path = "/alice/lab/settings/machines", who = "alice") => (await get(path, who)).text();

test("no reading says so in one line", async () => {
  expect(await page()).toContain('data-disks-empty="standard"');
});

test("healthy, alerting, behind-controller and unknown-model disks read as lines", async () => {
  const db = app.db;
  // 1e6 units × 512 000 B = 5.12e11 B = 0.51 TB; of 600 TBW = 0.085% → "0.1%". 2e9 units = 1.024e15 B = 1024.00 TB.
  recordReading(db, "standard", "nvme0", smart({ units: 1_000_000 }), T0);
  recordReading(db, "standard", "nvme1", smart({ units: 10, spare: 5, used: 85 }), T0);
  recordReading(db, "standard", "sda", controller, T0);
  recordReading(db, "standard", "nvme2", smart({ units: 2_000_000_000, model: "Mystery <b>X</b>" }), T0 + DAY);
  const body = await page();
  const li = (dev: string) => body.split(`data-disk="${dev}"`)[1]!.split("</li>")[0]!;
  const healthy = li("nvme0");
  expect(healthy).toContain("nvme0 · Samsung SSD 980 PRO 1TB");
  expect(healthy).toContain("0.51 of 600 TBW (0.1%) · 41 °C");
  expect(healthy).not.toContain("data-disk-reasons");
  expect(healthy).not.toContain("badge");
  expect(healthy).toContain("<details");
  expect(healthy).toContain("rated 600 TBW, 5-year warranty");
  expect(healthy).toContain("threshold 10%");
  expect(healthy).toContain("rated warning 82 °C");
  expect(healthy).toContain("Unsafe shutdowns");
  expect(healthy).toContain("no projection yet");
  const alerting = li("nvme1");
  expect(alerting).toContain('class="badge"');
  expect(alerting).toContain("available spare 5% is below its threshold 10%");
  expect(alerting).toContain("percentage used 85% is at or above 80%");
  // The reasons read with the line closed: after the <details>, not inside it.
  const reasons = alerting.split("</details>")[1]!;
  expect(reasons).toContain("data-disk-reasons");
  expect(reasons).toContain("available spare 5% is below its threshold 10%");
  expect(alerting.split("</details>")[0]).not.toContain("data-disk-reasons");
  expect(li("sda")).toContain("behind a controller; SMART not visible");
  const unknown = li("nvme2");
  expect(unknown).toContain("1024.00 TB written · no spec sheet");
  expect(unknown).toContain("Mystery &lt;b&gt;X&lt;/b&gt;");
  expect(unknown).not.toContain("<b>X");
  expect(body).not.toContain('data-disks-empty="standard"');
});

test("each machine's disks sit under its own row in the Machines list", async () => {
  const body = await page();
  const machines = body.split('id="machines"')[1]!.split("</section>")[0]!;
  const standard = machines.split('data-machine="standard"')[1]!;
  expect(standard).toContain('<ul class="row-children">');
  expect(standard).toContain('data-disk="nvme0"');
  expect(body).not.toContain("<h2>Disks</h2>");
  expect(body).not.toContain("<h3>");
});

test("a projected date shows when the rated TBW is reached at the 30-day rate", async () => {
  // 1e9 units = 512 TB at T0, 1.1e9 = 563.2 TB 30 d later: 51.2 TB per 30 d.
  // Remaining 600 − 563.2 = 36.8 TB ÷ (51.2/30 TB/d) = 21.5625 d after 2026-10-31 → 2026-11-21.
  recordReading(app.db, "standard", "nvme3", smart({ units: 1_000_000_000 }), T0);
  recordReading(app.db, "standard", "nvme3", smart({ units: 1_100_000_000 }), T0 + 30 * DAY);
  const row = (await page()).split('data-disk="nvme3"')[1]!.split("</li>")[0]!;
  expect(row).toContain("Projected TBW date</dt><dd>2026-11-21");
  expect(row).toContain("alert at 80%");
});

test("a writer who is not the owner sees no disks, though the machine name is shared", async () => {
  const body = await page("/bob/lab/settings/machines", "bob");
  expect(body).toContain('id="machines"');
  expect(body).not.toContain("data-disk");
  expect(body).not.toContain("Samsung");
  expect(body).not.toContain("<h2>Disks</h2>");
});

test("a reader is refused the page", async () => {
  expect((await get("/alice/lab/settings/machines", "carol")).status).toBe(403);
});
