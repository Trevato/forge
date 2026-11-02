/**
 * The ways a board changes, as one pure function: a board and an edit in, the
 * new board or the reason it cannot be out. Nothing here reads or writes the
 * repo; `store.ts` judges the result again before it is committed.
 */
import { err, ok, type Result } from "../kernel/result.ts";
import { parseBoard, parsePanel, type Board } from "./store.ts";

export type Edit =
  | { kind: "title"; title: unknown }
  | { kind: "settings"; range: unknown; refresh: unknown }
  | { kind: "add"; panel: unknown }
  | { kind: "edit"; index: number; panel: unknown }
  | { kind: "remove"; index: number; title?: string }
  | { kind: "move"; index: number; by: -1 | 1 };

export function applyEdit(board: Board, edit: Edit): Result<Board, string> {
  const panels = [...board.panels];
  const at = "index" in edit ? edit.index : -1;
  if ("index" in edit && (!Number.isInteger(at) || at < 0 || at >= panels.length)) {
    return err("there is no such panel");
  }
  let next: unknown;
  switch (edit.kind) {
    case "title":
      next = { ...board, title: edit.title };
      break;
    case "settings":
      next = { ...board, range: edit.range, refresh: edit.refresh };
      break;
    case "add": {
      const p = parsePanel(edit.panel);
      if (!p.ok) return p;
      next = { ...board, panels: [...panels, p.value] };
      break;
    }
    case "edit": {
      const p = parsePanel(edit.panel);
      if (!p.ok) return p;
      panels[at] = p.value;
      next = { ...board, panels };
      break;
    }
    case "remove":
      // A title names the panel the person saw; a board reordered since must not lose another one.
      if (edit.title !== undefined && panels[at]!.title !== edit.title) return err("that panel moved; nothing was removed");
      panels.splice(at, 1);
      next = { ...board, panels };
      break;
    case "move": {
      const to = at + edit.by;
      if (to < 0 || to >= panels.length) return ok(board);
      [panels[at], panels[to]] = [panels[to]!, panels[at]!];
      next = { ...board, panels };
      break;
    }
  }
  return parseBoard(next);
}
