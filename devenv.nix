{ pkgs, config, ... }:
{
  # Node is the exact version package.json's engines.node pins. pnpm_12 runs
  # the packageManager version itself, downloading it into PNPM_HOME.
  packages = [
    pkgs.nodejs_26
    pkgs.pnpm_12
    pkgs.jq
    pkgs.git
  ];

  # Keep pnpm's home, store, and cache inside this checkout instead of ~.
  env.PNPM_HOME = "${config.devenv.state}/pnpm";
  env.pnpm_config_store_dir = "${config.devenv.state}/pnpm-store";
  env.pnpm_config_cache_dir = "${config.devenv.state}/pnpm-cache";
  env.npm_config_cache = "${config.devenv.state}/npm-cache";

  enterTest = ''
    test "$(node --version)" = "v$(jq -r .engines.node package.json)"
  '';
}
