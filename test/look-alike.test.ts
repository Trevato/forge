/** A plan with three or more items of one shape is one change on several things, and is refused as such (#10403–#10432). */
import { describe, expect, test } from "bun:test";
import { LOOK_ALIKE_MIN, lookAlikes, sameShape } from "../src/actions/look_alike.ts";
import { parsePlan } from "../src/actions/plan.ts";

const lists = ["builds", "backups", "webhooks", "bets"].map((x) => `The ${x} list is keyboard-first: j/k move between rows, enter opens one`);

describe("sameShape", () => {
  test("the same words but one are one shape; two of twelve or more too", () => {
    expect(sameShape(lists[0]!, lists[1]!)).toBe(true);
    expect(sameShape(lists[0]!, "The milestones list is keyboard-first: j/k move between milestones, enter opens one")).toBe(true);
  });
  test("different lengths, short titles, identical titles and real differences are not", () => {
    expect(sameShape(lists[0]!, "The builds list is keyboard-first")).toBe(false);
    expect(sameShape("Fix the feed", "Fix the door")).toBe(false);
    expect(sameShape(lists[0]!, lists[0]!)).toBe(false);
    expect(sameShape("A like is a signal written to the decision ledger", "A fork is a share written to the public explorer")).toBe(false);
  });
});

describe("lookAlikes", () => {
  test("groups of three or more, in the order given; pairs and strangers are left alone", () => {
    const items = [{ t: lists[0]! }, { t: "Private by default is plain on every page" }, { t: lists[1]! }, { t: "The feed pages by cursor" }, { t: lists[2]! }, { t: "A fork tree reads in one query" }, { t: "A fork tree reads in two queries" }];
    const groups = lookAlikes(items, (i) => i.t);
    expect(groups).toHaveLength(1);
    expect(groups[0]!.map((i) => i.t)).toEqual(lists.slice(0, 3));
    expect(LOOK_ALIKE_MIN).toBe(3);
    expect(lookAlikes(items.slice(0, 3), (i) => i.t)).toEqual([]);
  });
});

describe("parsePlan", () => {
  const item = (key: string, title: string) => ({ key, title, body: "Done: it does.", pillar: "P9" });
  test("refuses three items of one shape and names them", () => {
    const parsed = parsePlan([item("a", lists[0]!), item("b", "The feed pages by cursor"), item("c", lists[1]!), item("d", lists[3]!)]);
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.error.error).toBe("look_alike");
    expect(parsed.error.message).toContain('"a", "c", "d" are one change on 3 things');
    expect(parsed.error.message).toContain("checkbox");
  });
  test("two of one shape pass: a pair is not a pattern", () => {
    expect(parsePlan([item("a", lists[0]!), item("b", lists[1]!)]).ok).toBe(true);
  });
});
