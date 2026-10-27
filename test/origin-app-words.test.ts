/**
 * An unreachable origin, an app already yours and a report already decided
 * are said from one module, src/actions/origin_app_words.ts (#5647). The API
 * and the MCP import the sentences; a copy typed back into either fails here.
 */
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  APP_ALREADY_YOURS,
  ORIGIN_UNREACHABLE,
  REPORT_ALREADY_DECIDED,
} from "../src/actions/origin_app_words.ts";
import { importsFrom, mcpSource } from "./helpers/mcp.ts";

const root = join(import.meta.dir, "..");
// The API door is api.ts and the route families moved out of it (#6332).
const apiFiles = (): string[] => [
  "src/http/api.ts",
  ...readdirSync(join(root, "src/http/api"))
    .filter((f) => f.endsWith(".ts"))
    .sort()
    .map((f) => `src/http/api/${f}`),
];
const apiSource = (): string =>
  apiFiles()
    .map((f) => readFileSync(join(root, f), "utf8"))
    .join("\n");
const read = (path: string) => {
  if (path === "src/http/mcp.ts") return mcpSource(root);
  if (path === "src/http/api.ts") return apiSource();
  return readFileSync(join(root, path), "utf8");
};

const SENTENCES = {
  ORIGIN_UNREACHABLE: "the origin could not be reached",
  APP_ALREADY_YOURS: "this app is already yours",
  REPORT_ALREADY_DECIDED: "this report was already decided",
} as const;

const DOORS = ["src/http/api.ts", "src/http/mcp.ts"] as const;

describe("origin, app and report refusals live in one module", () => {
  test("the module says each sentence, word for word", () => {
    expect({
      ORIGIN_UNREACHABLE,
      APP_ALREADY_YOURS,
      REPORT_ALREADY_DECIDED,
    }).toEqual(SENTENCES);
  });

  for (const door of DOORS) {
    test(`${door} imports the sentences and types none of them out`, () => {
      const text = read(door);
      expect(importsFrom(text, "actions/origin_app_words.ts")).toBe(true);
      for (const [name, sentence] of Object.entries(SENTENCES)) {
        expect(text).toContain(name);
        expect(text).not.toContain(sentence);
      }
    });
  }
});
