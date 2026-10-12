export class Label2Svg {
    worker;
    nextId = 1;
    pending = new Map();
    constructor(worker) {
        this.worker = worker;
        worker.onmessage = (e) => {
            const p = this.pending.get(e.data.id);
            if (!p)
                return;
            this.pending.delete(e.data.id);
            if ("svg" in e.data)
                p.resolve(e.data.svg);
            else
                p.reject(new Error(e.data.error));
        };
        worker.onerror = (e) => {
            for (const p of this.pending.values())
                p.reject(new Error(e.message));
            this.pending.clear();
        };
    }
    send(msg, transfer) {
        return new Promise((resolve, reject) => {
            const id = this.nextId++;
            this.pending.set(id, { resolve, reject });
            this.worker.postMessage({ ...msg, id }, transfer);
        });
    }
    /** Vectorize a label slice (one integer label per pixel, row-major). The array is copied. */
    fromLabels(labels, width, height, options) {
        const copy = labels.slice();
        return this.send({ labels: copy, width, height, options }, [copy.buffer]);
    }
    /**
     * Vectorize a canvas holding a colour-coded label image at 1:1 scale, drawn without
     * smoothing. Colours map to labels through `colorToLabel` ("#RRGGBB" → id); without
     * it every colour is its own label. Paths keep the canvas colours unless
     * `options.colors` is given.
     */
    fromCanvas(canvas, colorToLabel, options) {
        const ctx = canvas.getContext("2d");
        if (!ctx)
            throw new Error("label2svg: canvas has no 2D context");
        const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
        const rgba = new Uint8Array(img.data.buffer);
        return this.send({ rgba, width: img.width, height: img.height, colorToLabel, options }, [rgba.buffer]);
    }
    terminate() {
        this.worker.terminate();
    }
}
/** Parse an SVG string into an element ready to insert into the document. */
export function svgFromString(svg) {
    const doc = new DOMParser().parseFromString(svg, "image/svg+xml");
    const err = doc.querySelector("parsererror");
    if (err)
        throw new Error("label2svg: invalid SVG: " + err.textContent);
    return document.importNode(doc.documentElement, true);
}
