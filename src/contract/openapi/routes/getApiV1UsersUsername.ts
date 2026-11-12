import type { Route } from "../shared.ts";

export const route: Route = { method: "get", path: "/api/v1/users/{username}", summary: "Read one person's public profile; 404 when they do not exist or hid themselves from the caller", auth: false, role: "anonymous" };
