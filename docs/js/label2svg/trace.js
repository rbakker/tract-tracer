/*
 * Boundary tracing on the pixel-corner lattice.
 *
 * Boundaries run along pixel edges. Corners are numbered c = y * (W + 1) + x for
 * 0 <= x <= W, 0 <= y <= H. A corner where three or more labels meet is a *node*.
 * Boundary edges are grouped into *chains*: maximal runs between two nodes, or
 * closed loops that contain no node. Every chain has one label on its left and one
 * on its right, and each label's outline is a set of cycles of chains. Both
 * neighbours of a chain use that same chain (one of them reversed), so shared
 * boundaries are identical by construction.
 *
 * Coordinates are y-down (image convention). Directions: 0 = E, 1 = S, 2 = W, 3 = N.
 * The four pixels around corner (x, y), in clockwise order starting top-right:
 *   q0 = TR (x, y-1), q1 = BR (x, y), q2 = BL (x-1, y), q3 = TL (x-1, y-1).
 * Moving from a corner in direction d, the edge has pixel q[d] on its left and
 * q[(d + 1) % 4] on its right.
 *
 * Diagonal rule: where a label touches itself only diagonally at a corner, it is
 * connected through that corner if it "wins" against the labels on the other
 * diagonal. Foreground always wins over the background label, and between two
 * foreground labels the lower id wins. The rule is antisymmetric, so both sides of
 * a boundary always agree on its shape.
 */
const DX = [1, 0, -1, 0];
const DY = [0, 1, 0, -1];
export function traceBoundaries(labels, W, H, background) {
    const CW = W + 1;
    const lab = (x, y) => x < 0 || y < 0 || x >= W || y >= H ? background : labels[y * W + x];
    // quadrant k (0 TR, 1 BR, 2 BL, 3 TL) around corner (x, y)
    const quad = (x, y, k) => {
        switch (k & 3) {
            case 0: return lab(x, y - 1);
            case 1: return lab(x, y);
            case 2: return lab(x - 1, y);
            default: return lab(x - 1, y - 1);
        }
    };
    // does `a` win a diagonal contest against `b`?
    const wins = (a, b) => {
        if (a === b)
            return true;
        if (a === background)
            return false;
        if (b === background)
            return true;
        return a < b;
    };
    /**
     * Arriving at corner (x, y) moving in direction d with label L on the left,
     * return the direction in which L's boundary continues.
     */
    const turn = (x, y, d, L) => {
        const aheadLeft = quad(x, y, d);
        const aheadRight = quad(x, y, d + 1);
        if (aheadLeft === L)
            return aheadRight === L ? (d + 1) & 3 : d; // right turn : straight
        if (aheadRight !== L)
            return (d + 3) & 3; // left turn
        // L only diagonally ahead-right: connect (turn right) if L wins the diagonal
        const behindRight = quad(x, y, d + 2);
        return wins(L, aheadLeft) && wins(L, behindRight) ? (d + 1) & 3 : (d + 3) & 3;
    };
    /* --- nodes: corners with three or more distinct labels --- */
    const isNode = new Uint8Array(CW * (H + 1));
    for (let y = 0; y <= H; y++) {
        for (let x = 0; x <= W; x++) {
            const a = lab(x, y - 1), b = lab(x, y), c = lab(x - 1, y), e = lab(x - 1, y - 1);
            let n = 1;
            if (b !== a)
                n++;
            if (c !== a && c !== b)
                n++;
            if (e !== a && e !== b && e !== c)
                n++;
            if (n >= 3)
                isNode[y * CW + x] = 1;
        }
    }
    /* --- edge bookkeeping: horizontal edges (x,y)→(x+1,y), then vertical (x,y)→(x,y+1) --- */
    const nH = W * (H + 1);
    const visited = new Uint8Array(nH + CW * H);
    const edgeId = (x, y, d) => {
        switch (d) {
            case 0: return y * W + x;
            case 2: return y * W + x - 1;
            case 1: return nH + y * CW + x;
            default: return nH + (y - 1) * CW + x;
        }
    };
    const isBoundary = (x, y, d) => quad(x, y, d) !== quad(x, y, d + 1);
    const chains = [];
    /** Walk from (x0, y0) in direction d0 until a node is reached, or back to the start edge. */
    const walk = (x0, y0, d0, closed) => {
        const L = quad(x0, y0, d0);
        const R = quad(x0, y0, d0 + 1);
        const pts = [x0, y0];
        const startEdge = edgeId(x0, y0, d0);
        let x = x0, y = y0, d = d0;
        for (;;) {
            visited[edgeId(x, y, d)] = 1;
            x += DX[d];
            y += DY[d];
            if (!closed && isNode[y * CW + x]) {
                pts.push(x, y);
                chains.push({
                    pts: Int32Array.from(pts), closed: false, left: L, right: R,
                    start: y0 * CW + x0, end: y * CW + x, dirFirst: d0, dirLast: d,
                });
                return;
            }
            const nd = turn(x, y, d, L);
            if (closed && edgeId(x, y, nd) === startEdge) {
                chains.push({
                    pts: Int32Array.from(pts), closed: true, left: L, right: R,
                    start: -1, end: -1, dirFirst: d0, dirLast: d,
                });
                return;
            }
            pts.push(x, y);
            d = nd;
        }
    };
    // open chains: start at every node, in every direction with an unvisited boundary edge
    for (let y = 0; y <= H; y++) {
        for (let x = 0; x <= W; x++) {
            if (!isNode[y * CW + x])
                continue;
            for (let d = 0; d < 4; d++) {
                if (isBoundary(x, y, d) && !visited[edgeId(x, y, d)])
                    walk(x, y, d, false);
            }
        }
    }
    // closed loops: whatever boundary edges are left
    for (let y = 0; y <= H; y++) {
        for (let x = 0; x < W; x++) {
            if (!visited[y * W + x] && isBoundary(x, y, 0))
                walk(x, y, 0, true);
        }
    }
    for (let y = 0; y < H; y++) {
        for (let x = 0; x <= W; x++) {
            if (!visited[nH + y * CW + x] && isBoundary(x, y, 1))
                walk(x, y, 1, true);
        }
    }
    /* --- assemble per-label cycles --- */
    // outgoing use of a chain at a node: key = node * 4 + direction leaving the node
    const leaving = new Map(); // value: chain * 2 + (reversed ? 1 : 0)
    chains.forEach((c, i) => {
        if (c.closed)
            return;
        leaving.set(c.start * 4 + c.dirFirst, i * 2);
        leaving.set(c.end * 4 + ((c.dirLast + 2) & 3), i * 2 + 1);
    });
    const cycles = new Map();
    const add = (label, cycle) => {
        if (label === background)
            return;
        let list = cycles.get(label);
        if (!list)
            cycles.set(label, (list = []));
        list.push(cycle);
    };
    const used = new Uint8Array(chains.length * 2);
    for (let i = 0; i < chains.length; i++) {
        const c = chains[i];
        if (c.closed) {
            add(c.left, [{ chain: i, reversed: false }]);
            add(c.right, [{ chain: i, reversed: true }]);
            continue;
        }
        for (let r = 0; r < 2; r++) {
            const L = r ? c.right : c.left;
            if (used[i * 2 + r] || L === background)
                continue;
            const cycle = [];
            let cur = i * 2 + r;
            for (let guard = 0; guard <= chains.length * 2; guard++) {
                used[cur] = 1;
                cycle.push({ chain: cur >> 1, reversed: (cur & 1) === 1 });
                const cc = chains[cur >> 1];
                // node where this use ends, and the direction of arrival there
                const node = cur & 1 ? cc.start : cc.end;
                const arrive = cur & 1 ? (cc.dirFirst + 2) & 3 : cc.dirLast;
                const nx = node % CW, ny = (node - nx) / CW;
                const next = leaving.get(node * 4 + turn(nx, ny, arrive, L));
                if (next === undefined)
                    throw new Error("label2svg: broken boundary (internal error)");
                if (next === i * 2 + r)
                    break;
                cur = next;
            }
            add(L, cycle);
        }
    }
    return { chains, cycles };
}
