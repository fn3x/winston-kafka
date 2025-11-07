{
  inputs = {
    nixpkgs.url = "github:nixos/nixpkgs?ref=nixos-unstable";
  };

  outputs =
    { self, nixpkgs }:
    let
      pkgs = nixpkgs.legacyPackages.x86_64-linux;
      NPM_CONFIG_PREFIX = "~/npm";
    in
    {
      devShells.x86_64-linux.default = pkgs.mkShell {
        packages = with pkgs; [
          nodejs
        ];

        shellHook = ''
          export PATH="${NPM_CONFIG_PREFIX}/bin:$PATH"
          npm install
        '';
      };
    };
}
