/** Whether the reviewer seat is set to 0: on the crew, starting nothing. Every reading of "paused" goes through it. */
import type { Repo } from "../core/repos.ts";

export const reviewerPaused = (repo: Pick<Repo, "reviewerSlots">): boolean => repo.reviewerSlots === 0;
