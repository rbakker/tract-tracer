// ═══════════════════════════════════════════════════════════
// Object model + view for the FILE panel's collapsible data tree.
//
// Shape is deliberately similar to graphxtree.js (parent/child nodes,
// a `visible` getter/setter that fires a callback, a `root` getter) but
// adapted to what this app actually loads. The tree has exactly two
// levels: three category headings — Anatomy (volumes), Parcellations
// (label volumes, plus lookup tables not attached to any volume yet) and
// Streamline bundles (one row per streamline file: each bundle of a
// bundle set, or the single tractogram; plus .dqz data files that can't
// be attached) — with one row per item under them. Anything that belongs
// to a row (its lookup table, its .dqz data fields) lives in that row's
// settings area, not in a deeper level. LoadedDataStore is the one
// overall data class; LoadedItem
// is the shared base, with AnatomyItem / TractogramItem / BundleItem /
// LutItem as the file-type-specific subclasses the app asked for.
//
// This module knows nothing about Three.js, WebGL, or app state — it
// only tracks "what's loaded" and "is it on/off", and calls back into
// whatever the app wires up via onVisibilityChange/buildSettings. That keeps
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
    // Per-item settings, shown INLINE under the row when its settings
    // toggle (» at the row's right end) is open. The app fills the area:
    // (item, containerEl) => void, called on every render while open —
    // makeSettingsButton() below builds a standard button for it. Items
    // without buildSettings get no toggle.
    this.buildSettings = null;
    this.settingsOpen = false;
  }

  addChild(child) {
    child.parent = this;
    this.children.push(child);
    return child;
  }

  get root() {
    return this.parent ? this.parent.root : this;
  }

  // Items of the same category are "the same type of thing" for the
  // purpose of on/off cascading: a tractogram row and its bundle rows are
  // both 'streamlines' even though their kinds differ. Defaults to the
  // kind; subclasses override where kinds should be grouped.
  get category() {
    return this.kind;
  }

  get visible() {
    return this._visible;
  }

  // Switching an item on/off also switches every descendant of the SAME
  // category, recursively (e.g. a bundle-set row -> all its bundle rows),
  // each through its own setter, so each child's onVisibilityChange runs.
  // Children of another category (e.g. a bundle's data-field rows) are
  // left alone, and the cascade doesn't descend into them.
  set visible(v) {
    this._visible = v;
    if (this.onVisibilityChange) this.onVisibilityChange(this, v);
    for (const c of this.children) {
      if (c.category === this.category && c.selectorType === 'checkbox' && c._visible !== v) c.visible = v;
    }
  }
}

class AnatomyItem extends LoadedItem {
  constructor(label) { super('anat', label); }
}

class LutItem extends LoadedItem {
  constructor(label) { super('lut', label); }
}

// One markers file (markers-format.md).
class MarkersItem extends LoadedItem {
  constructor(label) { super('markers', label); }
}

class BundleItem extends LoadedItem {
  get category() { return 'streamlines'; }
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

// A plain grouping row with no file of its own. isCategory marks the
// three top-level category headings (see LoadedDataStore), which the view
// styles as headings; selectAll gives a heading a checkbox that switches
// all its rows on/off (checked = all on, indeterminate = some on).
class DataGroupItem extends LoadedItem {
  constructor(label, isCategory = false) {
    super('group', label);
    this.selectorType = 'none';
    this.isCategory = isCategory;
    this.selectAll = false;
  }
}

// A row of controls rather than a data item (e.g. "select all / none ·
// header" at the top of Streamline bundles): the app fills the row via
// build(item, rowEl). No caret, selector or settings toggle.
class ToolbarItem extends LoadedItem {
  constructor(build) {
    super('toolbar', '');
    this.selectorType = 'none';
    this.build = build;
  }
}

class TractogramItem extends LoadedItem {
  get category() { return 'streamlines'; }
  constructor(label) { super('trck', label); }

  // entries: [{name, color}] — color is a '#rrggbb' string or null.
  // Rebuilds the bundle children from scratch (a fresh tractogram load
  // replaces whatever bundle set was there before).
  setBundles(entries) {
    this.children = [];
    entries.forEach((e, i) => this.addChild(new BundleItem(e.name, i, e.color)));
  }
}

// The one overall data class: tracks what's loaded and notifies the view
// when the tree's shape changes (a load/replace/clear — not a plain
// visibility toggle, which items report individually via
// onVisibilityChange). The tree always has the same three category rows
// (kept here, so their collapsed state survives rebuilds of what's under
// them); a category with nothing in it isn't shown.
class LoadedDataStore {
  constructor() {
    this.categories = {
      anatomy:       new DataGroupItem('Anatomy', true),
      parcellations: new DataGroupItem('Parcellations', true),
      streamlines:   new DataGroupItem('Streamline bundles', true),
      markers:       new DataGroupItem('Markers', true),
    };
    this.anatomyItems = [];       // volume rows (see registerVolumeItems in index.html)
    this.parcellationItems = [];  // label-volume rows + unattached lookup-table rows
    this.streamlineItems = [];    // one row per streamline file (bundle, or the single tractogram)
    this.dataFileItems = [];      // .dqz data files with no parent to attach to, or unreadable
    this.streamlineToolbar = null; // ToolbarItem shown first under Streamline bundles while it has rows
    this.markerItems = [];        // one row per markers file
    this.onChange = null; // () => void
  }

  setVolumes(anatomyItems, parcellationItems) {
    this.anatomyItems = anatomyItems; this.parcellationItems = parcellationItems; this._fire();
  }
  setStreamlines(items) { this.streamlineItems = items; this._fire(); }
  setDataFiles(items) { this.dataFileItems = items; this._fire(); }
  setMarkers(items) { this.markerItems = items; this._fire(); }
  // Something shown in the tree changed (a tag, a settings area) — re-render.
  refresh() { this._fire(); }

  clearVolumes() { this.setVolumes([], []); }
  clearStreamlines() { this.streamlineItems = []; this._fire(); }

  get roots() {
    const { anatomy, parcellations, streamlines, markers } = this.categories;
    const fill = (group, items) => {
      group.children = [];
      for (const it of items) if (it) group.addChild(it);
      return group;
    };
    fill(anatomy, this.anatomyItems);
    fill(parcellations, this.parcellationItems);
    fill(streamlines, [this.streamlineItems.length ? this.streamlineToolbar : null, ...this.streamlineItems, ...this.dataFileItems]);
    fill(markers, this.markerItems);
    return [anatomy, parcellations, streamlines, markers].filter(g => g.children.length);
  }

  _fire() {
    if (this.onChange) this.onChange();
  }
}

// A standard button for an item's settings area (see buildSettings).
function makeSettingsButton(label, onClick, title = null) {
  const b = document.createElement('button');
  b.className = 'accent-link dt-set-btn';
  b.textContent = label;
  if (title) b.title = title;
  b.addEventListener('click', e => { e.stopPropagation(); onClick(e); });
  return b;
}

// Renders a LoadedDataStore into a container element as a collapsible
// tree: caret (if it has children) · checkbox (on/off) · label ·
// settings toggle (» — opens/closes the item's inline settings area, see
// buildSettings). Re-renders whenever the store reports a structural
// change.
class DataTreeView {
  constructor(container, store) {
    this.container = container;
    this.container.classList.add('dt-root'); // CSS hook, see .dt-row's separator rule
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
    for (const item of roots) this.container.appendChild(this._renderNode(item, 0, item.isCategory ? 1 : 0));
  }

  // topDepth: the depth of the tree's "main" rows — 1 under a category
  // heading — which get the brighter top-level label style; deeper rows
  // are sub-rows.
  _renderNode(item, depth, topDepth = 0) {
    const wrap = document.createElement('div');
    if (item.kind === 'toolbar') {
      const bar = document.createElement('div');
      bar.className = 'dt-row dt-toolbar';
      bar.style.paddingLeft = (8 + depth * 14) + 'px';
      item.build(item, bar);
      wrap.appendChild(bar);
      return wrap;
    }

    const row = document.createElement('div');
    row.className = 'dt-row' + (item.isCategory ? ' dt-cat' : depth > topDepth ? ' dt-sub' : '')
                  + (item.dimmed ? ' dt-dim' : '') + (item.isError ? ' dt-err' : '');
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
      // A category heading has nothing else to click on, so its whole
      // row expands/collapses it.
      if (item.isCategory) row.addEventListener('click', () => { item.collapsed = !item.collapsed; this.render(); });
    }

    let selector;
    if (item.isCategory && item.selectAll) {
      // Select/deselect all: checked when every switchable row is on,
      // indeterminate when only some are.
      const rows = item.children.filter(c => c.selectorType === 'checkbox' && !c.checkboxDisabled);
      const on = rows.filter(c => c.visible).length;
      selector = document.createElement('input');
      selector.type = 'checkbox';
      selector.className = 'dt-check';
      selector.checked = rows.length > 0 && on === rows.length;
      selector.indeterminate = on > 0 && on < rows.length;
      selector.disabled = !rows.length;
      selector.title = 'all on / off';
      selector.addEventListener('click', e => e.stopPropagation());
      selector.addEventListener('change', () => {
        for (const c of rows) if (c.visible !== selector.checked) c.visible = selector.checked;
        this.render();
      });
    } else if (item.selectorType === 'none') {
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
      selector.addEventListener('change', () => {
        item.visible = selector.checked;
        // Redraw so the heading's all-on/off checkbox (and any
        // same-category children, see the visible setter) show it.
        this.render();
      });
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

    // Settings toggle: » turned to point down (closed) / up (open) via
    // CSS. A row with nothing to configure gets an empty, same-width
    // placeholder so labels and tags stay aligned.
    const menuBtn = document.createElement(item.buildSettings ? 'button' : 'span');
    menuBtn.className = 'dt-menu-btn' + (item.settingsOpen ? ' dt-open' : '');
    if (item.buildSettings) {
      menuBtn.textContent = '»';
      menuBtn.title = item.settingsOpen ? 'hide settings' : 'settings';
      menuBtn.addEventListener('click', e => {
        e.stopPropagation();
        item.settingsOpen = !item.settingsOpen;
        this.render();
      });
    }

    row.appendChild(caret);
    if (!item.isCategory || item.selectAll) row.appendChild(selector);
    if (swatch) row.appendChild(swatch);
    row.appendChild(label);
    if (tag) row.appendChild(tag);
    row.appendChild(menuBtn);
    wrap.appendChild(row);

    if (item.buildSettings && item.settingsOpen) {
      const panel = document.createElement('div');
      panel.className = 'dt-settings';
      panel.style.paddingLeft = (8 + (depth + 1) * 14 + 20) + 'px';
      item.buildSettings(item, panel);
      wrap.appendChild(panel);
    }

    if (hasChildren && !item.collapsed) {
      for (const child of item.children) wrap.appendChild(this._renderNode(child, depth + 1, topDepth));
    }
    return wrap;
  }
}

export { LoadedItem, AnatomyItem, TractogramItem, ToolbarItem, MarkersItem, BundleItem, LutItem, DataFieldItem, DataGroupItem, LoadedDataStore, DataTreeView, makeSettingsButton };
