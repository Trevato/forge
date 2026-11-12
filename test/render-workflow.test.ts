/** A workflow as its jobs: triggers, needs, a matrix, escaping, the fallback, the registry. */
import { describe, expect, test } from "bun:test";
import { fileKind, kindByName } from "../src/web/render/kinds.ts";
import { RENDERERS } from "../src/web/render/renderers.ts";
import { parseWorkflow, workflow } from "../src/web/render/workflow.ts";

const enc = (s: string): Uint8Array => new TextEncoder().encode(s);
const draw = (text: string) => workflow({ path: ".github/workflows/ci.yml", size: text.length, body: enc(text), media: "/m", download: "/d" });
const html = (r: ReturnType<typeof draw>): string => String(r.content);

const CI = `name: CI
on:
  push:
    branches: [main]
  pull_request:
jobs:
  test:
    runs-on: \${{ matrix.os }}
    strategy:
      matrix:
        os: [ubuntu-latest, macos-latest]
        bun: [1, 2]
    steps:
      - uses: actions/checkout@v4
      - name: <script>alert(1)</script>
        run: |
          bun install
          bun test
  deploy:
    needs: [test]
    runs-on: ubuntu-latest
    steps:
      - run: echo "<img src=x onerror=1>"
`;

describe("workflow", () => {
  test("the registry names workflow files and a renderer draws them", () => {
    for (const p of [".github/workflows/ci.yml", "a/.github/workflows/x.yaml"]) {
      expect(fileKind(p, enc("on: push"))).toBe("workflow");
      expect(kindByName(p)).toBe("workflow");
    }
    expect(fileKind(".github/workflows/notes.md", enc("x"))).not.toBe("workflow");
    expect(fileKind(".github/other/ci.yml", enc("x"))).not.toBe("workflow");
    expect(RENDERERS.workflow).toBe(workflow);
  });

  test("triggers, needs, matrix and steps", () => {
    const w = parseWorkflow(CI);
    if ("error" in w) throw new Error(w.error);
    expect(w.triggers).toEqual(["push", "pull_request"]);
    expect(w.jobs.map((j) => j.id)).toEqual(["test", "deploy"]);
    expect(w.jobs[0]!.matrix).toEqual(["os: ubuntu-latest, macos-latest", "bun: 1, 2"]);
    expect(w.jobs[0]!.steps[1]!.does).toBe("bun install");
    expect(w.jobs[1]!.needs).toEqual(["test"]);
    const out = html(draw(CI));
    expect(out).toContain("Runs on <code>push</code> <code>pull_request</code>");
    expect(out).toContain("<dt>Needs</dt><dd><code>test</code></dd>");
    expect(out).toContain("uses <code>actions/checkout@v4</code>");
    expect(out).toContain("Matrix");
  });

  test("every value is escaped", () => {
    const out = html(draw(CI));
    expect(out).not.toContain("<script>");
    expect(out).not.toContain("<img");
    expect(out).toContain("&lt;script&gt;");
  });

  test("a file that is not a workflow falls back with a reason", () => {
    expect(draw("a: [").fallback).toContain("is shown as YAML because it is not drawn as a workflow: it is not valid YAML");
    expect(draw("on: push\n").fallback).toContain("no jobs");
    expect(draw("- a\n").fallback).toContain("not a map");
  });
});

describe("workflow edges", () => {
  test("a matrix with include and exclude, and a file of two documents", () => {
    const w = parseWorkflow("on: push\njobs:\n  t:\n    runs-on: x\n    strategy:\n      matrix:\n        v: [1]\n        include: [{v: 2}, {v: 3}]\n        exclude: [{v: 1}]\n");
    if ("error" in w) throw new Error(w.error);
    expect(w.jobs[0]!.matrix).toEqual(["v: 1", "include: 2 entries", "exclude: 1 entry"]);
    expect(draw("on: push\njobs: {}\n---\na: 1\n").fallback).toContain("not one YAML document");
  });
});
