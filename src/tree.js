"use strict";

const path = require("path");
const { categorize } = require("./categories");

function compareSegments(a, b) {
  const param = (value) => /^\/?:/.test(value);
  if (param(a.label) !== param(b.label)) return param(a.label) ? 1 : -1;
  return a.label.localeCompare(b.label);
}

function sortNodes(nodes) {
  nodes.sort(compareSegments);
  nodes.forEach((node) => sortNodes(node.children));
  return nodes;
}

/** Folds folders that hold nothing but one other folder: /api > /v1 becomes /api/v1. */
function compress(node) {
  node.children.forEach(compress);
  if (!node.route && node.children.length === 1) {
    const [only] = node.children;
    node.label += only.label;
    node.full = only.full;
    node.route = only.route;
    node.children = only.children;
  }
}

/** Turns flat routes into a tree of path segments. A node can be a page and a folder at once. */
function buildTree(routes) {
  const root = { label: "", full: "", children: [] };
  for (const route of routes) {
    let node = root;
    let full = "";
    for (const part of route.path.split("/").filter(Boolean)) {
      full += `/${part}`;
      let next = node.children.find((child) => child.full === full);
      if (!next) {
        next = { label: `/${part}`, full, children: [] };
        node.children.push(next);
      }
      node = next;
    }
    if (node === root) root.route = route;
    else node.route = route;
  }
  root.children.forEach(compress);
  const nodes = sortNodes(root.children);
  if (root.route) nodes.unshift({ label: "/", full: "/", route: root.route, children: [] });
  return nodes;
}

const MODES = ["area", "path", "file", "framework", "method", "access"];

function bucket(routes, keysOf, icon) {
  const groups = new Map();
  for (const route of routes) {
    for (const key of keysOf(route)) {
      if (!groups.has(key)) groups.set(key, { id: `${icon}-${key}`, label: key, icon, routes: [] });
      groups.get(key).routes.push(route);
    }
  }
  return [...groups.values()].sort((a, b) => a.label.localeCompare(b.label));
}

function groupRoutes(routes, mode, { rules = [], root = "" } = {}) {
  switch (mode) {
    case "path":
      return [{ id: "all", label: "", icon: "", routes }];
    case "file":
      return bucket(routes, (route) => [...new Set(route.locations.map((place) => path.relative(root, place.file).split(path.sep).join("/")))], "file-code");
    case "framework":
      return bucket(routes, (route) => [route.source], "extensions");
    case "method":
      return bucket(routes, (route) => (route.methods.length ? route.methods : ["ANY"]), "symbol-method");
    case "access":
      return bucket(routes, (route) => [route.protected ? "Protected" : "Public"], "lock");
    default:
      return categorize(routes, rules);
  }
}

/** Advice per route: handlers that shadow each other and admin pages without a visible login check. */
const GUARDED_SOURCES = new Set(["Flask", "Quart", "FastAPI", "Express", "Fastify", "Hono", "Koa", "NestJS"]);

function findings(routes, rules = []) {
  const admin = categorize(routes, rules).find((group) => group.id === "admin");
  const results = [];
  for (const route of routes) {
    for (const { first, second } of route.conflicts) {
      results.push({ type: "conflict", route, file: second.file, line: second.line, other: first });
    }
  }
  for (const route of admin ? admin.routes : []) {
    if (!route.protected && !route.guardedElsewhere && GUARDED_SOURCES.has(route.source)) {
      results.push({ type: "unprotected", route, file: route.file, line: route.line });
    }
  }
  return results;
}

/** The route that answers a concrete address, static routes before parameters. */
function matchRoute(routes, address) {
  const clean = address.replace(/^https?:\/\/[^/]+/, "").split(/[?#]/)[0].replace(/\/$/, "") || "/";
  const pattern = (route) =>
    new RegExp(`^${route.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\/:\w+\*/g, "(?:/.*)?").replace(/:\w+/g, "[^/]+")}$`);
  return routes.find((route) => route.path === clean) || routes.find((route) => route.path.includes(":") && pattern(route.path).test(clean));
}

module.exports = { MODES, buildTree, groupRoutes, findings, matchRoute };
