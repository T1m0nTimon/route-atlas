# Changelog

## Unreleased

- **AI security prompt.** One click turns the security findings into a Markdown prompt for ChatGPT, Claude, Copilot and others: instructions, attack surface, and every finding with a code snippet. Secrets are redacted. Large reports are split into self-contained parts of at most `routeAtlas.aiPromptMaxChars` characters (default 20000). The files land in `.route-atlas/`, which ignores itself in Git, so coding agents in the project can read them directly. Also on the command line: `route-atlas ai`.
- **Route graph.** A force-directed map of areas, routes, source files and findings, coloured by area, with search, cluster hulls, a security heatmap, labels, force and zoom controls. Double-click a node to open its code.

## 0.4.1

- Add a dedicated Security view in the Route Atlas sidebar.
- Add a clear one-click **Start security scan** action and visible findings list.
- Click a finding to jump directly to the affected file and line.

## 0.4.0

- Add broad language and project-manifest recognition.
- Expand source discovery for C/C++, Swift, Dart, Scala, Elixir, Haskell, SQL, shell, Terraform and configuration formats.
- Add a local, read-only heuristic security scanner with CWE references and VS Code Problems diagnostics.
- Add a visual project/security dashboard.
- Keep security analysis separate from route extraction; unsupported route grammars are not guessed.

## 0.3.1

- Optional Laravel runtime scanning via `php artisan route:list --json`, so routes registered by service providers and plugins can be discovered
- Runtime scanning is opt-in, uses a shell-free process with a timeout, and falls back to static scanning if PHP or Artisan is unavailable
- CLI option: `--laravel-runtime`; VS Code setting: `routeAtlas.laravelRuntime`
- Added parser tests for Laravel route-list output

## 0.3.0

Tools for full-stack developers: Route Atlas now checks your links, writes request code for you and keeps your frontend in step with your routes.

- Broken links: `href`, `fetch`, `router.push`, `redirect` and Markdown links that no route answers show up in the Problems panel, with a quick fix
- Copy a route as cURL, `fetch`, Axios or HTTPie
- Generate typed TypeScript route helpers, on demand or kept up to date through `routeAtlas.helpersFile`
- Command line tool `route-atlas` with `list`, `export`, `check` and `lint`, for scripts and CI
- Follow more prefixes: routers mounted in the same file, named imports, files like `user.routes.js`, Fastify `register` options, nested `include_router` and Django `include`
- Flask: a `url_prefix` at registration replaces the one of the blueprint
- Python: imports over several lines and relative imports find the right module

## 0.2.1

- Link the repository and show a screenshot in the README

## 0.2.0

- Routes form a real tree, so everything below `/admin` hangs under Admin
- Group by area, path, file, framework, method or access
- Send requests from the tree and from above the route in the code
- Check all routes, with the status in the tree
- Search with `Ctrl+Alt+R`, go to definition on path strings, favorites
- Finds the running server by itself
- Problems panel: routes handled twice, admin routes without a login check
- Export as Markdown, OpenAPI 3, `.http`, JSON and `sitemap.xml`
- English and German

## 0.1.0

- First version
