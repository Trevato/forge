import { describe, expect, test } from "bun:test";
import { lean, plansOnly, visible, type Tool } from "../src/http/mcp/shared.ts";
import type { Ctx } from "../src/http/context.ts";
import type { User } from "../src/core/users.ts";

const tool = (over: Partial<Tool> = {}): Tool => ({
  name: "t",
  description: "",
  inputSchema: {},
  writes: true,
  run: () => ({ ok: true, value: null }),
  ...over,
});
const ctxOf = (scope: "ro" | "rw" | "admin"): Ctx => ({ auth: { scope } }) as unknown as Ctx;
const userOf = (isAdmin: boolean): User => ({ isAdmin }) as unknown as User;

describe("visible", () => {
  test("a plain tool is visible to everyone", () => {
    expect(visible(tool(), ctxOf("ro"), userOf(false))).toBe(true);
  });
  test("adminOnly is hidden from a non-admin and shown to an admin", () => {
    const t = tool({ adminOnly: true });
    expect(visible(t, ctxOf("admin"), userOf(false))).toBe(false);
    expect(visible(t, ctxOf("ro"), userOf(true))).toBe(true);
  });
  test("needsAdminScope wants an admin token, whoever the user is", () => {
    const t = tool({ needsAdminScope: true });
    expect(visible(t, ctxOf("ro"), userOf(true))).toBe(false);
    expect(visible(t, ctxOf("rw"), userOf(true))).toBe(false);
    expect(visible(t, ctxOf("admin"), userOf(true))).toBe(true);
  });
  test("both flags need both", () => {
    const t = tool({ adminOnly: true, needsAdminScope: true });
    expect(visible(t, ctxOf("admin"), userOf(false))).toBe(false);
    expect(visible(t, ctxOf("ro"), userOf(true))).toBe(false);
    expect(visible(t, ctxOf("admin"), userOf(true))).toBe(true);
  });
  test("an unset scope counts as ro", () => {
    const t = tool({ needsAdminScope: true });
    expect(visible(t, { auth: {} } as unknown as Ctx, userOf(true))).toBe(false);
  });
});

describe("plansOnly", () => {
  test("a plain write is not a plan", () => {
    expect(plansOnly(tool(), {})).toBe(false);
  });
  test("dryByDefault plans unless dryRun is false", () => {
    const t = tool({ dryByDefault: true });
    expect(plansOnly(t, {})).toBe(true);
    expect(plansOnly(t, { dryRun: true })).toBe(true);
    expect(plansOnly(t, { dryRun: "false" })).toBe(true);
    expect(plansOnly(t, { dryRun: false })).toBe(false);
  });
  test("readsWithout reads only while the key is absent", () => {
    const t = tool({ readsWithout: "x" });
    expect(plansOnly(t, {})).toBe(true);
    expect(plansOnly(t, { y: 1 })).toBe(true);
    expect(plansOnly(t, { x: 1 })).toBe(false);
    expect(plansOnly(t, { x: null })).toBe(false);
  });
  test("readsWithout as an array needs every key absent", () => {
    const t = tool({ readsWithout: ["x", "y"] });
    expect(plansOnly(t, {})).toBe(true);
    expect(plansOnly(t, { x: 1 })).toBe(false);
    expect(plansOnly(t, { y: 1 })).toBe(false);
    expect(plansOnly(t, { x: 1, y: 1 })).toBe(false);
  });
  test("readsWhen is honoured", () => {
    const t = tool({ readsWhen: (a) => a["action"] === "list" });
    expect(plansOnly(t, { action: "list" })).toBe(true);
    expect(plansOnly(t, { action: "delete" })).toBe(false);
  });
});

describe("lean", () => {
  test("strips length hints at every depth and keeps the rest", () => {
    const schema = {
      type: "object",
      required: ["a"],
      maxLength: 1,
      properties: {
        a: { type: "string", minLength: 1, maxLength: 9, enum: ["x"], description: "d" },
        b: {
          type: "array",
          minItems: 1,
          maxItems: 5,
          items: { type: "object", properties: { c: { type: "string", maxLength: 3 } } },
        },
        d: { anyOf: [{ type: "string", minLength: 2 }, { type: "number", minimum: 0 }] },
      },
    };
    expect(lean(schema)).toEqual({
      type: "object",
      required: ["a"],
      properties: {
        a: { type: "string", enum: ["x"], description: "d" },
        b: { type: "array", items: { type: "object", properties: { c: { type: "string" } } } },
        d: { anyOf: [{ type: "string" }, { type: "number", minimum: 0 }] },
      },
    });
  });
  test("scalars and null pass through", () => {
    expect(lean(null)).toBe(null);
    expect(lean(5)).toBe(5);
    expect(lean("maxLength")).toBe("maxLength");
  });
  test("a hint key at the top level is stripped too", () => {
    expect(lean({ maxItems: 3, keep: 1 })).toEqual({ keep: 1 });
  });
});
