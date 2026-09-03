/**
 * The names the rest of the app knows a repository by.
 *
 * There is one repository screen now — the workspace (`screens/workspace.ts`):
 * explorer, tabs, an editor and one commit, all on one screen. These three
 * doors survive because "open this repository", "open this file" and "open
 * this directory" are still the three things a caller means, and because a
 * dashboard row should not have to know which pane it is asking for.
 */

export { repoScreen, blobScreen, treeScreen } from "./workspace.ts";
