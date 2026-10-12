/*
 * label2svg: vectorize a label image into smooth SVG paths, one <path> per label.
 * Neighbouring labels share exactly the same boundary curves (no gaps, no overlaps).
 *
 * Coordinates are in pixel units: pixel (x, y) covers the square x..x+1, y..y+1, and
 * the SVG has viewBox="0 0 width height". Map to world units (nm, µm, mm) with a
 * transform in the application.
 */
import { traceBoundaries } from "./trace.js";
import { taut, fitPolyline } from "./fit.js";
// Share of the tolerance used for straightening (taut string); the rest is for curve fitting.
const SLACK_SHARE = 0.75;
/** Trace all labels and return one path per label, sorted by label. */
export function traceLabels(labels, width, height, options = {}) {
    const tolerance = options.tolerance ?? 0.45;
    const precision = options.precision ?? 2;
    const background = options.background ?? 0;
    if (!(width > 0 && height > 0))
        throw new Error("label2svg: empty image");
    if (labels.length < width * height)
        throw new Error("label2svg: label array too small");
    if (!(tolerance > 0))
        throw new Error("label2svg: tolerance must be > 0");
    const { chains, cycles } = traceBoundaries(labels, width, height, background);
    // Fit every chain once and round its points once; both neighbours use these numbers.
    const f = Math.pow(10, precision);
    const round = (v) => Math.round(v * f) / f;
    // The tolerance is split between straightening (how far the taut string may move off
    // the pixel-edge midpoints) and curve fitting (how far the curve may move off the string).
    const slack = Math.min(tolerance * SLACK_SHARE, 0.49);
    const fitTol = Math.max(tolerance - slack, 0.01);
    // Junctions: start at the shared corner, then move each junction (within `slack`) to the
    // mean of where its chains cross their first portal, and pull the chains again from
    // there. All chains at a junction use the same moved point, so they still meet exactly.
    const first = chains.map((c) => taut(c.pts, c.closed, slack));
    const acc = new Map();
    const accumulate = (node, p) => {
        const a = acc.get(node) ?? [0, 0, 0];
        a[0] += p[0];
        a[1] += p[1];
        a[2]++;
        acc.set(node, a);
    };
    chains.forEach((c, i) => {
        if (c.closed)
            return;
        const t = first[i];
        accumulate(c.start, t[1]);
        accumulate(c.end, t[t.length - 2]);
    });
    const CW = width + 1;
    const nodePos = new Map();
    for (const [node, [sx, sy, k]] of acc) {
        const x0 = node % CW, y0 = (node - x0) / CW;
        let dx = sx / k - x0, dy = sy / k - y0;
        const d = Math.hypot(dx, dy);
        if (d > slack) {
            dx *= slack / d;
            dy *= slack / d;
        }
        nodePos.set(node, [x0 + dx, y0 + dy]);
    }
    const geom = chains.map((c, i) => {
        const line = c.closed ? first[i] : taut(c.pts, false, slack, nodePos.get(c.start), nodePos.get(c.end));
        const fitted = fitPolyline(line, c.closed, fitTol);
        const pts = fitted.pts.map(round);
        // index (in points) of the start point of each segment
        const starts = [];
        let p = 0;
        for (const k of fitted.kinds) {
            starts.push(p);
            p += k ? 3 : 1;
        }
        return { pts, kinds: fitted.kinds, starts };
    });
    // compact number: no trailing zeros, no leading zero ("0.5" -> ".5", "-0.5" -> "-.5")
    const num = (v) => {
        const n = Math.round(v * f);
        if (n === 0)
            return "0";
        const a = n < 0 ? -n : n;
        const ip = Math.floor(a / f);
        let fr = a - ip * f;
        let t = ip === 0 ? "" : String(ip);
        if (fr !== 0) {
            let digits = precision;
            while (fr % 10 === 0) {
                fr /= 10;
                digits--;
            }
            t += "." + String(fr).padStart(digits, "0");
        }
        return n < 0 ? "-" + t : t;
    };
    // join numbers; a separator is only needed when the next one does not start with "-"
    const join = (a, b) => (b[0] === "-" ? a + b : a + " " + b);
    const out = [];
    const sorted = [...cycles.keys()].sort((a, b) => a - b);
    for (const label of sorted) {
        const parts = [];
        for (const cycle of cycles.get(label)) {
            let cx = 0, cy = 0;
            let cmd = "";
            const seg = (c, coords) => {
                let s = "";
                for (let i = 0; i < coords.length; i++) {
                    const v = num(coords[i] - (i & 1 ? cy : cx));
                    s = i === 0 ? v : join(s, v);
                }
                if (c !== cmd)
                    parts.push(c + s);
                else
                    parts.push(s[0] === "-" ? s : " " + s);
                cmd = c;
                cx = coords[coords.length - 2];
                cy = coords[coords.length - 1];
            };
            cycle.forEach((use, ci) => {
                const g = geom[use.chain];
                const P = g.pts;
                const nSeg = g.kinds.length;
                if (!use.reversed) {
                    if (ci === 0) {
                        cx = P[0];
                        cy = P[1];
                        parts.push("M" + join(num(cx), num(cy)));
                    }
                    for (let s = 0; s < nSeg; s++) {
                        const i = 2 * g.starts[s];
                        if (g.kinds[s])
                            seg("c", [P[i + 2], P[i + 3], P[i + 4], P[i + 5], P[i + 6], P[i + 7]]);
                        else
                            seg("l", [P[i + 2], P[i + 3]]);
                    }
                }
                else {
                    if (ci === 0) {
                        cx = P[P.length - 2];
                        cy = P[P.length - 1];
                        parts.push("M" + join(num(cx), num(cy)));
                    }
                    for (let s = nSeg - 1; s >= 0; s--) {
                        const i = 2 * g.starts[s];
                        if (g.kinds[s])
                            seg("c", [P[i + 4], P[i + 5], P[i + 2], P[i + 3], P[i], P[i + 1]]);
                        else
                            seg("l", [P[i], P[i + 1]]);
                    }
                }
            });
            parts.push("z");
        }
        out.push({ label, d: parts.join("") });
    }
    return out;
}
function colorLookup(colors) {
    const fallback = (l) => `hsl(${Math.round((l * 137.508) % 360)} 55% 62%)`;
    if (!colors)
        return fallback;
    if (typeof colors === "function")
        return (l) => colors(l) ?? fallback(l);
    if (colors instanceof Map)
        return (l) => colors.get(l) ?? fallback(l);
    return (l) => colors[l] ?? fallback(l);
}
const esc = (s) => s.replace(/[&"<>]/g, (c) => `&#${c.charCodeAt(0)};`);
/** Wrap traced paths in an SVG document. */
export function pathsToSvg(paths, width, height, options = {}) {
    const color = colorLookup(options.colors);
    const seam = options.seamStroke ?? 0.5;
    const g = seam > 0 ? `<g stroke-width="${seam}" stroke-linejoin="round">` : "<g>";
    const lines = [`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}">`, g];
    for (const p of paths) {
        const c = esc(color(p.label));
        lines.push(`<path data-label-id="${p.label}" fill="${c}"${seam > 0 ? ` stroke="${c}"` : ""} d="${p.d}"/>`);
    }
    lines.push("</g>", "</svg>", "");
    return lines.join("\n");
}
/** Trace a label image and return an SVG document. */
export function labelsToSvg(labels, width, height, options = {}) {
    return pathsToSvg(traceLabels(labels, width, height, options), width, height, options);
}
/**
 * Convert RGBA pixels (e.g. canvas ImageData) to labels.
 * With `colorToLabel` ("#RRGGBB" → id), unknown colours throw. Without it, every colour
 * becomes its own label (0xRRGGBB + 1). Transparent pixels become `background` (default 0).
 * Also returns the colour of each label, for use as `colors`.
 */
export function labelsFromRGBA(rgba, width, height, colorToLabel, background = 0) {
    const n = width * height;
    if (rgba.length < n * 4)
        throw new Error("label2svg: RGBA buffer too small");
    const table = new Map();
    if (colorToLabel) {
        const entries = colorToLabel instanceof Map ? [...colorToLabel] : Object.entries(colorToLabel);
        for (const [k, v] of entries) {
            const m = /^#?([0-9a-fA-F]{6})$/.exec(k.trim());
            if (!m)
                throw new Error(`label2svg: invalid colour "${k}"`);
            table.set(parseInt(m[1], 16), v);
        }
    }
    const hex = (c) => "#" + c.toString(16).toUpperCase().padStart(6, "0");
    const labels = new Int32Array(n);
    const colors = new Map();
    let lastC = -1, lastL = background;
    for (let p = 0, q = 0; p < n; p++, q += 4) {
        if (rgba[q + 3] === 0) {
            labels[p] = background;
            continue;
        }
        const c = (rgba[q] << 16) | (rgba[q + 1] << 8) | rgba[q + 2];
        if (c !== lastC) {
            let l;
            if (colorToLabel) {
                l = table.get(c);
                if (l === undefined)
                    throw new Error(`label2svg: colour ${hex(c)} is not in colorToLabel`);
            }
            else {
                l = c + 1;
            }
            if (!colors.has(l))
                colors.set(l, hex(c));
            lastC = c;
            lastL = l;
        }
        labels[p] = lastL;
    }
    return { labels, colors };
}
