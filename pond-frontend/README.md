# pond-frontend

Interactive web UI for the pond ecosystem simulation. A React app that runs the C++ engine compiled to WebAssembly, visualises population dynamics with Recharts, and loads scenarios and species metadata from a Drupal JSON:API backend.

## Architecture

The frontend does not reimplement ecology — it drives the WASM module built from [pond-sim](../pond-sim) and renders the returned state over time.

1. **WASM engine** — `PondSim` is stepped each frame via Emscripten bindings.
2. **Scenario config** — Parameters and run duration are fetched from the API and applied with `setParam`.
3. **Live charts** — Algae, invertebrates, nutrients, and water volume are plotted as the simulation runs.



## Project structure

```
pond-frontend/
├── public/
│   ├── pond.wasm          # WASM binary (copied from pond-sim after build)
│   └── frog.jpg
├── src/
│   ├── main.tsx           # App entry point
│   ├── PondSim.tsx        # Simulation UI, animation loop, charts
│   ├── api.ts             # JSON:API client (scenarios, species)
│   ├── pond.d.ts          # TypeScript declarations for WASM module
│   ├── pond.css           # Component styles
│   └── wasm/
│       ├── loadPond.ts    # Async WASM loader
│       └── pond.js        # Emscripten glue (copied from pond-sim after build)
├── index.html
└── vite.config.ts
```



## Getting started

**Prerequisites:** Node.js, a built WASM bundle from pond-sim

```bash
npm install
npm run dev
```

After rebuilding the C++ WASM target, copy `pond.js` and `pond.wasm` from `pond-sim/pondSimulator/src/` into both `public/` and `src/wasm/`.

## Scripts


| Command           | Description                     |
| ----------------- | ------------------------------- |
| `npm run dev`     | Start Vite dev server           |
| `npm run build`   | Type-check and production build |
| `npm run preview` | Preview production build        |
| `npm run lint`    | Run ESLint                      |




## API

Scenario and species data are loaded from a Drupal JSON:API endpoint configured in `src/api.ts`. Each scenario provides a parameter map and run metadata that the UI applies before starting a simulation.