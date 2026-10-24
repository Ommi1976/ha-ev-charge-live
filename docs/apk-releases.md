# Vorschlag: APKs über GitHub Releases statt im Git-Repo

Status: **Vorschlag** – außer Schritt 1 ist noch nichts umgesetzt. Die Historie bleibt unangetastet, es gibt keinen Force-Push.

## Ausgangslage (Stand v1.3.18)

- Im Repo-Root liegen 21 APKs (`ev-charge-live-v*.apk`, je ~5 MB, zusammen ~100 MB).
  In der Historie stecken 24 APK-Blobs mit ~114 MB. Jede neue Version legt ~5 MB dazu,
  die nie wieder verschwinden, weil APKs als ZIP-Dateien kaum Deltas bilden.
- Auf GitHub gibt es die Tags `v1.3.9` bis `v1.3.17`, aber noch keine Releases. `v1.3.18` hat noch keinen Tag.
- Weder die App (`app.js`) noch das README verlinken APK-Dateien im Repo. Ein Umzug macht also nichts kaputt.

## Ziel

Git enthält nur noch Quellcode. Jede APK hängt als Asset an einem GitHub Release `v<version>`.
Der feste Download-Link lautet dann <https://github.com/Ommi1976/ha-ev-charge-live/releases/latest>.

## Schritt 1: Neue APKs nicht mehr committen (umgesetzt)

`npm run apk` schreibt nach `dist/ev-charge-live-v<version>.apk`, und `dist/` steht in `.gitignore`.

## Schritt 2: Pro Version ein Release (lokal, mit `gh`)

```bash
npm run bump 1.3.19
npm run apk
git commit -am "release: v1.3.19"
git tag v1.3.19
git push origin master v1.3.19
gh release create v1.3.19 dist/ev-charge-live-v1.3.19.apk --title "v1.3.19" --generate-notes
```

**Warum lokal bauen und nicht in GitHub Actions?** Debug-APKs werden mit dem Debug-Keystore des
Rechners signiert (`~/.android/debug.keystore`). Eine APK aus einem CI-Runner hätte eine andere Signatur.
Android lehnt dann das Update über die installierte App ab („App nicht installiert“), und man müsste
deinstallieren, wobei die lokalen App-Daten verloren gehen. Ein CI-Build lohnt sich erst mit einem eigenen
Release-Keystore (siehe „Später“).

## Schritt 3: Vorhandene APKs einmalig als Releases nachtragen

Fehlt der Tag, legt `gh` ihn auf dem Commit an, mit dem die APK ins Repo kam.
Die alten Releases werden nicht als „latest“ markiert, erst am Ende die neueste Version:

```bash
for apk in ev-charge-live-v*.apk; do
  v="${apk#ev-charge-live-v}"; v="${v%.apk}"
  commit="$(git log --diff-filter=A --format=%H -1 -- "$apk")"
  gh release create "v$v" "$apk" --title "v$v" --target "$commit" --latest=false \
    --notes "APK aus dem Repo-Archiv übernommen."
done
gh release edit v1.3.18 --latest
```

Hinweis: Die APKs bis v1.3.6 kamen gemeinsam in Commit `c9306e2`. Ihre neuen Tags zeigen deshalb alle
auf diesen Commit und nicht auf den Quellstand der jeweiligen Version. Für ein reines Download-Archiv reicht das.

## Schritt 4: APKs aus dem aktuellen Stand entfernen (normaler Commit)

Erst ausführen, wenn Schritt 3 vollständig auf GitHub sichtbar ist:

```bash
git rm --cached ev-charge-live-v*.apk
printf '/ev-charge-live-v*.apk\n' >> .gitignore
git commit -m "chore: APKs nach GitHub Releases verschoben"
```

Danach haben Checkouts und Worktrees ~100 MB weniger Dateien. Die Historie enthält die Blobs weiterhin,
deshalb wird ein `git clone` nicht kleiner. GitHub meldet für das Repo derzeit ~25 MB Speicherbedarf.
In der README sollte bei der App-Installation der Releases-Link stehen.

## Bewusst nicht vorgeschlagen: Historie umschreiben

`git filter-repo --path-glob '*.apk' --invert-paths` mit anschließendem Force-Push würde auch den Clone verkleinern.
Dabei ändern sich aber alle Commit-SHAs, Tags müssen neu gesetzt werden, und bestehende Clones, Worktrees und
offene Branches passen nicht mehr. Das lohnt sich nur, wenn die Clone-Größe wirklich stört, und braucht
eine eigene Entscheidung.

## Später (optional): APK in GitHub Actions bauen und anhängen

Ein Workflow, der bei einem Tag-Push `v*` startet: `actions/setup-java` (JDK 17) → `npm ci` → `npm run apk`
→ `gh release upload "$GITHUB_REF_NAME" dist/*.apk`. Voraussetzung ist ein Release-Keystore als
GitHub-Secret, dazu eine `signingConfigs.release` in `android/app/build.gradle` und `assembleRelease` statt
`assembleDebug`. Beim Umstieg muss die App einmalig neu installiert werden, weil sich die Signatur ändert.
