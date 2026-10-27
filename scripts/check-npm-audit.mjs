#!/usr/bin/env node
/**
 * Runs `npm audit --omit=dev --audit-level=high` but allows a small,
 * explicitly dated allowlist of advisory IDs to pass through instead of
 * failing the build — used only for a finding that's confirmed:
 *   (a) real (not a false positive),
 *   (b) dev/build-tooling only, never shipped in the app bundle, and
 *   (c) has no upstream fix available yet.
 *
 * This is NOT a permanent suppression. Every entry has an `expires` date;
 * once that date passes, this script fails loudly on that entry regardless
 * of whether it's still "just" the allowlisted finding, forcing a human to
 * either renew the allowlist (re-confirming (a)-(c) still hold) or drop it
 * because upstream finally shipped a fix. See README's "Known issues" for
 * the full story on the >high-severity moderate findings this doesn't
 * touch at all (those stay below --audit-level=high and are unaffected by
 * this script).
 *
 * Usage: node scripts/check-npm-audit.mjs
 * Exit 0: no findings at/above --audit-level, or every one is allowlisted
 *         and not expired.
 * Exit 1: a real, non-allowlisted high/critical finding, or an allowlist
 *         entry past its expiry date.
 */

import { execFileSync } from "node:child_process";

/** @type {{ id: string, package: string, expires: string, reason: string }[]} */
const ALLOWLIST = [
  {
    id: "GHSA-mrhx-c7xc-m3w5",
    package: "zod",
    expires: "2026-11-07",
    reason:
      "Zod memory exhaustion on oversized constrained collections (high). " +
      "The flagged copy is zod 3.25.76 nested under @expo/cli " +
      "(node_modules/@expo/cli/node_modules/zod), which Expo's own CLI uses " +
      "for build/dev tooling, so it is never part of the app bundle. The " +
      "app's own lint tooling resolves a separate zod 4.x; this 3.x copy " +
      "cannot be fixed: no 3.x release carries a fix (3.25.76 is the " +
      "latest) and npm audit only offers a downgrade of expo. Re-check " +
      "before the expiry date: drop this entry once @expo/cli moves to a " +
      "patched zod, otherwise re-confirm and renew.",
  },
  {
    id: "GHSA-vfj7-8cjw-p6xm",
    package: "braces",
    expires: "2026-11-15",
    reason:
      "Stack-exhaustion DoS in braces (recursive AST walkers lack depth " +
      "guards, so deeply nested brace patterns crash the process), high " +
      "severity (CVSS 8.7). Reached only transitively through micromatch " +
      "from build/test tooling (metro, jest, @expo/cli, react-native's " +
      "CLI plugin) that runs on developer machines and CI against " +
      "repo-controlled glob patterns — never in the app bundle a device " +
      "runs. No patched braces release exists (3.0.3 is the latest, and " +
      "the advisory lists no fixed version), so there is nothing to " +
      "upgrade to. Re-check before the expiry date: renew if still " +
      "unfixed upstream, drop this entry the moment a real fix ships.",
  },
];

function todayUtc() {
  return new Date().toISOString().slice(0, 10);
}

function runAudit() {
  try {
    const out = execFileSync(
      "npm",
      ["audit", "--omit=dev", "--audit-level=high", "--json"],
      { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
    );
    return JSON.parse(out);
  } catch (err) {
    // npm audit exits non-zero when it finds anything at/above
    // --audit-level, but still writes the JSON report to stdout.
    if (err.stdout) {
      try {
        return JSON.parse(err.stdout);
      } catch (parseErr) {
        console.error("Could not parse npm audit JSON output:");
        console.error(err.stdout);
        throw parseErr;
      }
    }
    throw err;
  }
}

// `npm audit --json` propagates severity up the WHOLE dependency chain: if
// leaf package D has a real advisory, every package that depends on it
// (C -> B -> A) also gets its own top-level entry in `vulnerabilities`, and
// that entry's `severity` field is the MAX severity of every advisory
// reachable anywhere below it — not necessarily the severity of any single
// advisory. C/B/A's own `via` arrays list the next package DOWN the chain as
// a plain package-name *string*, not the advisory object; only the actual
// leaf advisory entries are objects with a `url` AND THEIR OWN `severity`.
//
// This matters concretely in this repo: `uuid`'s real advisory
// (GHSA-w5hq-g745-h8pq) is a long-documented MODERATE (6.3) finding — one of
// the 13 moderate findings README's "Known issues" already accepts and that
// `--audit-level=high` is specifically scoped to ignore. It was never
// supposed to need an allowlist entry. But `uuid` and `node-forge` (the real
// high-severity, allowlisted finding) both sit transitively under the same
// `@expo/cli`/`expo` package entries, so npm audit's rolled-up severity for
// `@expo/cli`/`expo` is "high" (the max of the two), and a check that only
// looked at the rolled-up container severity would wrongly treat `uuid`'s
// advisory as something that needs allowlisting too, when its own severity
// never crossed the --audit-level=high threshold at all.
//
// So: walk the WHOLE report and collect every leaf advisory object (the ones
// with their own `url` + `severity`), deduped by url. Only a leaf whose OWN
// severity is high/critical needs an allowlist entry — a moderate leaf
// dragged into a "high" container by an unrelated sibling advisory does not.
function collectLeafAdvisories(vulnerabilitiesByName) {
  const leavesByUrl = new Map();
  for (const vuln of Object.values(vulnerabilitiesByName)) {
    for (const via of vuln.via ?? []) {
      if (via && typeof via === "object" && typeof via.url === "string") {
        leavesByUrl.set(via.url, via);
      }
    }
  }
  return leavesByUrl;
}

// For reporting purposes only: which top-level package name(s) a given leaf
// advisory url is reachable from, so console/annotation output can still say
// "node-forge (via expo -> @expo/cli -> ...)" rather than just a bare URL.
function topLevelNamesReaching(url, vulnerabilitiesByName) {
  const names = [];
  for (const vuln of Object.values(vulnerabilitiesByName)) {
    const stack = [...(vuln.via ?? [])];
    const seen = new Set();
    while (stack.length > 0) {
      const via = stack.pop();
      if (via && typeof via === "object" && via.url === url) {
        names.push(vuln.name);
        break;
      }
      if (typeof via === "string" && !seen.has(via)) {
        seen.add(via);
        const next = vulnerabilitiesByName[via];
        if (next) {
          stack.push(...(next.via ?? []));
        }
      }
    }
  }
  return names;
}

function main() {
  const today = todayUtc();
  const expired = ALLOWLIST.filter((entry) => entry.expires < today);
  if (expired.length > 0) {
    console.error(
      "npm-audit allowlist has expired entries that must be re-reviewed " +
        "before this check can pass:",
    );
    for (const entry of expired) {
      console.error(`  - ${entry.id} (${entry.package}), expired ${entry.expires}`);
    }
    console.error(
      "\nRe-run `npm audit --omit=dev --audit-level=high` for real and " +
        "either renew the expiry date in scripts/check-npm-audit.mjs (if " +
        "still unfixed upstream) or remove the entry (if a fix shipped).",
    );
    process.exit(1);
  }

  const report = runAudit();
  const vulnerabilitiesByName = report.vulnerabilities ?? {};

  // Evaluate each LEAF advisory's own severity — never the rolled-up
  // container severity npm audit stamps on `@expo/cli`/`expo` — so a
  // moderate finding (like uuid's) dragged into a "high" container by an
  // unrelated sibling advisory (like node-forge's) isn't mistaken for
  // something that needs its own allowlist entry.
  const leafAdvisoriesByUrl = collectLeafAdvisories(vulnerabilitiesByName);
  const highOrCriticalLeaves = [...leafAdvisoriesByUrl.values()].filter(
    (a) => a.severity === "high" || a.severity === "critical",
  );

  if (highOrCriticalLeaves.length === 0) {
    console.log("npm audit: no high/critical findings. Clean.");
    process.exit(0);
  }

  const allowedIds = [...new Set(ALLOWLIST.map((e) => e.id))];
  const unexplained = [];
  const explained = [];

  for (const advisory of highOrCriticalLeaves) {
    const matchedId = allowedIds.find((id) => advisory.url.includes(id));
    const names = topLevelNamesReaching(advisory.url, vulnerabilitiesByName);
    const entry = {
      title: advisory.title ?? advisory.name,
      severity: advisory.severity,
      url: advisory.url,
      via: names.join(", ") || "(unknown path)",
    };
    if (matchedId) {
      explained.push(entry);
    } else {
      unexplained.push(entry);
    }
  }

  if (unexplained.length > 0) {
    const summary = unexplained
      .map((u) => `${u.title} (${u.severity}) via ${u.via}: ${u.url}`)
      .join(" | ");
    // Also as a GitHub Actions error annotation, so it's visible via the
    // check-run annotations API even when the raw job log isn't reachable.
    console.log(
      `::error title=npm audit - unexplained findings::${summary}`,
    );
    console.error(
      "npm audit found high/critical advisories NOT covered by the " +
        "allowlist in scripts/check-npm-audit.mjs:",
    );
    for (const u of unexplained) {
      console.error(`  - ${u.title} (${u.severity}) via ${u.via}: ${u.url}`);
    }
    process.exit(1);
  }

  console.log(
    `npm audit: ${highOrCriticalLeaves.length} high/critical advisory(ies), ` +
      "all covered by the dated allowlist (see scripts/check-npm-audit.mjs):",
  );
  for (const e of explained) {
    console.log(`  - ${e.title} (${e.severity}) via ${e.via}`);
  }
  process.exit(0);
}

try {
  main();
} catch (err) {
  console.log(`::error title=npm audit script crashed::${err?.message ?? err}`);
  console.error(err);
  process.exit(1);
}
