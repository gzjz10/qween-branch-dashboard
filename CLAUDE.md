# CLAUDE.md — Qween Branch Dashboard

## What this is

Arabic RTL single-file app (`index.html`) for a new branch: a **stocking dashboard**
plus a **supplier-order system** («لمسات — نظام أوردرات الموردين»), merged into one
zero-dependency file. Named top-level tabs: نظرة عامة، الموردون، الأوردرات،
متابعة الموردين، التقارير، الإعدادات، then one tab per category (21 «قطاعي»
categories). Originally converted from the Excel workbook
`داشبورد_متابعة_تجهيز_الفرع_بالمجموعات_الفرعية.xlsx`; `data.json` is the faithful v1
extraction (18 categories) embedded verbatim as `const DATA` and migrated at load
into the 21-category v2 structure (`DEFAULT_CATEGORIES`, from the richer app).
`index2.txt` is the read-only source the order/supplier features were ported from.

Deployed via GitHub Pages: https://gzjz10.github.io/qween-branch-dashboard/

## Architecture (v2)

- **State** is an object `{version:2, categories[], suppliers[], orders[]}` (v1 was a
  bare category array). `categories[]` rows carry **stable ids** (`catId-NNN`) — these
  are the identity that orders reference, so a row rename/reorder never mis-resolves an
  order. `suppliers[]` link to grid columns **by name**; `orders[]` items hold
  per-row `subAllocations{rowId:{qty,note}}` and a `posted` ledger.
- **Grid is the single source of truth for registered quantities.** An order is a plan;
  when its status becomes «تم التسليم» its quantities post into `row.vals` (recorded in
  `order.posted.cells`) and reverse **exactly** when it leaves delivered. Double-posting
  is impossible; posted orders are locked from editing. Never make orders the truth for
  the grid — the instant cell-edit path must stay direct and Excel-faithful.
- Order math uses the same Excel rule as the grid (`deficit = max(target−alloc, 0)`,
  never a signed sum). Migration fabricates **zero** orders, so the branch invariants
  below hold by construction.
- **Offline replacements** (no CDNs): SVG donut (`donutSVGgeneric`) + CSS bars instead
  of Chart.js; `window.print()` + a dedicated `#printArea` + `@media print` instead of
  jsPDF; JSON/CSV instead of xlsx (xlsx import was dropped); emoji/inline-SVG icons
  instead of FontAwesome; the system Arabic font stack instead of a webfont.
- Regression harness: **`tests/check.mjs`** runs the extracted `<script>` in `node:vm`
  with DOM stubs and asserts migration, invariants, posting, escaping, exports. Keep it
  green (`node tests/check.mjs`) — it is the fastest way to catch a break.

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
- **Persistence contract**: localStorage key `qween-dashboard-v2` (envelope
  `{savedAt, data}`). Load order is v2 key → v1 key (`qween-dashboard-v1`, migrated in)
  → embedded `DATA`. **Never write or delete the v1 key** (rollback safety), and never
  persist before `validDataV2` passes (`sanitizeV2` drops orphan refs / coerces unknown
  status first). Bump the key version again for any further shape change and migrate.
- **All dynamic HTML goes through `esc()`** (escapes & < > " '); no inline
  `onclick`/`onchange` with interpolated data — use delegated `data-action`/`data-id`.
- CSV export must keep the UTF-8 BOM (`﻿`) or Arabic breaks in Excel.
- Mobile: ≤768px switches subgroup tables to expandable cards; supplier/order cards
  stack; modals become full-screen sheets; no body horizontal scroll at 360px; tap
  targets ≥44px; inputs ≥16px font (iOS zoom).

## Editing data vs code

- The embedded v1 `const DATA` (line ~322, one 62KB line — never reformat it) plus
  `DEFAULT_CATEGORIES` (the 21-category / 709-subgroup skeleton, also a long single
  line) are both huge. Navigate with `grep -n` + offset reads; never paste their full
  content or let a tool reflow them.
- To refresh source data from a new Excel export: re-run the extraction (see SPEC.md),
  replace `data.json`, splice it into `const DATA`. Migration then reshapes it into 21
  categories at load. Sanity: v1 = 18 categories / 386 rows; المنظفات → target 950,
  registered 1757 → over-target.
- Placeholder supplier columns (`اسم الشركة N` / empty) are hidden in the UI but their
  data slots must be preserved; the posting engine fills placeholders before appending
  new columns.

## Verify after changes

1. `node --check` on the extracted `<script>`, then `node tests/check.mjs` (must report
   all-passed).
2. Open in Chrome (`file://`): overview totals **1,000 / 1,877 / عجز 374 / تجاوز +202**;
   المنظفات violet over-target; DevTools Network shows the document only (no external
   requests).
3. Edit a cell → totals recompute live and «آخر حفظ» updates; reload → persisted to the
   v2 key (v1 key untouched).
4. Create a supplier → order (wizard) → mark «تم التسليم» → grid rises by exactly the
   allocation; revert status → grid returns exactly. Tracking + reports reflect it.
5. Narrow to 360–390px: cards appear on every screen, no sideways body scroll.
6. Export the 3 CSVs → open in Excel with correct Arabic (BOM preserved).
7. XSS probe: a supplier/note/row name of `<img src=x onerror=alert(1)>` renders inert
   everywhere.

## Deploy

Push to `main`; GitHub Pages serves the repo root. No build step.
