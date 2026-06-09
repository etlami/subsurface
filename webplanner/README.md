<!-- AI-generated (Claude) -->
# Subsurface Web-Tauchplaner

Eine Browser-App, in der man ein Tauchprofil **zeichnet** und live die echte
Subsurface-Dekoberechnung (Bühlmann ZH-L16C + Gradient Factors / VPM-B) erhält.
Der Rechenkern ist der unveränderte C++-Code aus `core/` (`planner.cpp`,
`deco.cpp`, `dive.cpp`, ...), per Emscripten nach WebAssembly kompiliert.

## Aufbau

```
webplanner/
  wasm/
    bridge.cpp        embind-Schnittstelle JS <-> plan()
    wasm_support.cpp  faithful Mini-Implementierungen + Link-Stubs
    qt-stubs/         Angle-Bracket-Stubs (QObject, QString, ...) statt Qt
    git-stubs/        git2.h Typ-Stub (statt libgit2)
    libdc-stubs/      libdivecomputer/version.h Stub
    build.sh          Build-Skript (Emscripten)
    validate.mjs      Validierung gegen tests/testplan.cpp (79 m / 30 min Tx)
    determinism.mjs   Determinismus-Probe
  public/             die fertige App + planner.js/.wasm
    index.html  app.js  profile-editor.js  style.css
```

## Voraussetzungen

- Emscripten (`emcc`), z. B. `brew install emscripten`
- `node` (für die Validierungs-Skripte)
- `libdivecomputer`-Submodul (nur die Header werden gebraucht):
  `git submodule update --init libdivecomputer`

## Bauen

```bash
bash webplanner/wasm/build.sh
```

Schreibt `webplanner/public/planner.js` + `planner.wasm` (Objektdateien landen in
`webplanner/build/`).

## Starten

```bash
cd webplanner/public && python3 -m http.server 8000
# Browser: http://localhost:8000
```

## Bedienung

- **Klick** auf die freie Fläche: neuen Wegpunkt setzen
- **Punkt ziehen**: Wegpunkt verschieben (Neuberechnung läuft live)
- **Doppelklick / Rechtsklick** auf einen Punkt: löschen
- Rechts: Algorithmus, Gase (O₂/He/Größe/Druck), SAC, Oberflächendruck,
  Salinität. Deko-Gase (Flaschen ab Index 1) werden automatisch an ihrer MOD
  zum Wechsel angeboten.

## Validierung

```bash
node webplanner/wasm/validate.mjs      # 79 m / 30 min Tx 15/45 -> ~108 min
node webplanner/wasm/determinism.mjs   # reproduzierbare Ergebnisse
```

Der Referenzfall entspricht `tests/testplan.cpp::testMetric` (erwartet ~109 min);
die WASM-Berechnung liefert 108 min und ist über Instanzen/Prozesse deterministisch.
