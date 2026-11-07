# Changelog

## Unreleased

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
