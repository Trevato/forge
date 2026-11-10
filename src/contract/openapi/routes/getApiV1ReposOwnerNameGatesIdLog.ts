import { REPO, type Route } from "../shared.ts";

export const route: Route = { method: "get", path: `${REPO}/gates/{id}/log`, summary: "Read a kept full gate's log: the last 200 lines as text/plain, under a one-line header; the last 20 gates of a repository are kept; 404 when none is kept under that id", auth: false, role: "anonymous" };
