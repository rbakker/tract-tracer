// ═══════════════════════════════════════════════════════════
// Draggable floating panel, shared by the FILE / SETTINGS / ABOUT
// windows (previously one physical div that swapped its content —
// now three independent panels that share a "dock slot").
//
// Behavior:
//  - Fresh open (never dragged this session): the panel snaps to its
//    default position (anchored to the top-left button row) and
//    opening it closes any OTHER undocked-and-open panel in the same
//    group — i.e. the old "shared modal" replace behavior.
//  - Once the user drags a panel by its titlebar, it becomes "pinned":
//    from then on it keeps whatever position it was dropped at, stays
//    open independently of the other panels, and never auto-closes on
//    an outside click. Only its own × button (or clicking its trigger
//    button again) closes it. This is what lets someone drag SETTINGS
//    to one corner and FILE to another and have both stay up.
//  - Pinning is a per-session thing — nothing is persisted, matching
//    the existing "always reopens at the default spot" behavior for
//    an undragged panel.
// ═══════════════════════════════════════════════════════════

function clampPanelPos(panel, left, top) {
  const margin = 60; // keep at least this much of the panel reachable/visible
  const maxLeft = window.innerWidth  - margin;
  const maxTop  = window.innerHeight - margin;
  return [
    Math.min(Math.max(left, margin - panel.offsetWidth), maxLeft),
    Math.min(Math.max(top, 0), maxTop),
  ];
}

class FloatingPanel {
  // panelEl: the .app-panel element (must contain .app-panel-titlebar
  //   and .app-panel-close somewhere inside it).
  // anchorEl: element whose bottom-left corner defines the default dock
  //   position (e.g. the fullscreen button, so panels line up under the
  //   top-left button row). Ignored if defaultPos is given.
  // defaultPos: optional explicit {left, top} default position, for a
  //   panel that isn't docked under the top-bar buttons (e.g. the
  //   HEADER panel, which defaults near the top-left corner instead).
  // triggerBtn: optional top-bar button that opens/closes this panel.
  //   Omit for a panel that's only ever opened programmatically.
  // group: a PanelDockGroup shared by every panel that should replace
  //   each other while undocked.
  // onOpen: optional callback fired every time the panel opens (used
  //   for e.g. lazy-loading ABOUT's content on first open).
  constructor({ panelEl, anchorEl, defaultPos, triggerBtn, group, onOpen }) {
    this.el = panelEl;
    this.titlebar = this.el.querySelector('.app-panel-titlebar');
    this.closeBtn = this.el.querySelector('.app-panel-close');
    this.anchorEl = anchorEl || null;
    this.defaultPos = defaultPos || null;
    this.group = group;
    this.onOpen = onOpen || null;
    this.pinned = false; // becomes true the first time it's actually dragged

    this.group.register(this);
    this._initDrag();

    this.closeBtn.addEventListener('click', e => { e.stopPropagation(); this.close(); });
    this.el.addEventListener('click', e => e.stopPropagation());
    if (triggerBtn) triggerBtn.addEventListener('click', e => { e.stopPropagation(); this.toggle(); });
  }

  get isOpen() { return this.el.classList.contains('open'); }

  toggle() { this.isOpen ? this.close() : this.open(); }

  open() {
    if (!this.pinned) {
      this.group.closeUndocked(this);
      this._positionAtDefault();
    }
    this.el.classList.add('open');
    if (this.onOpen) this.onOpen();
  }

  close() {
    this.el.classList.remove('open');
  }

  _positionAtDefault() {
    let left, top;
    if (this.defaultPos) {
      ({ left, top } = this.defaultPos);
    } else {
      const r = this.anchorEl.getBoundingClientRect();
      left = r.left; top = r.bottom + 6;
    }
    const [l, t] = clampPanelPos(this.el, left, top);
    this.el.style.left = l + 'px';
    this.el.style.top  = t + 'px';
  }

  _initDrag() {
    let dragging = false, startX, startY, startLeft, startTop, moved;
    // Pointer Events (not mouse-only) so this also works with touch.
    this.titlebar.style.touchAction = 'none';
    this.titlebar.addEventListener('pointerdown', e => {
      if (e.target.closest('.app-panel-close')) return; // let the close button handle its own click
      dragging = true;
      moved = false;
      startX = e.clientX; startY = e.clientY;
      const r = this.el.getBoundingClientRect();
      startLeft = r.left; startTop = r.top;
      this.el.classList.add('dragging');
      this.titlebar.setPointerCapture(e.pointerId);
      e.preventDefault();
    });
    this.titlebar.addEventListener('pointermove', e => {
      if (!dragging) return;
      const dx = e.clientX - startX, dy = e.clientY - startY;
      if (Math.abs(dx) > 4 || Math.abs(dy) > 4) moved = true;
      const [l, t] = clampPanelPos(this.el, startLeft + dx, startTop + dy);
      this.el.style.left = l + 'px';
      this.el.style.top  = t + 'px';
    });
    this.titlebar.addEventListener('pointerup', () => {
      if (dragging && moved) this.pinned = true;
      dragging = false;
      this.el.classList.remove('dragging');
    });
  }
}

// Coordinates the "replace each other while undocked" / "outside click
// closes only the undocked ones" behavior across a set of panels.
class PanelDockGroup {
  constructor() {
    this.panels = [];
    document.addEventListener('click', () => {
      for (const p of this.panels) if (p.isOpen && !p.pinned) p.close();
    });
  }
  register(panel) { this.panels.push(panel); }
  closeUndocked(exceptPanel) {
    for (const p of this.panels) if (p !== exceptPanel && p.isOpen && !p.pinned) p.close();
  }
}

export { FloatingPanel, PanelDockGroup, clampPanelPos };
