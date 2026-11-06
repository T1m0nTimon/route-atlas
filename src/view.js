"use strict";

const vscode = require("vscode");
const { buildTree, groupRoutes } = require("./tree");

const OPEN_GROUPS = new Set(["admin", "api", "pages", "favorites", "all"]);

class Node {
  constructor(type, data) {
    this.type = type;
    Object.assign(this, data);
  }
}

class RouteTree {
  constructor({ state, t }) {
    this.state = state;
    this.t = t;
    this.changed = new vscode.EventEmitter();
    this.onDidChangeTreeData = this.changed.event;
    this.results = [];
    this.filter = "";
    this.mode = state.get("mode", "area");
    this.favorites = new Set(state.get("favorites", []));
    this.statuses = new Map();
    this.warnings = new Map();
  }

  refresh() {
    this.changed.fire();
  }

  visible(routes) {
    const term = this.filter.toLowerCase();
    if (!term) return routes;
    return routes.filter((route) => `${route.path} ${route.methods.join(" ")} ${route.source}`.toLowerCase().includes(term));
  }

  key(result, route) {
    return `${result.folder.uri.toString()}|${route.path}`;
  }

  toggleFavorite(result, route) {
    const key = this.key(result, route);
    if (!this.favorites.delete(key)) this.favorites.add(key);
    this.state.update("favorites", [...this.favorites]);
    this.refresh();
  }

  nodes(entries, result, scope) {
    return entries.map((entry) => new Node(entry.route ? "route" : "dir", { entry, result, scope }));
  }

  groups(result) {
    const routes = this.visible(result.routes);
    const rules = vscode.workspace.getConfiguration("routeAtlas").get("categories");
    const groups = groupRoutes(routes, this.mode, { rules, root: result.folder.uri.fsPath });
    const list = [];
    const favorites = routes.filter((route) => this.favorites.has(this.key(result, route)));
    if (favorites.length) {
      const flat = favorites.map((route) => ({ label: route.path, full: route.path, route, children: [] }));
      list.push(new Node("group", { group: { id: "favorites", label: "Favorites", icon: "star-full", routes: favorites }, entries: flat, result }));
    }
    if (this.mode === "path") return [...list, ...this.nodes(buildTree(routes), result, "all")];
    for (const group of groups) {
      let entries = buildTree(group.routes);
      let own;
      // A single root folds into its group, or /admin would show up twice.
      if (entries.length === 1) {
        own = entries[0];
        entries = own.children;
      }
      list.push(new Node("group", { group, entries, own, result }));
    }
    return list;
  }

  getChildren(node) {
    if (!node) {
      if (this.results.length > 1) {
        return this.results.filter((result) => this.visible(result.routes).length).map((result) => new Node("folder", { result }));
      }
      return this.results.length ? this.groups(this.results[0]) : [];
    }
    if (node.type === "folder") return this.groups(node.result);
    if (node.type === "group") return this.nodes(node.entries, node.result, node.group.id);
    return this.nodes(node.entry.children, node.result, node.scope);
  }

  getTreeItem(node) {
    const { Collapsed, Expanded, None } = vscode.TreeItemCollapsibleState;
    const base = node.result.folder.uri.toString();
    if (node.type === "folder") {
      const item = new vscode.TreeItem(node.result.folder.name, Expanded);
      item.iconPath = new vscode.ThemeIcon("root-folder");
      item.description = String(this.visible(node.result.routes).length);
      return item;
    }
    if (node.type === "group") {
      const { group, own, entries } = node;
      const open = OPEN_GROUPS.has(group.id) || Boolean(this.filter);
      const item = new vscode.TreeItem(this.t(group.label), entries.length ? (open ? Expanded : Collapsed) : None);
      item.id = `${base}#${this.mode}#${group.id}#${open}`;
      item.iconPath = new vscode.ThemeIcon(group.icon);
      const place = own && own.full !== `/${group.label}`.replace("//", "/") ? `${own.full}  ` : "";
      item.description = `${place}${group.routes.length}`;
      if (own && own.route) this.attach(item, own.route, node.result);
      return item;
    }
    const { entry } = node;
    const state = entry.children.length ? (this.filter ? Expanded : Collapsed) : None;
    const item = new vscode.TreeItem(entry.label, state);
    item.id = `${base}#${this.mode}#${node.scope}#${entry.full}#${Boolean(this.filter)}`;
    if (entry.route) this.decorate(item, entry.route, node.result);
    else item.iconPath = new vscode.ThemeIcon("folder");
    return item;
  }

  attach(item, route, result) {
    item.command = { command: "routeAtlas.open", title: "", arguments: [{ route, result }] };
    item.contextValue = this.context(route, result);
  }

  context(route, result) {
    const kind = route.kind === "api" && !route.methods.includes("GET") ? "endpoint" : "route";
    return this.favorites.has(this.key(result, route)) ? `${kind}.favorite` : kind;
  }

  decorate(item, route, result) {
    this.attach(item, route, result);
    const status = this.statuses.get(this.key(result, route));
    const warnings = this.warnings.get(this.key(result, route)) || [];
    const methods = route.methods.filter((method) => method !== "GET" || route.methods.length > 1).join(" ");
    item.description = [status ? (status.status || "-") : "", methods].filter(Boolean).join("  ");
    let icon = new vscode.ThemeIcon(route.protected ? "lock" : route.kind === "api" ? "symbol-method" : "file");
    if (status) {
      const code = status.status;
      if (code === 0 || code >= 500) icon = new vscode.ThemeIcon("error", new vscode.ThemeColor("testing.iconFailed"));
      else if (code === 401 || code === 403) icon = new vscode.ThemeIcon("lock", new vscode.ThemeColor("testing.iconPassed"));
      else if (code >= 400) icon = new vscode.ThemeIcon("question", new vscode.ThemeColor("list.warningForeground"));
      else icon = new vscode.ThemeIcon("pass", new vscode.ThemeColor("testing.iconPassed"));
    }
    if (warnings.length) icon = new vscode.ThemeIcon("warning", new vscode.ThemeColor("list.warningForeground"));
    item.iconPath = icon;
    const where = vscode.workspace.asRelativePath(route.file);
    item.tooltip = new vscode.MarkdownString(
      [
        `**${route.path}**`,
        route.methods.join(", "),
        `${route.source}${route.protected ? ` · ${this.t("Protected")}` : ""}`,
        `${where}:${route.line + 1}`,
        ...warnings.map((warning) => `$(warning) ${warning}`),
      ]
        .filter(Boolean)
        .join("  \n"),
      true,
    );
  }
}

module.exports = { RouteTree };
