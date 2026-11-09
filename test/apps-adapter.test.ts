import { describe, expect, test } from "bun:test";
import { EVERY_MAX, EVERY_MIN, parseAdapter } from "../src/apps/adapter.ts";
import { parseManifest } from "../src/apps/manifest.ts";

const forge = (extra: Record<string, unknown>): string =>
  JSON.stringify({ app: { run: "bun run src/server.ts" }, ...extra });

function refused(raw: unknown): string {
  const r = parseAdapter(raw);
  if (r.ok) throw new Error(`expected a refusal for ${JSON.stringify(raw)}`);
  return r.error;
}

describe("parseAdapter", () => {
  test("a valid block is plain data", () => {
    expect(parseAdapter({ schedule: { every: 900 } })).toEqual({
      ok: true,
      value: { schedule: { every: 900 } },
    });
  });

  test("the bounds are inclusive: 60 and 86400 seconds", () => {
    expect(EVERY_MIN).toBe(60);
    expect(EVERY_MAX).toBe(86_400);
    expect(parseAdapter({ schedule: { every: 60 } }).ok).toBe(true);
    expect(parseAdapter({ schedule: { every: 86_400 } }).ok).toBe(true);
  });

  test("an absent block is undefined", () => {
    expect(parseAdapter(undefined)).toEqual({ ok: true, value: undefined });
  });

  test("every out of range is refused, naming the field", () => {
    for (const every of [59, 86_401, 0, -60]) {
      expect(refused({ schedule: { every } })).toBe(
        "forge.json: adapter.schedule.every must be a whole number of seconds, 60–86400",
      );
    }
  });

  test("every that is not an integer is refused", () => {
    for (const every of [90.5, "900", null, true, Number.NaN]) {
      expect(refused({ schedule: { every } })).toContain("adapter.schedule.every");
    }
    expect(refused({ schedule: {} })).toContain("adapter.schedule.every");
  });

  test("unknown keys are refused at each level", () => {
    expect(refused({ schedule: { every: 900 }, url: "/pull" })).toBe(
      'forge.json: adapter takes only schedule, not "url"',
    );
    expect(refused({ schedule: { every: 900, jitter: 5 } })).toBe(
      'forge.json: adapter.schedule takes only every, not "jitter"',
    );
    expect(refused({ scheduel: { every: 900 } })).toContain('"scheduel"');
  });

  test("a block of the wrong shape is refused", () => {
    expect(refused(null)).toBe("forge.json: adapter must be an object");
    expect(refused([])).toBe("forge.json: adapter must be an object");
    expect(refused({})).toBe("forge.json: adapter.schedule is required");
    expect(refused({ schedule: 900 })).toBe("forge.json: adapter.schedule must be an object");
  });
});

describe("the manifest carries the adapter", () => {
  test("present: parsed onto the manifest", () => {
    const m = parseManifest(forge({ adapter: { schedule: { every: 3600 } } }), undefined);
    expect(m.ok && m.value.adapter).toEqual({ schedule: { every: 3600 } });
  });

  test("absent: undefined", () => {
    const m = parseManifest(forge({}), undefined);
    expect(m.ok).toBe(true);
    expect(m.ok && m.value.adapter).toBeUndefined();
  });

  test("a bad block fails the manifest and names the field", () => {
    const m = parseManifest(forge({ adapter: { schedule: { every: 30 } } }), undefined);
    expect(m).toEqual({
      ok: false,
      error: {
        kind: "invalid",
        message: "forge.json: adapter.schedule.every must be a whole number of seconds, 60–86400",
      },
    });
  });
});
