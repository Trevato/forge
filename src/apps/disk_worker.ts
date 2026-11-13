/** The worker side of `diskBytesOff` (`contain.ts`): walk the directories and say how many bytes they hold. */

import { diskBytes } from "./disk_walk.ts";

declare const self: Worker;

self.onmessage = (e: MessageEvent<{ id: number; dirs: string[] }>) => {
  try {
    postMessage({ id: e.data.id, bytes: diskBytes(e.data.dirs) });
  } catch (error) {
    postMessage({ id: e.data.id, error: String(error) });
  }
};
