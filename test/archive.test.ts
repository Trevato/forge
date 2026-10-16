import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { getRepo } from "../src/core/repos.ts";
import { serve, type Servers } from "../src/http/server.ts";

type Row = { archivedAt: string | null };

describe("archive and wake", () => {
  let dataDir: string;
  let app: App;
  let servers: Servers;
  let base: string;
  let owner = "";
  let stranger = "";

  const form = (fields: Record<string, string>) => new URLSearchParams(fields);

  async function signup(username: string): Promise<string> {
    const res = await fetch(`${base}/signup`, {
      method: "POST",
      body: form({
        username,
        email: `${username}@f.dev`,
        password: "archive-password",
      }),
      redirect: "manual",
    });
    return (res.headers.get("set-cookie") ?? "").split(";")[0]!;
  }

  const patch = (cookie: string, archived: boolean) =>
    fetch(`${base}/api/v1/repos/ada/old`, {
      method: "PATCH",
      headers: { cookie, "content-type": "application/json", origin: base },
      body: JSON.stringify({ archived }),
    });

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-archive-"));
    app = createApp({ dataDir, port: 0 });
    servers = await serve(app);
    base = servers.url;
    owner = await signup("ada");
    stranger = await signup("bob");
    await fetch(`${base}/new`, {
      method: "POST",
      headers: { cookie: owner },
      body: form({ name: "old", visibility: "public", description: "done" }),
      redirect: "manual",
    });
  });

  afterAll(async () => {
    servers.stop();
    app.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  test("a repository starts unarchived, and the JSON says so", async () => {
    const res = await fetch(`${base}/api/v1/repos/ada/old`, {
      headers: { cookie: owner },
    });
    expect(((await res.json()) as Row).archivedAt).toBeNull();
  });

  test("a non-boolean archived is refused with 422 and changes nothing", async () => {
    for (const archived of ["yes", 1, null]) {
      const res = await fetch(`${base}/api/v1/repos/ada/old`, {
        method: "PATCH",
        headers: { cookie: owner, "content-type": "application/json", origin: base },
        body: JSON.stringify({ archived }),
      });
      expect(res.status).toBe(422);
      expect(((await res.json()) as { error: string }).error).toBe("bad_archived");
    }
    const res = await fetch(`${base}/api/v1/repos/ada/old`, {
      headers: { cookie: owner },
    });
    expect(((await res.json()) as Row).archivedAt).toBeNull();
  });

  test("the API archives and wakes it", async () => {
    const archived = await patch(owner, true);
    expect(archived.status).toBe(200);
    const stamp = ((await archived.json()) as Row).archivedAt;
    expect(Date.parse(stamp ?? "")).not.toBeNaN();
    expect(getRepo(app.db, "ada", "old")?.archivedAt).toBe(stamp);

    // Archiving again keeps the first date.
    expect(((await (await patch(owner, true)).json()) as Row).archivedAt).toBe(stamp);

    const woke = await patch(owner, false);
    expect(((await woke.json()) as Row).archivedAt).toBeNull();
    expect(getRepo(app.db, "ada", "old")?.archivedAt).toBeNull();
  });

  test("a non-admin is refused with 403 and nothing changes", async () => {
    const res = await patch(stranger, true);
    expect(res.status).toBe(403);
    expect(getRepo(app.db, "ada", "old")?.archivedAt).toBeNull();
  });

  test("the Settings form archives, the page says so, and Wake clears it", async () => {
    const post = (cookie: string, fields: Record<string, string>, origin = base) =>
      fetch(`${base}/ada/old/settings/archive`, {
        method: "POST",
        headers: { cookie, origin },
        body: form(fields),
        redirect: "manual",
      });

    // Cross-origin: refused, unchanged.
    const cross = await post(owner, { archived: "1" }, "http://evil.example");
    expect(cross.status).toBe(403);
    expect(getRepo(app.db, "ada", "old")?.archivedAt).toBeNull();

    // A stranger's form is not an admin's.
    expect((await post(stranger, { archived: "1" })).status).toBeGreaterThanOrEqual(400);
    expect(getRepo(app.db, "ada", "old")?.archivedAt).toBeNull();

    expect((await post(owner, { archived: "1" })).status).toBe(303);
    const at = getRepo(app.db, "ada", "old")!.archivedAt!;
    const day = at.slice(0, 10);

    const asOwner = await (
      await fetch(`${base}/ada/old`, { headers: { cookie: owner } })
    ).text();
    expect(asOwner).toContain(`Archived on`);
    expect(asOwner).toContain(day);
    expect(asOwner).toContain("Wake");

    const asStranger = await (
      await fetch(`${base}/ada/old`, { headers: { cookie: stranger } })
    ).text();
    expect(asStranger).toContain("Archived on");
    expect(asStranger).not.toContain("/settings/archive");

    expect((await post(owner, { archived: "0", to: "repo" })).status).toBe(303);
    expect(getRepo(app.db, "ada", "old")?.archivedAt).toBeNull();
    const woken = await (
      await fetch(`${base}/ada/old`, { headers: { cookie: owner } })
    ).text();
    expect(woken).not.toContain("Archived on");
  });
});
