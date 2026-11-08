# A child forge's cell may reach its model provider

A child forge that runs in a cell (`src/spawn/cell.ts`) could reach its parent and nothing else, so its crew could not call a model. An admin of the parent now chooses one model provider those cells may reach.

- **The setting** is `children.modelEgress` under **Settings → Usage → Capacity**, or `FORGE_CHILDREN_MODEL_EGRESS` at boot. It is `off` by default. `openrouter` lets every child cell reach `openrouter.ai` on port 443, and no other host or port.
- **Enforced always.** A child cell refuses every other host even while `cells.egress` is `report`. Report mode is for apps still declaring their hosts, not for a whole forge.
- **The child's own key.** The cell opens the route only. The child's crew still calls the model with a key the child holds, and the parent's key and environment are never handed on (`cellEnv`).
- **When it applies:** on the next child cell started. A running child keeps the list it started with.

A hosted child (one that runs inside its parent's process) is not changed by this: it still has no crew runner.
