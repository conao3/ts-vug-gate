{
  description = "vug merge-policy Worker";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixpkgs-unstable";
    flake-parts.url = "github:hercules-ci/flake-parts";
    treefmt-nix.url = "github:numtide/treefmt-nix";
    treefmt-nix.inputs.nixpkgs.follows = "nixpkgs";
  };

  outputs =
    inputs:
    inputs.flake-parts.lib.mkFlake { inherit inputs; } {
      systems = [
        "x86_64-linux"
        "aarch64-darwin"
      ];
      imports = [ inputs.treefmt-nix.flakeModule ];
      perSystem =
        { pkgs, ... }:
        let
          node = pkgs.nodejs_26;
          pnpm = pkgs.pnpm.override { nodejs-slim = pkgs.nodejs-slim_26; };
          vp = pkgs.writeShellApplication {
            name = "vp";
            runtimeInputs = [
              node
              pnpm
            ];
            text = ''
              if [ "''${1:-}" = install ]; then
                shift
                exec pnpm install "$@"
              fi
              exec node node_modules/vite-plus/bin/vp "$@"
            '';
          };
          src = pkgs.lib.cleanSource ./.;
        in
        {
          treefmt = {
            projectRootFile = "flake.nix";
            programs.nixfmt.enable = true;
          };
          devShells.default = pkgs.mkShell {
            packages = [
              node
              pnpm
              vp
              pkgs.python3
            ];
          };
          packages.default = pkgs.stdenv.mkDerivation (finalAttrs: {
            pname = "vug-gate";
            version = "0.1.0";
            inherit src pnpm;
            pnpmDeps = pkgs.fetchPnpmDeps {
              inherit (finalAttrs) pname version src;
              inherit pnpm;
              fetcherVersion = 5;
              hash = "sha256-P8pOkSL1gPwTjyT1Ao3j0udLjOKo+OYOI3vjaJ/XsA0=";
            };
            nativeBuildInputs = [
              node
              pnpm
              pkgs.pnpmConfigHook
              pkgs.makeWrapper
            ]
            ++ pkgs.lib.optionals pkgs.stdenv.hostPlatform.isLinux [
              pkgs.autoPatchelfHook
            ];
            buildInputs = pkgs.lib.optionals pkgs.stdenv.hostPlatform.isLinux [
              pkgs.stdenv.cc.cc.lib
              pkgs.zlib
            ];
            buildPhase = ''
              runHook preBuild
              pnpm exec wrangler deploy --dry-run --outdir dist
              runHook postBuild
            '';
            installPhase = ''
              runHook preInstall
              mkdir -p "$out/bin" "$out/lib/vug-gate"
              cp -R dist node_modules "$out/lib/vug-gate/"
              substitute wrangler.jsonc "$out/lib/vug-gate/wrangler.jsonc" \
                --replace-fail '"src/index.ts"' '"dist/index.js"'
              makeWrapper ${node}/bin/node "$out/bin/vug-gate" \
                --add-flags "$out/lib/vug-gate/node_modules/wrangler/bin/wrangler.js dev --config $out/lib/vug-gate/wrangler.jsonc"
              runHook postInstall
            '';
            meta.mainProgram = "vug-gate";
          });
        };
    };
}
