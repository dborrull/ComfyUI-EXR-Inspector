// ComfyUI-EXR-Inspector - by David Borrull
// MIT License - Copyright (c) 2026 David Borrull. See LICENSE.
//
// Coordinates: "world" = pixel coords of the reference image (A, or B when A
// is empty), OpenEXR convention, y down. Each side maps world -> its own
// image coords with a centre and a scale (fit / 1:1).

export const VERTEX = `#version 300 es
void main() {
    vec2 v[3] = vec2[](vec2(-1.0, -1.0), vec2(3.0, -1.0), vec2(-1.0, 3.0));
    gl_Position = vec4(v[gl_VertexID], 0.0, 1.0);
}`;

export const FRAGMENT = `#version 300 es
precision highp float;
out vec4 outColor;

struct Side {
    bool has;
    int nch;          // 1..4 channels in the texture
    vec4 data;        // data window: x0, y0, x1 + 1, y1 + 1
    vec2 span;        // texture size * proxy factor, in image pixels
    vec2 center;      // display window centre, image coords
    float scale;      // world pixels per image pixel
    vec4 disp;        // display window: x0, y0, x1 + 1, y1 + 1
    int kind;         // 0 colour, 1 data
    int space;        // 0 linear, 1 sRGB-encoded
    mat3 gamut;       // file primaries -> Rec.709
    vec2 range;       // data remap low / high
    bool invert;
};
uniform sampler2D uTexA;
uniform sampler2D uTexB;
uniform Side uA;
uniform Side uB;

uniform vec2 uViewport;    // device pixels
uniform vec2 uCenter;      // world point at the viewport centre
uniform float uZoom;       // device pixels per world pixel
uniform float uPar;        // pixel aspect of the reference
uniform vec2 uRefCenter;   // reference display window centre

uniform int uMode;         // 0 A, 1 B, 2 wipe, 3 diff
uniform float uWipe;       // wipe position, 0..1 of the viewport width
uniform float uGain;       // 2^stops
uniform float uGamma;
uniform float uSaturation;  // around Rec.709 luminance, in linear
uniform int uChannel;      // 0 rgb, 1 r, 2 g, 3 b, 4 a, 5 luminance
uniform int uView;         // 0 sRGB, 1 gamma 2.2, 2 gamma 2.4, 3 raw
uniform float uDiffGain;
uniform bool uFalse;
uniform bool uClip;
uniform bool uWindows;
uniform vec4 uRefDisp;     // reference display / data windows: x0, y0, x1 + 1, y1 + 1
uniform vec4 uRefData;

const vec3 LUMA = vec3(0.2126, 0.7152, 0.0722);
const vec3 BG = vec3(0.105);

vec3 turbo(float x) {
    x = clamp(x, 0.0, 1.0);
    const vec4 kr = vec4(0.13572138, 4.61539260, -42.66032258, 132.13108234);
    const vec4 kg = vec4(0.09140261, 2.19418839, 4.84296658, -14.18503333);
    const vec4 kb = vec4(0.10667330, 12.64194608, -60.58204836, 110.36276771);
    const vec2 kr2 = vec2(-152.94239396, 59.28637943);
    const vec2 kg2 = vec2(4.27729857, 2.82956604);
    const vec2 kb2 = vec2(-89.90310912, 27.34824973);
    vec4 v4 = vec4(1.0, x, x * x, x * x * x);
    vec2 v2 = v4.zw * v4.z;
    return vec3(dot(v4, kr) + dot(v2, kr2), dot(v4, kg) + dot(v2, kg2), dot(v4, kb) + dot(v2, kb2));
}

vec3 srgbToLinear(vec3 c) {
    vec3 lo = c / 12.92;
    vec3 hi = pow(max((c + 0.055) / 1.055, 0.0), vec3(2.4));
    return mix(hi, lo, vec3(lessThanEqual(c, vec3(0.04045))));
}

vec3 linearToSrgb(vec3 c) {
    c = max(c, 0.0);
    vec3 lo = c * 12.92;
    vec3 hi = 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055;
    return mix(hi, lo, vec3(lessThanEqual(c, vec3(0.0031308))));
}

vec3 viewTransform(vec3 c) {
    if (uView == 0) return linearToSrgb(c);
    if (uView == 1) return pow(max(c, 0.0), vec3(1.0 / 2.2));
    if (uView == 2) return pow(max(c, 0.0), vec3(1.0 / 2.4));
    return c;
}

vec2 worldPos() {
    vec2 s = vec2(gl_FragCoord.x, uViewport.y - gl_FragCoord.y);
    vec2 w = (s - 0.5 * uViewport) / uZoom;
    w.x /= uPar;
    return w + uCenter;
}

vec2 imagePos(Side s, vec2 world) {
    return (world - uRefCenter) / s.scale + s.center;
}

bool inRect(vec2 p, vec4 r) {
    return p.x >= r.x && p.y >= r.y && p.x < r.z && p.y < r.w;
}

// Raw texture value (file values), expanded to RGBA
vec4 fetchRaw(Side s, sampler2D tex, vec2 img) {
    vec4 t = texture(tex, (img - s.data.xy) / s.span);
    if (s.nch == 1) return vec4(t.rrr, 1.0);
    if (s.nch == 2) return vec4(t.rg, 0.0, 1.0);
    if (s.nch == 3) return vec4(t.rgb, 1.0);
    return t;
}

// Colour: scene-linear Rec.709. Data: remapped to 0..1.
vec4 toWorking(Side s, vec4 raw) {
    if (s.kind == 1) {
        vec3 v = (raw.rgb - s.range.x) / max(s.range.y - s.range.x, 1e-20);
        if (s.invert) v = 1.0 - v;
        return vec4(v, raw.a);
    }
    vec3 c = s.space == 1 ? srgbToLinear(raw.rgb) : raw.rgb;
    return vec4(s.gamut * c, raw.a);
}

vec3 pickChannel(vec4 c) {
    if (uChannel == 1) return vec3(c.r);
    if (uChannel == 2) return vec3(c.g);
    if (uChannel == 3) return vec3(c.b);
    if (uChannel == 4) return vec3(c.a);
    if (uChannel == 5) return vec3(dot(c.rgb, LUMA));
    return c.rgb;
}

float zebra() {
    return mod(floor((gl_FragCoord.x + gl_FragCoord.y) / 6.0), 2.0);
}

vec3 finish(vec3 c, int kind, bool bad) {
    // c: linear (colour, gain applied) or 0..1 (data / diff)
    if (bad && (uClip || uFalse)) return vec3(1.0, 0.0, 1.0);
    if (uFalse) {
        if (kind == 1) return turbo(dot(c, vec3(1.0 / 3.0)));
        float l = dot(c, LUMA);
        if (l <= 0.0) return vec3(0.0);
        float stops = log2(l / 0.18);
        if (abs(stops) < 1.0 / 6.0) return vec3(0.5);
        return turbo((stops + 8.0) / 14.0);
    }
    // Gamma on everything, like Nuke's viewer; data layers skip the view transform
    vec3 g = sign(c) * pow(abs(c), vec3(1.0 / uGamma));
    vec3 o = kind == 1 ? g : viewTransform(g);
    if (uClip) {
        float z = zebra();
        if (max(max(c.r, c.g), c.b) > 1.0) o = mix(o, vec3(1.0, 0.15, 0.1), 0.75 * z);
        else if (min(min(c.r, c.g), c.b) < 0.0) o = mix(o, vec3(0.1, 0.35, 1.0), 0.75 * z);
    }
    return clamp(o, 0.0, 1.0);
}

bool isBad(vec4 v) {
    return any(isnan(v)) || any(isinf(v));
}

// One side as the viewer shows it; alpha = 0 outside its data window
vec4 shade(Side s, sampler2D tex, vec2 world) {
    vec2 img = imagePos(s, world);
    if (!inRect(img, s.data)) return vec4(inRect(img, s.disp) ? vec3(0.0) : BG, 0.0);
    vec4 raw = fetchRaw(s, tex, img);
    vec4 w = toWorking(s, raw);
    vec3 c = pickChannel(w);
    if (uChannel != 4) c *= uGain;       // data: gain after the remap
    if (uChannel == 0) c = mix(vec3(dot(c, LUMA)), c, uSaturation);
    return vec4(finish(c, s.kind, isBad(raw)), 1.0);
}

vec4 shadeDiff(vec2 world) {
    vec2 ia = imagePos(uA, world), ib = imagePos(uB, world);
    bool ina = inRect(ia, uA.data), inb = inRect(ib, uB.data);
    if (!ina && !inb) return vec4(BG, 0.0);
    vec4 ra = ina ? fetchRaw(uA, uTexA, ia) : vec4(0.0);
    vec4 rb = inb ? fetchRaw(uB, uTexB, ib) : vec4(0.0);
    // Colour layers compare in linear Rec.709, data layers as raw values
    vec4 a = (ina && uA.kind == 0) ? toWorking(uA, ra) : ra;
    vec4 b = (inb && uB.kind == 0) ? toWorking(uB, rb) : rb;
    vec3 d = abs(pickChannel(a - b)) * uDiffGain;
    bool bad = isBad(ra) || isBad(rb);
    int kind = (uA.kind == 1 && uB.kind == 1) ? 1 : 0;
    if (kind == 1 && !uFalse) return vec4(clamp(d, 0.0, 1.0), 1.0);
    return vec4(finish(d, kind, bad), 1.0);
}

float edge(vec2 world, vec4 r) {
    // 1 on the outline of r (one device pixel wide)
    vec2 px = vec2(1.0 / (uZoom * uPar), 1.0 / uZoom);
    bool inside = world.x >= r.x - px.x && world.x <= r.z + px.x && world.y >= r.y - px.y && world.y <= r.w + px.y;
    bool core = world.x > r.x && world.x < r.z && world.y > r.y && world.y < r.w;
    return (inside && !core) ? 1.0 : 0.0;
}

void main() {
    vec2 world = worldPos();
    vec4 col;
    if (uMode == 3 && uA.has && uB.has) {
        col = shadeDiff(world);
    } else {
        bool showB = uMode == 1 || (uMode == 2 && gl_FragCoord.x / uViewport.x >= uWipe);
        if (!uA.has) showB = true;
        if (!uB.has) showB = false;
        col = showB ? shade(uB, uTexB, world) : shade(uA, uTexA, world);
    }
    vec3 c = col.rgb;
    if (uWindows) {
        // reference windows, already in world coords
        if (uRefData != uRefDisp) c = mix(c, vec3(0.35, 0.55, 0.9), 0.6 * edge(world, uRefData));
        c = mix(c, vec3(0.75), 0.7 * edge(world, uRefDisp));
    }
    if (uMode == 2 && uA.has && uB.has && abs(gl_FragCoord.x - uWipe * uViewport.x) < 1.0) {
        c = vec3(0.9);
    }
    outColor = vec4(c, 1.0);
}`;
