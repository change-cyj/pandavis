/* ============================================================
 * PandaVis app — UI controller
 * State, i18n, sidebar ops, table/output/code/history panes,
 * charts, data loading, tour. Depends on PV, Charts, I18N,
 * BUILTIN_DATASETS, echarts, XLSX.
 * ============================================================ */
"use strict";

/* ---------------- tiny helpers ---------------- */
const $ = s => document.querySelector(s);
const $$ = s => [...document.querySelectorAll(s)];
const esc = s => String(s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

const state = {
  lang: localStorage.getItem("pv.lang") || "zh",
  theme: localStorage.getItem("pv.theme") || "light",
  df: null, df0: null, dsName: "", dsId: "",
  history: [], histIndex: 0,
  code: [],
  page: 1, pageSize: 50, sortView: null,
  output: null,            // {df, titleKey}
  chart: null, lastChartSpec: null,
  extraDatasets: [],       // uploaded datasets available for merge
  builtinCache: {},
  tour: null,
};

function t(key, vars) {
  let s = (I18N[state.lang] && I18N[state.lang][key]) ?? I18N.zh[key] ?? key;
  if (vars) for (const k of Object.keys(vars)) s = s.replaceAll(`{${k}}`, vars[k]);
  return s;
}

function toast(msg, kind = "ok") {
  const el = document.createElement("div");
  el.className = "toast" + (kind === "err" ? " err" : kind === "info" ? " info" : "");
  el.textContent = msg;
  $("#toast-box").appendChild(el);
  setTimeout(() => { el.classList.add("out"); setTimeout(() => el.remove(), 350); }, 3200);
}

function download(filename, text, mime = "text/plain") {
  const blob = text instanceof Blob ? text : new Blob([text], { type: mime + ";charset=utf-8" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 4000);
}

const fmtVal = v => v === null || v === undefined
  ? `<span class="nan">${esc(t("table.null"))}</span>`
  : typeof v === "number" ? esc(Charts.fmtNum(v)) : esc(v);

/* ============================================================
 * Sidebar operation definitions
 * ============================================================ */
const AGG_FUNCS = ["sum", "mean", "median", "min", "max", "count", "nunique", "std", "var", "first", "last"];
const COND_OPS = ["eq", "ne", "gt", "gte", "lt", "lte", "contains", "notcontains", "startswith", "endswith", "isin", "isnull", "notnull"];

function condToCode(c) {
  const ref = `df['${c.col}']`;
  const raw = String(c.value ?? "");
  const v = PV.NUM_RE.test(raw.trim()) ? raw.trim() : `'${raw}'`;
  switch (c.op) {
    case "eq": return `(${ref} == ${v})`;
    case "ne": return `(${ref} != ${v})`;
    case "gt": return `(${ref} > ${v})`;
    case "gte": return `(${ref} >= ${v})`;
    case "lt": return `(${ref} < ${v})`;
    case "lte": return `(${ref} <= ${v})`;
    case "contains": return `(${ref}.str.contains('${raw}', na=False))`;
    case "notcontains": return `(~${ref}.str.contains('${raw}', na=False))`;
    case "startswith": return `(${ref}.str.startswith('${raw}', na=False))`;
    case "endswith": return `(${ref}.str.endswith('${raw}', na=False))`;
    case "isin": return `(${ref}.isin([${raw.split(",").map(x => `'${x.trim()}'`).join(", ")}]))`;
    case "isnull": return `(${ref}.isna())`;
    case "notnull": return `(${ref}.notna())`;
    default: return "";
  }
}
const quoteList = arr => arr.map(c => `'${c}'`).join(", ");

/* ---- generic field builders ---- */
function el(tag, cls, html) { const e = document.createElement(tag); if (cls) e.className = cls; if (html !== undefined) e.innerHTML = html; return e; }

function fld(labelKey, control) {
  const w = el("label", "fld");
  w.appendChild(el("span", "", esc(t(labelKey))));
  w.appendChild(control);
  return w;
}
function colSelect(filter = "any", withNone = false) {
  const s = el("select", "col-sel");
  s.dataset.filter = filter;
  if (withNone) s.dataset.none = "1";
  return s;
}
function colChecks(filter = "any") {
  const d = el("div", "col-checks check-list");
  d.dataset.filter = filter;
  return d;
}
function numInput(val, min = 0) { const i = el("input"); i.type = "number"; i.value = val; i.min = min; return i; }
function txtInput(ph = "") { const i = el("input"); i.type = "text"; i.placeholder = ph; return i; }
function optSelect(pairs) { // [[value, labelKeyOrRaw, isRaw]]
  const s = el("select");
  for (const [v, lab, raw] of pairs) {
    const o = el("option", "", esc(raw ? lab : t(lab)));
    o.value = v; s.appendChild(o);
  }
  return s;
}

/* dynamic row builders */
function queryRow() {
  const r = el("div", "dyn-row");
  r.appendChild(colSelect("any"));
  const ops = optSelect(COND_OPS.map(o => [o, "cond." + o]));
  r.appendChild(ops);
  const val = txtInput(); r.appendChild(val);
  const rm = el("button", "rm", "×"); rm.type = "button"; rm.onclick = () => r.remove(); r.appendChild(rm);
  r.collect = () => ({ col: r.children[0].value, op: ops.value, value: val.value });
  return r;
}
function sortRow() {
  const r = el("div", "dyn-row");
  r.appendChild(colSelect("any"));
  const dir = optSelect([["asc", "op.sort.asc"], ["desc", "op.sort.desc2"]]);
  r.appendChild(dir);
  const rm = el("button", "rm", "×"); rm.type = "button"; rm.onclick = () => r.remove(); r.appendChild(rm);
  r.collect = () => ({ col: r.children[0].value, asc: dir.value === "asc" });
  return r;
}
function aggRow() {
  const r = el("div", "dyn-row");
  r.appendChild(colSelect("any"));
  const f = optSelect(AGG_FUNCS.map(a => [a, "agg." + a]));
  f.value = "mean";
  r.appendChild(f);
  const rm = el("button", "rm", "×"); rm.type = "button"; rm.onclick = () => r.remove(); r.appendChild(rm);
  r.collect = () => ({ col: r.children[0].value, func: f.value });
  return r;
}
function dynBuilder(rowFn, addLabelKey) {
  const box = el("div", "dyn-box");
  const rows = el("div", "dyn-rows");
  const add = el("button", "btn sm add-row", "+ " + esc(t(addLabelKey)));
  add.type = "button";
  add.onclick = () => { rows.appendChild(rowFn()); populateColumnControls(rows); };
  box.appendChild(rows); box.appendChild(add);
  box.addRow = () => { rows.appendChild(rowFn()); populateColumnControls(rows); };
  box.collect = () => [...rows.children].map(r => r.collect());
  return box;
}

/* ---- op definitions ---- */
const OPS = [
  /* ===== Inspect & statistics ===== */
  {
    id: "head", sec: "inspect",
    fields: b => { b.n = numInput(5, 1); b.body.appendChild(fld("common.n", b.n)); },
    run: b => ({ kind: "view", df: state.df.head(+b.n.value || 5), code: t("code.head", { n: +b.n.value || 5 }) })
  },
  {
    id: "tail", sec: "inspect",
    fields: b => { b.n = numInput(5, 1); b.body.appendChild(fld("common.n", b.n)); },
    run: b => ({ kind: "view", df: state.df.tail(+b.n.value || 5), code: t("code.tail", { n: +b.n.value || 5 }) })
  },
  {
    id: "sample", sec: "inspect",
    fields: b => { b.n = numInput(5, 1); b.body.appendChild(fld("common.n", b.n)); },
    run: b => ({ kind: "view", df: state.df.sample(+b.n.value || 5), code: t("code.sample", { n: +b.n.value || 5 }) })
  },
  { id: "info", sec: "inspect", fields: () => { }, run: () => ({ kind: "info", code: t("code.info") }) },
  { id: "describe", sec: "inspect", fields: () => { }, run: () => ({ kind: "view", df: state.df.describe(), code: t("code.describe") }) },
  { id: "corr", sec: "inspect", fields: () => { }, run: () => ({ kind: "view", df: state.df.corr(), code: t("code.corr") }) },
  {
    id: "value_counts", sec: "inspect",
    fields: b => {
      b.col = colSelect("any"); b.top = numInput(10, 0);
      b.body.appendChild(fld("common.col", b.col));
      b.body.appendChild(fld("op.vc.top", b.top));
    },
    run: b => ({ kind: "view", df: state.df.valueCounts(b.col.value, +b.top.value || undefined), code: t("code.value_counts", { col: b.col.value }) })
  },

  /* ===== Cleaning ===== */
  {
    id: "dropna", sec: "clean",
    fields: b => {
      b.subset = colChecks("any"); b.how = optSelect([["any", "op.dropna.any"], ["all", "op.dropna.all"]]);
      b.body.appendChild(fld("op.dropna.subset", b.subset));
      b.body.appendChild(fld("op.dropna.how", b.how));
    },
    run: b => {
      const subset = checkedVals(b.subset);
      const ndf = state.df.dropna(subset, b.how.value);
      const code = subset.length ? t("code.dropna", { subset: quoteList(subset), how: b.how.value }) : t("code.dropna.all", { how: b.how.value });
      return { kind: "transform", df: ndf, code, toastKey: "toast.rows.removed", toastVars: { n: state.df.rows.length - ndf.rows.length } };
    }
  },
  {
    id: "fillna", sec: "clean",
    fields: b => {
      b.col = colSelect("any");
      b.method = optSelect([["value", "op.fillna.value"], ["mean", "op.fillna.mean"], ["median", "op.fillna.median"], ["mode", "op.fillna.mode"], ["ffill", "op.fillna.ffill"], ["bfill", "op.fillna.bfill"]]);
      b.val = txtInput();
      b.valFld = fld("op.fillna.input", b.val);
      b.method.onchange = () => { b.valFld.style.display = b.method.value === "value" ? "" : "none"; };
      b.method.onchange();
      b.body.appendChild(fld("common.col", b.col));
      b.body.appendChild(fld("op.fillna.method", b.method));
      b.body.appendChild(b.valFld);
    },
    run: b => {
      const col = b.col.value, m = b.method.value;
      const before = state.df.col(col).filter(v => v === null).length;
      const ndf = state.df.fillna(col, m, b.val.value);
      const after = ndf.col(col).filter(v => v === null).length;
      let code;
      if (m === "value") {
        const raw = b.val.value;
        code = t("code.fillna.value", { col, value: PV.NUM_RE.test(raw.trim()) ? raw.trim() : `'${raw}'` });
      } else if (m === "ffill" || m === "bfill") code = t("code.fillna." + m, { col });
      else code = t("code.fillna.stat", { col, method: m });
      return { kind: "transform", df: ndf, code, toastKey: "toast.filled", toastVars: { n: before - after } };
    }
  },
  {
    id: "dropdup", sec: "clean",
    fields: b => { b.subset = colChecks("any"); b.body.appendChild(fld("op.dropdup.subset", b.subset)); },
    run: b => {
      const subset = checkedVals(b.subset);
      const ndf = state.df.dropDuplicates(subset);
      const code = subset.length ? t("code.dropdup", { subset: quoteList(subset) }) : t("code.dropdup.all");
      return { kind: "transform", df: ndf, code, toastKey: "toast.dup.removed", toastVars: { n: state.df.rows.length - ndf.rows.length } };
    }
  },
  {
    id: "astype", sec: "clean",
    fields: b => {
      b.col = colSelect("any");
      b.to = optSelect([["number", "type.number"], ["string", "type.string"], ["date", "type.date"], ["boolean", "type.boolean"]]);
      b.body.appendChild(fld("common.col", b.col));
      b.body.appendChild(fld("op.astype.to", b.to));
    },
    run: b => ({
      kind: "transform", df: state.df.astype(b.col.value, b.to.value),
      code: t("code.astype", { col: b.col.value, type: b.to.value }), toastKey: "toast.casted"
    })
  },
  {
    id: "rename", sec: "clean",
    fields: b => {
      b.col = colSelect("any"); b.nn = txtInput();
      b.body.appendChild(fld("common.col", b.col));
      b.body.appendChild(fld("op.rename.new", b.nn));
    },
    run: b => {
      if (!b.nn.value.trim()) throw new Error(t("op.rename.new"));
      return {
        kind: "transform", df: state.df.renameColumns({ [b.col.value]: b.nn.value.trim() }),
        code: t("code.rename", { old: b.col.value, new: b.nn.value.trim() }), toastKey: "toast.renamed"
      };
    }
  },
  {
    id: "dropcol", sec: "clean",
    fields: b => { b.cols = colChecks("any"); b.body.appendChild(fld("common.cols", b.cols)); },
    run: b => {
      const cols = checkedVals(b.cols);
      if (!cols.length) throw new Error(t("common.cols"));
      return { kind: "transform", df: state.df.dropColumns(cols), code: t("code.dropcol", { cols: quoteList(cols) }), toastKey: "toast.cols.dropped", toastVars: { n: cols.length } };
    }
  },
  {
    id: "selectcol", sec: "clean",
    fields: b => { b.cols = colChecks("any"); b.body.appendChild(fld("common.cols", b.cols)); },
    run: b => {
      const cols = checkedVals(b.cols);
      if (!cols.length) throw new Error(t("common.cols"));
      return { kind: "transform", df: state.df.selectColumns(cols), code: t("code.selectcol", { cols: quoteList(cols) }), toastKey: "toast.op.ok", toastVars: { r: state.df.rows.length, c: cols.length } };
    }
  },

  /* ===== Filter & sort ===== */
  {
    id: "query", sec: "filter",
    fields: b => {
      b.builder = dynBuilder(queryRow, "op.query.add");
      b.logic = optSelect([["and", "op.query.and"], ["or", "op.query.or"]]);
      b.body.appendChild(b.builder);
      b.body.appendChild(fld("op.query.logic", b.logic));
      b.builder.addRow();
    },
    run: b => {
      const conds = b.builder.collect().filter(c => c.col && c.op);
      if (!conds.length) throw new Error(t("op.query"));
      const logic = b.logic.value;
      const ndf = state.df.query(conds, logic);
      const code = t("code.query.and", { conds: conds.map(condToCode).join(logic === "or" ? " | " : " & ") });
      return { kind: "transform", df: ndf, code, toastKey: "toast.rows.kept", toastVars: { n: ndf.rows.length } };
    }
  },
  {
    id: "sort", sec: "filter",
    fields: b => {
      b.builder = dynBuilder(sortRow, "op.sort.add");
      b.body.appendChild(b.builder);
      b.builder.addRow();
    },
    run: b => {
      const by = b.builder.collect().filter(c => c.col);
      if (!by.length) throw new Error(t("op.sort"));
      const ndf = state.df.sortValues(by);
      const code = t("code.sort", { cols: quoteList(by.map(x => x.col)), asc: by.map(x => x.asc ? "True" : "False").join(", ") });
      return { kind: "transform", df: ndf, code, toastKey: "toast.sorted" };
    }
  },
  {
    id: "slice", sec: "filter",
    fields: b => {
      b.from = numInput(0, 0); b.to = numInput(100, 0);
      b.body.appendChild(fld("op.slice.from", b.from));
      b.body.appendChild(fld("op.slice.to", b.to));
    },
    run: b => {
      const s = +b.from.value || 0, e = +b.to.value || state.df.rows.length;
      const ndf = state.df.sliceRows(s, e);
      return { kind: "transform", df: ndf, code: t("code.slice", { start: s, end: e }), toastKey: "toast.rows.kept", toastVars: { n: ndf.rows.length } };
    }
  },

  /* ===== Transform & aggregate ===== */
  {
    id: "groupby", sec: "transform",
    fields: b => {
      b.keys = colChecks("any");
      b.builder = dynBuilder(aggRow, "op.groupby.add");
      b.body.appendChild(fld("op.groupby.keys", b.keys));
      b.body.appendChild(fld("op.groupby.aggs", b.builder));
      b.builder.addRow();
    },
    run: b => {
      const keys = checkedVals(b.keys);
      const aggs = b.builder.collect().filter(a => a.col && a.func);
      if (!keys.length || !aggs.length) throw new Error(t("op.groupby"));
      const ndf = state.df.groupby(keys, aggs);
      const byCol = {};
      for (const a of aggs) (byCol[a.col] = byCol[a.col] || new Set()).add(a.func);
      const aggStr = Object.entries(byCol).map(([c, fs]) => `'${c}': [${[...fs].map(f => `'${f}'`).join(", ")}]`).join(", ");
      return { kind: "view", df: ndf, code: t("code.groupby", { keys: quoteList(keys), aggs: aggStr }) };
    }
  },
  {
    id: "pivot", sec: "transform",
    fields: b => {
      b.index = colSelect("any"); b.columns = colSelect("any"); b.values = colSelect("any");
      b.agg = optSelect(AGG_FUNCS.map(a => [a, "agg." + a])); b.agg.value = "mean";
      b.body.appendChild(fld("op.pivot.index", b.index));
      b.body.appendChild(fld("op.pivot.columns", b.columns));
      b.body.appendChild(fld("op.pivot.values", b.values));
      b.body.appendChild(fld("op.pivot.agg", b.agg));
    },
    run: b => ({
      kind: "view",
      df: state.df.pivot(b.index.value, b.columns.value, b.values.value, b.agg.value),
      code: t("code.pivot", { index: b.index.value, columns: b.columns.value, values: b.values.value, agg: b.agg.value })
    })
  },
  {
    id: "addcol", sec: "transform",
    fields: b => buildAddcolForm(b),
    run: b => collectAddcol(b)
  },
  {
    id: "merge", sec: "transform",
    fields: b => {
      b.other = el("select"); b.other.id = "merge-other";
      b.lefton = colSelect("any");
      b.righton = el("select");
      b.how = optSelect([["inner", "inner", 1], ["left", "left", 1], ["right", "right", 1], ["outer", "outer", 1]]);
      b.body.appendChild(fld("op.merge.other", b.other));
      b.body.appendChild(fld("op.merge.lefton", b.lefton));
      b.body.appendChild(fld("op.merge.righton", b.righton));
      b.body.appendChild(fld("op.merge.how", b.how));
      b.other.onchange = () => populateMergeKey(b);
    },
    run: b => {
      const other = getMergeOther(b);
      if (!other) throw new Error(t("op.merge.other"));
      const ndf = state.df.merge(other, b.lefton.value, b.righton.value, b.how.value);
      const code = t("code.merge", { left: b.lefton.value, right: b.righton.value, how: b.how.value });
      return { kind: "transform", df: ndf, code, toastKey: "toast.merged", toastVars: { r: ndf.rows.length, c: ndf.columns.length } };
    }
  },
];

/* ---- addcol form (mode switch) ---- */
function buildAddcolForm(b) {
  b.name = txtInput();
  b.mode = optSelect([["arith", "op.addcol.arith"], ["str", "op.addcol.str"], ["date", "op.addcol.date"], ["cond", "op.addcol.cond"], ["cut", "op.addcol.cut"]]);
  b.body.appendChild(fld("op.addcol.name", b.name));
  b.body.appendChild(fld("op.addcol.mode", b.mode));
  const panels = el("div", "mode-panels");
  b.body.appendChild(panels);

  // arithmetic
  const pa = el("div"); pa.dataset.mode = "arith";
  b.aColA = colSelect("number");
  b.aOp = optSelect([["+", "+", 1], ["-", "-", 1], ["*", "*", 1], ["/", "/", 1], ["%", "%", 1], ["**", "**", 1]]);
  b.aOperand = optSelect([["const", "op.addcol.operand.const"], ["column", "op.addcol.operand.col"]]);
  b.aColB = colSelect("number");
  b.aConst = numInput(2);
  b.aColBwrap = fld("op.addcol.operand.col", b.aColB);
  b.aConstwrap = fld("op.addcol.operand.const", b.aConst);
  b.aOperand.onchange = () => {
    b.aColBwrap.style.display = b.aOperand.value === "column" ? "" : "none";
    b.aConstwrap.style.display = b.aOperand.value === "const" ? "" : "none";
  };
  pa.appendChild(fld("common.col", b.aColA));
  pa.appendChild(fld("op.addcol.arith", b.aOp));
  pa.appendChild(fld("op.addcol.mode", b.aOperand));
  pa.appendChild(b.aConstwrap); pa.appendChild(b.aColBwrap);
  b.aOperand.onchange();
  panels.appendChild(pa);

  // string
  const ps = el("div"); ps.dataset.mode = "str";
  b.sCol = colSelect("any");
  b.sFunc = optSelect(["upper", "lower", "title", "trim", "length", "slice", "replace", "contains", "concat"].map(f => [f, "op.addcol.str." + f]));
  b.sArgA = txtInput(); b.sArgB = txtInput();
  b.sArgAw = fld("op.addcol.argA", b.sArgA); b.sArgBw = fld("op.addcol.argB", b.sArgB);
  b.sFunc.onchange = () => {
    const need = { slice: 2, replace: 2, contains: 1, concat: 1 }[b.sFunc.value] || 0;
    b.sArgAw.style.display = need >= 1 ? "" : "none";
    b.sArgBw.style.display = need >= 2 ? "" : "none";
  };
  ps.appendChild(fld("common.col", b.sCol));
  ps.appendChild(fld("op.addcol.str", b.sFunc));
  ps.appendChild(b.sArgAw); ps.appendChild(b.sArgBw);
  b.sFunc.onchange();
  panels.appendChild(ps);

  // date
  const pd = el("div"); pd.dataset.mode = "date";
  b.dCol = colSelect("any");
  b.dPart = optSelect(["year", "month", "day", "weekday", "quarter", "hour", "ym"].map(p => [p, "op.addcol.date." + p]));
  pd.appendChild(fld("common.col", b.dCol));
  pd.appendChild(fld("op.addcol.date", b.dPart));
  panels.appendChild(pd);

  // conditional
  const pc = el("div"); pc.dataset.mode = "cond";
  b.cCol = colSelect("any");
  b.cOp = optSelect(COND_OPS.map(o => [o, "cond." + o]));
  b.cVal = txtInput();
  const mkTE = () => {
    const type = optSelect([["const", "common.value", 0], ["column", "op.addcol.cond.fromcol"]]);
    type.children[0].textContent = t("common.value");
    const val = txtInput(); const col = colSelect("any");
    const wrap = el("div");
    const vf = fld("common.value", val), cf = fld("op.addcol.cond.fromcol", col);
    type.onchange = () => { vf.style.display = type.value === "const" ? "" : "none"; cf.style.display = type.value === "column" ? "" : "none"; };
    wrap.appendChild(fld("op.addcol.mode", type)); wrap.appendChild(vf); wrap.appendChild(cf);
    type.onchange();
    return { wrap, type, val, col };
  };
  b.cThen = mkTE(); b.cElse = mkTE();
  pc.appendChild(fld("op.addcol.cond.if", b.cCol));
  pc.appendChild(fld("op.query", b.cOp));
  pc.appendChild(fld("common.value", b.cVal));
  pc.appendChild(el("hr", "sep"));
  pc.appendChild(el("p", "hint", esc(t("op.addcol.cond.then"))));
  pc.appendChild(b.cThen.wrap);
  pc.appendChild(el("p", "hint", esc(t("op.addcol.cond.else"))));
  pc.appendChild(b.cElse.wrap);
  panels.appendChild(pc);

  // cut
  const pu = el("div"); pu.dataset.mode = "cut";
  b.uCol = colSelect("number");
  b.uEdges = txtInput(t("op.addcol.cut.edges.ph"));
  b.uLabels = txtInput();
  pu.appendChild(fld("common.col", b.uCol));
  pu.appendChild(fld("op.addcol.cut.edges", b.uEdges));
  pu.appendChild(fld("op.addcol.cut.labels", b.uLabels));
  panels.appendChild(pu);

  b.mode.onchange = () => {
    [...panels.children].forEach(p => p.classList.toggle("on", p.dataset.mode === b.mode.value));
  };
  b.mode.onchange();
}

function collectAddcol(b) {
  const name = b.name.value.trim();
  if (!name) throw new Error(t("op.addcol.name"));
  const mode = b.mode.value;
  let spec = { mode, name }, code = "";
  if (mode === "arith") {
    spec = { ...spec, colA: b.aColA.value, op: b.aOp.value, operand: b.aOperand.value, colB: b.aColB.value, constVal: b.aConst.value };
    const rhs = spec.operand === "column" ? `df['${spec.colB}']` : String(+spec.constVal);
    code = `df['${name}'] = df['${spec.colA}'] ${spec.op} ${rhs}`;
  } else if (mode === "str") {
    spec = { ...spec, col: b.sCol.value, func: b.sFunc.value, argA: b.sArgA.value, argB: b.sArgB.value };
    const ref = `df['${spec.col}'].str`;
    const map = {
      upper: `${ref}.upper()`, lower: `${ref}.lower()`, title: `${ref}.title()`,
      trim: `${ref}.strip()`, length: `${ref}.len()`,
      slice: `${ref}[${spec.argA || 0}:${spec.argB || ""}]`,
      replace: `${ref}.replace('${spec.argA}', '${spec.argB}')`,
      contains: `${ref}.contains('${spec.argA}', na=False)`,
      concat: `df['${spec.col}'] + '${spec.argA}'`,
    };
    code = `df['${name}'] = ${map[spec.func]}`;
  } else if (mode === "date") {
    spec = { ...spec, col: b.dCol.value, part: b.dPart.value };
    const ref = `pd.to_datetime(df['${spec.col}']).dt`;
    code = spec.part === "ym"
      ? `df['${name}'] = ${ref}.strftime('%Y-%m')`
      : `df['${name}'] = ${ref}.${spec.part === "weekday" ? "dayofweek" : spec.part}`;
  } else if (mode === "cond") {
    const te = te => te.type.value === "column" ? `df['${te.col.value}']` : (PV.NUM_RE.test(te.val.value.trim()) ? te.val.value.trim() : `'${te.val.value}'`);
    spec = {
      ...spec, condCol: b.cCol.value, op: b.cOp.value, condVal: b.cVal.value,
      thenType: b.cThen.type.value, thenCol: b.cThen.col.value, thenVal: b.cThen.val.value,
      elseType: b.cElse.type.value, elseCol: b.cElse.col.value, elseVal: b.cElse.val.value,
    };
    const c = condToCode({ col: spec.condCol, op: spec.op, value: spec.condVal });
    code = `df['${name}'] = np.where(${c}, ${te(b.cThen)}, ${te(b.cElse)})`;
  } else if (mode === "cut") {
    const edges = b.uEdges.value.split(",").map(s => s.trim()).filter(Boolean);
    const labels = b.uLabels.value.split(",").map(s => s.trim()).filter(Boolean);
    spec = { ...spec, col: b.uCol.value, edges, labels };
    code = `df['${name}'] = pd.cut(df['${spec.col}'], bins=[${edges.join(", ")}]${labels.length ? `, labels=[${labels.map(l => `'${l}'`).join(", ")}]` : ""})`;
  }
  const ndf = state.df.addColumn(spec);
  return { kind: "transform", df: ndf, code, toastKey: "toast.col.added", toastVars: { name } };
}

/* ---- merge helpers ---- */
function getMergeOptions() {
  const opts = [];
  for (const d of BUILTIN_DATASETS) opts.push({ value: "builtin:" + d.id, label: (state.lang === "zh" ? d.name_zh : d.name_en) });
  for (const d of state.extraDatasets) opts.push({ value: "extra:" + d.name, label: d.name });
  return opts;
}
function getMergeOther(b) {
  const v = b.other.value;
  if (!v) return null;
  if (v.startsWith("builtin:")) {
    const id = v.slice(8);
    if (!state.builtinCache[id]) {
      const d = BUILTIN_DATASETS.find(x => x.id === id);
      state.builtinCache[id] = PV.DataFrame.fromCSV(d.csv, id);
    }
    return state.builtinCache[id];
  }
  const ex = state.extraDatasets.find(x => "extra:" + x.name === v);
  return ex ? ex.df : null;
}
function populateMergeKey(b) {
  const other = getMergeOther(b);
  fillSelect(b.righton, other ? other.columns : []);
}
function refreshMergeSelects() {
  const b = OPS.find(o => o.id === "merge")._b;
  if (!b) return;
  const cur = b.other.value;
  fillSelect(b.other, getMergeOptions().map(o => o.value), getMergeOptions().map(o => o.label));
  if ([...b.other.options].some(o => o.value === cur)) b.other.value = cur;
  populateMergeKey(b);
}

/* ---- checked checkbox values ---- */
function checkedVals(box) { return [...box.querySelectorAll("input:checked")].map(i => i.value); }

/* ============================================================
 * Sidebar construction
 * ============================================================ */
function buildSidebar() {
  for (const op of OPS) {
    const card = el("div", "op-card");
    card.dataset.op = op.id;
    const head = el("div", "op-head");
    const titles = el("div", "op-titles");
    titles.appendChild(el("div", "op-name", esc(t("op." + op.id))));
    titles.appendChild(el("div", "op-desc", esc(t("op." + op.id + ".desc"))));
    head.appendChild(titles);
    head.appendChild(el("span", "chev", "▶"));
    const body = el("div", "op-body");
    const b = { body };
    op.fields(b);
    const runBtn = el("button", "btn primary block", esc(t("run")));
    runBtn.type = "button";
    runBtn.onclick = () => runOp(op.id);
    body.appendChild(runBtn);
    head.onclick = () => card.classList.toggle("open");
    card.appendChild(head); card.appendChild(body);
    $("#sec-" + op.sec).appendChild(card);
    op._b = b; op._card = card;
  }
}

function fillSelect(sel, values, labels) {
  const cur = sel.value;
  sel.innerHTML = "";
  if (sel.dataset.none === "1") {
    const o = el("option", "", esc(t("chart.none"))); o.value = "__none__"; sel.appendChild(o);
  }
  values.forEach((v, i) => {
    const o = el("option", "", esc(labels ? labels[i] : v));
    o.value = v; sel.appendChild(o);
  });
  if (values.includes(cur)) sel.value = cur;
}

function populateColumnControls(root = document) {
  if (!state.df) return;
  const df = state.df;
  const byFilter = f =>
    f === "number" ? df.numericColumns() :
    f === "category" ? df.categoricalColumns() :
    f === "date" ? df.dateColumns() : df.columns;
  root.querySelectorAll("select.col-sel").forEach(sel => {
    let cols = byFilter(sel.dataset.filter || "any");
    if (!cols.length) cols = df.columns;
    fillSelect(sel, cols);
  });
  root.querySelectorAll(".col-checks").forEach(box => {
    const was = new Set(checkedVals(box));
    let cols = byFilter(box.dataset.filter || "any");
    if (!cols.length) cols = df.columns;
    box.innerHTML = "";
    for (const c of cols) {
      const lab = el("label");
      const cb = el("input"); cb.type = "checkbox"; cb.value = c;
      cb.checked = was.has(c);
      lab.appendChild(cb);
      lab.appendChild(document.createTextNode(c));
      box.appendChild(lab);
    }
  });
  refreshMergeSelects();
  populateChartControls();
}

/* ============================================================
 * Running operations
 * ============================================================ */
function runOp(id) {
  const op = OPS.find(o => o.id === id);
  if (!op || !state.df) { toast(t("toast.need.data"), "err"); return; }
  let res;
  try { res = op.run(op._b); }
  catch (e) { toast(t("toast.err", { msg: e.message }), "err"); return; }
  if (res.kind === "view") applyView(res.df, op.id, res.code);
  else if (res.kind === "info") applyInfo(res.code, op.id);
  else applyTransform(res.df, op.id, res.code, res.toastKey, res.toastVars);
}

function applyTransform(ndf, opId, code, toastKey, toastVars) {
  state.code.push(code);
  state.df = ndf;
  state.history = state.history.slice(0, state.histIndex + 1);
  state.history.push({ df: ndf, label: t("op." + opId), codeLen: state.code.length, code });
  state.histIndex = state.history.length - 1;
  state.page = 1; state.sortView = null;
  if (toastKey) toast(t(toastKey, toastVars || { r: ndf.rows.length, c: ndf.columns.length }));
  refreshAfterDataChange();
  renderCode(); renderHistory();
}

function applyView(df, opId, code) {
  state.code.push(code);
  state.output = { df, titleKey: "op." + opId };
  renderOutput(); renderCode();
  switchTab("output");
}

function applyInfo(code, opId) {
  const rows = state.df.info().map(r => [r.column, r.dtype, r.nonNull, r.nulls, Math.round(r.nullPct * 10) / 10, r.unique]);
  const df = new PV.DataFrame(["column", "dtype", "non_null", "nulls", "null_%", "unique"], rows, "info");
  applyView(df, opId, code);
}

function refreshAfterDataChange() {
  populateColumnControls();
  renderTable(); updateStatus(); renderCurrentData();
  updateUndoRedo();
}

/* ============================================================
 * Table pane
 * ============================================================ */
function viewRows() {
  let rows = state.df.rows;
  if (state.sortView) {
    const i = state.df.colIndex(state.sortView.col);
    const asc = state.sortView.asc ? 1 : -1;
    rows = rows.slice().sort((a, b) => asc * PV.smartCompare(a[i], b[i]));
  }
  return rows;
}

function renderTable() {
  const wrap = $("#table-wrap");
  wrap.innerHTML = "";
  if (!state.df) return;
  const df = state.df, types = df.types();
  const rows = viewRows();
  const total = rows.length;
  const pages = Math.max(1, Math.ceil(total / state.pageSize));
  state.page = Math.min(state.page, pages);
  const start = (state.page - 1) * state.pageSize;
  const pageRows = rows.slice(start, start + state.pageSize);

  const tbl = el("table", "data");
  const thead = el("thead");
  const hr = el("tr");
  hr.appendChild(el("th", "idx", "#"));
  for (const c of df.columns) {
    const th = el("th", "sortable");
    th.innerHTML = esc(c) + ` <span class="dt-badge">${esc(t("type." + types[c]))}</span>` +
      (state.sortView && state.sortView.col === c ? (state.sortView.asc ? " ▲" : " ▼") : "");
    th.title = c;
    th.onclick = () => {
      if (state.sortView && state.sortView.col === c) {
        if (state.sortView.asc) state.sortView = { col: c, asc: false };
        else state.sortView = null;
      } else state.sortView = { col: c, asc: true };
      renderTable();
    };
    hr.appendChild(th);
  }
  thead.appendChild(hr);
  tbl.appendChild(thead);
  const tbody = el("tbody");
  pageRows.forEach((r, i) => {
    const tr = el("tr");
    tr.appendChild(el("td", "idx", String(start + i)));
    for (const v of r) tr.appendChild(el("td", "", fmtVal(v)));
    tbody.appendChild(tr);
  });
  tbl.appendChild(tbody);
  wrap.appendChild(tbl);

  $("#table-total").textContent = t("table.total", { n: total });
  $("#page-info").textContent = `${state.page} / ${pages}`;
  $("#page-prev").disabled = state.page <= 1;
  $("#page-next").disabled = state.page >= pages;
}

/* ============================================================
 * Output pane
 * ============================================================ */
function renderOutput() {
  const o = state.output;
  const wrap = $("#output-wrap");
  wrap.innerHTML = "";
  if (!o) {
    $("#output-empty").style.display = "";
    $("#output-toolbar").hidden = true;
    return;
  }
  $("#output-empty").style.display = "none";
  $("#output-toolbar").hidden = false;
  $("#output-title").textContent = t(o.titleKey) + `  ·  ${o.df.rows.length} × ${o.df.columns.length}`;
  const tbl = el("table", "data");
  const thead = el("thead");
  const hr = el("tr");
  hr.appendChild(el("th", "idx", "#"));
  if (o.df.indexLabels) hr.appendChild(el("th", "", ""));
  for (const c of o.df.columns) hr.appendChild(el("th", "", esc(c)));
  thead.appendChild(hr); tbl.appendChild(thead);
  const tbody = el("tbody");
  const cap = Math.min(o.df.rows.length, 1000);
  for (let i = 0; i < cap; i++) {
    const tr = el("tr");
    tr.appendChild(el("td", "idx", String(i)));
    if (o.df.indexLabels) tr.appendChild(el("td", "", `<strong>${esc(o.df.indexLabels[i])}</strong>`));
    for (const v of o.df.rows[i]) tr.appendChild(el("td", "", fmtVal(v)));
    tbody.appendChild(tr);
  }
  tbl.appendChild(tbody);
  wrap.appendChild(tbl);
}

/* ============================================================
 * Code pane
 * ============================================================ */
function renderCode() {
  const header = "import pandas as pd\nimport numpy as np\n\n";
  const body = state.code.length ? state.code.join("\n") : t("code.empty");
  $("#code-view").textContent = header + body;
}

/* ============================================================
 * History pane
 * ============================================================ */
function renderHistory() {
  const list = $("#history-list");
  list.innerHTML = "";
  if (!state.history.length) {
    list.appendChild(el("div", "hist-empty", esc(t("history.empty"))));
    return;
  }
  state.history.forEach((h, i) => {
    const item = el("div", "hist-item" + (i === state.histIndex ? " current" : ""));
    item.appendChild(el("span", "step-no", String(i)));
    const lab = el("div", "hist-label");
    lab.appendChild(el("span", "", esc(h.label) + (i === state.histIndex ? ` · ${esc(t("history.current"))}` : "")));
    lab.appendChild(el("span", "sub", esc(h.code || "") + `   [${h.df.rows.length} × ${h.df.columns.length}]`));
    item.appendChild(lab);
    if (i !== state.histIndex) {
      const btn = el("button", "btn sm", esc(t("history.restore")));
      btn.type = "button";
      btn.onclick = () => restoreStep(i);
      item.appendChild(btn);
    }
    list.appendChild(item);
  });
}

function restoreStep(i) {
  state.histIndex = i;
  const h = state.history[i];
  state.df = h.df;
  state.code.length = h.codeLen;
  state.page = 1; state.sortView = null;
  toast(t("toast.restored", { n: i }), "info");
  refreshAfterDataChange();
  renderCode(); renderHistory();
}

function updateUndoRedo() {
  $("#btn-undo").disabled = state.histIndex <= 0;
  $("#btn-redo").disabled = state.histIndex >= state.history.length - 1;
}

/* ============================================================
 * Status / current data
 * ============================================================ */
function updateStatus() {
  if (!state.df) return;
  const [r, c] = state.df.shape;
  $("#st-dataset").textContent = `${t("status.dataset")}: ${currentDsName()}`;
  $("#st-shape").textContent = t("status.shape", { r, c });
  $("#st-memory").textContent = `${t("data.memory")} ${(state.df.memoryUsage() / 1024).toFixed(1)} KB`;
  $("#st-step").textContent = t("status.step", { n: state.histIndex });
}

function renderCurrentData() {
  if (!state.df) return;
  const [r, c] = state.df.shape;
  $("#current-data").innerHTML =
    `<strong>${esc(currentDsName())}</strong><br>${r} ${esc(t("data.rows"))} × ${c} ${esc(t("data.cols"))} · ${esc(t("data.memory"))} ${(state.df.memoryUsage() / 1024).toFixed(1)} KB`;
}

/* ============================================================
 * Data loading
 * ============================================================ */
function setData(df, name, codeLines, registerExtra, dsId) {
  state.df = df; state.df0 = df;
  state.dsName = name;
  state.dsId = dsId || "";
  state.code = codeLines.slice();
  state.history = [{ df, label: t("history.load") + " · " + name, codeLen: state.code.length, code: codeLines[codeLines.length - 1] || "" }];
  state.histIndex = 0;
  state.page = 1; state.sortView = null;
  state.output = null;
  if (registerExtra) {
    state.extraDatasets = state.extraDatasets.filter(d => d.name !== name);
    state.extraDatasets.push({ name, df });
  }
  toast(t("toast.loaded", { name, r: df.rows.length, c: df.columns.length }));
  refreshAfterDataChange();
  renderOutput(); renderCode(); renderHistory();
  switchTab("table");
}

function loadBuiltin(id) {
  const d = BUILTIN_DATASETS.find(x => x.id === id);
  if (!d) return;
  const df = PV.DataFrame.fromCSV(d.csv, id);
  const name = state.lang === "zh" ? d.name_zh : d.name_en;
  setData(df, name, [t("code.load.builtin", { name }), t("code.load.csv", { name: id })], false, id);
}

/* display name of current dataset, re-localized on language switch */
function currentDsName() {
  const d = state.dsId && BUILTIN_DATASETS.find(x => x.id === state.dsId);
  return d ? (state.lang === "zh" ? d.name_zh : d.name_en) : state.dsName;
}

function parseAnyFile(name, textOrBuffer) {
  const ext = (name.split(".").pop() || "").toLowerCase();
  if (ext === "json") {
    const obj = JSON.parse(textOrBuffer);
    const arr = Array.isArray(obj) ? obj : obj.data;
    if (!Array.isArray(arr)) throw new Error("JSON must be an array of objects");
    return PV.DataFrame.fromObjects(arr, name);
  }
  if (ext === "xlsx" || ext === "xls") {
    const wb = XLSX.read(textOrBuffer, { type: "array" });
    const ws = wb.Sheets[wb.SheetNames[0]];
    const aoa = XLSX.utils.sheet_to_json(ws, { header: 1, defval: "" });
    if (!aoa.length) throw new Error("empty sheet");
    const columns = aoa[0].map((h, i) => String(h).trim() || "col_" + (i + 1));
    const rows = aoa.slice(1).filter(r => r.some(v => v !== "")).map(r => columns.map((_, i) => PV.parseScalar(r[i] === undefined ? "" : r[i])));
    return new PV.DataFrame(columns, rows, name);
  }
  return PV.DataFrame.fromCSV(String(textOrBuffer), name);
}

function handleFile(file) {
  const ext = (file.name.split(".").pop() || "").toLowerCase();
  const isExcel = ext === "xlsx" || ext === "xls";
  const reader = new FileReader();
  reader.onload = () => {
    try {
      const df = parseAnyFile(file.name, reader.result);
      if (!df.columns.length) throw new Error("empty");
      setData(df, file.name, [`# ${file.name}`, t("code.load.csv", { name: file.name.replace(/\.[^.]+$/, "") })], true);
    } catch (e) { toast(t("toast.parse.fail"), "err"); }
  };
  reader.onerror = () => toast(t("toast.parse.fail"), "err");
  if (isExcel) reader.readAsArrayBuffer(file); else reader.readAsText(file, "utf-8");
}

/* ============================================================
 * Charts
 * ============================================================ */
function populateChartControls() {
  if (!state.df) return;
  const df = state.df;
  const nums = df.numericColumns();
  const cats = df.categoricalColumns();
  const anyC = df.columns;
  fillSelect($("#ch-x"), anyC);
  fillSelect($("#ch-y"), nums.length ? nums : anyC);
  const agg = $("#ch-agg");
  agg.innerHTML = "";
  agg.appendChild(new Option(t("chart.count"), "count"));
  for (const f of AGG_FUNCS) agg.appendChild(new Option(t("agg." + f), f));
  agg.value = "count";
  fillSelect($("#ch-group"), cats, cats);
  $("#ch-group").dataset.none = "1";
  fillSelect($("#ch-group"), cats);
  fillSelect($("#ch-heat-index"), cats.length ? cats : anyC);
  fillSelect($("#ch-heat-columns"), cats.length ? cats : anyC);
  fillSelect($("#ch-heat-values"), nums.length ? nums : anyC);
  updateChartFieldVisibility();
}

function updateChartFieldVisibility() {
  const type = $("#ch-type").value;
  const heatMode = $("#ch-heat-mode").value;
  $$("#chart-bar .ch-field").forEach(f => {
    const tokens = (f.dataset.for || "").split(/\s+/).filter(Boolean);
    if (!tokens.length) { f.style.display = ""; return; }
    let show = tokens.includes(type);
    if (show && tokens.includes("pivot-only")) show = type === "heat" && heatMode === "pivot";
    if (show && type === "pie" && f.querySelector("#ch-y")) { /* pie y used only when agg != count */ }
    f.style.display = show ? "" : "none";
  });
  // pie & count agg: y not needed
  const yF = $("#ch-y").closest(".ch-field");
  if (["hist", "box"].includes(type)) yF.style.display = "";
  if (type === "scatter") { $("#ch-agg").closest(".ch-field").style.display = "none"; }
}

function chartSpecFromUI() {
  const type = $("#ch-type").value;
  const spec = {
    type,
    x: $("#ch-x").value, y: $("#ch-y").value,
    agg: $("#ch-agg").value || "count",
    groupBy: $("#ch-group").value,
    bins: +$("#ch-bins").value || 15,
    title: $("#ch-title").value.trim(),
    heatMode: $("#ch-heat-mode").value,
    heatIndex: $("#ch-heat-index").value, heatColumns: $("#ch-heat-columns").value,
    heatValues: $("#ch-heat-values").value, heatAgg: "mean",
  };
  if (!spec.title) {
    if (type === "hist") spec.title = spec.y;
    else if (type === "box") spec.title = spec.y + (spec.groupBy !== "__none__" ? " by " + spec.groupBy : "");
    else if (type === "scatter") spec.title = `${spec.y} vs ${spec.x}`;
    else if (type === "heat") spec.title = t(spec.heatMode === "corr" ? "chart.heat.corr" : "chart.heat.pivot");
    else spec.title = spec.agg === "count" ? `${t("chart.count")} by ${spec.x}` : `${spec.agg}(${spec.y}) by ${spec.x}`;
  }
  return spec;
}

function renderChart(spec) {
  if (!state.df) { toast(t("toast.need.data"), "err"); return; }
  if (["bar", "barh", "line", "area", "pie", "scatter"].includes(spec.type) && !spec.x) { toast(t("chart.need.x"), "err"); return; }
  if (["scatter", "hist", "box"].includes(spec.type) && !spec.y) { toast(t("chart.need.num"), "err"); return; }
  if (["bar", "barh", "line", "area", "pie"].includes(spec.type) && spec.agg !== "count" && !spec.y) { toast(t("chart.need.num"), "err"); return; }
  const opt = Charts.buildOption(state.df, spec, state.theme === "dark", I18N[state.lang]);
  if (!opt) { toast(t("toast.err", { msg: "no data" }), "err"); return; }
  $("#chart-empty").style.display = "none";
  const box = $("#chart-box");
  box.classList.add("on");
  if (state.chart) state.chart.dispose();
  state.chart = echarts.init(box, null, { renderer: "canvas" });
  state.chart.setOption(opt);
  state.lastChartSpec = spec;
  toast(t("toast.chart.ok"), "info");
}

function resizeChart() { if (state.chart) state.chart.resize(); }

/* ============================================================
 * Tabs
 * ============================================================ */
function switchTab(name) {
  $$("#tabs .tab").forEach(b => b.classList.toggle("active", b.dataset.tab === name));
  $$(".main .pane").forEach(p => p.classList.toggle("active", p.id === "pane-" + name));
  if (name === "chart") setTimeout(resizeChart, 30);
}

/* ============================================================
 * i18n apply
 * ============================================================ */
function applyI18n() {
  document.documentElement.lang = state.lang === "zh" ? "zh-CN" : "en";
  document.title = t("app.title");
  $$("[data-i18n]").forEach(elm => { elm.textContent = t(elm.dataset.i18n); });
  $$("[data-i18n-ph]").forEach(elm => { elm.placeholder = t(elm.dataset.i18nPh); });
  $$("[data-i18n-title]").forEach(elm => { elm.title = t(elm.dataset.i18nTitle); });
  $("#btn-lang").textContent = t("nav.lang");
  // rebuild dynamic UI in new language
  $$(".op-card[data-op]").forEach(c => c.remove());
  buildSidebar();
  populateColumnControls();
  renderBuiltinSelect();
  buildHelpTable();
  renderTable(); renderOutput(); renderCode(); renderHistory();
  renderCurrentData(); updateStatus();
  if (state.lastChartSpec && state.chart) renderChart(state.lastChartSpec);
}

function applyTheme() {
  document.documentElement.dataset.theme = state.theme;
  $("#btn-theme").textContent = state.theme === "dark" ? "☀️" : "🌙";
  if (state.lastChartSpec && state.chart) renderChart(state.lastChartSpec);
}

/* ============================================================
 * Builtin dataset select / help table
 * ============================================================ */
function renderBuiltinSelect() {
  const sel = $("#builtin-select");
  const cur = sel.value || "titanic";
  sel.innerHTML = "";
  for (const d of BUILTIN_DATASETS) sel.appendChild(new Option(state.lang === "zh" ? d.name_zh : d.name_en, d.id));
  sel.value = [...sel.options].some(o => o.value === cur) ? cur : "titanic";
  updateBuiltinDesc();
}
function updateBuiltinDesc() {
  const d = BUILTIN_DATASETS.find(x => x.id === $("#builtin-select").value);
  $("#builtin-desc").textContent = d ? (state.lang === "zh" ? d.desc_zh : d.desc_en) : "";
}

const HELP_ROWS = [
  ["help.load", "pd.read_csv() / read_json() / read_excel()"],
  ["help.view", "df / df.iloc / df.sort_values()"],
  ["help.info", "df.info()"],
  ["help.head", "df.head() / df.tail() / df.sample()"],
  ["help.clean", "dropna() / fillna() / drop_duplicates() / astype() / rename() / drop()"],
  ["help.filter", "df[cond] / df.query() / sort_values() / iloc[]"],
  ["help.groupby", "df.groupby().agg()"],
  ["help.pivot", "df.pivot_table()"],
  ["help.addcol", "df.assign() / .str / .dt / np.where() / pd.cut()"],
  ["help.merge", "pd.merge()"],
  ["help.viz", "df.plot() / matplotlib"],
  ["help.history", "df.copy() (checkpoint)"],
  ["help.code", "# script.py"],
];
function buildHelpTable() {
  const tbl = $("#help-table");
  tbl.innerHTML = `<thead><tr><th>${esc(t("help.col.feature"))}</th><th>${esc(t("help.col.pandas"))}</th></tr></thead>`;
  const tb = el("tbody");
  for (const [k, code] of HELP_ROWS) {
    const tr = el("tr");
    tr.appendChild(el("td", "", esc(t(k))));
    tr.appendChild(el("td", "", `<code>${esc(code)}</code>`));
    tb.appendChild(tr);
  }
  tbl.appendChild(tb);
}

/* ============================================================
 * Tour
 * ============================================================ */
function presetOp(id, fn) {
  const op = OPS.find(o => o.id === id);
  if (!op) return;
  if (!op._card.classList.contains("open")) op._card.classList.add("open");
  fn(op._b);
}
const TOUR_STEPS = [
  { sel: null, key: 1 },
  { sel: () => OPS.find(o => o.id === "info")._card, key: 2, action: () => presetOp("info", () => { }) },
  { sel: () => $("#pane-output"), key: 3, action: () => runOp("info") },
  {
    sel: () => OPS.find(o => o.id === "fillna")._card, key: 4, action: () => {
      presetOp("fillna", b => {
        if ([...b.col.options].some(o => o.value === "Age")) { b.col.value = "Age"; b.method.value = "median"; b.method.onchange(); }
      });
      runOp("fillna");
    }
  },
  {
    sel: () => OPS.find(o => o.id === "query")._card, key: 5, action: () => {
      presetOp("query", b => {
        const rows = b.builder.querySelectorAll ? null : null;
        const box = b.builder;
        box.querySelector(".dyn-rows").innerHTML = "";
        box.addRow(); box.addRow();
        const [r1, r2] = box.querySelectorAll(".dyn-row");
        const setRow = (r, col, op, val) => {
          if (![...r.children[0].options].some(o => o.value === col)) return false;
          r.children[0].value = col; r.children[1].value = op; r.children[2].value = val; return true;
        };
        setRow(r1, "Sex", "eq", "female");
        setRow(r2, "Pclass", "eq", "1");
      });
      runOp("query");
    }
  },
  {
    sel: () => OPS.find(o => o.id === "groupby")._card, key: 6, action: () => {
      presetOp("groupby", b => {
        b.keys.querySelectorAll("input").forEach(i => { i.checked = i.value === "Sex"; });
        const box = b.builder;
        box.querySelector(".dyn-rows").innerHTML = "";
        box.addRow();
        const r = box.querySelector(".dyn-row");
        if ([...r.children[0].options].some(o => o.value === "Survived")) r.children[0].value = "Survived";
        r.children[1].value = "mean";
      });
      runOp("groupby");
    }
  },
  {
    sel: () => $("#chart-bar"), key: 7, action: () => {
      switchTab("chart");
      const type = $("#ch-type"); type.value = "bar";
      updateChartFieldVisibility();
      const x = $("#ch-x"), y = $("#ch-y"), agg = $("#ch-agg");
      if ([...x.options].some(o => o.value === "Sex")) x.value = "Sex";
      if ([...y.options].some(o => o.value === "Survived")) y.value = "Survived";
      if (state.df.columns.includes("Survived")) agg.value = "mean";
      renderChart(chartSpecFromUI());
    }
  },
  { sel: () => $("#pane-code"), key: 8, action: () => switchTab("code") },
  { sel: () => $("#pane-history"), key: 9, action: () => switchTab("history") },
  { sel: null, key: 10, action: () => switchTab("table") },
];

function tourStart() {
  if (!state.df) loadBuiltin("titanic");
  state.tour = { i: 0 };
  $("#tour-mask").hidden = false;
  tourShow(0);
}
function tourEnd() {
  state.tour = null;
  $("#tour-mask").hidden = true;
}
function tourShow(i) {
  const steps = TOUR_STEPS;
  if (i < 0 || i >= steps.length) return;
  state.tour.i = i;
  const st = steps[i];
  if (st.action) { try { st.action(); } catch (e) { /* tour resilient */ } }
  const spot = $("#tour-spot"), card = $("#tour-card");
  $("#tour-title").textContent = t("tour.s" + st.key + ".title");
  $("#tour-text").textContent = t("tour.s" + st.key + ".text");
  $("#tour-stepnum").textContent = t("tour.step", { i: i + 1, n: steps.length });
  $("#tour-prev").disabled = i === 0;
  $("#tour-next").textContent = i === steps.length - 1 ? t("tour.done") : t("tour.next");
  const target = st.sel ? st.sel() : null;
  if (target) {
    target.scrollIntoView({ block: "center", behavior: "instant" });
    const r = target.getBoundingClientRect();
    const pad = 6;
    spot.style.display = "";
    spot.style.left = (r.left - pad) + "px";
    spot.style.top = (r.top - pad) + "px";
    spot.style.width = (r.width + pad * 2) + "px";
    spot.style.height = (r.height + pad * 2) + "px";
    // place card
    const cw = 360, ch = card.offsetHeight || 200;
    let cx = Math.min(window.innerWidth - cw - 20, Math.max(10, r.left + r.width / 2 - cw / 2));
    let cy = r.bottom + 16;
    if (cy + ch > window.innerHeight - 10) cy = Math.max(10, r.top - ch - 16);
    card.style.left = cx + "px"; card.style.top = cy + "px";
  } else {
    spot.style.display = "none";
    $("#tour-mask").style.background = "rgba(2,6,23,.62)";
    card.style.left = "50%"; card.style.top = "50%";
    card.style.transform = "translate(-50%,-50%)";
    if (target !== null) { /* noop */ }
  }
  if (target) { $("#tour-mask").style.background = "transparent"; card.style.transform = ""; }
}

/* ============================================================
 * Modals
 * ============================================================ */
function openModal(id) { $(id).hidden = false; }
function closeModals() { $$(".modal-mask").forEach(m => m.hidden = true); }

/* ============================================================
 * Events
 * ============================================================ */
function bindEvents() {
  // tabs
  $$("#tabs .tab").forEach(b => b.onclick = () => switchTab(b.dataset.tab));
  // pagination
  $("#page-prev").onclick = () => { state.page--; renderTable(); };
  $("#page-next").onclick = () => { state.page++; renderTable(); };
  $("#page-size").onchange = e => { state.pageSize = +e.target.value; state.page = 1; renderTable(); };
  // nav
  $("#btn-undo").onclick = () => { if (state.histIndex > 0) { restoreStep(state.histIndex - 1); toast(t("toast.undo"), "info"); } };
  $("#btn-redo").onclick = () => { if (state.histIndex < state.history.length - 1) { restoreStep(state.histIndex + 1); toast(t("toast.redo"), "info"); } };
  $("#btn-reset").onclick = () => {
    if (!state.df0) return;
    setData(state.df0, state.dsName, state.code.slice(0, state.history[0].codeLen));
    toast(t("toast.reset"), "info");
  };
  $("#btn-tour").onclick = tourStart;
  $("#btn-help").onclick = () => openModal("#modal-help");
  $("#btn-theme").onclick = () => {
    state.theme = state.theme === "dark" ? "light" : "dark";
    localStorage.setItem("pv.theme", state.theme);
    applyTheme();
  };
  $("#btn-lang").onclick = () => {
    state.lang = state.lang === "zh" ? "en" : "zh";
    localStorage.setItem("pv.lang", state.lang);
    applyI18n();
  };
  // export dropdown
  $("#btn-export").onclick = e => { e.stopPropagation(); $("#export-menu").classList.toggle("open"); };
  document.addEventListener("click", () => $("#export-menu").classList.remove("open"));
  $("#export-csv").onclick = () => { if (state.df) { download(state.dsName.replace(/\.[^.]+$/, "") + ".csv", state.df.toCSV(), "text/csv"); toast(t("toast.exported")); } };
  $("#export-json").onclick = () => { if (state.df) { download(state.dsName.replace(/\.[^.]+$/, "") + ".json", state.df.toJSON(), "application/json"); toast(t("toast.exported")); } };
  // data loading
  $("#btn-load-builtin").onclick = () => loadBuiltin($("#builtin-select").value);
  $("#builtin-select").onchange = updateBuiltinDesc;
  $("#btn-upload").onclick = () => $("#file-input").click();
  $("#file-input").onchange = e => { if (e.target.files[0]) handleFile(e.target.files[0]); e.target.value = ""; };
  $("#btn-url").onclick = () => openModal("#modal-url");
  $("#btn-paste").onclick = () => openModal("#modal-paste");
  $("#url-confirm").onclick = async () => {
    const url = $("#url-input").value.trim();
    if (!url) return;
    closeModals();
    try {
      const resp = await fetch(url);
      if (!resp.ok) throw new Error("HTTP " + resp.status);
      const text = await resp.text();
      const name = url.split("/").pop().split("?")[0] || "url_data.csv";
      const df = name.endsWith(".json") ? parseAnyFile(name, text) : PV.DataFrame.fromCSV(text, name);
      setData(df, name, [`# ${name}`, `df = pd.read_csv('${url}')`], true);
    } catch (e) { toast(t("toast.url.fail", { msg: e.message }), "err"); }
  };
  $("#paste-confirm").onclick = () => {
    const text = $("#paste-input").value.trim();
    if (!text) return;
    closeModals();
    try {
      let df;
      if (text.startsWith("[") || text.startsWith("{")) {
        const arr = JSON.parse(text);
        df = PV.DataFrame.fromObjects(Array.isArray(arr) ? arr : [arr], "pasted");
      } else df = PV.DataFrame.fromCSV(text, "pasted");
      if (!df.columns.length) throw new Error("empty");
      setData(df, "pasted_data", ["# pasted data", "# df = pd.read_csv(...)"], true);
    } catch (e) { toast(t("toast.parse.fail"), "err"); }
  };
  $$("[data-close]").forEach(b => b.onclick = closeModals);
  $$(".modal-mask").forEach(m => m.addEventListener("click", e => { if (e.target === m) closeModals(); }));
  // output
  $("#output-download").onclick = () => { if (state.output) { download("result.csv", state.output.df.toCSV(), "text/csv"); toast(t("toast.exported")); } };
  $("#output-use").onclick = () => {
    if (!state.output) return;
    state.code.push(t("code.use.result"));
    const ndf = state.output.df.clone(state.df.name);
    state.df = ndf;
    state.history = state.history.slice(0, state.histIndex + 1);
    state.history.push({ df: ndf, label: t("output.use"), codeLen: state.code.length, code: t("code.use.result") });
    state.histIndex = state.history.length - 1;
    state.page = 1; state.sortView = null;
    toast(t("toast.op.ok", { r: ndf.rows.length, c: ndf.columns.length }));
    refreshAfterDataChange(); renderCode(); renderHistory();
    switchTab("table");
  };
  // code
  $("#code-copy").onclick = async () => {
    try { await navigator.clipboard.writeText($("#code-view").textContent); toast(t("code.copied")); }
    catch { toast(t("toast.err", { msg: "clipboard" }), "err"); }
  };
  // chart
  $("#ch-type").onchange = updateChartFieldVisibility;
  $("#ch-heat-mode").onchange = updateChartFieldVisibility;
  $("#ch-render").onclick = () => renderChart(chartSpecFromUI());
  $("#ch-download").onclick = () => {
    if (!state.chart) return;
    const a = document.createElement("a");
    a.href = state.chart.getDataURL({ pixelRatio: 2, backgroundColor: state.theme === "dark" ? "#131e33" : "#ffffff" });
    a.download = "chart.png";
    a.click();
  };
  // search
  $("#op-search").addEventListener("input", e => {
    const q = e.target.value.trim().toLowerCase();
    $$(".op-card[data-op]").forEach(card => {
      const hit = !q || card.textContent.toLowerCase().includes(q);
      card.classList.toggle("hidden-by-search", !hit);
    });
  });
  // section collapse
  $$(".sec-title").forEach(h => h.onclick = () => h.parentElement.classList.toggle("closed"));
  // tour
  $("#tour-next").onclick = () => {
    if (state.tour.i >= TOUR_STEPS.length - 1) tourEnd();
    else tourShow(state.tour.i + 1);
  };
  $("#tour-prev").onclick = () => tourShow(state.tour.i - 1);
  $("#tour-skip").onclick = tourEnd;
  // drag & drop
  let dragDepth = 0;
  window.addEventListener("dragenter", e => { e.preventDefault(); dragDepth++; $("#drag-mask").hidden = false; });
  window.addEventListener("dragleave", e => { e.preventDefault(); if (--dragDepth <= 0) { dragDepth = 0; $("#drag-mask").hidden = true; } });
  window.addEventListener("dragover", e => e.preventDefault());
  window.addEventListener("drop", e => {
    e.preventDefault(); dragDepth = 0; $("#drag-mask").hidden = true;
    if (e.dataTransfer.files && e.dataTransfer.files[0]) handleFile(e.dataTransfer.files[0]);
  });
  window.addEventListener("resize", resizeChart);
}

/* ============================================================
 * Init
 * ============================================================ */
function init() {
  applyTheme();
  bindEvents();
  applyI18n();
  loadBuiltin("titanic");
  switchTab("table");
}
document.addEventListener("DOMContentLoaded", init);
