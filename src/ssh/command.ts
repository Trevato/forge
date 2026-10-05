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
  const host =
    app.config.host ??
    (app.config.url !== undefined
      ? new URL(app.config.url).hostname
      : "localhost");
  const at = login === undefined ? "" : `${login}@`;
  return `ssh${port === 22 ? "" : ` -p ${port}`} ${at}${host}`;
}
