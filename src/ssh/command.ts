/**
 * The exact `ssh …` that opens this forge's terminal — or an app's, when a
 * login is given (its slug; `slug--12` for the preview of pull 12). One
 * builder for every surface that shows the command, so they never disagree
 * about the host or the port. Undefined when SSH is off.
 */

import type { App } from "../app.ts";

export function sshCommand(app: App, login?: string): string | undefined {
  // Hosted by another forge, this forge's own terminal is reached the way
  // its host said, word for word; it has no listener of its own.
  if (login === undefined && app.config.appSsh !== undefined) return app.config.appSsh;
  const port = app.config.sshPort;
  if (port === undefined || port <= 0) return undefined;
  const host = sshHost(app);
  const at = login === undefined ? "" : `${login}@`;
  return `ssh${port === 22 ? "" : ` -p ${port}`} ${at}${host}`;
}

/**
 * The one-line tell, `ssh … tell <words>`, built from the forge's own
 * address. Undefined when SSH is off, and when the forge is itself hosted as
 * an app (its address then names an app login, which has no `tell`).
 */
export function sshTellCommand(app: App): string | undefined {
  if (app.config.appSsh !== undefined) return undefined;
  const base = sshCommand(app);
  return base === undefined ? undefined : `${base} tell <words>`;
}

/**
 * The `ssh://git@…` address that clones `owner/name` from this forge. The
 * port is left out when it is 22. Undefined when SSH is off, and when the
 * forge is hosted as an app of another: its own listener is then not
 * reachable, and the host's terminal command is not a git remote.
 */
export function sshCloneUrl(
  app: App,
  owner: string,
  name: string,
): string | undefined {
  if (app.config.appSsh !== undefined || sshCommand(app) === undefined)
    return undefined;
  const port = app.config.sshPort;
  return `ssh://git@${sshHost(app)}${port === 22 ? "" : `:${port}`}/${owner}/${name}.git`;
}

function sshHost(app: App): string {
  return (
    app.config.host ??
    (app.config.url !== undefined
      ? new URL(app.config.url).hostname
      : "localhost")
  );
}
