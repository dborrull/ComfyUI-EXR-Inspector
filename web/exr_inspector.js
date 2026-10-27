// ComfyUI-EXR-Inspector - by David Borrull, VFX compositor
// MIT License - Copyright (c) 2026 David Borrull. See LICENSE.
//
// Node UI for "EXR A/B Inspector": toolbar, per-side layer / input space /
// data remap, readout with raw values, ctrl+click exact pick, fullscreen.
// View settings and layer choices are saved in node.properties.exrInspector,
// so they travel with the workflow and never need a new run.

import { Viewer, parsePixels } from "./viewer.js";

const { app } = window.comfyAPI.app;
const { api } = window.comfyAPI.api;

const NODE = "EXRInspector";
const DEFAULT_SETTINGS = {
    mode: "wipe", wipe: 0.5, exposure: 0, gamma: 1, saturation: 1, channel: "rgb", view: "srgb",
    falseColor: false, clip: false, diffGain: 1, bFit: "fit", windows: true,
};
const DEFAULT_SIDE = { layer: "", space: "auto", remap: { auto: true, lo: 0, hi: 1, invert: false } };
const HELP = [
    "Wheel: zoom   Drag: wipe (pan in other modes)   Middle / Alt / Space drag: pan",
    "Double-click or F: fit   0: 100%   Ctrl+click: exact values from the file",
    "1 / 2: A / B   W: wipe   K: blink   D: diff   R G B A Y: channel (again: RGB)",
    "[ ]: exposure -/+ 0.5   E: reset exposure, gamma, saturation   X: false colour   Z: clipping",
].join("\n");

function chain(obj, prop, fn) {
    const orig = obj[prop];
    obj[prop] = function () {
        const r = orig?.apply(this, arguments);
        fn.apply(this, arguments);
        return r;
    };
}

function el(tag, attrs = {}, ...children) {
    const e = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
        if (k === "class") e.className = v;
        else if (k.startsWith("on")) e.addEventListener(k.slice(2), v);
        else if (v !== undefined && v !== null) e.setAttribute(k, v);
    }
    for (const c of children) if (c !== null && c !== undefined) e.append(c);
    return e;
}

function select(options, value, onChange, title) {
    const s = el("select", { class: "exri-select", title });
    setOptions(s, options, value);
    s.addEventListener("change", () => onChange(s.value));
    return s;
}

function setOptions(s, options, value) {
    s.replaceChildren(...options.map(([v, label]) => el("option", { value: v }, label)));
    if (value !== undefined) s.value = value;
}

function toggle(label, title, onChange) {
    const b = el("button", { class: "exri-btn", title }, label);
    b.addEventListener("click", () => onChange(!b.classList.contains("on")));
    b.setOn = (on) => b.classList.toggle("on", !!on);
    return b;
}

function fmt(v) {
    if (v === null || v === undefined) return "-";
    if (typeof v === "string") return v;
    if (Number.isNaN(v)) return "nan";
    if (!Number.isFinite(v)) return v > 0 ? "inf" : "-inf";
    const a = Math.abs(v);
    if (a !== 0 && (a >= 1e5 || a < 1e-4)) return v.toExponential(3);
    return v.toFixed(5);
}

function escapeHtml(s) {
    return s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

function num(v) {
    if (typeof v === "number") return v;
    return v === "inf" ? Infinity : v === "-inf" ? -Infinity : NaN;
}

function layerKey(part, id) {
    return `${part}::${id}`;
}

function parseLayerKey(key) {
    const i = (key || "").indexOf("::");
    return i < 0 ? { part: 0, id: key || "" } : { part: parseInt(key.slice(0, i)) || 0, id: key.slice(i + 2) };
}

async function getJSON(url, signal) {
    const r = await api.fetchApi(url, { signal, cache: "no-store" });
    const body = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(body.error || `HTTP ${r.status}`);
    return body;
}

let serverConfig = null;
async function config() {
    if (!serverConfig) {
        try { serverConfig = await getJSON("/exr_inspector/config"); }
        catch { serverConfig = { max_texture: 4096 }; }
    }
    return serverConfig;
}

function injectStyle() {
    if (document.getElementById("exri-style")) return;
    const css = `
.exri-root { display: flex; flex-direction: column; width: 100%; height: 100%; min-height: 0;
  font: 11px/1.3 system-ui, sans-serif; color: var(--input-text, #ddd); outline: none; gap: 3px;
  box-sizing: border-box; }
.exri-bar { display: flex; flex-wrap: wrap; align-items: center; gap: 3px 6px; }
.exri-group { display: flex; align-items: center; gap: 3px; }
.exri-tag { font-weight: 600; min-width: 12px; }
.exri-select, .exri-num { background: var(--comfy-input-bg, #222); color: var(--input-text, #ddd);
  border: 1px solid var(--border-color, #444); border-radius: 4px; font: inherit; padding: 1px 3px; }
.exri-select { max-width: 190px; }
.exri-num { width: 58px; }
.exri-btn { background: var(--comfy-input-bg, #222); color: var(--input-text, #ddd); font: inherit;
  border: 1px solid var(--border-color, #444); border-radius: 4px; padding: 1px 6px; cursor: pointer; }
.exri-btn.on { background: var(--p-primary-color, #3a6ea5); color: #fff; border-color: transparent; }
.exri-range { width: 80px; accent-color: var(--p-primary-color, #3a6ea5); }
.exri-val { font-family: ui-monospace, monospace; min-width: 34px; }
.exri-viewport { position: relative; flex: 1 1 auto; min-height: 120px; background: #1b1b1b;
  border-radius: 4px; overflow: hidden; }
.exri-canvas { position: absolute; inset: 0; width: 100%; height: 100%; display: block; cursor: crosshair;
  touch-action: none; }
.exri-label, .exri-msg, .exri-marker { z-index: 1; }
.exri-label { position: absolute; top: 4px; padding: 1px 5px; border-radius: 3px; pointer-events: none;
  background: rgba(0,0,0,.55); color: #eee; max-width: 45%; overflow: hidden; text-overflow: ellipsis;
  white-space: nowrap; }
.exri-label.a { left: 4px; } .exri-label.b { right: 4px; }
.exri-msg { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center;
  text-align: center; padding: 12px; color: #aaa; pointer-events: none; white-space: pre-line; }
.exri-readout { font-family: ui-monospace, monospace; font-size: 11px; white-space: pre; overflow: hidden;
  min-height: 2.6em; color: var(--input-text, #ddd); }
.exri-readout .r { color: #f66; } .exri-readout .g { color: #6d6; } .exri-readout .b { color: #69f; }
.exri-marker { position: absolute; width: 9px; height: 9px; margin: -5px 0 0 -5px; border: 1px solid #fff;
  box-shadow: 0 0 0 1px #000; pointer-events: none; display: none; }
.exri-overlay { position: fixed; inset: 0; z-index: 10000; background: var(--comfy-menu-bg, #181818);
  padding: 8px; box-sizing: border-box; }
.exri-overlay .exri-root { font-size: 12px; }
`;
    document.head.append(el("style", { id: "exri-style" }, css));
}

class Inspector {
    constructor(node) {
        this.node = node;
        node.properties = node.properties || {};
        this.state = this._loadState();
        this.runtime = { a: {}, b: {} };       // src, header, abort, pick, error
        this.pick = null;
        this._build();
        this.viewer = new Viewer(this.viewport);
        this.viewer.set(this.state.settings);
        this.viewer.onHover = (info) => this._hover(info);
        this.viewer.onPick = (info) => this._pick(info);
        this.viewer.onViewChange = () => this._placeMarker();
        this._syncControls();
        this._setBlink();
    }

    _loadState() {
        const saved = this.node.properties.exrInspector || {};
        const side = (s) => ({ ...DEFAULT_SIDE, ...(s || {}), remap: { ...DEFAULT_SIDE.remap, ...(s?.remap || {}) } });
        return {
            settings: { ...DEFAULT_SETTINGS, ...(saved.settings || {}) },
            sides: { a: side(saved.sides?.a), b: side(saved.sides?.b) },
            exec: { ...(saved.exec || {}) },
        };
    }

    _save() {
        this.node.properties.exrInspector = this.state;
        clearTimeout(this._saveTimer);
        this._saveTimer = setTimeout(() => this.node.graph?.change?.(), 300);
    }

    // UI
    _build() {
        // Handlers read this.state each time: onConfigure replaces it
        const s = this.state.settings;
        const setS = (patch) => {
            Object.assign(this.state.settings, patch); this.viewer.set(patch); this._save(); this._syncControls();
        };

        this.modeSel = select([["a", "A"], ["b", "B"], ["wipe", "Wipe"], ["blink", "Blink"], ["diff", "Diff"]],
            s.mode, (v) => { setS({ mode: v }); this._setBlink(); }, "View mode (1 2 W K D)");
        this.expRange = el("input", { class: "exri-range", type: "range", min: -10, max: 10, step: 0.1,
            title: "Exposure in stops ([ ]). Double-click: 0" });
        this.expVal = el("span", { class: "exri-val" });
        this.expRange.addEventListener("input", () => setS({ exposure: parseFloat(this.expRange.value) }));
        this.expRange.addEventListener("dblclick", () => setS({ exposure: 0 }));
        this.gamRange = el("input", { class: "exri-range", type: "range", min: 0.2, max: 4, step: 0.05,
            title: "Gamma. Double-click: 1" });
        this.gamVal = el("span", { class: "exri-val" });
        this.gamRange.addEventListener("input", () => setS({ gamma: parseFloat(this.gamRange.value) }));
        this.gamRange.addEventListener("dblclick", () => setS({ gamma: 1 }));
        this.satRange = el("input", { class: "exri-range", type: "range", min: 0, max: 2, step: 0.05,
            title: "Saturation (RGB view). Double-click: 1" });
        this.satVal = el("span", { class: "exri-val" });
        this.satRange.addEventListener("input", () => setS({ saturation: parseFloat(this.satRange.value) }));
        this.satRange.addEventListener("dblclick", () => setS({ saturation: 1 }));
        this.chanSel = select([["rgb", "RGB"], ["r", "R"], ["g", "G"], ["b", "B"], ["a", "A"], ["luma", "Luma"]],
            s.channel, (v) => setS({ channel: v }), "Channel (R G B A Y)");
        this.viewSel = select([["srgb", "sRGB"], ["g22", "Gamma 2.2"], ["g24", "Gamma 2.4"], ["raw", "Raw"]],
            s.view, (v) => setS({ view: v }), "View transform (colour layers only)");
        this.falseBtn = toggle("False", "False colour: stops from 18% grey, heat map on data (X)",
            (on) => setS({ falseColor: on }));
        this.clipBtn = toggle("Clip", "Clipping: red zebra > 1, blue zebra < 0, magenta NaN/inf (Z)",
            (on) => setS({ clip: on }));
        this.gainSel = select([1, 2, 4, 8, 16, 32, 64, 128].map((g) => [String(g), "x" + g]), String(s.diffGain),
            (v) => setS({ diffGain: parseFloat(v) }), "Difference gain");
        this.fitSel = select([["fit", "B fit"], ["pixel", "B 1:1"]], s.bFit,
            (v) => { setS({ bFit: v }); this._hover(null); }, "How B lines up with A: fit A's format, or pixel for pixel (centred)");
        this.winBtn = toggle("Win", "Show display window (grey) and data window (blue)", (on) => setS({ windows: on }));
        const fitBtn = el("button", { class: "exri-btn", title: "Fit (F)" }, "Fit");
        fitBtn.addEventListener("click", () => this.viewer.fit());
        const oneBtn = el("button", { class: "exri-btn", title: "100% (0)" }, "1:1");
        oneBtn.addEventListener("click", () => this.viewer.zoomTo(1));
        this.fullBtn = el("button", { class: "exri-btn", title: "Fullscreen (Esc to close)" }, "⛶");
        this.fullBtn.addEventListener("click", () => this.toggleFullscreen());
        const help = el("span", { class: "exri-btn", title: HELP }, "?");

        const bar = el("div", { class: "exri-bar" },
            this.modeSel,
            el("span", { class: "exri-group" }, "Exp", this.expRange, this.expVal),
            el("span", { class: "exri-group" }, "γ", this.gamRange, this.gamVal),
            el("span", { class: "exri-group" }, "Sat", this.satRange, this.satVal),
            this.chanSel, this.viewSel, this.falseBtn, this.clipBtn,
            this.diffGroup = el("span", { class: "exri-group" }, "Diff", this.gainSel),
            this.fitSel, this.winBtn, fitBtn, oneBtn, this.fullBtn, help);

        this.sideUI = {};
        const sideBar = el("div", { class: "exri-bar" });
        for (const k of ["a", "b"]) sideBar.append(this._buildSide(k));

        this.viewport = el("div", { class: "exri-viewport" });
        this.labels = { a: el("div", { class: "exri-label a" }), b: el("div", { class: "exri-label b" }) };
        this.msg = el("div", { class: "exri-msg" });
        this.marker = el("div", { class: "exri-marker" });
        this.viewport.append(this.labels.a, this.labels.b, this.msg, this.marker);
        this.readout = el("div", { class: "exri-readout" });

        this.root = el("div", { class: "exri-root", tabindex: 0 }, bar, sideBar, this.viewport, this.readout);
        this.root.addEventListener("keydown", (e) => this._key(e));
        this.root.addEventListener("keyup", (e) => { if (e.code === "Space") this.viewer._space = false; });
        this.root.addEventListener("pointerenter", () => {
            const a = document.activeElement;
            if (!a || a === document.body || a.tagName === "CANVAS") this.root.focus({ preventScroll: true });
        });
        this.container = el("div", { class: "exri-host" });
        this.container.style.cssText = "width:100%;height:100%;";
        this.container.append(this.root);
    }

    _buildSide(k) {
        const st = () => this.state.sides[k];
        const ui = {};
        ui.layer = select([], "", (v) => { st().layer = v; this._save(); this.loadSide(k, { keepHeader: true }); },
            "Layer");
        ui.space = select([["auto", "auto"], ["sRGB", "sRGB"], ["linear", "linear"]], st().space, (v) => {
            st().space = v; this._save(); this._applySideOptions(k);
        }, "Input space of this side (auto: EXR/HDR linear, 8-bit and graph images sRGB)");
        ui.lo = el("input", { class: "exri-num", type: "number", step: "any", title: "Data remap: low" });
        ui.hi = el("input", { class: "exri-num", type: "number", step: "any", title: "Data remap: high" });
        const remap = (patch) => {
            st().remap = { ...st().remap, ...patch };
            this._save(); this._applySideOptions(k);
        };
        const onRange = () => remap({ auto: false, lo: parseFloat(ui.lo.value) || 0, hi: parseFloat(ui.hi.value) || 0 });
        ui.lo.addEventListener("change", onRange);
        ui.hi.addEventListener("change", onRange);
        ui.auto = el("button", { class: "exri-btn", title: "Remap to the layer's range (0.5-99.5 percentile, depth background ignored)" }, "Auto");
        ui.auto.addEventListener("click", () => remap({ auto: true }));
        ui.inv = toggle("Inv", "Invert the remap", (on) => remap({ invert: on }));
        ui.data = el("span", { class: "exri-group" }, ui.lo, ui.hi, ui.auto, ui.inv);
        ui.info = el("span", { class: "exri-val", style: "opacity:.7" });
        this.sideUI[k] = ui;
        return el("span", { class: "exri-group" }, el("span", { class: "exri-tag" }, k.toUpperCase()),
            ui.layer, ui.space, ui.data, ui.info);
    }

    _syncControls() {
        const s = this.state.settings;
        this.modeSel.value = s.mode;
        this.expRange.value = s.exposure;
        this.expVal.textContent = (s.exposure > 0 ? "+" : "") + s.exposure.toFixed(1);
        this.gamRange.value = s.gamma;
        this.gamVal.textContent = s.gamma.toFixed(2);
        this.satRange.value = s.saturation;
        this.satVal.textContent = s.saturation.toFixed(2);
        this.chanSel.value = s.channel;
        this.viewSel.value = s.view;
        this.falseBtn.setOn(s.falseColor);
        this.clipBtn.setOn(s.clip);
        this.winBtn.setOn(s.windows);
        this.gainSel.value = String(s.diffGain);
        this.fitSel.value = s.bFit;
        this.diffGroup.style.display = s.mode === "diff" ? "" : "none";
        for (const k of ["a", "b"]) {
            const ui = this.sideUI[k], st = this.state.sides[k], side = this.viewer?.sides[k];
            ui.space.value = st.space;
            const data = side?.kind === "data";
            ui.data.style.display = data ? "" : "none";
            ui.space.style.display = side && !data ? "" : "none";
            if (side) {
                ui.lo.value = +side.range[0].toPrecision(6);
                ui.hi.value = +side.range[1].toPrecision(6);
                ui.inv.setOn(st.remap.invert);
                ui.auto.classList.toggle("on", st.remap.auto);
            }
        }
        this._updateLabels();
    }

    _updateLabels() {
        const s = this.state.settings;
        for (const k of ["a", "b"]) {
            const rt = this.runtime[k], side = this.viewer?.sides[k];
            let show = !!side;
            if (s.mode === "a") show = show && k === "a";
            if (s.mode === "b") show = show && k === "b";
            if (s.mode === "blink") show = show && (k === "b") === this.viewer.blinkShowB;
            this.labels[k].style.display = show ? "" : "none";
            if (side) this.labels[k].textContent = `${k.toUpperCase()}  ${rt.header?.name || ""} · ${rt.layerLabel || ""}`;
        }
        // In A / B / blink the shown label sits on the left
        this.labels.b.classList.toggle("a", s.mode !== "wipe" && s.mode !== "diff");
        this.labels.b.classList.toggle("b", s.mode === "wipe" || s.mode === "diff");
    }

    _setBlink() {
        clearInterval(this._blinkTimer);
        this.viewer.blinkShowB = false;
        if (this.state.settings.mode === "blink") {
            this._blinkTimer = setInterval(() => {
                this.viewer.blinkShowB = !this.viewer.blinkShowB;
                this.viewer.render();
                this._updateLabels();
            }, 500);
        }
        this._updateLabels();
    }

    _message() {
        const parts = [];
        for (const k of ["a", "b"]) {
            const rt = this.runtime[k];
            if (rt.error) parts.push(`${k.toUpperCase()}: ${rt.error}`);
            else if (rt.loading) parts.push(`${k.toUpperCase()}: loading…`);
        }
        if (!parts.length && !this.viewer.sides.a && !this.viewer.sides.b) {
            parts.push("Type an EXR path (shows at once)\nor connect images and run the workflow.");
        }
        this.msg.textContent = parts.join("\n");
    }

    // Sources
    _pathWidget(k) {
        return this.node.widgets?.find((w) => w.name === "path_" + k);
    }

    _src(k) {
        const p = (this._pathWidget(k)?.value || "").trim();
        if (p) return "file:" + p;
        return this.state.exec[k] || null;
    }

    async loadSide(k, { keepHeader = false } = {}) {
        const rt = this.runtime[k], st = this.state.sides[k];
        rt.abort?.abort();
        const ctrl = rt.abort = new AbortController();
        const src = this._src(k);
        rt.error = null;
        if (!src) {
            rt.src = rt.header = null;
            this.viewer.setImage(k, null);
            setOptions(this.sideUI[k].layer, []);
            this.sideUI[k].info.textContent = "";
            this._syncControls(); this._message();
            return;
        }
        rt.loading = true;
        this._message();
        try {
            if (!keepHeader || rt.src !== src || !rt.header) {
                rt.header = await getJSON("/exr_inspector/header?src=" + encodeURIComponent(src), ctrl.signal);
                rt.src = src;
                this._fillLayers(k);
            }
            let { part, id } = parseLayerKey(st.layer);
            const p = rt.header.parts.find((x) => x.index === part) || rt.header.parts[0];
            let layer = p.layers.find((l) => l.id === id);
            if (!layer) layer = p.layers.find((l) => l.kind === "color") || p.layers[0];
            this.sideUI[k].layer.value = layerKey(p.index, layer.id);
            const max = Math.min((await config()).max_texture || 4096, this.viewer.maxTexture);
            const r = await api.fetchApi(`/exr_inspector/pixels?src=${encodeURIComponent(src)}&part=${p.index}`
                + `&layer=${encodeURIComponent(layer.id)}&max=${max}`, { signal: ctrl.signal, cache: "no-store" });
            if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || `HTTP ${r.status}`);
            const payload = parsePixels(await r.arrayBuffer());
            if (ctrl.signal.aborted) return;
            rt.part = p.index;
            rt.layer = layer.id;
            rt.layerLabel = (rt.header.parts.length > 1 ? (p.name || "part " + p.index) + " / " : "") + layer.label;
            this.viewer.setImage(k, payload, this._sideOptions(k, payload.meta));
            const m = payload.meta, dw = p.display_window;
            this.sideUI[k].info.textContent = `${dw[2] - dw[0] + 1}×${dw[3] - dw[1] + 1}`
                + (m.factor > 1 ? ` (proxy 1/${m.factor})` : "")
                + (p.primaries && !p.primaries.startsWith("Rec.709") ? ` · ${p.primaries}` : "");
        } catch (e) {
            if (e.name === "AbortError") return;
            rt.error = e.message;
            this.viewer.setImage(k, null);
        } finally {
            if (rt.abort === ctrl) rt.loading = false;
        }
        this._syncControls();
        this._message();
    }

    _fillLayers(k) {
        const h = this.runtime[k].header, multi = h.parts.length > 1;
        const opts = [];
        for (const p of h.parts) {
            for (const l of p.layers) {
                const name = (multi ? (p.name || "part " + p.index) + " / " : "") + l.label;
                opts.push([layerKey(p.index, l.id), `${name} [${l.suffixes.join("")}]${l.kind === "data" ? " ·data" : ""}`]);
            }
        }
        setOptions(this.sideUI[k].layer, opts);
    }

    _sideOptions(k, meta) {
        const st = this.state.sides[k], rt = this.runtime[k];
        const space = st.space === "auto" ? (rt.header?.default_space || "linear") : st.space;
        const range = st.remap.auto ? meta.stats.auto_range : [st.remap.lo, st.remap.hi];
        return { space, range, invert: st.remap.invert };
    }

    _applySideOptions(k) {
        const side = this.viewer.sides[k];
        if (side) this.viewer.setSideOptions(k, this._sideOptions(k, side.meta));
        this._syncControls();
    }

    // Readout
    _hover(info) {
        this._lastHover = info;
        cancelAnimationFrame(this._hoverRaf);
        this._hoverRaf = requestAnimationFrame(() => this._renderReadout());
    }

    _line(tag, smp, exact) {
        if (!smp) return null;
        const cls = ["r", "g", "b", ""];
        if (!smp.values) return `${tag}  (${smp.x}, ${smp.y})  outside data window`;
        const vals = smp.values.map((v, i) => {
            const name = escapeHtml((smp.channels[i] || "").padStart(2));
            return `<span class="${smp.channels.length > 1 ? cls[i] : ""}">${name} ${fmt(v).padStart(11)}</span>`;
        }).join(" ");
        const note = exact ? "  exact" : smp.proxy ? "  ~proxy" : "";
        return `${tag}  ${vals}${note}`;
    }

    _diffLine(a, b) {
        if (!a?.values || !b?.values) return null;
        const n = Math.min(a.values.length, b.values.length);
        const vals = [];
        for (let i = 0; i < n; i++) vals.push(`${escapeHtml((a.channels[i] || "").padStart(2))} ${fmt(num(a.values[i]) - num(b.values[i])).padStart(11)}`);
        return `A−B ${vals.join(" ")}`;
    }

    _renderReadout() {
        const info = this._lastHover, lines = [];
        if (info && (info.a || info.b)) {
            const ref = info.a || info.b;
            lines.push(`x ${ref.x}  y ${ref.y}` + (info.a && info.b && (info.a.x !== info.b.x || info.a.y !== info.b.y)
                ? `   (B ${info.b.x}, ${info.b.y})` : ""));
            lines.push(this._line("A  ", info.a), this._line("B  ", info.b), this._diffLine(info.a, info.b));
        }
        if (this.pick) {
            const p = this.pick;
            lines.push(`Pick x ${p.x}  y ${p.y}`);
            lines.push(this._line("A  ", p.a, true), this._line("B  ", p.b, true), this._diffLine(p.a, p.b));
        }
        this.readout.innerHTML = lines.filter(Boolean).join("\n");   // channel names escaped in _line
    }

    async _pick(info) {
        const out = { x: (info.a || info.b)?.x, y: (info.a || info.b)?.y, wx: info.wx, wy: info.wy, a: null, b: null };
        for (const k of ["a", "b"]) {
            const rt = this.runtime[k], smp = info[k];
            if (!smp || !rt.src) continue;
            try {
                const r = await getJSON(`/exr_inspector/sample?src=${encodeURIComponent(rt.src)}&part=${rt.part}`
                    + `&layer=${encodeURIComponent(rt.layer)}&x=${smp.x}&y=${smp.y}`);
                out[k] = { ...smp, values: r.values, channels: r.channels };
            } catch (e) {
                out[k] = { ...smp, values: null };
            }
        }
        this.pick = out;
        this._placeMarker();
        this._renderReadout();
    }

    _placeMarker() {
        if (!this.pick) { this.marker.style.display = "none"; return; }
        const [x, y] = this.viewer.worldToScreen(Math.floor(this.pick.wx) + 0.5, Math.floor(this.pick.wy) + 0.5);
        this.marker.style.display = "block";
        this.marker.style.left = x + "px";
        this.marker.style.top = y + "px";
    }

    // Keys
    _key(e) {
        if (e.target.tagName === "INPUT" || e.target.tagName === "SELECT") return;
        const s = this.state.settings;
        const set = (patch) => {
            Object.assign(s, patch); this.viewer.set(patch); this._save(); this._syncControls();
        };
        const chan = { r: "r", g: "g", b: "b", a: "a", y: "luma" };
        const k = e.key.toLowerCase();
        let handled = true;
        if (e.ctrlKey || e.metaKey || e.altKey) handled = false;
        else if (e.code === "Space") this.viewer._space = true;
        else if (k === "escape" && this.overlay) this.toggleFullscreen();
        else if (k === "f") this.viewer.fit();
        else if (k === "0") this.viewer.zoomTo(1);
        else if (k === "1") { set({ mode: "a" }); this._setBlink(); }
        else if (k === "2") { set({ mode: "b" }); this._setBlink(); }
        else if (k === "w") { set({ mode: "wipe" }); this._setBlink(); }
        else if (k === "k") { set({ mode: "blink" }); this._setBlink(); }
        else if (k === "d") { set({ mode: "diff" }); this._setBlink(); }
        else if (chan[k]) set({ channel: s.channel === chan[k] ? "rgb" : chan[k] });
        else if (k === "c") set({ channel: "rgb" });
        else if (k === "[") set({ exposure: Math.max(-10, s.exposure - 0.5) });
        else if (k === "]") set({ exposure: Math.min(10, s.exposure + 0.5) });
        else if (k === "e") set({ exposure: 0, gamma: 1, saturation: 1 });
        else if (k === "x") set({ falseColor: !s.falseColor });
        else if (k === "z") set({ clip: !s.clip });
        else handled = false;
        if (handled) { e.preventDefault(); e.stopPropagation(); }
    }

    toggleFullscreen() {
        if (this.overlay) {
            this.container.append(this.root);
            this.overlay.remove();
            this.overlay = null;
            this.fullBtn.classList.remove("on");
        } else {
            this.overlay = el("div", { class: "exri-overlay" }, this.root);
            document.body.append(this.overlay);
            this.fullBtn.classList.add("on");
            this.root.focus({ preventScroll: true });
        }
        requestAnimationFrame(() => { this.viewer.resize(); this.viewer.fit(); });
    }

    // Node events
    executed(message) {
        const sides = message?.exr_inspector?.[0];
        if (!sides) return;
        this.state.exec = { a: sides.a?.src || null, b: sides.b?.src || null };
        this._save();
        for (const k of ["a", "b"]) this.loadSide(k, { keepHeader: false });
    }

    reloadAll() {
        for (const k of ["a", "b"]) this.loadSide(k);
    }

    dispose() {
        clearInterval(this._blinkTimer);
        for (const k of ["a", "b"]) this.runtime[k].abort?.abort();
        this.overlay?.remove();
        this.viewer.dispose();
    }
}

app.registerExtension({
    name: "dborrull.EXRInspector",
    beforeRegisterNodeDef(nodeType, nodeData) {
        if (nodeData.name !== NODE) return;
        injectStyle();

        chain(nodeType.prototype, "onNodeCreated", function () {
            const insp = this.exrInspector = new Inspector(this);
            this.addDOMWidget("exr_inspector", "exr_inspector", insp.container, {
                serialize: false,
                hideOnZoom: false,
                hideInPanel: true,        // the side panel would resize it to its own width
                getMinHeight: () => 300,
            });
            for (const k of ["a", "b"]) {
                const w = insp._pathWidget(k);
                if (w) chain(w, "callback", () => insp.loadSide(k));
            }
            this.size = [Math.max(this.size[0], 620), Math.max(this.size[1], 640)];
            requestAnimationFrame(() => insp.reloadAll());
        });

        chain(nodeType.prototype, "onConfigure", function () {
            const insp = this.exrInspector;
            if (!insp) return;
            insp.state = insp._loadState();
            insp.viewer.set(insp.state.settings);
            insp._syncControls();
            insp._setBlink();
            requestAnimationFrame(() => insp.reloadAll());
        });

        chain(nodeType.prototype, "onExecuted", function (message) {
            this.exrInspector?.executed(message);
        });

        chain(nodeType.prototype, "onRemoved", function () {
            this.exrInspector?.dispose();
        });
    },
});
