{
  description = "T3 Code server (BUR4KBEY fork)";

  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";

  outputs = {
    self,
    nixpkgs,
  }: let
    forAllSystems = nixpkgs.lib.genAttrs ["x86_64-linux" "aarch64-linux"];
  in {
    packages = forAllSystems (system: rec {
      t3-server = nixpkgs.legacyPackages.${system}.callPackage ./packaging/nix/t3-server.nix {
        src = self;
      };
      default = t3-server;
    });
  };
}
