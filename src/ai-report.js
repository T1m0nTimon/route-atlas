"use strict";

const fs = require("fs/promises");
const path = require("path");
const { RULES } = require("./security");

const SEVERITY_ORDER = { critical: 0, high: 1, medium: 2, low: 3 };
const SECRET = RULES.find((rule) => rule.id === "secret-hardcoded").regex;

/** Hides secret values before code leaves the machine. An AI never needs the real key. */
function redact(text, file = "") {
  let result = text;
  if (/(^|[\\/])\.env(\.[\w-]+)?$/.test(file)) result = result.replace(/^(\s*[\w.-]+\s*=\s*).+$/gm, "$1***");
  return result
    .replace(new RegExp(SECRET.source, SECRET.flags), (match, value) => match.replace(value, "***"))
    // Keeps the number of lines, so line numbers in snippets stay right.
    .replace(/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g, (block) =>
      block.split("\n").map((line, index, all) => (index === 0 || index === all.length - 1 ? line : "***")).join("\n"))
    .replace(/\b[A-Za-z0-9+/_-]{40,}={0,2}/g, "***");
}

/** Numbered lines around `line` (1-based), with the hit marked by `>`. */
async function snippet(file, line, radius = 3, cache = new Map()) {
  if (!cache.has(file)) cache.set(file, fs.readFile(file, "utf8").then((text) => redact(text.replace(/\r\n/g, "\n"), file).split("\n"), () => null));
  const lines = await cache.get(file);
  if (!lines) return "";
  const from = Math.max(1, line - radius);
  const to = Math.min(lines.length, line + radius);
  const width = String(to).length;
  const out = [];
  for (let number = from; number <= to; number++) {
    out.push(`${String(number).padStart(width)} ${number === line ? ">" : "|"} ${lines[number - 1].slice(0, 200)}`);
  }
  return out.join("\n");
}

const INSTRUCTIONS = `Du bist ein erfahrener Security-Reviewer. Die Funde unten stammen aus einem statischen Scanner (Route Atlas). Es sind Heuristiken: viele können False Positives sein.

Für jeden Fund:
1. Bewerte ihn: **echtes Risiko**, **False Positive** oder **unklar**, mit kurzer Begründung anhand des Codes.
2. Bei echtem Risiko: gib einen minimalen, konkreten Fix als Code (am besten als Diff).
3. Sortiere deine Antwort nach Dringlichkeit.

Geheimnisse wurden geschwärzt (\`***\`). Frage nicht nach ihnen; ist ein echter Schlüssel im Code, empfiehl ihn zu rotieren und in Umgebungsvariablen oder einen Secret-Store zu verschieben.

Antwortformat: zuerst eine Tabelle \`ID | Bewertung | Begründung\`, danach die Fixes je ID.`;

function fence(file) {
  const ext = path.extname(file).slice(1).toLowerCase();
  return /^[a-z0-9]+$/.test(ext) ? ext : "";
}

function cell(value) {
  return String(value).replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
}

/**
 * Builds a ready-to-paste AI prompt in Markdown, split into parts of at most `maxChars`.
 * Every part repeats the instructions, so each can be pasted into a chat on its own.
 */
async function toAiPrompt({ title = "Projekt", root = "", routes = [], routeIssues = [], findings = [], maxChars = 20000 }) {
  const relative = (file) => (root ? path.relative(root, file).split(path.sep).join("/") : file) || file;
  const cache = new Map();
  const blocks = [];

  const sorted = [...findings].sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity]);
  for (const [index, finding] of sorted.entries()) {
    const code = await snippet(finding.file, finding.line, 3, cache);
    blocks.push([
      `### S${index + 1} · ${finding.severity.toUpperCase()} · ${finding.title}`,
      `\`${relative(finding.file)}:${finding.line}\` · ${finding.cwe} · Konfidenz: ${finding.confidence}`,
      code ? `\`\`\`${fence(finding.file)}\n${code}\n\`\`\`` : `Treffer: \`${redact(finding.evidence || "", finding.file)}\``,
    ].join("\n"));
  }
  for (const [index, issue] of routeIssues.entries()) {
    const code = await snippet(issue.file, issue.line + 1, 3, cache);
    blocks.push([
      `### R${index + 1} · MEDIUM · Admin-Route ohne erkennbaren Login-Check`,
      `\`${issue.route.methods.join(", ") || "ANY"} ${issue.route.path}\` in \`${relative(issue.file)}:${issue.line + 1}\` · CWE-306`,
      code ? `\`\`\`${fence(issue.file)}\n${code}\n\`\`\`` : "",
    ].filter(Boolean).join("\n"));
  }

  const counts = sorted.reduce((sum, item) => ({ ...sum, [item.severity]: (sum[item.severity] || 0) + 1 }), {});
  const overview = [
    "## Überblick",
    `- Funde: ${sorted.length} (kritisch ${counts.critical || 0}, hoch ${counts.high || 0}, mittel ${counts.medium || 0}, niedrig ${counts.low || 0})`,
    `- Admin-Routen ohne erkennbaren Login-Check: ${routeIssues.length}`,
    `- Erkannte Routen: ${routes.length}`,
  ].join("\n");

  // The attack surface helps the AI judge reachability; it may use at most a third of part 1.
  let surface = "";
  if (routes.length) {
    const rows = ["## Angriffsfläche (Routen)", "", "| Methode | Pfad | Geschützt | Datei |", "| --- | --- | --- | --- |"];
    let shown = 0;
    for (const route of routes) {
      const row = `| ${cell(route.methods.join(", ") || "ANY")} | \`${cell(route.path)}\` | ${route.protected ? "ja" : "?"} | ${cell(relative(route.file))}:${route.line + 1} |`;
      if (rows.join("\n").length + row.length > maxChars / 3) break;
      rows.push(row);
      shown++;
    }
    if (shown < routes.length) rows.push("", `… und ${routes.length - shown} weitere Routen.`);
    surface = rows.join("\n");
  }

  const head = (part) => `# Security-Review: ${title}${part}\n\n${INSTRUCTIONS}`;
  const NOTE = "\n\n> Jeder Teil ist eigenständig. Die Fund-IDs sind über alle Teile eindeutig.";
  const reserve = head(" (Teil 99 von 99)").length + NOTE.length + 10;
  const budget = Math.max(maxChars - reserve, 500);
  const parts = [[overview, surface].filter(Boolean)];
  let size = parts[0].join("\n\n").length;
  for (let block of blocks) {
    if (block.length > budget) block = `${block.slice(0, budget - 20)}\n… (gekürzt)\n\`\`\``;
    if (size + block.length + 2 > budget && parts[parts.length - 1].length) {
      parts.push([]);
      size = 0;
    }
    parts[parts.length - 1].push(block);
    size += block.length + 2;
  }
  if (!blocks.length) parts[0].push("Der Scanner hat keine Muster gefunden. Das beweist nicht, dass das Projekt sicher ist.");
  return parts.map((sections, index) => {
    const label = parts.length > 1 ? ` (Teil ${index + 1} von ${parts.length})` : "";
    const note = parts.length > 1 ? NOTE : "";
    return `${head(label)}${note}\n\n${sections.join("\n\n")}\n`;
  });
}

module.exports = { toAiPrompt, redact };
