/**
 * The repositories-limit and agent-not-here refusals live in one module
 * (#5720): migrate, repos, the apps page, the fleet, the terminal and the MCP
 * import them, and none types its own copy.
 */

import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  AGENT_NOT_ON_CREW,
  AT_REPOSITORY_LIMIT,
  NO_SUCH_AGENT,
} from "../src/actions/crew_limit_words.ts";

const root = join(import.meta.dir, "..");
const read = (file: string): string => readFileSync(join(root, file), "utf8");

const readers: Record<string, Record<string, string>> = {
  "src/actions/migrate.ts": { AT_REPOSITORY_LIMIT, NO_SUCH_AGENT },
  "src/actions/repos.ts": { AT_REPOSITORY_LIMIT },
  "src/actions/apps.ts": { NO_SUCH_AGENT },
  "src/fleet/verbs.ts": { AGENT_NOT_ON_CREW },
  "src/tui/screens/common.ts": { AGENT_NOT_ON_CREW },
  "src/http/mcp/tools/assign.ts": { AGENT_NOT_ON_CREW },
};

test("the sentences read as they always have", () => {
  expect(AT_REPOSITORY_LIMIT).toBe("at the repositories limit");
  expect(NO_SUCH_AGENT).toBe("That agent is not on this forge.");
  expect(AGENT_NOT_ON_CREW).toBe("that agent is not on this repository's crew");
});

for (const [file, names] of Object.entries(readers)) {
  for (const [name, sentence] of Object.entries(names)) {
    test(`${file} imports ${name} and types no copy of it`, () => {
      const text = read(file);
      expect(text).not.toContain(`"${sentence}"`);
      expect(text).toMatch(new RegExp(`import \\{[^}]*\\b${name}\\b[^}]*\\} from "[./]*(actions/)?crew_limit_words\\.ts"`));
    });
  }
}
