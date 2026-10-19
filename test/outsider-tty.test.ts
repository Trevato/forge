/**
 * The outsider suite's terminal door (#663): a stranger in the terminal is
 * refused a repository of their own, a view of a private repository and a
 * crew assignment, and the suite goes red when the assignment is left open.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { addToCrew, createAgent } from "../src/actions/crew.ts";
import { openIssue } from "../src/actions/issues.ts";
import { createRepo } from "../src/actions/repos.ts";
import { getIssue } from "../src/core/issues.ts";
import { getRepo } from "../src/core/repos.ts";
import { setMember } from "../src/core/roles.ts";
import { createUser, getUserByName, type User } from "../src/core/users.ts";
import { seedAdmin } from "./helpers/admin.ts";
import { quietLogs } from "./helpers/globals.ts";
import { outsiderTty, type Target } from "./helpers/outsider-tty.ts";

quietLogs();

describe("outsider suite, terminal door", () => {
  let dataDir = "";
  let app: App;
  let stranger: User;
  const targets: Target[] = [];

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-outsider-tty-"));
    app = createApp({ dataDir, port: 0 });
    const seeded = await seedAdmin(app, { username: "rowan", email: "rowan@example.com", password: "a-long-owner-passphrase" });
    if (!seeded.ok) throw new Error(String(seeded.error));
    const owner = seeded.value;
    const agent = await createAgent(app, owner, { username: "helper" });
    if (!agent.ok) throw new Error(String(agent.error));
    for (const [name, visibility] of [["vault", "private"], ["lawn", "public"]] as const) {
      const made = await createRepo(app, owner, { name, visibility });
      if (!made.ok) throw new Error(String(made.error));
      const opened = openIssue(app, owner, made.value, { title: "weed", body: "" });
      if (!opened.ok) throw new Error(String(opened.error));
      const crewed = addToCrew(app, owner, made.value, "helper");
      if (!crewed.ok) throw new Error(String(crewed.error));
      targets.push({ owner: "rowan", name, issue: opened.value.number, agent: "helper", hidden: visibility === "private" });
    }
    const made = await createUser(app.db, { origin: "seed", trusted: true, username: "stranger", email: "stranger@example.com", password: "a-long-stranger-passphrase" });
    if (!made.ok) throw new Error(String(made.error));
    stranger = made.value;
  }, 60_000);

  afterAll(async () => {
    app.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  test("a stranger in the terminal is refused everything, and nothing changes", async () => {
    expect(await outsiderTty(app, stranger, targets)).toEqual([]);
    expect(getRepo(app.db, "stranger", "stranger-tty")).toBeUndefined();
    const lawn = getRepo(app.db, "rowan", "lawn")!;
    expect(getIssue(app.db, lawn.id, targets[1]!.issue)?.assigneeId).toBeNull();
  }, 60_000);

  test("it is red when the terminal lets a stranger make a repository and assign", async () => {
    // The door left open: the stranger is a member and owns a public repository with a crew.
    const owner = getUserByName(app.db, "rowan")!;
    const made = await createRepo(app, owner, { name: "yard", visibility: "public" });
    if (!made.ok) throw new Error(String(made.error));
    const opened = openIssue(app, owner, made.value, { title: "weed", body: "" });
    if (!opened.ok) throw new Error(String(opened.error));
    const crewed = addToCrew(app, owner, made.value, "helper");
    if (!crewed.ok) throw new Error(String(crewed.error));
    app.db.query("UPDATE repo SET owner_id = ?1 WHERE id = ?2").run(stranger.id, made.value.id);
    setMember(app.db, stranger.id, true, owner.id, new Date());
    const got = await outsiderTty(app, stranger, [{ owner: "stranger", name: "yard", issue: opened.value.number, agent: "helper", hidden: false }]);
    expect(got.map((r) => r.check)).toEqual(["no repository of its own (terminal)", "no steering of stranger/yard (terminal)"]);
  }, 60_000);
});
