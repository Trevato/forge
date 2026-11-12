import { REPO, type Route } from "../shared.ts";

export const route: Route = { method: "get", path: `${REPO}/chapters`, summary: "The repository's chapters (a version with an end): the open one, the drafts waiting after it and the closed ones, each with its name, what done means, state, and its list of issues (done only when live and proven, building, left), progress and the date it finishes at the current pace; a closed chapter carries its tag, notes, cost and the day it closed", auth: false, role: "anonymous" };
