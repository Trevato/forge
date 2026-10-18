import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { seedAdmin } from "./helpers/admin.ts";

describe("read-back API (contents, branches, commits)", () => {
  let dataDir: string;
  let app: App;
  let servers: Servers;
  let base: string;
  let token = "";

  const api = (path: string) =>
    fetch(`${base}${path}`, { headers: { authorization: `Bearer ${token}` } });
  const write = (path: string, bodyObj: unknown) =>
    fetch(`${base}${path}`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(bodyObj),
    });

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-readapi-"));
    app = createApp({ dataDir, port: 0 });
    servers = await serve(app);
    base = servers.url;
    await seedAdmin(app, {
      username: "dev",
      email: "d@f.dev",
      password: "read-api-pass",
    });
    token = await fetch(`${base}/api/v1/tokens`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ adminConfirm: true,
        username: "dev",
        password: "read-api-pass",
        name: "c",
        scope: "rw",
      }),
    })
      .then((r) => r.json())
      .then((j) => (j as { token: string }).token);
    await write("/api/v1/repos", { name: "lib", visibility: "public" });
    await write("/api/v1/repos/dev/lib/contents", {
      message: "init",
      files: [
        { path: "src/index.ts", content: "export const answer = 42;\n" },
        { path: "README.md", content: "# lib\n" },
      ],
    });
    await write("/api/v1/repos/dev/lib/contents", {
      branch: "feature",
      message: "bump",
      files: [{ path: "src/index.ts", content: "export const answer = 43;\n" }],
    });
  });

  afterAll(async () => {
    servers.stop();
    app.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  test("branches lists heads with the default flagged", async () => {
    const branches = (await (
      await api("/api/v1/repos/dev/lib/branches")
    ).json()) as {
      name: string;
      isDefault: boolean;
    }[];
    const names = branches.map((b) => b.name).sort();
    expect(names).toEqual(["feature", "main"]);
    expect(branches.find((b) => b.name === "main")?.isDefault).toBe(true);
  });

  test("commits walks history at a ref", async () => {
    const commits = (await (
      await api("/api/v1/repos/dev/lib/commits?ref=main")
    ).json()) as {
      subject: string;
    }[];
    expect(commits[0]?.subject).toBe("init");
  });

  test("contents reads a file's text at a ref", async () => {
    const main = (await (
      await api("/api/v1/repos/dev/lib/contents/src/index.ts")
    ).json()) as {
      type: string;
      encoding: string;
      content: string;
    };
    expect(main.type).toBe("file");
    expect(main.encoding).toBe("utf-8");
    expect(main.content).toBe("export const answer = 42;\n");

    // The feature branch has the bumped value — read it at that ref.
    const feature = (await (
      await api("/api/v1/repos/dev/lib/contents/src/index.ts?ref=feature")
    ).json()) as { content: string };
    expect(feature.content).toBe("export const answer = 43;\n");
  });

  test("contents lists a directory", async () => {
    const root = (await (
      await api("/api/v1/repos/dev/lib/contents")
    ).json()) as {
      type: string;
      entries: { name: string }[];
    };
    expect(root.type).toBe("dir");
    expect(root.entries.map((e) => e.name).sort()).toEqual([
      "README.md",
      "src",
    ]);

    const src = (await (
      await api("/api/v1/repos/dev/lib/contents/src")
    ).json()) as {
      entries: { name: string }[];
    };
    expect(src.entries.map((e) => e.name)).toEqual(["index.ts"]);
  });

  test("read endpoints respect private-repo visibility", async () => {
    await write("/api/v1/repos", { name: "secret", visibility: "private" });
    await write("/api/v1/repos/dev/secret/contents", {
      message: "x",
      files: [{ path: "a.txt", content: "y" }],
    });
    // No auth → 404 (hidden).
    expect(
      (await fetch(`${base}/api/v1/repos/dev/secret/contents/a.txt`)).status,
    ).toBe(404);
    expect(
      (await fetch(`${base}/api/v1/repos/dev/secret/branches`)).status,
    ).toBe(404);
  });
});
