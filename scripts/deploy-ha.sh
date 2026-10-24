#!/usr/bin/env bash
# Deployt das Add-on per SSH nach /addons/ha-ev-charge-live auf Home Assistant OS (für Git Bash).
#
#   scripts/deploy-ha.sh --dry-run   zeigt nur, was passieren würde (kein Kontakt zu HA)
#   scripts/deploy-ha.sh             sichert den alten Ordner lokal und überträgt die neuen Dateien
#
# Überschreibbar per Umgebungsvariable: HA_SSH_TARGET, HA_SSH_KEY, HA_ADDON_DIR, BACKUP_DIR.
# Das Store-Reload und das Add-on-Update macht das Skript bewusst nicht (der SSH-Benutzer hat kein sudo).
set -euo pipefail

HA_SSH_TARGET="${HA_SSH_TARGET:-homeassistant@192.168.178.77}"
HA_SSH_KEY="${HA_SSH_KEY:-$HOME/.ssh/haos_codex_deploy}"
HA_ADDON_DIR="${HA_ADDON_DIR:-/addons/ha-ev-charge-live}"
ADDON_SLUG="local_ev_charge_live"
FILES=(config.yaml Dockerfile build.yaml run.sh requirements.txt README.md app)

usage() {
  sed -n '2,8p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
}

die() {
  echo "FEHLER: $*" >&2
  exit 1
}

DRY_RUN=0
for arg in "$@"; do
  case "$arg" in
    -n|--dry-run) DRY_RUN=1 ;;
    -h|--help) usage; exit 0 ;;
    *) usage >&2; die "unbekannte Option: $arg" ;;
  esac
done

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

# Backups liegen neben dem Haupt-Checkout – auch wenn aus einem git-Worktree deployt wird.
if [[ -z "${BACKUP_DIR:-}" ]]; then
  main_root="$(cd "$(git rev-parse --git-common-dir 2>/dev/null)/.." 2>/dev/null && pwd)" || main_root="$REPO_ROOT"
  BACKUP_DIR="$(dirname "$main_root")/ha-ev-charge-live-backups"
fi

config_version() {
  tr -d '\r' | sed -n 's/^version:[[:space:]]*"\(.*\)".*/\1/p'
}

VERSION="$(config_version < config.yaml)"
[[ -n "$VERSION" ]] || die "keine Version in config.yaml gefunden"

for f in "${FILES[@]}"; do
  [[ -e "$f" ]] || die "$f fehlt im Repo"
done

if command -v node >/dev/null 2>&1; then
  node scripts/build-www.js --check || die "Versionsprüfung fehlgeschlagen – erst 'npm run bump <version>' / 'npm run build:www'."
else
  echo "Hinweis: node nicht gefunden, Versionsprüfung übersprungen."
fi

ARCHIVE="$(mktemp -t ev-charge-deploy.XXXXXX)"
trap 'rm -f "$ARCHIVE"' EXIT
tar -cf "$ARCHIVE" --exclude='__pycache__' --exclude='*.pyc' "${FILES[@]}"

STAMP="$(date +%Y%m%d-%H%M%S)"
backup_file() {
  echo "$BACKUP_DIR/ha-ev-charge-live-addon-$1-$STAMP.tgz"
}
SSH=(ssh -i "$HA_SSH_KEY" -o BatchMode=yes -o ConnectTimeout=10 "$HA_SSH_TARGET")

echo "Version:  $VERSION"
echo "Ziel:     $HA_SSH_TARGET:$HA_ADDON_DIR"
echo "Backups:  $BACKUP_DIR"
echo "Dateien:  $(tar -tf "$ARCHIVE" | grep -vc '/$') ($(du -h "$ARCHIVE" | cut -f1) unkomprimiert)"

if [[ $DRY_RUN -eq 1 ]]; then
  echo
  tar -tvf "$ARCHIVE"
  [[ -f "$HA_SSH_KEY" ]] || echo "WARNUNG: SSH-Key $HA_SSH_KEY existiert nicht."
  echo
  echo "Dry-Run – würde ausführen:"
  echo "  1. ${SSH[*]} \"tar -C $(dirname "$HA_ADDON_DIR") -cf - $(basename "$HA_ADDON_DIR")\" | gzip > $(backup_file '<alte-version>')"
  echo "  2. ${SSH[*]} \"mkdir -p $HA_ADDON_DIR && tar -xf - -C $HA_ADDON_DIR\" < <Archiv>"
  echo "Nichts übertragen."
  exit 0
fi

[[ -f "$HA_SSH_KEY" ]] || die "SSH-Key $HA_SSH_KEY existiert nicht"

# 1. Lokales Backup des alten Add-on-Ordners – ohne Backup wird nicht deployt.
if "${SSH[@]}" "test -d '$HA_ADDON_DIR'"; then
  OLD_VERSION="$("${SSH[@]}" "cat '$HA_ADDON_DIR/config.yaml'" 2>/dev/null | config_version)" || true
  BACKUP_FILE="$(backup_file "${OLD_VERSION:-unbekannt}")"
  mkdir -p "$BACKUP_DIR"
  if ! "${SSH[@]}" "tar -C '$(dirname "$HA_ADDON_DIR")' -cf - '$(basename "$HA_ADDON_DIR")'" | gzip -c > "$BACKUP_FILE" \
      || ! tar --force-local -tzf "$BACKUP_FILE" >/dev/null; then
    rm -f "$BACKUP_FILE"
    die "Backup fehlgeschlagen – nichts deployt."
  fi
  echo "Backup angelegt: $BACKUP_FILE ($(du -h "$BACKUP_FILE" | cut -f1))"
else
  echo "$HA_ADDON_DIR existiert noch nicht – kein Backup nötig."
fi

# 2. Neue Dateien übertragen (überschreibt, löscht nichts).
"${SSH[@]}" "mkdir -p '$HA_ADDON_DIR' && tar -xf - -C '$HA_ADDON_DIR'" < "$ARCHIVE"
DEPLOYED="$("${SSH[@]}" "cat '$HA_ADDON_DIR/config.yaml'" | config_version)"
[[ "$DEPLOYED" == "$VERSION" ]] || die "auf HA steht jetzt Version '$DEPLOYED' statt '$VERSION'"
echo "Deployt: v$DEPLOYED nach $HA_SSH_TARGET:$HA_ADDON_DIR"

# Dateien auf HA, die nicht (mehr) zum Deploy gehören, bleiben liegen – nur melden.
STALE="$(comm -23 \
  <("${SSH[@]}" "cd '$HA_ADDON_DIR' && find . -type f ! -path '*/__pycache__/*'" | tr -d '\r' | sed 's|^\./||' | sort) \
  <(tar -tf "$ARCHIVE" | grep -v '/$' | sort))"
if [[ -n "$STALE" ]]; then
  echo "Hinweis: diese Dateien auf HA gehören nicht zum Deploy (nicht gelöscht, ggf. veraltet):"
  echo "$STALE" | sed 's/^/  /'
fi

echo
echo "Jetzt noch in Home Assistant (per UI oder HA-Tool):"
echo "  1. Add-on-Store neu laden (Einstellungen → Add-ons → Add-on-Store → ⋮ → Nach Updates suchen)"
echo "  2. Add-on '$ADDON_SLUG' auf v$VERSION aktualisieren"
