/**
 * A new forge starts with signup = invite; a forge with a stored value keeps
 * it; the first admin is untouched (first-admin.test.ts).
 */

import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { createApp } from "../src/app.ts";
import { getSignup, seedSignup, setSignup, signupChanges } from "../src/settings/signup.ts";

const app = () => createApp({ dataDir: mkdtempSync(join(tmpdir(), "fresh-")) });

describe("seedSignup", () => {
  test("a fresh forge stores invite and keeps the change", () => {
    const a = app();
    expect(getSignup(a.db)).toBe("open");
    seedSignup(a.db, true);
    expect(getSignup(a.db)).toBe("invite");
    expect(signupChanges(a.db)[0]?.actorName).toBe("new forge");
    a.close();
  });

  test("a forge that stored open keeps it", () => {
    const a = app();
    setSignup(a.db, "closed", "boot");
    setSignup(a.db, "open", "boot");
    seedSignup(a.db, true);
    expect(getSignup(a.db)).toBe("open");
    a.close();
  });

  test("an existing forge with nothing stored is left alone", () => {
    const a = app();
    seedSignup(a.db, false);
    expect(getSignup(a.db)).toBe("open");
    expect(signupChanges(a.db)).toHaveLength(0);
    a.close();
  });
});

describe("createApp with seedSignup", () => {
  test("a data directory with no forge.db starts with invite; one with a forge.db keeps its value", () => {
    const dir = mkdtempSync(join(tmpdir(), "fresh-"));
    const first = createApp({ dataDir: dir, seedSignup: true });
    expect(getSignup(first.db)).toBe("invite");
    setSignup(first.db, "open", "boot");
    first.close();
    const again = createApp({ dataDir: dir, seedSignup: true });
    expect(getSignup(again.db)).toBe("open");
    again.close();
  });

  test("a forge.db that never stored a value stays open", () => {
    const dir = mkdtempSync(join(tmpdir(), "fresh-"));
    createApp({ dataDir: dir }).close();
    const again = createApp({ dataDir: dir, seedSignup: true });
    expect(getSignup(again.db)).toBe("open");
    again.close();
  });

  test("without the option nothing is seeded", () => {
    const a = app();
    expect(getSignup(a.db)).toBe("open");
    a.close();
  });
});

describe("main.ts", () => {
  test("booting on an empty data directory stores invite", async () => {
    const dir = mkdtempSync(join(tmpdir(), "fresh-"));
    const proc = Bun.spawn(["bun", "run", join(import.meta.dir, "../src/main.ts")], {
      env: { ...process.env, FORGE_DATA: dir, FORGE_APP_DATA: "", FORGE_SIGNUP: "", PORT: "0", FORGE_PORT: "0" },
      stdout: "ignore",
      stderr: "ignore",
    });
    try {
      let value: string | undefined;
      for (let i = 0; i < 100 && value === undefined; i++) {
        await Bun.sleep(100);
        try {
          const db = new Database(join(dir, "forge.db"), { readonly: true });
          value = db.query<{ value: string }, []>("SELECT value FROM forge_setting WHERE key = 'signup'").get()?.value;
          db.close();
        } catch {}
      }
      expect(value).toBe("invite");
    } finally {
      proc.kill();
      await proc.exited;
    }
  });
});
