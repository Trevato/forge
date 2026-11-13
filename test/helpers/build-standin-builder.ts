/**
 * What `build-standin.ts`'s stand-in does, run by `bun` in the clone it is
 * given: edit, run the app's own tests, and only then commit and push.
 * Argument: the file holding the prompt.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { ANCHOR, READING_V1, READING_V2, routeFor, testFor } from "./build-standin.ts";

const prompt = readFileSync(process.argv[2]!, "utf8");
const say = prompt.includes("READING-V2") ? READING_V2 : prompt.includes("READING-V1") ? READING_V1 : undefined;
const finish = (ok: boolean, result: string): void =>
  console.log(
    JSON.stringify({ type: "result", subtype: ok ? "success" : "error_during_execution", is_error: !ok, result, total_cost_usd: 0.01, num_turns: 1, session_id: "build-1", terminal_reason: ok ? "completed" : "tool_error" }),
  );
const git = (...args: string[]): void => {
  const r = Bun.spawnSync(["git", ...args], { stdout: "pipe", stderr: "pipe" });
  if (r.exitCode !== 0) throw new Error(`${args.join(" ")}: ${r.stderr.toString()}`);
};

if (say === undefined) {
  finish(true, "DECLINED: nothing here I know how to build.");
  process.exit(0);
}
const routes = readFileSync("src/routes.ts", "utf8");
if (say === READING_V1) {
  if (!routes.includes(ANCHOR)) {
    finish(false, "the template's routes have changed shape");
    process.exit(0);
  }
  writeFileSync("src/routes.ts", routes.replace(ANCHOR, routeFor(READING_V1) + ANCHOR));
} else {
  if (!routes.includes(JSON.stringify(READING_V1))) {
    finish(false, "there is no first change to change");
    process.exit(0);
  }
  writeFileSync("src/routes.ts", routes.replace(JSON.stringify(READING_V1), JSON.stringify(READING_V2)));
}
writeFileSync("src/reading.test.ts", testFor(say));
const tested = Bun.spawnSync(["bun", "test"], { stdout: "pipe", stderr: "pipe" });
if (tested.exitCode !== 0) {
  finish(false, `its tests failed: ${tested.stderr.toString().slice(-300)}`);
  process.exit(0);
}
git("add", "-A");
git("commit", "-qm", say === READING_V1 ? "Add the reading list" : "Say two books");
git("push", "-q", "-u", "origin", "HEAD");
finish(true, `Added ${say}, tests pass.`);
