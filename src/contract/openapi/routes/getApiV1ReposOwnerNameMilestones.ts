import { REPO, type Route } from "../shared.ts";

export const route: Route = { method: "get", path: `${REPO}/milestones`, summary: "Read the plan: { repo: { owner, name }, limbs }, one limb per milestone with its weights (and askToLive for a pillar's umbrella); a private repository needs a token", auth: false };
