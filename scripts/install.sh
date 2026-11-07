#!/bin/sh
# Installs the batrak CLI: curl -fsSL https://github.com/Symblight/batrak/releases/latest/download/install.sh | sh
# BATRAK_RELEASE_URL replaces the download's base URL, for testing only.

# Everything is in functions called from the last line, so a truncated download runs nothing.

fail() {
  echo "batrak install: $1" >&2
  exit 1
}

detect_target() {
  os=$(uname -s)
  arch=$(uname -m)
  case "$arch" in
    arm64 | aarch64) arch=aarch64 ;;
    x86_64 | amd64) arch=x86_64 ;;
    *) fail "unsupported architecture: $arch (batrak has builds for x86_64 and aarch64)" ;;
  esac
  case "$os" in
    Darwin) echo "$arch-apple-darwin" ;;
    Linux) echo "$arch-unknown-linux-gnu" ;;
    MINGW* | MSYS* | CYGWIN*) fail "on Windows, use install.ps1 in PowerShell" ;;
    *) fail "unsupported operating system: $os (batrak has builds for macOS, Linux and Windows)" ;;
  esac
}

main() {
  set -u
  target=$(detect_target) || exit 1
  command -v curl >/dev/null 2>&1 || fail "curl is required"
  [ -n "${HOME:-}" ] || fail "HOME is not set"

  base=${BATRAK_RELEASE_URL:-https://github.com/Symblight/batrak/releases/latest/download}
  url="$base/batrak-$target"
  dir="$HOME/.local/bin"

  mkdir -p "$dir" || fail "can't create $dir"
  # In the install folder, so the final move is a rename on one filesystem.
  tmp=$(mktemp "$dir/.batrak-install.XXXXXX") || fail "can't write to $dir"
  trap 'rm -f "$tmp"' EXIT
  # A signal alone doesn't run the EXIT trap in every sh.
  trap 'exit 130' INT
  trap 'exit 143' HUP TERM

  echo "Downloading $url"
  # The base URL's scheme only (https unless overridden), redirects included.
  curl --proto "=${base%%:*}" -fsSL -o "$tmp" "$url" || fail "couldn't download $url"
  chmod 755 "$tmp" || fail "can't make $tmp executable"
  version=$("$tmp" --version 2>&1) || fail "the downloaded binary doesn't run on this machine: $version"

  mv -f "$tmp" "$dir/batrak" || fail "can't write $dir/batrak"
  printf '{ "installer": "script" }\n' >"$dir/batrak.install.json" || fail "can't write $dir/batrak.install.json"

  echo "Installed $version to $dir/batrak"
  case ":${PATH:-}:" in
    *":$dir:"*) ;;
    *)
      echo "$dir isn't on your PATH. Add it to your shell's profile:"
      echo "  export PATH=\"$dir:\$PATH\""
      ;;
  esac
}

main "$@"
