# pulsewatch-mobile

React Native companion app for [pulsewatch](https://github.com/arb-rajab/pulsewatch),
a self-hosted uptime/SLO/alerting service. Signs in with the same operator
account as the pulsewatch dashboard, shows live target health and incident
history, and receives a push notification the moment an incident opens —
foreground or background — deep-linking straight to that incident.

## Screenshots

![Sign in, targets, target detail and an incident](docs/screenshots/overview.png)

![Server setup](docs/screenshots/server-setup.png)

_Real screens of this app, not mockups. They were rendered through the Expo web build (`react-native-web`) in Chromium against a running pulsewatch backend (PostgreSQL, Redis, a scheduler checking three local HTTP endpoints, one of them failing so it has an open incident), driven with Playwright. A web render is not a native iOS or Android capture: fonts and chrome differ, and `expo-notifications` has no web implementation, so it was stubbed for the capture and push behaviour is not shown. The "Error budget consumed" figure is just what the backend reported for a target that had only existed for a short time._

## Stack

- [Expo](https://expo.dev) (SDK 57) + TypeScript, bare enough to use raw
  native push tokens (no managed Expo push service in the loop — see
  "Push notifications" below)
- [expo-router](https://docs.expo.dev/router/introduction/) for file-based
  navigation and deep linking (`pulsewatch://` scheme, plus universal
  paths matching the in-app routes)
- [expo-notifications](https://docs.expo.dev/versions/latest/sdk/notifications/)
  for permissions, raw device token retrieval, and foreground/background/
  killed-state notification handling
- Jest (`jest-expo` preset) + React Native Testing Library for tests

## Backend contract

This app is a pure client of pulsewatch's `/api/v1` REST API
(`docs/architecture/openapi.yaml` in the `pulsewatch` repo) — operator
session auth (`POST /auth/login`, an `HttpOnly` cookie), targets, target
status/SLO, incidents, and device-token registration. Push dispatch itself
(FCM + APNs, sent directly by the backend with no vendor SDK) is
`pulsewatch`'s ADR-0007; this repo only consumes it.

`lib/api-types.ts` is a deliberately 1:1 mirror of that OpenAPI schema —
if the backend contract changes, that file is where it shows up as a
diff, not something this app tries to abstract away.

## Setup

```bash
npm install
npm run typecheck
npm run lint
npm test
```

pulsewatch is self-hosted, so there's no baked-in production server URL —
on first launch the app asks for the pulsewatch server's URL (stored
locally) before showing the login screen.

### Running

```bash
npm run android   # or
npm run ios       # requires macOS
```

Push notifications require a real device / a development build (not Expo
Go — see "Named limitations" below) plus:

- **Android**: a Firebase project's `google-services.json` (for the FCM
  device token) placed at the project root and referenced from `app.json`.
- **iOS**: an Apple Developer account with push notifications enabled for
  the app's bundle id; `app.json`'s `aps-environment` entitlement is set
  to `development` — flip to `production` for a release build.

Neither is included in this repo (they're real credentials, not something
to commit) — see pulsewatch's own ADR-0007 for the same reasoning on the
backend side.

## Push notifications and deep linking

- **Registration** (`lib/device-tokens.ts`): requests notification
  permission, then fetches the *raw* native push token —
  `expo-notifications`' `getDevicePushTokenAsync()`, not an Expo push
  token — since the backend speaks FCM's HTTP v1 API and APNs' HTTP/2
  provider API directly. Android always registers as `fcm`, iOS as
  `apns` (`providerForPlatform`), matching pulsewatch's ADR-0007.
  Registration runs on every sign-in (`lib/use-register-device-on-sign-in.ts`),
  since re-registering an unchanged token is what clears a dead/revoked
  mark on the backend.
- **Payload shape**: every push's `data` carries `{ kind, incident_id,
  target_id }` as strings (`lib/push-notifications.ts`'s
  `extractDeepLinkData`), mirroring `internal/pushprovider`'s
  `Notification.Data` on the backend exactly.
- **Deep link**: `lib/use-notification-deep-linking.ts` wires
  `expo-notifications`' `useLastNotificationResponse()` — which covers a
  live tap, a background tap, *and* a cold start launched by tapping a
  notification, through one hook — to `router.push('/targets/[targetId]/
  incidents/[incidentId]')`, deduped by notification identifier so a
  re-render doesn't double-navigate.
- **Settings → Devices**: lists this operator's registered devices
  (including why a dead one died) and can revoke one (`DELETE
  /device-tokens/{id}`); signing out is the same action for the current
  device.

### Why the incident detail route needs both ids

There's no `GET /incidents/{id}` in the backend's API — incident history
is only exposed per-target. A push's payload always carries both
`target_id` and `incident_id` (ADR-0007), so the deep-link route is
`/targets/[targetId]/incidents/[incidentId]` and resolves the single
incident by loading that target's incident list and matching the id
(`lib/incidents.ts`).

## Testing

93 tests across 16 suites (`npm test`): API client, auth state machine,
device-token registration, target/incident data helpers, every screen,
and — the one most worth calling out — a genuine push → deep-link
integration test (`lib/__tests__/use-notification-deep-linking.test.tsx`)
that renders the *actual* production hook the app mounts, feeds it a
fabricated native notification-response event, and asserts the real
navigation call. It's not a reimplementation of the logic under test.

### Named limitation

What this repo's test suite (and this sandbox) cannot verify: an actual
push arriving from real FCM/APNs infrastructure, or an actual OS
cold-launching the app process from a killed state via a notification
tap — both require a physical device and real provider credentials.
This is the same class of limitation pulsewatch's own ADR-0007 names for
its server-side push delivery (B-016: "not verified... requires real
credentials") — stated here rather than implied or papered over.

## Known issues

`npm audit --omit=dev` currently reports 13 moderate-severity advisories
(`decode-uri-component`, `uuid`) that are all transitive dependencies of
`expo`'s and `expo-router`'s own build/CLI tooling
(`@expo/config-plugins`, `@expo/cli`, `xcode`, ...) — none of it ships in
the app bundle a device runs. `npm audit fix --force` "fixes" this only
by downgrading `expo`/`expo-router` to years-old major versions, which
would be a much larger regression than the advisories themselves. CI's
`npm audit` step is scoped to `--audit-level=high` for that reason and
will still fail on anything worse; revisit once SDK 57's own tooling
picks up the fix upstream.

**One high-severity finding (`node-forge` / `GHSA-86w9-cpqp-85rv`, an RSA
PKCS#1 v1.5 signature-verification bypass) is explicitly, narrowly
allowlisted** rather than just relying on `--audit-level=high` — same
shape as the moderate findings above (reached only transitively through
`expo`'s own bundled `@expo/cli` build tooling, never shipped in the app
bundle), confirmed ecosystem-wide with no patched `node-forge` release
yet as of 2026-10-02. `scripts/check-npm-audit.mjs` runs the real audit
and fails on anything at/above `--audit-level=high` that ISN'T this one
advisory, so a genuinely new high/critical finding still blocks CI. The
allowlist entry itself expires 2026-11-15, after which the check fails
outright until a human either renews it (if still unfixed upstream) or
removes it (if a fix finally shipped) — see the script's own header for
the full reasoning.

**A second high-severity finding (`braces` / `GHSA-vfj7-8cjw-p6xm`, a
stack-exhaustion DoS on deeply nested brace patterns) is allowlisted the
same way** — build/test tooling only (via `micromatch`), no patched
`braces` release exists as of 2026-10-05, and the entry expires
2026-11-15.

**No branch protection on `main`.** GitHub's branch API reports `main` as
`"protected": false` — there is no branch protection rule at all, so none
of CI's three jobs (`app`: typecheck/lint/tests/`npm audit`; `gitleaks`:
secret scanning; `codeql`: static analysis) are actually required to pass
before a PR can merge. CI being green has never been enforced here, only
informative — the same gap this portfolio found (and fixed) in
`bookslot-mobile`. (Separately: `CLAUDE.md`'s session-continuity notes say
the repo's default branch setting was still the old rebuild branch as of
2026-09-15 with no tool able to change it — that part is now resolved;
GitHub's repository metadata confirms `default_branch` is `main`.) No tool
available to any session using this portfolio's GitHub MCP tooling can read
or write branch-protection settings (no such endpoint is exposed, and raw
API/`gh`-CLI fallback is out of policy), so this can only be fixed by a
human with repo admin access: GitHub → Settings → Branches → add a rule for
`main` → require status checks `app`, `gitleaks`, and `codeql` →
(recommended) require a pull request before merging. None of these three
jobs are path-filtered, so requiring all of them carries no risk of
permanently blocking an unrelated PR.

## Project layout

```
app/                          expo-router routes
  index.tsx                   auth-state gate (bootstrapping/needs-server/signed-out/signed-in)
  server-setup.tsx            pulsewatch server URL entry
  login.tsx                   operator sign-in
  (app)/                      signed-in routes (guarded)
    index.tsx                 target health list
    settings.tsx               device list, revoke, sign out
    targets/[targetId]/       target detail (status + SLO)
    targets/[targetId]/incidents/            incident list
    targets/[targetId]/incidents/[incidentId] incident detail (push deep-link target)
lib/                          API client, auth, push, and data-loading logic (framework-agnostic, unit-tested)
```
