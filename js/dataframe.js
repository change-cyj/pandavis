/* ============================================================
 * PandaVis DataFrame Engine — a pandas-like data engine in JS
 * Pure data layer: no DOM access. All transform operations are
 * immutable (return a new DataFrame) to support history/undo.
 * ============================================================ */
"use strict";

/* ---------------- CSV parsing / serialization ---------------- */
const CSV = {
  // Robust CSV parser: quotes, escaped quotes, embedded newlines, auto delimiter
  detectDelimiter(line) {
    const cands = [",", "\t", ";", "|"];
    let best = ",", bestCount = 0;
    for (const d of cands) {
      const n = line.split(d).length;
      if (n > bestCount) { bestCount = n; best = d; }
    }
    return best;
  },
  parse(text) {
    text = text.replace(/^\uFEFF/, ""); // strip BOM
    const firstLine = text.split(/\r?\n/, 1)[0] || "";
    const delim = this.detectDelimiter(firstLine);
    const rows = [];
    let field = "", row = [], inQuotes = false;
    for (let i = 0; i < text.length; i++) {
      const c = text[i];
      if (inQuotes) {
        if (c === '"') {
          if (text[i + 1] === '"') { field += '"'; i++; }
          else inQuotes = false;
        } else field += c;
      } else if (c === '"') {
        inQuotes = true;
      } else if (c === delim) {
        row.push(field); field = "";
      } else if (c === "\n" || c === "\r") {
        if (c === "\r" && text[i + 1] === "\n") i++;
        row.push(field); field = "";
        if (row.length > 1 || row[0] !== "") rows.push(row);
        row = [];
      } else field += c;
    }
    if (field !== "" || row.length > 0) { row.push(field); rows.push(row); }
    if (!rows.length) return { columns: [], rows: [] };
    const width = rows[0].length;
    const columns = rows[0].map((h, i) => {
      h = String(h).trim();
      return h === "" ? "col_" + (i + 1) : h;
    });
    const data = [];
    for (let r = 1; r < rows.length; r++) {
      const src = rows[r];
      const out = new Array(width);
      for (let c = 0; c < width; c++) out[c] = parseScalar(src[c] === undefined ? "" : src[c]);
      data.push(out);
    }
    return { columns, rows: data };
  },
  stringify(columns, rows) {
    const esc = v => {
      if (v === null || v === undefined) return "";
      const s = String(v);
      return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
    };
    const lines = [columns.map(esc).join(",")];
    for (const r of rows) lines.push(r.map(esc).join(","));
    return lines.join("\n");
  }
};

/* ---------------- scalar typing ---------------- */
const NUM_RE = /^-?\d+(\.\d+)?([eE][+-]?\d+)?$/;
const DATE_RE = /^\d{4}[-/]\d{1,2}[-/]\d{1,2}([ T]\d{1,2}:\d{2}(:\d{2})?)?$/;

function parseScalar(raw) {
  const s = String(raw).trim();
  if (s === "" || s.toLowerCase() === "nan" || s.toLowerCase() === "null" || s.toLowerCase() === "none") return null;
  if (NUM_RE.test(s)) {
    const n = Number(s);
    if (Number.isFinite(n)) return n;
  }
  if (s.toLowerCase() === "true") return true;
  if (s.toLowerCase() === "false") return false;
  return s;
}

function inferType(values) {
  let num = 0, str = 0, bool = 0, date = 0, total = 0;
  for (const v of values) {
    if (v === null || v === undefined) continue;
    total++;
    if (typeof v === "number") num++;
    else if (typeof v === "boolean") bool++;
    else if (typeof v === "string" && DATE_RE.test(v) && !isNaN(Date.parse(v.replace(/\//g, "-")))) date++;
    else str++;
  }
  if (total === 0) return "empty";
  const ratio = t => t / total;
  if (ratio(num) >= 0.9) return "number";
  if (ratio(date) >= 0.9) return "date";
  if (ratio(bool) >= 0.9) return "boolean";
  if (ratio(str) >= 0.9) return "string";
  return "mixed";
}

/* ---------------- statistics helpers ---------------- */
const Stats = {
  nums(values) { return values.filter(v => typeof v === "number" && Number.isFinite(v)); },
  sum(a) { return a.reduce((s, v) => s + v, 0); },
  mean(a) { return a.length ? this.sum(a) / a.length : null; },
  variance(a) { // sample variance (ddof=1), like pandas
    if (a.length < 2) return null;
    const m = this.mean(a);
    return a.reduce((s, v) => s + (v - m) * (v - m), 0) / (a.length - 1);
  },
  std(a) { const v = this.variance(a); return v === null ? null : Math.sqrt(v); },
  quantile(sorted, q) { // linear interpolation, same as pandas default
    if (!sorted.length) return null;
    const pos = (sorted.length - 1) * q;
    const base = Math.floor(pos), rest = pos - base;
    if (base + 1 < sorted.length) return sorted[base] + rest * (sorted[base + 1] - sorted[base]);
    return sorted[base];
  },
  mode(values) {
    const freq = new Map();
    let best = null, bestN = 0;
    for (const v of values) {
      if (v === null) continue;
      const n = (freq.get(v) || 0) + 1;
      freq.set(v, n);
      if (n > bestN) { bestN = n; best = v; }
    }
    return best;
  },
  pearson(xs, ys) {
    const pairs = [];
    for (let i = 0; i < xs.length; i++)
      if (typeof xs[i] === "number" && typeof ys[i] === "number") pairs.push([xs[i], ys[i]]);
    const n = pairs.length;
    if (n < 2) return null;
    const mx = this.mean(pairs.map(p => p[0])), my = this.mean(pairs.map(p => p[1]));
    let sxy = 0, sxx = 0, syy = 0;
    for (const [x, y] of pairs) { sxy += (x - mx) * (y - my); sxx += (x - mx) ** 2; syy += (y - my) ** 2; }
    if (sxx === 0 || syy === 0) return null;
    return sxy / Math.sqrt(sxx * syy);
  },
  aggregate(values, func) {
    const present = values.filter(v => v !== null && v !== undefined);
    const nums = this.nums(values);
    switch (func) {
      case "sum": return nums.length ? this.sum(nums) : null;
      case "mean": return this.mean(nums);
      case "median": { const s = [...nums].sort((a, b) => a - b); return this.quantile(s, 0.5); }
      case "min": return nums.length ? Math.min(...nums) : (present.length ? present.sort()[0] : null);
      case "max": return nums.length ? Math.max(...nums) : (present.length ? present.sort()[present.length - 1] : null);
      case "count": return present.length;
      case "nunique": return new Set(present.map(String)).size;
      case "std": return this.std(nums);
      case "var": return this.variance(nums);
      case "first": return present.length ? present[0] : null;
      case "last": return present.length ? present[present.length - 1] : null;
      default: return null;
    }
  }
};

function smartCompare(a, b) { // mixed-type aware ascending compare
  if (a === null && b === null) return 0;
  if (a === null) return 1;  // NaN last, like pandas
  if (b === null) return -1;
  if (typeof a === "number" && typeof b === "number") return a - b;
  return String(a).localeCompare(String(b), undefined, { numeric: true });
}

/* ---------------- DataFrame ---------------- */
class DataFrame {
  constructor(columns, rows, name) {
    this.columns = columns.slice();
    this.rows = rows; // array of arrays aligned with columns; null = missing
    this.name = name || "df";
    this._types = null;
  }
  static fromObjects(objs, name) {
    const cols = [];
    const seen = new Set();
    for (const o of objs) for (const k of Object.keys(o))
      if (!seen.has(k)) { seen.add(k); cols.push(k); }
    const rows = objs.map(o => cols.map(c => o[c] === undefined ? null : o[c]));
    return new DataFrame(cols, rows, name);
  }
  static fromCSV(text, name) {
    const { columns, rows } = CSV.parse(text);
    return new DataFrame(columns, rows, name);
  }
  clone(name) {
    return new DataFrame(this.columns.slice(), this.rows.map(r => r.slice()), name || this.name);
  }
  get shape() { return [this.rows.length, this.columns.length]; }
  colIndex(name) { return this.columns.indexOf(name); }
  col(name) { const i = this.colIndex(name); return i < 0 ? [] : this.rows.map(r => r[i]); }
  types() {
    if (!this._types) {
      this._types = {};
      for (let c = 0; c < this.columns.length; c++)
        this._types[this.columns[c]] = inferType(this.rows.map(r => r[c]));
    }
    return this._types;
  }
  typeOf(col) { return this.types()[col] || "empty"; }
  numericColumns() { return this.columns.filter(c => this.typeOf(c) === "number"); }
  categoricalColumns() { return this.columns.filter(c => ["string", "boolean", "mixed"].includes(this.typeOf(c))); }
  dateColumns() { return this.columns.filter(c => this.typeOf(c) === "date"); }
  unique(col, limit) {
    const s = new Set();
    for (const v of this.col(col)) { if (v !== null) s.add(v); if (limit && s.size >= limit) break; }
    return [...s].sort(smartCompare);
  }
  memoryUsage() { // rough estimate in bytes
    let bytes = 0;
    for (const r of this.rows) for (const v of r) {
      if (v === null) bytes += 8;
      else if (typeof v === "number") bytes += 8;
      else if (typeof v === "boolean") bytes += 4;
      else bytes += String(v).length * 2 + 8;
    }
    return bytes;
  }

  /* ---------- views (do not modify in pandas semantics) ---------- */
  head(n = 5) { return new DataFrame(this.columns, this.rows.slice(0, n), this.name); }
  tail(n = 5) { return new DataFrame(this.columns, this.rows.slice(-n), this.name); }
  sample(n = 5) {
    const idx = this.rows.map((_, i) => i);
    for (let i = idx.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1));[idx[i], idx[j]] = [idx[j], idx[i]]; }
    return new DataFrame(this.columns, idx.slice(0, Math.min(n, idx.length)).sort((a, b) => a - b).map(i => this.rows[i]), this.name);
  }
  sliceRows(start, end) { return new DataFrame(this.columns, this.rows.slice(start, end), this.name); }

  info() { // like df.info()
    const types = this.types();
    return this.columns.map(c => {
      const vals = this.col(c);
      const nonNull = vals.filter(v => v !== null).length;
      return {
        column: c, dtype: types[c], nonNull,
        nulls: vals.length - nonNull,
        nullPct: vals.length ? (vals.length - nonNull) / vals.length * 100 : 0,
        unique: new Set(vals.filter(v => v !== null).map(String)).size,
      };
    });
  }

  describe() { // like df.describe(include='all') -> DataFrame
    const statNames = ["count", "unique", "top", "freq", "mean", "std", "min", "25%", "50%", "75%", "max"];
    const cols = [], dataCols = [];
    for (const c of this.columns) {
      const t = this.typeOf(c);
      const vals = this.col(c).filter(v => v !== null);
      const nums = Stats.nums(vals);
      const row = new Array(statNames.length).fill(null);
      row[0] = vals.length;
      if (t === "number" && nums.length) {
        const s = [...nums].sort((a, b) => a - b);
        row[4] = Stats.mean(nums); row[5] = Stats.std(nums);
        row[6] = s[0]; row[7] = Stats.quantile(s, 0.25); row[8] = Stats.quantile(s, 0.5);
        row[9] = Stats.quantile(s, 0.75); row[10] = s[s.length - 1];
      } else {
        row[1] = new Set(vals.map(String)).size;
        const mode = Stats.mode(vals);
        if (mode !== null) { row[2] = String(mode); row[3] = vals.filter(v => String(v) === String(mode)).length; }
      }
      cols.push(c); dataCols.push(row);
    }
    // transpose to stat-rows x data-cols
    const rows = statNames.map((_, si) => dataCols.map(dc => dc[si]));
    return new DataFrame(cols, rows, "describe")._withIndex(statNames);
  }

  _withIndex(labels) { // attach an index label column (display helper)
    this.indexLabels = labels;
    return this;
  }

  corr() { // df.corr() numeric pairwise pearson
    const nums = this.numericColumns();
    const data = nums.map(c1 => nums.map(c2 => {
      const r = Stats.pearson(this.col(c1), this.col(c2));
      return r === null ? null : Math.round(r * 10000) / 10000;
    }));
    return new DataFrame(nums, data, "corr")._withIndex(nums);
  }

  valueCounts(col, topN) {
    const freq = new Map();
    for (const v of this.col(col)) { if (v === null) continue; const k = String(v); freq.set(k, (freq.get(k) || 0) + 1); }
    let entries = [...freq.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
    const total = this.rows.filter(r => r[this.colIndex(col)] !== null).length;
    if (topN) entries = entries.slice(0, topN);
    const rows = entries.map(([k, n]) => [k, n, total ? n / total : 0]);
    return new DataFrame([col, "count", "proportion"], rows, "value_counts");
  }

  /* ---------- transforms (return new DataFrame) ---------- */
  selectColumns(cols) {
    const idx = cols.map(c => this.colIndex(c)).filter(i => i >= 0);
    return new DataFrame(idx.map(i => this.columns[i]), this.rows.map(r => idx.map(i => r[i])), this.name);
  }
  dropColumns(cols) {
    const drop = new Set(cols);
    return this.selectColumns(this.columns.filter(c => !drop.has(c)));
  }
  renameColumns(map) {
    const cols = this.columns.map(c => map[c] !== undefined && map[c] !== "" ? map[c] : c);
    // dedupe names
    const seen = new Map();
    const finalCols = cols.map(c => { const n = (seen.get(c) || 0); seen.set(c, n + 1); return n ? `${c}_${n}` : c; });
    return new DataFrame(finalCols, this.rows.map(r => r.slice()), this.name);
  }
  astype(col, type) {
    const i = this.colIndex(col);
    const rows = this.rows.map(r => {
      const v = r[i]; const nr = r.slice();
      if (v === null) return nr;
      let nv = v;
      if (type === "number") {
        const n = typeof v === "number" ? v : Number(String(v).replace(/,/g, ""));
        nv = Number.isFinite(n) ? n : null;
      } else if (type === "string") nv = String(v);
      else if (type === "date") {
        const s = String(v);
        nv = (!isNaN(Date.parse(s)) || !isNaN(Date.parse(s.replace(/\//g, "-")))) ? s : null;
      } else if (type === "boolean") nv = (v === true || v === "true" || v === 1 || v === "1");
      nr[i] = nv; return nr;
    });
    return new DataFrame(this.columns.slice(), rows, this.name);
  }
  dropna(subset, how = "any") {
    const idx = (subset && subset.length ? subset : this.columns).map(c => this.colIndex(c));
    const rows = this.rows.filter(r => {
      const nulls = idx.filter(i => r[i] === null).length;
      return how === "all" ? nulls < idx.length : nulls === 0;
    });
    return new DataFrame(this.columns.slice(), rows, this.name);
  }
  fillna(col, method, value) {
    const i = this.colIndex(col);
    const type = this.typeOf(col);
    let fill = value;
    if (method === "mean" || method === "median" || method === "mode") {
      const vals = this.col(col).filter(v => v !== null);
      if (method === "mean") fill = Stats.mean(Stats.nums(vals));
      else if (method === "median") { const s = [...Stats.nums(vals)].sort((a, b) => a - b); fill = Stats.quantile(s, 0.5); }
      else fill = Stats.mode(vals);
      if (fill === null || fill === undefined) fill = 0;
      if (type === "number" && typeof fill !== "number") fill = Number(fill) || 0;
    }
    const rows = [];
    let last = null;
    const src = this.rows.map(r => r[i]);
    const ffill = [];
    if (method === "ffill" || method === "bfill") {
      const seq = method === "ffill" ? src : [...src].reverse();
      for (const v of seq) { if (v !== null) last = v; ffill.push(v === null ? last : v); }
      if (method === "bfill") ffill.reverse();
    }
    for (let r = 0; r < this.rows.length; r++) {
      const nr = this.rows[r].slice();
      if (nr[i] === null) {
        if (method === "ffill" || method === "bfill") nr[i] = ffill[r];
        else nr[i] = fill === "" ? null : (type === "number" && fill !== null && typeof fill !== "number" ? (Number(fill) ?? null) : fill);
        if (typeof nr[i] === "number" && !Number.isFinite(nr[i])) nr[i] = null;
      }
      rows.push(nr);
    }
    return new DataFrame(this.columns.slice(), rows, this.name);
  }
  dropDuplicates(subset) {
    const idx = (subset && subset.length ? subset : this.columns).map(c => this.colIndex(c));
    const seen = new Set();
    const rows = this.rows.filter(r => {
      const key = JSON.stringify(idx.map(i => r[i]));
      if (seen.has(key)) return false;
      seen.add(key); return true;
    });
    return new DataFrame(this.columns.slice(), rows, this.name);
  }
  sortValues(by) { // by: [{col, asc}]
    const spec = by.map(b => ({ i: this.colIndex(b.col), asc: b.asc !== false }));
    const rows = this.rows.slice().sort((a, b) => {
      for (const s of spec) {
        const av = a[s.i], bv = b[s.i];
        if (av === null && bv === null) continue;
        if (av === null) return 1;   // NaN always last (pandas default na_position='last')
        if (bv === null) return -1;
        const cmp = smartCompare(av, bv);
        if (cmp !== 0) return s.asc ? cmp : -cmp;
      }
      return 0;
    });
    return new DataFrame(this.columns.slice(), rows, this.name);
  }

  /* ---------- filtering (boolean indexing / df.query) ---------- */
  static evalCond(v, op, val) {
    if (op === "isnull") return v === null;
    if (op === "notnull") return v !== null;
    if (v === null) return false;
    // numeric comparison when both sides numeric
    const numVal = (typeof val === "number") ? val : (typeof val === "string" && NUM_RE.test(val.trim()) ? Number(val) : null);
    if (typeof v === "number" && numVal !== null) {
      switch (op) {
        case "eq": return v === numVal; case "ne": return v !== numVal;
        case "gt": return v > numVal; case "gte": return v >= numVal;
        case "lt": return v < numVal; case "lte": return v <= numVal;
      }
    }
    // date comparison
    const dv = (typeof v === "string" && DATE_RE.test(v)) ? Date.parse(v.replace(/\//g, "-")) : null;
    const dval = (typeof val === "string" && DATE_RE.test(val)) ? Date.parse(val.replace(/\//g, "-")) : null;
    if (dv !== null && dval !== null && !isNaN(dv) && !isNaN(dval)) {
      switch (op) {
        case "eq": return dv === dval; case "ne": return dv !== dval;
        case "gt": return dv > dval; case "gte": return dv >= dval;
        case "lt": return dv < dval; case "lte": return dv <= dval;
      }
    }
    const sv = String(v).toLowerCase(), sval = String(val).toLowerCase();
    switch (op) {
      case "eq": return sv === sval; case "ne": return sv !== sval;
      case "gt": return sv > sval; case "gte": return sv >= sval;
      case "lt": return sv < sval; case "lte": return sv <= sval;
      case "contains": return sv.includes(sval);
      case "notcontains": return !sv.includes(sval);
      case "startswith": return sv.startsWith(sval);
      case "endswith": return sv.endsWith(sval);
      case "isin": return sval.split(",").map(x => x.trim()).includes(sv);
      default: return false;
    }
  }
  query(conditions, logic = "and") {
    const conds = conditions.filter(c => c.col && this.colIndex(c.col) >= 0 && c.op);
    if (!conds.length) return this.clone();
    const rows = this.rows.filter(r => {
      const results = conds.map(c => DataFrame.evalCond(r[this.colIndex(c.col)], c.op, c.value));
      return logic === "or" ? results.some(Boolean) : results.every(Boolean);
    });
    return new DataFrame(this.columns.slice(), rows, this.name);
  }

  /* ---------- groupby & pivot ---------- */
  groupby(keys, aggs) { // aggs: [{col, func}]
    const keyIdx = keys.map(k => this.colIndex(k));
    const groups = new Map();
    for (const r of this.rows) {
      const kv = keyIdx.map(i => r[i]);
      const k = JSON.stringify(kv);
      if (!groups.has(k)) groups.set(k, { kv, rows: [] });
      groups.get(k).rows.push(r);
    }
    const entries = [...groups.values()].sort((a, b) => {
      for (let i = 0; i < a.kv.length; i++) { const c = smartCompare(a.kv[i], b.kv[i]); if (c) return c; }
      return 0;
    });
    const outCols = [...keys, ...aggs.map(a => `${a.col}_${a.func}`)];
    const rows = entries.map(g => {
      const out = [...g.kv];
      for (const a of aggs) {
        const ci = this.colIndex(a.col);
        out.push(Stats.aggregate(g.rows.map(r => r[ci]), a.func));
      }
      return out;
    });
    return new DataFrame(outCols, rows, "groupby");
  }
  pivot(index, columns, values, aggfunc) {
    const ii = this.colIndex(index), ci = this.colIndex(columns), vi = this.colIndex(values);
    const colVals = this.unique(columns);
    const rowMap = new Map();
    for (const r of this.rows) {
      const iv = r[ii], cv = r[ci] === null ? "(null)" : String(r[ci]);
      if (!rowMap.has(iv)) rowMap.set(iv, {});
      const cell = rowMap.get(iv);
      if (!cell[cv]) cell[cv] = [];
      cell[cv].push(r[vi]);
    }
    const indexVals = [...rowMap.keys()].sort(smartCompare);
    const outCols = [index, ...colVals.map(String)];
    const rows = indexVals.map(iv => {
      const cell = rowMap.get(iv);
      return [iv, ...colVals.map(cv => cell[String(cv)] ? Stats.aggregate(cell[String(cv)], aggfunc) : null)];
    });
    return new DataFrame(outCols, rows, "pivot");
  }

  /* ---------- add computed columns (df.assign) ---------- */
  addColumn(spec) {
    const { mode, name } = spec;
    if (!name || this.colIndex(name) >= 0) throw new Error("invalid or duplicate column name");
    let newVals;
    if (mode === "arith") {
      const ai = this.colIndex(spec.colA);
      const useCol = spec.operand === "column";
      const bi = useCol ? this.colIndex(spec.colB) : -1;
      const cst = useCol ? null : Number(spec.constVal);
      newVals = this.rows.map(r => {
        const a = r[ai], b = useCol ? r[bi] : cst;
        if (typeof a !== "number" || typeof b !== "number" || !Number.isFinite(b)) return null;
        switch (spec.op) {
          case "+": return a + b; case "-": return a - b; case "*": return a * b;
          case "/": return b === 0 ? null : a / b;
          case "%": return b === 0 ? null : a % b;
          case "**": return Math.pow(a, b);
          default: return null;
        }
      });
    } else if (mode === "str") {
      const i = this.colIndex(spec.col);
      newVals = this.rows.map(r => {
        const v = r[i]; if (v === null) return null;
        const s = String(v);
        switch (spec.func) {
          case "upper": return s.toUpperCase();
          case "lower": return s.toLowerCase();
          case "title": return s.replace(/\w\S*/g, w => w[0].toUpperCase() + w.slice(1).toLowerCase());
          case "trim": return s.trim();
          case "length": return s.length;
          case "slice": { const a = Number(spec.argA) || 0; const b = spec.argB === "" || spec.argB === undefined ? undefined : Number(spec.argB); return s.slice(a, b); }
          case "replace": return spec.argA === "" ? s : s.split(String(spec.argA)).join(String(spec.argB ?? ""));
          case "contains": return s.toLowerCase().includes(String(spec.argA ?? "").toLowerCase());
          case "concat": return s + String(spec.argA ?? "");
          default: return null;
        }
      });
    } else if (mode === "date") {
      const i = this.colIndex(spec.col);
      newVals = this.rows.map(r => {
        const v = r[i]; if (v === null) return null;
        const d = new Date(String(v).replace(/\//g, "-"));
        if (isNaN(d)) return null;
        switch (spec.part) {
          case "year": return d.getFullYear();
          case "month": return d.getMonth() + 1;
          case "day": return d.getDate();
          case "weekday": return d.getDay(); // 0=Sunday like pandas dt.dayofweek (0=Mon in pandas; noted in UI)
          case "quarter": return Math.floor(d.getMonth() / 3) + 1;
          case "hour": return d.getHours();
          case "ym": return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
          default: return null;
        }
      });
    } else if (mode === "cond") { // np.where style single condition
      const i = this.colIndex(spec.condCol);
      const thenIsCol = spec.thenType === "column", elseIsCol = spec.elseType === "column";
      const ti = thenIsCol ? this.colIndex(spec.thenCol) : -1;
      const ei = elseIsCol ? this.colIndex(spec.elseCol) : -1;
      newVals = this.rows.map(r => {
        const ok = DataFrame.evalCond(r[i], spec.op, spec.condVal);
        if (ok) return thenIsCol ? r[ti] : parseScalar(spec.thenVal ?? "");
        return elseIsCol ? r[ei] : parseScalar(spec.elseVal ?? "");
      });
    } else if (mode === "cut") { // pd.cut binning
      const i = this.colIndex(spec.col);
      const edges = spec.edges.filter(e => e !== "" && !isNaN(Number(e))).map(Number).sort((a, b) => a - b);
      if (edges.length < 2) throw new Error("need at least 2 edges");
      const labels = spec.labels && spec.labels.length === edges.length - 1 ? spec.labels : null;
      newVals = this.rows.map(r => {
        const v = r[i];
        if (typeof v !== "number") return null;
        if (v < edges[0] || v > edges[edges.length - 1]) return null;
        for (let b = 0; b < edges.length - 1; b++) {
          const inBin = b === edges.length - 2 ? (v >= edges[b] && v <= edges[b + 1]) : (v >= edges[b] && v < edges[b + 1]);
          if (inBin) return labels ? labels[b] : `(${edges[b]}, ${edges[b + 1]}]`;
        }
        return null;
      });
    } else throw new Error("unknown add column mode");
    const rows = this.rows.map((r, ri) => [...r, newVals[ri] === undefined ? null : newVals[ri]]);
    return new DataFrame([...this.columns, name], rows, this.name);
  }

  /* ---------- merge (pd.merge) ---------- */
  merge(other, leftOn, rightOn, how = "inner") {
    const li = this.colIndex(leftOn), ri = other.colIndex(rightOn);
    const overlap = other.columns.filter(c => this.columns.includes(c) && c !== rightOn);
    const rightCols = other.columns.map(c => overlap.includes(c) ? c + "_y" : c);
    const leftCols = this.columns.map(c => overlap.includes(c) ? c + "_x" : c);
    const rKeep = other.columns.map((c, i) => i).filter(i => i !== ri); // drop right key
    const outCols = [...leftCols, ...rKeep.map(i => rightCols[i])];
    const index = new Map();
    for (const r of other.rows) {
      const k = String(r[ri]);
      if (!index.has(k)) index.set(k, []);
      index.get(k).push(r);
    }
    const matchedRight = new Set();
    const out = [];
    for (const l of this.rows) {
      const k = String(l[li]);
      const matches = index.get(k);
      if (matches) {
        for (const m of matches) {
          matchedRight.add(m);
          out.push([...l, ...rKeep.map(i => m[i])]);
        }
      } else if (how === "left" || how === "outer") {
        out.push([...l, ...rKeep.map(() => null)]);
      }
    }
    if (how === "right" || how === "outer") {
      for (const r of other.rows) {
        if (!matchedRight.has(r) && ![...this.rows].some(l => String(l[li]) === String(r[ri]))) {
          const leftNulls = this.columns.map((c, i) => i === li ? r[ri] : null);
          if (how === "outer" || true) out.push([...leftNulls, ...rKeep.map(i => r[i])]);
        }
      }
    }
    return new DataFrame(outCols, out, "merged");
  }

  /* ---------- export ---------- */
  toCSV() { return CSV.stringify(this.columns, this.rows); }
  toJSON() {
    return JSON.stringify(this.rows.map(r => {
      const o = {};
      this.columns.forEach((c, i) => o[c] = r[i]);
      return o;
    }), null, 2);
  }
}

/* expose */
window.PV = { DataFrame, CSV, Stats, inferType, parseScalar, smartCompare, NUM_RE, DATE_RE };
