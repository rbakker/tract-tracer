/*
 * Smoothing and curve fitting for one boundary chain.
 *
 * 1. The pixel staircase is replaced by a taut string through the chain's portals
 *    (see taut()), which turns staircases into straight lines. The end corners of an
 *    open chain (where three or more labels meet) are kept exactly.
 * 2. The midpoint polyline is fitted with straight lines and cubic Beziers
 *    (Schneider, "An Algorithm for Automatically Fitting Digitized Curves",
 *    Graphics Gems, 1990): a straight line if every point is within `tolerance`,
 *    otherwise a least-squares cubic, split at the worst point until all points are
 *    within `tolerance` (in pixels).
 */
/**
 * Taut boundary through the "portals" of a chain.
 *
 * Every unit edge of the chain separates two pixels; the boundary may cross that edge
 * anywhere on the segment between the two pixel centres. The portal is that segment,
 * shrunk to `slack` (< 0.5) on either side of the edge midpoint. Pulling a string taut
 * through all portals (funnel algorithm) straightens staircases into lines without
 * ever passing a pixel centre. Returns one point per unit edge where the string crosses
 * its portal, plus the end points of an open chain (closed: first point repeated).
 * The end points default to the chain's end corners; `from`/`to` override them.
 */
export function taut(corners, closed, slack, from, to) {
    const n = corners.length / 2;
    const m = closed ? n : n - 1; // number of unit edges
    // portal i: midpoint and unit normal pointing to the left of the travel direction
    const mx = new Float64Array(m), my = new Float64Array(m), nx = new Float64Array(m), ny = new Float64Array(m);
    for (let i = 0; i < m; i++) {
        const j = (i + 1) % n;
        const dx = corners[2 * j] - corners[2 * i], dy = corners[2 * j + 1] - corners[2 * i + 1];
        mx[i] = corners[2 * i] + dx / 2;
        my[i] = corners[2 * i + 1] + dy / 2;
        nx[i] = dy; // left of (dx, dy) in y-down coordinates
        ny[i] = -dx;
    }
    if (!closed) {
        const a = from ?? [corners[0], corners[1]];
        const b = to ?? [corners[2 * n - 2], corners[2 * n - 1]];
        return crossings(pull(a, b, 0, m, mx, my, nx, ny, slack), a, b, 0, m, mx, my, nx, ny);
    }
    // closed loop: pull once from portal 0, then restart at a natural corner of that path,
    // so the seam of the loop sits at a vertex the taut string has anyway
    const first = pull([mx[0], my[0]], [mx[0], my[0]], 1, m - 1, mx, my, nx, ny, slack);
    let k = 0, start = [mx[0], my[0]];
    if (first.length > 2) {
        const v = first[first.length >> 1];
        k = v.portal;
        start = v.p;
    }
    const rot = (arr) => Float64Array.from({ length: m }, (_, i) => arr[(i + k) % m]);
    const [rx, ry, rnx, rny] = [rot(mx), rot(my), rot(nx), rot(ny)];
    const path = pull(start, start, 1, m - 1, rx, ry, rnx, rny, slack);
    const pts = crossings(path, start, start, 1, m - 1, rx, ry, rnx, rny);
    return pts; // starts and ends at `start`
}
/**
 * Funnel algorithm ("simple stupid funnel", Mononen) from point a to point b through
 * portals first..first+count-1 (indices into mx/my/nx/ny, all wrapped modulo length).
 */
function pull(a, b, first, count, mx, my, nx, ny, slack) {
    const m = mx.length;
    // portal list: [a, portals…, b]; left/right as seen when travelling along the chain
    const N = count + 2;
    const lx = new Float64Array(N), ly = new Float64Array(N), rx = new Float64Array(N), ry = new Float64Array(N);
    const idx = new Int32Array(N);
    lx[0] = rx[0] = a[0];
    ly[0] = ry[0] = a[1];
    idx[0] = -1;
    for (let i = 0; i < count; i++) {
        const q = (first + i) % m;
        lx[i + 1] = mx[q] + slack * nx[q];
        ly[i + 1] = my[q] + slack * ny[q];
        rx[i + 1] = mx[q] - slack * nx[q];
        ry[i + 1] = my[q] - slack * ny[q];
        idx[i + 1] = q;
    }
    lx[N - 1] = rx[N - 1] = b[0];
    ly[N - 1] = ry[N - 1] = b[1];
    idx[N - 1] = -1;
    // cross product of (b - a) and (c - a); > 0 means c is to the right of a→b in y-down coordinates
    const cross = (ax, ay, bx, by, cx, cy) => (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
    const out = [{ p: a, portal: -1 }];
    let apx = a[0], apy = a[1];
    let plx = a[0], ply = a[1], prx = a[0], pry = a[1];
    let apex = 0, li = 0, ri = 0;
    for (let i = 1; i < N; i++) {
        const Lx = lx[i], Ly = ly[i], Rx = rx[i], Ry = ry[i];
        // tighten the right side
        if (cross(apx, apy, prx, pry, Rx, Ry) <= 0) {
            if ((apx === prx && apy === pry) || cross(apx, apy, plx, ply, Rx, Ry) > 0) {
                prx = Rx;
                pry = Ry;
                ri = i;
            }
            else {
                // right crossed over left: the left point becomes a path vertex
                apx = plx;
                apy = ply;
                apex = li;
                out.push({ p: [apx, apy], portal: idx[apex] });
                prx = plx = apx;
                pry = ply = apy;
                li = ri = apex;
                i = apex;
                continue;
            }
        }
        // tighten the left side
        if (cross(apx, apy, plx, ply, Lx, Ly) >= 0) {
            if ((apx === plx && apy === ply) || cross(apx, apy, prx, pry, Lx, Ly) < 0) {
                plx = Lx;
                ply = Ly;
                li = i;
            }
            else {
                apx = prx;
                apy = pry;
                apex = ri;
                out.push({ p: [apx, apy], portal: idx[apex] });
                prx = plx = apx;
                pry = ply = apy;
                li = ri = apex;
                i = apex;
                continue;
            }
        }
    }
    out.push({ p: b, portal: -1 });
    return out;
}
/** Points where the taut path crosses each portal, plus its end points. */
function crossings(path, a, b, first, count, mx, my, nx, ny) {
    const m = mx.length;
    const pts = [a];
    let seg = 0; // current path segment path[seg] -> path[seg + 1]
    // position of each path vertex in portal order (0 = a, count + 1 = b)
    const pos = path.map((v, i) => (i === 0 ? 0 : i === path.length - 1 ? count + 1 : ((v.portal - first + m) % m) + 1));
    for (let i = 1; i <= count; i++) {
        while (seg < path.length - 2 && pos[seg + 1] <= i)
            seg++;
        if (pos[seg] === i) {
            pts.push(path[seg].p);
            continue;
        }
        const q = (first + i - 1) % m;
        const A = path[seg].p, B = path[seg + 1].p;
        // intersect A + t (B - A) with the portal line M + u N
        const ex = B[0] - A[0], ey = B[1] - A[1];
        const den = ex * ny[q] - ey * nx[q];
        if (den === 0) {
            pts.push([mx[q], my[q]]);
            continue;
        }
        const t = ((mx[q] - A[0]) * ny[q] - (my[q] - A[1]) * nx[q]) / den;
        pts.push([A[0] + t * ex, A[1] + t * ey]);
    }
    pts.push(b);
    return pts;
}
const sub = (a, b) => [a[0] - b[0], a[1] - b[1]];
const len = (v) => Math.hypot(v[0], v[1]);
const unit = (v) => {
    const l = len(v);
    return l > 0 ? [v[0] / l, v[1] / l] : [0, 0];
};
const scale = (v, s) => [v[0] * s, v[1] * s];
const addp = (a, b) => [a[0] + b[0], a[1] + b[1]];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1];
function bezier(b, t) {
    const s = 1 - t;
    const b0 = s * s * s, b1 = 3 * s * s * t, b2 = 3 * s * t * t, b3 = t * t * t;
    return [
        b0 * b[0][0] + b1 * b[1][0] + b2 * b[2][0] + b3 * b[3][0],
        b0 * b[0][1] + b1 * b[1][1] + b2 * b[2][1] + b3 * b[3][1],
    ];
}
/** Squared distance from p to segment a–b. */
function segDist2(p, a, b) {
    const ab = sub(b, a);
    const l2 = dot(ab, ab);
    let t = l2 > 0 ? dot(sub(p, a), ab) / l2 : 0;
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    const dx = p[0] - (a[0] + t * ab[0]), dy = p[1] - (a[1] + t * ab[1]);
    return dx * dx + dy * dy;
}
// tangents look a few points ahead, so the 45° wobble of the midpoint polyline does not dominate
const REACH = 3;
function chordParams(d, first, last) {
    const u = new Float64Array(last - first + 1);
    for (let i = first + 1; i <= last; i++)
        u[i - first] = u[i - first - 1] + len(sub(d[i], d[i - 1]));
    const total = u[last - first];
    for (let i = 1; i < u.length; i++)
        u[i] /= total;
    return u;
}
function generateBezier(d, first, last, u, t1, t2) {
    const p0 = d[first], p3 = d[last];
    let c00 = 0, c01 = 0, c11 = 0, x0 = 0, x1 = 0;
    for (let i = 0; i < u.length; i++) {
        const t = u[i], s = 1 - t;
        const b0 = s * s * s, b1 = 3 * s * s * t, b2 = 3 * s * t * t, b3 = t * t * t;
        const a1 = scale(t1, b1), a2 = scale(t2, b2);
        c00 += dot(a1, a1);
        c01 += dot(a1, a2);
        c11 += dot(a2, a2);
        const tmp = [
            d[first + i][0] - (p0[0] * (b0 + b1) + p3[0] * (b2 + b3)),
            d[first + i][1] - (p0[1] * (b0 + b1) + p3[1] * (b2 + b3)),
        ];
        x0 += dot(a1, tmp);
        x1 += dot(a2, tmp);
    }
    const det = c00 * c11 - c01 * c01;
    let al = det !== 0 ? (x0 * c11 - x1 * c01) / det : 0;
    let ar = det !== 0 ? (c00 * x1 - c01 * x0) / det : 0;
    const seg = len(sub(p3, p0));
    const eps = 1e-6 * seg;
    if (al < eps || ar < eps)
        al = ar = seg / 3; // Wu/Barsky fallback
    return [p0, addp(p0, scale(t1, al)), addp(p3, scale(t2, ar)), p3];
}
function newtonStep(b, p, t) {
    const q = bezier(b, t);
    const s = 1 - t;
    // first and second derivative
    const q1 = [
        3 * (s * s * (b[1][0] - b[0][0]) + 2 * s * t * (b[2][0] - b[1][0]) + t * t * (b[3][0] - b[2][0])),
        3 * (s * s * (b[1][1] - b[0][1]) + 2 * s * t * (b[2][1] - b[1][1]) + t * t * (b[3][1] - b[2][1])),
    ];
    const q2 = [
        6 * (s * (b[2][0] - 2 * b[1][0] + b[0][0]) + t * (b[3][0] - 2 * b[2][0] + b[1][0])),
        6 * (s * (b[2][1] - 2 * b[1][1] + b[0][1]) + t * (b[3][1] - 2 * b[2][1] + b[1][1])),
    ];
    const num = (q[0] - p[0]) * q1[0] + (q[1] - p[1]) * q1[1];
    const den = q1[0] * q1[0] + q1[1] * q1[1] + (q[0] - p[0]) * q2[0] + (q[1] - p[1]) * q2[1];
    return den === 0 ? t : t - num / den;
}
/** Max squared distance of the inner points to the curve, and where it occurs. */
function maxError(d, first, last, b, u) {
    let max = 0, at = (first + last) >> 1;
    for (let i = first + 1; i < last; i++) {
        const q = bezier(b, u[i - first]);
        const dx = q[0] - d[i][0], dy = q[1] - d[i][1];
        const e = dx * dx + dy * dy;
        if (e >= max) {
            max = e;
            at = i;
        }
    }
    // also check halfway between data points, so the curve cannot bulge out between them
    for (let i = first; i < last; i++) {
        const q = bezier(b, (u[i - first] + u[i + 1 - first]) / 2);
        const e = segDist2(q, d[i], d[i + 1]);
        if (e > max) {
            max = e;
            at = Math.min(Math.max(i === first ? i + 1 : i, first + 1), last - 1);
        }
    }
    return [max, at];
}
/** Fit a smoothed polyline (closed: last point equals first). */
export function fitPolyline(d, closed, tolerance) {
    const out = { pts: [d[0][0], d[0][1]], kinds: [] };
    const n = d.length;
    if (n < 2)
        return out;
    const tol2 = tolerance * tolerance;
    const k = Math.min(REACH, n - 1);
    let tStart, tEnd;
    if (closed) {
        // smooth through the seam: tangent from the points on either side of it
        tStart = unit(sub(d[k], d[n - 1 - k]));
        tEnd = scale(tStart, -1);
    }
    else {
        tStart = unit(sub(d[k], d[0]));
        tEnd = unit(sub(d[n - 1 - k], d[n - 1]));
    }
    const stack = [[0, n - 1, tStart, tEnd]];
    while (stack.length) {
        const [first, last, t1, t2] = stack.pop();
        const a = d[first], b = d[last];
        // straight line if every point is close enough to the chord
        if (!(a[0] === b[0] && a[1] === b[1])) {
            let ok = true;
            for (let i = first + 1; i < last && ok; i++)
                ok = segDist2(d[i], a, b) <= tol2;
            if (ok) {
                out.pts.push(b[0], b[1]);
                out.kinds.push(0);
                continue;
            }
        }
        let u = chordParams(d, first, last);
        let bez = generateBezier(d, first, last, u, t1, t2);
        let [err, split] = maxError(d, first, last, bez, u);
        if (err > tol2 && err < 4 * tol2) {
            // try improving the parameterization
            for (let it = 0; it < 4 && err > tol2; it++) {
                const u2 = u.map((t, i) => newtonStep(bez, d[first + i], t));
                const bez2 = generateBezier(d, first, last, u2, t1, t2);
                const [err2, split2] = maxError(d, first, last, bez2, u2);
                if (err2 >= err)
                    break;
                u = u2;
                bez = bez2;
                err = err2;
                split = split2;
            }
        }
        if (err <= tol2) {
            out.pts.push(bez[1][0], bez[1][1], bez[2][0], bez[2][1], b[0], b[1]);
            out.kinds.push(1);
            continue;
        }
        if (last - first <= 2) {
            // too few points to split: follow them with straight lines
            for (let i = first + 1; i <= last; i++) {
                out.pts.push(d[i][0], d[i][1]);
                out.kinds.push(0);
            }
            continue;
        }
        // split at the worst point, keeping the tangent continuous there
        const r = Math.min(REACH, split - first, last - split);
        const tc = unit(sub(d[split - r], d[split + r]));
        stack.push([split, last, scale(tc, -1), t2]); // right half, processed second
        stack.push([first, split, t1, tc]); // left half, processed first
    }
    return out;
}
