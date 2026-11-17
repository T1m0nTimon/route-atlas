"use strict";

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (char) => ({
    "&":"&amp;", "<":"&lt;", ">":"&gt;", '"':"&quot;", "'":"&#39;",
  })[char]);
}

function dashboardHtml({ title = "Route Atlas", routes = [], languages = [], findings = [] }) {
  const counts = findings.reduce((result, item) => {
    result[item.severity] = (result[item.severity] || 0) + 1;
    return result;
  }, {});
  const languageRows = languages.map((item) =>
    `<tr><td>${escapeHtml(item.language)}</td><td>${item.files}</td></tr>`).join("");
  const findingRows = findings.map((item) =>
    `<tr><td><span class="severity ${escapeHtml(item.severity)}">${escapeHtml(item.severity)}</span></td><td>${escapeHtml(item.title)}<small>${escapeHtml(item.cwe)} · ${escapeHtml(item.confidence)} confidence</small></td><td>${escapeHtml(item.file)}:${item.line}</td></tr>`).join("");
  return `<!doctype html>
<html lang="en"><head><meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline';">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>
:root{color-scheme:light dark}body{font:13px var(--vscode-font-family);color:var(--vscode-foreground);background:var(--vscode-editor-background);padding:22px;max-width:1100px;margin:auto}
h1{font-size:22px;font-weight:600}h2{font-size:15px;margin:28px 0 10px}
.cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:10px}.card{padding:16px;border:1px solid var(--vscode-panel-border);border-radius:8px;background:var(--vscode-sideBar-background)}
.number{font-size:25px;font-weight:650}.muted,small{color:var(--vscode-descriptionForeground)}table{border-collapse:collapse;width:100%}td,th{text-align:left;padding:9px;border-bottom:1px solid var(--vscode-panel-border);vertical-align:top}th{color:var(--vscode-descriptionForeground);font-weight:600}
.severity{font-weight:700;text-transform:uppercase}.critical,.high{color:var(--vscode-errorForeground)}.medium{color:var(--vscode-editorWarning-foreground)}.low{color:var(--vscode-descriptionForeground)}small{display:block;margin-top:4px}
.empty{padding:16px;border:1px dashed var(--vscode-panel-border);border-radius:8px;color:var(--vscode-descriptionForeground)}
</style></head><body>
<h1>${escapeHtml(title)} — Project overview</h1><p class="muted">Static analysis only. Findings are indicators, not proof of exploitability.</p>
<section class="cards">
<div class="card"><div class="number">${routes.length}</div><div class="muted">Detected routes</div></div>
<div class="card"><div class="number">${languages.length}</div><div class="muted">Language / project types</div></div>
<div class="card"><div class="number">${findings.length}</div><div class="muted">Security findings</div></div>
<div class="card"><div class="number">${counts.critical || 0} / ${counts.high || 0}</div><div class="muted">Critical / high</div></div>
</section>
<h2>Languages and project types</h2>
${languages.length ? `<table><thead><tr><th>Language</th><th>Files</th></tr></thead><tbody>${languageRows}</tbody></table>` : '<div class="empty">No recognized source files.</div>'}
<h2>Security findings</h2>
${findings.length ? `<table><thead><tr><th>Severity</th><th>Finding</th><th>Location</th></tr></thead><tbody>${findingRows}</tbody></table>` : '<div class="empty">No matching patterns found. This does not mean the project is vulnerability-free.</div>'}
</body></html>`;
}

module.exports = { dashboardHtml };
