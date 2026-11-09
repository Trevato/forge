/** The thin plugins name only MCP tools the forge lists, so a rename there fails here. */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { toolNames } from "../src/http/mcp.ts";
import { tool as askedTool } from "../src/http/mcp/tools/asked.ts";
import { ASKED_STATES, askedJson, type Asked } from "../src/core/asked.ts";

const read = (path: string): string => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

/** Claude Code: the command text is the whole file after the front matter. */
const claudeText = (): string => read("plugins/claude-code/commands/forge.md").replace(/^---\n[\s\S]*?\n---\n/, "");

/** OpenCode: the COMMAND template literal, where backticks are escaped. */
const opencodeText = (): string => {
  const m = /const COMMAND = `([\s\S]*?[^\\])`;\n/.exec(read("plugins/opencode/forge.ts"));
  if (!m) throw new Error("plugins/opencode/forge.ts has no COMMAND template");
  return m[1]!.replaceAll("\\`", "`");
};

/** Backticked lowercase identifiers: tool names and argument names alike. */
const backticked = (text: string): string[] => [...text.matchAll(/`([a-z][a-z0-9_]*)`/g)].map((m) => m[1]!);

/** Backticked words that are the server or an argument, not a tool. */
const NOT_TOOLS = new Set(["forge", "repo", "text", "context", "page", "run", "commit", "said", "action", "ship", "close", "status", "words", "id", "verb", "proposal", "approve", "later", "url", "tail", "name", "description", "show", "all", "outcomeText"]);

/** Tools the command text tells the agent to call: every backticked name that is not an argument. */
const toolsNamed = (text: string): string[] => [...new Set(backticked(text))].filter((n) => !NOT_TOOLS.has(n));

const tools = new Set(toolNames());

for (const [label, text] of [
  ["plugins/claude-code/commands/forge.md", claudeText],
  ["plugins/opencode/forge.ts", opencodeText],
] as const) {
  test(`${label} names only tools the forge has`, () => {
    const named = toolsNamed(text());
    for (const core of ["tell", "now", "asks", "asks_act", "say", "preview", "pulls"]) expect(named).toContain(core);
    expect(named.filter((n) => !tools.has(n))).toEqual([]);
  });
}

describe("what the crew is doing on an app", () => {
  for (const [label, text] of [
    ["Claude Code", claudeText],
    ["OpenCode", opencodeText],
  ] as const) {
    test(`${label} names runs and run_log, which the forge lists`, () => {
      const named = toolsNamed(text());
      for (const tool of ["runs", "run_log"]) {
        expect(named).toContain(tool);
        expect(tools.has(tool)).toBe(true);
      }
      expect(text()).toMatch(/log <app> <run>/);
      expect(text()).toMatch(/`tail`\s*(=\s*)?40/);
      expect(text()).toContain("verbatim");
    });
  }

  test("a command that drops run_log is caught", () => {
    expect(toolsNamed("- runs <app>: call `runs` with `repo`")).not.toContain("run_log");
  });
});

describe("what you asked the crew for", () => {
  for (const [label, text] of [
    ["Claude Code", claudeText],
    ["OpenCode", opencodeText],
  ] as const) {
    test(`${label} names asked, which the forge lists`, () => {
      expect(toolsNamed(text())).toContain("asked");
      expect(tools.has("asked")).toBe(true);
      expect(text()).toMatch(/asked \[app\]/);
      expect(text()).toContain("flagged ones first");
      expect(text()).toContain("`outcomeText`");
    });

    test(`${label} passes only arguments asked takes, and lists exactly the states it returns`, () => {
      const line = text().split("\n").find((l) => /^- `?asked \[app\]/.test(l))!;
      const props = askedTool.inputSchema["properties"] as Record<string, { enum?: string[] }>;
      expect(Object.keys(props)).toContain("repo");
      expect(line).toMatch(/`show`\s*(=\s*)?`all`/);
      expect(props["show"]!.enum).toContain("all");
      const listed = /its state \(([^)]*)\)/.exec(line)![1]!.split(/,\s*|\s+or\s+/);
      expect(listed).toEqual([...ASKED_STATES]);
    });
  }

  test("the outcome sentence the texts name is a field asked returns, and says why a parked ask waits", () => {
    const parked = {
      source: "issue",
      repo: { ownerName: "ada", name: "notes" },
      issue: { number: 7, title: "Export to CSV", state: "open" },
      askedBy: "ada",
      askedAt: "2026-10-01T00:00:00Z",
      pulls: [],
      state: "waiting",
      stale: true,
      flagged: true,
      lastCrewAt: null,
      doneBy: [],
      outcome: { kind: "parked", note: "needs a schema decision" },
    } as unknown as Asked;
    expect(askedJson(parked).outcomeText).toBe("parked: needs a schema decision");
  });

  test("a command that drops asked is caught", () => {
    expect(toolsNamed("- asked [app]: call `asks` with `repo`")).not.toContain("asked");
  });

  test("both READMEs and the argument hint list it", () => {
    expect(read("plugins/claude-code/commands/forge.md")).toMatch(/argument-hint:.*\| asked \[app\]/);
    for (const p of ["plugins/claude-code/README.md", "plugins/opencode/README.md"]) expect(read(p)).toContain("`/forge asked [app]`");
  });
});

test("a renamed tool is caught", () => {
  expect(toolsNamed("call `tell_renamed` with `repo`").filter((n) => !tools.has(n))).toEqual(["tell_renamed"]);
  expect(backticked("`a_b` and `C`")).toEqual(["a_b"]);
});

test("the Claude Code command names plan's tools, and the forge lists them", () => {
  const named = toolsNamed(claudeText());
  for (const tool of ["asks", "asks_proposal"]) {
    expect(named).toContain(tool);
    expect(tools.has(tool)).toBe(true);
  }
  expect(claudeText()).toContain("`proposal.id`");
});

describe("new <name> <words> makes an app through new_app, after a yes", () => {
  for (const [label, text] of [
    ["Claude Code", claudeText],
    ["OpenCode", opencodeText],
  ] as const) {
    test(`${label} names new_app, which the forge lists`, () => {
      expect(toolsNamed(text())).toContain("new_app");
      expect(tools.has("new_app")).toBe(true);
      expect(text()).toContain("new <name> <words>");
      expect(text()).toMatch(/Only after (they say|the person says) yes, call `new_app`/);
      expect(text()).toMatch(/If `new_app` refuses \([^)]*name_taken[^)]*\), say its own message in one line; for name_taken, offer another name\. Never retry without asking\./);
    });
  }

  test("both argument hints offer it", () => {
    expect(read("plugins/claude-code/commands/forge.md")).toMatch(/^argument-hint: new <name> <words> \|/m);
    expect(read("plugins/opencode/forge.ts")).toMatch(/description: "New, tell/);
    expect(opencodeText()).toMatch(/^- new <name> <words>: /m);
    expect(claudeText()).toMatch(/^- `new <name> <words>`: /m);
  });

  test("a command that drops new_app is caught", () => {
    expect(toolsNamed(claudeText().replaceAll("`new_app`", "`tell`"))).not.toContain("new_app");
  });
});

describe("the OpenCode plan command", () => {
  test("steers the planner's wave through asks_proposal, after a yes", () => {
    const text = opencodeText();
    expect(text).toContain("plan [approve|redirect <words>|later]");
    expect(toolsNamed(text)).toContain("asks_proposal");
    expect(tools.has("asks_proposal")).toBe(true);
    expect(text).toMatch(/only after the person says yes/);
  });
});

describe("the OpenCode plugin module", () => {
  test("loads and registers a forge command whose template has plan", async () => {
    const saved = { url: process.env["FORGE_URL"], token: process.env["FORGE_TOKEN"] };
    process.env["FORGE_URL"] = "https://forge.example";
    process.env["FORGE_TOKEN"] = "t";
    try {
      // A computed specifier: the plugin's type-only import of OpenCode's package is not a dependency here, so tsc must not follow it.
      const file = "../plugins/opencode/forge.ts";
      const { Forge } = await import(file);
      const config: Record<string, any> = {};
      const hooks: any = await (Forge as any)({});
      await hooks.config(config);
      const template: string = config["command"].forge.template;
      expect(template).toContain("plan [approve|redirect <words>|later]");
      expect(template).toContain("`asks_proposal`");
      expect(template).toEndWith("a person lands changes.");
    } finally {
      for (const [k, v] of [["FORGE_URL", saved.url], ["FORGE_TOKEN", saved.token]] as const) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  });
});

/** The verbs a command offers: the first word of each `- <verb>` line. */
const verbsOf = (text: string): string[] => [...text.matchAll(/^- `?([a-z]+)/gm)].map((m) => m[1]!).sort();

/** The verbs in one command but not the other, either way. */
const verbDiff = (a: string, b: string): { onlyA: string[]; onlyB: string[] } => {
  const va = verbsOf(a);
  const vb = verbsOf(b);
  return { onlyA: va.filter((v) => !vb.includes(v)), onlyB: vb.filter((v) => !va.includes(v)) };
};

describe("the two plugin commands offer the same verbs", () => {
  test("Claude Code and OpenCode have the same set", () => {
    expect(verbsOf(claudeText())).toEqual(["asked", "decide", "log", "new", "plan", "preview", "pulls", "runs", "status", "tell"]);
    expect(verbDiff(claudeText(), opencodeText())).toEqual({ onlyA: [], onlyB: [] });
  });

  test("a command missing a verb fails the comparison", () => {
    const full = "- tell <app>: x\n- status: y\n- plan [approve]: z";
    const missing = "- tell <app>: x\n- status: y";
    expect(verbDiff(full, missing)).toEqual({ onlyA: ["plan"], onlyB: [] });
    expect(verbDiff(missing, full)).toEqual({ onlyA: [], onlyB: ["plan"] });
  });
});

describe("the repository is a Claude Code marketplace", () => {
  test("marketplace.json lists forge, whose directory holds a plugin.json with the same name and version", () => {
    const market = JSON.parse(read(".claude-plugin/marketplace.json"));
    expect(market.name).toBe("forge");
    expect(market.plugins).toHaveLength(1);
    const entry = market.plugins[0];
    expect(entry.name).toBe("forge");
    expect(entry.source).toBe("./plugins/claude-code");
    const plugin = JSON.parse(read(`${entry.source.slice(2)}/.claude-plugin/plugin.json`));
    expect(plugin.name).toBe(entry.name);
    expect(plugin.version).toBe(entry.version);
  });

  test("both docs show the two commands and the install", () => {
    for (const p of ["plugins/claude-code/README.md", "docs/MCP.md"]) {
      const t = read(p);
      expect(t).toContain("/plugin marketplace add");
      expect(t).toContain("/plugin install forge@forge");
      expect(t).toContain("--plugin-dir plugins/claude-code");
    }
  });
});
