/** What the CLI needs from the person at the keyboard; a test fakes it. */
export interface Io {
  /** One answered line, or null when there is no terminal to ask. */
  ask(prompt: string): Promise<string | null>;
}

/** One line from the terminal, echoed; null when stdin is not a terminal. */
export async function askLine(prompt: string): Promise<string | null> {
  const stdin = process.stdin;
  if (stdin.isTTY !== true || process.stdout.isTTY !== true) return null;
  process.stdout.write(prompt);
  stdin.resume();
  return new Promise<string>((resolve) => {
    // ctrl+d or a closed terminal is an answer too, and the answer is N.
    const finish = (answer: string): void => {
      stdin.off("data", onData);
      stdin.off("end", onEnd);
      stdin.off("close", onEnd);
      stdin.pause();
      resolve(answer);
    };
    const onData = (chunk: Buffer): void =>
      finish(chunk.toString("utf8").split("\n")[0] ?? "");
    const onEnd = (): void => {
      process.stdout.write("\n");
      finish("");
    };
    stdin.on("data", onData);
    stdin.once("end", onEnd);
    stdin.once("close", onEnd);
  });
}
