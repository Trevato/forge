/**
 * A limb's seat (#6624): `parseSeat` takes only `top:N` or `<issue>:N`, and
 * moving a limb then restoring the seat it had puts the group back.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { linkIssue } from "../src/actions/dependencies.ts";
import { openIssue } from "../src/actions/issues.ts";
import { createRepo } from "../src/actions/repos.ts";
import { moveLimb, parseSeat, seating } from "../src/core/limb_seats.ts";
import { getIssueById, type Issue } from "../src/core/issues.ts";
import { getRepoById, type Repo } from "../src/core/repos.ts";
import { createUser, getUserByName } from "../src/core/users.ts";

describe("parseSeat", () => {
  test("takes a group and a place", () => {
    expect(parseSeat("top:1")).toEqual({ group: "top", place: 1 });
    expect(parseSeat("42:3")).toEqual({ group: "42", place: 3 });
  });

  test("refuses everything else", () => {
    for (const bad of ["top:0", "0:1", "01:1", "top:", ":1", "top:1x", "top:1234567"])
      expect(parseSeat(bad)).toBeUndefined();
    expect(parseSeat(3)).toBeUndefined();
    expect(parseSeat(undefined)).toBeUndefined();
  });
});

describe("moving a limb", () => {
  let dataDir: string;
  let app: App;
  let repo: Repo;
  let parent: Issue;
  let limbs: Issue[];

  const fresh = () => getRepoById(app.db, repo.id)!;
  const current = (i: Issue) => getIssueById(app.db, i.id)!;
  const open = (title: string): Issue => {
    const o = openIssue(app, getUserByName(app.db, "alice")!, fresh(), { title });
    if (!o.ok) throw new Error(String(o.error));
    return o.value;
  };
  const link = (waiter: Issue, on: Issue): void => {
    const l = linkIssue(
      app,
      getUserByName(app.db, "alice")!,
      fresh(),
      current(waiter),
      current(on),
    );
    if (!l.ok) throw new Error(String(l.error));
  };
  const order = (): number[] => {
    const seats = seating(app.db, fresh());
    const byId = new Map(seats.graph.issues.map((i) => [i.id, i.number]));
    return seats.order(String(parent.number)).map((id) => byId.get(id)!);
  };

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-limb-seats-"));
    app = createApp({ dataDir, port: 0 });
    const made = await createUser(app.db, {
      origin: "seed",
      trusted: true,
      username: "alice",
      email: "alice@forge.local",
      password: "a-good-passphrase",
      adminIfFirst: true,
    });
    if (!made.ok) throw new Error(made.error);
    const r = await createRepo(app, getUserByName(app.db, "alice")!, {
      name: "seats",
      visibility: "public",
    });
    if (!r.ok) throw new Error(String(r.error));
    repo = r.value;
    parent = open("The issue whose limbs these are");
    limbs = [open("One"), open("Two"), open("Three")];
    for (const limb of limbs) {
      link(parent, limb);
      link(limb, open(`A leaf under ${limb.title}`));
    }
  }, 60_000);

  afterAll(async () => {
    app.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  test("the third to place 1 reads 3, 1, 2; its old seat restores 1, 2, 3", () => {
    const [one, two, three] = limbs.map((l) => l.number);
    expect(order()).toEqual([one!, two!, three!]);
    const group = String(parent.number);
    const before = seating(app.db, fresh()).of(limbs[2]!.id);
    expect(before).toContain(`${group}:3`);
    expect(moveLimb(app.db, fresh(), limbs[2]!.id, { group, place: 1 })).toBeUndefined();
    expect(order()).toEqual([three!, one!, two!]);
    const back = parseSeat(`${group}:3`)!;
    expect(moveLimb(app.db, fresh(), limbs[2]!.id, back)).toBeUndefined();
    expect(order()).toEqual([one!, two!, three!]);
    expect(app.db.query("SELECT * FROM limb_place").all()).toEqual([]);
  });

  test("refuses a place past the end and a stranger", () => {
    const group = String(parent.number);
    expect(moveLimb(app.db, fresh(), limbs[0]!.id, { group, place: 4 })).toContain("only 3");
    expect(moveLimb(app.db, fresh(), parent.id, { group, place: 1 })).toContain("not one");
  });
});
