import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { appFor, operatorClientId } from "../src/origins/oauth.ts";

describe("an origin the operator registered once", () => {
  const env = {
    FORGE_ORIGIN_CLIENT_ID:
      " git.example=abc-123 , Other.Example=def-456,broken,=nothing",
  };

  test("is matched on the origin's hostname, case-insensitively", () => {
    expect(operatorClientId(env, "https://git.example/api/v1")).toBe("abc-123");
    expect(operatorClientId(env, "https://other.example/api/v1")).toBe(
      "def-456",
    );
    expect(
      operatorClientId(env, "https://else.example/api/v1"),
    ).toBeUndefined();
    expect(operatorClientId({}, "https://git.example/api/v1")).toBeUndefined();
    expect(operatorClientId(env, "not a url")).toBeUndefined();
  });

  describe("through appFor", () => {
    let dataDir: string;
    let app: App;

    beforeAll(async () => {
      dataDir = await mkdtemp(join(tmpdir(), "forge-origin-op-"));
      app = createApp({ dataDir, port: 0 });
    });
    afterAll(async () => {
      app.close();
      await rm(dataDir, { recursive: true, force: true });
    });

    test("a Forgejo host needs no pasted client id, and no secret", () => {
      const found = appFor(
        app.db,
        dataDir,
        "nobody",
        {
          kind: "forgejo",
          apiUrl: "https://git.example/api/v1",
          webUrl: "https://git.example",
        },
        env,
      );
      expect(found.ok).toBe(true);
      if (found.ok) {
        expect(found.value.clientId).toBe("abc-123");
        expect(found.value.clientSecret).toBe("");
        expect(found.value.kind).toBe("forgejo");
      }
    });

    test("an unregistered host is still nobody's app", () => {
      const found = appFor(
        app.db,
        dataDir,
        "nobody",
        {
          kind: "forgejo",
          apiUrl: "https://else.example/api/v1",
          webUrl: "https://else.example",
        },
        env,
      );
      expect(found.ok).toBe(false);
    });
  });
});
