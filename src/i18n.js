"use strict";

const GERMAN = {
  Pages: "Seiten",
  Auth: "Anmeldung",
  Account: "Konto",
  Legal: "Rechtliches",
  Favorites: "Favoriten",
  Protected: "Geschützt",
  Public: "Öffentlich",
  "Areas": "Bereiche",
  "Path tree": "Pfadbaum",
  "File": "Datei",
  "Framework": "Framework",
  "HTTP method": "HTTP-Methode",
  "Access": "Zugriff",
  "Group routes by": "Seiten sortieren nach",
  "Filter routes": "Seiten filtern",
  "Path, method or framework": "Pfad, Methode oder Framework",
  "Filter: {0}": "Filter: {0}",
  "Find a route": "Seite suchen",
  "Type a path, method or file": "Pfad, Methode oder Datei eingeben",
  "{0} routes": "{0} Seiten",
  "Protected route": "Geschützte Seite",
  "Value for {0}": "Wert für {0}",
  "Request body (optional)": "Inhalt der Anfrage (optional)",
  "Choose a method": "Methode wählen",
  "Sending {0} {1}": "Sende {0} {1}",
  "Show headers": "Header zeigen",
  "Set the server address": "Serveradresse festlegen",
  "No server answers at {0}. Start it, or set the address.": "Unter {0} antwortet kein Server. Starte ihn oder lege die Adresse fest.",
  "Request failed: {0}": "Anfrage fehlgeschlagen: {0}",
  "Server address": "Serveradresse",
  "Leave empty to detect it": "Leer lassen für automatische Erkennung",
  "Server running at {0}": "Server läuft unter {0}",
  "No server found, using {0}": "Kein Server gefunden, nutze {0}",
  "Checking routes": "Prüfe Seiten",
  "Checked {0} routes: {1} fine, {2} with errors": "{0} Seiten geprüft: {1} in Ordnung, {2} mit Fehlern",
  "{0} is not on this computer. Send requests to all routes anyway?": "{0} liegt nicht auf diesem Rechner. Trotzdem Anfragen an alle Seiten senden?",
  "Check": "Prüfen",
  "Export routes": "Seiten exportieren",
  "Routes of {0}": "Seiten von {0}",
  "{0} {1} is also handled at {2}, so one of them never runs.": "{0} {1} wird auch in {2} behandelt, eine der beiden Stellen läuft also nie.",
  "This admin route has no login check that Route Atlas could find.": "Für diese Admin-Seite hat Route Atlas keine Anmeldeprüfung gefunden.",
  "No login check found": "Keine Anmeldeprüfung gefunden",
  "Handled twice": "Doppelt belegt",
  "Open in browser": "Im Browser öffnen",
  "Send request": "Anfrage senden",
};

function createTranslator(language) {
  const table = language === "de" ? GERMAN : {};
  return (text, ...values) => (table[text] || text).replace(/\{(\d)\}/g, (_, index) => values[index]);
}

/** VS Code often runs in English on a German system, so the system counts as well. */
function resolveLanguage(setting, editorLanguage, systemLocale) {
  if (setting === "de" || setting === "en") return setting;
  return editorLanguage.startsWith("de") || systemLocale.startsWith("de") ? "de" : "en";
}

module.exports = { createTranslator, resolveLanguage };
