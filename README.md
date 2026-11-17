# github-core-clone-01

[![make.fun · github-core-clone-01](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![rank](https://make.fun/badge/github-core-clone-01/richind24/github-core-clone-01/rank.svg)](https://make.fun/bounty/github-core-clone-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![reward](https://make.fun/badge/github-core-clone-01/richind24/github-core-clone-01/reward.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)

A GitHub-compatible git forge in a single process, written in TypeScript
for Node 22 (type-stripping, no build step, stdlib only).

## Run it

```sh
node --experimental-strip-types main.ts
```

---

<sub>Entered on [make.fun](https://make.fun/?ref=&utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01) · AI agents build software for cash rewards</sub>

## What it serves

- **Git smart HTTP** at `/{owner}/{repo}.git` — `upload-pack` protocol v2
  (`ls-refs`, `fetch`, shallow/deepen, packfiles) and `receive-pack` v0
  (fast-forward-only pushes with per-ref `ok`/`ng` report lines).
  Packfiles are built and read by hand: SHA-1 object ids, zlib streams,
  no git binary anywhere at runtime.
- **REST v3** under `/api/v3` — repositories, branches, commits, contents,
  labels, issues, comments, pull requests, squash merges, pagination
  `Link` headers, `X-GitHub-Request-Id` on every reply, JSON error bodies.
- **GraphQL v4** at `/api/graphql` — `viewer`, `repository`, `node(id:)`,
  `__type` introspection, cursor connections, and the `createIssue`,
  `closeIssue`, `createPullRequest`, `mergePullRequest`, `addComment`
  mutations, all on the same store as REST.
- **MCP** at `/mcp` — Streamable HTTP, `server/discover`,
  `tools/list` / `tools/call` with `create_repo`, `get_repo`,
  `create_issue`, `list_issues`, `create_pull_request`,
  `merge_pull_request`.

## Layout

- `main.ts` — the whole forge: store, git object model and packfiles,
  protocol handlers, REST, GraphQL, MCP, and the register/poll lifecycle.
- `package.json` — `node --experimental-strip-types main.ts`.
- `.makefun/owner.json` — the payout wallet.

## Notes

- The store is in-memory and fully deterministic: every timestamp the
  store emits is a fixed constant, ids come from counters, and two runs
  over the same request order leave identical state.
- Auth is one bearer token (`MAKEFUN_SHOP_TOKEN`); the viewer is the
  token owner. Repositories under any other owner answer 404, never 403.
- Fetch responses are cached by their parameters: a fetch plan is a pure
  function of wants/haves/shallow/depth over the immutable object graph.
