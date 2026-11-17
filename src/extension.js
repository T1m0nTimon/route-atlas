"use strict";

const fs = require("fs/promises");
const path = require("path");
const vscode = require("vscode");
const { scan, SKIP_DIRS, walk } = require("./scanner");
const { scanSecurity } = require("./security");
const { summarizeLanguages } = require("./languages");
const { dashboardHtml } = require("./dashboard");
const { MODES, findings, matchRoute } = require("./tree");
const { FORMATS } = require("./exporters");
const { scanLinks } = require("./links");
const { SNIPPETS } = require("./snippets");
const { toTypeScript } = require("./typed");
const { findServer, send, checkAll, checkable, isLocal } = require("./http");
const { createTranslator, resolveLanguage } = require("./i18n");
const { RouteTree } = require("./view");

const FRAMEWORK_PORTS = {
  "Next.js": 3000, Nuxt: 3000, Remix: 3000, Express: 3000, Rails: 3000, NestJS: 3000, SvelteKit: 5173, "Vue Router": 5173,
  "React Router": 5173, Astro: 4321, Angular: 4200, Flask: 5000, FastAPI: 8000, Django: 8000, Laravel: 8000, Spring: 8080, Go: 8080,
};
const MODE_LABELS = { area: "Areas", path: "Path tree", file: "File", framework: "Framework", method: "HTTP method", access: "Access" };
const SCHEME = "route-atlas";

function config() {
  return vscode.workspace.getConfiguration("routeAtlas");
}

async function envPort(folder) {
  for (const name of [".env.local", ".env"]) {
    try {
      const match = /^\s*PORT\s*=\s*"?(\d+)/m.exec(await fs.readFile(path.join(folder.uri.fsPath, name), "utf8"));
      if (match) return Number(match[1]);
    } catch {
      // Not every project has both files.
    }
  }
  return undefined;
}

async function locateServer(folder, routes) {
  const configured = config().get("baseUrl");
  if (configured) return { baseUrl: configured.replace(/\/$/, ""), running: true };
  const preferred = [await envPort(folder), routes[0] && FRAMEWORK_PORTS[routes[0].source]].filter(Boolean);
  const port = await findServer(preferred);
  return { baseUrl: `http://127.0.0.1:${port || preferred[0] || 3000}`, running: Boolean(port) };
}

/** Intl only knows the locale of the extension host, VS Code passes the real one along. */
function systemLocale() {
  try {
    return JSON.parse(process.env.VSCODE_NLS_CONFIG).osLocale || "";
  } catch {
    return Intl.DateTimeFormat().resolvedOptions().locale;
  }
}

function activate(context) {
  const t = createTranslator(resolveLanguage(config().get("language"), vscode.env.language, systemLocale()));
  const tree = new RouteTree({ state: context.workspaceState, t });
  const view = vscode.window.createTreeView("routeAtlas.routes", { treeDataProvider: tree, showCollapseAll: true });
  const problems = vscode.languages.createDiagnosticCollection("Route Atlas");
  const statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 20);
  const lensChanged = new vscode.EventEmitter();
  const documents = new Map();
  const documentChanged = new vscode.EventEmitter();
  const linkFixes = new Map();
  statusBar.command = "routeAtlas.search";
  let timer;
  let running = false;
  let again = false;
  let serial = 0;

  const showState = () => {
    const total = tree.results.reduce((sum, result) => sum + tree.visible(result.routes).length, 0);
    view.badge = total ? { value: total, tooltip: t("{0} routes", total) } : undefined;
    view.message = tree.filter ? t("Filter: {0}", tree.filter) : undefined;
    vscode.commands.executeCommand("setContext", "routeAtlas.filtered", Boolean(tree.filter));
    vscode.commands.executeCommand("setContext", "routeAtlas.empty", total === 0 && !tree.filter);
    const first = tree.results[0];
    if (!first || !first.routes.length) {
      statusBar.hide();
      return;
    }
    statusBar.text = `$(${first.running ? "radio-tower" : "type-hierarchy"}) ${total}`;
    statusBar.tooltip = `${t("{0} routes", total)}\n${first.running ? t("Server running at {0}", first.baseUrl) : t("No server found, using {0}", first.baseUrl)}`;
    statusBar.show();
  };

  const showFindings = () => {
    problems.clear();
    tree.warnings.clear();
    linkFixes.clear();
    if (!config().get("diagnostics")) return;
    const perFile = new Map();
    const report = (file, diagnostic) => {
      if (!perFile.has(file)) perFile.set(file, []);
      perFile.get(file).push(diagnostic);
    };
    for (const link of tree.results.flatMap((result) => result.links || [])) {
      const range = new vscode.Range(link.line, link.column, link.line, link.column + link.length);
      const hint = link.suggestion ? ` ${t("Did you mean {0}?", link.suggestion.path)}` : "";
      const diagnostic = new vscode.Diagnostic(range, t("No route answers {0}.", link.path) + hint, vscode.DiagnosticSeverity.Warning);
      diagnostic.source = "Route Atlas";
      diagnostic.code = "broken-link";
      if (link.suggestion && link.suggestion.replacement && !/[$}{<%]/.test(link.value)) {
        // Keep the query and the anchor of the original link.
        const kept = link.value.slice(link.value.split(/[?#]/)[0].replace(/\/$/, "").length);
        linkFixes.set(`${vscode.Uri.file(link.file).toString()}|${link.line}|${link.column}`, link.suggestion.replacement + kept);
      }
      report(link.file, diagnostic);
    }
    for (const result of tree.results) {
      for (const finding of findings(result.routes, config().get("categories"))) {
        const conflict = finding.type === "conflict";
        const where = conflict ? `${vscode.workspace.asRelativePath(finding.other.file)}:${finding.other.line + 1}` : "";
        const method = conflict ? finding.other.methods.join(" ") : "";
        const message = conflict
          ? t("{0} {1} is also handled at {2}, so one of them never runs.", method, finding.route.path, where)
          : t("This admin route has no login check that Route Atlas could find.");
        const diagnostic = new vscode.Diagnostic(
          new vscode.Range(finding.line, 0, finding.line, 200),
          message,
          conflict ? vscode.DiagnosticSeverity.Warning : vscode.DiagnosticSeverity.Information,
        );
        diagnostic.source = "Route Atlas";
        report(finding.file, diagnostic);
        const key = tree.key(result, finding.route);
        tree.warnings.set(key, [...(tree.warnings.get(key) || []), t(conflict ? "Handled twice" : "No login check found")]);
      }
    }
    for (const [file, list] of perFile) problems.set(vscode.Uri.file(file), list);
  };

  const refresh = async () => {
    if (running) {
      again = true;
      return;
    }
    running = true;
    try {
      const exclude = config().get("exclude");
      tree.results = await Promise.all(
        (vscode.workspace.workspaceFolders || []).map(async (folder) => {
          const runtimeExecutable = config().get("laravelRuntimeExecutable", "php");
          const runtimeArgs = config().get("laravelRuntimeArgs", ["artisan", "route:list", "--json"]);
          const routes = await scan(folder.uri.fsPath, {
            exclude,
            laravelRuntime: vscode.workspace.isTrusted && config().get("laravelRuntime", false),
            laravelRuntimeOptions: { executable: runtimeExecutable, args: runtimeArgs, requireArtisan: runtimeExecutable === "php" },
          });
          return { folder, routes, ...(await locateServer(folder, routes)) };
        }),
      );
      // In a multi-root workspace the frontend may link to routes of another folder.
      const known = tree.results.flatMap((result) => result.routes);
      if (config().get("diagnostics") && config().get("brokenLinks")) {
        const ignore = vscode.workspace.isTrusted ? config().get("ignoreLinks") : [];
        for (const result of tree.results) result.links = await scanLinks(result.folder.uri.fsPath, known, { exclude, ignore });
      }
      await writeHelpers();
      showFindings();
      tree.refresh();
      lensChanged.fire();
      showState();
    } finally {
      running = false;
      if (again) {
        again = false;
        refresh();
      }
    }
  };

  const schedule = (uri) => {
    if (uri && uri.fsPath.split(path.sep).some((part) => SKIP_DIRS.has(part))) return;
    clearTimeout(timer);
    timer = setTimeout(refresh, 700);
  };

  const target = (node) => {
    if (node && node.entry && node.entry.route) return { route: node.entry.route, result: node.result };
    if (node && node.own && node.own.route) return { route: node.own.route, result: node.result };
    return node;
  };

  const fillParameters = async (route) => {
    const remembered = context.workspaceState.get("parameters", {});
    let filled = route.path;
    for (const name of route.path.match(/:\w+\*?/g) || []) {
      const value = await vscode.window.showInputBox({ title: route.path, prompt: t("Value for {0}", name), value: remembered[name] || "" });
      if (value === undefined) return undefined;
      remembered[name] = value;
      filled = filled.replace(name, encodeURIComponent(value));
    }
    context.workspaceState.update("parameters", remembered);
    return filled;
  };

  const showDocument = async (name, content) => {
    const uri = vscode.Uri.from({ scheme: SCHEME, path: `/${++serial}/${name}` });
    documents.set(uri.toString(), content);
    documentChanged.fire(uri);
    await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(uri), { preview: true, viewColumn: vscode.ViewColumn.Beside });
  };

  const sendRequest = async (node, chosen) => {
    const { route, result } = target(node);
    let method = chosen || route.methods[0] || "GET";
    if (!chosen && route.methods.length > 1) {
      method = await vscode.window.showQuickPick(route.methods, { title: route.path, placeHolder: t("Choose a method") });
      if (!method) return;
    }
    const filled = await fillParameters(route);
    if (filled === undefined) return;
    let body;
    if (!["GET", "HEAD", "OPTIONS", "DELETE"].includes(method)) {
      body = await vscode.window.showInputBox({ title: `${method} ${route.path}`, prompt: t("Request body (optional)"), placeHolder: '{"name": "value"}' });
      if (body === undefined) return;
    }
    const url = result.baseUrl + filled;
    let response;
    try {
      response = await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Window, title: t("Sending {0} {1}", method, filled) },
        () => send({ url, method, body, headers: config().get("requestHeaders") }),
      );
    } catch (error) {
      const refused = /fetch failed|ECONNREFUSED/.test(`${error.message} ${error.cause && error.cause.code}`);
      const action = await vscode.window.showErrorMessage(
        refused ? t("No server answers at {0}. Start it, or set the address.", result.baseUrl) : t("Request failed: {0}", error.message),
        t("Set the server address"),
      );
      if (action) vscode.commands.executeCommand("routeAtlas.setServer");
      return;
    }
    const type = response.headers["content-type"] || "";
    let text = response.text;
    let extension = "txt";
    if (/json/.test(type)) {
      extension = "json";
      try {
        text = JSON.stringify(JSON.parse(text), null, 2);
      } catch {
        // Broken JSON is worth seeing as it came.
      }
    } else if (/html/.test(type)) extension = "html";
    else if (/xml/.test(type)) extension = "xml";
    await showDocument(`${method} ${filled.replace(/\//g, "_") || "_"}.${extension}`, text);
    const summary = `${method} ${filled}: ${response.status} ${response.statusText} · ${response.ms} ms`;
    const show = t("Show headers");
    const choice = await (response.status >= 400 ? vscode.window.showWarningMessage : vscode.window.showInformationMessage)(summary, show);
    if (choice === show) {
      showDocument("headers.txt", Object.entries(response.headers).map(([name, value]) => `${name}: ${value}`).join("\n"));
    }
  };

  const helpersTarget = (result) => {
    const setting = vscode.workspace.isTrusted ? config().get("helpersFile") : "";
    if (!setting) return undefined;
    const folder = result.folder.uri.fsPath;
    const file = path.resolve(folder, setting);
    const relative = path.relative(folder, file);
    return relative.startsWith("..") || path.isAbsolute(relative) ? undefined : file;
  };

  /** Keeps the file from `routeAtlas.helpersFile` in step with the routes. */
  const writeHelpers = async () => {
    for (const result of tree.results) {
      const file = helpersTarget(result);
      if (!file || !result.routes.length) continue;
      const content = toTypeScript(result.routes);
      try {
        if ((await fs.readFile(file, "utf8")) === content) continue;
      } catch {
        // Not written yet.
      }
      try {
        await fs.mkdir(path.dirname(file), { recursive: true });
        await fs.writeFile(file, content);
      } catch (error) {
        vscode.window.showWarningMessage(t("Could not write {0}: {1}", file, error.message));
      }
    }
  };

  const generateHelpers = async () => {
    const [result] = tree.results;
    if (!result || !result.routes.length) return;
    const suggested = helpersTarget(result) || path.join(result.folder.uri.fsPath, "src", "routes.gen.ts");
    const uri = await vscode.window.showSaveDialog({ defaultUri: vscode.Uri.file(suggested), filters: { TypeScript: ["ts"] }, title: t("Save route helpers") });
    if (!uri) return;
    await vscode.workspace.fs.writeFile(uri, Buffer.from(toTypeScript(result.routes)));
    await vscode.window.showTextDocument(uri);
    const relative = path.relative(result.folder.uri.fsPath, uri.fsPath).split(path.sep).join("/");
    if (relative.startsWith("..") || path.isAbsolute(relative) || config().get("helpersFile") === relative) return;
    const keep = t("Keep it up to date");
    if ((await vscode.window.showInformationMessage(t("Update {0} whenever routes change?", relative), keep)) === keep) {
      await config().update("helpersFile", relative, vscode.ConfigurationTarget.Workspace);
    }
  };

  const copyAs = async (node) => {
    const { route, result } = target(node);
    const format = await vscode.window.showQuickPick(SNIPPETS, { title: t("Copy {0} as", route.path) });
    if (!format) return;
    let method = route.methods[0] || "GET";
    if (route.methods.length > 1) {
      method = await vscode.window.showQuickPick(route.methods, { title: route.path, placeHolder: t("Choose a method") });
      if (!method) return;
    }
    const filled = await fillParameters(route);
    if (filled === undefined) return;
    let body;
    if (!["GET", "HEAD", "OPTIONS", "DELETE"].includes(method)) {
      body = await vscode.window.showInputBox({ title: `${method} ${route.path}`, prompt: t("Request body (optional)"), placeHolder: '{"name": "value"}' });
      if (body === undefined) return;
    }
    const headers = config().get("requestHeaders") || {};
    await vscode.env.clipboard.writeText(format.render({ method, url: result.baseUrl + filled, headers, body: body || undefined }));
    vscode.window.setStatusBarMessage(t("Copied {0} {1} as {2}", method, filled, format.label), 4000);
  };

  const openRoute = async ({ route }) => {
    if (route.runtime) {
      const details = [
        `${route.methods.join(", ") || "ANY"} ${route.path}`,
        route.name ? `Name: ${route.name}` : "",
        route.action ? `Action: ${route.action}` : "",
        route.middleware && route.middleware.length ? `Middleware: ${route.middleware.join(", ")}` : "",
        "Registered by the running Laravel application. The defining source file is not included in route:list --json.",
      ].filter(Boolean).join("\n");
      await showDocument(`Laravel ${route.path.replace(/[^a-z0-9_-]+/gi, "_")}.txt`, details);
      return;
    }
    const document = await vscode.workspace.openTextDocument(route.file);
    const position = new vscode.Position(route.line, 0);
    await vscode.window.showTextDocument(document, { selection: new vscode.Range(position, position), preview: true });
  };

  const openBrowser = async (node) => {
    const { route, result } = target(node);
    const filled = await fillParameters(route);
    if (filled !== undefined) vscode.env.openExternal(vscode.Uri.parse(result.baseUrl + filled));
  };

  const allRoutes = () => tree.results.flatMap((result) => result.routes.map((route) => ({ route, result })));

  const watcher = vscode.workspace.createFileSystemWatcher("**/*.{py,js,jsx,mjs,cjs,ts,tsx,vue,svelte,astro,md,mdx,php,rb,java,kt,cs,go,rs,html,htm,swift,c,h,cc,cpp,cxx,hpp,m,mm,fs,fsx,vb,scala,groovy,dart,lua,pl,ex,exs,erl,hs,lhs,clj,cljs,r,jl,sql,sh,bash,zsh,ps1,css,scss,sass,less,json,jsonc,yaml,yml,toml,xml,graphql,gql,proto,tf,hcl,ipynb}");
  const command = (name, handler) => vscode.commands.registerCommand(`routeAtlas.${name}`, handler);
  context.subscriptions.push(
    view,
    watcher,
    problems,
    statusBar,
    watcher.onDidCreate(schedule),
    watcher.onDidChange(schedule),
    watcher.onDidDelete(schedule),
    vscode.workspace.onDidChangeWorkspaceFolders(() => schedule()),
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration("routeAtlas")) schedule();
    }),
    vscode.workspace.registerTextDocumentContentProvider(SCHEME, {
      onDidChange: documentChanged.event,
      provideTextDocumentContent: (uri) => documents.get(uri.toString()) || "",
    }),
    vscode.languages.registerCodeLensProvider({ scheme: "file" }, {
      onDidChangeCodeLenses: lensChanged.event,
      provideCodeLenses(document) {
        if (!config().get("codeLens")) return [];
        const lenses = [];
        for (const { route, result } of allRoutes()) {
          for (const place of route.locations) {
            if (place.file !== document.uri.fsPath) continue;
            const range = new vscode.Range(place.line, 0, place.line, 0);
            const methods = place.methods.length ? place.methods : ["GET"];
            for (const method of methods) {
              lenses.push(new vscode.CodeLens(range, { title: `$(play) ${method} ${route.path}`, command: "routeAtlas.send", arguments: [{ route, result }, method] }));
            }
          }
        }
        return lenses;
      },
    }),
    vscode.languages.registerCodeActionsProvider({ scheme: "file" }, {
      provideCodeActions(document, _range, { diagnostics }) {
        const actions = [];
        for (const diagnostic of diagnostics) {
          if (diagnostic.source !== "Route Atlas" || diagnostic.code !== "broken-link") continue;
          const { line, character } = diagnostic.range.start;
          const replacement = linkFixes.get(`${document.uri.toString()}|${line}|${character}`);
          if (!replacement) continue;
          const action = new vscode.CodeAction(t("Change to {0}", replacement), vscode.CodeActionKind.QuickFix);
          action.edit = new vscode.WorkspaceEdit();
          action.edit.replace(document.uri, diagnostic.range, replacement);
          action.diagnostics = [diagnostic];
          action.isPreferred = true;
          actions.push(action);
        }
        return actions;
      },
    }, { providedCodeActionKinds: [vscode.CodeActionKind.QuickFix] }),
    vscode.languages.registerDefinitionProvider({ scheme: "file" }, {
      provideDefinition(document, position) {
        const range = document.getWordRangeAtPosition(position, /["'`](?:https?:\/\/[^"'`\s]+)?\/[^"'`\s]*["'`]/);
        if (!range) return undefined;
        const found = matchRoute(allRoutes().map((item) => item.route), document.getText(range).slice(1, -1));
        return found ? new vscode.Location(vscode.Uri.file(found.file), new vscode.Position(found.line, 0)) : undefined;
      },
    }),
    command("securityScan", async () => {
      if (!vscode.workspace.isTrusted) { vscode.window.showWarningMessage("Security scanning is disabled in Restricted Mode. Trust this workspace to scan its files."); return; }
      const folders = vscode.workspace.workspaceFolders || []; if (!folders.length) return;
      const findings = []; const languageStats = new Map(); let routeCount = 0;
      await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: "Route Atlas: scanning project security", cancellable: false }, async () => {
        for (const folder of folders) {
          const files = await walk(folder.uri.fsPath, { exclude: config().get("exclude") || [] });
          routeCount += (tree.results.find((item) => item.folder.uri.fsPath === folder.uri.fsPath)?.routes || []).length;
          for (const item of summarizeLanguages(files)) languageStats.set(item.language, (languageStats.get(item.language) || 0) + item.files);
          findings.push(...await scanSecurity(folder.uri.fsPath, { exclude: config().get("exclude") || [] }));
        }
      });
      const diagnostics = vscode.languages.createDiagnosticCollection("Route Atlas Security"); const grouped = new Map();
      const severity = { critical: vscode.DiagnosticSeverity.Error, high: vscode.DiagnosticSeverity.Error, medium: vscode.DiagnosticSeverity.Warning, low: vscode.DiagnosticSeverity.Information };
      for (const finding of findings) {
        const uri = vscode.Uri.file(finding.file); const list = grouped.get(uri.toString()) || [];
        const line = Math.max(0, finding.line - 1); const column = Math.max(0, finding.column);
        const diagnostic = new vscode.Diagnostic(new vscode.Range(line, column, line, column + 1), finding.title + " (" + finding.cwe + "; " + finding.confidence + " confidence). Review manually; static detection can produce false positives.", severity[finding.severity] || vscode.DiagnosticSeverity.Warning);
        diagnostic.source = "Route Atlas Security"; diagnostic.code = finding.id; list.push(diagnostic); grouped.set(uri.toString(), list);
      }
      for (const [uri, list] of grouped) diagnostics.set(vscode.Uri.parse(uri), list); context.subscriptions.push(diagnostics);
      const languages = [...languageStats].map(([language, files]) => ({ language, files })).sort((a,b) => b.files-a.files);
      const panel = vscode.window.createWebviewPanel("routeAtlas.dashboard", "Route Atlas — Security & Project", vscode.ViewColumn.Beside, { enableScripts: false });
      panel.webview.html = dashboardHtml({ title: folders.map((folder) => folder.name).join(", "), routes: Array(routeCount), languages, findings });
      vscode.window.showInformationMessage("Route Atlas: " + findings.length + " security indicators found. Review the Problems panel; findings are heuristic, not confirmed vulnerabilities.");
    }),
    command("dashboard", () => vscode.commands.executeCommand("routeAtlas.securityScan")),
    command("refresh", refresh),
    command("filter", async () => {
      const value = await vscode.window.showInputBox({ title: t("Filter routes"), value: tree.filter, prompt: t("Path, method or framework") });
      if (value === undefined) return;
      tree.filter = value.trim();
      tree.refresh();
      showState();
    }),
    command("clearFilter", () => {
      tree.filter = "";
      tree.refresh();
      showState();
    }),
    command("groupBy", async () => {
      const items = MODES.map((mode) => ({ label: t(MODE_LABELS[mode]), mode, picked: mode === tree.mode, description: mode === tree.mode ? "✓" : "" }));
      const choice = await vscode.window.showQuickPick(items, { title: t("Group routes by") });
      if (!choice) return;
      tree.mode = choice.mode;
      context.workspaceState.update("mode", choice.mode);
      tree.refresh();
    }),
    command("search", async () => {
      const items = allRoutes().map((item) => ({
        label: item.route.path,
        description: item.route.methods.join(" "),
        detail: `${vscode.workspace.asRelativePath(item.route.file)}:${item.route.line + 1}`,
        item,
        buttons: [
          { iconPath: new vscode.ThemeIcon("play"), tooltip: t("Send request"), action: sendRequest },
          { iconPath: new vscode.ThemeIcon("globe"), tooltip: t("Open in browser"), action: openBrowser },
        ],
      }));
      const pick = vscode.window.createQuickPick();
      pick.title = t("Find a route");
      pick.placeholder = t("Type a path, method or file");
      pick.items = items;
      pick.matchOnDescription = true;
      pick.matchOnDetail = true;
      pick.onDidAccept(() => {
        const [selected] = pick.selectedItems;
        pick.hide();
        if (selected) openRoute(selected.item);
      });
      pick.onDidTriggerItemButton(({ button, item }) => {
        pick.hide();
        button.action(item.item);
      });
      pick.onDidHide(() => pick.dispose());
      pick.show();
    }),
    command("open", (node) => openRoute(target(node))),
    command("browser", openBrowser),
    command("send", sendRequest),
    command("favorite", (node) => {
      const { route, result } = target(node);
      tree.toggleFavorite(result, route);
    }),
    command("unfavorite", (node) => {
      const { route, result } = target(node);
      tree.toggleFavorite(result, route);
    }),
    command("copyAs", copyAs),
    command("generateHelpers", generateHelpers),
    command("copyPath", (node) => vscode.env.clipboard.writeText(target(node).route.path)),
    command("copyUrl", async (node) => {
      const { route, result } = target(node);
      const filled = await fillParameters(route);
      if (filled !== undefined) vscode.env.clipboard.writeText(result.baseUrl + filled);
    }),
    command("setServer", async () => {
      const value = await vscode.window.showInputBox({
        title: t("Server address"),
        prompt: t("Leave empty to detect it"),
        value: config().get("baseUrl"),
        placeHolder: "http://127.0.0.1:8080",
      });
      if (value === undefined) return;
      const scope = vscode.workspace.workspaceFolders ? vscode.ConfigurationTarget.Workspace : vscode.ConfigurationTarget.Global;
      await config().update("baseUrl", value.trim(), scope);
    }),
    command("checkAll", async () => {
      await refresh();
      for (const result of tree.results) {
        if (!isLocal(result.baseUrl)) {
          const go = t("Check");
          if ((await vscode.window.showWarningMessage(t("{0} is not on this computer. Send requests to all routes anyway?", result.baseUrl), { modal: true }, go)) !== go) continue;
        } else if (!result.running) {
          vscode.window.showWarningMessage(t("No server answers at {0}. Start it, or set the address.", result.baseUrl));
          continue;
        }
        let fine = 0;
        let failed = 0;
        await vscode.window.withProgress({ location: { viewId: "routeAtlas.routes" }, title: t("Checking routes") }, () =>
          checkAll(result.routes, result.baseUrl, {
            headers: config().get("requestHeaders"),
            onResult(route, status) {
              tree.statuses.set(tree.key(result, route), status);
              if (status.status === 0 || status.status >= 500) failed++;
              else fine++;
              tree.refresh();
            },
          }),
        );
        vscode.window.showInformationMessage(t("Checked {0} routes: {1} fine, {2} with errors", result.routes.filter(checkable).length, fine, failed));
      }
    }),
    command("export", async () => {
      const format = await vscode.window.showQuickPick(FORMATS, { title: t("Export routes") });
      if (!format || !tree.results.length) return;
      const [result] = tree.results;
      const content = format.render(tree.visible(result.routes), {
        title: t("Routes of {0}", result.folder.name),
        baseUrl: result.baseUrl,
        rules: config().get("categories"),
      });
      const document = await vscode.workspace.openTextDocument({ content, language: format.language });
      await vscode.window.showTextDocument(document);
    }),
  );
  refresh();
}

function deactivate() {}

module.exports = { activate, deactivate };
