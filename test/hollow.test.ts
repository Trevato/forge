/**
 * Hollow work does not pass the gate (#615, #739): an exported action that
 * nothing that runs reaches, or a screen no page links to, is named by
 * `scripts/hollow.ts` unless `scripts/hollow-allow.ts` lists it under an
 * owning issue.
 *
 * @tree-scan: `scripts/hollow.ts` reads the whole of src/ through the gate.
 */

import { describe, expect, test } from "bun:test";
import { EXCLUDED } from "../scripts/gate.ts";
import { audit, hollow, readSources } from "../scripts/hollow.ts";

const root = new URL("..", import.meta.url).pathname;
/** Reading the whole tree takes a second, and many on a busy machine. */
const WHOLE_TREE = 60_000;
const ids = (files: Record<string, string>): string[] =>
  hollow(new Map(Object.entries(files))).map((h) => h.id);

describe("the repository", () => {
  test(
    "carries no hollow work beyond what is allowed, and allows nothing that is reached",
    () => {
      expect(audit(readSources(root))).toEqual([]);
    },
    WHOLE_TREE,
  );

  // The audit hangs on this tree's own shape: where the surfaces are, and
  // which function draws a page. If either moves, this goes red rather than
  // the audit going quiet.
  test(
    "planted in this tree, an uncalled action and an unlinked screen are both named",
    () => {
      const planted = readSources(root);
      planted.set(
        "src/actions/zz-planted.ts",
        "export function zzPlanted(): void {}",
      );
      planted.set(
        "src/web/pages/zz-planted.ts",
        `import { page } from "../layout.ts";
       export const zzPage = (): Response => page({} as never);`,
      );
      planted.set(
        "src/http/zz-planted.ts",
        `import { zzPage } from "../web/pages/zz-planted.ts";
       export function zzRoutes(router: { add(m: string, p: string, h: unknown): void }): void {
         router.add("GET", "/zz-planted", zzPage);
       }`,
      );
      const found = hollow(planted).map((h) => h.id);
      expect(found).toContain("src/actions/zz-planted.ts#zzPlanted");
      expect(found).toContain("GET /zz-planted");
    },
    WHOLE_TREE,
  );

  test("this guard is itself in the gate: no exclusion names it", () => {
    const excluded = EXCLUDED.map((e) => e.file);
    expect(excluded).not.toContain("test/hollow.test.ts");
    expect(excluded).not.toContain("test/hollow-cli.test.ts");
  });
});

describe("an action nothing that runs reaches", () => {
  // The shape that sat on main: an action, its helper, and only tests calling.
  const SPAWN = `
    export const LIMIT = 3;
    export const childDirOf = (id: string): string => "children/" + id;
    export async function spawnForge(id: string): Promise<string> {
      return childDirOf(id);
    }
  `;
  /** Where the program starts: it runs `name` from `file`, as src/main.ts runs the server. */
  const runs = (file: string, name: string): Record<string, string> => ({
    "src/main.ts": `import { ${name} } from "./${file}"; ${name}();`,
  });

  test("is named, with the helper only it uses; a constant is not an action", () => {
    expect(ids({ "src/actions/spawn.ts": SPAWN })).toEqual([
      "src/actions/spawn.ts#childDirOf",
      "src/actions/spawn.ts#spawnForge",
    ]);
  });

  test("is called once what runs calls it, in a route, a page, the crew, the CLI or the terminal; a caller that never runs is no caller", () => {
    for (const surface of ["http", "web", "crew", "cli", "tui"]) {
      const files = {
        "src/actions/spawn.ts": SPAWN,
        [`src/${surface}/door.ts`]: `
          import { spawnForge } from "../actions/spawn.ts";
          export const door = () => spawnForge("a");
        `,
      };
      expect(ids(files)).toHaveLength(2);
      expect(ids({ ...files, ...runs(`${surface}/door.ts`, "door") })).toEqual(
        [],
      );
    }
  });

  test("a page function no route names does not make its action called; a route does, once its table is run", () => {
    const files = {
      "src/actions/spawn.ts": `export function spawnForge(): number { return 1; }`,
      "src/web/pages/spawn.ts": `
        import { spawnForge } from "../../actions/spawn.ts";
        export const spawnPage = (): Response => new Response(String(spawnForge()));
      `,
    };
    expect(ids(files)).toEqual(["src/actions/spawn.ts#spawnForge"]);
    const routed = {
      ...files,
      "src/http/server.ts": `
        import { spawnPage } from "../web/pages/spawn.ts";
        export function routes(router: { add(m: string, p: string, h: unknown): void }): void {
          router.add("POST", "/spawn", spawnPage);
        }
      `,
    };
    // A table of routes that nothing calls registers nothing.
    expect(ids(routed)).toEqual(["src/actions/spawn.ts#spawnForge"]);
    expect(ids({ ...routed, ...runs("http/server.ts", "routes") })).toEqual([]);
  });

  test("an import() in a function nothing calls loads nothing; one that runs reaches the whole module", () => {
    const action = {
      "src/actions/spawn.ts": `export function spawnForge(): number { return 1; }`,
    };
    const lazy = `
      export async function lazy(): Promise<number> {
        const m = await import("../../actions/spawn.ts");
        return m.spawnForge();
      }
      export const other = (): number => 1;
    `;
    // A page no route names: nothing loads it at all.
    expect(ids({ ...action, "src/web/pages/lazy.ts": lazy })).toEqual([
      "src/actions/spawn.ts#spawnForge",
    ]);
    // Its file is loaded and another of its functions runs: `lazy` still does not.
    expect(
      ids({
        ...action,
        "src/web/pages/lazy.ts": lazy,
        ...runs("web/pages/lazy.ts", "other"),
      }),
    ).toEqual(["src/actions/spawn.ts#spawnForge"]);
    expect(
      ids({
        ...action,
        "src/web/pages/lazy.ts": lazy,
        ...runs("web/pages/lazy.ts", "lazy"),
      }),
    ).toEqual([]);
    // At the top level of a file that is loaded, it runs.
    expect(
      ids({
        ...action,
        "src/main.ts": `const m = await import("./actions/spawn.ts"); m.spawnForge();`,
      }),
    ).toEqual([]);
  });

  test("a file nothing loads runs nothing: its top-level call is no call until a loaded file imports it", () => {
    const files = {
      "src/actions/sweep.ts": `export function sweep(): void {}`,
      "src/tools/orphan.ts": `import { sweep } from "../actions/sweep.ts"; sweep();`,
    };
    expect(ids(files)).toEqual(["src/actions/sweep.ts#sweep"]);
    // Loaded by an entry, for its side effect or through another file.
    expect(
      ids({ ...files, "src/main.ts": `import "./tools/orphan.ts";` }),
    ).toEqual([]);
    expect(
      ids({
        ...files,
        "src/main.ts": `import { boot } from "./boot.ts"; boot();`,
        "src/boot.ts": `import "./tools/orphan.ts"; export const boot = (): void => {};`,
      }),
    ).toEqual([]);
    // An import() of it in a function nothing calls does not load it.
    expect(
      ids({
        ...files,
        "src/main.ts": `export const never = () => import("./tools/orphan.ts");`,
      }),
    ).toEqual(["src/actions/sweep.ts#sweep"]);
  });

  test("the server, the CLI, the terminal, a git hook and the restore are where running starts, and nowhere else", () => {
    const action = {
      "src/actions/sweep.ts": `export function sweep(): void {}`,
    };
    for (const [entry, up] of [
      ["src/main.ts", "."],
      ["src/cli/main.ts", ".."],
      ["src/tui/main.ts", ".."],
      ["src/git/hook-entry.ts", ".."],
      ["src/snapshot/restore.ts", ".."],
    ] as const)
      expect(
        ids({
          ...action,
          [entry]: `import { sweep } from "${up}/actions/sweep.ts"; sweep();`,
        }),
      ).toEqual([]);
    for (const other of ["src/tui/gallery.ts", "src/web/main.ts", "src/x.ts"])
      expect(
        ids({
          ...action,
          [other]: `import { sweep } from "${other.split("/").length > 2 ? ".." : "."}/actions/sweep.ts"; sweep();`,
        }),
      ).toEqual(["src/actions/sweep.ts#sweep"]);
  });

  test("is not called by a file that runs unless the function that calls it is reached", () => {
    const door = `
      import { spawnForge } from "../actions/spawn.ts";
      export const spawnDoor = () => spawnForge("a");
      export const unrelated = () => 1;
    `;
    const files = { "src/actions/spawn.ts": SPAWN, "src/spawn/door.ts": door };
    expect(ids(files)).toHaveLength(2);
    // The file is used, but not the function that calls the action.
    expect(
      ids({
        ...files,
        "src/http/api.ts": `import { unrelated } from "../spawn/door.ts"; export const n = unrelated;`,
        ...runs("http/api.ts", "n"),
      }),
    ).toHaveLength(2);
    expect(
      ids({
        ...files,
        "src/http/api.ts": `import { spawnDoor } from "../spawn/door.ts"; export const go = spawnDoor;`,
        ...runs("http/api.ts", "go"),
      }),
    ).toEqual([]);
  });

  test("is called through another action, and through a renamed import", () => {
    const files = {
      "src/actions/access.ts": `export function requireWriter(): boolean { return true; }`,
      "src/actions/issues.ts": `
        import { requireWriter as may } from "./access.ts";
        export function closeIssue(): boolean { return may(); }
      `,
    };
    expect(ids(files)).toEqual([
      "src/actions/access.ts#requireWriter",
      "src/actions/issues.ts#closeIssue",
    ]);
    expect(
      ids({
        ...files,
        "src/http/api.ts": `import { closeIssue } from "../actions/issues.ts"; export const r = () => closeIssue();`,
        ...runs("http/api.ts", "r"),
      }),
    ).toEqual([]);
  });

  test("a helper that a called action of the same file uses is called, whoever else imports it", () => {
    expect(
      ids({
        "src/actions/spend.ts": `
          export function spanSince(): number { return 1; }
          export function readSpend(): number { return spanSince(); }
        `,
        "src/web/pages/board.ts": `import { readSpend } from "../../actions/spend.ts"; export const board = readSpend;`,
        ...runs("web/pages/board.ts", "board"),
      }),
    ).toEqual([]);
  });

  test("two that call only each other are both named", () => {
    expect(
      ids({
        "src/actions/loop.ts": `
          export function a(n: number): number { return n > 0 ? b(n - 1) : 0; }
          export function b(n: number): number { return a(n); }
          export function c(): number { return 1; }
        `,
        "src/web/pages/x.ts": `import { c } from "../../actions/loop.ts"; export const x = c;`,
        ...runs("web/pages/x.ts", "x"),
      }),
    ).toEqual(["src/actions/loop.ts#a", "src/actions/loop.ts#b"]);
  });

  test("a type import, a property, a parameter and a comment that spell its name are not calls, in code that runs", () => {
    expect(
      ids({
        "src/actions/spawn.ts": `export function spawnForge(): number { return 1; }`,
        "src/http/api.ts": `
          import type { spawnForge } from "../actions/spawn.ts";
          import { type spawnForge as Spawn } from "../actions/spawn.ts";
          // spawnForge() is called here, says the comment
          export const table = { spawnForge: 1 };
          export function f(spawnForge: number, o: { spawnForge: number }): number {
            return o.spawnForge + spawnForge;
          }
          export type T = typeof spawnForge | Spawn;
        `,
        "src/main.ts": `import { f, table, type T } from "./http/api.ts"; f(table.spawnForge, table as unknown as T & typeof table);`,
      }),
    ).toEqual(["src/actions/spawn.ts#spawnForge"]);
  });

  test("a namespace import, import(), a barrel and `export *` all reach it", () => {
    const action = {
      "src/actions/spawn.ts": `export function spawnForge(): number { return 1; }`,
    };
    const callers = [
      `import * as spawn from "../actions/spawn.ts"; export const go = () => spawn.spawnForge();`,
      `export const go = async () => (await import("../actions/spawn.ts")).spawnForge();`,
      `import { spawnForge } from "../actions/index.ts"; export const go = spawnForge;`,
      `import { birth } from "../actions/index.ts"; export const go = birth;`,
      `import { spawnForge } from "../actions/all.ts"; export const go = spawnForge;`,
    ];
    for (const caller of callers)
      expect(
        ids({
          ...action,
          "src/actions/index.ts": `export { spawnForge, spawnForge as birth } from "./spawn.ts";`,
          "src/actions/all.ts": `export * from "./spawn.ts";`,
          "src/http/api.ts": caller,
          ...runs("http/api.ts", "go"),
        }),
      ).toEqual([]);
  });

  test("an alias is named as it is exported, a default export as `default`, and both are followed", () => {
    const files = {
      "src/actions/a.ts": `
        function inner(): number { return 1; }
        export { inner as outer };
        export default function main(): number { return 2; }
      `,
    };
    expect(ids(files)).toEqual([
      "src/actions/a.ts#default",
      "src/actions/a.ts#outer",
    ]);
    expect(
      ids({
        ...files,
        "src/http/api.ts": `import main, { outer } from "../actions/a.ts"; export const go = () => main() + outer();`,
        ...runs("http/api.ts", "go"),
      }),
    ).toEqual([]);
  });

  test("a module's own top-level statement is a call; an unused constant holding one is not", () => {
    const sweep = {
      "src/actions/sweep.ts": `export function sweep(): void {}`,
    };
    expect(
      ids({
        ...sweep,
        "src/main.ts": `import { sweep } from "./actions/sweep.ts"; sweep();`,
      }),
    ).toEqual([]);
    expect(
      ids({
        ...sweep,
        "src/main.ts": `import { sweep } from "./actions/sweep.ts"; const later = () => sweep();`,
      }),
    ).toEqual(["src/actions/sweep.ts#sweep"]);
  });

  test("the line names it, says what would call it, and where the allow-list is", () => {
    expect(
      hollow(
        new Map([
          [
            "src/actions/spawn.ts",
            "export function spawnForge(): number { return 1; }",
          ],
        ]),
      ).map((h) => h.line),
    ).toEqual([
      "src/actions/spawn.ts#spawnForge is exported and nothing that runs reaches it: call it from a route, a routed page or an MCP tool, or list it in ALLOWED (scripts/hollow-allow.ts) with the issue that owns it",
    ]);
  });
});

describe("a screen no page links to", () => {
  const LAYOUT = `
    export function page(body: string): Response { return new Response(body); }
    export function redirect(to: string): Response { return new Response(to); }
  `;
  const HOME = (body: string) => `
    import { page } from "../layout.ts";
    export const home = (): Response => page(${JSON.stringify(body)});
  `;
  // The fleet graph as it shipped: a page whose form posts to itself, a
  // fragment its own chart refetches, a file to download, and no way in.
  const GRAPH = `
    import { page } from "../layout.ts";
    import { chart } from "../fleet-graph.ts";
    export const fleetGraphPage = (): Response =>
      page('<form method="get" action="/fleet/graph">' + chart() + '<a href="/fleet/graph.csv">csv</a>');
    export const fleetGraphLive = (): Response => new Response(chart());
    export const fleetGraphCsv = (): Response => new Response("at,cost");
  `;
  const server = (more = ""): string => `
    import { home } from "../web/pages/site.ts";
    import { boardPage, bigRedirect } from "../web/pages/board.ts";
    import { repoHome } from "../web/pages/repo.ts";
    import { fleetGraphCsv, fleetGraphLive, fleetGraphPage } from "../web/pages/fleet-graph.ts";
    import { fleetOpsPage } from "../web/pages/fleet-ops.ts";
    import { page } from "../web/layout.ts";
    export function routes(router: { add(method: string, path: string, handler: unknown): void }): void {
      router.add("GET", "/", home);
      router.add("GET", "/board", boardPage);
      router.add("GET", "/big", bigRedirect);
      router.add("GET", "/:owner/:name", repoHome);
      router.add("GET", "/fleet/graph", fleetGraphPage);
      router.add("GET", "/fleet/graph/live", fleetGraphLive);
      router.add("GET", "/fleet/graph.csv", fleetGraphCsv);
      router.add("POST", "/fleet/graph", fleetGraphPage);
      ${more}
    }
  `;
  const tree = (over: Record<string, string> = {}): Record<string, string> => ({
    "src/web/layout.ts": LAYOUT,
    "src/web/pages/site.ts": HOME('<a href="/board">Board</a>'),
    "src/web/pages/board.ts": `
      import { page, redirect } from "../layout.ts";
      export const boardPage = (): Response => page("the board");
      export const bigRedirect = (): Response => redirect("/board?wall");
    `,
    "src/web/pages/repo.ts": `
      import { page } from "../layout.ts";
      export const repoHome = (): Response => page("a repository");
    `,
    "src/web/pages/fleet-graph.ts": GRAPH,
    "src/web/pages/fleet-ops.ts": `export const fleetOpsPage = (): Response => new Response("");`,
    "src/web/fleet-graph.ts": `export const chart = (): string => '<div data-src="/fleet/graph/live"></div>';`,
    "src/http/server.ts": server(),
    ...over,
  });

  test("is named: its own form, its fragment and its download are not a way in", () => {
    expect(ids(tree())).toEqual(["GET /fleet/graph"]);
  });

  test("is linked from the front door, or from a page the front door links to", () => {
    expect(
      ids(
        tree({
          "src/web/pages/site.ts": HOME('<a href="/fleet/graph">Graph</a>'),
        }),
      ),
    ).toEqual(["GET /board"]);
    expect(
      ids(
        tree({
          "src/web/pages/board.ts": `
            import { page } from "../layout.ts";
            export const boardPage = (): Response => page('<a href="/fleet/graph?repo=a">Spend over time</a>');
            export const bigRedirect = (): Response => new Response("");
          `,
        }),
      ),
    ).toEqual([]);
  });

  test("is linked from a page whose path takes a parameter, or from what such a page is drawn with", () => {
    expect(
      ids(
        tree({
          "src/web/pages/repo.ts": `
            import { page } from "../layout.ts";
            export const repoHome = (): Response => page('<a href="/fleet/graph">Graph</a>');
          `,
        }),
      ),
    ).toEqual([]);
    expect(
      ids(
        tree({
          "src/web/layout.ts": `${LAYOUT}\nexport const NAV = [{ label: "Graph", href: "/fleet/graph" }];`,
        }),
      ),
    ).toEqual([]);
  });

  test("a longer path, a path after an interpolation and the router that imports every page are not links", () => {
    const links = [
      '<a href="/fleet/graph/live">live</a>',
      '<a href="/fleet/graph.csv">csv</a>',
      '<a href="/fleet/graphs">others</a>',
      '<a href="/x/fleet/graph">elsewhere</a>',
    ];
    for (const link of links)
      expect(
        ids(
          tree({
            "src/web/pages/site.ts": HOME(`<a href="/board">b</a>${link}`),
          }),
        ),
      ).toEqual(["GET /fleet/graph"]);
    expect(
      ids(
        tree({
          "src/web/pages/repo.ts": `
            import { page } from "../layout.ts";
            import { routes } from "../../http/server.ts";
            export const repoHome = (base: string): Response => page(\`<a href="\${base}/fleet/graph">\${String(routes)}</a>\`);
          `,
        }),
      ),
    ).toEqual(["GET /fleet/graph"]);
  });

  test("two that link only to each other are both named, and one link in reaches both", () => {
    const pair = {
      "src/web/pages/fleet-ops.ts": `
        import { page } from "../layout.ts";
        export const fleetOpsPage = (): Response => page('<a href="/fleet/graph">graph</a>');
      `,
      "src/web/pages/fleet-graph.ts": GRAPH.replace(
        "csv</a>",
        'csv</a><a href="/fleet/ops">ops</a>',
      ),
      "src/http/server.ts": server(
        `router.add("GET", "/fleet/ops", fleetOpsPage);`,
      ),
    };
    expect(ids(tree(pair))).toEqual(["GET /fleet/graph", "GET /fleet/ops"]);
    expect(
      ids(
        tree({
          ...pair,
          "src/web/pages/site.ts": HOME(
            '<a href="/board">b</a><a href="/fleet/ops">Fleet</a>',
          ),
        }),
      ),
    ).toEqual([]);
  });

  test("a handler written in place is a screen too, and one that never draws the page is not", () => {
    expect(
      ids(
        tree({
          "src/http/server.ts": server(`
            router.add("GET", "/inline", () => page("in place"));
            router.add("GET", "/healthz", () => new Response("ok"));
          `),
        }),
      ),
    ).toEqual(["GET /fleet/graph", "GET /inline"]);
  });

  test("the line names the path and the file that draws it", () => {
    expect(hollow(new Map(Object.entries(tree()))).map((h) => h.line)).toEqual([
      "GET /fleet/graph (src/web/pages/fleet-graph.ts) is a screen no page links to: link it from a page a person can get to, or list it in ALLOWED (scripts/hollow-allow.ts) with the issue that owns it",
    ]);
  });
});

describe("audit", () => {
  const sources = new Map([
    ["src/actions/a.ts", "export function a(): void {}"],
    ["src/actions/b.ts", "export function b(): void {}"],
    [
      "src/http/api.ts",
      `import { b } from "../actions/b.ts"; export const r = b;`,
    ],
    ["src/main.ts", `import { r } from "./http/api.ts"; r();`],
  ]);

  test("what is hollow and not listed is a problem; what is listed with an owner is not", () => {
    expect(audit(sources, [])).toHaveLength(1);
    expect(audit(sources, [])[0]).toStartWith("src/actions/a.ts#a is exported");
    expect(
      audit(sources, [
        {
          orphan: "src/actions/a.ts#a",
          reason: "waits for its route",
          issue: 7,
        },
      ]),
    ).toEqual([]);
  });

  test("an entry that is no longer hollow is a problem, so the list only shrinks", () => {
    expect(
      audit(sources, [
        {
          orphan: "src/actions/a.ts#a",
          reason: "waits for its route",
          issue: 7,
        },
        { orphan: "src/actions/b.ts#b", reason: "was hollow once", issue: 8 },
      ]),
    ).toEqual([
      "src/actions/b.ts#b is in ALLOWED but is not hollow: remove the entry",
    ]);
  });

  test("an entry listed twice, or with no reason or no issue, is named", () => {
    expect(
      audit(sources, [
        { orphan: "src/actions/a.ts#a", reason: " ", issue: 0 },
        {
          orphan: "src/actions/a.ts#a",
          reason: "waits for its route",
          issue: 7,
        },
      ]),
    ).toEqual([
      "src/actions/a.ts#a is allowed with no reason",
      "src/actions/a.ts#a is allowed with no issue number",
      "src/actions/a.ts#a is in ALLOWED twice",
    ]);
  });
});
