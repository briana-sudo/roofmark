# RoofMark

KCC field documentation, sequence builder, and shop drawing geometry tool.

- **Status:** Phase 1 build in progress (Field Markup mode)
- **Stack:** React + Konva (react-konva) + Zustand, built with Vite
- **Deploy:** GitHub Pages via GitHub Actions workflow on push to `main`
- **Live URL:** https://briana-sudo.github.io/roofmark/

## What this is

RoofMark lets a project manager load a field photo or PDF as a canvas
background, draw named color-coded component zones (layers) over it,
organize those layers into installation sequences, annotate each sequence
with callouts and dimension lines, and generate a bilingual (English /
Spanish) crew instruction PDF — one page per sequence. Phase 2 adds a
Technical Drawing mode for proportional shop-drawing geometry exported as
JSON for the locked `kcc-shop-drawing.py` template.

Full spec: see the RoofMark Kickoff Spec v1.0 in Notion.

## Local development

```sh
npm install
npm run dev
```

The dev server runs at http://localhost:5173/roofmark/ (the `/roofmark/`
prefix matches the GitHub Pages base path so dev and prod resolve assets
identically).

## Build

```sh
npm run build
npm run preview
```

`vite build` writes static output to `dist/`. The Pages deploy workflow
(`.github/workflows/pages.yml`) runs `npm ci && npm run build` on every
push to `main` and uploads `dist/` as a Pages artifact.

## Project structure

```
roofmark/
├── .github/workflows/pages.yml    # Pages deploy via GitHub Actions
├── public/                        # Static assets copied as-is
├── src/
│   ├── App.jsx                    # Layout shell
│   ├── App.css
│   ├── index.css
│   ├── main.jsx
│   └── store/
│       └── useAppStore.js         # Zustand app store
├── index.html
├── package.json
├── vite.config.js                 # base: '/roofmark/'
└── README.md
```
