import { REPO, type Route } from "../shared.ts";

export const route: Route = { method: "get", path: `${REPO}/waves/{version}`, summary: "Takes no query parameters. Read one wave as { version, date, headline, highlights, pulls: [{ number, title, url }] }; number is null when the line names no pull; a private repository needs a token", auth: false, role: "anonymous", reply: { version: "string", date: "string", headline: "string", highlights: "array", pulls: "array" }, refusals: { not_found: "404: no such repository, or it is not readable, or no such wave" } };
