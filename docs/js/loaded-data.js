// ═══════════════════════════════════════════════════════════
// Object model + view for the FILE panel's collapsible data tree.
//
// Shape is deliberately similar to graphxtree.js (parent/child nodes,
// a `visible` getter/setter that fires a callback, a `root` getter) but
// adapted to what this app actually loads: one Anatomy slot, one
// Tractogram slot (optionally exploded into per-bundle children), one
// LUT slot. LoadedDataStore is the one overall data class; LoadedItem
// is the shared base, with AnatomyItem / TractogramItem / BundleItem /
// LutItem as the file-type-specific subclasses the app asked for.
//
// This module knows nothing about Three.js, WebGL, or app state — it
// only tracks "what's loaded" and "is it on/off", and calls back into
// whatever the app wires up via onVisibilityChange/onMenu. That keeps
// it testable and reusable independent of the renderer.
// ═══════════════════════════════════════════════════════════

class LoadedItem {
  constructor(kind, label) {
    this.kind = kind;     // 'anat' | 'trck' | 'bundle' | 'lut' | 'field' | 'group'
    this.label = label;   // filename / display name
    this.children = [];
    this.parent = null;
    this.collapsed = false;
    this._visible = true;

    // Selector UI: 'checkbox' (default, multi-select on/off) or 'radio'
    // (single-select within radioGroup — used for choosing which of
    // several simultaneously-loaded anatomy files is active; never for
    // bundles, which stay independently toggleable checkboxes).
    this.selectorType = 'checkbox';
    this.radioGroup = null;   // shared name string for a radio's siblings
    this.selected = false;    // radio state, independent of `visible`
    this.radioDeselectable = false; // clicking the already-selected radio
                                    // de-selects it (onSelect fires again;
                                    // the handler toggles) — for "at most
                                    // one", as opposed to "exactly one" 
    this.checkboxDisabled = false; // greys out the checkbox (e.g. an
                                    // anatomy file not currently active,
                                    // so there's nothing to show/hide yet)
                                    // selectorType 'none' = no selector at
                                    // all (just a same-width spacer).

    // Optional row decorations:
    this.tag = null;      // short dim text after the label (e.g. 'per-vertex · scaled')
    this.tooltip = null;  // row hover text; defaults to the label
    this.dimmed = false;  // greyed-out row (e.g. an unmatched data file)
    this.isError = false; // error-styled tag (e.g. an unreadable data file)

    // Wired up by the app after construction:
    this.onVisibilityChange = null; // (item, visible) => void
    this.onSelect = null;           // (item) => void — radio selection
    this.onColorChange = null;      // (item, hex) => void — swatch edit (bundles)
    this.onMenu = null;             // (item, anchorEl) => void — hamburger stub
  }

  addChild(child) {
    child.parent = this;
    this.children.push(child);
    return child;
  }

  get root() {
    return this.parent ? this.parent.root : this;
  }

  get visible() {
    return this._visible;
  }

  set visible(v) {
    this._visible = v;
    if (this.onVisibilityChange) this.onVisibilityChange(this, v);
  }
}

class AnatomyItem extends LoadedItem {
  constructor(label) { super('anat', label); }
}

class LutItem extends LoadedItem {
  constructor(label) { super('lut', label); }
}

class BundleItem extends LoadedItem {
  constructor(label, bundleIndex, colorHex) {
    super('bundle', label);
    this.bundleIndex = bundleIndex; // index into bundlePaletteRGB/streamlineBundleId
    this.colorHex = colorHex || null;
  }
}

// One .dqz child data file (a named per-vertex or per-streamline field).
// Hangs under the tree item of the geometry file it belongs to — a
// TractogramItem for a single-file load, or that file's BundleItem in a
// bundle set — or, while it has no matching parent, under the store's
// "unmatched" group (dimmed). `record` is the app's own bookkeeping
// object for the file (header, parsed data, match status); this class
// doesn't interpret it. A matched field gets a de-selectable radio (the
// app sets selectorType/radioGroup): at most one field per geometry file
// is the active one used to color its streamlines.
class DataFieldItem extends LoadedItem {
  constructor(label, record) {
    super('field', label);
    this.record = record;
    this.selectorType = 'none';
    this.radioDeselectable = true;
  }
}

// A plain grouping row with no file of its own (e.g. "unmatched data").
class DataGroupItem extends LoadedItem {
  constructor(label) {
    super('group', label);
    this.selectorType = 'none';
  }
}

class TractogramItem extends LoadedItem {
  constructor(label) { super('trck', label); }

  // entries: [{name, color}] — color is a '#rrggbb' string or null.
  // Rebuilds the bundle children from scratch (a fresh tractogram load
  // replaces whatever bundle set was there before).
  setBundles(entries) {
    this.children = [];
    entries.forEach((e, i) => this.addChild(new BundleItem(e.name, i, e.color)));
  }
}

// The one overall data class: tracks what's loaded per file type and
// notifies the view when the tree's shape changes (a load/replace/clear
// — not a plain visibility toggle, which items report individually via
// onVisibilityChange). Anatomy is a list rather than a single slot
// because a zip/multi-file drop can deliver several anatomy files at
// once (radio-selected — see registerAnatGroupItems in index.html);
// it's length 1 in the common single-file case.
class LoadedDataStore {
  constructor() {
    this.anatItems = [];
    this.types = { trck: null, lut: null };
    this.unmatchedGroup = null; // DataGroupItem of not-yet-matched data files, or null
    this.invalidGroup = null;   // DataGroupItem of unreadable data files, or null
    this.onChange = null; // () => void
  }

  setAnatItems(items) { this.anatItems = items; this._fire(); }
  setTrck(item) { this.types.trck = item; this._fire(); }
  setLut(item)  { this.types.lut  = item; this._fire(); }
  setUnmatched(item, invalidItem = null) { this.unmatchedGroup = item; this.invalidGroup = invalidItem; this._fire(); }
  // Children were added/removed below an existing root — re-render.
  refresh() { this._fire(); }

  clearAnat() { this.anatItems = []; this._fire(); }
  clearTrck() { this.types.trck = null; this._fire(); }
  clearLut()  { this.types.lut  = null; this._fire(); }

  get roots() {
    return [...this.anatItems, this.types.trck, this.types.lut, this.unmatchedGroup, this.invalidGroup].filter(Boolean);
  }

  _fire() {
    if (this.onChange) this.onChange();
  }
}

// Renders a LoadedDataStore into a container element as a collapsible
// tree: caret (if it has children) · checkbox (on/off) · label ·
// hamburger (per-type menu, stubbed for now — just calls item.onMenu if
// set). Re-renders whenever the store reports a structural change.
class DataTreeView {
  constructor(container, store) {
    this.container = container;
    this.store = store;
    store.onChange = () => this.render();
    this.render();
  }

  render() {
    this.container.innerHTML = '';
    const roots = this.store.roots;
    if (!roots.length) {
      const empty = document.createElement('div');
      empty.className = 'dt-empty';
      empty.textContent = 'Nothing loaded yet — use LOAD… above.';
      this.container.appendChild(empty);
      return;
    }
    for (const item of roots) this.container.appendChild(this._renderNode(item, 0));
  }

  _renderNode(item, depth) {
    const wrap = document.createElement('div');

    const row = document.createElement('div');
    row.className = 'dt-row' + (depth > 0 ? ' dt-sub' : '') + (item.dimmed ? ' dt-dim' : '') + (item.isError ? ' dt-err' : '');
    row.style.paddingLeft = (8 + depth * 14) + 'px';

    const hasChildren = item.children.length > 0;
    const caret = document.createElement('span');
    caret.className = 'dt-caret' + (hasChildren ? '' : ' dt-caret-empty');
    caret.textContent = hasChildren ? (item.collapsed ? '▸' : '▾') : '';
    if (hasChildren) {
      caret.addEventListener('click', e => {
        e.stopPropagation();
        item.collapsed = !item.collapsed;
        this.render();
      });
    }

    let selector;
    if (item.selectorType === 'none') {
      selector = document.createElement('span');
      selector.className = 'dt-noselect';
    } else if (item.selectorType === 'radio') {
      selector = document.createElement('input');
      selector.type = 'radio';
      selector.className = 'dt-radio';
      selector.name = 'dt-radio-' + (item.radioGroup || 'default');
      selector.checked = !!item.selected;
      selector.addEventListener('change', () => {
        if (item.onSelect) item.onSelect(item);
      });
      // A native radio can't be un-checked by clicking it (no 'change'
      // fires), so for a de-selectable radio, remember whether it was
      // already checked when the press started and handle that case here.
      let wasChecked = false;
      selector.addEventListener('pointerdown', () => { wasChecked = selector.checked; });
      selector.addEventListener('click', e => {
        e.stopPropagation();
        if (item.radioDeselectable && wasChecked) {
          selector.checked = false;
          if (item.onSelect) item.onSelect(item);
        }
        wasChecked = false;
      });
    } else {
      selector = document.createElement('input');
      selector.type = 'checkbox';
      selector.className = 'dt-check';
      selector.checked = item.visible;
      selector.disabled = !!item.checkboxDisabled;
      selector.addEventListener('click', e => e.stopPropagation());
      selector.addEventListener('change', () => { item.visible = selector.checked; });
    }

    let swatch = null;
    if (item.kind === 'bundle' && item.colorHex) {
      // A real <input type=color> sized/stripped to look exactly like
      // the old static swatch, so clicking it opens the native color
      // picker without disturbing the row layout — only a hover effect
      // (see the .dt-swatch:hover CSS) hints it's interactive.
      swatch = document.createElement('input');
      swatch.type = 'color';
      swatch.className = 'dt-swatch';
      swatch.value = item.colorHex;
      swatch.title = 'change bundle color';
      swatch.addEventListener('click', e => e.stopPropagation());
      swatch.addEventListener('input', () => {
        item.colorHex = swatch.value;
        if (item.onColorChange) item.onColorChange(item, swatch.value);
      });
    }

    const label = document.createElement('span');
    label.className = 'dt-label';
    label.textContent = item.label;
    label.title = item.tooltip || item.label;

    let tag = null;
    if (item.tag) {
      tag = document.createElement('span');
      tag.className = 'dt-tag';
      tag.textContent = item.tag;
    }

    const menuBtn = document.createElement('button');
    menuBtn.className = 'dt-menu-btn';
    menuBtn.textContent = '☰';
    menuBtn.title = 'options';
    if (!item.onMenu) {
      menuBtn.disabled = true;
      menuBtn.title = 'options — coming soon';
    } else {
      menuBtn.addEventListener('click', e => {
        e.stopPropagation();
        item.onMenu(item, menuBtn);
      });
    }

    row.appendChild(caret);
    row.appendChild(selector);
    if (swatch) row.appendChild(swatch);
    row.appendChild(label);
    if (tag) row.appendChild(tag);
    row.appendChild(menuBtn);
    wrap.appendChild(row);

    if (hasChildren && !item.collapsed) {
      for (const child of item.children) wrap.appendChild(this._renderNode(child, depth + 1));
    }
    return wrap;
  }
}

export { LoadedItem, AnatomyItem, TractogramItem, BundleItem, LutItem, DataFieldItem, DataGroupItem, LoadedDataStore, DataTreeView };
