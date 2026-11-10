/**
 * Every `/settings…` page route: the account, its tokens, sessions and
 * passkeys, and a forge admin's sections (subscriptions, secrets, cloud,
 * backups, accounts, crew, origins, keys). Moved out of `server.ts` (#8309),
 * unchanged and in their original order; `buildRouter` calls it once, where
 * the first of them stood, above every `/:owner`-shaped route, and hands
 * in the pattern list the usage page reads, so this module never imports it.
 */

import type { Handler } from "./context.ts";
import type { Router } from "./router.ts";
import { parentLinkStart } from "./rp.ts";
import { accessPage } from "../web/pages/access.ts";
import { knobSet } from "../web/pages/knobs.ts";
import { capacityPage, capacitySet } from "../web/pages/capacity.ts";
import { teamPage, teamSet, teamsPage, teamsStream } from "../web/pages/teams.ts";
import { telemetryPage, telemetrySet } from "../web/pages/telemetry.ts";
import { flagsPage, flagsSet } from "../web/pages/flags.ts";
import { appTemplatesPage, appTemplatesSet } from "../web/pages/app_templates.ts";
import { economicsPage, economicsSet } from "../web/pages/economics.ts";
import { trustedAdd, trustedPage, trustedRemove, trustedRevert, trustedStop } from "../web/pages/trusted.ts";
import { usagePage } from "../web/pages/usage.ts";
import { spendPage } from "../web/pages/spend-tab.ts";
import { securityControlsPage } from "../web/pages/security_controls.ts";
import { securityPage, securityShieldSet } from "../web/pages/security.ts";
import { trafficPage } from "../web/pages/traffic.ts";
import { sourcesPage } from "../web/pages/sources.ts";
import { requestAct } from "../web/requests_card.ts";
import { captureStart, captureStop, networksImport, scrapesExport, scrapesPage } from "../web/pages/scrapes.ts";
import {
  accountAct,
  retireAct,
  retirePage,
  accountsPage,
  personSignInsPage,
  signInAct,
} from "../web/pages/accounts.ts";
import { confirmsList, confirmYes } from "../web/pages/confirms.ts";
import { captainAct, captainPage } from "../web/pages/captain.ts";
import { packsSettingsPage, packsSettingsSave } from "../web/pages/packs-settings.ts";
import { featureAccept, featurePage, featureRun, featureSave, featuresPage, featureSwitch } from "../web/pages/features.ts";
import { passkeyAdd, passkeyDelete, passkeyOptions, passkeysPage } from "../web/pages/passkeys.ts";
import { deviceCap, deviceDeclare, deviceGrant, devicesPage, deviceRemove, deviceRevoke } from "../web/settings/devices.ts";
import { secretDelete, secretSet, secretsPage } from "../web/pages/secrets.ts";
import {
  backupsClear,
  backupsDestination,
  backupsDrill,
  backupsLive,
  backupsMirror,
  backupsMirrorClear,
  backupsMirrorNow,
  backupsNow,
  backupsPage,
  backupsTest,
  domainsMoved,
} from "../web/pages/backups.ts";
import {
  cloudAdd,
  cloudAudit,
  cloudAuditPage,
  cloudRename,
  cloudRotate,
  cloudPage,
  cloudRemove,
  cloudVerify,
  cloudWrite,
} from "../web/pages/cloud.ts";
import {
  subscriptionAdd,
  subscriptionDelete,
  subscriptionsPage,
  subscriptionBudget,
  subscriptionHeadroom,
  subscriptionWake,
} from "../web/pages/subscriptions.ts";
import { peoplePage, roleAct } from "../web/pages/people.ts";
import { ceilingAct, grantAct, modelAdd, modelPage } from "../web/pages/model.ts";
import {
  everydayCreate,
  everydayKeep,
  everydayOptions,
  everydaySwitch,
} from "../web/pages/everyday.ts";
import {
  agentCreate,
  agentDelete,
  modelReviewDecline,
  modelReviewTake,
  agentPage,
  agentUpdate,
  crewPage,
} from "../web/pages/crew.ts";
import {
  accountPage,
  shellsPage,
  shellStop,
  shellsStopIdle,
  notifyUpdate,
  edgeLink,
  edgeUnlink,
  parentUnlink,
  accountUpdate,
  dotfilesUpdate,
  keyCreate,
  keyDelete,
  keysPage,
  passwordPage,
  resendVerifyLink,
  passwordUpdate,
  tokenCreate,
  sessionDelete,
  tokenDelete,
  tokensPage,
} from "../web/pages/account.ts";
import { completeOAuthCallback } from "../actions/origins.ts";
import { mirrorJobPage } from "../web/pages/browse.ts";
import {
  callbackLanding,
  originAppCreate,
  originAppDelete,
  originConnectToken,
  originCheckSubmit,
  originDisconnect,
  originOAuthStart,
  originSyncSubmit,
  originsPage,
  originReplaceToken,
  originTrustedHosts,
} from "../web/pages/origins.ts";
import { originArchivedPage, originArchivedRestore } from "../web/pages/origin-archived.ts";
import { originFlowStream } from "./flow_stream.ts";
import { originFlowPage, originFlowPoll } from "../web/pages/origin-flow.ts";
import { originMirrorSubmit, originReposPage } from "../web/pages/origin-repos.ts";

export function settingsRoutes(router: Router<Handler>, knownPatterns: () => readonly string[]): void {
  router.add("GET", "/settings/trusted", trustedPage);
  router.add("POST", "/settings/trusted", trustedAdd);
  router.add("POST", "/settings/trusted/stop", trustedStop);
  router.add("POST", "/settings/trusted/revert", trustedRevert);
  router.add("POST", "/settings/trusted/:id/remove", trustedRemove);
  router.add("GET", "/settings/telemetry", telemetryPage);
  router.add("POST", "/settings/telemetry", telemetrySet);
  router.add("GET", "/settings", accountPage);
  router.add("POST", "/settings", accountUpdate);
  router.add("POST", "/settings/notify", notifyUpdate);
  router.add("POST", "/settings/dotfiles", dotfilesUpdate);
  router.add("POST", "/settings/edge/link", edgeLink);
  router.add("POST", "/settings/edge/unlink", edgeUnlink);
  router.add("POST", "/settings/parent/link", parentLinkStart);
  router.add("POST", "/settings/parent/unlink", parentUnlink);
  router.add("POST", "/settings/email/verify", resendVerifyLink);
  router.add("GET", "/settings/password", passwordPage);
  router.add("POST", "/settings/password", passwordUpdate);
  // The everyday account: an admin's daily account, apart from admin (#596).
  router.add("POST", "/settings/everyday", everydayCreate);
  router.add("POST", "/settings/everyday/options", everydayOptions);
  router.add("POST", "/settings/everyday/switch", everydaySwitch);
  router.add("POST", "/settings/everyday/keep", everydayKeep);
  router.add("GET", "/settings/shells", shellsPage);
  router.add("POST", "/settings/shells/stop-idle", shellsStopIdle);
  router.add("POST", "/settings/shells/:id/stop", shellStop);
  router.add("GET", "/settings/tokens", tokensPage);
  router.add("POST", "/settings/tokens", tokenCreate);
  router.add("POST", "/settings/tokens/:id/delete", tokenDelete);
  router.add("POST", "/settings/sessions/:id/delete", sessionDelete);
  router.add("GET", "/settings/confirms", confirmsList);
  router.add("POST", "/settings/confirms/:id", confirmYes);
  router.add("GET", "/settings/passkeys", passkeysPage);
  router.add("POST", "/settings/passkeys/options", passkeyOptions);
  router.add("POST", "/settings/passkeys", passkeyAdd);
  router.add("POST", "/settings/passkeys/:id/delete", passkeyDelete);
  // The crew: a forge admin's section, hidden from everyone else.
  router.add("GET", "/settings/subscriptions", subscriptionsPage);
  router.add("POST", "/settings/subscriptions", subscriptionAdd);
  router.add("POST", "/settings/subscriptions/:id/delete", subscriptionDelete);
  router.add("POST", "/settings/subscriptions/:id/wake", subscriptionWake);
  router.add(
    "POST",
    "/settings/subscriptions/:id/headroom",
    subscriptionHeadroom,
  );
  router.add("POST", "/settings/subscriptions/:id/budget", subscriptionBudget);
  router.add("GET", "/settings/secrets", secretsPage);
  router.add("POST", "/settings/secrets", secretSet);
  router.add("POST", "/settings/secrets/delete", secretDelete);
  router.add("GET", "/settings/devices", devicesPage);
  router.add("POST", "/settings/devices", deviceDeclare);
  router.add("POST", "/settings/devices/delete", deviceRemove);
  router.add("POST", "/settings/devices/grant", deviceGrant);
  router.add("POST", "/settings/devices/revoke", deviceRevoke);
  router.add("POST", "/settings/devices/cap", deviceCap);
  router.add("GET", "/settings/cloud", cloudPage);
  router.add("POST", "/settings/cloud", cloudAdd);
  router.add("POST", "/settings/cloud/verify", cloudVerify);
  router.add("POST", "/settings/cloud/write", cloudWrite);
  router.add("POST", "/settings/cloud/audit", cloudAudit);
  router.add("GET", "/settings/cloud/audit", cloudAuditPage);
  router.add("POST", "/settings/cloud/rotate", cloudRotate);
  router.add("POST", "/settings/cloud/rename", cloudRename);
  router.add("POST", "/settings/cloud/remove", cloudRemove);
  router.add("GET", "/settings/access", accessPage);
  router.add("GET", "/settings/resilience", domainsMoved);
  router.add("GET", "/settings/capacity", capacityPage);
  router.add("POST", "/settings/capacity", capacitySet);
  router.add("GET", "/settings/economics", economicsPage);
  router.add("POST", "/settings/economics", economicsSet);
  router.add("GET", "/settings/flags", flagsPage);
  // Apps absorbed as the forge's own features, and their settings.
  router.add("GET", "/settings/captain", captainPage);
  router.add("POST", "/settings/captain", captainAct);
  router.add("GET", "/settings/packs", packsSettingsPage);
  router.add("POST", "/settings/packs", packsSettingsSave);
  router.add("GET", "/settings/features", featuresPage);
  router.add("GET", "/settings/features/:slug", featurePage);
  router.add("POST", "/settings/features/:slug", featureSave);
  router.add("POST", "/settings/features/:slug/run/:tool", featureRun());
  router.add("POST", "/settings/features/:slug/absorb", featureSwitch(true));
  router.add("POST", "/settings/features/:slug/unabsorb", featureSwitch(false));
  router.add("POST", "/settings/features/:slug/accept", featureAccept);
  router.add("POST", "/settings/flags", flagsSet);
  router.add("GET", "/settings/app-templates", appTemplatesPage);
  router.add("POST", "/settings/app-templates", appTemplatesSet);
  router.add("GET", "/settings/usage", (ctx) => usagePage(ctx, knownPatterns));
  router.add("GET", "/settings/spend", spendPage);
  router.add("GET", "/settings/traffic", trafficPage);
  router.add("GET", "/settings/traffic/sources", sourcesPage);
  router.add("GET", "/settings/traffic/scrapes", scrapesPage);
  router.add("GET", "/settings/traffic/scrapes/export", scrapesExport);
  router.add("POST", "/settings/traffic/scrapes/capture", captureStart);
  router.add("POST", "/settings/traffic/scrapes/stop", captureStop);
  router.add("POST", "/settings/traffic/scrapes/networks", networksImport);
  router.add("GET", "/settings/security", securityPage);
  router.add("GET", "/settings/security/controls", securityControlsPage);
  router.add("POST", "/settings/security/shield", securityShieldSet);
  router.add("GET", "/settings/backups", backupsPage);
  router.add("GET", "/settings/backups/live", backupsLive);
  router.add("POST", "/settings/backups/now", backupsNow);
  router.add("POST", "/settings/backups/drill", backupsDrill);
  router.add("POST", "/settings/backups/destination", backupsDestination);
  router.add("POST", "/settings/backups/test", backupsTest);
  router.add("POST", "/settings/backups/clear", backupsClear);
  router.add("POST", "/settings/backups/mirror", backupsMirror);
  router.add("POST", "/settings/backups/mirror/clear", backupsMirrorClear);
  router.add("POST", "/settings/backups/mirror/now", backupsMirrorNow);
  router.add("GET", "/settings/accounts", accountsPage);
  router.add("POST", "/settings/accounts/:username/allow", requestAct("allow"));
  router.add("POST", "/settings/accounts/:username/decline", requestAct("decline"));
  router.add("GET", "/settings/people", peoplePage);
  router.add("POST", "/settings/people/:username/role", roleAct);
  router.add("GET", "/settings/model", modelPage);
  router.add("POST", "/settings/model", modelAdd);
  router.add("POST", "/settings/accounts/:username/model", grantAct);
  router.add("POST", "/settings/accounts/:username/ceiling", ceilingAct);
  router.add("GET", "/settings/accounts/:username", personSignInsPage);
  router.add(
    "POST",
    "/settings/accounts/:username/tokens/:id/delete",
    signInAct("token"),
  );
  router.add(
    "POST",
    "/settings/accounts/:username/sessions/:id/delete",
    signInAct("session"),
  );
  router.add(
    "POST",
    "/settings/accounts/:username/suspend",
    accountAct("suspend"),
  );
  router.add(
    "POST",
    "/settings/accounts/:username/unsuspend",
    accountAct("unsuspend"),
  );
  router.add("POST", "/settings/accounts/:username/remove", accountAct("remove"));
  router.add("GET", "/settings/accounts/:username/retire", retirePage);
  router.add("POST", "/settings/accounts/:username/retire", retireAct);
  router.add("POST", "/settings/accounts/:username/verify", accountAct("verify"));
  router.add("GET", "/settings/crew", crewPage);
  router.add("POST", "/settings/crew/knobs", knobSet);
  router.add("POST", "/settings/crew", agentCreate);
  router.add("GET", "/settings/teams", teamsPage);
  router.add("GET", "/settings/teams/stream", teamsStream);
  router.add("GET", "/settings/teams/:slug", teamPage);
  router.add("POST", "/settings/teams/:slug", teamSet);
  router.add("GET", "/settings/crew/:username", agentPage);
  router.add("POST", "/settings/crew/:username", agentUpdate);
  router.add("POST", "/settings/crew/:username/delete", agentDelete);
  router.add("POST", "/settings/crew/model-review/:id/take", modelReviewTake);
  router.add("POST", "/settings/crew/model-review/:id/decline", modelReviewDecline);
  // Where an OAuth authorization comes back to. Deliberately a plain route
  // and not an API one: it is a browser redirect, possibly from a phone, and
  // the only thing it carries is a `state` this forge issued minutes ago.
  router.add("GET", "/settings/origins/callback", async (ctx) => {
    const done = await completeOAuthCallback(ctx.app, ctx.auth.user, {
      state: ctx.url.searchParams.get("state") ?? "",
      code: ctx.url.searchParams.get("code") ?? "",
      error: ctx.url.searchParams.get("error") ?? "",
    });
    return new Response(null, {
      status: 303,
      headers: { location: callbackLanding(ctx, done) },
    });
  });
  // Origins. Literal thirds first, so `flows` and `apps` can never be
  // captured as an origin id by the parameterized routes below them.
  router.add("GET", "/settings/origins", originsPage);
  router.add("POST", "/settings/origins/token", originConnectToken);
  router.add("POST", "/settings/origins/oauth", originOAuthStart);
  router.add("POST", "/settings/origins/apps", originAppCreate);
  router.add("POST", "/settings/origins/trusted-hosts", originTrustedHosts);
  router.add("POST", "/settings/origins/apps/:id/delete", originAppDelete);
  router.add("GET", "/settings/origins/flows/:id", originFlowPage);
  router.add("POST", "/settings/origins/flows/:id/poll", originFlowPoll);
  router.add("GET", "/settings/origins/flows/:id/stream", originFlowStream);
  router.add("GET", "/settings/origins/:id/repos", originReposPage);
  router.add("GET", "/settings/origins/:id/archived", originArchivedPage);
  router.add("POST", "/settings/origins/:id/archived", originArchivedRestore);
  router.add("POST", "/settings/origins/:id/mirror", originMirrorSubmit);
  // A mirror is a job with stages, so it has a page of its own to watch it
  // on. The literal "mirror" third segment is registered above the :id/:job
  // shape for the same reason `flows` and `apps` are.
  router.add("GET", "/settings/origins/:id/mirror/:job", mirrorJobPage);
  router.add("POST", "/settings/origins/:id/sync", originSyncSubmit);
  // "Check again": the operator guard on a connection whose writes are paused.
  router.add("POST", "/settings/origins/:id/check", originCheckSubmit);
  router.add("POST", "/settings/origins/:id/delete", originDisconnect);
  router.add("POST", "/settings/origins/:id/token", originReplaceToken);
  router.add("GET", "/settings/keys", keysPage);
  router.add("POST", "/settings/keys", keyCreate);
  router.add("POST", "/settings/keys/:id/delete", keyDelete);
}
