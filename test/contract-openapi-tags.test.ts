import { expect, test } from "bun:test";
import { openapi, ROUTES } from "../src/contract/openapi.ts";
import { TAG_WORDS, tagOf } from "../src/contract/tags.ts";
import { openapiSliceText, TAGS } from "../src/contract/served.ts";

type Doc = { tags: { name: string; description: string }[]; paths: Record<string, Record<string, { tags: string[] }>>; components: unknown; info: unknown };
const doc = openapi("https://x.test", "v") as Doc;

test("every operation carries exactly one tag, and every tag is listed with a line", () => {
  const listed = new Set(doc.tags.map((t) => t.name));
  for (const ops of Object.values(doc.paths)) for (const op of Object.values(ops)) {
    expect(op.tags).toHaveLength(1);
    expect(listed.has(op.tags[0]!)).toBe(true);
  }
  for (const t of doc.tags) expect(TAG_WORDS[t.name]).toBeTruthy();
  expect(Object.keys(TAG_WORDS).sort()).toEqual([...listed].sort());
});

test("a path's tag is its resource", () => {
  expect(tagOf("/api/v1/repos/{owner}/{name}/pulls/{number}/merge")).toBe("pulls");
  expect(tagOf("/api/v1/repos/{owner}/{name}/issues")).toBe("issues");
  expect(tagOf("/api/v1/repos/{owner}/{name}/app/env")).toBe("apps");
  expect(tagOf("/api/v1/repos/{owner}/{name}/forks")).toBe("forks");
  expect(tagOf("/api/v1/repos/{owner}/{name}")).toBe("repos");
});

test("a slice keeps only its tag's operations and the rest of the document", () => {
  const slice = JSON.parse(openapiSliceText("https://x.test", "v", "pulls").text) as Doc;
  expect(slice.info).toEqual(doc.info);
  expect(slice.components).toEqual(doc.components);
  expect(slice.tags.map((t) => t.name)).toEqual(["pulls"]);
  const n = Object.values(slice.paths).flatMap((o) => Object.values(o)).length;
  expect(n).toBe(ROUTES.filter((r) => tagOf(r.path) === "pulls").length);
  expect(openapiSliceText("https://x.test", "v", "pulls").text.length).toBeLessThan(40_000);
});

test("?tag= over HTTP: a slice, the whole, and a 400 naming the tags", async () => {
  const { openapiRoute } = await import("../src/contract/served.ts");
  const { Router } = await import("../src/http/router.ts");
  const router = new Router<(ctx: any) => Response>();
  openapiRoute(router as never);
  const call = async (q: string) => {
    const m = (router as any).match("GET", "/contract/openapi.json");
    const url = new URL(`https://x.test/contract/openapi.json${q}`);
    return m.handler({ url, request: new Request(url.href) }) as Response;
  };
  const bad = await call("?tag=nope");
  expect(bad.status).toBe(400);
  expect(((await bad.json()) as { message: string }).message).toContain(TAGS.join(", "));
  const whole = JSON.parse(await (await call("")).text()) as Doc;
  expect(Object.keys(whole.paths).length).toBe(Object.keys(doc.paths).length);
  const one = JSON.parse(await (await call("?tag=pulls")).text()) as Doc;
  expect(Object.keys(one.paths).length).toBeLessThan(Object.keys(whole.paths).length);
});
