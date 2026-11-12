/**
 * Settings → Crew → Budgets (#11515): the card on a forge of its own, the
 * POST that saves the three limits (admin only, same-origin, validated), and
 * the home's line saying whose key is paying.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { saveCrewKey } from "../src/actions/crew_key.ts";
import { createApp, type App } from "../src/app.ts";
import { budgetLimit } from "../src/crew/forge_budget.ts";
import { createSession } from "../src/core/sessions.ts";
import { createUser, getUserByName } from "../src/core/users.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { crewFirstText, crewNote } from "../src/web/studio/crew_key.ts";
import { quietLogs } from "./helpers/globals.ts";

quietLogs();

describe("the owner's budgets page", () => {
  let dir = "";
  let app: App;
  let servers: Servers;
  let admin = "";
  let plain = "";
  const post = (cookie: string, body: Record<string, string>, origin = servers.url) =>
    fetch(`${servers.url}/settings/crew/budgets`, {
      method: "POST",
      redirect: "manual",
      headers: { "content-type": "application/x-www-form-urlencoded", origin, cookie },
      body: new URLSearchParams(body),
    });

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "forge-budgets-"));
    writeFileSync(join(dir, "parent.json"), "{}");
    app = createApp({ dataDir: dir, port: 0 });
    for (const [username, adminIfFirst] of [["alice", true], ["bob", false]] as const) {
      const made = await createUser(app.db, { origin: "seed", trusted: true, username, email: `${username}@x.test`, password: "a-long-starter-passphrase", adminIfFirst });
      if (!made.ok) throw new Error(made.error);
    }
    admin = `forge_session=${createSession(app.db, getUserByName(app.db, "alice")!.id).token}`;
    plain = `forge_session=${createSession(app.db, getUserByName(app.db, "bob")!.id).token}`;
    servers = await serve(app);
  });
  afterAll(async () => {
    servers?.stop();
    app?.close();
    await rm(dir, { recursive: true, force: true });
  });

  test("the page shows three limits with their defaults and what is spent", async () => {
    const res = await fetch(`${servers.url}/settings/crew`, { headers: { cookie: admin } });
    const page = await res.text();
    expect(page).toContain('id="budgets"');
    expect(page).toContain('name="run" type="number"');
    expect(page).toContain('value="5.00"');
    expect(page).toContain('value="50.00"');
    expect(page).toContain('value="500.00"');
    expect(page).toContain("$0.00 of $50.00");
    expect(page).toContain("Spent this day (UTC)");
    expect(page).toContain(`max="100000"`);
  });

  test("an admin saves them; a bad amount, a stranger and a cross-origin post change nothing", async () => {
    const saved = await post(admin, { run: "12.50", day: "40", month: "300" });
    expect(saved.status).toBeLessThan(400);
    expect([budgetLimit(app.db, "run"), budgetLimit(app.db, "day"), budgetLimit(app.db, "month")]).toEqual([12.5, 40, 300]);
    await post(admin, { run: "abc", day: "1", month: "1" });
    await post(plain, { run: "1" });
    expect((await post(admin, { run: "1" }, "https://evil.example")).status).toBe(403);
    expect(budgetLimit(app.db, "run")).toBe(12.5);
    expect(budgetLimit(app.db, "day")).toBe(40);
  });

  test("a post that raises a limit says the parked work was picked back up", async () => {
    const { addComment, openIssue } = await import("../src/actions/issues.ts");
    const { createRepo } = await import("../src/actions/repos.ts");
    const { PARK_NOTE } = await import("../src/crew/parks.ts");
    const { stoppedBy, setBudget } = await import("../src/crew/forge_budget.ts");
    const alice = getUserByName(app.db, "alice")!;
    const made = await createRepo(app, alice, { name: "beds", visibility: "public" });
    if (!made.ok) throw new Error("repo");
    app.db.query("UPDATE repo SET autonomy = 'autonomous' WHERE id = ?1").run(made.value.id);
    setBudget(app.db, "run", 0.1, alice.id);
    const issue = openIssue(app, alice, made.value, { title: "Stopped by a limit", body: "x" });
    if (!issue.ok) throw new Error("issue");
    addComment(app, alice, made.value, issue.value, `${PARK_NOTE}${stoppedBy(app.db, "run")}`);
    const res = await post(admin, { run: "8" });
    expect(res.status).toBeLessThan(400);
    const flash = res.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
    const page = await (await fetch(new URL(res.headers.get("location")!, servers.url), { headers: { cookie: `${admin}; ${flash}` } })).text();
    expect(page).toContain("1 issue picked back up.");
  });

  test("with its own key the home line says whose key is paying, and the host's credit is not drawn on", async () => {
    expect(crewNote(app)).not.toContain("own model key");
    expect((await saveCrewKey(app, { ...getUserByName(app.db, "alice")!, isAdmin: true }, "sk-ant-api03-abcdefghijklmnop")).ok).toBe(true);
    expect(crewNote(app)).toBe("The crew works on this forge's own model key; the host's included credit is not drawn on.");
    expect(crewFirstText(app)).toContain("not drawn on");
  });
});
