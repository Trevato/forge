import { REPO, type Route } from "../shared.ts";

export const route: Route = { method: "post", path: `${REPO}/app/pull`, summary: "Pull an adapter now, whatever its schedule (rw scope, writer); answers { run }; 404 no adapter block, 409 asleep or a pull in flight", auth: true, role: "member" };
