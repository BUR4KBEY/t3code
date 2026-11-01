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

The agent has to be started inside the shell. For omp, use a wrapper such as [omp-devenv](https://github.com/BUR4KBEY/devbox-nixos/blob/main/dotfiles/bin/omp-devenv) as the provider command (Settings → Providers → OMP). The wrapper must keep stdout clean: ACP clients end the session on the first line that isn't JSON-RPC, and `enterShell` hooks print to stdout.

Existing threads pick up the indicator on their next message.

## Installing on Arch Linux

`packaging/fork/PKGBUILD` builds a package named `t3code-nightly-patched`. It replaces `t3code-nightly-bin`.

The package takes the official nightly AppImage named by `pkgver` and rebuilds only its JavaScript (server, web client, Electron main) from the committed `main` branch of your checkout. The native helpers and Electron come from the AppImage, so you need no Rust or C toolchain. Node and pnpm are fetched by [mise](https://mise.jdx.dev) at the versions the source pins and are not put on your PATH.

Build dependencies: `git`, `jq`, `mise`.

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

Each fork change is an ordinary commit on `main`. Keep them few and self-contained so rebases stay cheap, and keep fork-only files under `packaging/fork/` so they never collide with upstream paths.

To run a change before packaging it, use upstream's dev server with a separate data directory so it doesn't touch your real `~/.t3`:

```sh
mise x node@$(jq -r .engines.node package.json) pnpm@$(jq -r '.packageManager|sub("^pnpm@";"")' package.json) -- \
  sh -c 'pnpm install && pnpm dev --home-dir ~/.t3-dev'
```

The package build reads committed `main`, not your working tree, so commit before running `makepkg`.

## License

MIT, as upstream. See [LICENSE](./LICENSE). The devenv logo comes from [cachix/devenv](https://github.com/cachix/devenv) (Apache-2.0).
