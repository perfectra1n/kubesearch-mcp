# Changelog

## [1.3.0](https://github.com/perfectra1n/kubesearch-mcp/compare/v1.2.0...v1.3.0) (2026-10-22)


### Features

* **renovate:** implement renovate ([cd849d9](https://github.com/perfectra1n/kubesearch-mcp/commit/cd849d9429cc7907ad1e15ef31a823453edf668d))


### Bug Fixes

* **data:** wait for both downloads to settle before rejecting ([9f4d257](https://github.com/perfectra1n/kubesearch-mcp/commit/9f4d2571286a41cabd48c46a1cb0432a08cd9e5d))


### Continuous Integration

* target main, move off deprecated Node 20 actions ([5c028a4](https://github.com/perfectra1n/kubesearch-mcp/commit/5c028a42e48a3247d2d4ad897d2accd26b500a4e))


### Miscellaneous Chores

* **data:** escape the NUL in the SQLite magic string ([3873c52](https://github.com/perfectra1n/kubesearch-mcp/commit/3873c52f10e3cd7f4098169fcfb7d3eb56e7bb21))

## [1.2.0](https://github.com/perfectra1n/kubesearch-mcp/compare/v1.1.0...v1.2.0) (2026-09-08)


### Features

* always-warm pool of top repos + repo_grep_all ([dd69d4e](https://github.com/perfectra1n/kubesearch-mcp/commit/dd69d4eea53c8e7506e33bf00de4bbcf3077fb6e))
* **repo:** grepAll across pinned pool clones ([663a8d7](https://github.com/perfectra1n/kubesearch-mcp/commit/663a8d7cde85598be2beaf2c112fe487d1ddab4a))
* **repo:** pinned pool clones in RepoStore, pool config and member selection ([498138d](https://github.com/perfectra1n/kubesearch-mcp/commit/498138def9bfbdd454fbd44bf2425574843d9f1e))
* **repo:** RepoPool keeps the top indexed repos permanently cloned ([e6aa902](https://github.com/perfectra1n/kubesearch-mcp/commit/e6aa90258e615c15a3a2f057177e3f77943b6905))
* **tools:** repo_grep_all greps the always-warm pool of top repos ([6ff2dac](https://github.com/perfectra1n/kubesearch-mcp/commit/6ff2daca4b07b11b7ff25ba28b4992cb853f8adc))


### Documentation

* **readme:** document the always-warm repo pool and repo_grep_all ([fffe7a4](https://github.com/perfectra1n/kubesearch-mcp/commit/fffe7a44fe4dfa464a95b50e98be00babb54a031))


### Continuous Integration

* **release:** manage versions with release-please ([4b0de15](https://github.com/perfectra1n/kubesearch-mcp/commit/4b0de15f7e2b47314d2904a0e57cbc40c846107d))
* **release:** manage versions with release-please ([07ddc6e](https://github.com/perfectra1n/kubesearch-mcp/commit/07ddc6ef46e292c97b524c45d1cdb030771fc31f))
