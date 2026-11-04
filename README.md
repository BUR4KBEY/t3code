# T3 Code (BUR4KBEY fork)

A personal fork of [pingdotgg/t3code](https://github.com/pingdotgg/t3code), the desktop and web control surface for coding agents. For what T3 Code is, how to use it, and the official downloads, read the [upstream README](https://github.com/pingdotgg/t3code#readme). This file only covers how the fork differs.

The fork follows upstream nightly releases. `main` is the newest upstream nightly tag with this fork's commits on top, and it is rebased (and force-pushed) every time it moves to a newer nightly.

## What the fork adds

### devenv indicator

When the agent process runs inside a [devenv](https://devenv.sh) shell, T3 shows it in three places:

- the thread header: the devenv logo and `DEVSHELL_NAME`
- the sidebar row: the devenv logo next to the provider icon
- the thread hover card: `devenv · DEVSHELL_NAME`, or `devenv` when the shell sets no name

The server reads `DEVENV_ROOT` and `DEVSHELL_NAME` from `/proc/<pid>/environ` of the ACP agent at the start of every turn. That is the environment the agent was started with, not something derived from the project folder, so the indicator only appears when the launcher really entered the shell. If the launcher fails, the indicator disappears on the next turn. Linux only; on other systems it never shows.

The agent has to be started inside the shell. For omp, the package installs [`omp-devenv`](./packaging/fork/omp-devenv) to `/usr/bin`; set the OMP provider's command to `omp-devenv` with arguments `acp` (Settings → Providers → OMP). In a project with `devenv.nix` or `devenv.yaml` it runs omp inside `devenv shell`, in a linked git worktree it uses the main checkout's devenv, and anywhere else it runs plain omp. `OMP_DEVENV_DEBUG=1` logs its decisions to `~/.local/state/omp-devenv/debug.log`.

A different wrapper works too, as long as it keeps stdout clean: ACP clients end the session on the first line that isn't JSON-RPC, and devenv `enterShell` hooks print to stdout. `omp-devenv` sends their output to stderr.

Existing threads pick up the indicator on their next message.

### omp usage history

Upstream's Usage page has no session reader for ACP Registry agents, so omp threads never appear in its totals even though the composer shows their live cost. The fork adds an `omp` usage provider that reads omp's session files from `~/.omp/agent/sessions`. Each assistant message in those files records its tokens and `cost.total`, so the cost on Usage is omp's own number, not an estimate.

omp writes the same JSONL format as Pi, so the reader is Pi's reader (`packages/provider-pi/src/server/usage.ts`) with a different default directory. omp also honors `PI_CODING_AGENT_DIR` and `PI_CODING_AGENT_SESSION_DIR`. If those point omp and Pi at one directory, the sessions count once, under Pi. The reader is attached to the `acpRegistry` driver in `apps/server/src/provider/builtInDrivers.ts`.

Known gap: the Usage page links each usage provider to one driver, and omp shares `acpRegistry` with every other registry agent. Hiding omp on Usage also hides Limits rows of other ACP Registry agents, and those rows take omp's color.

Upstream status (checked 2026-11-01): no issue, PR, or discussion covers omp usage. The closest are discussions [#27535](https://github.com/pingdotgg/t3code/discussions/27535) (Devin history through the ACP Registry) and [#24407](https://github.com/pingdotgg/t3code/discussions/24407) (Usage for ACP Registry agents in general). Upstream treats a new Usage source as a feature that needs an approved Ideas discussion before a PR. It closed [#26728](https://github.com/pingdotgg/t3code/pull/26728) (ACP plan limits in Usage) on those grounds, and it has closed every omp provider PR (#8985, #10893, and others) because omp is not a supported provider. Propose the general ACP Registry approach in an Ideas discussion before sending this upstream.

### Usage limits for agents

Upstream shows subscription limits only to clients (Usage → Limits, `/usage-limits`, the thread details card). The fork adds a read-only MCP tool, `t3_usage_limits`, so agents running in T3 can check them too, for example before starting a long job or picking where to delegate.

It returns the same pooled per-account report as Usage → Limits: provider accounts and CLIProxyAPI hub accounts, each with `checkedAt` (when its limits were last read), its windows (`label`, `usedPercent`, `resetsAt`), and an `unavailable` reason when there is one. Hub errors come back in `notices`. `driver` narrows the result to one provider type, such as `codex`. `environmentId` reads a linked machine's limits.

By default it returns the saved snapshot. `refresh: true` re-checks every provider and hub first, at most once a minute per environment; a call inside that minute gets the saved data with `refreshed: false`. The result never includes hub URLs, management keys, emails, workspace ids, or reset credit ids. Hub account labels are built from the hub's auth file names, which often contain the login email, exactly as the UI shows them.

The tool lives in `apps/server/src/mcp/toolkits/environment/`, next to `t3_environment_read`, with the same access rules; it is also on Claude's read-only tool allowlist. It reuses the UI's normalizer through `collectDriverUsageLimits` in `packages/shared/src/usageLimits.ts`. Adding it raises `mcpToolListJsonBytes` in `apps/server/src/provider/agentContextBudget.json`; after a rebase that changes tool text, rerun `apps/server/src/provider/AgentContextBudget.test.ts` and copy the measured value.

## Installing on Arch Linux

`packaging/fork/PKGBUILD` builds a package named `t3code-nightly-patched`. It replaces `t3code-nightly-bin`.

The package takes the official nightly AppImage named by `pkgver` and rebuilds only its JavaScript (server, web client, Electron main) from the committed `main` branch of your checkout. The native helpers and Electron come from the AppImage, so you need no Rust or C toolchain. Node and pnpm come from the checkout's devenv shell (see below).

Build dependencies: `git` and [devenv](https://devenv.sh/getting-started/). devenv is not a pacman package, so the PKGBUILD checks for it itself.

```sh
git clone git@github.com:BUR4KBEY/t3code.git
cd t3code/packaging/fork
makepkg -Cf
sudo pacman -U t3code-nightly-patched-*-x86_64.pkg.tar.zst
```

The build stops if the rebuilt bundle's file list differs from the official one. That catches build settings drifting away from upstream's release CI. A change that adds a new bundle chunk can also trip it; read the diff before relaxing the check.

## Updating to a newer nightly

```sh
cd packaging/fork
./sync-upstream.sh
makepkg -Cf
sudo pacman -U t3code-nightly-patched-<new version>-x86_64.pkg.tar.zst
git push --force-with-lease origin main
```

`sync-upstream.sh` fetches upstream tags, rebases `main` onto the newest nightly, updates `pkgver` and the checksum, and commits that change. If the rebase hits a conflict, resolve it, run `git rebase --continue`, then run the script again.

It expects a remote named `upstream` pointing at `https://github.com/pingdotgg/t3code`.

## Working on the fork

Each fork change is an ordinary commit on `main`. Keep them few and self-contained so rebases stay cheap, and keep fork-only files under `packaging/fork/` so they never collide with upstream paths. The exceptions are `devenv.nix`, `devenv.yaml`, `devenv.lock`, and a few lines at the end of `.gitignore`, which devenv needs at the repository root.

`devenv shell` gives you the Node version `package.json` pins, from the `cachix/devenv-nixpkgs` rolling channel, and pnpm, which switches itself to the `packageManager` version. pnpm's home, store, and cache live under `.devenv/state`, so nothing is written to your home directory. If upstream bumps `engines.node` past what the channel has, `devenv test` fails; run `devenv update` and try again.

To run a change before packaging it, use upstream's dev server with a separate data directory so it doesn't touch your real `~/.t3`:

```sh
devenv shell -- sh -c 'pnpm install && pnpm dev --home-dir ~/.t3-dev'
```

The package build reads committed `main`, not your working tree, so commit before running `makepkg`.

## License

MIT, as upstream. See [LICENSE](./LICENSE). The devenv logo comes from [cachix/devenv](https://github.com/cachix/devenv) (Apache-2.0).
