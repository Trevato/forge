import { templatesView } from "../../../spawn/templates.ts";
import { good, type Tool } from "../shared.ts";

export const tool: Tool = {
  name: "templates",
  doc: "the templates a child forge may start from (`blank` first, the default), each with id, title, one sentence and source; pass an id as `spawn`'s `template`",
  description: "The templates a child forge may start from.",
  inputSchema: { type: "object", properties: {} },
  writes: false,
  run: () => good(templatesView()),
};
