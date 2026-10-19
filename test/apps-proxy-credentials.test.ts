/** The app proxy never forwards the forge's or the edge's credentials. */

import { expect, test } from "bun:test";
import { stripForgeCredentials } from "../src/apps/proxy.ts";
import { edgeIdentity } from "../src/http/edge.ts";

test("x-plat-*, authorization and this app's grant cookie are removed; the app's and a hosted forge's cookies stay", () => {
  const h = new Headers({
    "x-plat-edge-token": "secret",
    "x-plat-user": "admin",
    authorization: "Bearer t",
    cookie: "forge_grant_aaaaaaaa=ours; theme=dark; forge_session=hosted; forge_grant_bbbbbbbb=theirs",
    accept: "text/html",
  });
  stripForgeCredentials(h, "forge_grant_aaaaaaaa");
  expect([...h.keys()].filter((k) => k.startsWith("x-plat-"))).toEqual([]);
  expect(h.get("authorization")).toBeNull();
  expect(h.get("cookie")).toBe("theme=dark; forge_session=hosted; forge_grant_bbbbbbbb=theirs");
  expect(h.get("accept")).toBe("text/html");
});

test("a cookie header holding only our grant disappears", () => {
  const h = new Headers({ cookie: "forge_grant_aaaaaaaa=ours" });
  stripForgeCredentials(h, "forge_grant_aaaaaaaa");
  expect(h.has("cookie")).toBe(false);
});

test("a stranger's x-plat-user without the edge token names nobody", () => {
  const r = new Request("http://x/", { headers: { "x-plat-user": "admin" } });
  expect(edgeIdentity(r, "secret")).toBeUndefined();
  const wrong = new Request("http://x/", {
    headers: { "x-plat-user": "admin", "x-plat-edge-token": "guess" },
  });
  expect(edgeIdentity(wrong, "secret")).toBeUndefined();
});
