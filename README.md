# Hookline

Bowling-Tracking als installierbare Web-App (PWA) für Handy und Tablet, ohne Abhängigkeiten und ohne Build-Schritt.
Die App erkennt Laufweg, Tempo, Bretter (Foul-Linie, Punkte, Pfeile, Breakpoint, Pins), Einlauf- und Abwurfwinkel,
Hook, Pocket-Treffer und die stehenden Pins. Sie führt den Punktezettel und zeigt Replays ohne Video (Draufsicht
und nachgebaute Kamerasicht). Alles bleibt auf dem Gerät (IndexedDB), Export/Import als JSON.

Wie Bahn-, Kugel- und Pin-Erkennung funktionieren, erklärt die [Technik-Seite](https://hooklineapp.github.io/hookline/technik.html) mit Diagrammen und Bildern.

## Bedienung
1. **Ecken**: Das Bild friert ein. Tippe die 4 Bahnecken: Foul-Linie links, rechts, dann Kopfpin-Höhe links, rechts
   (in den Optionen auf „Bahnende“ umstellbar). Feinjustieren durch Ziehen, mit Lupe.
2. **Kugel** (optional, verbessert die Erkennung): Bild friert ein, auf die Kugel tippen. Die Farbe wird je Spieler gespeichert.
3. Werfen. Die App erkennt den Wurf selbst, misst nach dem Einschlag die Pins und speichert den Wurf.
   Die Pins lassen sich im Wurf korrigieren (antippen).

Filmen aus der Hand geht: Die Bahn wird in jedem Bild nachgeführt (eigener pyramidaler Lucas-Kanade + RANSAC-Homografie).
Am besten leicht hinter dem Spieler stehen, auch seitlich zwischen zwei Bahnen. Die Pins sollten im Bild sein.

## Nutzen
Einfach die Seite im Handy-Browser öffnen (HTTPS nötig, z. B. GitHub Pages) und über das Browser-Menü
„Zum Startbildschirm hinzufügen“ bzw. „App installieren“ wählen. Danach läuft Hookline wie eine App, auch offline.
Alle Daten bleiben auf dem Gerät.

## Tipps für gute Aufnahmen
- Stehend filmen, Handy etwa auf Augenhöhe, 1–3 m hinter dem Anlauf, leicht seitlich ist ok.
- Die ganze Bahn bis zu den Pins muss im Bild sein; Zoom während des Wurfs vermeiden.
- Möglichst die eigene Bahn mittig, nicht weit von der Seite.
- Höhere Analysebreite (Optionen) verbessert Werte am fernen Bahnende.
