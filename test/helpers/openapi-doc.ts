import type { App } from "../../src/app.ts";
import { adminCookie } from "./admin.ts";

const cookies = new WeakMap<App, Promise<string>>();

/**
 * The served OpenAPI document as a site admin reads it: every row. The
 * document is cut to the caller's role (#11286), so a suite that checks a
 * member or admin route is described asks as an admin, signed in once per app.
 */
export async function adminOpenapi(app: App, base: string, path = "/contract/openapi.json"): Promise<Response> {
  let cookie = cookies.get(app);
  if (!cookie) {
    cookie = adminCookie(app, { username: "openapi-reader", email: "openapi-reader@forge.test", password: "openapi-reader-pass-1" });
    cookies.set(app, cookie);
  }
  return fetch(`${base}${path}`, { headers: { cookie: await cookie }, redirect: "follow" });
}
