import { describe, expect, test } from "bun:test";
import { parseWave, writeWave, type Wave } from "../src/story/wave.ts";

const wave = (): Wave => ({
  version: "0.7.81",
  date: "2026-10-15",
  headline: "Waves are files",
  highlights: [
    { title: "One", why: "because one" },
    { title: "Two", why: "because two" },
    { title: "Three", why: "because three" },
  ],
  pulls: [{ title: "#1 First", url: "https://forge.example/t/f/pulls/1" }],
});
const P = "waves/0.7.81.md";
const text = () => {
  const r = writeWave(wave());
  if (!r.ok) throw r.error;
  return r.value;
};
const bad = (t: string, re: RegExp) => {
  const r = parseWave(P, t);
  expect(r.ok).toBe(false);
  if (!r.ok) {
    expect(r.error.message).toContain(P);
    expect(r.error.message).toMatch(re);
  }
};

describe("wave file", () => {
  test("round-trips through write and parse", () => {
    const r = parseWave(P, text());
    expect(r).toEqual({ ok: true, value: wave() });
    const again = writeWave((r as { value: Wave }).value);
    expect(again).toEqual({ ok: true, value: text() });
  });
  test("an empty pull list round-trips", () => {
    const w = { ...wave(), pulls: [] };
    const t = writeWave(w);
    expect(t.ok && parseWave(P, t.value)).toEqual({ ok: true, value: w });
  });
  test("missing front matter, version, date, headline", () => {
    bad("# hi", /front matter/);
    bad(text().replace("version: 0.7.81\n", ""), /missing version/);
    bad(text().replace("version: 0.7.81", "version: soon"), /bad version/);
    bad(text().replace("date: 2026-10-15\n", ""), /missing date/);
    bad(text().replace("2026-10-15", "2026-02-30"), /bad date/);
    bad(text().replace("2026-10-15", "yesterday"), /bad date/);
    bad(text().replace("headline: Waves are files\n", ""), /missing headline/);
  });
  test("no, too few, too many highlights", () => {
    const t = text();
    const hs = t.split("\n").filter((l) => l.startsWith("- **"));
    bad(hs.reduce((a, l) => a.replace(l + "\n", ""), t), /no highlights/);
    bad(t.replace(hs[2]! + "\n", ""), /too few highlights/);
    const extra = ["- **Four** — w4", "- **Five** — w5", "- **Six** — w6"];
    bad(t.replace(hs[2]!, [hs[2]!, ...extra].join("\n")), /too many highlights/);
  });
  test("a highlight without a why, a bad pull line", () => {
    bad(text().replace("— because one", "—"), /no why/);
    bad(text().replace("- **One** — because one", "- One"), /bad highlight/);
    bad(text().replace("(https://forge.example/t/f/pulls/1)", "(javascript:x)"), /bad link/);
    bad(text() + "- stray\n", /bad pull line/);
  });
  test("writeWave refuses a malformed wave, naming the file", () => {
    const r = writeWave({ ...wave(), highlights: [] });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.message).toContain("waves/0.7.81.md");
    const s = writeWave({ ...wave(), date: "nope" });
    expect(s.ok).toBe(false);
  });
});
