/**
 * The browser terminal's wiring to a machine's shell socket
 * (`machines/shell.ts`), with no DOM and no socket in it: plain functions the
 * client (`machine-term-client.ts`) connects to a real terminal and a real
 * WebSocket, and a test connects to fakes.
 *
 * The terminal is reached only through `Term` — `write`, `onData`, `resize`,
 * `fit` — so the emulator behind it (ghostty-web today) can be swapped
 * without touching the protocol.
 *
 * The protocol is the socket's: binary frames are keystrokes in and screen
 * bytes out; a text frame is `{"type":"resize","cols":n,"rows":n}`. A size is
 * sent once when the socket opens (the server redraws a reattached session on
 * it) and then once per size the terminal settles on, never twice in a row.
 */

export interface Size {
  readonly cols: number;
  readonly rows: number;
}

/** The thin face of a terminal emulator: all the page needs of one. */
export interface Term {
  /** Screen bytes from the shell. */
  write(bytes: Uint8Array): void;
  /** Keystrokes the person typed (or pasted). */
  onData(listener: (text: string) => void): void;
  resize(cols: number, rows: number): void;
  /** Fit the terminal to its box; the size it settled on, if it could measure one. */
  fit(): Size | undefined;
}

/** The text frame that tells the shell its window's size. */
export function resizeFrame(size: Size): string {
  return JSON.stringify({ type: "resize", cols: size.cols, rows: size.rows });
}

/** Why a closed socket closed, in words a person can act on. */
export function closedWords(code: number, reason: string): string {
  const why = reason.trim() !== "" ? reason.trim() : code === 1000 ? "the shell exited" : "the connection dropped";
  return `Disconnected: ${why}. Reload to reattach.`;
}

export interface Wired {
  /** The socket opened: send the size, start forwarding keystrokes. */
  opened(): void;
  /** Screen bytes arrived. */
  received(bytes: Uint8Array): void;
  /** The socket closed. */
  closed(code: number, reason: string): void;
  /** The terminal's box may have changed size: fit, and send the size if it is new. */
  refit(): void;
}

/**
 * Wire a terminal to a socket's `send`. `say` puts a status line in front of
 * the person (connecting, connected, why it closed).
 */
export function wire(term: Term, send: (frame: string | Uint8Array) => void, say: (words: string) => void): Wired {
  const encoder = new TextEncoder();
  let open = false;
  let sent: Size | undefined;
  const sendSize = (size: Size): void => {
    sent = size;
    send(resizeFrame(size));
  };
  term.onData((text) => {
    if (open) send(encoder.encode(text));
  });
  return {
    opened() {
      open = true;
      say("Connected.");
      const size = term.fit();
      if (size !== undefined) sendSize(size);
    },
    received(bytes) {
      term.write(bytes);
    },
    closed(code, reason) {
      open = false;
      say(closedWords(code, reason));
    },
    refit() {
      const size = term.fit();
      if (!open || size === undefined) return;
      if (sent !== undefined && sent.cols === size.cols && sent.rows === size.rows) return;
      sendSize(size);
    },
  };
}
