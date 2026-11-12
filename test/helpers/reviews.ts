/**
 * Reviews are something an owner turns on (#11666): with them off and no
 * reviewer seated, a green pull lands by itself. A test whose expectation is
 * a wait on a review asks for reviews here, in one place, rather than
 * writing the column itself.
 */

import type { Database } from "bun:sqlite";

/** Turn `requireReview` on (or, with `on` false, off) for a repository. */
export function askForReviews(db: Database, repoId: string, on = true): void {
  db.query("UPDATE repo SET require_review = ?2 WHERE id = ?1").run(repoId, on ? 1 : 0);
}
