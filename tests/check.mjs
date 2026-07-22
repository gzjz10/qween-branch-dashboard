/* ============================================================
   tests/check.mjs — node-only harness (no deps).
   Extracts the <script> from index.html, boots it inside node:vm
   with Proxy-based DOM stubs, then drives the pure data-core
   functions and asserts the Stage-1 migration invariants.
   Run: node tests/check.mjs   (exit 0 = all pass)
   ============================================================ */
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const html = readFileSync(join(root, "index.html"), "utf8");
const m = html.match(/<script>([\s\S]*?)<\/script>/);
if (!m) { console.error("FATAL: no <script> block found in index.html"); process.exit(1); }
const src = m[1];

/* ---------- universal Proxy stub: any property access / call /
   construction yields another stub; primitives coerce safely ---------- */
function makeStub(name) {
  const fn = function stub() {};
  return new Proxy(fn, {
    get(t, p) {
      if (p === Symbol.toPrimitive) return () => 0;
      if (p === Symbol.iterator) return undefined;          // Array.from -> array-like, length 0
      if (p === Symbol.toStringTag) return "Stub";
      if (p === "toString") return () => "";
      if (p === "valueOf") return () => 0;
      if (p === "then") return undefined;                   // never thenable
      if (p === "length") return 0;
      return makeStub(name + "." + String(p));
    },
    set() { return true; },
    apply() { return makeStub(name + "()"); },
    construct() { return makeStub("new " + name); },
    has() { return true; }
  });
}

/* ---------- real localStorage stub (shared host <-> vm) ---------- */
const store = new Map();
const localStorage = {
  getItem: k => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => { store.set(k, String(v)); },
  removeItem: k => { store.delete(k); },
  clear: () => store.clear()
};

const sandbox = {
  document: makeStub("document"),
  window: makeStub("window"),
  navigator: makeStub("navigator"),
  localStorage,
  ResizeObserver: makeStub("ResizeObserver"),
  matchMedia: makeStub("matchMedia"),
  FileReader: makeStub("FileReader"),
  Blob: makeStub("Blob"),
  URL: makeStub("URL"),
  confirm: () => true,
  prompt: () => null,
  alert: () => {},
  /* inert timers: nothing fires later; tests call persistNow() directly */
  setTimeout: () => 0, clearTimeout: () => {},
  setInterval: () => 0, clearInterval: () => {},
  console
};
sandbox.globalThis = sandbox;
vm.createContext(sandbox);

let passed = 0, failed = 0;
function check(name, fn) {
  try { fn(); passed++; console.log("ok   - " + name); }
  catch (e) { failed++; console.error("FAIL - " + name + "\n       " + (e && e.message)); }
}
function assert(cond, msg) { if (!cond) throw new Error(msg || "assertion failed"); }
function eq(a, b, msg) { assert(a === b, (msg || "eq") + ": expected " + b + ", got " + a); }

/* ---------- boot the app script ---------- */
check("boot: script runs to completion under DOM stubs", () => {
  vm.runInContext(src, sandbox, { filename: "index.html<script>" });
});
if (failed) { console.error("\nBoot failed — aborting."); process.exit(1); }

const g = expr => vm.runInContext(expr, sandbox);
const clone = x => JSON.parse(JSON.stringify(x));

const DATA = g("DATA");
const migrateV1toV2 = g("migrateV1toV2");
const validDataV1 = g("validDataV1");
const validDataV2 = g("validDataV2");
const sanitizeV2 = g("sanitizeV2");
const branchCalcOf = g("branchCalcOf");
const catCalc = g("catCalc");
const SUFFIX_RE = /\s*[—–-]\s*(ملحقات المنزل|ملحقات المطبخ|ملحقات المائدة|كهربائيات وخردوات)\s*$/;

check("boot: state is a v2 object with 21 categories (migrated from embedded DATA)", () => {
  eq(g("state && state.version"), 2, "state.version");
  eq(g("state.categories.length"), 21, "categories");
  eq(g("Array.isArray(state.orders) && state.orders.length"), 0, "orders empty");
  eq(g("state.suppliers.length"), 16, "suppliers");
});

/* ---------- fresh migration of the embedded DATA ---------- */
const mig = migrateV1toV2(clone(DATA), true);

check("migrate: 21 categories, ids 001..021 in order", () => {
  eq(mig.categories.length, 21, "count");
  mig.categories.forEach((c, i) =>
    eq(c.id, String(i + 1).padStart(3, "0"), "cat id at " + i));
});

check("migrate: branch invariants 1000 / 1877 / 374 / +202 (invoices/paid 0)", () => {
  const b = branchCalcOf(mig.categories);
  eq(b.target, 1000, "target"); eq(b.reg, 1877, "reg");
  eq(b.deficit, 374, "deficit"); eq(b.excess, 202, "excess");
  eq(b.invoices, 0, "invoices"); eq(b.paid, 0, "paid");
});

check("migrate: cat 003 (المنظفات) target 950, reg 1757, over-target", () => {
  const c = mig.categories.find(c => c.id === "003");
  const k = catCalc(c);
  eq(k.target, 950, "target"); eq(k.reg, 1757, "reg");
  eq(k.excess, 122, "Σ per-row excess (ground truth from data.json)");
  assert(k.reg > k.target && k.excess > 0, "must render as over-target");
});

check("migrate: 16 supplier entities, unique names, active, assigned to real columns", () => {
  eq(mig.suppliers.length, 16, "count");
  const names = new Set(mig.suppliers.map(s => s.name));
  eq(names.size, 16, "unique names");
  mig.suppliers.forEach(s => {
    eq(s.status, "active", "status of " + s.name);
    assert(Array.isArray(s.assignedCategories) && s.assignedCategories.length > 0,
      s.name + " has no assignedCategories");
    s.assignedCategories.forEach(cid => {
      const cat = mig.categories.find(c => c.id === cid);
      assert(cat && cat.suppliers.indexOf(s.name) !== -1,
        s.name + " assigned to " + cid + " but not a column there");
    });
  });
  const q = mig.suppliers.find(s => s.name === "قوين");
  assert(q, "قوين entity missing");
  ["001", "002", "021", "009"].forEach(cid =>
    assert(q.assignedCategories.indexOf(cid) !== -1, "قوين must cover السبالة slice " + cid));
});

check("migrate: «فحم» row lands in 001 with its v1 code", () => {
  const c1 = mig.categories.find(c => c.id === "001");
  const r = c1.rows.find(r => r.name === "فحم");
  assert(r, "no فحم row in 001");
  eq(r.code, "016", "code copied from v1");
});

check("migrate: «سائل يدين» claims prebuilt sub 003-001 with target 200", () => {
  const c3 = mig.categories.find(c => c.id === "003");
  const r = c3.rows.find(r => r.name === "سائل يدين");
  assert(r, "no سائل يدين row in 003");
  eq(r.id, "003-001", "row id");
  eq(r.target, 200, "target");
  eq(r.vals.reduce((a, b) => a + b, 0), 268, "reg preserved");
});

check("migrate: السبالة routed 25/51/39/13 and suffix stripped everywhere", () => {
  mig.categories.forEach(c => c.rows.forEach(r =>
    assert(!SUFFIX_RE.test(r.name), "suffix survives on «" + r.name + "» in " + c.id)));
  /* السبالة had 128 rows; each slice's rows all live in its target cat now */
  const rowsOf = id => mig.categories.find(c => c.id === id).rows;
  assert(rowsOf("002").length >= 51, "002 must hold the 51-row المطبخ slice");
  assert(rowsOf("021").length >= 39, "021 must hold the 39-row المائدة slice");
});

check("migrate: row-count conservation (709 prebuilt + 105 appended; 386 v1 rows kept)", () => {
  const total = mig.categories.reduce((a, c) => a + c.rows.length, 0);
  const xRows = mig.categories.reduce((a, c) => a + c.rows.filter(r => /-x\d+$/.test(r.id)).length, 0);
  eq(total, 814, "total rows");
  eq(xRows, 105, "appended rows");
  /* claimed (386-105=281) + appended = all 386 v1 rows — enforced inside migration, echoed here */
  eq(709 + xRows, total, "appended accounting");
});

check("migrate: every category padded to >= 15 supplier columns; vals aligned", () => {
  mig.categories.forEach(c => {
    assert(c.suppliers.length >= 15, c.id + " has " + c.suppliers.length + " columns");
    c.rows.forEach(r => eq(r.vals.length, c.suppliers.length, "vals of " + r.id));
  });
});

check("migrate: unique row ids per category", () => {
  mig.categories.forEach(c => {
    const ids = new Set(c.rows.map(r => r.id));
    eq(ids.size, c.rows.length, "dup row ids in " + c.id);
  });
});

check("validators: validDataV2(migrated) true; v1 shapes / index2 shapes rejected", () => {
  eq(validDataV2(mig), true, "migrated valid");
  eq(validDataV1(DATA), true, "v1 validator accepts DATA");
  eq(validDataV2(DATA), false, "v2 validator rejects v1 array");
  eq(validDataV2({ categories: [], suppliers: [], orders: [] }), false, "index2-shaped rejected");
  eq(validDataV2(null), false, "null rejected");
});

check("sanitizeV2: clean migration needs 0 fixes", () => {
  const d = clone(mig);
  eq(sanitizeV2(d), 0, "fixes");
  eq(JSON.stringify(d), JSON.stringify(mig), "no mutation on clean data");
});

check("sanitizeV2: fixes orphans/status/negatives once, then idempotent", () => {
  const d = clone(mig);
  const supId = d.suppliers[0].id;
  d.suppliers[0].assignedCategories.push("999");                       // orphan cat ref
  d.orders.push({ id: "ORD-t1", supplierId: "SUP-nope", supplierName: "؟",
    orderDate: "x", updatedAt: "x", status: "draft", notes: "",
    items: [{ mainCategoryId: "003", target: 10, subAllocations: {} }], posted: null });
  d.orders.push({ id: "ORD-t2", supplierId: supId, supplierName: "؟",
    orderDate: "x", updatedAt: "x", status: "shipped", notes: "",     // unknown status
    items: [
      { mainCategoryId: "999", target: 5, subAllocations: {} },        // orphan cat item
      { mainCategoryId: "003", target: -7,                             // negative target
        subAllocations: { "003-001": { qty: -4, note: "" },            // negative qty
                          "003-zzz": { qty: 3, note: "" } } }          // orphan rowId
    ], posted: null });
  d.orders.push({ id: "ORD-t3", supplierId: supId, supplierName: "؟",
    orderDate: "x", updatedAt: "x", status: "draft", notes: "",
    items: [{ mainCategoryId: "888", target: 1, subAllocations: {} }], posted: null });
  const f1 = sanitizeV2(d);
  assert(f1 > 0, "first pass must fix something (got " + f1 + ")");
  eq(d.orders.length, 1, "surviving orders");
  eq(d.orders[0].id, "ORD-t2", "survivor id");
  eq(d.orders[0].status, "draft", "status coerced");
  eq(d.orders[0].items.length, 1, "orphan item dropped");
  eq(d.orders[0].items[0].target, 0, "negative target clamped");
  eq(d.orders[0].items[0].subAllocations["003-001"].qty, 0, "negative qty clamped");
  eq("003-zzz" in d.orders[0].items[0].subAllocations, false, "orphan rowId dropped");
  eq(d.suppliers[0].assignedCategories.indexOf("999"), -1, "orphan cat ref dropped");
  eq(validDataV2(d), true, "sanitized object valid");
  const snap = JSON.stringify(d);
  eq(sanitizeV2(d), 0, "second pass fixes");
  eq(JSON.stringify(d), snap, "idempotent");
});

check("migrate: conservation holds for arbitrary (edited) v1 input", () => {
  const v1b = clone(DATA);
  v1b[0].info.invoices = 1234.5; v1b[0].info.paid = 200;
  v1b[7].info.invoices = 77;                                  // السبالة info -> credited once (002)
  v1b[0].rows.push({ code: "", name: "صنف اختبار جديد", target: 50,
    vals: [10, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0], note: "" });
  const inB = branchCalcOf(v1b);
  const out = migrateV1toV2(clone(v1b));                      // no embedded flag
  const outB = branchCalcOf(out.categories);
  eq(outB.target, inB.target, "target"); eq(outB.reg, inB.reg, "reg");
  eq(outB.deficit, inB.deficit, "deficit"); eq(outB.excess, inB.excess, "excess");
  eq(outB.invoices, inB.invoices, "invoices"); eq(outB.paid, inB.paid, "paid");
  eq(out.categories.find(c => c.id === "002").info.invoices, 77, "السبالة info credited to 002");
  const total = out.categories.reduce((a, c) => a + c.rows.length, 0);
  const xRows = out.categories.reduce((a, c) => a + c.rows.filter(r => /-x\d+$/.test(r.id)).length, 0);
  eq(total, 709 + xRows, "row accounting");
  eq(xRows, 106, "one extra appended row");
});

check("migrate: throws on unmapped v1 category (caller falls back)", () => {
  const v1b = clone(DATA);
  v1b.push({ name: "قسم مجهول", info: { status: "", payStatus: "", account: "", invoices: 0, paid: 0 },
    suppliers: [], rows: [] });
  let threw = false;
  try { migrateV1toV2(v1b); } catch (e) { threw = true; }
  eq(threw, true, "must throw");
});

/* ---------- persistence paths (vm-side, real localStorage stub) ---------- */
check("loadState: v1 key migrates in place; v1 key untouched; v2 written only by persistNow", () => {
  store.clear();
  const v1b = clone(DATA);
  v1b[0].rows[0].target = 999;                                // user edit in v1
  const rawV1 = JSON.stringify({ savedAt: "2026-01-01T00:00:00.000Z", data: v1b });
  localStorage.setItem("qween-dashboard-v1", rawV1);
  g("loadState()");
  eq(g("state.version"), 2, "migrated to v2");
  eq(g('state.categories.find(c => c.id === "003").rows.find(r => r.id === "003-001").target'),
    999, "v1 edit carried through migration");
  eq(localStorage.getItem("qween-dashboard-v1"), rawV1, "v1 key byte-identical");
  eq(localStorage.getItem("qween-dashboard-v2"), null, "no v2 write before persistNow");
  g("persistNow()");
  const rawV2 = localStorage.getItem("qween-dashboard-v2");
  assert(rawV2, "persistNow must write v2 key");
  eq(JSON.parse(rawV2).data.version, 2, "v2 envelope");
  eq(localStorage.getItem("qween-dashboard-v1"), rawV1, "v1 key still untouched");
});

check("loadState: corrupted v2 key falls back to v1 migration without crash", () => {
  store.clear();
  localStorage.setItem("qween-dashboard-v2", "{broken json");
  localStorage.setItem("qween-dashboard-v1", JSON.stringify(clone(DATA)));  // bare-array form
  g("loadState()");
  eq(g("state.version"), 2, "recovered");
  eq(g("state.categories.length"), 21, "21 cats");
  eq(localStorage.getItem("qween-dashboard-v2"), "{broken json", "corrupt v2 left as-is until next save");
});

check("loadState: valid v2 key wins and is sanitized", () => {
  store.clear();
  const d = clone(mig);
  d.orders.push({ id: "ORD-x9", supplierId: "SUP-ghost", supplierName: "؟",
    orderDate: "x", updatedAt: "x", status: "draft", notes: "",
    items: [{ mainCategoryId: "003", target: 1, subAllocations: {} }], posted: null });
  localStorage.setItem("qween-dashboard-v2", JSON.stringify({ savedAt: "2026-01-02T00:00:00.000Z", data: d }));
  g("loadState()");
  eq(g("state.version"), 2, "v2 loaded");
  eq(g("state.orders.length"), 0, "orphan order sanitized away");
  eq(g("savedAtIso"), "2026-01-02T00:00:00.000Z", "savedAt restored");
});

check("resetAll: clears v2 key only, rebuilds from embedded DATA", () => {
  store.clear();
  const rawV1 = JSON.stringify(clone(DATA));
  localStorage.setItem("qween-dashboard-v1", rawV1);
  localStorage.setItem("qween-dashboard-v2", '{"savedAt":"x","data":{}}');
  g("resetAll()");                                            // confirm stub returns true
  eq(localStorage.getItem("qween-dashboard-v2"), null, "v2 cleared");
  eq(localStorage.getItem("qween-dashboard-v1"), rawV1, "v1 untouched");
  const b = branchCalcOf(g("state.categories"));
  eq(b.target, 1000, "fresh target"); eq(b.reg, 1877, "fresh reg");
});

/* ---------- UI paths still operate on state.categories ---------- */
check("render paths: overview, category screen, tabs, CSV export run without throwing", () => {
  g('view.screen = "overview"; view.cat = -1; render(); "ok"');
  g('view.screen = "cat"; view.cat = 2; render(); "ok"');     // المنظفات screen + bind
  g('view.screen = "cat"; view.cat = 99; render(); "ok"');    // out of range -> falls back
  eq(g("view.screen"), "overview", "fallback to overview");
  g("exportCSV(); \"ok\"");
  g("exportJSON(); \"ok\"");
});

/* ============================================================
   Stage 2 — view architecture: named screens, dispatch, modal
   framework, donutSVG refactor
   ============================================================ */
check("stage2: NAMED_SCREENS has exactly the six named screens (no 'cat')", () => {
  const names = g("Array.from(NAMED_SCREENS).join(',')");
  eq(names, "overview,suppliers,orders,tracking,reports,settings", "set contents");
  eq(g('NAMED_SCREENS.has("cat")'), false, "'cat' must route via numeric fallthrough");
  eq(g("NAMED_TABS.length"), 6, "six named tabs");
  eq(g("NAMED_TABS.every(t => NAMED_SCREENS.has(t[0]))"), true, "tab keys are named screens");
});

check("stage2: render dispatch — placeholders render, screen sticks, filters hidden flagged", () => {
  for (const s of ["suppliers", "orders", "tracking", "reports", "settings"]) {
    g('view.screen = "' + s + '"; view.cat = -1; render(); "ok"');
    eq(g("view.screen"), s, "screen sticks on " + s);
  }
  g('view.screen = "overview"; view.cat = -1; render(); "ok"');
  eq(g("view.screen"), "overview", "back to overview");
  g('view.screen = "cat"; view.cat = 2; render(); "ok"');
  eq(g("view.screen"), "cat", "numeric category screen still renders");
  g('view.screen = "bogus"; render(); "ok"');
  eq(g("view.screen"), "overview", "unknown screen falls back to overview");
});

check("stage2: donutSVG output identical to the pre-refactor algorithm", () => {
  const ST = { DONE: "مكتمل", PROG: "تحت التنفيذ", FOLLOW: "يحتاج متابعة",
               NONE: "لم يبدأ", NOTGT: "بدون مستهدف" };
  const fmt = n => (+n || 0).toLocaleString("en-US");
  const escH = s => String(s == null ? "" : s)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  /* verbatim copy of the ORIGINAL donutSVG (pre-refactor reference) */
  function oldDonutSVG(counts, total) {
    const order = [
      [ST.DONE, "var(--done)"], [ST.PROG, "var(--prog)"],
      [ST.FOLLOW, "var(--follow)"], [ST.NONE, "var(--none)"],
      [ST.NOTGT, "#94a3b8"]
    ];
    const R = 54, CIRC = 2 * Math.PI * R;
    let off = 0, segs = "";
    for (const [key, col] of order) {
      const n = counts[key] || 0;
      if (!n || !total) continue;
      const len = (n / total) * CIRC;
      segs += '<circle cx="70" cy="70" r="' + R + '" fill="none" stroke="' + col +
        '" stroke-width="20" stroke-dasharray="' + len.toFixed(2) + " " + (CIRC - len).toFixed(2) +
        '" stroke-dashoffset="' + (-off).toFixed(2) + '" transform="rotate(-90 70 70)"></circle>';
      off += len;
    }
    if (!segs) segs = '<circle cx="70" cy="70" r="' + R + '" fill="none" stroke="var(--muted-bg)" stroke-width="20"></circle>';
    const legend = order.map(([key, col]) =>
      '<div class="li"><span class="sw" style="background:' + col + '"></span>' +
      escH(key) + ' <b style="direction:ltr">' + fmt(counts[key] || 0) + "</b></div>").join("");
    return '<div class="donut-wrap"><svg width="140" height="140" viewBox="0 0 140 140" role="img" aria-label="توزيع حالات الأصناف">' +
      segs + '<text x="70" y="66" text-anchor="middle" class="donut-center">' + fmt(total) + "</text>" +
      '<text x="70" y="82" text-anchor="middle" class="donut-center-sub">صنف فرعي</text></svg>' +
      '<div class="donut-legend">' + legend + "</div></div>";
  }
  const fixtures = [
    [{ [ST.DONE]: 3, [ST.PROG]: 2, [ST.NOTGT]: 5 }, 10],
    [{ [ST.DONE]: 814 }, 814],
    [{}, 0]
  ];
  /* real overview counts too */
  const b = branchCalcOf(mig.categories);
  fixtures.push([b.counts, Object.values(b.counts).reduce((a, n) => a + n, 0)]);
  for (const [counts, total] of fixtures) {
    const got = g("donutSVG(" + JSON.stringify(counts) + ", " + total + ")");
    eq(got, oldDonutSVG(counts, total), "donut for total=" + total);
  }
});

check("stage2: donutSVGgeneric — custom segments drawn in order, labels escaped", () => {
  const html = g('donutSVGgeneric([{label:"<img src=x onerror=alert(1)>",value:2,color:"var(--prog)"},' +
    '{label:"b",value:3,color:"var(--done)"}], "5", "أوردر", "حسب الحالة")');
  assert(html.indexOf("<img") === -1, "raw label injected");
  assert(html.indexOf("&lt;img src=x onerror=alert(1)&gt;") !== -1, "escaped label present");
  assert(html.indexOf('stroke="var(--prog)"') < html.indexOf('stroke="var(--done)"'), "segment order kept");
  assert(html.indexOf('aria-label="حسب الحالة"') !== -1, "aria label");
  assert(html.indexOf(">أوردر</text>") !== -1, "center sub");
});

check("stage2: modal framework — helpers exist, head escapes, close action registered", () => {
  eq(g("typeof openAppModal"), "function", "openAppModal");
  eq(g("typeof closeAppModal"), "function", "closeAppModal");
  const head = g('modalHeadHTML("<b>عنوان</b>")');
  assert(head.indexOf("<b>") === -1, "title must be escaped");
  assert(head.indexOf('data-action="modal-close"') !== -1, "close button wired via data-action");
  assert(head.indexOf("onclick") === -1, "no inline onclick");
  eq(g('typeof ACTIONS["modal-close"]'), "function", "modal-close routed");
  g('openAppModal("<p>x</p>"); closeAppModal(); "ok"');   // must not throw under stubs
});

/* ============================================================
   Stage 3 — suppliers tab: entities, CRUD rules, rename
   propagation, delete rules, escaping
   ============================================================ */
check("stage3: 16 migrated suppliers; assignedCategories == exact column membership, category order", () => {
  eq(mig.suppliers.length, 16, "supplier count");
  mig.suppliers.forEach(s => {
    const expect = mig.categories
      .filter(c => c.suppliers.indexOf(s.name) !== -1).map(c => c.id);
    eq(JSON.stringify(s.assignedCategories), JSON.stringify(expect),
      "assignedCategories of " + s.name);
  });
});

check("stage3: supplierNameError — empty / placeholder / duplicate rejected, self-rename allowed", () => {
  g('state = migrateV1toV2(JSON.parse(JSON.stringify(DATA)), true); "ok"');
  assert(g('supplierNameError("", null)') !== null, "empty must be rejected");
  assert(g('supplierNameError("   ", null)') !== null, "whitespace must be rejected");
  assert(g('supplierNameError("اسم الشركة 7", null)') !== null, "placeholder pattern must be rejected");
  assert(g('supplierNameError("اسم الشركة 15", null)') !== null, "placeholder 15 must be rejected");
  assert(g('supplierNameError("موبي", null)') !== null, "duplicate of existing supplier rejected");
  assert(g('supplierNameError(" موبي ", null)') !== null, "trimmed duplicate rejected");
  const mobiId = g('state.suppliers.find(s => s.name === "موبي").id');
  eq(g('supplierNameError("موبي", ' + JSON.stringify(mobiId) + ")"), null, "own name allowed on edit");
  eq(g('supplierNameError("مورد تجريبي جديد", null)'), null, "fresh unique name allowed");
});

check("stage3: propagateSupplierRename — every column string + own order snapshots; grid vals untouched", () => {
  const res = JSON.parse(g(`(() => {
    state = migrateV1toV2(JSON.parse(JSON.stringify(DATA)), true);
    const q = state.suppliers.find(s => s.name === "قوين");
    const other = state.suppliers.find(s => s.name === "موبي");
    state.orders.push({ id: "ORD-r1", supplierId: q.id, supplierName: "قوين",
      orderDate: "x", updatedAt: "x", status: "draft", notes: "",
      items: [{ mainCategoryId: "001", target: 5, subAllocations: {} }], posted: null });
    state.orders.push({ id: "ORD-r2", supplierId: other.id, supplierName: "موبي",
      orderDate: "x", updatedAt: "x", status: "draft", notes: "",
      items: [{ mainCategoryId: "001", target: 5, subAllocations: {} }], posted: null });
    const beforeCats = state.categories
      .filter(c => c.suppliers.indexOf("قوين") !== -1).map(c => c.id);
    const beforeIdx = {};
    state.categories.forEach(c => { beforeIdx[c.id] = c.suppliers.indexOf("قوين"); });
    const valsSnap = JSON.stringify(state.categories.map(c => c.rows.map(r => r.vals)));
    const ret = propagateSupplierRename("قوين", "قوين المتحدة", q.id);
    const afterOld = state.categories
      .filter(c => c.suppliers.indexOf("قوين") !== -1).length;
    const afterNewCats = state.categories
      .filter(c => c.suppliers.indexOf("قوين المتحدة") !== -1).map(c => c.id);
    const idxKept = state.categories.every(c =>
      beforeIdx[c.id] === -1 || c.suppliers[beforeIdx[c.id]] === "قوين المتحدة");
    return JSON.stringify({
      ret, beforeCats, afterOld, afterNewCats, idxKept,
      valsUntouched: JSON.stringify(state.categories.map(c => c.rows.map(r => r.vals))) === valsSnap,
      ord1: state.orders[0].supplierName, ord2: state.orders[1].supplierName
    });
  })()`));
  assert(res.beforeCats.length >= 4, "قوين must start in >= 4 categories");
  ["001", "002", "021", "009"].forEach(id =>
    assert(res.beforeCats.indexOf(id) !== -1, "قوين column expected in " + id));
  eq(res.ret.cols, res.beforeCats.length, "renamed column count");
  eq(res.ret.ords, 1, "renamed order-snapshot count");
  eq(res.afterOld, 0, "no old-name column survives");
  eq(JSON.stringify(res.afterNewCats), JSON.stringify(res.beforeCats), "new name in same categories");
  eq(res.idxKept, true, "renamed in place (same column index)");
  eq(res.valsUntouched, true, "row vals byte-identical");
  eq(res.ord1, "قوين المتحدة", "own order snapshot re-synced");
  eq(res.ord2, "موبي", "other supplier's order untouched");
});

check("stage3: deleteSupplier — removes entity + its orders only; grid byte-identical", () => {
  const res = JSON.parse(g(`(() => {
    state = migrateV1toV2(JSON.parse(JSON.stringify(DATA)), true);
    const a = state.suppliers.find(s => s.name === "رسيل");
    const b = state.suppliers.find(s => s.name === "موبي");
    state.orders.push({ id: "ORD-d1", supplierId: a.id, supplierName: a.name,
      orderDate: "x", updatedAt: "x", status: "draft", notes: "",
      items: [{ mainCategoryId: "003", target: 5, subAllocations: {} }], posted: null });
    state.orders.push({ id: "ORD-d2", supplierId: a.id, supplierName: a.name,
      orderDate: "x", updatedAt: "x", status: "pending", notes: "",
      items: [{ mainCategoryId: "003", target: 5, subAllocations: {} }], posted: null });
    state.orders.push({ id: "ORD-d3", supplierId: b.id, supplierName: b.name,
      orderDate: "x", updatedAt: "x", status: "draft", notes: "",
      items: [{ mainCategoryId: "003", target: 5, subAllocations: {} }], posted: null });
    const catsSnap = JSON.stringify(state.categories);
    const supsBefore = state.suppliers.length;
    deleteSupplier(a.id);   /* confirm stub returns true */
    return JSON.stringify({
      supsBefore, supsAfter: state.suppliers.length,
      aGone: !state.suppliers.some(s => s.id === a.id),
      orderIds: state.orders.map(o => o.id),
      catsUntouched: JSON.stringify(state.categories) === catsSnap,
      colStays: state.categories.some(c => c.suppliers.indexOf("رسيل") !== -1)
    });
  })()`));
  eq(res.supsBefore, 16, "16 before");
  eq(res.supsAfter, 15, "15 after");
  eq(res.aGone, true, "entity removed");
  eq(JSON.stringify(res.orderIds), JSON.stringify(["ORD-d3"]), "only its orders removed");
  eq(res.catsUntouched, true, "grid columns/vals byte-identical");
  eq(res.colStays, true, "grid column named رسيل survives entity deletion");
});

check("stage3: saveSupplierCategories — stable category order; setAllCategoryChecks respects filter", () => {
  const res = JSON.parse(g(`(() => {
    state = migrateV1toV2(JSON.parse(JSON.stringify(DATA)), true);
    const s = state.suppliers[0];
    catModalSupplierId = s.id;
    catModalSel = new Set(["009", "001", "017"]);   /* deliberately unordered */
    catModalFilter = "";
    saveSupplierCategories();
    const assigned = s.assignedCategories.slice();
    /* select-all / none via the modal helpers */
    catModalSupplierId = s.id;
    catModalSel = new Set();
    catModalFilter = "";
    setAllCategoryChecks(true);
    const allN = catModalSel.size;
    catModalFilter = "المنظفات";
    setAllCategoryChecks(false);
    const afterFilteredNone = catModalSel.size;
    const dropped003 = !catModalSel.has("003");
    catModalFilter = "";
    setAllCategoryChecks(false);
    const noneN = catModalSel.size;
    catModalSel = null; catModalSupplierId = null; catModalFilter = "";
    return JSON.stringify({ assigned, updatedAt: typeof s.updatedAt,
      allN, afterFilteredNone, dropped003, noneN });
  })()`));
  eq(JSON.stringify(res.assigned), JSON.stringify(["001", "009", "017"]), "saved in category order");
  eq(res.updatedAt, "string", "updatedAt stamped");
  eq(res.allN, 21, "select-all covers all 21");
  eq(res.afterFilteredNone, 20, "filtered none drops only the match");
  eq(res.dropped003, true, "المنظفات dropped by filtered none");
  eq(res.noneN, 0, "unfiltered none clears all");
});

check("stage3: supplierCardHTML — XSS probes inert, ids quoted, no inline onclick", () => {
  const probe = {
    id: 'SUP-x"y', name: '<img src=x onerror=alert(1)>', contact: '"><b>x</b>',
    email: '"><svg onload=alert(2)>@x', address: '<script>alert(3)</' + 'script>',
    status: "active", notes: '"><script>alert(4)</' + 'script>',
    assignedCategories: ["003"]
  };
  const html = g("supplierCardHTML(" + JSON.stringify(probe) + ")");
  assert(html.indexOf("<img") === -1, "raw <img injected");
  assert(html.indexOf("<script") === -1, "raw <script injected");
  assert(html.indexOf("<svg") === -1, "raw <svg injected");
  assert(html.indexOf("onclick") === -1, "inline onclick present");
  assert(html.indexOf("&lt;img src=x onerror=alert(1)&gt;") !== -1, "escaped name shown");
  assert(html.indexOf('data-id="SUP-x&quot;y"') !== -1, "data-id attribute-escaped");
  assert(html.indexOf('data-action="sup-edit"') !== -1, "edit delegated");
  assert(html.indexOf('data-action="sup-delete"') !== -1, "delete delegated");
});

check("stage3: suppliers screen renders under stubs; dispatch + actions wired; filters narrow", () => {
  eq(g("SCREEN_RENDERERS.suppliers === renderSuppliers"), true, "dispatch entry is the real renderer");
  g('view.screen = "suppliers"; view.cat = -1; render(); "ok"');
  eq(g("view.screen"), "suppliers", "screen sticks");
  ["sup-add", "sup-edit", "sup-delete", "sup-cats", "sup-save", "sup-cats-save",
   "sup-cats-all", "sup-cats-none", "sup-filters-reset", "sup-new-order"].forEach(a =>
    eq(g('typeof ACTIONS["' + a + '"]'), "function", "action " + a));
  /* unknown supplier id: the new-order action opens the wizard with no preselect, never throws */
  g('ACTIONS["sup-new-order"]({ dataset: { id: "SUP-x" } }); "ok"');
  g('wiz = null; "ok"');   /* discard that wizard (the stub DOM cannot close the modal) */
  const res = JSON.parse(g(`(() => {
    state = migrateV1toV2(JSON.parse(JSON.stringify(DATA)), true);
    supFilters = { search: "", status: "", cat: "" };
    const all = filteredSuppliers().length;
    supFilters.cat = "003";
    const in003 = filteredSuppliers().length;
    const expect003 = state.suppliers.filter(s => s.assignedCategories.indexOf("003") !== -1).length;
    supFilters = { search: "قوين", status: "", cat: "" };
    const byName = filteredSuppliers().map(s => s.name);
    state.suppliers[0].status = "inactive";
    supFilters = { search: "", status: "inactive", cat: "" };
    const inact = filteredSuppliers().length;
    state.suppliers[0].status = "active";
    supFilters = { search: "", status: "", cat: "" };
    return JSON.stringify({ all, in003, expect003, byName, inact });
  })()`));
  eq(res.all, 16, "no filters -> all 16");
  assert(res.in003 > 0 && res.in003 === res.expect003, "category filter matches assignedCategories");
  eq(JSON.stringify(res.byName), JSON.stringify(["قوين"]), "name search");
  eq(res.inact, 1, "status filter");
  g('view.screen = "overview"; view.cat = -1; render(); "ok"');
});

/* ============================================================
   Stage 4 — order wizard: orderItemCalc/orderCalc (Excel rule),
   create + edit round-trip, empty refusal, posted lock,
   over-allocation violet path, transient scratch state
   ============================================================ */
const orderItemCalc = it => JSON.parse(g("JSON.stringify(orderItemCalc(" + JSON.stringify(it) + "))"));
const orderCalc = o => JSON.parse(g("JSON.stringify(orderCalc(" + JSON.stringify(o) + "))"));

check("stage4: orderItemCalc — Excel rule (deficit floored, pct capped, status chips, violet excess)", () => {
  let k = orderItemCalc({ target: 100, subAllocations: { a: { qty: 40 }, b: { qty: 30 } } });
  eq(k.allocated, 70, "allocated"); eq(k.deficit, 30, "deficit");
  eq(k.pct, 0.7, "pct"); eq(k.status, "تحت التنفيذ", "status"); eq(k.excess, 0, "excess");
  k = orderItemCalc({ target: 50, subAllocations: { a: { qty: 80 } } });
  eq(k.deficit, 0, "over-allocation must NOT yield negative deficit");
  eq(k.excess, 30, "excess"); eq(k.pct, 1, "pct capped"); eq(k.status, "مكتمل", "status at cap");
  k = orderItemCalc({ target: 0, subAllocations: { a: { qty: 9 } } });
  eq(k.pct, 0, "target 0 -> pct 0"); eq(k.status, "", "target 0 -> blank status");
  eq(k.deficit, 0, "target 0 -> no deficit"); eq(k.excess, 0, "no badge when target 0 (grid rule)");
  k = orderItemCalc({ target: 100, subAllocations: { a: { qty: -5 }, b: { qty: 30 } } });
  eq(k.allocated, 30, "negative qty clamped to 0 in the sum");
  k = orderItemCalc({ target: 10, subAllocations: {} });
  eq(k.status, "لم يبدأ", "empty allocations -> لم يبدأ"); eq(k.deficit, 10, "full deficit");
  eq(orderItemCalc({ target: 100, subAllocations: { a: { qty: 90 } } }).status, "مكتمل", "0.9 boundary");
  eq(orderItemCalc({ target: 100, subAllocations: { a: { qty: 60 } } }).status, "تحت التنفيذ", "0.6 boundary");
  eq(orderItemCalc({ target: 100, subAllocations: { a: { qty: 30 } } }).status, "يحتاج متابعة", "0.3 boundary");
});

check("stage4: orderCalc — per-item deficit sum; over-allocation never masks a shortage", () => {
  const k = orderCalc({ items: [
    { mainCategoryId: "001", target: 50, subAllocations: { a: { qty: 80 } } },   // over by 30
    { mainCategoryId: "003", target: 100, subAllocations: { b: { qty: 20 } } }   // short by 80
  ] });
  eq(k.target, 150, "Σtarget"); eq(k.allocated, 100, "Σallocated");
  eq(k.deficit, 80, "deficit must be 80 (NOT netted to 50)");
  eq(k.excess, 30, "Σexcess");
  eq(orderCalc({ items: [] }).deficit, 0, "empty order");
  eq(orderCalc({}).target, 0, "missing items tolerated");
});

check("stage4: wizard create round-trip — supplier preselect, steps, save creates ORD draft", () => {
  const res = JSON.parse(g(`(() => {
    state = migrateV1toV2(JSON.parse(JSON.stringify(DATA)), true);
    wiz = null;
    const sup = state.suppliers.find(s => s.assignedCategories.indexOf("003") !== -1);
    openOrderWizard({ supplierId: sup.id });
    const s1 = { step: wiz.step, sid: wiz.supplierId === sup.id, isNew: wiz.orderId === null };
    wizNext();                                              /* -> step 2 */
    wiz.selectedCategories = ["003"];
    wizNext();                                              /* -> step 3 */
    const s3 = wiz.step;
    wiz.allocations["003"] = { target: 100, subAllocations: {
      "003-001": { qty: 40, note: "عاجل" },
      "003-002": { qty: 0, note: "" },                      /* zero+empty -> dropped */
      "003-zzz": { qty: 9, note: "" } } };                  /* orphan rowId -> dropped */
    wizNext();                                              /* -> step 4 */
    const s4 = wiz.step;
    const before = state.orders.length;
    wizSave();
    const o = state.orders[0];
    return JSON.stringify({ s1, s3, s4, before, after: state.orders.length,
      supName: sup.name, id: o && o.id, sid2: o && o.supplierId === sup.id,
      snm: o && o.supplierName, st: o && o.status, posted: o ? o.posted : "?",
      dates: o && typeof o.orderDate === "string" && typeof o.updatedAt === "string",
      notes: o && o.notes, items: o && o.items,
      wizCleared: wiz === null, valid: validDataV2(state) });
  })()`));
  eq(res.s1.step, 1, "starts at step 1");
  eq(res.s1.sid, true, "supplier preselected from card");
  eq(res.s1.isNew, true, "create mode");
  eq(res.s3, 3, "reaches step 3"); eq(res.s4, 4, "reaches step 4");
  eq(res.before, 0, "no orders before"); eq(res.after, 1, "one order saved");
  assert(/^ORD-/.test(res.id), "genId ORD pattern, got " + res.id);
  eq(res.sid2, true, "supplierId"); eq(res.snm, res.supName, "supplierName snapshot");
  eq(res.st, "draft", "created as draft"); eq(res.posted, null, "posted null");
  eq(res.dates, true, "orderDate/updatedAt iso strings"); eq(res.notes, "", "empty notes");
  eq(res.items.length, 1, "one item");
  eq(res.items[0].mainCategoryId, "003", "item category");
  eq(res.items[0].target, 100, "item target");
  eq(JSON.stringify(Object.keys(res.items[0].subAllocations)), JSON.stringify(["003-001"]),
    "zero rows and orphan rowIds dropped");
  eq(res.items[0].subAllocations["003-001"].qty, 40, "qty saved");
  eq(res.items[0].subAllocations["003-001"].note, "عاجل", "note saved");
  eq(res.wizCleared, true, "wizard scratch cleared after save");
  eq(res.valid, true, "state stays validDataV2");
});

check("stage4: wizard edit round-trip — preload, supplier locked, in-place update, scratch isolated", () => {
  const res = JSON.parse(g(`(() => {
    const o = state.orders[0];
    const beforeItems = JSON.stringify(o.items);
    const beforeDate = o.orderDate, beforeUpd = o.updatedAt;
    openOrderWizard({ orderId: o.id });
    const pre = { step: wiz.step, oid: wiz.orderId === o.id, sid: wiz.supplierId === o.supplierId,
      sel: wiz.selectedCategories.slice(),
      qty: wiz.allocations["003"].subAllocations["003-001"].qty };
    const step1 = wizHTML();
    wiz.allocations["003"].subAllocations["003-001"].qty = 70;   /* edit scratch */
    const orderUntouched = JSON.stringify(o.items) === beforeItems;
    wizNext(); wizNext(); wizNext();
    wizSave();
    return JSON.stringify({ pre, step1Locked: step1.indexOf("wizSupSearch") === -1,
      step1Hint: step1.indexOf("المورد مثبّت") !== -1,
      orderUntouched, count: state.orders.length, sameId: state.orders[0].id === o.id,
      qtyAfter: state.orders[0].items[0].subAllocations["003-001"].qty,
      dateKept: state.orders[0].orderDate === beforeDate,
      updChanged: typeof state.orders[0].updatedAt === "string" && state.orders[0].updatedAt !== beforeUpd,
      st: state.orders[0].status, wizCleared: wiz === null, valid: validDataV2(state) });
  })()`));
  eq(res.pre.step, 1, "edit starts at step 1");
  eq(res.pre.oid, true, "orderId preloaded"); eq(res.pre.sid, true, "supplier preloaded");
  eq(JSON.stringify(res.pre.sel), JSON.stringify(["003"]), "categories preloaded");
  eq(res.pre.qty, 40, "allocations preloaded");
  eq(res.step1Locked, true, "no supplier search input in edit mode");
  eq(res.step1Hint, true, "locked-supplier hint shown");
  eq(res.orderUntouched, true, "editing scratch must not mutate the order before save");
  eq(res.count, 1, "updated in place, not duplicated");
  eq(res.sameId, true, "same order id");
  eq(res.qtyAfter, 70, "qty updated");
  eq(res.dateKept, true, "orderDate preserved");
  eq(res.updChanged, true, "updatedAt stamped");
  eq(res.st, "draft", "status untouched by edit");
  eq(res.wizCleared, true, "scratch cleared"); eq(res.valid, true, "still valid");
});

check("stage4: empty-order refusal — all targets and qtys 0 blocks save, wizard stays open", () => {
  const res = JSON.parse(g(`(() => {
    const sup = state.suppliers.find(s => s.assignedCategories.indexOf("003") !== -1);
    const before = state.orders.length;
    openOrderWizard({ supplierId: sup.id });
    wizNext();
    wiz.selectedCategories = ["003"];
    wizNext();
    wiz.allocations["003"] = { target: 0, subAllocations: { "003-001": { qty: 0, note: "" } } };
    wizNext();
    const review = wizHTML();
    wizSave();
    const out = { before, after: state.orders.length, open: wiz !== null,
      step: wiz && wiz.step, reviewWarns: review.indexOf("لا يمكن حفظ أمر فارغ") !== -1 };
    wiz = null;
    return JSON.stringify(out);
  })()`));
  eq(res.after, res.before, "no order saved");
  eq(res.open, true, "wizard stays open for correction");
  eq(res.step, 4, "still on review step");
  eq(res.reviewWarns, true, "review shows the empty-order warning");
});

check("stage4: posted orders locked — wizard refuses to open AND refuses a late save", () => {
  const res = JSON.parse(g(`(() => {
    const o = state.orders[0];
    o.posted = { at: "2026-01-01T00:00:00.000Z", cells: [] };
    wiz = null;
    openOrderWizard({ orderId: o.id });
    const openBlocked = wiz === null;
    /* race: wizard opened while unposted, order becomes posted before save */
    o.posted = null;
    openOrderWizard({ orderId: o.id });
    wizNext(); wizNext(); wizNext();
    o.posted = { at: "2026-01-01T00:00:00.000Z", cells: [] };
    const beforeItems = JSON.stringify(o.items);
    wiz.allocations["003"].subAllocations["003-001"].qty = 99;
    wizSave();
    const saveBlocked = JSON.stringify(o.items) === beforeItems && wiz !== null;
    o.posted = null;
    wiz = null;
    return JSON.stringify({ openBlocked, saveBlocked });
  })()`));
  eq(res.openBlocked, true, "openOrderWizard blocked while posted");
  eq(res.saveBlocked, true, "save blocked when posted appears mid-edit");
});

check("stage4: over-allocation — violet badge path, saves fine, deficit never negative", () => {
  const res = JSON.parse(g(`(() => {
    const sup = state.suppliers.find(s => s.assignedCategories.indexOf("003") !== -1);
    const before = state.orders.length;
    openOrderWizard({ supplierId: sup.id });
    wizNext();
    wiz.selectedCategories = ["003"];
    wizNext();
    wiz.allocations["003"] = { target: 50, subAllocations: { "003-001": { qty: 80, note: "" } } };
    const step3 = wizHTML();
    wizNext();
    const step4 = wizHTML();
    wizSave();
    const o = state.orders[state.orders.length - 1];
    return JSON.stringify({ before, after: state.orders.length,
      calc: orderItemCalc(o.items[0]),
      s3badge: step3.indexOf("badge-over") !== -1 && step3.indexOf("تجاوز المستهدف +30") !== -1,
      s4badge: step4.indexOf("badge-over") !== -1,
      s3neg: step3.indexOf("-30") !== -1, s4neg: step4.indexOf("-30") !== -1,
      valid: validDataV2(state) });
  })()`));
  eq(res.after, res.before + 1, "over-allocation must still save");
  eq(res.calc.deficit, 0, "saved data yields deficit 0, never negative");
  eq(res.calc.excess, 30, "saved data yields excess 30 (violet path)");
  eq(res.s3badge, true, "step-3 summary shows violet «تجاوز المستهدف +30»");
  eq(res.s4badge, true, "step-4 review shows the violet badge");
  eq(res.s3neg, false, "no -30 anywhere in step 3");
  eq(res.s4neg, false, "no -30 anywhere in step 4");
  eq(res.valid, true, "state valid");
  const sum = g('wizSumHTML(orderItemCalc({target:50, subAllocations:{a:{qty:80}}}))');
  assert(sum.indexOf("badge-over") !== -1, "wizSumHTML violet badge");
  assert(sum.indexOf("تجاوز المستهدف +30") !== -1, "wizSumHTML badge text");
  assert(sum.indexOf("-30") === -1, "wizSumHTML never shows a negative deficit");
});

check("stage4: step guards — no supplier / inactive / no categories / empty selection all hold", () => {
  const res = JSON.parse(g(`(() => {
    state = migrateV1toV2(JSON.parse(JSON.stringify(DATA)), true);
    wiz = null;
    openOrderWizard({});                                    /* no supplier at all */
    wizNext();
    const g1 = wiz.step === 1;
    const sup = state.suppliers.find(s => s.assignedCategories.length > 0);
    sup.status = "inactive";                                /* inactive supplier */
    wiz.supplierId = sup.id;
    wizNext();
    const g2 = wiz.step === 1;
    sup.status = "active";
    state.suppliers.push({ id: "SUP-nocats", name: "مورد بلا مجموعات", contact: "", email: "",
      address: "", status: "active", notes: "", assignedCategories: [],
      createdAt: "x", updatedAt: "x" });                    /* no assigned categories */
    wiz.supplierId = "SUP-nocats";
    wizNext();
    const g3 = wiz.step === 1;
    wiz.supplierId = sup.id;                                /* valid -> advances */
    wizNext();
    const g4 = wiz.step === 2;
    wiz.selectedCategories = [];                            /* nothing selected */
    wizNext();
    const g5 = wiz.step === 2;
    wiz.selectedCategories = ["999"];                       /* nonexistent category */
    wizNext();
    const g6 = wiz.step === 2 && wiz.selectedCategories.length === 0;
    state.suppliers = state.suppliers.filter(s => s.id !== "SUP-nocats");
    wiz = null;
    return JSON.stringify({ g1, g2, g3, g4, g5, g6,
      inactiveListed: (() => {                              /* autocomplete = ACTIVE only */
        sup.status = "inactive";
        const q = sup.name.toLowerCase();
        const listed = state.suppliers.filter(s => s.status === "active" &&
          s.name.toLowerCase().indexOf(q) !== -1).length;
        sup.status = "active";
        return listed;
      })() });
  })()`));
  ["g1", "g2", "g3"].forEach(k => eq(res[k], true, "guard " + k + " must hold on step 1"));
  eq(res.g4, true, "valid supplier advances to step 2");
  eq(res.g5, true, "empty selection blocks step 2");
  eq(res.g6, true, "nonexistent category filtered then blocked");
  eq(res.inactiveListed, 0, "inactive suppliers excluded from the autocomplete source");
});

check("stage4: wizard scratch is transient — never enters state or the persisted envelope", () => {
  const res = JSON.parse(g(`(() => {
    state = migrateV1toV2(JSON.parse(JSON.stringify(DATA)), true);
    const sup = state.suppliers.find(s => s.assignedCategories.indexOf("003") !== -1);
    openOrderWizard({ supplierId: sup.id });
    wizNext();
    wiz.selectedCategories = ["003"];                       /* scratch-only key */
    persistNow();                                           /* persist WHILE wizard is open */
    const raw = localStorage.getItem("qween-dashboard-v2");
    const out = { hasScratch: raw.indexOf("selectedCategories") !== -1 ||
        raw.indexOf("currentWizard") !== -1 || raw.indexOf('"wiz"') !== -1,
      stateClean: !("currentWizard" in state) && !("wiz" in state),
      stateKeys: Object.keys(state).sort().join(",") };
    wiz = null;
    return JSON.stringify(out);
  })()`));
  eq(res.hasScratch, false, "no wizard scratch in the persisted envelope");
  eq(res.stateClean, true, "no wizard keys on state");
  eq(res.stateKeys, "categories,orders,suppliers,version", "state shape untouched");
});

check("stage4: step-3/step-4 markup — XSS probes inert, delegated actions only", () => {
  const res = JSON.parse(g(`(() => {
    state = migrateV1toV2(JSON.parse(JSON.stringify(DATA)), true);
    const sup = state.suppliers.find(s => s.assignedCategories.indexOf("003") !== -1);
    const cat = state.categories.find(c => c.id === "003");
    const r = cat.rows[0];
    const oldName = r.name, oldSupName = sup.name;
    r.name = '<img src=x onerror=alert(1)>';
    sup.name = '"><svg onload=alert(2)>';
    openOrderWizard({ supplierId: sup.id });
    wizNext();
    wiz.selectedCategories = ["003"];
    wizNext();
    wiz.allocations["003"] = { target: 5, subAllocations: {
      [r.id]: { qty: 2, note: '"><scr' + 'ipt>alert(3)</scr' + 'ipt>' } } };
    const step3 = wizHTML();
    wiz.step = 4;
    const step4 = wizHTML();
    r.name = oldName; sup.name = oldSupName; wiz = null;
    return JSON.stringify({
      s3img: step3.indexOf("<img") !== -1,
      s3escaped: step3.indexOf("&lt;img src=x onerror=alert(1)&gt;") !== -1,
      s3script: step3.indexOf("<scr" + "ipt") !== -1,
      s3onclick: step3.indexOf("onclick") !== -1,
      s4svg: step4.indexOf("<svg") !== -1,
      s4onclick: step4.indexOf("onclick") !== -1,
      acHtml: (() => {                                       /* autocomplete items too */
        wiz = { orderId: null, step: 1, supplierId: null, selectedCategories: [], allocations: {} };
        sup.name = '<img src=y onerror=alert(4)>'; sup.status = "active";
        let captured = null;
        const savedDoc = document;                           /* recording stub for #wizSupList */
        document = { querySelector: sel => sel === "#wizSupList"
          ? { set innerHTML(v) { captured = v; }, set hidden(v) {} }
          : savedDoc.querySelector(sel) };
        wizFilterSuppliers("img");                           /* probe name contains "img" */
        document = savedDoc;
        sup.name = oldSupName; wiz = null;
        return captured;
      })() });
  })()`));
  eq(res.s3img, false, "raw <img must not appear in step 3");
  eq(res.s3escaped, true, "escaped row name shown in step 3");
  eq(res.s3script, false, "raw <script from note must not appear");
  eq(res.s3onclick, false, "no inline onclick in step 3");
  eq(res.s4svg, false, "raw <svg from supplier name must not appear in step 4");
  eq(res.s4onclick, false, "no inline onclick in step 4");
  assert(typeof res.acHtml === "string" && res.acHtml.length > 0, "autocomplete list rendered");
  assert(res.acHtml.indexOf("<img") === -1, "autocomplete item must escape the supplier name");
  assert(res.acHtml.indexOf("&lt;img src=y onerror=alert(4)&gt;") !== -1, "escaped name present in list");
  assert(res.acHtml.indexOf("onclick") === -1 && res.acHtml.indexOf("onmouseover") === -1,
    "autocomplete uses delegated data-action, no inline handlers");
});

check("stage4: ACTIONS wired — wizard actions registered; supplier card opens the wizard", () => {
  ["ord-new", "ord-edit", "wiz-pick-sup", "wiz-next", "wiz-prev", "wiz-save"].forEach(a =>
    eq(g('typeof ACTIONS["' + a + '"]'), "function", "action " + a));
  const res = JSON.parse(g(`(() => {
    state = migrateV1toV2(JSON.parse(JSON.stringify(DATA)), true);
    wiz = null;
    const sup = state.suppliers[0];
    ACTIONS["sup-new-order"]({ dataset: { id: sup.id } });
    const viaCard = wiz !== null && wiz.supplierId === sup.id && wiz.orderId === null;
    wiz = null;
    ACTIONS["ord-new"]({ dataset: {} });
    const viaNew = wiz !== null && wiz.supplierId === null && wiz.orderId === null;
    wiz = null;
    ACTIONS["ord-edit"]({ dataset: { id: "ORD-missing" } });  /* unknown -> toast, no wizard */
    const missingSafe = wiz === null;
    ACTIONS["wiz-next"]({}, {});                              /* wiz null -> all no-ops */
    ACTIONS["wiz-prev"]({}, {});
    ACTIONS["wiz-save"]({}, {});
    ACTIONS["wiz-pick-sup"]({ dataset: { id: "SUP-x" } }, {});
    return JSON.stringify({ viaCard, viaNew, missingSafe, stillNull: wiz === null });
  })()`));
  eq(res.viaCard, true, "supplier card preselects the supplier");
  eq(res.viaNew, true, "ord-new opens a blank wizard");
  eq(res.missingSafe, true, "editing a missing order toasts instead of opening");
  eq(res.stillNull, true, "wizard actions are null-safe when no wizard is open");
});

/* ============================================================
   Stage 5 — orders tab + posting engine + print:
   deliver -> exact grid rise; un-deliver -> exact restore;
   double-deliver no-op; posted edit blocked; clamp + skip on
   reversal; declined confirm; escaping in card/modal/sheet
   ============================================================ */
check("stage5: dispatch, actions and status labels wired", () => {
  eq(g("SCREEN_RENDERERS.orders === renderOrders"), true, "dispatch entry is the real renderer");
  ["ord-details", "ord-delete", "ord-print", "ord-filters-reset"].forEach(a =>
    eq(g('typeof ACTIONS["' + a + '"]'), "function", "action " + a));
  eq(g("Object.keys(ORDER_STATUS_LABELS).join(',')"),
    "draft,pending,confirmed,delivered,cancelled", "labels cover the status enum");
  eq(g('ORDER_STATUS_LABELS.draft'), "مسودة", "draft label");
  eq(g('ORDER_STATUS_LABELS.pending'), "قيد الانتظار", "pending label");
  eq(g('ORDER_STATUS_LABELS.confirmed'), "مؤكد", "confirmed label");
  eq(g('ORDER_STATUS_LABELS.delivered'), "تم التسليم", "delivered label");
  eq(g('ORDER_STATUS_LABELS.cancelled'), "ملغي", "cancelled label");
  g('view.screen = "orders"; view.cat = -1; render(); "ok"');
  eq(g("view.screen"), "orders", "orders screen sticks");
  g('view.screen = "overview"; view.cat = -1; render(); "ok"');
});

check("stage5: ensureSupplierColumn — name match, placeholder claim, append extends every row", () => {
  const res = JSON.parse(g(`(() => {
    const c2 = { id: "099", name: "اختبار", suppliers: ["أ", "اسم الشركة 2", "ب"], rows: [
      { id: "r1", vals: [1, 2, 3] }, { id: "r2", vals: [0, 0, 0] } ] };
    const iMatch = ensureSupplierColumn(c2, " ب ");
    const iPh = ensureSupplierColumn(c2, "مورد جديد");
    const c3 = { id: "098", name: "x", suppliers: ["أ"], rows: [
      { id: "r1", vals: [4] }, { id: "r2", vals: [] } ] };
    const iApp = ensureSupplierColumn(c3, "ملحق");
    return JSON.stringify({ iMatch, iPh, sup1: c2.suppliers[1], len2: c2.suppliers.length,
      iApp, c3sup: c3.suppliers, c3vals: c3.rows.map(r => r.vals) });
  })()`));
  eq(res.iMatch, 2, "trimmed exact-name match returns the existing column");
  eq(res.iPh, 1, "placeholder slot claimed");
  eq(res.sup1, "مورد جديد", "placeholder renamed in place");
  eq(res.len2, 3, "no column appended when a slot is free");
  eq(res.iApp, 1, "no free slot -> appended index");
  eq(JSON.stringify(res.c3sup), JSON.stringify(["أ", "ملحق"]), "suppliers extended");
  eq(JSON.stringify(res.c3vals), JSON.stringify([[4, 0], [0, 0]]), "EVERY row.vals padded");
});

check("stage5: deliver posts exact quantities — ledger recorded, grid + branch rise exactly", () => {
  const res = JSON.parse(g(`(() => {
    state = migrateV1toV2(JSON.parse(JSON.stringify(DATA)), true);
    const sup = state.suppliers.find(s => s.name === "مصنع الجودة");
    const c3 = state.categories.find(c => c.id === "003");
    const c17 = state.categories.find(c => c.id === "017");
    const colOf = c3.suppliers.indexOf(sup.name);
    const before = branchCalcOf(state.categories);
    const r1 = c3.rows.find(r => r.id === "003-001");
    const r2 = c3.rows.find(r => r.id === "003-002");
    const r17 = c17.rows[0];
    const reg1 = rowCalc(r1).reg, reg2 = rowCalc(r2).reg;
    const v1 = +r1.vals[colOf] || 0, v2 = +r2.vals[colOf] || 0;
    state.orders.push({ id: "ORD-p1", supplierId: sup.id, supplierName: sup.name,
      orderDate: "2026-07-01T00:00:00.000Z", updatedAt: "x", status: "confirmed", notes: "",
      items: [
        { mainCategoryId: "003", target: 100, subAllocations: {
          "003-001": { qty: 40, note: "" }, "003-002": { qty: 10, note: "" },
          "003-003": { qty: 0, note: "" } } },
        { mainCategoryId: "017", target: 0, subAllocations: { [r17.id]: { qty: 7, note: "" } } }
      ], posted: null });
    setOrderStatus("ORD-p1", "delivered");
    const o = state.orders.find(x => x.id === "ORD-p1");
    const after = branchCalcOf(state.categories);
    return JSON.stringify({
      st: o.status, postedAt: o.posted && typeof o.posted.at,
      cells: o.posted && o.posted.cells, colOf,
      reg1d: rowCalc(r1).reg - reg1, reg2d: rowCalc(r2).reg - reg2,
      v1d: (+r1.vals[colOf] || 0) - v1, v2d: (+r2.vals[colOf] || 0) - v2,
      reg17: rowCalc(r17).reg, c17col0: c17.suppliers[0],
      regDelta: after.reg - before.reg, tgtDelta: after.target - before.target,
      valid: validDataV2(state) });
  })()`));
  eq(res.st, "delivered", "status updated");
  eq(res.postedAt, "string", "posted.at recorded");
  eq(res.cells.length, 3, "one ledger cell per qty>0 allocation (zero rows excluded)");
  const c3cells = res.cells.filter(c => c.catId === "003");
  eq(c3cells.length, 2, "two cells in 003");
  c3cells.forEach(c => eq(c.colIdx, res.colOf, "003 cells posted into the supplier's own column"));
  eq(c3cells.find(c => c.rowId === "003-001").qty, 40, "exact qty in ledger");
  eq(c3cells.find(c => c.rowId === "003-002").qty, 10, "exact qty in ledger");
  eq(res.reg1d, 40, "row 003-001 reg rises by exactly 40");
  eq(res.reg2d, 10, "row 003-002 reg rises by exactly 10");
  eq(res.v1d, 40, "cell value delta exact");
  eq(res.v2d, 10, "cell value delta exact");
  eq(res.reg17, 7, "017 row received 7");
  eq(res.c17col0, "مصنع الجودة", "placeholder column claimed with the supplier name");
  eq(res.regDelta, 57, "branch registered rises by Σqty");
  eq(res.tgtDelta, 0, "branch target untouched");
  eq(res.valid, true, "state stays validDataV2 (ledger shape ok)");
});

check("stage5: un-deliver restores the grid EXACTLY — invariants 1000/1877/374/+202 back", () => {
  const res = JSON.parse(g(`(() => {
    state = migrateV1toV2(JSON.parse(JSON.stringify(DATA)), true);
    const sup = state.suppliers.find(s => s.name === "مصنع الجودة");
    const valsSnap = JSON.stringify(state.categories.map(c => c.rows.map(r => r.vals)));
    state.orders.push({ id: "ORD-p2", supplierId: sup.id, supplierName: sup.name,
      orderDate: "2026-07-01T00:00:00.000Z", updatedAt: "x", status: "confirmed", notes: "",
      items: [
        { mainCategoryId: "003", target: 100, subAllocations: {
          "003-001": { qty: 40, note: "" }, "003-002": { qty: 10, note: "" } } },
        { mainCategoryId: "017", target: 0, subAllocations: {
          [state.categories.find(c => c.id === "017").rows[0].id]: { qty: 7, note: "" } } }
      ], posted: null });
    setOrderStatus("ORD-p2", "delivered");
    const mid = branchCalcOf(state.categories);
    setOrderStatus("ORD-p2", "pending");
    const o = state.orders.find(x => x.id === "ORD-p2");
    const after = branchCalcOf(state.categories);
    return JSON.stringify({
      midReg: mid.reg, st: o.status, posted: o.posted,
      b: { target: after.target, reg: after.reg, deficit: after.deficit, excess: after.excess },
      valsRestored: JSON.stringify(state.categories.map(c => c.rows.map(r => r.vals))) === valsSnap,
      valid: validDataV2(state) });
  })()`));
  eq(res.midReg, 1877 + 57, "delivered state carried the posted quantities");
  eq(res.st, "pending", "status moved off delivered");
  eq(res.posted, null, "ledger cleared");
  eq(res.b.target, 1000, "target restored");
  eq(res.b.reg, 1877, "registered restored EXACTLY");
  eq(res.b.deficit, 374, "deficit restored");
  eq(res.b.excess, 202, "excess restored");
  eq(res.valsRestored, true, "every row.vals byte-identical to pre-deliver");
  eq(res.valid, true, "state valid");
});

check("stage5: double-deliver impossible — postOrder short-circuits, same-status no-op", () => {
  const res = JSON.parse(g(`(() => {
    state = migrateV1toV2(JSON.parse(JSON.stringify(DATA)), true);
    const sup = state.suppliers.find(s => s.name === "مصنع الجودة");
    state.orders.push({ id: "ORD-p3", supplierId: sup.id, supplierName: sup.name,
      orderDate: "2026-07-01T00:00:00.000Z", updatedAt: "x", status: "draft", notes: "",
      items: [{ mainCategoryId: "003", target: 50, subAllocations: {
        "003-001": { qty: 40, note: "" } } }], posted: null });
    const o = state.orders.find(x => x.id === "ORD-p3");
    setOrderStatus("ORD-p3", "delivered");
    const snap = JSON.stringify(state.categories.map(c => c.rows.map(r => r.vals)));
    const ledgerSnap = JSON.stringify(o.posted);
    const second = postOrder(o);                       /* direct double-post attempt */
    setOrderStatus("ORD-p3", "delivered");             /* same-status no-op */
    /* pathological import: posted set but status not delivered -> deliver must NOT re-post */
    o.status = "confirmed";
    setOrderStatus("ORD-p3", "delivered");
    return JSON.stringify({ second,
      gridSame: JSON.stringify(state.categories.map(c => c.rows.map(r => r.vals))) === snap,
      ledgerSame: JSON.stringify(o.posted) === ledgerSnap, st: o.status });
  })()`));
  eq(res.second, false, "postOrder returns false on a posted order");
  eq(res.gridSame, true, "grid unchanged by every double-deliver path");
  eq(res.ledgerSame, true, "ledger unchanged");
  eq(res.st, "delivered", "status still delivered");
});

check("stage5: posted order edit blocked — wizard refuses, modal button disabled, unlocks after un-deliver", () => {
  const res = JSON.parse(g(`(() => {
    state = migrateV1toV2(JSON.parse(JSON.stringify(DATA)), true);
    const sup = state.suppliers.find(s => s.name === "مصنع الجودة");
    state.orders.push({ id: "ORD-p4", supplierId: sup.id, supplierName: sup.name,
      orderDate: "2026-07-01T00:00:00.000Z", updatedAt: "x", status: "draft", notes: "",
      items: [{ mainCategoryId: "003", target: 50, subAllocations: {
        "003-001": { qty: 40, note: "" } } }], posted: null });
    setOrderStatus("ORD-p4", "delivered");
    const o = state.orders.find(x => x.id === "ORD-p4");
    wiz = null;
    openOrderWizard({ orderId: "ORD-p4" });
    const blocked = wiz === null;
    const modalPosted = orderModalHTML(o);
    setOrderStatus("ORD-p4", "confirmed");             /* un-deliver */
    openOrderWizard({ orderId: "ORD-p4" });
    const unlocked = wiz !== null && wiz.orderId === "ORD-p4";
    const modalFree = orderModalHTML(o);
    wiz = null; ordModalId = null;
    const editBtn = (h) => {
      const i = h.indexOf('data-action="ord-edit"');
      return h.slice(h.lastIndexOf("<button", i), h.indexOf(">", i) + 1);
    };
    return JSON.stringify({ blocked, unlocked,
      btnPosted: editBtn(modalPosted), btnFree: editBtn(modalFree) });
  })()`));
  eq(res.blocked, true, "wizard refuses to open while posted");
  eq(res.unlocked, true, "wizard opens after un-deliver");
  assert(res.btnPosted.indexOf(" disabled") !== -1, "edit button disabled while posted");
  assert(res.btnPosted.indexOf('title="') !== -1, "disabled edit button carries a tooltip");
  eq(res.btnFree.indexOf(" disabled"), -1, "edit button enabled after un-deliver");
});

check("stage5: reversal clamps at 0 after a manual decrease; deleted rows skipped safely", () => {
  const res = JSON.parse(g(`(() => {
    state = migrateV1toV2(JSON.parse(JSON.stringify(DATA)), true);
    const sup = state.suppliers.find(s => s.name === "مصنع الجودة");
    const c3 = state.categories.find(c => c.id === "003");
    state.orders.push({ id: "ORD-p5", supplierId: sup.id, supplierName: sup.name,
      orderDate: "2026-07-01T00:00:00.000Z", updatedAt: "x", status: "draft", notes: "",
      items: [{ mainCategoryId: "003", target: 100, subAllocations: {
        "003-001": { qty: 40, note: "" }, "003-002": { qty: 10, note: "" } } }], posted: null });
    setOrderStatus("ORD-p5", "delivered");
    const o = state.orders.find(x => x.id === "ORD-p5");
    const cell1 = o.posted.cells.find(c => c.rowId === "003-001");
    const cell2 = o.posted.cells.find(c => c.rowId === "003-002");
    const r1 = c3.rows.find(r => r.id === "003-001");
    r1.vals[cell1.colIdx] = 5;                         /* manual decrease below posted qty */
    const r2before = c3.rows.find(r => r.id === "003-002").vals[cell2.colIdx];
    c3.rows = c3.rows.filter(r => r.id !== "003-002"); /* row deleted meanwhile */
    let threw = false;
    try { setOrderStatus("ORD-p5", "cancelled"); } catch (e) { threw = true; }
    return JSON.stringify({ threw, st: o.status, posted: o.posted,
      clamped: +r1.vals[cell1.colIdx], r2before });
  })()`));
  eq(res.threw, false, "reversal with a deleted row must not throw");
  eq(res.st, "cancelled", "status still transitions");
  eq(res.posted, null, "ledger cleared");
  eq(res.clamped, 0, "5 - 40 clamps at 0, never negative");
  assert(res.r2before >= 10, "deleted row had received its posted qty before deletion");
});

check("stage5: declined confirm keeps status + grid; unknown status ignored; ledgerless delivered import safe", () => {
  const res = JSON.parse(g(`(() => {
    state = migrateV1toV2(JSON.parse(JSON.stringify(DATA)), true);
    const sup = state.suppliers.find(s => s.name === "مصنع الجودة");
    state.orders.push({ id: "ORD-p6", supplierId: sup.id, supplierName: sup.name,
      orderDate: "2026-07-01T00:00:00.000Z", updatedAt: "x", status: "draft", notes: "",
      items: [{ mainCategoryId: "003", target: 50, subAllocations: {
        "003-001": { qty: 40, note: "" } } }], posted: null });
    const o = state.orders.find(x => x.id === "ORD-p6");
    const snap = JSON.stringify(state.categories.map(c => c.rows.map(r => r.vals)));
    const yes = confirm;
    confirm = () => false;                             /* user declines */
    setOrderStatus("ORD-p6", "delivered");
    const declined = { st: o.status, posted: o.posted,
      gridSame: JSON.stringify(state.categories.map(c => c.rows.map(r => r.vals))) === snap };
    confirm = yes;
    setOrderStatus("ORD-p6", "shipped");               /* unknown status */
    const unknownIgnored = o.status === "draft";
    setOrderStatus("ORD-p6", "delivered");             /* now accept */
    confirm = () => false;                             /* decline the withdrawal */
    setOrderStatus("ORD-p6", "draft");
    const stillDelivered = o.status === "delivered" && o.posted !== null;
    confirm = yes;
    /* imported delivered order with no ledger: leaving delivered must not reverse anything */
    state.orders.push({ id: "ORD-p7", supplierId: sup.id, supplierName: sup.name,
      orderDate: "2026-07-02T00:00:00.000Z", updatedAt: "x", status: "delivered", notes: "",
      items: [{ mainCategoryId: "003", target: 5, subAllocations: {
        "003-001": { qty: 3, note: "" } } }], posted: null });
    const snap2 = JSON.stringify(state.categories.map(c => c.rows.map(r => r.vals)));
    setOrderStatus("ORD-p7", "draft");
    const o7 = state.orders.find(x => x.id === "ORD-p7");
    return JSON.stringify({ declined, unknownIgnored, stillDelivered,
      ledgerless: { st: o7.status,
        gridSame: JSON.stringify(state.categories.map(c => c.rows.map(r => r.vals))) === snap2 } });
  })()`));
  eq(res.declined.st, "draft", "declined deliver keeps the status");
  eq(res.declined.posted, null, "declined deliver posts nothing");
  eq(res.declined.gridSame, true, "declined deliver leaves the grid untouched");
  eq(res.unknownIgnored, true, "unknown status is ignored (no NaN, no change)");
  eq(res.stillDelivered, true, "declined withdrawal keeps delivered + ledger");
  eq(res.ledgerless.st, "draft", "ledgerless delivered order transitions cleanly");
  eq(res.ledgerless.gridSame, true, "ledgerless transition never touches the grid");
});

check("stage5: deleteOrder — confirm-gated; deleting a posted order keeps the delivered quantities", () => {
  const res = JSON.parse(g(`(() => {
    state = migrateV1toV2(JSON.parse(JSON.stringify(DATA)), true);
    const sup = state.suppliers.find(s => s.name === "مصنع الجودة");
    state.orders.push({ id: "ORD-p8", supplierId: sup.id, supplierName: sup.name,
      orderDate: "2026-07-01T00:00:00.000Z", updatedAt: "x", status: "draft", notes: "",
      items: [{ mainCategoryId: "003", target: 50, subAllocations: {
        "003-001": { qty: 40, note: "" } } }], posted: null });
    state.orders.push({ id: "ORD-p9", supplierId: sup.id, supplierName: sup.name,
      orderDate: "2026-07-02T00:00:00.000Z", updatedAt: "x", status: "draft", notes: "",
      items: [{ mainCategoryId: "003", target: 5, subAllocations: {
        "003-003": { qty: 2, note: "" } } }], posted: null });
    const yes = confirm;
    confirm = () => false;
    deleteOrder("ORD-p8");
    const declinedKept = state.orders.length === 2;
    confirm = yes;
    deleteOrder("ORD-p9");                             /* plain delete */
    const plainGone = !state.orders.some(o => o.id === "ORD-p9");
    setOrderStatus("ORD-p8", "delivered");
    const snap = JSON.stringify(state.categories.map(c => c.rows.map(r => r.vals)));
    deleteOrder("ORD-p8");                             /* delete while posted */
    deleteOrder("ORD-missing");                        /* unknown id: no throw */
    return JSON.stringify({ declinedKept, plainGone,
      postedGone: state.orders.length === 0,
      gridKept: JSON.stringify(state.categories.map(c => c.rows.map(r => r.vals))) === snap,
      valid: validDataV2(state) });
  })()`));
  eq(res.declinedKept, true, "declined confirm keeps the order");
  eq(res.plainGone, true, "plain delete removes the order");
  eq(res.postedGone, true, "posted order deletable after its own confirm");
  eq(res.gridKept, true, "delivered quantities stay in the grid on delete");
  eq(res.valid, true, "state valid after deletions");
});

check("stage5: list, modal, print sheet — filters narrow; XSS probes inert; delegated actions only", () => {
  const res = JSON.parse(g(`(() => {
    state = migrateV1toV2(JSON.parse(JSON.stringify(DATA)), true);
    const sup = state.suppliers.find(s => s.name === "مصنع الجودة");
    const other = state.suppliers.find(s => s.name === "موبي");
    state.orders.push({ id: 'ORD-x"1', supplierId: sup.id,
      supplierName: '<img src=x onerror=alert(1)>',
      orderDate: "2026-07-03T00:00:00.000Z", updatedAt: "x", status: "pending",
      notes: '"><scr' + 'ipt>alert(2)</scr' + 'ipt>',
      items: [{ mainCategoryId: "003", target: 50, subAllocations: {
        "003-001": { qty: 40, note: '<svg onload=alert(3)>' } } }], posted: null });
    state.orders.push({ id: "ORD-x2", supplierId: other.id, supplierName: other.name,
      orderDate: "2026-07-01T00:00:00.000Z", updatedAt: "x", status: "delivered",
      notes: "", items: [{ mainCategoryId: "001", target: 5, subAllocations: {
        "001-001": { qty: 2, note: "" } } }],
      posted: { at: "2026-07-02T00:00:00.000Z", cells: [] } });
    const o = state.orders[0];
    ordFilters = { search: "", status: "", supplier: "" };
    const all = filteredOrders().map(x => x.id);
    ordFilters.status = "pending";
    const byStatus = filteredOrders().map(x => x.id);
    ordFilters = { search: "", status: "", supplier: other.id };
    const bySup = filteredOrders().map(x => x.id);
    ordFilters = { search: "المنظفات", status: "", supplier: "" };
    const byCat = filteredOrders().map(x => x.id);
    ordFilters = { search: "", status: "", supplier: "" };
    const card = orderCardHTML(o);
    ordModalId = o.id;
    const modal = orderModalHTML(o);
    ordModalId = null;
    const sheet = orderSheetHTML(o);
    let printThrew = false;
    try { printOrder(o.id); } catch (e) { printThrew = true; }
    const probe = (h) => ({
      img: h.indexOf("<img") !== -1, svg: h.indexOf("<svg") !== -1,
      script: h.indexOf("<scr" + "ipt") !== -1, onclick: h.indexOf("onclick") !== -1,
      escaped: h.indexOf("&lt;img src=x onerror=alert(1)&gt;") !== -1 });
    return JSON.stringify({ all, byStatus, bySup, byCat,
      card: probe(card), modal: probe(modal), sheet: probe(sheet), printThrew,
      cardIdQuoted: card.indexOf('data-id="ORD-x&quot;1"') !== -1,
      cardAction: card.indexOf('data-action="ord-details"') !== -1,
      modalSel: modal.indexOf('id="ordStatusSel"') !== -1 &&
        modal.split("<option").length - 1 === 5 &&
        modal.indexOf('value="pending" selected') !== -1,
      modalNotes: modal.indexOf('id="ordNotesTa"') !== -1 &&
        modal.indexOf("&quot;&gt;&lt;scr") !== -1,
      modalDelete: modal.indexOf('data-action="ord-delete"') !== -1,
      modalPrint: modal.indexOf('data-action="ord-print"') !== -1,
      sheetQty: sheet.indexOf("40") !== -1,
      sheetNoteEsc: sheet.indexOf("&lt;svg onload=alert(3)&gt;") !== -1 });
  })()`));
  eq(JSON.stringify(res.all), JSON.stringify(['ORD-x"1', "ORD-x2"]), "newest first");
  eq(JSON.stringify(res.byStatus), JSON.stringify(['ORD-x"1']), "status filter");
  eq(JSON.stringify(res.bySup), JSON.stringify(["ORD-x2"]), "supplier filter");
  eq(JSON.stringify(res.byCat), JSON.stringify(['ORD-x"1']), "search matches category names");
  for (const [where, p] of [["card", res.card], ["modal", res.modal], ["sheet", res.sheet]]) {
    eq(p.img, false, where + ": raw <img injected");
    eq(p.svg, false, where + ": raw <svg injected");
    eq(p.script, false, where + ": raw <script injected");
    eq(p.onclick, false, where + ": inline onclick present");
    eq(p.escaped, true, where + ": escaped supplier name shown");
  }
  eq(res.cardIdQuoted, true, "card data-id attribute-escaped");
  eq(res.cardAction, true, "card opens details via delegated action");
  eq(res.modalSel, true, "modal status select: 5 labeled options, current selected");
  eq(res.modalNotes, true, "modal notes textarea present with escaped content");
  eq(res.modalDelete, true, "delete delegated");
  eq(res.modalPrint, true, "print delegated");
  eq(res.printThrew, false, "printOrder safe under stubs");
  eq(res.sheetQty, true, "sheet lists the quantity");
  eq(res.sheetNoteEsc, true, "sheet escapes sub-allocation notes");
});

check("stage5: status change refreshes the open details modal in place; missing ids are null-safe", () => {
  const res = JSON.parse(g(`(() => {
    state = migrateV1toV2(JSON.parse(JSON.stringify(DATA)), true);
    const sup = state.suppliers.find(s => s.name === "مصنع الجودة");
    state.orders.push({ id: "ORD-p10", supplierId: sup.id, supplierName: sup.name,
      orderDate: "2026-07-01T00:00:00.000Z", updatedAt: "x", status: "draft", notes: "",
      items: [{ mainCategoryId: "003", target: 50, subAllocations: {
        "003-001": { qty: 40, note: "" } } }], posted: null });
    ordModalId = null;
    openOrderModal("ORD-p10");
    const opened = ordModalId === "ORD-p10";
    setOrderStatus("ORD-p10", "confirmed");            /* modal stays targeted */
    const stillOpen = ordModalId === "ORD-p10";
    const stNow = state.orders.find(o => o.id === "ORD-p10").status;
    ordModalId = null;
    openOrderModal("ORD-missing");                     /* unknown id -> toast only */
    const missingSafe = ordModalId === null;
    ACTIONS["ord-details"]({ dataset: { id: "ORD-missing" } });
    ACTIONS["ord-print"]({ dataset: { id: "ORD-missing" } });
    ACTIONS["ord-delete"]({ dataset: { id: "ORD-missing" } });
    ACTIONS["ord-filters-reset"]();
    setOrderStatus("ORD-missing", "delivered");        /* toast, no throw */
    ordModalId = null;
    return JSON.stringify({ opened, stillOpen, stNow, missingSafe,
      filtersCleared: ordFilters.search === "" && ordFilters.status === "" && ordFilters.supplier === "" });
  })()`));
  eq(res.opened, true, "openOrderModal targets the order");
  eq(res.stillOpen, true, "status change re-renders the modal without closing it");
  eq(res.stNow, "confirmed", "status applied");
  eq(res.missingSafe, true, "unknown order id never opens the modal");
  eq(res.filtersCleared, true, "ord-filters-reset clears all filters");
});

/* ============================================================
   Stage 6 — tracking, reports, overview orders panel
   ============================================================ */
check("stage6: dispatch + actions wired — tracking/reports real renderers, 4 report types", () => {
  eq(g("SCREEN_RENDERERS.tracking === renderTracking"), true, "tracking wired");
  eq(g("SCREEN_RENDERERS.reports === renderReports"), true, "reports wired");
  eq(g('typeof ACTIONS["rep-show"]'), "function", "rep-show registered");
  eq(g('typeof ACTIONS["rep-print"]'), "function", "rep-print registered");
  eq(g("JSON.stringify(Object.keys(REPORT_TYPES))"),
    JSON.stringify(["suppliers", "orders", "categories", "deficit"]), "report types + order");
  eq(g('repCurrent in REPORT_TYPES'), true, "default report is a valid type");
});

check("stage6: empty-data renders — every screen safe with zero suppliers AND zero orders", () => {
  const res = JSON.parse(g(`(() => {
    state = migrateV1toV2(JSON.parse(JSON.stringify(DATA)), true);
    state.suppliers = []; state.orders = [];
    trkFilters = { search: "" }; repCurrent = "suppliers";
    /* harness-call every stage-6 render path — must not throw */
    renderTracking(); renderReports();
    showReport("suppliers"); showReport("orders"); showReport("categories"); showReport("deficit");
    renderOverview();
    view.screen = "tracking"; render();
    view.screen = "reports"; render();
    view.screen = "overview"; render();
    const noSup = trackingContentHTML();
    const panel = ordersOverviewPanelsHTML();
    const supRep = reportBodyHTML("suppliers", false);
    const ordRep = reportBodyHTML("orders", false);
    const catRep = reportBodyHTML("categories", false);
    const defRep = reportBodyHTML("deficit", false);
    repCurrent = "suppliers";
    return JSON.stringify({
      noSup: noSup.indexOf("لا يوجد مورّدون بعد") !== -1,
      panelEmpty: panel === "",
      supEmpty: supRep.indexOf("لا بيانات") !== -1,
      ordEmpty: ordRep.indexOf("لا بيانات") !== -1,
      catEmpty: catRep.indexOf("لا بيانات") !== -1,
      defFromGrid: defRep.indexOf("374") !== -1 && defRep.indexOf("rep-cat-row") !== -1 });
  })()`));
  eq(res.noSup, true, "no-suppliers empty state");
  eq(res.panelEmpty, true, "overview panel absent when no orders");
  eq(res.supEmpty, true, "suppliers report empty row");
  eq(res.ordEmpty, true, "orders report empty row");
  eq(res.catEmpty, true, "categories report empty row");
  eq(res.defFromGrid, true, "deficit report still computed from the GRID (374, grouped)");
});

check("stage6: tracking empty states — exact spec text when suppliers exist but no orders; all-cancelled noted", () => {
  const res = JSON.parse(g(`(() => {
    state = migrateV1toV2(JSON.parse(JSON.stringify(DATA)), true);
    state.orders = []; trkFilters = { search: "" };
    const noOrders = trackingContentHTML();
    const sup = state.suppliers[0];
    state.orders.push({ id: "ORD-t0", supplierId: sup.id, supplierName: sup.name,
      orderDate: "2026-07-01T00:00:00.000Z", updatedAt: "x", status: "cancelled", notes: "",
      items: [{ mainCategoryId: "003", target: 10, subAllocations: { "003-001": { qty: 5, note: "" } } }],
      posted: null });
    const allCancelled = trackingContentHTML();
    state.orders = [];
    return JSON.stringify({
      noOrders: noOrders.indexOf("لا توجد أوردرات بعد — أنشئ أول أمر من تبويب الأوردرات") !== -1,
      noOrdersIsNote: noOrders.indexOf("empty-note") !== -1,
      allCancelled: allCancelled.indexOf("ملغاة") !== -1 && allCancelled.indexOf("trk-card") === -1 });
  })()`));
  eq(res.noOrders, true, "exact spec empty-state text");
  eq(res.noOrdersIsNote, true, "uses the standard empty-note");
  eq(res.allCancelled, true, "all-cancelled shows a note, no supplier cards");
});

check("stage6: tracking aggregation — Excel rule per category (never netted), cancelled excluded, search + XSS", () => {
  const res = JSON.parse(g(`(() => {
    state = migrateV1toV2(JSON.parse(JSON.stringify(DATA)), true);
    const sup = state.suppliers.find(s => s.name === "مصنع الجودة");
    const other = state.suppliers.find(s => s.name === "موبي");
    /* o1: cat 003 target 100 alloc 40 (deficit 60) + cat 001 target 50 alloc 90 (excess 40) */
    state.orders.push({ id: "ORD-a1", supplierId: sup.id, supplierName: sup.name,
      orderDate: "2026-07-01T00:00:00.000Z", updatedAt: "x", status: "confirmed", notes: "",
      items: [
        { mainCategoryId: "003", target: 100, subAllocations: { "003-001": { qty: 40, note: "" } } },
        { mainCategoryId: "001", target: 50, subAllocations: { "001-001": { qty: 90, note: "" } } }
      ], posted: null });
    /* o2: cat 003 again, target 20 alloc 10 — merges into the 003 row */
    state.orders.push({ id: "ORD-a2", supplierId: sup.id, supplierName: sup.name,
      orderDate: "2026-07-02T00:00:00.000Z", updatedAt: "x", status: "draft", notes: "",
      items: [{ mainCategoryId: "003", target: 20, subAllocations: { "003-002": { qty: 10, note: "" } } }],
      posted: null });
    /* o3: cancelled — must not count anywhere in tracking */
    state.orders.push({ id: "ORD-a3", supplierId: sup.id, supplierName: sup.name,
      orderDate: "2026-07-03T00:00:00.000Z", updatedAt: "x", status: "cancelled", notes: "",
      items: [{ mainCategoryId: "003", target: 500, subAllocations: { "003-001": { qty: 500, note: "" } } }],
      posted: null });
    const k = supplierTrackAgg(sup.id);
    const cat003 = k.cats.find(c => c.catId === "003");
    const cat001 = k.cats.find(c => c.catId === "001");
    /* search narrows; XSS probe stays inert in the card */
    trkFilters = { search: "موبي" };
    const searched = trackingContentHTML();
    trkFilters = { search: "" };
    sup.name = '<img src=x onerror=alert(1)>';
    const card = trackCardHTML(sup);
    sup.name = "مصنع الجودة";
    state.orders = [];
    return JSON.stringify({
      orders: k.orders, target: k.target, allocated: k.allocated,
      deficit: k.deficit, excess: k.excess,
      c3: cat003 && { t: cat003.target, a: cat003.allocated, d: cat003.deficit, e: cat003.excess },
      c1: cat001 && { t: cat001.target, a: cat001.allocated, d: cat001.deficit, e: cat001.excess },
      catOrderStable: k.cats[0].catId === "001" && k.cats[1].catId === "003",
      searchedNoCards: searched.indexOf("trk-card") === -1,
      xssInert: card.indexOf("<img") === -1 && card.indexOf("&lt;img src=x onerror=alert(1)&gt;") !== -1,
      noOnclick: card.indexOf("onclick") === -1 });
  })()`));
  eq(res.orders, 2, "cancelled order excluded from count");
  eq(res.target, 170, "target = 100+20+50");
  eq(res.allocated, 140, "allocated = 40+10+90");
  eq(res.deficit, 70, "deficit = Σ per-category max (70), NOT netted 30");
  eq(res.excess, 40, "excess reported separately (violet), never subtracted");
  eq(JSON.stringify(res.c3), JSON.stringify({ t: 120, a: 50, d: 70, e: 0 }), "cat 003 merged across orders");
  eq(JSON.stringify(res.c1), JSON.stringify({ t: 50, a: 90, d: 0, e: 40 }), "cat 001 over-allocated");
  eq(res.catOrderStable, true, "breakdown follows dashboard category order");
  eq(res.searchedNoCards, true, "search filters supplier cards");
  eq(res.xssInert, true, "supplier-name probe escaped in tracking card");
  eq(res.noOnclick, true, "no inline onclick in tracking markup");
});

check("stage6: overview orders panel — donut segments sum to order count; spec colors; top-8 bars", () => {
  const res = JSON.parse(g(`(() => {
    state = migrateV1toV2(JSON.parse(JSON.stringify(DATA)), true);
    state.orders = [];
    const mk = (i, st, qty, nm) => ({ id: "ORD-d" + i, supplierId: "SUP-d" + i,
      supplierName: nm, orderDate: "2026-07-10T00:00:00.000Z", updatedAt: "x", status: st,
      notes: "", items: [{ mainCategoryId: "003", target: qty,
        subAllocations: { "003-001": { qty: qty, note: "" } } }], posted: null });
    const sts = ["draft", "draft", "pending", "confirmed", "delivered", "cancelled", "cancelled"];
    sts.forEach((st, i) => state.orders.push(mk(i, st, (i + 1) * 10, "مورد" + i)));
    /* 5 more suppliers so >8 candidates exist; one zero-qty (skipped) */
    for (let j = 7; j < 12; j++) state.orders.push(mk(j, "confirmed", j === 11 ? 0 : j * 10, "مورد" + j));
    state.orders.push(mk(20, "pending", 999, '<img src=x onerror=alert(1)>'));
    const segs = orderStatusSegments();
    const sum = segs.reduce((a, s) => a + s.value, 0);
    const byLabel = {};
    segs.forEach(s => { byLabel[s.label] = { v: s.value, c: s.color }; });
    const top = topSuppliersByAllocated(8);
    const panel = ordersOverviewPanelsHTML();
    state.orders = [];
    return JSON.stringify({ sum, n: 13,
      segCount: segs.length,
      draft: byLabel["مسودة"], pending: byLabel["قيد الانتظار"], confirmed: byLabel["مؤكد"],
      delivered: byLabel["تم التسليم"], cancelled: byLabel["ملغي"],
      topLen: top.length,
      topFirst: top[0].allocated, topSorted: top.every((e, i) => !i || top[i - 1].allocated >= e.allocated),
      topNoCancelled: top.every(e => e.name !== "مورد5" && e.name !== "مورد6"),
      topNoZero: top.every(e => e.allocated > 0),
      panelHasDonut: panel.indexOf('aria-label="توزيع حالات الأوردرات"') !== -1,
      panelHasBars: panel.indexOf("ts-row") !== -1 && panel.indexOf('class="fill"') !== -1,
      panelXssInert: panel.indexOf("<img") === -1 &&
        panel.indexOf("&lt;img src=x onerror=alert(1)&gt;") !== -1 });
  })()`));
  eq(res.segCount, 5, "one segment per status");
  eq(res.sum, res.n, "donut segment sum equals order count");
  eq(JSON.stringify(res.draft), JSON.stringify({ v: 2, c: "var(--muted)" }), "draft count+color");
  eq(JSON.stringify(res.pending), JSON.stringify({ v: 2, c: "var(--prog)" }), "pending count+color");
  eq(JSON.stringify(res.confirmed), JSON.stringify({ v: 6, c: "var(--accent)" }), "confirmed count+color");
  eq(JSON.stringify(res.delivered), JSON.stringify({ v: 1, c: "var(--done)" }), "delivered count+color");
  eq(JSON.stringify(res.cancelled), JSON.stringify({ v: 2, c: "var(--none)" }), "cancelled count+color");
  eq(res.topLen, 8, "top suppliers capped at 8");
  eq(res.topFirst, 999, "sorted by allocated desc");
  eq(res.topSorted, true, "bars in descending order");
  eq(res.topNoCancelled, true, "cancelled allocations excluded from bars");
  eq(res.topNoZero, true, "zero-allocation suppliers excluded");
  eq(res.panelHasDonut, true, "status donut present");
  eq(res.panelHasBars, true, "CSS bars present");
  eq(res.panelXssInert, true, "supplier-name probe escaped in bars");
});

check("stage6: reports — default + coercion, per-report content, print variant safe and escaped", () => {
  const res = JSON.parse(g(`(() => {
    state = migrateV1toV2(JSON.parse(JSON.stringify(DATA)), true);
    const sup = state.suppliers.find(s => s.name === "مصنع الجودة");
    state.orders.push({ id: 'ORD-r"1', supplierId: sup.id,
      supplierName: '<img src=x onerror=alert(1)>',
      orderDate: "2026-07-05T00:00:00.000Z", updatedAt: "x", status: "pending", notes: "",
      items: [{ mainCategoryId: "003", target: 200, subAllocations: { "003-001": { qty: 80, note: "" } } }],
      posted: null });
    state.orders.push({ id: "ORD-r2", supplierId: sup.id, supplierName: sup.name,
      orderDate: "2026-07-01T00:00:00.000Z", updatedAt: "x", status: "delivered", notes: "",
      items: [{ mainCategoryId: "001", target: 50, subAllocations: { "001-001": { qty: 50, note: "" } } }],
      posted: { at: "2026-07-02T00:00:00.000Z", cells: [] } });
    repCurrent = "bogus"; showReport("bogus");
    const coerced = repCurrent;
    renderReports();                                  /* default view renders on entry */
    const ordScreen = reportBodyHTML("orders", false);
    const ordPrint = reportBodyHTML("orders", true);
    const supScreen = reportBodyHTML("suppliers", false);
    const catScreen = reportBodyHTML("categories", false);
    const defScreen = reportBodyHTML("deficit", false);
    let printThrew = false;
    try { printReport("orders"); printReport("deficit"); } catch (e) { printThrew = true; }
    const b = branchCalc();
    const zeroOrderSup = state.suppliers.find(s => s.id !== sup.id);
    state.orders = []; repCurrent = "suppliers";
    return JSON.stringify({
      coerced,
      newestFirst: ordScreen.indexOf("ORD-r&quot;1") < ordScreen.indexOf("ORD-r2"),
      ordXss: ordScreen.indexOf("<img") === -1 &&
        ordScreen.indexOf("&lt;img src=x onerror=alert(1)&gt;") !== -1,
      ordChips: ordScreen.indexOf("قيد الانتظار") !== -1 && ordScreen.indexOf("تم التسليم") !== -1,
      printPs: ordPrint.indexOf('<table class="ps">') === 0,
      printNoChip: ordPrint.indexOf('class="st') === -1,
      printXss: ordPrint.indexOf("<img") === -1 &&
        ordPrint.indexOf("&lt;img src=x onerror=alert(1)&gt;") !== -1,
      screenWrapped: ordScreen.indexOf('<div class="rep-wrap"><table class="rep">') === 0,
      supHasZeroOrder: supScreen.indexOf(zeroOrderSup.name) !== -1,
      /* cat 003: target 200 alloc 80 (deficit 120); cat 001: 50/50 — sorted by target desc */
      catSorted: catScreen.indexOf("المنظفات") !== -1 &&
        catScreen.indexOf("المنظفات") < catScreen.indexOf("ملحقات المنزل"),
      catDeficit: catScreen.indexOf("120") !== -1,
      defTotal: defScreen.indexOf(">" + b.deficit.toLocaleString("en-US") + "<") !== -1,
      defMatchesBranch: b.deficit === 374,
      printThrew });
  })()`));
  eq(res.coerced, "suppliers", "unknown report type coerces to the default");
  eq(res.newestFirst, true, "orders report newest first");
  eq(res.ordXss, true, "orders report escapes supplier-name probe");
  eq(res.ordChips, true, "status labels shown on screen");
  eq(res.printPs, true, "print variant uses the .ps table");
  eq(res.printNoChip, true, "print variant uses text statuses, not chips");
  eq(res.printXss, true, "print variant escaped too");
  eq(res.screenWrapped, true, "screen variant scrolls inside .rep-wrap");
  eq(res.supHasZeroOrder, true, "suppliers report includes zero-order suppliers");
  eq(res.catSorted, true, "categories report sorted by target desc");
  eq(res.catDeficit, true, "categories report shows the Excel-rule deficit");
  eq(res.defTotal, true, "deficit report footer equals the branch grid deficit");
  eq(res.defMatchesBranch, true, "clean data: grid deficit is 374");
  eq(res.printThrew, false, "printReport safe under DOM stubs");
});

/* ============================================================
   Stage 7 — settings, exports, sample data:
   backup→wipe→restore round-trip, v1 import migration, sample
   data append-only (categories byte-identical), CSV BOM/quoting
   ============================================================ */
check("stage7: dispatch + actions wired — settings real renderer; screen renders under stubs", () => {
  eq(g("SCREEN_RENDERERS.settings === renderSettings"), true, "dispatch entry is the real renderer");
  ["set-backup", "set-restore", "set-sample", "set-wipe", "set-reset",
   "csv-items", "csv-suppliers", "csv-orders"].forEach(a =>
    eq(g('typeof ACTIONS["' + a + '"]'), "function", "action " + a));
  g('state = migrateV1toV2(JSON.parse(JSON.stringify(DATA)), true); "ok"');
  g('view.screen = "settings"; view.cat = -1; render(); "ok"');
  eq(g("view.screen"), "settings", "screen sticks");
  g('view.screen = "overview"; view.cat = -1; render(); "ok"');
});

check("stage7: csvString — BOM leads (bytes EF BB BF), CRLF rows, RFC quote-escaping", () => {
  const csv = g('csvString([["a,b", "he said \\"hi\\"", "line\\nbreak"], ["x", "", null], [1, 0]])');
  eq(csv.charCodeAt(0), 0xfeff, "starts with U+FEFF");
  const bytes = Buffer.from(csv, "utf8");
  assert(bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf, "UTF-8 BOM bytes EF BB BF");
  eq(csv.slice(1),
    '"a,b","he said ""hi""","line\nbreak"\r\nx,,\r\n1,0',
    "quoting: comma/quote/newline quoted, quotes doubled, null -> empty, CRLF rows");
});

check("stage7: all three exports start with the BOM; items export columns unchanged", () => {
  g('state = migrateV1toV2(JSON.parse(JSON.stringify(DATA)), true); "ok"');
  g('confirm = () => true; loadSampleData(); "ok"');           /* so orders CSV is non-trivial */
  for (const b of ["csvItemsLines", "csvSuppliersLines", "csvOrdersLines"]) {
    const csv = g("csvString(" + b + "())");
    eq(csv.charCodeAt(0), 0xfeff, b + " starts with U+FEFF");
    const bytes = Buffer.from(csv, "utf8");
    assert(bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf, b + " BOM bytes");
    assert(csv.indexOf("\r\n") !== -1, b + " uses CRLF");
  }
  const itemsHead = JSON.parse(g("JSON.stringify(csvItemsLines()[0])"));
  eq(JSON.stringify(itemsHead), JSON.stringify(["القسم", "الكود", "الصنف الفرعي", "المستهدف",
    "إجمالي المسجل", "العجز", "نسبة الإنجاز", "الحالة", "التجاوز", "ملاحظات"]),
    "legacy الأصناف columns byte-identical");
  eq(g("csvItemsLines().length"), 1 + 814, "one line per grid row + header");
});

check("stage7: suppliers CSV — 9 columns, group/order counts, Arabic status labels", () => {
  const res = JSON.parse(g(`(() => {
    state = migrateV1toV2(JSON.parse(JSON.stringify(DATA)), true);
    const a = state.suppliers.find(s => s.name === "موبي");
    a.status = "inactive";
    a.notes = "ملاحظة, بفاصلة";
    state.orders.push({ id: "ORD-c1", supplierId: a.id, supplierName: a.name,
      orderDate: "2026-07-01T00:00:00.000Z", updatedAt: "x", status: "draft", notes: "",
      items: [{ mainCategoryId: "003", target: 5, subAllocations: {} }], posted: null });
    state.orders.push({ id: "ORD-c2", supplierId: a.id, supplierName: a.name,
      orderDate: "2026-07-02T00:00:00.000Z", updatedAt: "x", status: "pending", notes: "",
      items: [{ mainCategoryId: "003", target: 5, subAllocations: {} }], posted: null });
    const lines = csvSuppliersLines();
    const row = lines.find(l => l[1] === "موبي");
    const anyActive = lines.find(l => l[5] === "نشط");
    return JSON.stringify({ n: lines.length, head: lines[0], row,
      expCats: a.assignedCategories.length, active: !!anyActive });
  })()`));
  eq(res.n, 17, "header + 16 suppliers");
  eq(res.head.length, 9, "9 columns");
  eq(res.row[5], "غير نشط", "inactive label");
  eq(res.row[6], res.expCats, "groups count");
  eq(res.row[7], 2, "orders count");
  eq(res.row[8], "ملاحظة, بفاصلة", "notes cell raw (quoting happens in csvString)");
  eq(res.active, true, "active label present for others");
  assert(/^SUP-/.test(res.row[0]), "id column");
});

check("stage7: orders CSV — one line per order×item×sub with qty>0; names + labels resolved", () => {
  const res = JSON.parse(g(`(() => {
    state = migrateV1toV2(JSON.parse(JSON.stringify(DATA)), true);
    const sup = state.suppliers[0];
    state.orders.push({ id: "ORD-csv1", supplierId: sup.id, supplierName: sup.name,
      orderDate: "2026-07-10T00:00:00.000Z", updatedAt: "x", status: "confirmed", notes: "",
      items: [
        { mainCategoryId: "003", target: 100, subAllocations: {
          "003-001": { qty: 40, note: "عاجل, جدًا" },
          "003-002": { qty: 0, note: "صفر — يجب ألا يظهر" },
          "003-003": { qty: 15, note: "" } } },
        { mainCategoryId: "001", target: 30, subAllocations: {
          "001-001": { qty: 12, note: "" } } }
      ], posted: null });
    const lines = csvOrdersLines();
    const c3 = state.categories.find(c => c.id === "003");
    return JSON.stringify({ n: lines.length, head: lines[0],
      rows: lines.slice(1),
      sub1: c3.rows.find(r => r.id === "003-001").name,
      catName: c3.name });
  })()`));
  eq(res.n, 4, "header + 3 qty>0 lines (zero-qty sub skipped)");
  eq(res.head.length, 9, "9 columns");
  const l1 = res.rows[0];
  eq(l1[0], "ORD-csv1", "order id");
  assert(l1[1] && l1[1] !== "—", "date formatted");
  assert(/\d/.test(l1[1]) && !/[٠-٩]/.test(l1[1]), "western digits in date");
  eq(l1[3], "مؤكد", "status label Arabic");
  eq(l1[4], res.catName, "category name resolved");
  eq(l1[5], res.sub1, "sub name resolved from rowId");
  eq(l1[6], 100, "item target repeated per line");
  eq(l1[7], 40, "qty");
  eq(l1[8], "عاجل, جدًا", "note cell raw");
  assert(!res.rows.some(l => String(l[8]).indexOf("يجب ألا يظهر") !== -1), "qty=0 line absent");
  eq(res.rows[2][4], g('state.categories.find(c => c.id === "001").name'), "second item category");
  eq(res.rows[2][7], 12, "second item qty");
});

check("stage7: sample data — append-only; state.categories byte-identical; unique names; valid", () => {
  const res = JSON.parse(g(`(() => {
    state = migrateV1toV2(JSON.parse(JSON.stringify(DATA)), true);
    confirm = () => true;
    const catsSnap = JSON.stringify(state.categories);
    const supsBefore = state.suppliers.length, ordsBefore = state.orders.length;
    loadSampleData();
    const afterOne = { sups: state.suppliers.length, ords: state.orders.length,
      catsSame: JSON.stringify(state.categories) === catsSnap };
    loadSampleData();                                   /* second load must also be safe */
    const names = state.suppliers.map(s => s.name);
    const newSups = state.suppliers.slice(supsBefore);
    const newOrds = state.orders.slice(ordsBefore);
    return JSON.stringify({ supsBefore, ordsBefore, afterOne,
      sups2: state.suppliers.length, ords2: state.orders.length,
      catsSame2: JSON.stringify(state.categories) === catsSnap,
      uniqueNames: new Set(names.map(n => n.trim())).size === names.length,
      hasSuffixed: names.indexOf("مصنع الجودة (تجريبي)") !== -1,
      hasSuffixed2: names.indexOf("مصنع الجودة (تجريبي 2)") !== -1,
      idsOk: newSups.every(s => /^SUP-/.test(s.id)) && newOrds.every(o => /^ORD-/.test(o.id)),
      statusesOk: newOrds.every(o => ["draft","pending","confirmed"].indexOf(o.status) !== -1),
      postedNull: newOrds.every(o => o.posted === null),
      itemsOk: newOrds.every(o => o.items.length > 0 && o.items.every(it =>
        Object.keys(it.subAllocations).length > 0 &&
        Object.values(it.subAllocations).every(a => a.qty > 0))),
      valid: validDataV2(state),
      fixes: sanitizeV2(JSON.parse(JSON.stringify(state))) });
  })()`));
  eq(res.supsBefore, 16, "16 suppliers before");
  eq(res.ordsBefore, 0, "0 orders before");
  eq(res.afterOne.sups, 21, "+5 suppliers");
  eq(res.afterOne.ords, 5, "+5 orders");
  eq(res.afterOne.catsSame, true, "categories byte-identical after first load");
  eq(res.sups2, 26, "+5 more on second load");
  eq(res.ords2, 10, "+5 more orders");
  eq(res.catsSame2, true, "categories byte-identical after second load");
  eq(res.uniqueNames, true, "supplier names stay unique");
  eq(res.hasSuffixed, true, "colliding sample name uniquified (تجريبي)");
  eq(res.hasSuffixed2, true, "second load uniquified again (تجريبي 2)");
  eq(res.idsOk, true, "fresh SUP-/ORD- ids");
  eq(res.statusesOk, true, "sample statuses within the enum");
  eq(res.postedNull, true, "sample orders never posted");
  eq(res.itemsOk, true, "every sample order has items with qty>0 allocations");
  eq(res.valid, true, "state validDataV2");
  eq(res.fixes, 0, "sanitizeV2 finds nothing to fix");
});

check("stage7: sample data — declined confirm adds nothing; empty-suppliers state skips the confirm", () => {
  const res = JSON.parse(g(`(() => {
    state = migrateV1toV2(JSON.parse(JSON.stringify(DATA)), true);
    let asked = 0;
    confirm = () => { asked++; return false; };
    loadSampleData();
    const declined = { asked, sups: state.suppliers.length, ords: state.orders.length };
    state.suppliers = []; state.orders = [];
    asked = 0;
    loadSampleData();                        /* nothing to overwrite -> no confirm */
    const empty = { asked, sups: state.suppliers.length, ords: state.orders.length };
    confirm = () => true;
    return JSON.stringify({ declined, empty });
  })()`));
  eq(res.declined.asked, 1, "confirm asked once when suppliers exist");
  eq(res.declined.sups, 16, "declined: no suppliers added");
  eq(res.declined.ords, 0, "declined: no orders added");
  eq(res.empty.asked, 0, "no confirm on empty suppliers");
  eq(res.empty.sups, 5, "empty state: 5 sample suppliers");
  eq(res.empty.ords, 5, "empty state: 5 sample orders");
});

check("stage7: wipe — exactly two confirms; suppliers+orders cleared; grid byte-identical; declines abort", () => {
  const res = JSON.parse(g(`(() => {
    state = migrateV1toV2(JSON.parse(JSON.stringify(DATA)), true);
    confirm = () => true;
    loadSampleData();
    const catsSnap = JSON.stringify(state.categories);
    let asked = 0;
    confirm = () => { asked++; return true; };
    wipeOrdersAndSuppliers();
    const wiped = { asked, sups: state.suppliers.length, ords: state.orders.length,
      catsSame: JSON.stringify(state.categories) === catsSnap };
    /* refill, then decline on the FIRST confirm */
    confirm = () => true;
    loadSampleData();
    asked = 0;
    confirm = () => { asked++; return false; };
    wipeOrdersAndSuppliers();
    const firstNo = { asked, sups: state.suppliers.length, ords: state.orders.length };
    /* decline on the SECOND confirm */
    asked = 0;
    confirm = () => { asked++; return asked === 1; };
    wipeOrdersAndSuppliers();
    const secondNo = { asked, sups: state.suppliers.length, ords: state.orders.length };
    confirm = () => true;
    return JSON.stringify({ wiped, firstNo, secondNo });
  })()`));
  eq(res.wiped.asked, 2, "double confirm");
  eq(res.wiped.sups, 0, "suppliers cleared");
  eq(res.wiped.ords, 0, "orders cleared");
  eq(res.wiped.catsSame, true, "grid byte-identical");
  eq(res.firstNo.asked, 1, "first decline stops at one prompt");
  eq(res.firstNo.sups, 5, "first decline: nothing wiped");
  eq(res.secondNo.asked, 2, "second prompt reached");
  eq(res.secondNo.sups, 5, "second decline: nothing wiped");
  eq(res.secondNo.ords, 5, "second decline: orders kept");
});

check("stage7: backup → wipe → restore deep-equals (bare object AND {savedAt,data} envelope)", () => {
  const res = JSON.parse(g(`(() => {
    state = migrateV1toV2(JSON.parse(JSON.stringify(DATA)), true);
    confirm = () => true;
    loadSampleData();
    state.categories[2].rows[0].note = "ملاحظة قبل النسخ";
    const backupTxt = JSON.stringify(state, null, 2);   /* exactly what exportJSON writes */
    const canonical = JSON.stringify(state);
    wipeOrdersAndSuppliers();
    const wiped = state.suppliers.length === 0 && state.orders.length === 0;
    const ok1 = applyImportedText(backupTxt);
    const eq1 = JSON.stringify(state) === canonical;
    /* envelope round-trip too (a saved v2 localStorage blob used as a file) */
    wipeOrdersAndSuppliers();
    const ok2 = applyImportedText(JSON.stringify({ savedAt: "2026-01-01T00:00:00.000Z",
      data: JSON.parse(backupTxt) }));
    const eq2 = JSON.stringify(state) === canonical;
    return JSON.stringify({ wiped, ok1, eq1, ok2, eq2, valid: validDataV2(state) });
  })()`));
  eq(res.wiped, true, "wipe emptied suppliers+orders");
  eq(res.ok1, true, "bare-object restore accepted");
  eq(res.eq1, true, "restored state deep-equals the backup");
  eq(res.ok2, true, "envelope restore accepted");
  eq(res.eq2, true, "envelope restore deep-equals too");
  eq(res.valid, true, "restored state valid");
});

check("stage7: v1-array import migrates with invariants intact; persists only after success", () => {
  store.clear();
  const res = JSON.parse(g(`(() => {
    state = migrateV1toV2(JSON.parse(JSON.stringify(DATA)), true);
    const ok = applyImportedText(JSON.stringify(DATA));   /* bare v1 array file */
    return JSON.stringify({ ok, version: state.version,
      cats: state.categories.length, sups: state.suppliers.length,
      ords: state.orders.length });
  })()`));
  eq(res.ok, true, "v1 file accepted");
  eq(res.version, 2, "migrated to v2");
  eq(res.cats, 21, "21 categories");
  eq(res.sups, 16, "16 suppliers");
  eq(res.ords, 0, "no fabricated orders");
  const b = branchCalcOf(g("state.categories"));
  eq(b.target, 1000, "target"); eq(b.reg, 1877, "reg");
  eq(b.deficit, 374, "deficit"); eq(b.excess, 202, "excess");
  const rawV2 = localStorage.getItem("qween-dashboard-v2");
  assert(rawV2, "successful import persisted to the v2 key");
  eq(JSON.parse(rawV2).data.version, 2, "persisted envelope is v2");
});

check("stage7: bad imports rejected with rollback — index2-shaped, truncated, wrong version; nothing persisted", () => {
  const res = JSON.parse(g(`(() => {
    state = migrateV1toV2(JSON.parse(JSON.stringify(DATA)), true);
    persistNow();
    const snap = JSON.stringify(state);
    const rawBefore = localStorage.getItem(LS_KEY_V2);
    /* index2-shaped: {categories,suppliers,orders} but NO version field */
    const index2ish = JSON.stringify({
      categories: [{ id: "001", name: "الفحم - قطاعي", subs: ["فحم مشب"] }],
      suppliers: [{ id: "sup1", name: "مورد", status: "active" }],
      orders: [] });
    const r1 = applyImportedText(index2ish);
    const s1 = JSON.stringify(state) === snap;
    const r2 = applyImportedText('{"version":2,"categories":');   /* truncated */
    const s2 = JSON.stringify(state) === snap;
    const r3 = applyImportedText(JSON.stringify({ version: 3, categories: [], suppliers: [], orders: [] }));
    const s3 = JSON.stringify(state) === snap;
    const r4 = applyImportedText("null");
    const s4 = JSON.stringify(state) === snap;
    const rawSame = localStorage.getItem(LS_KEY_V2) === rawBefore;
    return JSON.stringify({ r1, s1, r2, s2, r3, s3, r4, s4, rawSame });
  })()`));
  eq(res.r1, false, "index2-shaped rejected");
  eq(res.s1, true, "rollback after index2-shaped");
  eq(res.r2, false, "truncated rejected");
  eq(res.s2, true, "rollback after truncated");
  eq(res.r3, false, "wrong version rejected");
  eq(res.s3, true, "rollback after wrong version");
  eq(res.r4, false, "null rejected");
  eq(res.s4, true, "rollback after null");
  eq(res.rawSame, true, "v2 key never rewritten by failed imports");
});

check("stage7: utf8Bytes exact vs Buffer; fmtBytes units; storageBytesApprox matches the stored blob", () => {
  for (const s of ["a", "é", "ع", "€", "😀", "سائل يدين 500 مل\r\n\"quoted\"", ""]) {
    eq(g("utf8Bytes(" + JSON.stringify(s) + ")"), Buffer.byteLength(s, "utf8"),
      "utf8Bytes(" + JSON.stringify(s) + ")");
  }
  eq(g("fmtBytes(500)"), "500 بايت", "bytes unit");
  eq(g("fmtBytes(2048)"), "2 كيلوبايت", "KB unit");
  eq(g("fmtBytes(3 * 1024 * 1024)"), "3 ميجابايت", "MB unit");
  assert(g("fmtBytes(1536)").indexOf("2") === 0, "rounded KB");
  g("persistNow(); \"ok\"");
  const raw = localStorage.getItem("qween-dashboard-v2");
  assert(raw, "v2 blob present");
  eq(g("storageBytesApprox()"), Buffer.byteLength(raw, "utf8"), "approx == stored blob bytes");
});

check("stage7: renderSettings + settings actions run under stubs; toolbar buttons still wired", () => {
  g('state = migrateV1toV2(JSON.parse(JSON.stringify(DATA)), true); confirm = () => true; "ok"');
  g('view.screen = "settings"; view.cat = -1; render(); "ok"');
  g('renderSettings(); "ok"');                       /* direct call too */
  g('ACTIONS["csv-items"](); ACTIONS["csv-suppliers"](); ACTIONS["csv-orders"](); "ok"');
  g('ACTIONS["set-backup"](); "ok"');
  g('ACTIONS["set-restore"](); "ok"');               /* clicks the stubbed file input */
  eq(g("typeof exportJSON"), "function", "toolbar exportJSON intact");
  eq(g("typeof exportCSV"), "function", "toolbar exportCSV intact");
  eq(g("typeof resetAll"), "function", "toolbar resetAll intact");
  eq(g("typeof importJSON"), "function", "toolbar importJSON intact");
  g('view.screen = "overview"; view.cat = -1; render(); "ok"');
});

console.log("\n" + passed + " passed, " + failed + " failed");
process.exit(failed ? 1 : 0);
