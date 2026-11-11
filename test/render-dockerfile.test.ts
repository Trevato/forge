/** A Dockerfile as its stages: two stages, continuation, comments, escaping, the fallback, the registry. */
import { describe, expect, test } from "bun:test";
import { dockerfile, parseDockerfile, ROW_CAP } from "../src/web/render/dockerfile.ts";
import { fileKind, kindByName } from "../src/web/render/kinds.ts";
import { RENDERERS } from "../src/web/render/renderers.ts";

const enc = (s: string): Uint8Array => new TextEncoder().encode(s);
const draw = (text: string, path = "Dockerfile") => dockerfile({ path, size: text.length, body: enc(text), media: "/m", download: "/d" });

const TWO = `# build it
ARG V=1
FROM --platform=linux/amd64 oven/bun:1 AS build
ENV NODE_ENV=production TOKEN="a b"
WORKDIR /app
RUN bun install \\
  # not part of it
  && bun build
FROM debian:12
EXPOSE 3000 8080/udp
COPY --from=build /app/out /srv
CMD ["/srv/app"]
`;

describe("dockerfile", () => {
  test("the registry names the files and a renderer draws them", () => {
    for (const p of ["Dockerfile", "a/Containerfile", "api.Dockerfile", "x/dev.dockerfile", "dockerfile"]) {
      expect(fileKind(p, enc("FROM a"))).toBe("dockerfile");
      expect(kindByName(p)).toBe("dockerfile");
    }
    expect(fileKind("Dockerfile.md", enc("x"))).not.toBe("dockerfile");
    expect(RENDERERS.dockerfile).toBe(dockerfile);
  });

  test("two stages: images, names, ports, env names, rows", () => {
    const d = parseDockerfile(TWO);
    if ("error" in d) throw new Error(d.error);
    expect(d.stages.map((s) => [s.image, s.name])).toEqual([["", ""], ["oven/bun:1", "build"], ["debian:12", ""]]);
    expect(d.stages[1]!.env).toEqual(["NODE_ENV", "TOKEN"]);
    expect(d.stages[2]!.ports).toEqual(["3000", "8080/udp"]);
    expect(d.stages[0]!.rows).toEqual([{ keyword: "ARG", args: "V=1" }]);
    const h = String(draw(TWO).content);
    expect(h).toContain("Stage 1: oven/bun:1 as build");
    expect(h).toContain("Stage 2: debian:12");
    expect(h).not.toContain("a b");
    expect(h).toContain("<code>NODE_ENV</code>");
  });

  test("a continued RUN is one row and a comment is dropped", () => {
    const d = parseDockerfile(TWO);
    if ("error" in d) throw new Error(d.error);
    const run = d.stages[1]!.rows.find((r) => r.keyword === "RUN")!;
    expect(run.args).toBe("bun install && bun build");
    expect(String(draw(TWO).content)).not.toContain("build it");
    expect(String(draw(TWO).content)).not.toContain("not part of it");
  });

  test("a value with <script> is escaped", () => {
    const h = String(draw('FROM <script>alert(1)</script> AS <b>\nRUN echo "<script>x</script>"\nEXPOSE <i>\nENV <u>=1').content);
    expect(h).not.toContain("<script>");
    expect(h).not.toContain("<b>");
    expect(h).toContain("&lt;script&gt;");
  });

  test("an unparsable file falls back to the source with a reason", () => {
    for (const bad of ["hello world\nthis is not docker", "RUN ls\nFROM a", "ARG x=1", ""]) {
      const r = draw(bad);
      expect(r.fallback).toContain("not drawn");
    }
  });

  test("a heredoc body is skipped to its terminator, not read as instructions", () => {
    const text = "FROM a\nRUN <<EOF\nnot an instruction\n# nor this\nEOF\nCOPY <<-'X' /f\n\tbogus line\n\tX\nUSER me\n";
    const d = parseDockerfile(text);
    if ("error" in d) throw new Error(d.error);
    expect(d.stages[0]!.rows.map((r) => r.keyword)).toEqual(["RUN", "COPY", "USER"]);
    expect(draw(text).fallback).toBeUndefined();
    expect(String(draw(text).content)).not.toContain("not an instruction");
  });

  test("the stage count is said once", () => {
    const r = draw(TWO);
    expect(String(r.content)).not.toContain("2 stages");
    expect(r.summary).toContain("2 stages");
  });

  test("the instruction cap", () => {
    const r = draw("FROM a\n" + "RUN x\n".repeat(ROW_CAP + 3));
    expect(String(r.content)).toContain("3 more instructions not shown");
  });
});
