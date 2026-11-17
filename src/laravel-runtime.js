"use strict";

const fs = require("fs/promises");
const path = require("path");
const { execFile } = require("child_process");
const { promisify } = require("util");

const execFileAsync = promisify(execFile);

/**
 * Convert Laravel's route:list JSON into Route Atlas records.
 * This parser is deliberately separate so it can be tested without PHP.
 */
function parseLaravelRoutes(output, root) {
  const parsed = JSON.parse(output);
  if (!Array.isArray(parsed)) throw new Error("Laravel route:list did not return a JSON array");

  const routeFile = path.join(root, "routes", "web.php");
  return parsed
    .filter((item) => item && typeof item.uri === "string")
    .map((item) => {
      const rawMethods = item.methods ?? item.method ?? [];
      const methods = (Array.isArray(rawMethods) ? rawMethods : String(rawMethods).split("|"))
        .map((method) => String(method).trim().toUpperCase())
        .filter(Boolean);
      const middleware = Array.isArray(item.middleware)
        ? item.middleware
        : String(item.middleware || "").split(",").map((value) => value.trim()).filter(Boolean);
      const uri = item.uri.startsWith("/") ? item.uri.slice(1) : item.uri;
      const normalizedUri = uri.split("/").map((segment) => {
        if (!segment.startsWith("{") || !segment.endsWith("}")) return segment;
        let parameter = segment.slice(1, -1);
        if (parameter.endsWith("?")) parameter = parameter.slice(0, -1);
        return `:${parameter.split(":")[0]}`;
      }).join("/");
      return {
        path: `/${normalizedUri}`,
        methods: [...new Set(methods)],
        kind: (uri === "api" || uri.startsWith("api/")) ? "api" : "page",
        file: routeFile,
        line: 0,
        source: "Laravel",
        protected: middleware.some((value) => /(^|:)auth|verified|can:/i.test(value)),
        name: item.name || "",
        action: item.action || "",
        middleware,
        runtime: true,
      };
    });
}

/**
 * Run Artisan without a shell. This is opt-in because booting an application
 * executes its service providers and may connect to external services.
 * Returns null when Laravel/PHP is unavailable so static scanning can continue.
 */
async function scanLaravelRuntime(root, { timeout = 15000, executable = "php", args = ["artisan", "route:list", "--json"], requireArtisan = executable === "php" } = {}) {
  try {
    if (requireArtisan) await fs.access(path.join(root, "artisan"));
    if (typeof executable !== "string" || !executable.trim() || !Array.isArray(args) || !args.every((arg) => typeof arg === "string")) {
      throw new Error("Invalid Laravel runtime command configuration");
    }
    const { stdout } = await execFileAsync(executable, args, {
      cwd: root,
      timeout,
      maxBuffer: 8 * 1024 * 1024,
      windowsHide: true,
      shell: false,
    });
    return parseLaravelRoutes(stdout, root);
  } catch {
    return null;
  }
}

module.exports = { parseLaravelRoutes, scanLaravelRuntime };
