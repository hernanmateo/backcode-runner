#!/bin/sh
# Backcode runner: instala el ejecutable (sin Node) en ~/.backcode/bin y abre el panel.
#   curl -fsSL https://raw.githubusercontent.com/hernanmateo/backcode-runner/main/install.sh | sh
# Variables: BACKCODE_VERSION=1.2.3 (por defecto, la última) · BACKCODE_NO_OPEN=1 (no abrir el panel al terminar)
set -eu

REPO="hernanmateo/backcode-runner"
HOME_DIR="${BACKCODE_HOME:-$HOME/.backcode}"
BIN_DIR="$HOME_DIR/bin"
BIN="$BIN_DIR/backcode"

bold() { printf '\033[1m%s\033[0m\n' "$1"; }
fail() { printf '\033[31m✗ %s\033[0m\n' "$1" >&2; exit 1; }

case "$(uname -s)" in
  Darwin) os=darwin ;;
  Linux) os=linux ;;
  *) fail "Backcode runner works on macOS and Linux only." ;;
esac
case "$(uname -m)" in
  arm64 | aarch64) arch=arm64 ;;
  x86_64 | amd64) arch=x64 ;;
  *) fail "Unsupported CPU: $(uname -m)" ;;
esac
# Un Mac con Apple Silicon ejecutando una terminal con Rosetta dice x86_64: mejor el nativo.
if [ "$os" = darwin ] && [ "$arch" = x64 ] && [ "$(sysctl -n sysctl.proc_translated 2>/dev/null || echo 0)" = 1 ]; then arch=arm64; fi

asset="backcode-$os-$arch"
if [ -n "${BACKCODE_VERSION:-}" ]; then
  base="https://github.com/$REPO/releases/download/v${BACKCODE_VERSION#v}"
else
  base="https://github.com/$REPO/releases/latest/download"
fi

base="${BACKCODE_DOWNLOAD_BASE:-$base}"  # solo para probar el instalador sin GitHub
bold "Backcode runner · $os/$arch"
command -v curl >/dev/null 2>&1 || fail "curl is required."
mkdir -p "$BIN_DIR"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT INT TERM

printf '  · Downloading %s…\n' "$asset"
curl -fSL --progress-bar "$base/$asset" -o "$tmp/$asset" || fail "Download failed: $base/$asset"
curl -fsSL "$base/SHA256SUMS" -o "$tmp/SHA256SUMS" || fail "Download failed: $base/SHA256SUMS"

expected="$(grep " $asset\$" "$tmp/SHA256SUMS" | cut -d' ' -f1)"
if command -v shasum >/dev/null 2>&1; then actual="$(shasum -a 256 "$tmp/$asset" | cut -d' ' -f1)"; else actual="$(sha256sum "$tmp/$asset" | cut -d' ' -f1)"; fi
[ -n "$expected" ] && [ "$expected" = "$actual" ] || fail "Checksum mismatch: the download is incomplete or was tampered with."
printf '  · Checksum OK\n'

chmod 755 "$tmp/$asset"
# Descargado con curl no lleva cuarentena, pero por si acaso (p. ej. copiado desde el navegador).
[ "$os" = darwin ] && xattr -d com.apple.quarantine "$tmp/$asset" 2>/dev/null || true
"$tmp/$asset" --version >/dev/null 2>&1 || fail "The downloaded runner doesn't start on this computer."
mv -f "$tmp/$asset" "$BIN"
printf '  · Installed %s (v%s)\n' "$BIN" "$("$BIN" --version)"

# `backcode` en el PATH para las próximas veces (una línea en el perfil de tu shell; nada más se toca).
case ":$PATH:" in
  *":$BIN_DIR:"*) ;;
  *)
    line="export PATH=\"$BIN_DIR:\$PATH\""
    case "${SHELL:-}" in
      */zsh) rc="$HOME/.zshrc" ;;
      */bash) if [ "$os" = darwin ]; then rc="$HOME/.bash_profile"; else rc="$HOME/.bashrc"; fi ;;
      */fish) rc="" ; mkdir -p "$HOME/.config/fish/conf.d" && printf 'fish_add_path %s\n' "$BIN_DIR" > "$HOME/.config/fish/conf.d/backcode.fish" ;;
      *) rc="$HOME/.profile" ;;
    esac
    if [ -n "$rc" ] && ! grep -qs "$BIN_DIR" "$rc"; then
      printf '\n# Backcode runner\n%s\n' "$line" >> "$rc"
      printf '  · Added %s to your PATH in %s (new terminals)\n' "$BIN_DIR" "$rc"
    fi
    ;;
esac

echo
bold "✓ Ready. Next time, just run: backcode"
if [ -z "${BACKCODE_NO_OPEN:-}" ]; then
  echo
  # El panel se queda en esta terminal hasta que actives «Arrancar al iniciar sesión» en él.
  exec "$BIN" </dev/null
fi
