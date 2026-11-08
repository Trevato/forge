import { expect, test } from "bun:test";
import { lastBaseline, loadArgs, loadCheckHint } from "../src/perf/baseline.ts";

test("the baseline is the newest kept result older than the release", () => {
  const files = ["0.7.9.json", "0.7.10.json", "0.7.12.json", "notes.md", "x.json"];
  expect(lastBaseline(files, "0.7.11")).toBe("0.7.10.json");
  expect(lastBaseline(files, "0.7.13")).toBe("0.7.12.json");
  expect(lastBaseline(files, "0.7.9")).toBeUndefined();
  expect(lastBaseline([], "1.0.0")).toBeUndefined();
});

test("an edge result is compared only with an edge result, a bypass result only with a bypass one (#9514)", () => {
  const files = ["0.7.9.json", "0.7.9.bypass.json", "0.7.10.json", "0.7.8.bypass.json"];
  expect(lastBaseline(files, "0.7.11")).toBe("0.7.10.json");
  expect(lastBaseline(files, "0.7.11", "edge")).toBe("0.7.10.json");
  expect(lastBaseline(files, "0.7.11", "bypass")).toBe("0.7.9.bypass.json");
  expect(lastBaseline(files, "0.7.9", "bypass")).toBe("0.7.8.bypass.json");
  expect(lastBaseline(["9514-in-process-bypass.json"], "1.0.0", "bypass")).toBeUndefined();
  const b = loadArgs(["--url", "http://c", "--repo", "o/r"], "0.7.11", "/r", "0.7.9.bypass.json", "bypass");
  expect(b).toContain("--bypass");
  expect(b.slice(b.indexOf("--out"), b.indexOf("--out") + 2)).toEqual(["--out", "/r/0.7.11.bypass.json"]);
  expect(b.slice(-2)).toEqual(["--compare", "/r/0.7.9.bypass.json"]);
  expect(loadArgs([], "0.7.11", "/r", undefined)).not.toContain("--bypass");
});

test("release-load refuses a bad version, a missing --url and a missing --repo", async () => {
  const refused = async (args: string[]) => {
    const p = Bun.spawn(["bun", "scripts/release-load.ts", ...args], { stdout: "pipe", stderr: "pipe" });
    const [code, err] = await Promise.all([p.exited, new Response(p.stderr).text()]);
    expect(err).toContain("usage: bun scripts/release-load.ts");
    return code;
  };
  expect(await refused(["nope", "--url", "http://c", "--repo", "o/r"])).toBe(2);
  expect(await refused(["0.7.11", "--repo", "o/r"])).toBe(2);
  expect(await refused(["0.7.11", "--url", "http://c"])).toBe(2);
});

test("the bench arguments carry the version, the output file, defaults and --compare when a baseline is kept", () => {
  const a = loadArgs(["--url", "http://c", "--repo", "o/r"], "0.7.11", "/r", "0.7.10.json");
  expect(a).toEqual(["--url", "http://c", "--repo", "o/r", "--version", "0.7.11", "--out", "/r/0.7.11.json", "--rate", "500", "--seconds", "20", "--warm", "20", "--compare", "/r/0.7.10.json"]);
  const b = loadArgs(["--rate", "100", "--seconds", "5"], "1.0.0", "/r", undefined);
  expect(b).not.toContain("--compare");
  expect(b.filter((x) => x === "--rate")).toEqual(["--rate"]);
  expect(b).toContain("100");
});

test("cut-release names the load check on stderr and keeps stdout the JSON record alone", async () => {
  // A version far ahead of any release, without --tag: nothing is written.
  const p = Bun.spawn(["bun", "scripts/cut-release.ts", "999.0.0"], { stdout: "pipe", stderr: "pipe" });
  const [code, out, err] = await Promise.all([p.exited, new Response(p.stdout).text(), new Response(p.stderr).text()]);
  expect(code).toBe(0);
  expect(err).toContain(loadCheckHint("999.0.0"));
  expect(err).toContain("bun scripts/release-load.ts 999.0.0 --url");
  expect(out.trim().split("\n")).toHaveLength(1);
  expect(JSON.parse(out).version).toBe("999.0.0");
  expect(out).not.toContain("release-load");
});
