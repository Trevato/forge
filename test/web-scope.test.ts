import { expect, test } from "bun:test";
import {
  forkButton,
  hostOf,
  upstreamHref,
  type RepoScope,
} from "../src/web/scope.ts";

const origin = (login: string) => ({
  id: "o1",
  login,
  webUrl: "https://codeberg.org",
});

const scope = (over: Record<string, unknown>): RepoScope =>
  ({
    kind: "origin",
    base: "/origins/o1/r/octo/widgets",
    fullName: "octo/widgets",
    origin: origin("me"),
    repo: undefined,
    upstream: undefined,
    ...over,
  }) as unknown as RepoScope;

test("the fork button is offered on someone else's repository", () => {
  const out = forkButton(scope({})).toString();
  expect(out).toContain('action="/origins/o1/r/octo/widgets/fork"');
  expect(out).toContain("codeberg.org");
});

test("no fork button on a repository the account owns, in any case", () => {
  expect(forkButton(scope({ fullName: "me/widgets" })).toString()).toBe("");
  expect(forkButton(scope({ fullName: "ME/widgets" })).toString()).toBe("");
});

test("no fork button on a local scope or without an origin", () => {
  expect(forkButton(scope({ kind: "local" })).toString()).toBe("");
  expect(forkButton(scope({ origin: undefined })).toString()).toBe("");
});

test("a repository name with markup is escaped in the button", () => {
  const out = forkButton(
    scope({ fullName: 'octo/<img src=x onerror=1>"' }),
  ).toString();
  expect(out).not.toContain("<img");
  expect(out).toContain("&lt;img");
  expect(out).toContain("&quot;");
});

test("upstreamHref is a path on this forge, never an absolute URL", () => {
  const href = upstreamHref(scope({ upstream: "up/widgets" }));
  expect(href).toBe("/origins/o1/r/up/widgets");
  expect(href).not.toContain("codeberg.org");
  expect(href?.startsWith("/")).toBe(true);
});

test("upstreamHref reads the mirror's origin id and is undefined without upstream", () => {
  const mirror = scope({
    origin: undefined,
    repo: { origin: { originId: "o9" } },
    upstream: "up/widgets",
  });
  expect(upstreamHref(mirror)).toBe("/origins/o9/r/up/widgets");
  expect(upstreamHref(scope({}))).toBeUndefined();
  expect(
    upstreamHref(scope({ origin: undefined, upstream: "a/b" })),
  ).toBeUndefined();
});

test("hostOf gives the host, and nothing for garbage or javascript:", () => {
  expect(hostOf("https://codeberg.org/octo/widgets")).toBe("codeberg.org");
  expect(hostOf("not a url")).toBe("");
  expect(hostOf("javascript:alert(1)")).toBe("");
});
