# Route Atlas

Every page and endpoint of your web project in one sorted tree, without any setup. Open a project and the routes are there.

![The route tree of a small shop](media/screenshot.png)

## Features

- **Sorted tree.** Everything below `/admin` hangs under Admin, everything below `/api` under API, down to `/users/:id/edit`. Areas for auth, account, legal and system pages are built in, and any other path that appears twice gets its own group.
- **Group it your way.** By area, path, file, framework, HTTP method or access.
- **Jump to the code.** Click a route, or press `Ctrl+Alt+R` to search all of them.
- **Follow a link.** `F12` or `Ctrl+Click` on a string like `"/admin/users"` opens its handler.
- **Send requests.** Use the play button in the tree or above the route in your code. Parameters are remembered, and the response opens next to your code.
- **Check all routes.** One click calls every plain GET route and shows the status in the tree. Routes with parameters and paths such as `/logout` or `/delete` are left out.
- **Finds your server.** Looks at `PORT` in `.env`, the framework's default port and common ports.
- **Finds problems.** Routes handled twice, and admin routes without a login check, show up in the Problems panel.
- **Export.** Markdown, OpenAPI 3, `.http`, JSON and `sitemap.xml`.
- **Favorites**, a filter, and live updates when you save.

## Supported

- **File-based:** Next.js (app and pages), Nuxt, SvelteKit, SolidStart, Astro, Gatsby, Remix, TanStack Router
- **In code:** Flask, FastAPI, Quart, Sanic, Django, Express, Fastify, Hono, Koa, NestJS, Laravel, Rails, Spring, ASP.NET, Go, Axum, Actix, Rocket
- **Client routers:** React Router, Vue Router, Angular
- **No framework:** every HTML and PHP file

Prefixes from blueprints, routers and `app.use("/api", ...)` are followed across files. Monorepos and multi-root workspaces work.

## Limits

Route Atlas reads your source code and never runs it, so routes built at runtime are missing. The login check is a hint: it recognizes common decorators and middleware, not every way to protect a route.

## Settings

| Setting | Meaning |
| --- | --- |
| `routeAtlas.baseUrl` | Server address. Empty: detected automatically |
| `routeAtlas.requestHeaders` | Headers for every request, for example a token |
| `routeAtlas.categories` | Your own categories with `label`, `pattern` and `icon` |
| `routeAtlas.exclude` | More folders to skip |
| `routeAtlas.codeLens` | Send buttons above routes in the code |
| `routeAtlas.diagnostics` | Entries in the Problems panel |
| `routeAtlas.language` | `auto`, `en` or `de` |

## Privacy

Route Atlas collects nothing and has no telemetry. It only connects to the server address shown in the status bar, and only when you send a request or check routes. Port detection opens a short local connection to `127.0.0.1`.

## Development

```
npm test
npm run package
code --install-extension route-atlas-0.2.1.vsix
```
