import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { createAgent, updateAgent } from "../src/actions/crew.ts";
import { getAgentByName } from "../src/core/agents.ts";
import type { User } from "../src/core/users.ts";
import { seedAdmin } from "./helpers/admin.ts";

describe("changing a crew member: model and brief bounds", () => {
  let dataDir: string;
  let app: App;
  let admin: User;

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-crew-bounds-"));
    app = createApp({ dataDir, port: 0, url: "https://forge.example", edgeToken: "e" });
    const made = await seedAdmin(app, { username: "olive", email: "olive@f.dev", password: "a-long-passphrase" });
    if (!made.ok) throw new Error(made.error);
    admin = made.value;
    const a = await createAgent(app, admin, { username: "bounded", model: "m", brief: "b" });
    if (!a.ok) throw new Error(a.error);
  });
  afterAll(async () => {
    app.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  const row = () => {
    const a = getAgentByName(app.db, "bounded")!;
    return { model: a.model, brief: a.brief, budgetUsd: a.budgetUsd };
  };

  test("a bad model is refused and the row is unchanged", () => {
    for (const model of ["x".repeat(81), "has space", "nul\0byte", "tab\tbed"]) {
      const before = row();
      const r = updateAgent(app, admin, "bounded", { model });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error).toBe("invalid_model");
      expect(row()).toEqual(before);
    }
  });

  test("a brief over 4,000 is refused and the row is unchanged", () => {
    const before = row();
    const r = updateAgent(app, admin, "bounded", { brief: "y".repeat(4_001) });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe("brief_too_long");
    expect(row()).toEqual(before);
  });

  test("a refused brief does not let a good model through with it", () => {
    const before = row();
    const r = updateAgent(app, admin, "bounded", { model: "fine", brief: "y".repeat(4_001) });
    expect(r.ok).toBe(false);
    expect(row()).toEqual(before);
  });

  test("exactly 80 and exactly 4,000 succeed", () => {
    const model = "x".repeat(80);
    const brief = "y".repeat(4_000);
    const r = updateAgent(app, admin, "bounded", { model, brief });
    expect(r.ok).toBe(true);
    expect(row().model).toBe(model);
    expect(row().brief).toBe(brief);
  });

  test("creating an agent is bounded the same way, and makes no account", async () => {
    const r = await createAgent(app, admin, { username: "toolong", model: "x".repeat(81) });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe("invalid_model");
    const b = await createAgent(app, admin, { username: "toolong", brief: "y".repeat(4_001) });
    if (!b.ok) expect(b.error).toBe("brief_too_long");
    expect(b.ok).toBe(false);
    expect(getAgentByName(app.db, "toolong")).toBeUndefined();
  });
});
