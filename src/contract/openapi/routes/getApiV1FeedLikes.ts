import type { Route } from "../shared.ts";

export const route: Route = {
  method: "get",
  path: "/api/v1/feed/likes",
  summary: "The like ledger of one feed item, newest first, 50 a page (ro scope): `?item=` is a feed item id, `app` (owner/name) names the repository when the item is not an event; `before` is a seq to read the rows older than; answers { item, ledger: [{ seq, who, act, at }], more }, `more` true when older rows remain, `act` being like or unlike; an anonymous caller is told to sign in at /signin",
  auth: true,
  role: "member",
  query: { item: "string", app: "string", before: "string" },
};
