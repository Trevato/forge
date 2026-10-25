/**
 * The words a person reads when a new repository is refused: its name
 * breaks the rules, or git could not make it on disk. Migrate, a new app
 * and a new repository all say them, so they are said from here.
 */

/** A name `createRepo` refused as `invalid_name`. */
export const REPO_NAME_RULES = "Names start with a letter or digit; no spaces, no .git.";

/** `createRepo` failed as `git_init_failed`. */
export const REPO_INIT_FAILED = "The repository could not be initialised on disk.";
