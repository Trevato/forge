/** A bug closed with no fix behind it must say why: the action, the API's code, the terminal's words. */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closingFrom, openIssue, setIssueLabels, setIssueState } from "../src/actions/issues.ts";
import { createLabel, createRepo } from "../src/actions/repos.ts";
import { createApp, type App } from "../src/app.ts";
import { listComments } from "../src/core/issues.ts";
import { originAware } from "../src/http/api.ts";
import { signUpProven as signUp } from "./helpers/verified.ts";
import { promote } from "./helpers/members.ts";
import type { User } from "../src/core/users.ts";
import type { Repo } from "../src/core/repos.ts";
import { words } from "../src/fleet/verbs.ts";

let dir: string;
let app: App;
let alice: User;
let repo: Repo;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "bug-close-"));
  app = createApp({ dataDir: dir, port: 0 });
  const made = await signUp(app, { username: "alice", email: "alice@forge.test", password: "a-long-passphrase" });
  if (!made.ok) throw new Error("user");
  const extra = await signUp(app, { username: "bob", email: "bob@forge.test", password: "a-long-passphrase" });
  if (!extra.ok) throw new Error("user");
  alice = made.value;
  promote(app.db, alice, extra.value);
  const r = await createRepo(app, alice, { name: "p", visibility: "public" });
  if (!r.ok) throw new Error("repo");
  repo = r.value;
  if (!createLabel(app, alice, repo, "bug", "d73a4a").ok) throw new Error("label");
});
afterAll(async () => {
  await app.close();
  await rm(dir, { recursive: true, force: true });
});

function issue(title: string, label: boolean) {
  const o = openIssue(app, alice, repo, { title });
  if (!o.ok) throw new Error("open");
  if (label && !setIssueLabels(app, alice, repo, o.value, ["bug"]).ok) throw new Error("label");
  return o.value;
}

test("a bug closed without a fix is refused until it says why", () => {
  const bug = issue("crash", true);
  expect(setIssueState(app, alice, repo, bug, "closed", { reason: "dropped" })).toEqual({
    ok: false,
    error: "reason_required",
  });
  expect(setIssueState(app, alice, repo, bug, "closed", { note: "  " })).toEqual({
    ok: false,
    error: "reason_required",
  });
  const closed = setIssueState(app, alice, repo, bug, "closed", { reason: "dropped", note: "works as designed" });
  expect(closed.ok).toBe(true);
  expect(listComments(app.db, bug.id).map((c) => c.body)).toContain("Closed as won't fix: works as designed");
});

test("an issue that is not a bug closes as before", () => {
  const plain = issue("idea", false);
  expect(setIssueState(app, alice, repo, plain, "closed", { reason: "dropped" }).ok).toBe(true);
});

test("the API and the terminal name the refusal; the note is read from the request", () => {
  expect(originAware("reason_required").status).toBe(422);
  expect(words("reason_required")).toContain("says why");
  expect(closingFrom({ reason: "dropped", note: " no repro " })).toEqual({ reason: "dropped", note: " no repro " });
});
