"use strict";

const fs = require("fs/promises");
const path = require("path");
const { SKIP_DIRS } = require("./scanner");
const { languageForFile } = require("./languages");

const SOURCE_EXTENSIONS = new Set([
  ...Object.keys(require("./languages").EXTENSIONS),
  ".env", ".ini", ".conf", ".config", ".properties", ".gradle", ".tfvars",
]);
const MAX_FILE_SIZE = 1024 * 1024;
const PLACEHOLDER = /^(?:your[_ -]?.*|change[_ -]?me(?:[_ -].*)?|example|sample|dummy|placeholder|xxx+|<.*>|\*+|)$/i;

const RULES = [
  { id:"secret-hardcoded", severity:"critical", cwe:"CWE-798", title:"Möglicherweise fest codiertes Geheimnis", confidence:"medium",
    regex:/\b(?:api[_-]?key|access[_-]?token|client[_-]?secret|secret[_-]?key|password|passwd|private[_-]?key)\b\s*[:=]\s*["'`]([^"'`\r\n]{8,})["'`]/gi,
    check:(m)=>!PLACEHOLDER.test(m[1]) && !/^(?:process\.env|env\(|os\.environ)/i.test(m[1]) },
  { id:"private-key", severity:"critical", cwe:"CWE-321", title:"Privater Schlüssel im Quellcode", confidence:"high",
    regex:/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/g },
  { id:"sql-concat", severity:"high", cwe:"CWE-89", title:"Mögliche SQL-Injection durch String-Verkettung", confidence:"medium",
    regex:/(?:SELECT|INSERT|UPDATE|DELETE)\b[^\n]{0,180}(?:\+\s*\w+|\$\{[^}]+\}|\.\s*\w+|%\s*\w+)/gi },
  { id:"dynamic-eval", severity:"high", cwe:"CWE-95", title:"Dynamische Code-Ausführung", confidence:"medium",
    regex:/\b(?:eval|exec|Function)\s*\(/g },
  { id:"shell-injection", severity:"high", cwe:"CWE-78", title:"Shell-Aufruf mit möglicher Benutzereingabe", confidence:"medium",
    regex:/(?:exec|execSync|spawn|system|popen)\s*\([^\n]{0,160}(?:\$\{|\+\s*(?:req\.|request\.|params\.|input)|shell\s*:\s*true)/gi },
  { id:"unsafe-innerhtml", severity:"high", cwe:"CWE-79", title:"Unsichere HTML-Ausgabe über innerHTML", confidence:"medium",
    regex:/\.innerHTML\s*=|dangerouslySetInnerHTML\s*=|v-html\s*=/g },
  { id:"weak-tls", severity:"high", cwe:"CWE-295", title:"TLS-Zertifikatsprüfung deaktiviert", confidence:"high",
    regex:/(?:rejectUnauthorized\s*:\s*false|verify\s*=\s*False|CURLOPT_SSL_VERIFYPEER\s*,\s*false|NODE_TLS_REJECT_UNAUTHORIZED\s*=\s*["']0["'])/gi },
  { id:"wildcard-cors", severity:"medium", cwe:"CWE-942", title:"CORS erlaubt beliebige Origins", confidence:"medium",
    regex:/(?:Access-Control-Allow-Origin|allow_origins?)\s*[:=]\s*(?:["']\*["']|\[\s*["']\*["']\s*\])/gi },
  { id:"weak-hash", severity:"medium", cwe:"CWE-328", title:"Schwacher Hash-Algorithmus", confidence:"low",
    regex:/\b(?:md5|sha1)\s*\(/gi },
  { id:"debug-enabled", severity:"medium", cwe:"CWE-489", title:"Debug-Modus möglicherweise aktiviert", confidence:"low",
    regex:/\b(?:DEBUG|debug)\s*[:=]\s*(?:true|True|1|["']1["'])/g },
];

function lineAt(text, index) {
  return text.slice(0, index).split("\n").length;
}

function scanText(file, text) {
  const findings = [];
  for (const rule of RULES) {
    rule.regex.lastIndex = 0;
    for (let match; (match = rule.regex.exec(text)); ) {
      if (rule.check && !rule.check(match)) continue;
      const line = lineAt(text, match.index);
      findings.push({
        id: rule.id, severity: rule.severity, cwe: rule.cwe, title: rule.title,
        confidence: rule.confidence, file, line, column: match.index - text.lastIndexOf("\n", match.index - 1) - 1,
        evidence: match[0].slice(0, 100),
        language: languageForFile(file) || "Unknown",
      });
      if (match[0].length === 0) rule.regex.lastIndex++;
    }
  }
  return findings;
}

async function walkSource(root, exclude = []) {
  const skip = new Set([...SKIP_DIRS, ...exclude, ".git", ".hg", ".svn"]);
  const pending = [root];
  const files = [];
  while (pending.length) {
    const dir = pending.pop();
    let entries;
    try { entries = await fs.readdir(dir, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      if (entry.name.startsWith(".") && entry.name !== ".env" && !entry.name.startsWith(".env.")) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!skip.has(entry.name)) pending.push(full);
      } else if (entry.isFile() && (SOURCE_EXTENSIONS.has(path.extname(entry.name).toLowerCase()) || entry.name === "Dockerfile" || entry.name === ".env" || /^\.env\.(?!example$|sample$|template$)[a-z0-9_-]+$/i.test(entry.name))) {
        if (/\.env\.(?:example|sample|template)$/i.test(entry.name)) continue;
        files.push(full);
      }
    }
  }
  return files;
}

async function scanSecurity(root, { exclude = [], maxFiles = 20000 } = {}) {
  const files = (await walkSource(root, exclude)).slice(0, maxFiles);
  const findings = [];
  for (const file of files) {
    try {
      const stat = await fs.stat(file);
      if (stat.size > MAX_FILE_SIZE) continue;
      const content = await fs.readFile(file, "utf8");
      findings.push(...scanText(file, content));
    } catch { /* unreadable or binary file */ }
  }
  return findings.sort((a,b) => ({critical:0,high:1,medium:2,low:3}[a.severity] - {critical:0,high:1,medium:2,low:3}[b.severity]) || a.file.localeCompare(b.file) || a.line-b.line);
}

module.exports = { RULES, scanText, scanSecurity };
