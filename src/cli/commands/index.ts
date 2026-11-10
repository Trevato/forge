/**
 * Every `forge` subcommand, in the order `forge help` lists them. A new
 * command is a new file in this directory plus one line here.
 */
import { command as ui } from "./ui.ts";
import { command as login } from "./login.ts";
import { command as logout } from "./logout.ts";
import { command as whoami } from "./whoami.ts";
import { command as sync } from "./sync.ts";
import { command as status } from "./status.ts";
import { command as ls } from "./ls.ts";
import { command as pin } from "./pin.ts";
import { command as unpin } from "./unpin.ts";
import { command as open } from "./open.ts";
import { command as pulls } from "./pulls.ts";
import { command as runs } from "./runs.ts";
import { command as asks } from "./asks.ts";
import { command as map } from "./map.ts";
import { command as search } from "./search.ts";
import { command as tell } from "./tell.ts";
import { command as talk } from "./talk.ts";
import { command as newApp } from "./new.ts";
import { command as ship } from "./ship.ts";
import { command as data } from "./data.ts";
import type { Command } from "./types.ts";

export const commands: readonly Command[] = [
  ui,
  login,
  logout,
  whoami,
  sync,
  status,
  ls,
  pin,
  unpin,
  open,
  pulls,
  runs,
  asks,
  map,
  search,
  tell,
  talk,
  newApp,
  ship,
  data,
];
