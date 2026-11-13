import { REPO, type Route } from "../shared.ts";

export const route: Route = { method: "put", path: `${REPO}/app/domains/{host}/old-records`, summary: "Keep the domain's old DNS records with its row, replacing any kept before (admin scope); answers the domain", auth: true, role: "member" };
