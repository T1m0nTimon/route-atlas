"use strict";

const BUILT_IN = [
  { id: "api", label: "API", icon: "plug", pattern: "(^|/)(api|graphql|rest|rpc|trpc|webhooks?|v\\d+)(/|$)" },
  { id: "admin", label: "Admin", icon: "shield", pattern: "(^|/)(admin|administration|backoffice|backend|cms|manage|verwaltung|wp-admin)(/|$)" },
  { id: "auth", label: "Auth", icon: "key", pattern: "^/(auth|login|logout|signin|signout|sign-in|sign-out|signup|sign-up|register|registrieren|anmelden|abmelden|oauth|sso|password|passwort|forgot-password|reset-password|verify)(/|$)" },
  { id: "account", label: "Account", icon: "account", pattern: "^/(account|accounts|konto|profile|profil|me|settings|einstellungen|billing)(/|$)" },
  { id: "legal", label: "Legal", icon: "law", pattern: "^/(impressum|imprint|datenschutz|privacy|terms|tos|agb|legal|cookies)(/|$)" },
  { id: "system", label: "System", icon: "server-process", pattern: "^/(health|healthz|ready|readyz|livez|status|metrics|ping|sitemap|sitemap\\.xml|robots\\.txt|manifest\\.json|favicon\\.ico|static|assets|_\\w+)(/|$)" },
];
const PAGES = { id: "pages", label: "Pages", icon: "browser" };
const ORDER = ["pages", "admin", "api", "auth", "account"];

function compile(rules) {
  return rules.flatMap((rule) => {
    try {
      return [{ ...rule, regex: new RegExp(rule.pattern, "i") }];
    } catch {
      return [];
    }
  });
}

/** Skips leading parameters, so /:lang/admin counts as /admin. */
function matchable(route) {
  return route.replace(/^(\/:[^/]+)+(?=\/)/, "");
}

function firstSegment(route) {
  return matchable(route).split("/").filter(Boolean)[0] || "";
}

/**
 * Sorts routes into categories. Own rules win, then the built-in ones. What is left
 * gets a category of its own once a first path segment appears at least twice.
 */
function categorize(routes, customRules = []) {
  const custom = compile(customRules.map((rule, index) => ({ id: `custom-${index}`, icon: "tag", ...rule })));
  const rules = [...custom, ...compile(BUILT_IN)];
  const groups = new Map();
  const put = (group, route) => {
    if (!groups.has(group.id)) groups.set(group.id, { id: group.id, label: group.label, icon: group.icon, routes: [] });
    groups.get(group.id).routes.push(route);
  };

  const rest = [];
  for (const route of routes) {
    const target = matchable(route.path);
    const rule = rules.find((item) => item.regex.test(target));
    if (rule) put(rule, route);
    else if (route.admin) put(BUILT_IN[1], route);
    else if (route.kind === "api") put(BUILT_IN[0], route);
    else rest.push(route);
  }

  const counts = {};
  for (const route of rest) {
    const first = firstSegment(route.path);
    counts[first] = (counts[first] || 0) + 1;
  }
  for (const route of rest) {
    const first = firstSegment(route.path);
    if (first && !first.startsWith(":") && counts[first] >= 2) put({ id: `auto-${first}`, label: `/${first}`, icon: "folder" }, route);
    else put(PAGES, route);
  }

  const rank = (group) => {
    const index = ORDER.indexOf(group.id);
    if (group.id.startsWith("custom-")) return -1;
    if (index !== -1) return index;
    return group.id.startsWith("auto-") ? ORDER.length : ORDER.length + 1;
  };
  return [...groups.values()].sort((a, b) => rank(a) - rank(b) || a.label.localeCompare(b.label));
}

module.exports = { categorize };
