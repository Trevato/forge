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
      'forge.json: adapter takes only schedule, source and config, not "url"',
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

const good = {
  source: { name: "Shop API", hosts: ["api.shop.example"] },
  schedule: { every: 900 },
  config: {
    token: { type: "secret", env: "SHOP_TOKEN", required: true },
    page: { type: "number", env: "SHOP_PAGE", default: 50 },
  },
};

describe("source and config (#437)", () => {
  test("a block with source and config parses to plain data", () => {
    const r = parseAdapter(good);
    expect(r.ok && r.value?.source).toEqual({ name: "Shop API", hosts: ["api.shop.example"] });
    expect(r.ok && r.value?.config?.[0]?.required).toBe(true);
    expect(r.ok && r.value?.config?.[1]?.default).toBe(50);
  });

  test("source and config are optional beside schedule, and their stray keys are refused", () => {
    expect(parseAdapter({ schedule: { every: 900 } })).toEqual({ ok: true, value: { schedule: { every: 900 } } });
    expect(parseAdapter({ ...good, source: { ...good.source, url: "x" } }).ok).toBe(false);
    expect(parseAdapter({ ...good, config: { t: { type: "string", env: "T", value: "v" } } }).ok).toBe(false);
  });

  test("hosts are bare hostnames, never URLs, ports or addresses", () => {
    for (const h of ["https://a.example", "a.example:8080", "a.example/x", "127.0.0.1", "*.example.com", "localhost", "A.Example"])
      expect(parseAdapter({ ...good, source: { name: "x", hosts: [h] } }).ok).toBe(false);
    expect(parseAdapter({ ...good, source: { name: "x", hosts: [] } }).ok).toBe(false);
  });

  test("a secret names a variable and never holds a value", () => {
    const cfg = { token: { type: "secret", env: "T", default: "hunter2" } };
    expect(parseAdapter({ ...good, config: cfg }).ok).toBe(false);
  });

  test("a config field may not point at a variable the forge owns", () => {
    const cfg = { k: { type: "string", env: "FORGE_TOKEN" } };
    expect(parseAdapter({ ...good, config: cfg }).ok).toBe(false);
  });

  test("a default must match its type", () => {
    const cfg = { n: { type: "number", env: "N", default: "ten" } };
    expect(parseAdapter({ ...good, config: cfg }).ok).toBe(false);
  });

  test("the manifest carries it, and an invalid block fails the manifest", () => {
    const m = parseManifest(JSON.stringify({ app: { run: "bun x.ts" }, egress: ["api.shop.example"], adapter: good }), undefined);
    expect(m.ok && m.value.adapter?.source?.name).toBe("Shop API");
    const plain = parseManifest(JSON.stringify({ app: { run: "bun x.ts" } }), undefined);
    expect(plain.ok && plain.value.adapter).toBeUndefined();
    expect(parseManifest(JSON.stringify({ app: { run: "bun x.ts" }, adapter: { source: 1 } }), undefined).ok).toBe(false);
  });

  test("a source host egress does not list makes the block invalid: only egress opens a host", () => {
    const m = parseManifest(JSON.stringify({ app: { run: "bun x.ts" }, egress: ["cdn.example"], adapter: good }), undefined);
    expect(m.ok).toBe(false);
    expect(!m.ok && m.error.kind === "invalid" && m.error.message).toContain("api.shop.example");
    const opened = parseManifest(JSON.stringify({ app: { run: "bun x.ts" }, egress: ["cdn.example", "API.shop.example"], adapter: good }), undefined);
    expect(opened.ok && opened.value.egress).toEqual(["cdn.example", "api.shop.example"]);
  });
});
