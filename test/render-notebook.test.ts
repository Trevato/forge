/** A notebook as cells and outputs: hostile HTML output stays inert text. */
import { describe, expect, test } from "bun:test";
import { notebook } from "../src/web/render/notebook.ts";
import { fileKind, RENDER_CAP } from "../src/web/render/kinds.ts";
import { RENDERERS, rendererFor } from "../src/web/render/renderers.ts";

const enc = (s: string): Uint8Array => new TextEncoder().encode(s);
const draw = (s: string) => notebook({ path: "a.ipynb", size: s.length, body: enc(s), media: "/m", download: "/d" });
const PNG = "iVBORw0KGgo=";
const NB = JSON.stringify({
  cells: [
    { cell_type: "markdown", source: ["# Title\n", "some *prose*"] },
    {
      cell_type: "code",
      execution_count: 3,
      source: "print('<b>x</b>')",
      outputs: [
        { output_type: "stream", name: "stdout", text: ["a < b\n"] },
        { output_type: "display_data", data: { "image/png": PNG, "text/plain": "<Figure>" } },
        { output_type: "execute_result", data: { "text/html": ["<script>alert(1)</script>"], "application/javascript": "alert(2)" } },
        { output_type: "display_data", data: { "image/png": '"onerror="alert(3)' } },
      ],
    },
  ],
});

describe("notebooks", () => {
  test("the registry names .ipynb and a renderer draws it", () => {
    expect(fileKind("x/a.ipynb", enc("{}"))).toBe("notebook");
    expect(RENDERERS.notebook).toBe(notebook);
  });

  test("cells, outputs, and hostile HTML arrives escaped", () => {
    const r = draw(NB);
    const out = String(r.content);
    expect(r.fallback).toBeUndefined();
    expect(out).toContain("<h1");
    expect(out).toContain("In [3]:");
    expect(out).toContain("a &lt; b");
    expect(out).toContain(`<img class="nb-img" alt="Notebook output" src="data:image/png;base64,${PNG}"`);
    expect(out).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(out).not.toContain("<script");
    expect(out).toContain("&lt;b&gt;x&lt;/b&gt;");
    expect(out).not.toContain("onerror");
    expect(out.match(/<img/g)?.length).toBe(1);
  });

  test("invalid JSON, or no cells, falls back with a reason", () => {
    expect(draw("{nope").fallback).toContain("not valid JSON");
    expect(draw("[]").fallback).toContain("no cells");
  });

  test("a notebook over the cap is not handed to the renderer", () => {
    const big = { kind: "text", size: RENDER_CAP.notebook + 1, body: enc("{}") } as never;
    expect(rendererFor("a.ipynb", big)).toBeUndefined();
    expect(rendererFor("a.ipynb", { kind: "text", size: 2, body: enc("{}") } as never)?.render).toBe(notebook);
  });
});

describe("notebook edge cases", () => {
  test("JPEG output is a picture and an error loses its colour codes", () => {
    const out = String(
      draw(
        JSON.stringify({
          cells: [
            {
              cell_type: "code",
              source: "x",
              outputs: [
                { output_type: "display_data", data: { "image/jpeg": "/9j/4AAQ\n" } },
                { output_type: "error", ename: "E", evalue: "v", traceback: ["\x1b[31mBoom\x1b[0m <b>"] },
              ],
            },
          ],
        }),
      ).content,
    );
    expect(out).toContain('src="data:image/jpeg;base64,/9j/4AAQ"');
    expect(out).toContain("Boom &lt;b&gt;");
    expect(out).not.toContain("\x1b");
  });

});
