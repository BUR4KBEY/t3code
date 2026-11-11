# The T3 Code server (`t3`) from this checkout, for NixOS hosts. It has no
# web UI or desktop app; clients connect over the network. After a change to
# pnpm-lock.yaml, run ./update-hash.sh to refresh the pnpmDeps hash.
{
  lib,
  stdenv,
  src,
  nodejs_24,
  pnpm_12,
  fetchPnpmDeps,
  pnpmConfigHook,
  makeWrapper,
  python3,
}:
stdenv.mkDerivation (finalAttrs: {
  pname = "t3-server";
  version = (lib.importJSON "${src}/apps/server/package.json").version;
  inherit src;

  # `t3...` is the server package plus the workspace packages it depends on.
  pnpmWorkspaces = ["t3..."];
  pnpmDeps = fetchPnpmDeps {
    inherit (finalAttrs) pname version src pnpmWorkspaces;
    pnpm = pnpm_12;
    fetcherVersion = 4;
    hash = "sha256-JLj+BvyuKKldcK5Ds2RTfEcnR2vZ75EXNjcTK3YnnQo=";
  };

  nativeBuildInputs = [
    nodejs_24
    pnpm_12
    pnpmConfigHook
    makeWrapper
    python3
  ];

  env.CI = "1";

  buildPhase = ''
    runHook preBuild
    pnpm --filter t3 run build:bundle
    runHook postBuild
  '';

  installPhase = ''
    runHook preInstall
    pnpm --filter t3 deploy --prod --offline "$out/lib/t3"
    makeWrapper ${lib.getExe nodejs_24} "$out/bin/t3" \
      --add-flags "$out/lib/t3/dist/bin.mjs"
    runHook postInstall
  '';

  meta = {
    description = "T3 Code server, built from the BUR4KBEY fork";
    homepage = "https://github.com/BUR4KBEY/t3code";
    license = lib.licenses.mit;
    mainProgram = "t3";
    platforms = lib.platforms.linux;
  };
})
