# SPEC — لوحة متابعة تجهيز الفرع (قوين / Qween)

Single self-contained `index.html` (Arabic, RTL, **zero external dependencies** — no CDN,
no fonts fetched, no libraries). All data embedded inline as `const DATA = [...]`
(the exact contents of `data.json` in this directory). Must work opened as a
local `file://` page and on both mobile (≥360px) and laptop.

## Data model (data.json)

Array of 18 categories:

```json
{
  "name": "المنظفات",                    // category (sheet) name
  "info": {
    "status": "",                        // حالة القسم: مكتمل|تحت التنفيذ|يحتاج متابعة|لم يبدأ|""
    "payStatus": "",                     // حالة السداد: تم السداد|لم يتم السداد|جزئي|لا ينطبق|""
    "account": "",                       // فتح الحساب: مكتمل|جاري|لم يبدأ|لا ينطبق|""
    "invoices": 0,                       // قيمة الفواتير (SAR)
    "paid": 0                            // مبلغ السداد (SAR)
  },
  "suppliers": ["مصنع الجودة", "...", ""],  // 15 supplier column names; placeholders "اسم الشركة N" or "" = unused
  "rows": [
    { "code": "001",                     // may be "" (المنظفات sheet has no codes)
      "name": "سائل يدين",               // subgroup name
      "target": 200,                     // المستهدف للافتتاح (0 = no target set)
      "vals": [0,0,40, ...],             // 15 quantities, aligned with suppliers[]
      "note": "" }
  ]
}
```

## Computed values (must exactly match the Excel formulas)

- `registered = sum(vals)`  (إجمالي المسجل)
- `deficit = max(target - registered, 0)`  (العجز)
- `pct = target === 0 ? 0 : min(registered/target, 1)`  (نسبة الإنجاز, cap 100%)
- `status`: if `target === 0` → blank; else pct ≥ 0.9 → "مكتمل"; ≥ 0.6 → "تحت التنفيذ";
  ≥ 0.3 → "يحتاج متابعة"; else "لم يبدأ".
- **NEW over-target rule (the key added feature):** if `registered > target && target > 0`
  → show badge **«تجاوز المستهدف +N»** where `N = registered - target`, with a distinct
  color (e.g. violet/blue — NOT the same green as مكتمل), on subgroup rows, category
  cards, and the overview KPIs (branch-level excess = sum of per-row excess).
  Progress bars cap at 100% but show an overflow marker/segment for the excess.

Category totals = sums over its rows; branch totals = sums over all categories.
Overall pct uses the same formula (uncapped display optional but keep the Excel value
`min(...,1)` for the % figure; show excess separately).

## Status colors

- مكتمل = green, تحت التنفيذ = amber/yellow, يحتاج متابعة = orange, لم يبدأ = red/gray,
  تجاوز المستهدف = violet. Accessible contrast, works in light theme (single polished
  light theme is fine; dark optional).

## Screens / UI (SPA, tab or view switching, RTL `dir="rtl" lang="ar"`)

1. **نظرة عامة (Overview)**
   - KPI cards: إجمالي مستهدف الفرع, إجمالي المسجل, إجمالي العجز, نسبة إنجاز الفرع,
     إجمالي التجاوز (new), قيمة الفواتير & المسددة (sums of info.invoices/info.paid).
   - Category list: each category as card (mobile) / table row (laptop) with target,
     registered, deficit, %, progress bar, status chip, over-target badge when relevant.
     Click → category view.
   - Donut or stacked bar of subgroup status distribution (pure CSS/SVG, no libs).
2. **Category view** (one per category, reachable via horizontally-scrollable sticky
   tab bar + back button)
   - Editable header fields: حالة القسم, حالة السداد, فتح الحساب (selects with the
     الإعدادات options above), قيمة الفواتير, مبلغ السداد (numeric inputs).
   - Subgroup table: code, name, target (editable), one column per **named** supplier
     (placeholder columns hidden but preserved in data), each cell an editable number,
     then registered/deficit/%/status/notes(editable). Desktop: sticky first column +
     horizontal scroll. Mobile: collapse to expandable cards per subgroup — summary
     line (name, progress, status) expands to supplier quantity inputs.
   - Row add: add subgroup; supplier add: rename a placeholder column (bonus, keep simple).
3. **Search & filter**: global search box (subgroup name), status filter chips
   (including تجاوز المستهدف), work in both views.

## Editing & persistence

- All edits recompute totals live.
- Persist full state to `localStorage` key `qween-dashboard-v1` on every change
  (debounced). On load: use saved state if present, else embedded DATA.
- Toolbar buttons: **تصدير JSON** (download full state), **استيراد JSON** (file input),
  **تصدير CSV** (one CSV per category zipped is NOT possible without libs — instead a
  single CSV with category column, UTF-8 BOM so Excel opens Arabic correctly),
  **إعادة التعيين** (confirm dialog → clear localStorage, restore embedded data).
- Show "آخر حفظ" timestamp.

## Design quality bar

Professional admin-dashboard look: system Arabic font stack
(`"Segoe UI", Tahoma, "Noto Kufi Arabic", "Geeza Pro", sans-serif`), 8px spacing grid,
subtle shadows, rounded 12px cards, one accent color (deep teal or indigo) + status
palette, western digits (0-9), thousands separators via `toLocaleString('en-US')`.
Sticky app header with title «لوحة متابعة تجهيز الفرع — قوين» and toolbar.
Tap targets ≥44px on mobile. No horizontal body scroll on 360px width (tables scroll
inside their own container).

## Non-goals

No backend, no build step, no frameworks, no external requests of any kind.
