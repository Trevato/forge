/** MCP `crew`, `health` and `capacity` draw ui:// cards: full and empty, escaped, linked. */
import { describe, expect, test } from "bun:test";
import { CARD_OF_TOOL, cardFor } from "../src/web/studio/cards.ts";

const O = "https://forge.test";
const EVIL = "<img src=x onerror=1>";

describe("crew card", () => {
  test("bound to the crew card", () => {
    expect(CARD_OF_TOOL["crew"]).toBe("crew");
    expect(CARD_OF_TOOL["health"]).toBe("health");
    expect(CARD_OF_TOOL["capacity"]).toBe("capacity");
  });
  const seats = (by: string[]) => ({ auto: true, mode: "on", seats: [{ role: "builder", by, does: "x", ...(by.length === 0 ? { without: "nothing gets built" } : {}), state: "filled" }] });
  test("full: who fills each seat and what is running, linked", () => {
    const c = cardFor("crew", { crew: [{ username: "scout" }], seats: seats(["scout", EVIL]), slots: [{ role: "builder", running: 1, waiting: 2 }] }, O, { repo: "a/b" })!;
    expect(c.status).toBe("1 on the crew of a/b");
    expect(c.rows).toEqual([{ label: "builder", value: `scout, ${EVIL} · 1 running · 2 waiting`, link: `${O}/a/b/settings/crew` }]);
  });
  test("empty: the seat says what it costs; a week or a plan draws nothing", () => {
    const c = cardFor("crew", { crew: [], seats: seats([]), slots: [] }, O, { repo: "a/b" })!;
    expect(c.rows[0]!.value).toBe("empty — nothing gets built");
    expect(cardFor("crew", { days: 7, members: [] }, O)).toBeUndefined();
    expect(cardFor("crew", { agent: "x", changes: true, says: "plan" }, O)).toBeUndefined();
  });
  test("now still draws its list", () => {
    expect(cardFor("now", [], O)!.status).toBe("nothing running");
  });
});

describe("health card", () => {
  test("full: red with its causes", () => {
    const c = cardFor("health", { ok: false, version: "1.2", draining: true, rollout: { state: "blocked", reason: EVIL }, degraded: [{ cause: "queue:agent", sentence: "Queue is long.", href: "/flow" }], incidents: [{ key: "k", message: "m" }], apps: { serving: 3, asleep: 1, previews: 2 } }, O)!;
    expect(c.status).toBe("red · 1.2");
    expect(c.rows.map((r) => r.label)).toEqual(["Draining", "Rollout", "Needs attention", "Incident", "Apps"]);
    expect(c.rows[1]!.value).toContain(EVIL);
    expect(c.rows[0]!.link).toBe(`${O}/`);
    expect(c.rows[2]).toEqual({ label: "Needs attention", value: "Queue is long.", link: `${O}/flow` });
    expect(JSON.stringify(c)).not.toContain("queue:agent");
    expect(c.rows[4]!.link).toBe(`${O}/`);
  });
  test("empty: green, no rows, even for a stranger's answer", () => {
    const c = cardFor("health", { ok: true, version: "1.2", commit: null, draining: false }, O)!;
    expect(c.status).toBe("green · 1.2");
    expect(c.rows).toEqual([]);
    expect(cardFor("health", "nope", O)).toBeUndefined();
  });
});

describe("capacity card", () => {
  test("full: a row per setting, set ones marked, linked", () => {
    const c = cardFor("capacity", { settings: [{ key: "crew.concurrency", label: "Speed", value: "4", source: "setting" }, { key: "x", label: EVIL, value: "", source: "default" }], selfSwap: { blocked: null } }, O)!;
    expect(c.status).toBe("2 settings");
    expect(c.rows[0]).toEqual({ label: "Speed", value: "4 · set", link: `${O}/settings/capacity` });
    expect(c.rows[1]).toMatchObject({ label: EVIL, value: "auto" });
  });
  test("empty and a blocked swap; a plan draws nothing", () => {
    const c = cardFor("capacity", { settings: [], selfSwap: { blocked: "no kernel" } }, O)!;
    expect(c.rows).toEqual([]);
    expect(c.status).toBe("cannot swap itself: no kernel");
    expect(cardFor("capacity", { says: "Would set" }, O)).toBeUndefined();
  });
});

describe("caps: rows shown and the count agree", () => {
  test("crew seats, degraded causes and capacity settings are cut with a More row", () => {
    const seatList = Array.from({ length: 15 }, (_, i) => ({ role: `r${i}`, by: ["x"] }));
    const crew = cardFor("crew", { crew: [], seats: { seats: seatList }, slots: [] }, O, { repo: "a/b" })!;
    expect(crew.rows.length).toBe(13);
    expect(crew.rows[12]!.value).toBe("3 more not shown");
    const degraded = Array.from({ length: 14 }, () => ({ cause: "c", sentence: "s", href: "/" }));
    const health = cardFor("health", { ok: false, degraded }, O)!;
    expect(health.rows.at(-1)).toMatchObject({ label: "More", value: "2 more not shown" });
    const settings = Array.from({ length: 25 }, (_, i) => ({ label: `s${i}`, value: "1", source: "default" }));
    const cap = cardFor("capacity", { settings }, O)!;
    expect(cap.status).toBe("25 settings");
    expect(cap.rows.length).toBe(21);
    expect(cap.rows[20]!.value).toBe("5 more not shown");
  });
});
