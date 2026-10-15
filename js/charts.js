/* ============================================================
 * PandaVis Charts — builds ECharts options from a DataFrame.
 * Pure functions: no DOM access except the export helper.
 * ============================================================ */
"use strict";

const Charts = (() => {

  const PALETTE = ["#6366f1", "#22c55e", "#f59e0b", "#ef4444", "#06b6d4",
    "#a855f7", "#ec4899", "#84cc16", "#f97316", "#14b8a6", "#eab308", "#8b5cf6"];

  function baseColors(dark) {
    return {
      text: dark ? "#cbd5e1" : "#334155",
      axis: dark ? "#64748b" : "#94a3b8",
      split: dark ? "rgba(148,163,184,.15)" : "rgba(100,116,139,.15)",
      bg: "transparent"
    };
  }

  function fmtNum(v) {
    if (v === null || v === undefined) return "-";
    if (typeof v === "number") {
      if (Number.isInteger(v)) return String(v);
      return Math.abs(v) >= 1000 ? v.toLocaleString(undefined, { maximumFractionDigits: 2 })
        : Math.round(v * 10000) / 10000;
    }
    return String(v);
  }

  /* Group rows by x column, aggregate y. Returns {cats, vals} sorted smartly. */
  function aggregateBy(df, xCol, yCol, agg) {
    const xi = df.colIndex(xCol);
    const yi = yCol ? df.colIndex(yCol) : -1;
    const map = new Map();
    for (const r of df.rows) {
      const k = r[xi] === null ? "(NaN)" : r[xi];
      if (!map.has(k)) map.set(k, []);
      map.get(k).push(yi >= 0 ? r[yi] : 1);
    }
    let entries = [...map.entries()];
    // smart sort: numeric/date ascending, else by value desc
    const xType = df.typeOf(xCol);
    if (xType === "number" || xType === "date") {
      entries.sort((a, b) => PV.smartCompare(a[0], b[0]));
    } else {
      entries.sort((a, b) => {
        const va = PV.Stats.aggregate(a[1], agg) || 0, vb = PV.Stats.aggregate(b[1], agg) || 0;
        return vb - va;
      });
    }
    if (entries.length > 30 && (xType === "string" || xType === "mixed")) entries = entries.slice(0, 30);
    return {
      cats: entries.map(e => String(e[0])),
      vals: entries.map(e => PV.Stats.aggregate(e[1], agg))
    };
  }

  /* Multi-series: split by groupBy column (top 8 groups) */
  function aggregateGrouped(df, xCol, yCol, agg, gCol) {
    const groups = df.unique(gCol, 8);
    const xi = df.colIndex(xCol);
    const xType = df.typeOf(xCol);
    const catSet = [];
    const seen = new Set();
    for (const r of df.rows) {
      const k = String(r[xi] === null ? "(NaN)" : r[xi]);
      if (!seen.has(k)) { seen.add(k); catSet.push(k); }
    }
    if (xType === "number" || xType === "date") catSet.sort(PV.smartCompare);
    else catSet.sort();
    const cats = catSet.slice(0, 30);
    const series = groups.map(g => {
      const sub = df.query([{ col: gCol, op: "eq", value: g }]);
      const aggRes = aggregateBy(sub, xCol, yCol, agg);
      const m = new Map(aggRes.cats.map((c, i) => [c, aggRes.vals[i]]));
      return { name: String(g), data: cats.map(c => m.has(c) ? m.get(c) : null) };
    });
    return { cats, series };
  }

  function axisBase(c, titleText) {
    return {
      axisLabel: { color: c.text, rotate: 0 },
      axisLine: { lineStyle: { color: c.axis } },
      splitLine: { lineStyle: { color: c.split } },
      name: titleText || "",
      nameTextStyle: { color: c.text }
    };
  }

  function buildOption(df, spec, dark, S) {
    const c = baseColors(dark);
    const t = spec.type;
    const base = {
      backgroundColor: c.bg,
      color: PALETTE,
      textStyle: { color: c.text },
      title: { text: spec.title || "", left: "center", textStyle: { color: c.text, fontSize: 15 } },
      tooltip: { trigger: t === "scatter" || t === "box" ? "item" : "axis" },
      grid: { left: 70, right: 30, top: spec.title ? 50 : 40, bottom: 70, containLabel: false },
    };

    /* ---------- histogram ---------- */
    if (t === "hist") {
      const vals = PV.Stats.nums(df.col(spec.y)).sort((a, b) => a - b);
      if (!vals.length) return null;
      const bins = Math.max(2, Math.min(60, spec.bins || 15));
      const min = vals[0], max = vals[vals.length - 1];
      const w = (max - min) / bins || 1;
      const counts = new Array(bins).fill(0);
      for (const v of vals) {
        let b = Math.min(bins - 1, Math.floor((v - min) / w));
        counts[b]++;
      }
      const labels = counts.map((_, i) => `${fmtNum(Math.round((min + i * w) * 100) / 100)}~${fmtNum(Math.round((min + (i + 1) * w) * 100) / 100)}`);
      return {
        ...base,
        xAxis: { type: "category", data: labels, ...axisBase(c), axisLabel: { color: c.text, rotate: 35 } },
        yAxis: { type: "value", ...axisBase(c) },
        series: [{ type: "bar", data: counts, barCategoryGap: "8%", itemStyle: { borderRadius: [4, 4, 0, 0] } }],
        tooltip: { trigger: "axis" }
      };
    }

    /* ---------- box plot ---------- */
    if (t === "box") {
      const five = a => {
        const s = [...a].sort((x, y) => x - y);
        return [s[0], PV.Stats.quantile(s, .25), PV.Stats.quantile(s, .5), PV.Stats.quantile(s, .75), s[s.length - 1]];
      };
      let cats, data;
      if (spec.groupBy && spec.groupBy !== "__none__") {
        cats = df.unique(spec.groupBy, 12).map(String);
        data = cats.map(g => five(PV.Stats.nums(df.query([{ col: spec.groupBy, op: "eq", value: g }]).col(spec.y))));
      } else {
        cats = [spec.y];
        data = [five(PV.Stats.nums(df.col(spec.y)))];
      }
      return {
        ...base,
        tooltip: { trigger: "item" },
        xAxis: { type: "category", data: cats, ...axisBase(c), axisLabel: { color: c.text, rotate: cats.length > 6 ? 25 : 0 } },
        yAxis: { type: "value", ...axisBase(c) },
        series: [{ type: "boxplot", data, itemStyle: { borderWidth: 1.5 } }]
      };
    }

    /* ---------- scatter ---------- */
    if (t === "scatter") {
      const mk = sub => sub.rows
        .filter(r => typeof r[sub.colIndex(spec.x)] === "number" && typeof r[sub.colIndex(spec.y)] === "number")
        .map(r => [r[sub.colIndex(spec.x)], r[sub.colIndex(spec.y)]]);
      let series;
      if (spec.groupBy && spec.groupBy !== "__none__") {
        series = df.unique(spec.groupBy, 8).map(g => ({
          name: String(g), type: "scatter", data: mk(df.query([{ col: spec.groupBy, op: "eq", value: g }])),
          symbolSize: 8, emphasis: { focus: "series" }
        }));
        base.legend = { textStyle: { color: c.text }, bottom: 8 };
      } else {
        series = [{ type: "scatter", data: mk(df), symbolSize: 8 }];
      }
      base.grid.bottom = 60;
      return {
        ...base,
        xAxis: { type: "value", ...axisBase(c), name: spec.x },
        yAxis: { type: "value", ...axisBase(c), name: spec.y },
        series
      };
    }

    /* ---------- heatmap (corr / pivot) ---------- */
    if (t === "heat") {
      let xCats, yCats, cells;
      if (spec.heatMode === "corr") {
        const corr = df.corr();
        xCats = corr.columns; yCats = corr.indexLabels;
        cells = [];
        corr.rows.forEach((row, i) => row.forEach((v, j) => cells.push([j, i, v])));
      } else {
        const p = df.pivot(spec.heatIndex, spec.heatColumns, spec.heatValues, spec.heatAgg || "mean");
        xCats = p.columns.slice(1); yCats = p.col(p.columns[0]).map(String);
        cells = [];
        p.rows.forEach((row, i) => row.slice(1).forEach((v, j) => { if (typeof v === "number") cells.push([j, i, Math.round(v * 1000) / 1000]); }));
      }
      const nums = cells.map(cl => cl[2]).filter(v => typeof v === "number");
      const lo = Math.min(...nums), hi = Math.max(...nums);
      return {
        ...base,
        tooltip: { position: "top" },
        grid: { left: 110, right: 80, top: spec.title ? 50 : 30, bottom: 80 },
        xAxis: { type: "category", data: xCats, ...axisBase(c), axisLabel: { color: c.text, rotate: 30 } },
        yAxis: { type: "category", data: yCats, ...axisBase(c) },
        visualMap: {
          min: lo, max: hi, calculable: true, orient: "vertical", right: 8, top: "center",
          textStyle: { color: c.text },
          inRange: spec.heatMode === "corr"
            ? { color: ["#3b82f6", dark ? "#1e293b" : "#f1f5f9", "#ef4444"] }
            : { color: [dark ? "#1e293b" : "#eef2ff", "#6366f1", "#312e81"] }
        },
        series: [{ type: "heatmap", data: cells, label: { show: xCats.length <= 10, color: c.text, fontSize: 10 } }]
      };
    }

    /* ---------- pie ---------- */
    if (t === "pie") {
      const agg = spec.agg || "count";
      const { cats, vals } = aggregateBy(df, spec.x, agg === "count" ? null : spec.y, agg === "count" ? "count" : agg);
      return {
        ...base,
        tooltip: { trigger: "item", formatter: "{b}: {c} ({d}%)" },
        legend: { type: "scroll", bottom: 8, textStyle: { color: c.text } },
        series: [{
          type: "pie", radius: ["35%", "65%"], center: ["50%", "52%"],
          itemStyle: { borderRadius: 6, borderColor: dark ? "#0f172a" : "#fff", borderWidth: 2 },
          label: { color: c.text },
          data: cats.map((k, i) => ({ name: k, value: vals[i] }))
        }]
      };
    }

    /* ---------- bar / barh / line / area ---------- */
    if (["bar", "barh", "line", "area"].includes(t)) {
      const agg = spec.agg || "count";
      const useCount = agg === "count";
      const horizontal = t === "barh";
      const grouped = spec.groupBy && spec.groupBy !== "__none__";
      let cats, series;
      if (grouped) {
        const g = aggregateGrouped(df, spec.x, useCount ? null : spec.y, useCount ? "count" : agg, spec.groupBy);
        cats = g.cats;
        series = g.series.map(s => ({
          name: s.name, type: t === "line" || t === "area" ? "line" : "bar",
          data: s.data,
          areaStyle: t === "area" ? { opacity: .25 } : undefined,
          smooth: t === "line" || t === "area",
          itemStyle: (t === "bar" || t === "barh") ? { borderRadius: horizontal ? [0, 4, 4, 0] : [4, 4, 0, 0] } : undefined
        }));
        base.legend = { type: "scroll", bottom: 8, textStyle: { color: c.text } };
      } else {
        const r = aggregateBy(df, spec.x, useCount ? null : spec.y, useCount ? "count" : agg);
        cats = r.cats;
        series = [{
          type: t === "line" || t === "area" ? "line" : "bar",
          data: r.vals,
          areaStyle: t === "area" ? { opacity: .25 } : undefined,
          smooth: t === "line" || t === "area",
          itemStyle: (t === "bar" || t === "barh") ? { borderRadius: horizontal ? [0, 4, 4, 0] : [4, 4, 0, 0] } : undefined
        }];
      }
      const catAxis = { type: "category", data: cats, ...axisBase(c), axisLabel: { color: c.text, rotate: cats.length > 10 ? 30 : 0 } };
      const valAxis = { type: "value", ...axisBase(c) };
      return {
        ...base,
        xAxis: horizontal ? valAxis : catAxis,
        yAxis: horizontal ? catAxis : valAxis,
        series
      };
    }

    return null;
  }

  return { buildOption, PALETTE, fmtNum };
})();

window.Charts = Charts;
