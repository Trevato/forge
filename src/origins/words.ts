/**
 * The sentences an origin's providers say when the origin fails them, or when
 * a path names the wrong kind of thing, said from one place so every door
 * that shows them (page, API, MCP, terminal) reads the same words.
 */

/** The origin answered who the credential is, but named no account. */
export const NO_ACCOUNT = "the origin named no account";

/** The path asked for is not a file or directory in the repository. */
export const NOT_A_PATH = "not a path in a repository";

/** The origin accepted a review but returned none. */
export const NO_REVIEW = "the origin returned no review";

/** A directory listing was asked of a path that is a file. */
export const PATH_IS_FILE = "that path is a file, not a directory";

/** A file was asked of a path that is a directory. */
export const PATH_IS_DIRECTORY = "that path is a directory, not a file";

/**
 * What comes across from another forge, and what does not — said on the page
 * and in the API, so a mirror of a friend's app never reads as the whole of it.
 */
export const FORGE_NOT_CARRIED =
  "Code comes across, and the repository's history. Issues, pulls and comments read and write through. Not yet: labels, and how the app runs. Never by default: its data and its secrets.";

/**
 * Signing in to another forge by OAuth needs a browser to approve in, and a
 * forge has no device grant, so the terminal cannot start it: said where the
 * terminal asks for a token, and where it lists the apps, pointing at the page.
 */
export const FORGE_SIGN_IN_ON_PAGE =
  "Another forge signs in with one click on the web page; here, with a token.";
