# Vendored dependencies (N8AO ambient occlusion, ULTRA tier only)

Self-hosted rather than CDN-loaded, since this app may run on restricted
networks (see the AO integration discussion). Each is copied verbatim
from its npm package's own ESM build — nothing here is hand-edited —
so license headers/files travel with the code as required by their
licenses (ISC, Zlib).

| Vendored file                     | Package         | Version | Source path in the npm package      |
|------------------------------------|------------------|---------|---------------------------------------|
| `n8ao/N8AO.js`                    | `n8ao`           | 2.0.1   | `dist/N8AO.js` (+ `.js.map`)         |
| `postprocessing/postprocessing.js`| `postprocessing` | 6.39.5  | `build/index.js` — the ESM entry; **not** `postprocessing.min.js`, which is a UMD/global bundle expecting `window.THREE` and is not a valid ES module |
| `three/Pass.js`                   | `three`          | 0.180.0 | `examples/jsm/postprocessing/Pass.js` — n8ao's only import from three's examples tree; core `three` itself stays CDN-loaded (see the main import map), this is the one extra file N8AO specifically needs |

## To update a version

```
npm install n8ao@<version> postprocessing@<version> --no-save
cp node_modules/n8ao/dist/N8AO.js{,.map} js/vendor/n8ao/
cp node_modules/postprocessing/build/index.js js/vendor/postprocessing/postprocessing.js
cp node_modules/n8ao/LICENSE js/vendor/n8ao/LICENSE
cp node_modules/postprocessing/LICENSE.md js/vendor/postprocessing/LICENSE.md
```
`three/Pass.js` only needs re-copying if the app's own pinned three.js
version (see the main import map) changes.

## Why these three files specifically

Both `n8ao/dist/N8AO.js` and `postprocessing/build/index.js` are
self-contained single-file ESM bundles — verified by checking their own
`import` statements, not assumed: neither imports from any sibling file
within its own package, only from bare `"three"` (already resolved by
the app's existing import map) and, in N8AO's case, from `"postprocessing"`
and `"three/examples/jsm/postprocessing/Pass.js"`. That's the complete
dependency closure; nothing else needed vendoring.
