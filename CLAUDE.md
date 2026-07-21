# CLAUDE.md — Qween Branch Dashboard

## What this is

Arabic RTL single-file dashboard (`index.html`) for tracking new-branch stocking
across 18 departments × subgroups × suppliers. Originally converted from the Excel
workbook `داشبورد_متابعة_تجهيز_الفرع_بالمجموعات_الفرعية.xlsx`; `data.json` is the
faithful extraction of that workbook and is embedded verbatim inside `index.html`
as `const DATA`.

Deployed via GitHub Pages: https://gzjz10.github.io/qween-branch-dashboard/

## Hard rules

- **Single file, zero dependencies.** `index.html` must keep working when opened
  from `file://` with no network: no CDNs, fonts, libraries, or external requests.
- **Formulas must match the source Excel exactly** (SPEC.md is authoritative):
  - `registered = sum(vals)`; `deficit = max(target - registered, 0)`
  - `pct = target === 0 ? 0 : min(registered/target, 1)`
  - status: blank when target=0; else ≥0.9 مكتمل, ≥0.6 تحت التنفيذ, ≥0.3 يحتاج متابعة, else لم يبدأ
  - over-target badge «تجاوز المستهدف +N» only when `registered > target && target > 0` (violet, distinct from the green مكتمل)
- **RTL first.** `dir="rtl" lang="ar"`; use logical CSS properties
  (`inset-inline-end`, `padding-inline-*`); sticky table columns pin to the RIGHT.
  Western digits via `toLocaleString('en-US')`; dates day-first
  (`ar` locale + `numberingSystem:"latn"`).
- **Persistence contract**: localStorage key `qween-dashboard-v1`. If you change
  the state shape, bump the key version and migrate or fall back to embedded DATA.
  Never persist state before it passes `validData` (an earlier bug persisted
  broken imports and bricked the app on reload).
- CSV export must keep the UTF-8 BOM or Arabic breaks in Excel.
- Mobile: ≤768px switches subgroup tables to expandable cards; no body horizontal
  scroll at 360px; tap targets ≥44px; inputs ≥16px font (iOS zoom).

## Editing data vs code

- To refresh data from a new Excel export: re-run the extraction (see SPEC.md data
  model), replace `data.json`, and splice its contents into the `const DATA = [...]`
  block in `index.html`. Sanity: 18 categories, 386 rows (المنظفات totals: target
  950, registered 1757 → must show over-target).
- Placeholder supplier columns (`اسم الشركة N` / empty) are hidden in the UI but
  their data slots must be preserved.

## Verify after changes

1. `node --check` on the extracted `<script>` (or just open and watch the console).
2. Open in Chrome: overview totals unchanged (branch 1,000 / 1,877 / عجز 374 / تجاوز +202).
3. Edit a cell → totals recompute live and «آخر حفظ» updates; reload → persisted.
4. Narrow to 390px: cards appear, no sideways scroll.
5. Export CSV → opens in Excel with correct Arabic.

## Deploy

Push to `main`; GitHub Pages serves the repo root. No build step.
