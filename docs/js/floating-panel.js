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
//  - Once the user drags a panel, it becomes "pinned": from then on it
//    keeps whatever position it was dropped at, stays open
//    independently of the other panels, and never auto-closes on an
//    outside click. Only its own × button (or clicking its trigger
//    button again) closes it.
//  - Dragging: by default the panel can be grabbed anywhere, except on
//    interactive elements (inputs, sliders, buttons, links, …), native
//    scrollbars, and anything marked [data-no-drag]. Pass
//    dragAnywhere: false to restrict dragging to the titlebar.
//  - Stacking: pressing anywhere in a panel (or tabbing into it, or
//    opening it) brings it to the front of its group. The group owns
//    the z-index values; the calling script doesn't need to manage them.
//    The topmost open panel gets the group's focus class (default
//    'focused') so the user can see which one is active.
//  - Trigger button is a three-way toggle: hidden → open, open but not
//    focused → focused, focused → hidden. So pressing it for a panel
//    buried under another one brings it up instead of hiding it.
//  - Pinning is a per-session thing — nothing is persisted.
// ═══════════════════════════════════════════════════════════

// Elements that should keep their own pointer behavior instead of
// starting a drag. Extend per panel via the noDragSelector option,
// or mark individual elements with data-no-drag.
const INTERACTIVE_SELECTOR = [
  'input', 'textarea', 'select', 'option', 'button', 'a[href]', 'label', 'summary',
  'video[controls]', 'audio[controls]',
  '[contenteditable]:not([contenteditable="false"])',
  '[role="slider"]', '[role="button"]', '[role="checkbox"]', '[role="radio"]',
  '[role="switch"]', '[role="tab"]', '[role="menuitem"]', '[role="option"]',
  '[role="textbox"]', '[role="spinbutton"]', '[role="scrollbar"]', '[role="combobox"]',
  '[data-no-drag]',
  '.app-panel-close',
].join(', ');

const DRAG_THRESHOLD = 4; // px of movement before a press turns into a drag

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
  //   position. Ignored if defaultPos is given.
  // defaultPos: optional explicit {left, top} default position.
  // triggerBtn: optional top-bar button that opens/closes this panel.
  // group: a PanelDockGroup shared by every panel that should replace
  //   each other while undocked (and stack relative to each other).
  // onOpen: optional callback fired every time the panel opens.
  // dragAnywhere: true (default) = grab anywhere except controls;
  //   false = titlebar only (the old behavior).
  // noDragSelector: optional extra CSS selector for elements that must
  //   not start a drag (e.g. '.color-wheel, canvas').
  constructor({ panelEl, anchorEl, defaultPos, triggerBtn, group, onOpen,
                dragAnywhere = true, noDragSelector = '' }) {
    this.el = panelEl;
    this.titlebar = this.el.querySelector('.app-panel-titlebar');
    this.closeBtn = this.el.querySelector('.app-panel-close');
    this.anchorEl = anchorEl || null;
    this.defaultPos = defaultPos || null;
    this.group = group;
    this.onOpen = onOpen || null;
    this.pinned = false; // becomes true the first time it's actually dragged
    this.dragAnywhere = dragAnywhere;
    this.noDragSelector = noDragSelector
      ? `${INTERACTIVE_SELECTOR}, ${noDragSelector}`
      : INTERACTIVE_SELECTOR;

    this.group.register(this);
    this._initDrag();

    // Raise on any press inside the panel. Capture phase, so it still
    // works when a child control stops propagation.
    this.el.addEventListener('pointerdown', () => this.group.bringToFront(this), true);
    // Keyboard users tabbing into a panel should see it too.
    this.el.addEventListener('focusin', () => this.group.bringToFront(this));

    this.closeBtn.addEventListener('click', e => { e.stopPropagation(); this.close(); });
    this.el.addEventListener('click', e => e.stopPropagation());
    if (triggerBtn) triggerBtn.addEventListener('click', e => { e.stopPropagation(); this.toggle(); });
  }

  get isOpen() { return this.el.classList.contains('open'); }

  // Three-way toggle, so the trigger button always has a visible effect:
  //   hidden            → open (and focused)
  //   open, not focused → focused (brought to front)
  //   open and focused  → hidden
  toggle() {
    if (!this.isOpen) this.open();
    else if (!this.isFocused) this.group.bringToFront(this);
    else this.close();
  }

  // True when this is the topmost open panel of its group.
  get isFocused() { return this.group.frontPanel() === this; }

  open() {
    if (!this.pinned) {
      this.group.closeUndocked(this);
      this._positionAtDefault();
    }
    this.el.classList.add('open');
    this.group.bringToFront(this);
    if (this.onOpen) this.onOpen();
  }

  close() {
    this.el.classList.remove('open');
    this.group.refresh(); // focus passes to the next open panel down
  }

  bringToFront() { this.group.bringToFront(this); }

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

  // Decide whether a press on e.target may start a drag.
  _canStartDrag(e) {
    if (e.button !== 0) return false; // primary button / touch contact / pen tip only
    const t = e.target;
    if (!(t instanceof Element)) return false;
    if (t.closest(this.noDragSelector)) return false;
    if (!this.dragAnywhere && !t.closest('.app-panel-titlebar')) return false;
    // A press on a native scrollbar targets the scrolling element itself,
    // but lands outside its client area.
    const hasVScroll = t.scrollHeight > t.clientHeight;
    const hasHScroll = t.scrollWidth  > t.clientWidth;
    if ((hasVScroll && e.offsetX >= t.clientWidth) ||
        (hasHScroll && e.offsetY >= t.clientHeight)) return false;
    return true;
  }

  _initDrag() {
    const handle = this.dragAnywhere ? this.el : this.titlebar;
    let state = null; // { id, startX, startY, startLeft, startTop, moving }

    // Pointer Events (not mouse-only) so this also works with touch.
    this.titlebar.style.touchAction = 'none';

    handle.addEventListener('pointerdown', e => {
      if (state || !this._canStartDrag(e)) return;
      const r = this.el.getBoundingClientRect();
      state = {
        id: e.pointerId,
        startX: e.clientX, startY: e.clientY,
        startLeft: r.left, startTop: r.top,
        moving: false,
      };
      e.preventDefault(); // no text selection / native image drag while grabbing
    });

    handle.addEventListener('pointermove', e => {
      if (!state || e.pointerId !== state.id) return;
      const dx = e.clientX - state.startX, dy = e.clientY - state.startY;
      if (!state.moving) {
        // Only turn into a drag after a real movement, so a plain click
        // on the panel body doesn't nudge it and still reaches its target.
        if (Math.hypot(dx, dy) < DRAG_THRESHOLD) return;
        state.moving = true;
        handle.setPointerCapture(e.pointerId);
        this.el.classList.add('dragging');
      }
      const [l, t] = clampPanelPos(this.el, state.startLeft + dx, state.startTop + dy);
      this.el.style.left = l + 'px';
      this.el.style.top  = t + 'px';
    });

    const end = e => {
      if (!state || e.pointerId !== state.id) return;
      if (state.moving) {
        this.pinned = true;
        this.el.classList.remove('dragging');
      }
      state = null;
    };
    handle.addEventListener('pointerup', end);
    handle.addEventListener('pointercancel', end);
  }
}

// Coordinates the "replace each other while undocked" / "outside click
// closes only the undocked ones" behavior across a set of panels, and
// owns their stacking order and which one is focused.
class PanelDockGroup {
  // baseZ: z-index of the bottom-most panel; panels get baseZ, baseZ+1, …
  // focusClass: class put on the topmost open panel (style it in CSS,
  //   e.g. a blue border). Set it to whatever class your CSS already uses.
  constructor({ baseZ = 1000, focusClass = 'focused' } = {}) {
    this.panels = [];
    this.stack = []; // bottom → top
    this.baseZ = baseZ;
    this.focusClass = focusClass;
    document.addEventListener('click', () => {
      for (const p of this.panels) if (p.isOpen && !p.pinned) p.close();
    });
  }

  register(panel) {
    this.panels.push(panel);
    this.stack.push(panel);
    this.refresh();
  }

  closeUndocked(exceptPanel) {
    for (const p of this.panels) if (p !== exceptPanel && p.isOpen && !p.pinned) p.close();
  }

  bringToFront(panel) {
    const i = this.stack.indexOf(panel);
    if (i === -1) return;
    if (i !== this.stack.length - 1) {
      this.stack.splice(i, 1);
      this.stack.push(panel);
    }
    this.refresh();
  }

  // Topmost open panel, or null when none are open.
  frontPanel() {
    for (let i = this.stack.length - 1; i >= 0; i--) {
      if (this.stack[i].isOpen) return this.stack[i];
    }
    return null;
  }

  // Reapply z-indexes and the focus class. Reassigning compact values
  // keeps z-index bounded instead of counting up forever.
  refresh() {
    const front = this.frontPanel();
    this.stack.forEach((p, i) => {
      p.el.style.zIndex = String(this.baseZ + i);
      p.el.classList.toggle(this.focusClass, p === front);
    });
  }
}

export { FloatingPanel, PanelDockGroup, clampPanelPos, INTERACTIVE_SELECTOR };
