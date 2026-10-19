import { expect, test } from "bun:test";
import { announceShard, finishedShard } from "../src/checks/shard_event.ts";
import { checksLine } from "../src/web/pages/pull.ts";

const run = { id: "r1", repoId: "repo1", kind: "check", env: "pull-7", commitOid: "abc" } as never;

function fakeApp() {
  const events: { kind: string; repoId: string; payload: Record<string, unknown> }[] = [];
  return { events, app: { bus: { append: (e: never) => events.push(e) } } as never };
}

test("a finished shard, live or batched, is one line and one event", () => {
  expect(finishedShard("── shard 2/4 done (exit 0, 3.0s)")).toEqual({ shard: 2, of: 4 });
  expect(finishedShard("── shard 3/4 (exit 1, 2.0s): a.ts b.ts")).toEqual({ shard: 3, of: 4 });
  expect(finishedShard("── shard 2/4: a.ts b.ts")).toBeUndefined();
  expect(finishedShard(" 5 pass")).toBeUndefined();

  const { app, events } = fakeApp();
  for (const line of ["── shard 1/2: a.ts", " 5 pass", "── shard 1/2 done (exit 0, 1.0s)"])
    announceShard(app, run, line);
  expect(events).toHaveLength(1);
  expect(events[0]!.kind).toBe("run.shard");
  expect(events[0]!.repoId).toBe("repo1");
  expect(events[0]!.payload).toEqual({ runId: "r1", kind: "check", env: "pull-7", commitOid: "abc", shard: 1, of: 2 });
});

test("the checks line of a running check listens for run.* and never beats", () => {
  const run = { id: "r1", kind: "check", env: "pull-7", commitOid: "abcdef1234567", state: "running", summary: "", createdAt: "2026-10-16T10:00:00Z" } as never;
  const html = checksLine("/a/b", { state: "running", run }, false, true, false, "", "", 0, "", false, "", "/a/b/pulls/7/checks-line").text;
  expect(html).toContain('data-live="run.*"');
  expect(html).not.toContain("data-live-every");
});
