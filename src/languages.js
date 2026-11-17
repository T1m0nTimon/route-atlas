"use strict";

// File extensions and well-known project manifests. Detection is heuristic: a file
// extension identifies a language family, not the exact grammar or compiler version.
const EXTENSIONS = {
  ".py":"Python",".pyi":"Python",".pyx":"Cython",
  ".js":"JavaScript",".jsx":"JavaScript/JSX",".mjs":"JavaScript",".cjs":"JavaScript",
  ".ts":"TypeScript",".tsx":"TypeScript/TSX",".mts":"TypeScript",".cts":"TypeScript",
  ".php":"PHP",".phtml":"PHP",".rb":"Ruby",".rake":"Ruby",
  ".java":"Java",".kt":"Kotlin",".kts":"Kotlin",".scala":"Scala",".sc":"Scala",".groovy":"Groovy",
  ".cs":"C#",".fs":"F#",".fsx":"F#",".vb":"Visual Basic",
  ".go":"Go",".rs":"Rust",".swift":"Swift",".m":"Objective-C/C",".mm":"Objective-C++",
  ".c":"C",".h":"C/C++ Header",".cc":"C++",".cpp":"C++",".cxx":"C++",".hpp":"C++ Header",
  ".html":"HTML",".htm":"HTML",".css":"CSS",".scss":"SCSS",".sass":"Sass",".less":"Less",
  ".vue":"Vue",".svelte":"Svelte",".astro":"Astro",".md":"Markdown",".mdx":"MDX",
  ".sql":"SQL",".sh":"Shell",".bash":"Shell",".zsh":"Shell",".ps1":"PowerShell",
  ".json":"JSON",".jsonc":"JSON with Comments",".yaml":"YAML",".yml":"YAML",".toml":"TOML",
  ".xml":"XML",".graphql":"GraphQL",".gql":"GraphQL",".proto":"Protocol Buffers",
  ".dart":"Dart",".lua":"Lua",".pl":"Perl",".ex":"Elixir",".exs":"Elixir",
  ".erl":"Erlang",".hrl":"Erlang",".hs":"Haskell",".lhs":"Haskell",
  ".clj":"Clojure",".cljs":"ClojureScript",".cljc":"Clojure",
  ".r":"R",".R":"R",".jl":"Julia",".tf":"Terraform/HCL",".hcl":"HCL",
  ".dockerfile":"Dockerfile",".make":"Makefile",".mk":"Makefile",
  ".ipynb":"Jupyter Notebook",".vue":"Vue",
};

const MANIFESTS = {
  "package.json":"Node.js project","pyproject.toml":"Python project","requirements.txt":"Python dependencies",
  "Pipfile":"Python project","composer.json":"PHP/Composer project","Cargo.toml":"Rust project",
  "go.mod":"Go module","Gemfile":"Ruby/Bundler project","pom.xml":"Java/Maven project",
  "build.gradle":"Gradle project","build.gradle.kts":"Gradle/Kotlin project","*.csproj":".NET project",
  "pubspec.yaml":"Dart/Flutter project","mix.exs":"Elixir project","Package.swift":"Swift package",
  "Dockerfile":"Container build","docker-compose.yml":"Docker Compose","compose.yaml":"Docker Compose",
  "Makefile":"Make build","CMakeLists.txt":"CMake/C++ project","terraform.tf":"Terraform project",
};

function languageForFile(file) {
  const path = require("path");
  const base = path.basename(file);
  if (MANIFESTS[base]) return MANIFESTS[base];
  if (/\.csproj$/i.test(base)) return ".NET project";
  if (/^Dockerfile(\.|$)/i.test(base)) return "Dockerfile";
  if (base === "Makefile" || base === "GNUmakefile") return "Makefile";
  const ext = path.extname(base);
  return EXTENSIONS[ext] || EXTENSIONS[ext.toLowerCase()] || null;
}

function summarizeLanguages(files) {
  const counts = new Map();
  for (const file of files) {
    const language = languageForFile(file);
    if (language) counts.set(language, (counts.get(language) || 0) + 1);
  }
  return [...counts.entries()].map(([language, files]) => ({ language, files }))
    .sort((a, b) => b.files - a.files || a.language.localeCompare(b.language));
}

module.exports = { EXTENSIONS, MANIFESTS, languageForFile, summarizeLanguages };
