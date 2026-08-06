# m8t releases

Published artifacts for the [m8t](https://m8t.run) platform: the release channel an
installation reads to update itself, the desktop companion builds, and the Claude plugin
marketplace.

Everything here is fetched **anonymously** — an installation holds no credentials, so
everything it reads has to live somewhere public. That is what this repository is for.

| What | Where |
|---|---|
| Platform releases (`manifest.json`) | [Releases](https://github.com/m8t-labs/m8t-releases/releases), tagged `platform-v<version>` |
| Desktop companions | [Releases](https://github.com/m8t-labs/m8t-releases/releases), tagged `companion-v<version>` |
| Claude plugin marketplace | `.claude-plugin/marketplace.json` in this repository |

```bash
claude plugin marketplace add m8t-labs/m8t-releases
claude plugin install m8t@m8t
```

The artifacts here are published by the release pipeline, not edited by hand. The agent
itself, its knowledge, and the install runbook live in
[`m8t-labs/ezra`](https://github.com/m8t-labs/ezra).

Questions, bugs and feature requests are welcome in
[Issues](https://github.com/m8t-labs/m8t-releases/issues) and [Discussions](https://github.com/m8t-labs/m8t-releases/discussions).
