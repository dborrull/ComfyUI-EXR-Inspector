// ComfyUI-EXR-Inspector - by David Borrull
// MIT License - Copyright (c) 2026 David Borrull. See LICENSE.
//
// WebGL2 viewer: two float16 textures (A, B), shared view (zoom / pan),
// wipe / blink / diff, exposure, gamma, channels, false colour, clipping.
// Pixel values for the eyedropper are read from the CPU copy of the same
// float16 data, so they are the file values (averaged when proxied).

import { VERTEX, FRAGMENT } from "./shaders.js";

const MODES = { a: 0, b: 1, wipe: 2, blink: 0, diff: 3 };
const CHANNELS = { rgb: 0, r: 1, g: 2, b: 3, a: 4, luma: 5 };
const VIEWS = { srgb: 0, g22: 1, g24: 2, raw: 3 };
const FORMATS = {
    1: ["R16F", "RED"], 2: ["RG16F", "RG"], 3: ["RGB16F", "RGB"], 4: ["RGBA16F", "RGBA"],
};

export function halfToFloat(h) {
    const s = h & 0x8000 ? -1 : 1;
    const e = (h >> 10) & 0x1f;
    const f = h & 0x3ff;
    if (e === 0) return s * 2 ** -14 * (f / 1024);
    if (e === 31) return f ? NaN : s * Infinity;
    return s * 2 ** (e - 15) * (1 + f / 1024);
}

// Payload from /exr_inspector/pixels: "EXRI", uint32 meta length, JSON, float16 pixels
export function parsePixels(buffer) {
    const view = new DataView(buffer);
    const magic = String.fromCharCode(...new Uint8Array(buffer, 0, 4));
    if (magic !== "EXRI") throw new Error("Bad pixel payload");
    const n = view.getUint32(4, true);
    const meta = JSON.parse(new TextDecoder().decode(new Uint8Array(buffer, 8, n)));
    const data = new Uint16Array(buffer, 8 + n, meta.width * meta.height * meta.channels.length);
    return { meta, data };
}

function compile(gl, type, src) {
    const sh = gl.createShader(type);
    gl.shaderSource(sh, src);
    gl.compileShader(sh);
    if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
        const log = gl.getShaderInfoLog(sh);
        gl.deleteShader(sh);
        throw new Error("Shader: " + log);
    }
    return sh;
}

export class Viewer {
    constructor(host) {
        this.host = host;                       // element the canvas fills
        this.canvas = document.createElement("canvas");
        this.canvas.className = "exri-canvas";
        host.appendChild(this.canvas);
        this.sides = { a: null, b: null };      // {meta, data, tex, nch, space, kind, range, invert}
        this.view = { cx: 0, cy: 0, zoom: 1, fitted: false };
        this.settings = {
            mode: "wipe", wipe: 0.5, exposure: 0, gamma: 1, saturation: 1, channel: "rgb", view: "srgb",
            falseColor: false, clip: false, diffGain: 1, bFit: "fit", windows: true,
        };
        this.blinkShowB = false;
        this.onHover = null;                    // (info | null) => void
        this.onPick = null;                     // (info) => void, ctrl+click
        this.onViewChange = null;
        this._raf = 0;
        this._initGL();
        this._initEvents();
        this._resizeObs = new ResizeObserver(() => this.resize());
        this._resizeObs.observe(host);
    }

    // GL
    _initGL() {
        const gl = this.canvas.getContext("webgl2", { antialias: false, premultipliedAlpha: false });
        if (!gl) throw new Error("WebGL2 is not available in this browser.");
        this.gl = gl;
        this.maxTexture = gl.getParameter(gl.MAX_TEXTURE_SIZE);
        const prog = gl.createProgram();
        gl.attachShader(prog, compile(gl, gl.VERTEX_SHADER, VERTEX));
        gl.attachShader(prog, compile(gl, gl.FRAGMENT_SHADER, FRAGMENT));
        gl.linkProgram(prog);
        if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
            throw new Error("Shader link: " + gl.getProgramInfoLog(prog));
        }
        this.prog = prog;
        this.vao = gl.createVertexArray();
        this.uni = {};
        const n = gl.getProgramParameter(prog, gl.ACTIVE_UNIFORMS);
        for (let i = 0; i < n; i++) {
            const name = gl.getActiveUniform(prog, i).name;
            this.uni[name] = gl.getUniformLocation(prog, name);
        }
        // An empty 1x1 texture keeps both samplers valid
        this.emptyTex = this._makeTexture(1, 1, 1, new Uint16Array([0]));
        this.canvas.addEventListener("webglcontextlost", (e) => e.preventDefault());
        this.canvas.addEventListener("webglcontextrestored", () => {
            const keep = { a: this.sides.a, b: this.sides.b };
            this._initGL();
            for (const k of ["a", "b"]) {
                if (keep[k]) keep[k].tex = this._makeTexture(keep[k].meta.width, keep[k].meta.height,
                    keep[k].nch, keep[k].data);
            }
            this.render();
        });
    }

    _makeTexture(w, h, nch, data) {
        const gl = this.gl;
        const [internal, format] = FORMATS[nch];
        const tex = gl.createTexture();
        gl.bindTexture(gl.TEXTURE_2D, tex);
        gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl[internal], w, h, 0, gl[format], gl.HALF_FLOAT, data);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
        return tex;
    }

    // side: "a" | "b"; payload: {meta, data} from parsePixels, or null to clear
    setImage(side, payload, opts = {}) {
        const old = this.sides[side];
        if (old?.tex) this.gl.deleteTexture(old.tex);
        if (!payload) {
            this.sides[side] = null;
        } else {
            const { meta, data } = payload;
            const nch = meta.channels.length;
            this.sides[side] = {
                meta, data, nch,
                tex: this._makeTexture(meta.width, meta.height, nch, data),
                kind: meta.kind, space: opts.space || "linear",
                range: opts.range || meta.stats.auto_range, invert: !!opts.invert,
            };
        }
        if (!this.view.fitted) this.fit();
        this.render();
    }

    setSideOptions(side, opts) {
        const s = this.sides[side];
        if (!s) return;
        Object.assign(s, opts);
        this.render();
    }

    set(settings) {
        Object.assign(this.settings, settings);
        this.render();
    }

    // Geometry
    _ref() {
        return this.sides.a || this.sides.b;
    }

    static _rect(w) {      // [x0, y0, x1, y1] inclusive -> {x0, y0, x1, y1} exclusive
        return { x0: w[0], y0: w[1], x1: w[2] + 1, y1: w[3] + 1 };
    }

    _center(s) {
        const d = Viewer._rect(s.meta.display_window);
        return [(d.x0 + d.x1) / 2, (d.y0 + d.y1) / 2];
    }

    _scale(side) {
        const s = this.sides[side], ref = this._ref();
        if (!s || s === ref || this.settings.bFit === "pixel") return 1;
        const r = Viewer._rect(ref.meta.display_window), d = Viewer._rect(s.meta.display_window);
        return Math.min((r.x1 - r.x0) / (d.x1 - d.x0), (r.y1 - r.y0) / (d.y1 - d.y0));
    }

    _par() {
        return this._ref()?.meta.pixel_aspect || 1;
    }

    // CSS pixels in the canvas -> world (reference image) coords
    screenToWorld(x, y) {
        const v = this.view, w = this.canvas.clientWidth, h = this.canvas.clientHeight;
        return [(x - w / 2) / v.zoom / this._par() + v.cx, (y - h / 2) / v.zoom + v.cy];
    }

    worldToScreen(wx, wy) {
        const v = this.view, w = this.canvas.clientWidth, h = this.canvas.clientHeight;
        return [(wx - v.cx) * v.zoom * this._par() + w / 2, (wy - v.cy) * v.zoom + h / 2];
    }

    worldToImage(side, wx, wy) {
        const s = this.sides[side], ref = this._ref();
        if (!s) return null;
        const [rcx, rcy] = this._center(ref), [cx, cy] = this._center(s), k = this._scale(side);
        return [(wx - rcx) / k + cx, (wy - rcy) / k + cy];
    }

    fit() {
        const ref = this._ref();
        const w = this.canvas.clientWidth, h = this.canvas.clientHeight;
        if (!ref || !w || !h) return;
        const d = Viewer._rect(ref.meta.display_window);
        const iw = (d.x1 - d.x0) * this._par(), ih = d.y1 - d.y0;
        this.view = {
            cx: (d.x0 + d.x1) / 2, cy: (d.y0 + d.y1) / 2,
            zoom: Math.min(w / iw, h / ih) * 0.95, fitted: true,
        };
        this._viewChanged();
    }

    zoomTo(zoom, sx, sy) {
        const w = this.canvas.clientWidth, h = this.canvas.clientHeight;
        if (sx === undefined) { sx = w / 2; sy = h / 2; }
        const [wx, wy] = this.screenToWorld(sx, sy);
        this.view.zoom = Math.min(256, Math.max(1 / 64, zoom));
        // keep the world point under the cursor
        this.view.cx = wx - (sx - w / 2) / this.view.zoom / this._par();
        this.view.cy = wy - (sy - h / 2) / this.view.zoom;
        this.view.fitted = true;
        this._viewChanged();
    }

    _viewChanged() {
        this.render();
        this.onViewChange?.(this.view);
    }

    resize() {
        const dpr = window.devicePixelRatio || 1;
        const w = Math.max(1, Math.round(this.canvas.clientWidth * dpr));
        const h = Math.max(1, Math.round(this.canvas.clientHeight * dpr));
        if (this.canvas.width !== w || this.canvas.height !== h) {
            this.canvas.width = w;
            this.canvas.height = h;
            if (!this.view.fitted || this._autoFit) this.fit();
            this.render();
        }
    }

    // Pixel values (file values) of one side under a world point
    sample(side, wx, wy) {
        const s = this.sides[side];
        if (!s) return null;
        const [ix, iy] = this.worldToImage(side, wx, wy);
        const x = Math.floor(ix), y = Math.floor(iy);
        const dw = s.meta.data_window, f = s.meta.factor;
        const out = { x, y, channels: s.meta.channels, proxy: f > 1, values: null };
        if (x < dw[0] || y < dw[1] || x > dw[2] || y > dw[3]) return out;
        const tx = Math.floor((x - dw[0]) / f), ty = Math.floor((y - dw[1]) / f);
        if (tx >= s.meta.width || ty >= s.meta.height) return out;
        const base = (ty * s.meta.width + tx) * s.nch;
        out.values = Array.from(s.data.subarray(base, base + s.nch), halfToFloat);
        return out;
    }

    // Rendering
    render() {
        if (this._raf) return;
        this._raf = requestAnimationFrame(() => {
            this._raf = 0;
            this._draw();
        });
    }

    _setSide(prefix, side, unit) {
        const gl = this.gl, u = this.uni, s = this.sides[side];
        const set1i = (n, v) => u[prefix + n] && gl.uniform1i(u[prefix + n], v);
        gl.activeTexture(gl.TEXTURE0 + unit);
        gl.bindTexture(gl.TEXTURE_2D, s ? s.tex : this.emptyTex);
        set1i(".has", s ? 1 : 0);
        if (!s) return;
        const m = s.meta, dw = m.data_window, dp = m.display_window;
        set1i(".nch", s.nch);
        gl.uniform4f(u[prefix + ".data"], dw[0], dw[1], dw[2] + 1, dw[3] + 1);
        gl.uniform2f(u[prefix + ".span"], m.width * m.factor, m.height * m.factor);
        const [cx, cy] = this._center(s);
        gl.uniform2f(u[prefix + ".center"], cx, cy);
        gl.uniform1f(u[prefix + ".scale"], this._scale(side));
        gl.uniform4f(u[prefix + ".disp"], dp[0], dp[1], dp[2] + 1, dp[3] + 1);
        set1i(".kind", s.kind === "data" ? 1 : 0);
        set1i(".space", s.space === "sRGB" ? 1 : 0);
        gl.uniformMatrix3fv(u[prefix + ".gamut"], true, m.to_rec709);
        gl.uniform2f(u[prefix + ".range"], s.range[0], s.range[1]);
        set1i(".invert", s.invert ? 1 : 0);
    }

    _draw() {
        const gl = this.gl, u = this.uni, st = this.settings;
        if (!gl || gl.isContextLost()) return;
        const dpr = this.canvas.width / Math.max(1, this.canvas.clientWidth);
        gl.viewport(0, 0, this.canvas.width, this.canvas.height);
        gl.useProgram(this.prog);
        gl.bindVertexArray(this.vao);
        gl.uniform1i(u.uTexA, 0);
        gl.uniform1i(u.uTexB, 1);
        this._setSide("uA", "a", 0);
        this._setSide("uB", "b", 1);
        const ref = this._ref();
        const [rcx, rcy] = ref ? this._center(ref) : [0, 0];
        gl.uniform2f(u.uViewport, this.canvas.width, this.canvas.height);
        gl.uniform2f(u.uCenter, this.view.cx, this.view.cy);
        gl.uniform1f(u.uZoom, this.view.zoom * dpr);
        gl.uniform1f(u.uPar, this._par());
        gl.uniform2f(u.uRefCenter, rcx, rcy);
        if (ref) {
            const dp = ref.meta.display_window, dw = ref.meta.data_window;
            gl.uniform4f(u.uRefDisp, dp[0], dp[1], dp[2] + 1, dp[3] + 1);
            gl.uniform4f(u.uRefData, dw[0], dw[1], dw[2] + 1, dw[3] + 1);
        }
        let mode = MODES[st.mode];
        if (st.mode === "blink") mode = this.blinkShowB ? 1 : 0;
        gl.uniform1i(u.uMode, mode);
        gl.uniform1f(u.uWipe, st.wipe);
        gl.uniform1f(u.uGain, 2 ** st.exposure);
        gl.uniform1f(u.uGamma, Math.max(0.01, st.gamma));
        gl.uniform1f(u.uSaturation, st.saturation);
        gl.uniform1i(u.uChannel, CHANNELS[st.channel]);
        gl.uniform1i(u.uView, VIEWS[st.view]);
        gl.uniform1f(u.uDiffGain, st.diffGain);
        gl.uniform1i(u.uFalse, st.falseColor ? 1 : 0);
        gl.uniform1i(u.uClip, st.clip ? 1 : 0);
        gl.uniform1i(u.uWindows, st.windows ? 1 : 0);
        gl.drawArrays(gl.TRIANGLES, 0, 3);
    }

    // Interaction: wheel zoom, middle / alt / space drag pan, left drag moves
    // the wipe (or pans outside wipe mode), ctrl+click picks an exact sample.
    _initEvents() {
        const c = this.canvas;
        let drag = null;
        c.addEventListener("wheel", (e) => {
            e.preventDefault();
            e.stopPropagation();
            const r = c.getBoundingClientRect();
            this.zoomTo(this.view.zoom * Math.exp(-e.deltaY * 0.0015), e.clientX - r.left, e.clientY - r.top);
        }, { passive: false });
        c.addEventListener("pointerdown", (e) => {
            const r = c.getBoundingClientRect();
            const x = e.clientX - r.left, y = e.clientY - r.top;
            e.stopPropagation();
            if (e.button === 0 && (e.ctrlKey || e.metaKey)) {
                e.preventDefault();
                this.onPick?.(this._info(x, y));
                return;
            }
            const pan = e.button === 1 || (e.button === 0 && (e.altKey || this._space
                || this.settings.mode !== "wipe" || !(this.sides.a && this.sides.b)));
            if (e.button !== 0 && e.button !== 1) return;
            e.preventDefault();
            c.setPointerCapture(e.pointerId);
            drag = { pan, x, y, cx: this.view.cx, cy: this.view.cy };
            if (!pan) this.set({ wipe: Math.min(1, Math.max(0, x / c.clientWidth)) });
        });
        c.addEventListener("pointermove", (e) => {
            const r = c.getBoundingClientRect();
            const x = e.clientX - r.left, y = e.clientY - r.top;
            if (drag) {
                if (drag.pan) {
                    this.view.cx = drag.cx - (x - drag.x) / this.view.zoom / this._par();
                    this.view.cy = drag.cy - (y - drag.y) / this.view.zoom;
                    this._viewChanged();
                } else {
                    this.set({ wipe: Math.min(1, Math.max(0, x / c.clientWidth)) });
                    this.onViewChange?.(this.view);
                }
            }
            this.onHover?.(this._info(x, y));
        });
        const end = (e) => {
            if (drag && c.hasPointerCapture(e.pointerId)) c.releasePointerCapture(e.pointerId);
            drag = null;
        };
        c.addEventListener("pointerup", end);
        c.addEventListener("pointercancel", end);
        c.addEventListener("pointerleave", () => { if (!drag) this.onHover?.(null); });
        c.addEventListener("dblclick", (e) => { e.stopPropagation(); this.fit(); });
        c.addEventListener("contextmenu", (e) => { e.preventDefault(); e.stopPropagation(); });
    }

    _info(x, y) {
        const [wx, wy] = this.screenToWorld(x, y);
        return { sx: x, sy: y, wx, wy, a: this.sample("a", wx, wy), b: this.sample("b", wx, wy) };
    }

    dispose() {
        cancelAnimationFrame(this._raf);
        this._resizeObs.disconnect();
        const gl = this.gl;
        for (const k of ["a", "b"]) if (this.sides[k]?.tex) gl.deleteTexture(this.sides[k].tex);
        gl.getExtension("WEBGL_lose_context")?.loseContext();
        this.canvas.remove();
    }
}
