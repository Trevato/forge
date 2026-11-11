/**
 * The idle window an environment sleeps after comes from the slider's
 * position, and `app.always_on` is the one per-app exception.
 */
import { describe, expect, test } from "bun:test";
import { asleepWords, sleepWindow } from "../src/apps/sleep_window.ts";
import { parseManifest } from "../src/apps/manifest.ts";
import { envFacts } from "../src/web/ui.ts";

const at = (position: number) => ({ kind: "slider" as const, position });

describe("sleep windows", () => {
  test("production follows the slider: 10 min at 0, never at 100", () => {
    expect(sleepWindow(at(0), true, false)).toEqual({ ms: 600_000, why: "economy 0" });
    expect(sleepWindow(at(100), true, false).ms).toBeNull();
    expect(sleepWindow(at(50), true, false).ms).toBe(86_400_000);
    expect(sleepWindow(at(0), false, false).ms).toBe(300_000);
  });

  test("always_on wins over 0 for production, and previews still follow the forge", () => {
    expect(sleepWindow(at(0), true, true)).toEqual({ ms: null, why: "always_on" });
    expect(sleepWindow(at(0), false, true).ms).toBe(300_000);
  });

  test("a fixed setting is used as given", () => {
    const fixed = { kind: "fixed" as const, sleepAfterMs: { production: 700, preview: 900 } };
    expect(sleepWindow(fixed, true, false).ms).toBe(700);
    expect(sleepWindow(fixed, false, false).ms).toBe(900);
  });

  test("the asleep line names the window and the slider", () => {
    expect(asleepWords({ ms: 600_000, why: "economy 20" })).toBe(
      "asleep: nothing asked for it in 10 min (economy 20); the next request wakes it",
    );
  });
});

describe("app.always_on in forge.json", () => {
  const manifest = (app: Record<string, unknown>) =>
    parseManifest(JSON.stringify({ app: { run: "bun run s.ts", ...app } }), undefined);

  test("true is kept, false and unset follow the forge, anything else is refused", () => {
    const on = manifest({ always_on: true });
    expect(on.ok && on.value.alwaysOn).toBe(true);
    const off = manifest({ always_on: false });
    expect(off.ok && off.value.alwaysOn).toBeUndefined();
    const unset = manifest({});
    expect(unset.ok && unset.value.alwaysOn).toBeUndefined();
    const bad = manifest({ always_on: "yes" });
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(JSON.stringify(bad.error)).toContain("app.always_on must be true or false");
  });

  test("the app page says production is always on, and says nothing otherwise", () => {
    const env = { env: "production" as const, state: "running" as const, commitOid: "abc1234", url: "http://hello.apps.test" };
    const on = String(envFacts("/alice/hello", { ...env, alwaysOn: true }));
    expect(on).toContain("data-always-on");
    expect(on).toMatch(/<dt>Sleeps<\/dt><dd>never \(app\.always_on\)<\/dd>/);
    expect(on).not.toContain("profit slider");
    expect(String(envFacts("/alice/hello", env))).not.toContain("data-always-on");
  });
});
