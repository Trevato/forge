import { afterEach, expect, test } from "bun:test";
import { ForgeApi } from "../src/cli/api.ts";

let server: ReturnType<typeof Bun.serve> | undefined;
afterEach(() => server?.stop(true));

const pin = (i: number) => ({ owner: "alice", name: `r${i}`, cloneUrl: `http://x/alice/r${i}.git` });

function stub(handler: (url: URL) => Response): ForgeApi {
  server = Bun.serve({ port: 0, fetch: (req) => handler(new URL(req.url)) });
  return new ForgeApi(`http://127.0.0.1:${server.port}`, "t");
}

test("pins() follows next_cursor across pages", async () => {
  const seen: (string | null)[] = [];
  const api = stub((url) => {
    const cursor = url.searchParams.get("cursor");
    seen.push(cursor);
    return cursor === null
      ? Response.json({ items: [pin(1), pin(2)], next_cursor: "2" })
      : Response.json({ items: [pin(3)], next_cursor: null });
  });
  const out = await api.pins();
  expect(out.ok && out.value.map((p) => p.name)).toEqual(["r1", "r2", "r3"]);
  expect(seen).toEqual([null, "2"]);
});

test("pins() takes a bare array from an older forge as the whole list", async () => {
  const api = stub(() => Response.json([pin(1), pin(2)]));
  const out = await api.pins();
  expect(out.ok && out.value.map((p) => p.name)).toEqual(["r1", "r2"]);
});
