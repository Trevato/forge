import { sizesView } from "../../../spawn/sizes.ts";
import { good, type Tool } from "../shared.ts";

export const tool: Tool = {
  name: "sizes",
  description:
    "What a child forge's sizes mean: small, medium and large, each with CPU, memory and disk.",
  inputSchema: { type: "object", properties: {} },
  writes: false,
  run: () => good(sizesView()),
};
