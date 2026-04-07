# Repository Guidelines

## Project Structure & Module Organization

- `src/app.js` bootstraps Express, middleware, Redis initialization, and route mounting.
- `src/routes/` exposes public APIs (`unified`, `openai*`, `gemini*`, `droid`, `user`, `webhook`);
  `src/routes/admin/` contains admin APIs.
- Provider logic is split across:
  - `src/services/account/` (Claude official/console, GCP Vertex, Bedrock, Gemini OAuth/API,
    OpenAI/Responses, Azure OpenAI, Droid, CCR accounts)
  - `src/services/relay/` (provider-specific relay clients)
  - `src/services/scheduler/` (account selection/scheduling)
  - `src/services/balanceProviders/` (provider balance adapters)
- CLI tooling lives in `cli/index.js` and `src/cli/initCosts.js`.
- `web/admin-spa/` contains the Vue 3 + Vite admin SPA.
- `scripts/` covers service management, migrations, diagnostics, data transfer, and pricing tasks.
- Runtime configuration lives in `config/` (`config.js`, `config.example.js`, `models.js`,
  `pricingSource.js`) plus `.env`.
- `tests/` contains Jest/SuperTest suites (`*.test.js`, including `*.integration.test.js`).
- `docs/` and `resources/` contain docs and static assets.
- `data/`, `logs/`, `temp/`, and `redis_data/` are runtime-generated; never commit secrets or
  bulky artifacts.

## Build, Test, and Development Commands

- `npm install` installs backend dependencies.
- `npm run install:web` installs `web/admin-spa` dependencies.
- `npm run build:web` builds the admin SPA.
- `npm run install:web && npm run build:web` is the standard frontend verification sequence.
- `npm run dev` starts nodemon; `npm start` runs lint then production startup.
- `npm run setup` initializes admin credentials and writes `data/init.json`.
- `npm run init:costs` backfills cost data for existing API keys.
- `npm run cli <command>` runs CLI commands (`admin`, `keys`, `status`, `bedrock`).
- `npm run service:*` manages service lifecycle (`start|stop|restart|status|logs`, with
  `:daemon`, `:follow`, and shorthand variants).
- `npm run status` / `npm run status:detail` show runtime health snapshots; `npm run monitor`
  runs enhanced monitoring script.
- `npm test` runs Jest; use `npm test -- tests/<file>.test.js` for targeted runs.
- `npm run lint` / `npm run lint:check` run ESLint; `npm run format` / `npm run format:check`
  run Prettier.
- `npm run data:*` and `npm run migrate:*` provide import/export and migration tooling.
- `npm run docker:build`, `npm run docker:up`, `npm run docker:down` manage Docker lifecycle.
- `docker-compose --profile monitoring up -d` enables optional monitoring stack.
- `web/admin-spa` supports `npm run dev`, `npm run build`, `npm run lint`, `npm run format`.
- `make help` lists additional Makefile shortcuts.

## Coding Style & Naming Conventions

- Indentation: 2 spaces, no tabs; line width ~100.
- JavaScript style: single quotes, no semicolons, trailing commas disabled (Prettier).
- ESLint + Prettier enforce formatting; prefer `npm run format` before commits.
- Test files: `*.test.js` or `*.spec.js` (see `tests/`).

## Testing Guidelines

- Frameworks: Jest + SuperTest for HTTP coverage.
- Run `npm test`; add focused tests for services in `src/services/` and routes in `src/routes/`.
- Prefer realistic integration tests when touching auth, scheduling, routing, Redis behavior, or
  streaming/SSE paths.
- For bug fixes, add or update a failing regression test before implementation.

## Commit & Pull Request Guidelines

- Commit style follows Conventional Commits (e.g., `chore: ...`, `fix: ...`); some releases use `[skip ci]`.
- PRs should include a brief summary, testing notes (commands run), and config impacts
  (e.g., `.env`, `config/config.js`, `config/models.js` changes).
- For security or auth changes, reference `SECURITY.md` and call out risk/mitigations.

## Security & Configuration Tips

- Copy `config/config.example.js` and `.env.example` before running locally.
- Keep `JWT_SECRET` and `ENCRYPTION_KEY` private; never commit real values.
- `config/config.js` includes provider defaults/toggles (e.g., `gcpVertex`, `bedrock`, LDAP,
  user-management); verify these before production rollout.
- Keep deployments on `v1.1.249+`; README flags `v1.1.248` and below for critical admin auth bypass.
- Use Redis 6+ and Node.js 18+ as documented in `README.md` (Docker compose uses Redis 7 image).
