/**
 * The features list in the terminal, a site admin's who is a person: the page's list
 * (Settings → Features) from the same `listFeatures`, `a` absorbs or
 * un-absorbs the one under the cursor, Enter opens its settings and a setting
 * is typed in and saved through `changeFeatureSettings`, which checks it
 * against the app's declaration exactly as the page does. Anyone else is not
 * offered it, and the actions refuse them anyway.
 */

import {
  absorbApp,
  changeFeatureSettings,
  listFeatures,
  unabsorbApp,
  type FeatureView,
  type SettingView,
} from "../../actions/features.ts";
import type { Ctx, Screen } from "../app/app.ts";
import { binding } from "../app/keys.ts";
import type { Session } from "../session.ts";
import { ListState, drawList, promptScreen, runAsync, type ListRow } from "./common.ts";
import type { PaletteEntry } from "./entries.ts";

/** Site admins who are people: what the page's `requireAdmin` lets in. */
export const mayFeatures = (f: Session): boolean => f.user !== undefined && f.user.isAdmin && f.user.kind !== "agent";

const FAILS: Record<string, string> = {
  not_found: "no such app",
  forbidden: "only a site admin does that",
  not_a_feature: "that app's forge.json declares no feature",
  not_absorbed: "that app is not absorbed",
};

function featureRow(f: FeatureView): ListRow {
  return {
    title: `${f.name}  ${f.repo}`,
    meta: f.absorbed ? "absorbed" : "not absorbed",
    note: f.problem ?? `${String(f.settings.length)} setting${f.settings.length === 1 ? "" : "s"}`,
  };
}

function settingRow(s: SettingView): ListRow {
  return { title: `${s.label}  ${s.env}`, meta: s.value === "" ? "empty" : s.value, note: `${s.help ?? s.type}${s.set ? "" : " · not changed"}` };
}

function settingsScreen(f: Session, ctx: Ctx, slug: string): Screen {
  const state = new ListState();
  let view: FeatureView | undefined;
  const reload = async (): Promise<void> => {
    const listed = await listFeatures(f.app, f.user);
    view = listed.ok ? listed.value.find((v) => v.slug === slug) : undefined;
    ctx.invalidate();
  };
  const screen: Screen = {
    title: "Feature settings",
    keys: [binding(["j", "k"], "move cursor"), binding(["enter"], "change")],
    load: reload,
    render(area, s) {
      drawList(s, area, ctx.theme.c, state, (view?.settings ?? []).map(settingRow));
    },
    key(e) {
      const settings = view?.settings ?? [];
      if (e.key !== "enter") return state.key(e, settings.length);
      const setting = settings[state.index];
      if (view === undefined || setting === undefined) return true;
      if (!view.absorbed) {
        ctx.toast(`absorb ${view.name} to change its settings`, "attn");
        return true;
      }
      ctx.push(
        promptScreen(ctx, screen, {
          title: setting.label,
          label: setting.type === "list" || setting.type === "days" ? "comma separated" : setting.type,
          value: setting.value,
          hint: setting.help ?? `${setting.env}; default ${setting.default === "" ? "empty" : setting.default}`,
          onSubmit: async (text) => {
            const saved = await changeFeatureSettings(f.app, f.user, slug, { [setting.key]: text });
            if (!saved.ok) {
              ctx.toast(saved.error.message, "attn");
              return;
            }
            ctx.toast(`${saved.value.name}: saved. It restarts with the new settings.`);
            await reload();
          },
        }),
      );
      return true;
    },
  };
  return screen;
}

export function featureSwitchScreen(f: Session, ctx: Ctx): Screen {
  const state = new ListState();
  let features: readonly FeatureView[] = [];
  const reload = async (): Promise<void> => {
    const listed = mayFeatures(f) ? await listFeatures(f.app, f.user) : undefined;
    features = listed?.ok ? listed.value : [];
    ctx.invalidate();
  };
  const screen: Screen = {
    title: "Features",
    keys: [binding(["j", "k"], "move cursor"), binding(["a"], "absorb / un-absorb"), binding(["enter"], "settings")],
    load: reload,
    render(area, s) {
      drawList(s, area, ctx.theme.c, state, features.map(featureRow));
    },
    key(e) {
      const here = features[state.index];
      if (e.key === "a" && here !== undefined) {
        runAsync(ctx, async () => {
          const done = here.absorbed ? await unabsorbApp(f.app, f.user, here.slug) : await absorbApp(f.app, f.user, here.slug);
          ctx.toast(
            done.ok ? (here.absorbed ? `${here.name} runs as an ordinary app again; its settings are kept.` : `${here.name} is absorbed: it is in the forge's nav.`) : (FAILS[done.error] ?? done.error),
            done.ok ? undefined : "attn",
          );
          await reload();
        });
        return true;
      }
      if (e.key === "enter" && here !== undefined) {
        ctx.push(settingsScreen(f, ctx, here.slug));
        return true;
      }
      return state.key(e, features.length);
    },
  };
  return screen;
}

/** Features, as Settings → Features shows them: a site admin's who is a person. */
export const entry: PaletteEntry = {
  id: "features",
  title: "Features",
  hint: "apps that declare a feature: absorb one, change its settings",
  offered: mayFeatures,
  run: (session, ctx) => ctx.push(featureSwitchScreen(session, ctx)),
};
