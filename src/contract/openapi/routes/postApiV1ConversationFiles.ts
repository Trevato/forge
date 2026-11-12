import type { Route } from "../shared.ts";

export const route: Route = {
  method: "post",
  path: "/api/v1/conversation/files",
  summary: "Attach one file to the signed-in person's next /talk message: the raw bytes as the body, its name url-encoded in the x-file-name header. Its type is what its bytes are (PNG, JPEG, GIF or WebP image up to 5 MB, or a UTF-8 text file up to 100 KB), never what the request says; send its id in `files` to /api/v1/conversation/messages",
  auth: true,
  role: "member",
  status: 201,
  reply: { id: "string", name: "string", type: "string", size: "integer" },
  refusals: {
    empty: "the file is empty (422)",
    too_large: "an image is over 5 MB or a text file over 100 KB (413)",
    bad_type: "not a supported image or text file (415)",
    too_many: "four files are waiting for a message already (422)",
    storage_full: "the file does not fit in the 50 MB kept, even after the oldest sent files are dropped (507)",
    rate_limited: "more than 20 files in a minute (429)",
    forbidden: "the request is cross-origin, or the token may only read",
  },
};
