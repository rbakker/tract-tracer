/// <reference lib="webworker" />
/*
 * Web Worker entry. Request:
 *   { id, labels: typed array, width, height, options }                    label input
 *   { id, rgba: Uint8Array, width, height, colorToLabel?, options }       canvas input
 *   { id, labels, width, height, options, pathsOnly: true }               paths only
 * Reply: { id, svg }, { id, paths: [{ label, d }] } (pathsOnly) or { id, error }.
 * `options.colors` must be a plain object or Map here (functions cannot be posted).
 */
import { labelsToSvg, labelsFromRGBA, traceLabels } from "./index.js";
const ctx = self;
ctx.onmessage = (e) => {
    const { id, width, height, labels, rgba, colorToLabel, options = {}, pathsOnly } = e.data;
    let reply;
    try {
        if (pathsOnly && labels) {
            ctx.postMessage({ id, paths: traceLabels(labels, width, height, options) });
            return;
        }
        let svg;
        if (labels) {
            svg = labelsToSvg(labels, width, height, options);
        }
        else if (rgba) {
            const conv = labelsFromRGBA(rgba, width, height, colorToLabel, options.background ?? 0);
            svg = labelsToSvg(conv.labels, width, height, { colors: conv.colors, ...options });
        }
        else {
            throw new Error("label2svg: request needs `labels` or `rgba`");
        }
        reply = { id, svg };
    }
    catch (err) {
        reply = { id, error: err instanceof Error ? err.message : String(err) };
    }
    ctx.postMessage(reply);
};
