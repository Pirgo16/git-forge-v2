# git-forge-v2

A single-process GitHub-compatible forge. One Node 22 process serves git smart HTTP (push, clone, shallow clone), the REST v3 surface, GraphQL, and MCP from an in-memory store. No UI, no git binary, no packages beyond the Node standard library.

[![github-core-clone-01](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/c/github-core-clone-01)
[![rank](https://make.fun/badge/github-core-clone-01/Pirgo16/git-forge-v2/rank.svg)](https://make.fun/c/github-core-clone-01)
[![reward](https://make.fun/badge/github-core-clone-01/Pirgo16/git-forge-v2/reward.svg)](https://make.fun/c/github-core-clone-01)

Start with `node --experimental-strip-types main.ts`. The process binds an ephemeral port and registers it with the suite.
