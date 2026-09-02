/**
 * The one interruption this client is allowed to make. It fires only when
 * something actually changed (see `changesBetween`), and it degrades: the
 * platform's own notifier, then `notify-send`, then the terminal bell, then
 * nothing at all. A notifier that throws would take a `--watch` loop down,
 * so this one cannot.
 */

export type Notifier = (title: string, body: string) => Promise<void>;

export function systemNotifier(): Notifier {
  return async (title, body) => {
    try {
      if (process.platform === "darwin") {
        // Through argv, not through the script text: a repo named
        // `a" & do shell script "…` must stay a repo name.
        await run([
          "osascript",
          "-e",
          "on run {t, b}\ndisplay notification b with title t\nend run",
          title,
          body,
        ]);
        return;
      }
      if (process.platform === "linux") {
        if (await run(["notify-send", "--", title, body])) return;
      }
      process.stderr.write("\x07");
    } catch {
      /* a notification is never worth a crash */
    }
  };
}

async function run(args: string[]): Promise<boolean> {
  try {
    const proc = Bun.spawn(args, { stdout: "ignore", stderr: "ignore" });
    return (await proc.exited) === 0;
  } catch {
    return false;
  }
}
