"use strict";

const path = require("path");
const { walk, read, isTestFile, stripComments } = require("./scanner");
const { matchRoute } = require("./tree");

const LINK_EXT = new Set([
  ".js", ".jsx", ".mjs", ".cjs", ".ts", ".tsx", ".mts", ".cts", ".vue", ".svelte", ".astro",
  ".html", ".htm", ".php", ".py", ".rb", ".md", ".mdx",
]);
const PAGE_EXT = /\.(html?|php)$/i;
const VALUE = String.raw`(\/(?!\/)[^"'\`\s]*)`;
const QUOTED = String.raw`(["'\`])${VALUE}\1`;

/** Places where a string is clearly an address inside this app. */
const PATTERNS = [
  // <a href="/x">, <Link to="/x">, <form action="/x">, href={"/x"}, :to="'/x'"
  new RegExp(String.raw`\b(?:href|to|action|formAction|hx-(?:get|post|put|patch|delete))\s*=\s*\{?\s*${QUOTED}`, "dg"),
  // { title: "Docs", href: "/docs" } in navigation configs
  new RegExp(String.raw`(?:^|[{,\s])["']?(?:href|to)["']?\s*:\s*${QUOTED}`, "dg"),
  // fetch("/x"), redirect("/x"), navigate("/x"), axios.get("/x"), router.push("/x"), ...
  new RegExp(
    String.raw`(?:\bfetch|\$fetch|\buseFetch|\buseLazyFetch|\bofetch|\bredirect|\bpermanentRedirect|\bnavigate|\bnavigateTo|\bgoto|\bredirect_to|\bRedirectResponse|\bHttpResponseRedirect|\baxios(?:\.(?:get|post|put|patch|delete|head|options))?|\b(?:router|history|navigation|\$router)\.(?:push|replace|navigate)|\blocation\.(?:assign|replace))\s*\(\s*(?:url\s*=\s*)?${QUOTED}`,
    "dg",
  ),
  // location.href = "/x", window.location = "/x"
  new RegExp(String.raw`\blocation(?:\.href)?\s*=\s*${QUOTED}`, "dg"),
];
const MARKDOWN = /\]\((\/(?!\/)[^)\s]*)\)/dg;

/** Keeps offsets, so line numbers stay right. */
function blank(text) {
  return text.replace(/[^\n]/g, " ");
}

/** Turns `/users/${id}` or `/users/{{ id }}` into a concrete path that a route with a parameter matches. */
function concrete(value) {
  const filled = value
    .replace(/\$\{[^}]*\}/g, "x")
    .replace(/\{\{[^}]*\}\}/g, "x")
    .replace(/<\?[\s\S]*?\?>/g, "x")
    .replace(/<%[\s\S]*?%>/g, "x");
  if (/[{}<>$]/.test(filled)) return undefined;
  return filled.split(/[?#]/)[0].replace(/\/$/, "") || "/";
}

function lineStarts(text) {
  const starts = [0];
  for (let i = text.indexOf("\n"); i !== -1; i = text.indexOf("\n", i + 1)) starts.push(i + 1);
  return starts;
}

function position(starts, index) {
  let low = 0;
  let high = starts.length - 1;
  while (low < high) {
    const middle = (low + high + 1) >> 1;
    if (starts[middle] <= index) low = middle;
    else high = middle - 1;
  }
  return { line: low, column: index - starts[low] };
}

/** Every address in `text` that points into this app, with its place. */
function extractLinks(text, ext) {
  let clean = stripComments(text, ext).replace(/<!--[\s\S]*?-->/g, blank);
  if (ext === ".md" || ext === ".mdx") clean = clean.replace(/```[\s\S]*?```/g, blank).replace(/`[^`\n]*`/g, blank);
  const starts = lineStarts(clean);
  const found = [];
  const seen = new Set();
  const take = (value, start) => {
    if (seen.has(start)) return;
    seen.add(start);
    const target = concrete(value);
    if (target) found.push({ value, path: target, ...position(starts, start), length: value.length });
  };
  const patterns = ext === ".md" || ext === ".mdx" ? [...PATTERNS, MARKDOWN] : PATTERNS;
  for (const pattern of patterns) {
    pattern.lastIndex = 0;
    const group = pattern === MARKDOWN ? 1 : 2;
    for (let match; (match = pattern.exec(clean)); ) {
      // "/users/" + id is only the start of an address.
      const after = match.indices[group][1] + 1;
      if (pattern !== MARKDOWN && /^\s*\+/.test(clean.slice(after, after + 40))) continue;
      take(match[group], match.indices[group][0]);
    }
  }
  return found.sort((a, b) => a.line - b.line || a.column - b.column);
}

/** Files, images and other assets are served by the server, not by a route. */
function isAsset(target, routes) {
  const last = target.split("/").pop();
  if (!/\.\w{1,5}$/.test(last)) return false;
  return !(PAGE_EXT.test(last) && routes.some((route) => PAGE_EXT.test(route.path)));
}

function isKnown(routes, target) {
  if (matchRoute(routes, target)) return true;
  return routes.some((route) => {
    const star = route.path.indexOf("*");
    if (star === -1 || /:\w+\*$/.test(route.path)) return false;
    return target.startsWith(route.path.slice(0, star).replace(/\/$/, ""));
  });
}

function distance(a, b) {
  const row = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let i = 1; i <= a.length; i++) {
    let previous = row[0];
    row[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const current = row[j];
      row[j] = Math.min(row[j] + 1, row[j - 1] + 1, previous + (a[i - 1] === b[j - 1] ? 0 : 1));
      previous = current;
    }
  }
  return row[b.length];
}

/** The route path with the link's own values in place of its parameters, if both have the same shape. */
function fillLike(routePath, target) {
  const want = routePath.split("/");
  const have = target.split("/");
  if (want.length !== have.length || routePath.includes("*")) return routePath;
  return want.map((part, index) => (part.startsWith(":") ? have[index] : part)).join("/");
}

/** The route that the author most likely meant, and the address to write instead. */
function suggest(routes, target) {
  let best;
  let bestScore = Infinity;
  for (const route of routes) {
    const candidate = fillLike(route.path, target);
    const score = distance(target.toLowerCase(), candidate.toLowerCase());
    if (score < bestScore) {
      best = { path: route.path, replacement: candidate.includes(":") ? undefined : candidate };
      bestScore = score;
    }
  }
  return best && bestScore > 0 && bestScore <= Math.max(2, Math.floor(target.length / 4)) ? best : undefined;
}

function compileIgnore(ignore) {
  return ignore
    .map((pattern) => {
      try {
        return new RegExp(pattern);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

/** Links whose address no route answers. */
function brokenLinks(routes, links, { ignore = [] } = {}) {
  if (!routes.length) return [];
  const skip = compileIgnore(ignore);
  return links
    .filter((link) => !isAsset(link.path, routes) && !skip.some((pattern) => pattern.test(link.path)) && !isKnown(routes, link.path))
    .map((link) => ({ ...link, suggestion: suggest(routes, link.path) }));
}

/** Looks through the whole project for links that lead nowhere. */
async function scanLinks(root, routes, { exclude = [], ignore = [] } = {}) {
  if (!routes.length) return [];
  const results = [];
  for (const file of await walk(root, { exclude })) {
    const ext = path.extname(file).toLowerCase();
    if (!LINK_EXT.has(ext) || isTestFile(root, file)) continue;
    const text = await read(file);
    if (!text || !/["'`(]\//.test(text)) continue;
    for (const link of brokenLinks(routes, extractLinks(text, ext), { ignore })) results.push({ file, ...link });
  }
  return results;
}

module.exports = { extractLinks, brokenLinks, scanLinks, suggest, isKnown };
