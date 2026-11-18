#!/usr/bin/env node
"use strict";

// Starts the installed VS Code with this extension on a fresh copy of the fixture and runs suite.js.
// Set VSCODE_EXECUTABLE if VS Code is not in its default place.
const { spawnSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const root = path.resolve(__dirname, "..", "..");
const defaults = {
  win32: path.join(process.env.LOCALAPPDATA || "", "Programs", "Microsoft VS Code", "Code.exe"),
  darwin: "/Applications/Visual Studio Code.app/Contents/MacOS/Electron",
  linux: "/usr/share/code/code",
};
const executable = process.env.VSCODE_EXECUTABLE || defaults[process.platform];
if (!executable || !fs.existsSync(executable)) {
  console.error(`VS Code not found at ${executable}. Set VSCODE_EXECUTABLE.`);
  process.exit(2);
}

const temp = fs.mkdtempSync(path.join(os.tmpdir(), "route-atlas-e2e-"));
const workspace = path.join(temp, "project");
fs.cpSync(path.join(__dirname, "fixture"), workspace, { recursive: true });

const result = spawnSync(executable, [
  workspace,
  `--extensionDevelopmentPath=${root}`,
  `--extensionTestsPath=${path.join(__dirname, "suite.js")}`,
  `--user-data-dir=${path.join(temp, "user")}`,
  `--extensions-dir=${path.join(temp, "extensions")}`,
  "--disable-workspace-trust",
  "--skip-welcome",
  "--skip-release-notes",
  "--disable-gpu",
], { stdio: "inherit", env: { ...process.env, ELECTRON_RUN_AS_NODE: undefined } });

try {
  fs.rmSync(temp, { recursive: true, force: true, maxRetries: 5 });
} catch {
  // VS Code may still hold a file for a moment; the OS cleans its temp folder.
}
process.exit(result.status === null ? 1 : result.status);
