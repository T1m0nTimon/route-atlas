#!/usr/bin/env node
"use strict";

const fs = require("fs/promises");
const path = require("path");
const { scan } = require("../src/scanner");
const { findings } = require("../src/tree");
const { FORMATS } = require("../src/exporters");
const { checkAll, checkable, findServer } = require("../src/http");
const { scanLinks } = require("../src/links");
const { version } = require("../package.json");

const HELP = `Route Atlas ${version}: every page and endpoint of a web project.

Usage
  route-atlas [list] [dir]            List all routes
  route-atlas export <format> [dir]   Print routes as ${FORMATS.map((format) => format.id).join(", ")}
  route-atlas check [dir]             Call every plain GET route on a running server
  route-atlas lint [dir]              Report broken links, routes handled twice and admin routes without login check

Options
  --json                 Machine-readable output (list, check, lint)
  --base-url <url>       Server address, for example http://127.0.0.1:3000 (export, check)
  --out, -o <file>       Write the output to a file instead of the terminal
  --laravel-runtime      Read registered Laravel routes with php artisan route:list (runs project code)\n  --exclude <a,b>        More folder names to skip
  --ignore-link <regex>  Paths that lint should not report as broken (can be given more than once)
  --fail-on <status>     check: lowest HTTP status that counts as failure (default 500)
  --header <Name: value> check: header for every request (can be given more than once)
  --help, -h             Show this help
  --version, -v          Show the version

Exit codes: 0 fine, 1 problems found, 2 wrong usage.`;

function parse(argv) {
  const options = { positional: [], ignore: [], headers: {}, exclude: [], failOn: 500, laravelRuntime: false };
  const value = (index, flag) => {
    if (index >= argv.length) throw new UsageError(`${flag} needs a value`);
    return argv[index];
  };
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    const [flag, inline] = arg.startsWith("--") && arg.includes("=") ? [arg.slice(0, arg.indexOf("=")), arg.slice(arg.indexOf("=") + 1)] : [arg, undefined];
    const next = () => (inline !== undefined ? inline : value(++index, flag));
    switch (flag) {
      case "--help":
      case "-h":
        options.help = true;
        break;
      case "--version":
      case "-v":
        options.version = true;
        break;
      case "--json":
        options.json = true;
        break;
      case "--base-url":
        options.baseUrl = next().replace(/\/$/, "");
        break;
      case "--out":
      case "-o":
        options.out = next();
        break;
      case "--laravel-runtime":\n        options.laravelRuntime = true;\n        break;\n      case "--exclude":
        options.exclude.push(...next().split(",").map((item) => item.trim()).filter(Boolean));
        break;
      case "--ignore-link":
        options.ignore.push(next());
        break;
      case "--fail-on":
        options.failOn = Number(next());
        if (!Number.isInteger(options.failOn)) throw new UsageError("--fail-on needs a number such as 400 or 500");
        break;
      case "--header": {
        const header = next();
        const colon = header.indexOf(":");
        if (colon < 1) throw new UsageError(`--header needs "Name: value", got "${header}"`);
        options.headers[header.slice(0, colon).trim()] = header.slice(colon + 1).trim();
        break;
      }
      default:
        if (arg.startsWith("-") && arg !== "-") throw new UsageError(`Unknown option ${arg}`);
        options.positional.push(arg);
    }
  }
  return options;
}

class UsageError extends Error {}

const COMMANDS = new Set(["list", "export", "check", "lint"]);

function relative(root, file) {
  return path.relative(root, file).split(path.sep).join("/");
}

function table(rows) {
  const widths = rows[0].map((_, column) => Math.max(...rows.map((row) => row[column].length)));
  return rows.map((row) => row.map((cell, column) => (column === row.length - 1 ? cell : cell.padEnd(widths[column]))).join("  ")).join("\n");
}

async function list(root, routes, options) {
  if (options.json) {
    return JSON.stringify(
      routes.map((route) => ({
        path: route.path,
        methods: route.methods,
        kind: route.kind,
        source: route.source,
        protected: Boolean(route.protected),
        file: relative(root, route.file),
        line: route.line + 1,
      })),
      null,
      2,
    );
  }
  if (!routes.length) return "No routes found.";
  const rows = [["METHOD", "PATH", "SOURCE", "FILE"]];
  for (const route of routes) {
    rows.push([route.methods.join(",") || "ANY", route.path, route.source, `${relative(root, route.file)}:${route.line + 1}`]);
  }
  return `${table(rows)}\n\n${routes.length} routes`;
}

async function exportRoutes(root, routes, options) {
  const format = FORMATS.find((item) => item.id === options.format);
  if (!format) throw new UsageError(`export needs a format: ${FORMATS.map((item) => item.id).join(", ")}`);
  return format.render(routes, { title: `Routes of ${path.basename(path.resolve(root))}`, baseUrl: options.baseUrl || "http://localhost:3000" });
}

async function check(root, routes, options) {
  let baseUrl = options.baseUrl;
  if (!baseUrl) {
    const port = await findServer([]);
    if (!port) throw new Problem("No server found on the usual ports. Start it, or pass --base-url.");
    baseUrl = `http://127.0.0.1:${port}`;
  }
  const results = [];
  await checkAll(routes, baseUrl, {
    headers: options.headers,
    onResult: (route, status) => results.push({ path: route.path, ...status, failed: status.status === 0 || status.status >= options.failOn }),
  });
  results.sort((a, b) => a.path.localeCompare(b.path));
  const failed = results.filter((item) => item.failed).length;
  options.exitCode = failed ? 1 : 0;
  if (options.json) return JSON.stringify({ baseUrl, checked: results.length, failed, results }, null, 2);
  const skipped = routes.length - routes.filter(checkable).length;
  const rows = [["STATUS", "TIME", "PATH"], ...results.map((item) => [item.status ? String(item.status) : "ERR", `${item.ms} ms`, `${item.path}${item.failed ? "  ✗" : ""}`])];
  return `${results.length ? table(rows) : "Nothing to check."}\n\n${baseUrl}: ${results.length} checked, ${failed} failed, ${skipped} skipped (parameters, other methods or risky paths)`;
}

async function lint(root, routes, options) {
  const links = await scanLinks(root, routes, { exclude: options.exclude, ignore: options.ignore });
  const issues = [
    ...links.map((link) => ({
      type: "broken-link",
      file: relative(root, link.file),
      line: link.line + 1,
      column: link.column + 1,
      message: `No route answers ${link.path}${link.suggestion ? `, did you mean ${link.suggestion.path}?` : ""}`,
    })),
    ...findings(routes).map((finding) => ({
      type: finding.type === "conflict" ? "handled-twice" : "no-login-check",
      file: relative(root, finding.file),
      line: finding.line + 1,
      column: 1,
      message:
        finding.type === "conflict"
          ? `${finding.route.path} is also handled at ${relative(root, finding.other.file)}:${finding.other.line + 1}`
          : `Admin route ${finding.route.path} has no login check that Route Atlas could find`,
    })),
  ].sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
  options.exitCode = issues.length ? 1 : 0;
  if (options.json) return JSON.stringify(issues, null, 2);
  if (!issues.length) return `No problems in ${routes.length} routes.`;
  const lines = issues.map((issue) => `${issue.file}:${issue.line}:${issue.column}  ${issue.type}  ${issue.message}`);
  return `${lines.join("\n")}\n\n${issues.length} problems`;
}

class Problem extends Error {}

async function main(argv) {
  const options = parse(argv);
  if (options.version) return { output: version, code: 0 };
  if (options.help) return { output: HELP, code: 0 };
  const command = COMMANDS.has(options.positional[0]) ? options.positional.shift() : "list";
  const handler = { list, export: exportRoutes, check, lint }[command];
  if (command === "export") options.format = options.positional.shift();
  const root = path.resolve(options.positional.shift() || ".");
  if (options.positional.length) throw new UsageError(`Too many arguments: ${options.positional.join(" ")}`);
  try {
    if (!(await fs.stat(root)).isDirectory()) throw new Error();
  } catch {
    throw new UsageError(`${root} is not a folder`);
  }
  const routes = await scan(root, { exclude: options.exclude, laravelRuntime: options.laravelRuntime });
  const output = await handler(root, routes, options);
  if (options.out) {
    await fs.writeFile(options.out, output.endsWith("\n") ? output : `${output}\n`);
    return { output: `Wrote ${options.out}`, code: options.exitCode || 0, quiet: true };
  }
  return { output, code: options.exitCode || 0 };
}

if (require.main === module) {
  main(process.argv.slice(2)).then(
    ({ output, code, quiet }) => {
      (quiet ? process.stderr : process.stdout).write(`${output}\n`);
      process.exitCode = code;
    },
    (error) => {
      process.stderr.write(`route-atlas: ${error.message}\n`);
      if (error instanceof UsageError) process.stderr.write("Run route-atlas --help for usage.\n");
      process.exitCode = error instanceof UsageError ? 2 : 1;
    },
  );
}

module.exports = { main, parse };
