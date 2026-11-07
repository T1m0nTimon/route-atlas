"use strict";

const fs = require("fs/promises");
const path = require("path");

const SKIP_DIRS = new Set([
  "node_modules", ".git", ".hg", ".svn", ".venv", "venv", "env", "__pycache__", ".tox", ".mypy_cache",
  ".ruff_cache", ".pytest_cache", "dist", "build", "out", "target", "bin", "obj", "vendor", "coverage",
  ".next", ".nuxt", ".output", ".svelte-kit", ".astro", ".cache", ".turbo", ".vercel", ".idea", ".vscode",
  "site-packages", "migrations", "bower_components", "Pods", "storage",
]);
const TEST_DIRS = new Set(["test", "tests", "__tests__", "__mocks__", "spec", "specs", "e2e", "cypress", "fixtures", "playwright"]);
const TEST_FILE = /(^test_.*|^conftest\.py$|_test\.\w+$|[.-](test|spec|stories)\.\w+$)/;
const CODE_EXT = new Set([
  ".py", ".js", ".jsx", ".mjs", ".cjs", ".ts", ".tsx", ".mts", ".cts", ".vue", ".svelte", ".astro", ".md", ".mdx",
  ".php", ".rb", ".java", ".kt", ".cs", ".go", ".rs", ".html", ".htm",
]);
const MAX_FILE_SIZE = 1024 * 1024;
const JS_EXT = new Set([".js", ".jsx", ".mjs", ".cjs", ".ts", ".tsx", ".mts", ".cts", ".vue"]);
const HTTP = ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"];

async function walk(root, { exclude = [], maxFiles = 20000 } = {}) {
  const found = [];
  const skip = new Set([...SKIP_DIRS, ...exclude]);
  const pending = [root];
  while (pending.length && found.length < maxFiles) {
    const dir = pending.pop();
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!skip.has(entry.name)) pending.push(full);
      } else if (entry.isFile() && (entry.name === "package.json" || CODE_EXT.has(path.extname(entry.name)))) {
        found.push(full);
      }
    }
  }
  return found;
}

async function read(file) {
  try {
    if ((await fs.stat(file)).size > MAX_FILE_SIZE) return "";
    return await fs.readFile(file, "utf8");
  } catch {
    return "";
  }
}

function posix(file) {
  return file.split(path.sep).join("/");
}

function isTestFile(root, file) {
  const parts = posix(path.relative(root, file)).split("/");
  return parts.slice(0, -1).some((part) => TEST_DIRS.has(part)) || TEST_FILE.test(parts[parts.length - 1]);
}

function joinPath(...parts) {
  const joined = parts
    .filter((part) => part !== undefined && part !== null)
    .join("/")
    .replace(/\/{2,}/g, "/")
    .replace(/\/$/, "");
  return joined.startsWith("/") ? joined || "/" : `/${joined}`;
}

/** Unifies the parameter styles of all frameworks to /users/:id. */
function normalize(route) {
  return joinPath(
    route
      .replace(/^\^/, "")
      .replace(/\$$/, "")
      .replace(/<(?:[\w.]+:)?(\w+)>/g, ":$1")
      .replace(/\{(\w+)(?::[^}]*)?\??\}/g, ":$1")
      .split("?")[0],
  );
}

/** Replaces comment lines with blanks, so offsets and line numbers stay right. */
function stripComments(text, ext) {
  const hash = ext === ".py" || ext === ".rb";
  return text
    .split("\n")
    .map((line) => {
      const trimmed = line.trimStart();
      const comment = hash ? trimmed.startsWith("#") : /^(\/\/|\/\*|\*)/.test(trimmed);
      return comment ? "" : line;
    })
    .join("\n");
}

function lineOf(text, index) {
  let line = 0;
  for (let i = text.indexOf("\n"); i !== -1 && i < index; i = text.indexOf("\n", i + 1)) line++;
  return line;
}

/** The text between the bracket at `open` and its partner. */
function balanced(text, open, limit = 800) {
  const pairs = { "(": ")", "{": "}", "[": "]" };
  const opener = text[open];
  const closer = pairs[opener];
  let depth = 0;
  for (let i = open; i < Math.min(text.length, open + limit); i++) {
    if (text[i] === opener) depth++;
    else if (text[i] === closer && --depth === 0) return text.slice(open + 1, i);
  }
  return text.slice(open + 1, open + limit);
}

function methodsIn(args) {
  const list = /methods\s*=\s*[[(]([^\])]*)/.exec(args);
  if (!list) return [];
  return HTTP.filter((method) => new RegExp(`["']${method}["']`, "i").test(list[1]));
}

function add(routes, route) {
  routes.push({ methods: [], kind: "page", ...route, path: normalize(route.path) });
}

/* ---------------------------------------------------------------- Python */

const PY_RECEIVER = /^(app|api|application|server|bp|blueprint|router|\w*_bp|\w*_blueprint|\w*_router|\w*_api|\w*_app)$/i;
const PY_FRAMEWORK = [
  [/\bfastapi\b/i, "FastAPI"],
  [/\bflask\b/i, "Flask"],
  [/\bquart\b/i, "Quart"],
  [/\bsanic\b/i, "Sanic"],
  [/\blitestar\b/i, "Litestar"],
  [/\bbottle\b/i, "Bottle"],
];

function pythonPrefixes(text) {
  const prefixes = {};
  const pattern = /^(\w+)\s*(?::[^=\n]+)?=\s*(?:\w+\.)*(Blueprint|APIRouter)\(/gm;
  for (let match; (match = pattern.exec(text)); ) {
    const args = balanced(text, match.index + match[0].length - 1);
    const prefix = /\b(?:url_)?prefix\s*=\s*f?["']([^"']*)["']/.exec(args);
    prefixes[match[1]] = prefix ? prefix[1] : "";
  }
  return prefixes;
}

function pythonImports(text) {
  const imports = {};
  const pattern = /^\s*from\s+([\w.]+)\s+import\s+(\([^)]*\)|[^\n]+)/gm;
  for (let match; (match = pattern.exec(text)); ) {
    const names = match[2].replace(/#.*/g, "").replace(/[()]/g, "");
    for (const piece of names.split(",")) {
      const [name, alias] = piece.trim().split(/\s+as\s+/);
      if (name) imports[alias || name] = { module: match[1], name };
    }
  }
  return imports;
}

function scanPython(file, text, context) {
  const routes = [];
  const framework = (PY_FRAMEWORK.find(([pattern]) => pattern.test(text)) || [])[1];
  const prefixes = pythonPrefixes(text);
  const imports = pythonImports(text);
  const guardedElsewhere = /\bbefore_(app_)?request\b/.test(text);
  context.python.push({ file, prefixes, imports, text });

  const pattern = /^[ \t]*@([A-Za-z_][\w.]*)\.(route|get|post|put|patch|delete|head|options|websocket)\(\s*(?:(?:rule|path)\s*=\s*)?[rf]?["']([^"']*)["']/gm;
  for (let match; (match = pattern.exec(text)); ) {
    const receiver = match[1].split(".").pop();
    if (!framework && !PY_RECEIVER.test(receiver) && !(receiver in prefixes)) continue;
    const verb = match[2];
    const args = balanced(text, match.index + match[0].indexOf("("));
    const methods = verb === "route" ? methodsIn(args) : verb === "websocket" ? ["WS"] : [verb.toUpperCase()];
    const until = text.indexOf("def ", match.index);
    const decorators = until === -1 ? "" : text.slice(match.index, until);
    const guards = decorators.split("\n").slice(1).join("\n");
    const signature = until === -1 ? "" : balanced(text, text.indexOf("(", until));
    add(routes, {
      path: match[3] || "/",
      methods: methods.length ? methods : ["GET"],
      file,
      line: lineOf(text, match.index),
      source: framework || "Python",
      receiver,
      protected: /@\w*(login|auth|permission|role|admin|require)/i.test(guards) || /Depends\(\s*\w*(auth|user|admin|token)/i.test(signature + args),
      admin: /@\w*admin|["']admin["']/i.test(guards),
      guardedElsewhere,
    });
  }
  return routes;
}

/** Applies Blueprint and router prefixes, including those set in another file. */
function applyPythonPrefixes(routes, context, root) {
  const moduleName = (file) => posix(path.relative(root, file)).replace(/\.py$/, "").replace(/\/__init__$/, "");
  const moduleFile = (module, from) => {
    const dots = /^\.*/.exec(module)[0].length;
    const tail = module.slice(dots).replace(/\./g, "/");
    if (dots) {
      let dir = path.dirname(from);
      for (let level = 1; level < dots; level++) dir = path.dirname(dir);
      const wanted = posix(path.relative(root, path.join(dir, tail)));
      const exact = context.python.find(({ file }) => moduleName(file) === wanted);
      if (exact) return exact;
    }
    if (!tail) return undefined;
    return context.python.find(({ file }) => {
      const name = moduleName(file);
      return name === tail || name.endsWith(`/${tail}`);
    });
  };
  const submodule = ({ module, name }) => (module.endsWith(".") ? `${module}${name}` : `${module}.${name}`);
  /** Finds where a name lives: `from . import main` can mean a variable or a whole module. */
  const locate = (entry, variable) => {
    const imported = entry.imports[variable];
    if (variable in entry.prefixes || !imported) return { home: entry, variable };
    const places = [moduleFile(imported.module, entry.file), moduleFile(submodule(imported), entry.file)].filter(Boolean);
    const home = places.find((place) => imported.name in place.prefixes) || places[0];
    return home ? { home, variable: imported.name } : { home: entry, variable };
  };

  const mounts = [];
  for (const entry of context.python) {
    const pattern = /\b([A-Za-z_][\w.]*)\.(register_blueprint|include_router)\(\s*([\w.]+)/g;
    for (let match; (match = pattern.exec(entry.text)); ) {
      const args = balanced(entry.text, match.index + match[0].indexOf("("));
      const prefix = /\b(?:url_)?prefix\s*=\s*f?["']([^"']*)["']/.exec(args);
      const parts = match[3].split(".");
      const variable = parts.pop();
      let target = locate(entry, variable);
      if (parts.length) {
        const owner = entry.imports[parts[0]];
        const module = [owner ? submodule(owner) : parts[0], ...parts.slice(1)].join(".");
        const home = moduleFile(module, entry.file);
        if (!home) continue;
        target = { home, variable };
      }
      mounts.push({
        file: target.home.file,
        variable: target.variable,
        parent: locate(entry, match[1].split(".").pop()),
        prefix: prefix ? prefix[1] : "",
        // Flask replaces the prefix of the blueprint, FastAPI puts its own in front.
        replaces: Boolean(prefix) && match[2] === "register_blueprint",
      });
    }
  }
  const fullPrefix = ({ home, variable }, depth = 0) => {
    const own = home.prefixes[variable] || "";
    const mount = depth < 8 && mounts.find((item) => item.file === home.file && item.variable === variable);
    if (!mount) return own;
    return joinPath(fullPrefix(mount.parent, depth + 1), mount.prefix, mount.replaces ? "" : own);
  };
  for (const route of routes) {
    if (!route.receiver) continue;
    const entry = context.python.find(({ file }) => file === route.file);
    if (!entry) continue;
    route.path = normalize(joinPath(fullPrefix(locate(entry, route.receiver)), route.path));
    delete route.receiver;
  }
}

function scanDjango(file, text, context) {
  const routes = [];
  const pattern = /\b(?:re_)?path\(\s*r?["']([^"']*)["']\s*,\s*(include\(\s*(?:\(\s*)?["']([\w.]+)["'])?/g;
  for (let match; (match = pattern.exec(text)); ) {
    if (match[3]) {
      context.djangoMounts.push({ file, module: match[3], prefix: match[1] });
      continue;
    }
    add(routes, { path: match[1] || "/", file, line: lineOf(text, match.index), source: "Django", admin: /admin\.site\.urls/.test(text.slice(match.index, match.index + 120)) });
  }
  return routes;
}

function applyDjangoMounts(routes, context, root) {
  const prefixFor = (file, depth = 0) => {
    if (depth > 4) return "";
    const name = posix(path.relative(root, file)).replace(/\.py$/, "");
    const mount = context.djangoMounts.find(({ module }) => {
      const tail = module.replace(/\./g, "/");
      return name === tail || name.endsWith(`/${tail}`);
    });
    return mount ? joinPath(prefixFor(mount.file, depth + 1), normalize(mount.prefix)) : "";
  };
  for (const route of routes) {
    if (route.source === "Django") route.path = normalize(joinPath(prefixFor(route.file), route.path));
  }
}

/* ------------------------------------------------------------ JavaScript */

const JS_RECEIVER = /^(app|api|server|fastify|hono|router|\w*router|\w*routes?|\w*app)$/i;
const JS_CLIENT = /^(axios|http|https|fetch|client|request|supertest|\$http|ky|got|superagent|httpClient|apiClient)$/i;

function scanNode(file, text, context) {
  const routes = [];
  const guardedElsewhere = /\.(use|addHook)\(\s*(["'`][^"'`]*["'`]\s*,\s*)?\w*(auth|protect|require|admin|session|jwt)/i.test(text);
  const source = /\bfastify\b/i.test(text) ? "Fastify" : /\bhono\b/i.test(text) ? "Hono" : /\bkoa\b/i.test(text) ? "Koa" : "Express";

  const declared = new Set([...text.matchAll(/\b([A-Za-z_$][\w$]*)\s*=\s*(?:new\s+)?(?:express\.)?(?:Router|Hono)\(/g)].map((match) => match[1]));
  const pattern = /\b([A-Za-z_$][\w$]*)\.(get|post|put|patch|delete|all|head|options)\(\s*[`'"]([^`'"]*)[`'"]\s*,/g;
  for (let match; (match = pattern.exec(text)); ) {
    if (JS_CLIENT.test(match[1]) || !(JS_RECEIVER.test(match[1]) || declared.has(match[1]))) continue;
    if (!match[3].startsWith("/") && match[3] !== "*") continue;
    const guards = text.slice(match.index, match.index + 200).split("\n")[0];
    add(routes, {
      path: match[3],
      methods: [match[2] === "all" ? "ALL" : match[2].toUpperCase()],
      file,
      line: lineOf(text, match.index),
      source,
      receiver: match[1],
      protected: /\b(auth|requireAuth|isAuthenticated|protect|verifyToken|requireLogin)\w*/i.test(guards),
      admin: /\b\w*admin\w*\b/i.test(guards),
      guardedElsewhere,
    });
  }

  const chain = /\b([A-Za-z_$][\w$]*)\.route\(\s*[`'"](\/[^`'"]*)[`'"]\s*\)((?:\s*\.\w+\([^\n]*)+)/g;
  for (let match; (match = chain.exec(text)); ) {
    const methods = HTTP.filter((method) => new RegExp(`\\.${method}\\(`, "i").test(match[3]));
    add(routes, { path: match[2], methods, file, line: lineOf(text, match.index), source, receiver: match[1] });
  }

  const imports = nodeImports(text);
  const mountOf = (receiver, prefix, module, variable) => {
    const name = variable && variable.split(".")[0];
    const target = module || imports[name];
    if (target) context.nodeMounts.push({ from: file, receiver, target, prefix });
    else if (name) context.nodeMounts.push({ from: file, receiver, variable: name, prefix });
  };
  const mount = /(?:\b([A-Za-z_$][\w$]*))?\.(?:use|route|register)\(\s*[`'"](\/[^`'"]*)[`'"]\s*,\s*(?:[\w.]+\s*,\s*)*(?:require\(\s*["'](\.[^"']+)["']\s*\)|([\w$.]+))\s*\)/g;
  for (let match; (match = mount.exec(text)); ) mountOf(match[1], match[2], match[3], match[4]);
  const plugin = /(?:\b([A-Za-z_$][\w$]*))?\.register\(\s*(?:require\(\s*["'](\.[^"']+)["']\s*\)|([\w$.]+))\s*,\s*\{[^}]*\bprefix:\s*[`'"]([^`'"]*)[`'"]/g;
  for (let match; (match = plugin.exec(text)); ) mountOf(match[1], match[4], match[2], match[3]);
  return routes;
}

/** Local names of relative imports: default, named, namespace and require. */
function nodeImports(text) {
  const imports = {};
  const names = (list, module, separator) => {
    for (const piece of list.split(",")) {
      const name = piece.trim().split(separator).pop().trim();
      if (name) imports[name] = module;
    }
  };
  const source = `["'](\\.[^"']+)["']`;
  const direct = new RegExp(`(?:const|let|var)\\s+(\\w+)\\s*=\\s*require\\(\\s*${source}\\s*\\)|import\\s+(\\w+)\\s*(?:,\\s*\\{[^}]*\\}\\s*)?from\\s+${source}|import\\s+\\*\\s+as\\s+(\\w+)\\s+from\\s+${source}`, "g");
  for (let match; (match = direct.exec(text)); ) imports[match[1] || match[3] || match[5]] = match[2] || match[4] || match[6];
  const esm = new RegExp(`import\\s+(?:\\w+\\s*,\\s*)?\\{([^}]*)\\}\\s*from\\s+${source}`, "g");
  for (let match; (match = esm.exec(text)); ) names(match[1], match[2], /\s+as\s+/);
  const common = new RegExp(`(?:const|let|var)\\s*\\{([^}]*)\\}\\s*=\\s*require\\(\\s*${source}\\s*\\)`, "g");
  for (let match; (match = common.exec(text)); ) names(match[1], match[2], ":");
  return imports;
}

function applyNodeMounts(routes, context) {
  const stem = (file) => posix(file).replace(/\.[cm]?[jt]sx?$/, "").replace(/\/index$/, "");
  const prefixes = new Map();
  const local = [];
  for (const mount of context.nodeMounts) {
    if (mount.target) prefixes.set(stem(path.resolve(path.dirname(mount.from), mount.target)), mount);
    else local.push(mount);
  }
  /** Routers mounted inside one file: api.use("/v1", v1), then app.use("/api", api). */
  const within = (file, receiver, depth = 0) => {
    const mount = depth < 5 && local.find((item) => item.from === file && item.variable === receiver);
    return mount ? joinPath(within(file, mount.receiver, depth + 1), mount.prefix) : "";
  };
  const chain = (file, depth = 0) => {
    const mount = prefixes.get(stem(file));
    return mount && depth < 5 ? joinPath(chain(mount.from, depth + 1), within(mount.from, mount.receiver), mount.prefix) : "";
  };
  for (const route of routes) {
    if (["Express", "Fastify", "Hono", "Koa"].includes(route.source)) route.path = normalize(joinPath(chain(route.file), within(route.file, route.receiver), route.path));
    delete route.receiver;
  }
}

function scanNest(file, text) {
  const routes = [];
  const controller = /@Controller\(\s*(?:["'`]([^"'`]*)["'`])?/.exec(text);
  if (!controller) return routes;
  const pattern = /@(Get|Post|Put|Patch|Delete|All|Head|Options)\(\s*(?:["'`]([^"'`]*)["'`])?/g;
  for (let match; (match = pattern.exec(text)); ) {
    add(routes, {
      path: joinPath(controller[1] || "", match[2] || ""),
      methods: [match[1].toUpperCase()],
      file,
      line: lineOf(text, match.index),
      source: "NestJS",
      kind: "api",
      protected: /@UseGuards/.test(text),
    });
  }
  return routes;
}

function scanClientRouter(file, text) {
  const routes = [];
  const source = /RouterModule|@angular/.test(text)
    ? "Angular"
    : /vue-router|createRouter\(/.test(text)
      ? "Vue Router"
      : /createBrowserRouter|createHashRouter|createMemoryRouter|useRoutes|<Routes?\b|react-router/.test(text)
        ? "React Router"
        : null;
  if (!source) return routes;
  const pattern = /<Route\b[^>]*?\bpath=["'{`]+([^"'}`]*)|\bpath:\s*["'`]([^"'`]*)["'`]/g;
  for (let match; (match = pattern.exec(text)); ) {
    const route = match[1] ?? match[2];
    if (route === "*" || route === "**" || route.startsWith("/:pathMatch")) continue;
    add(routes, { path: route || "/", file, line: lineOf(text, match.index), source });
  }
  return routes;
}

/* --------------------------------------------------------- Other servers */

function scanLaravel(file, text, root) {
  const routes = [];
  const groups = [];
  const group = /Route::(?:middleware\([^)]*\)->)?prefix\(\s*["']([^"']*)["']\s*\)[^;{]*?group\(\s*function[^{]*\{/g;
  for (let match; (match = group.exec(text)); ) {
    const open = match.index + match[0].length - 1;
    groups.push({ start: open, end: open + balanced(text, open, 100000).length, prefix: match[1] });
  }
  const base = posix(path.relative(root, file)).endsWith("routes/api.php") ? "/api" : "";
  const pattern = /Route::(get|post|put|patch|delete|any|view|resource|apiResource)\(\s*["']([^"']*)["']/g;
  for (let match; (match = pattern.exec(text)); ) {
    const prefix = groups.filter((item) => match.index > item.start && match.index < item.end).map((item) => item.prefix);
    const verb = match[1];
    const line = lineOf(text, match.index);
    const route = joinPath(base, ...prefix, match[2]);
    const lineText = text.split("\n")[line] || "";
    const shared = { file, line, source: "Laravel", protected: /middleware\([^)]*auth/.test(lineText) };
    if (/resource/i.test(verb)) {
      add(routes, { ...shared, path: route, methods: ["GET", "POST"] });
      add(routes, { ...shared, path: `${route}/:id`, methods: ["GET", "PUT", "DELETE"] });
    } else {
      add(routes, { ...shared, path: route, methods: verb === "view" || verb === "any" ? [] : [verb.toUpperCase()] });
    }
  }
  return routes;
}

function scanRails(file, text) {
  const routes = [];
  const scopes = [];
  text.split("\n").forEach((raw, line) => {
    const code = raw.trim();
    const prefix = () => scopes.filter(Boolean).join("/");
    const shared = { file, line, source: "Rails" };
    let match;
    if ((match = /^(?:namespace|scope)\s+[:"'/]*([\w/-]+)["']?.*\bdo\b/.exec(code))) {
      scopes.push(match[1]);
    } else if ((match = /^resources?\s+:(\w+)(.*)/.exec(code))) {
      add(routes, { ...shared, path: joinPath(prefix(), match[1]), methods: ["GET", "POST"] });
      if (code.startsWith("resources ")) add(routes, { ...shared, path: joinPath(prefix(), match[1], ":id"), methods: ["GET", "PATCH", "DELETE"] });
      if (/\bdo\b/.test(match[2])) scopes.push(`${match[1]}/:id`);
    } else if ((match = /^(get|post|put|patch|delete)\s+["'/:]*([\w/:.-]+)["']?/.exec(code))) {
      add(routes, { ...shared, path: joinPath(prefix(), match[2]), methods: [match[1].toUpperCase()] });
    } else if (/^root\b/.test(code)) {
      add(routes, { ...shared, path: joinPath(prefix()) });
    } else if (/\bdo(\s*\|.*\|)?$/.test(code) && !/Rails\.application\.routes\.draw/.test(code)) {
      scopes.push("");
    } else if (code === "end") {
      scopes.pop();
    }
  });
  return routes;
}

function scanSpring(file, text) {
  const routes = [];
  if (!/@(Rest)?Controller/.test(text)) return routes;
  const value = `\\(\\s*(?:(?:value|path)\\s*=\\s*)?\\{?\\s*"([^"]*)"`;
  const base = new RegExp(`@RequestMapping${value}[^\\n]*\\n(?:\\s*@.*\\n)*\\s*(?:public\\s+|internal\\s+|open\\s+)*(?:class|interface)`).exec(text);
  const pattern = new RegExp(`@(Get|Post|Put|Patch|Delete)Mapping(?:${value})?`, "g");
  for (let match; (match = pattern.exec(text)); ) {
    add(routes, {
      path: joinPath(base ? base[1] : "", match[2] || ""),
      methods: [match[1].toUpperCase()],
      file,
      line: lineOf(text, match.index),
      source: "Spring",
      kind: /@RestController/.test(text) ? "api" : "page",
    });
  }
  return routes;
}

function scanDotnet(file, text) {
  const routes = [];
  const name = /class\s+(\w+)Controller\b/.exec(text);
  const base = /\[Route\(\s*"([^"]*)"\s*\)\]\s*(?:\[[^\]]*\]\s*)*public\s+(?:\w+\s+)*class/.exec(text);
  const prefix = base ? base[1].replace("[controller]", name ? name[1].toLowerCase() : "") : "";
  const attribute = /\[Http(Get|Post|Put|Patch|Delete)(?:\(\s*"([^"]*)")?/g;
  for (let match; (match = attribute.exec(text)); ) {
    add(routes, { path: joinPath(prefix, match[2] || ""), methods: [match[1].toUpperCase()], file, line: lineOf(text, match.index), source: "ASP.NET", kind: "api" });
  }
  const minimal = /\.Map(Get|Post|Put|Patch|Delete)\(\s*"([^"]*)"/g;
  for (let match; (match = minimal.exec(text)); ) {
    add(routes, { path: match[2], methods: [match[1].toUpperCase()], file, line: lineOf(text, match.index), source: "ASP.NET", kind: "api" });
  }
  return routes;
}

function scanGo(file, text) {
  const routes = [];
  const pattern = /\.(GET|POST|PUT|PATCH|DELETE|Get|Post|Put|Patch|Delete|HandleFunc|Handle)\(\s*"((?:[A-Z]+ )?\/[^"]*)"/g;
  for (let match; (match = pattern.exec(text)); ) {
    const [verb, route] = match[2].includes(" ") ? match[2].split(" ") : [match[1], match[2]];
    add(routes, {
      path: route,
      methods: /^Handle/.test(verb) ? [] : [verb.toUpperCase()],
      file,
      line: lineOf(text, match.index),
      source: "Go",
    });
  }
  return routes;
}

function scanRust(file, text) {
  const routes = [];
  const axum = /\.route\(\s*"([^"]*)"\s*,\s*([^\n]*)/g;
  for (let match; (match = axum.exec(text)); ) {
    const methods = HTTP.filter((method) => new RegExp(`\\b${method}\\(`, "i").test(match[2]));
    add(routes, { path: match[1], methods, file, line: lineOf(text, match.index), source: "Axum" });
  }
  const attribute = /#\[(get|post|put|patch|delete)\(\s*"([^"]*)"/g;
  for (let match; (match = attribute.exec(text)); ) {
    add(routes, { path: match[2], methods: [match[1].toUpperCase()], file, line: lineOf(text, match.index), source: "Actix/Rocket" });
  }
  return routes;
}

/* ----------------------------------------------------- File-based routing */

function segment(part) {
  if (/^\(.*\)$/.test(part)) return "";
  return part
    .replace(/^\[\[?\.\.\.(\w+)\]?\]$/, ":$1*")
    .replace(/^\[\[?(\w+)\]?\]$/, ":$1")
    .replace(/^\$(\w+)$/, ":$1")
    .replace(/^\$$/, ":rest*");
}

function hiddenPart(part) {
  return part.startsWith("_") || part.startsWith("@") || /^\(\.+\)/.test(part);
}

async function endpointMethods(file) {
  const text = await read(file);
  return HTTP.filter((method) => new RegExp(`export\\s+(?:async\\s+)?(?:function|const)\\s+${method}\\b`).test(text));
}

async function nextRoutes(base, files, routes) {
  for (const dir of ["app", "src/app"]) {
    const root = posix(path.join(base, dir)) + "/";
    for (const file of files) {
      const name = posix(file);
      if (!name.startsWith(root)) continue;
      const parts = name.slice(root.length).split("/");
      const leaf = parts.pop();
      if (parts.some(hiddenPart)) continue;
      const route = joinPath(...parts.map(segment).filter(Boolean));
      if (/^page\.(jsx?|tsx?|mdx?)$/.test(leaf)) add(routes, { path: route, file, line: 0, source: "Next.js" });
      else if (/^route\.(js|ts)$/.test(leaf)) add(routes, { path: route, methods: await endpointMethods(file), file, line: 0, source: "Next.js", kind: "api" });
    }
  }
  for (const dir of ["pages", "src/pages"]) {
    await pageTree(base, dir, files, routes, "Next.js", /\.(jsx?|tsx?|mdx?)$/, (parts) => parts[0] === "api");
  }
}

async function pageTree(base, dir, files, routes, source, extension, isApi = () => false) {
  const root = posix(path.join(base, dir)) + "/";
  for (const file of files) {
    const name = posix(file);
    if (!name.startsWith(root) || !extension.test(name)) continue;
    const parts = name.slice(root.length).replace(extension, "").split("/");
    if (parts.some((part) => part.startsWith("_") || part.startsWith("."))) continue;
    if (parts[parts.length - 1] === "index") parts.pop();
    add(routes, { path: joinPath(...parts.map(segment).filter(Boolean)), file, line: 0, source, kind: isApi(parts) ? "api" : "page" });
  }
}

async function svelteRoutes(base, files, routes, source = "SvelteKit") {
  const root = posix(path.join(base, "src/routes")) + "/";
  for (const file of files) {
    const name = posix(file);
    if (!name.startsWith(root)) continue;
    const parts = name.slice(root.length).split("/");
    const leaf = parts.pop();
    const route = joinPath(...parts.map(segment).filter(Boolean));
    if (/^\+page\.svelte$/.test(leaf)) add(routes, { path: route, file, line: 0, source });
    else if (/^\+server\.(js|ts)$/.test(leaf)) add(routes, { path: route, methods: await endpointMethods(file), file, line: 0, source, kind: "api" });
  }
}

function flatRouteName(name) {
  return name
    .split(".")
    .filter((part) => part && part !== "_index" && !part.startsWith("_") && part !== "route")
    .map((part) => segment(part.replace(/_$/, "")));
}

async function remixRoutes(base, files, routes) {
  for (const dir of ["app/routes", "src/routes"]) {
    const root = posix(path.join(base, dir)) + "/";
    for (const file of files) {
      const name = posix(file);
      if (!name.startsWith(root) || !/\.(jsx?|tsx?|mdx?)$/.test(name)) continue;
      const parts = name.slice(root.length).replace(/\.\w+$/, "").split("/");
      if (parts[parts.length - 1] === "__root") continue;
      add(routes, { path: joinPath(...parts.flatMap(flatRouteName)), file, line: 0, source: dir.startsWith("app") ? "Remix" : "TanStack Router" });
    }
  }
}

async function nuxtRoutes(base, files, routes) {
  await pageTree(base, "pages", files, routes, "Nuxt", /\.vue$/);
  await pageTree(base, "app/pages", files, routes, "Nuxt", /\.vue$/);
  for (const dir of ["server/api", "server/routes"]) {
    const root = posix(path.join(base, dir)) + "/";
    for (const file of files) {
      const name = posix(file);
      if (!name.startsWith(root) || !/\.(js|ts)$/.test(name)) continue;
      const parts = name.slice(root.length).replace(/\.\w+$/, "").split("/");
      const verb = /\.(get|post|put|patch|delete)$/.exec(parts[parts.length - 1]);
      if (verb) parts[parts.length - 1] = parts[parts.length - 1].slice(0, verb.index);
      if (parts[parts.length - 1] === "index") parts.pop();
      add(routes, {
        path: joinPath(dir === "server/api" ? "api" : "", ...parts.map(segment)),
        methods: verb ? [verb[1].toUpperCase()] : [],
        file,
        line: 0,
        source: "Nuxt",
        kind: "api",
      });
    }
  }
}

const FILE_ROUTERS = [
  [["next"], nextRoutes],
  [["nuxt"], nuxtRoutes],
  [["@sveltejs/kit"], svelteRoutes],
  [["@solidjs/start", "solid-start"], (base, files, routes) => pageTree(base, "src/routes", files, routes, "SolidStart", /\.(jsx|tsx|js|ts|mdx)$/)],
  [["astro"], (base, files, routes) => pageTree(base, "src/pages", files, routes, "Astro", /\.(astro|md|mdx|html|js|ts)$/)],
  [["gatsby"], (base, files, routes) => pageTree(base, "src/pages", files, routes, "Gatsby", /\.(jsx?|tsx?)$/)],
  [["@remix-run/react", "@remix-run/node", "@tanstack/react-router", "@react-router/dev"], remixRoutes],
];

async function scanFileRouters(files) {
  const routes = [];
  for (const manifest of files.filter((file) => path.basename(file) === "package.json")) {
    let dependencies;
    try {
      const parsed = JSON.parse(await read(manifest));
      dependencies = { ...parsed.dependencies, ...parsed.devDependencies };
    } catch {
      continue;
    }
    const base = path.dirname(manifest);
    for (const [names, scan] of FILE_ROUTERS) {
      if (names.some((name) => name in dependencies)) await scan(base, files, routes);
    }
  }
  return routes;
}

/** Sites without a framework: every HTML or PHP file is a page. */
function scanStatic(root, files) {
  const routes = [];
  for (const file of files) {
    const relative = posix(path.relative(root, file));
    if (!/\.(html?|php)$/.test(relative) || /(^|\/)(templates?|views?|layouts?|partials|includes?|components)\//.test(relative)) continue;
    const route = relative.replace(/^(public|www|htdocs|public_html|src|site)\//, "").replace(/(^|\/)index\.(html?|php)$/, "$1");
    add(routes, { path: route || "/", file, line: 0, source: relative.endsWith(".php") ? "PHP" : "HTML" });
  }
  return routes;
}

/** Two handlers answer the same method, so one of them never runs. */
function clash(known, route) {
  return known.locations.find(
    (place) =>
      place.source === route.source &&
      (place.file !== route.file || Math.abs(place.line - route.line) > 3) &&
      place.methods.some((method) => route.methods.includes(method)),
  );
}

function merge(routes) {
  const byPath = new Map();
  for (const route of routes) {
    const place = { file: route.file, line: route.line, methods: route.methods, source: route.source };
    const known = byPath.get(route.path);
    if (!known) {
      byPath.set(route.path, { ...route, methods: [...route.methods], locations: [place], conflicts: [] });
      continue;
    }
    const other = clash(known, route);
    if (other) known.conflicts.push({ first: other, second: place });
    known.locations.push(place);
    known.methods = [...new Set([...known.methods, ...route.methods])];
    known.protected = known.protected || route.protected;
    known.admin = known.admin || route.admin;
    known.guardedElsewhere = known.guardedElsewhere || route.guardedElsewhere;
    if (route.kind === "api") known.kind = "api";
  }
  return [...byPath.values()].sort((a, b) => a.path.localeCompare(b.path));
}

async function scanCode(root, files, context) {
  const routes = [];
  for (const file of files) {
    const ext = path.extname(file);
    if (isTestFile(root, file) || [".html", ".htm", ".md", ".mdx", ".svelte", ".astro"].includes(ext)) continue;
    const raw = await read(file);
    if (!raw) continue;
    const text = stripComments(raw, ext);
    const base = path.basename(file);
    if (ext === ".py") {
      routes.push(...scanPython(file, text, context));
      if (base === "urls.py") routes.push(...scanDjango(file, text, context));
    } else if (JS_EXT.has(ext)) {
      routes.push(...scanNode(file, text, context), ...scanNest(file, text), ...scanClientRouter(file, text));
    } else if (ext === ".php" && /Route::/.test(text)) {
      routes.push(...scanLaravel(file, text, root));
    } else if (ext === ".rb" && base === "routes.rb") {
      routes.push(...scanRails(file, text));
    } else if (ext === ".java" || ext === ".kt") {
      routes.push(...scanSpring(file, text));
    } else if (ext === ".cs") {
      routes.push(...scanDotnet(file, text));
    } else if (ext === ".go") {
      routes.push(...scanGo(file, text));
    } else if (ext === ".rs") {
      routes.push(...scanRust(file, text));
    }
  }
  return routes;
}

async function scan(root, options = {}) {
  const files = await walk(root, options);
  const context = { python: [], djangoMounts: [], nodeMounts: [] };
  const routes = [...(await scanFileRouters(files)), ...(await scanCode(root, files, context))];
  applyPythonPrefixes(routes, context, root);
  applyDjangoMounts(routes, context, root);
  applyNodeMounts(routes, context);
  return merge(routes.length ? routes : scanStatic(root, files));
}

module.exports = { scan, normalize, SKIP_DIRS };
