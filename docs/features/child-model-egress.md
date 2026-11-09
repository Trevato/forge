# A child forge's cell may reach its model provider

A child forge that runs in a cell (`src/spawn/cell.ts`) could reach its parent and nothing else, so its crew could not call a model. An admin of the parent now chooses one model provider those cells may reach.

- **The setting** is `children.modelEgress` under **Settings → Usage → Capacity**, or `FORGE_CHILDREN_MODEL_EGRESS` at boot. It is `off` by default. `openrouter` lets every child cell reach `openrouter.ai` on port 443, and no other host or port.
- **Enforced always.** A child cell refuses every other host even while `cells.egress` is `report`. Report mode is for apps still declaring their hosts, not for a whole forge.
- **The child's own key.** The cell opens the route only. The child's crew still calls the model with a key the child holds, and the parent's key and environment are never handed on (`cellEnv`).
- **When it applies:** on the next child cell started. A running child keeps the list it started with.

A hosted child (one that runs inside its parent's process) is not changed by this: it still has no crew runner.

## The package registries

A child cell could not reach a package registry either, so its checks failed filling the install cache. `children.registryEgress` (`FORGE_CHILDREN_REGISTRY_EGRESS`) is `off` by default:

- `npm` opens `registry.npmjs.org`.
- `build` opens what ordinary app builds fetch from: `registry.npmjs.org`, `registry.yarnpkg.com`, `pypi.org`, `files.pythonhosted.org`, `github.com`, `codeload.github.com`, `objects.githubusercontent.com` (git dependencies and release tarballs), `crates.io`, `static.crates.io`, `proxy.golang.org` and `sum.golang.org`.

Each host is named exactly, on port 443 alone, with no wildcards. It is enforced the same way and applies from the next child cell started.

## Cells inside a child

A child forge opens cells of its own for its checks, apps and install steps. Those cells' proxy cannot dial out, since the child's cell has no route but its own proxy, so it tunnels through that proxy with `CONNECT` (`upstream` in `src/apps/egress.ts`). A host opens only when both policies allow it: the step's own egress, and the child cell's list above. Names are resolved and checked by the child cell's proxy.
