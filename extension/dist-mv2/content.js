var __defProp = Object.defineProperty;
var __returnValue = (v) => v;
function __exportSetter(name, newValue) {
  this[name] = __returnValue.bind(null, newValue);
}
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, {
      get: all[name],
      enumerable: true,
      configurable: true,
      set: __exportSetter.bind(all, name)
    });
};
var __esm = (fn, res) => () => (fn && (res = fn(fn = 0)), res);

// extension/src/content/element-tree.ts
function buildSelector(el) {
  if (el.id)
    return `#${CSS.escape(el.id)}`;
  const parts = [];
  let current = el;
  while (current && current !== document.body) {
    let selector = current.tagName.toLowerCase();
    if (current.id) {
      parts.unshift(`#${CSS.escape(current.id)}`);
      break;
    }
    const parent = current.parentElement;
    if (parent) {
      const currentTagName = current.tagName;
      const siblings = Array.from(parent.children).filter((c) => c.tagName === currentTagName);
      if (siblings.length > 1) {
        const idx = siblings.indexOf(current) + 1;
        selector += `:nth-of-type(${idx})`;
      }
    }
    parts.unshift(selector);
    current = parent;
  }
  return parts.join(" > ");
}
function getRelevantAttrs(el) {
  const attrs = [];
  const tag = el.tagName.toLowerCase();
  const role = el.getAttribute("role");
  if (role)
    attrs.push(`role="${role}"`);
  if (tag === "a") {
    const href = el.getAttribute("href");
    if (href)
      attrs.push(`href="${href.slice(0, 60)}"`);
  }
  if (tag === "input") {
    const type = el.getAttribute("type");
    if (type)
      attrs.push(`type="${type}"`);
    const placeholder = el.getAttribute("placeholder");
    if (placeholder)
      attrs.push(`placeholder="${placeholder}"`);
    const value = el.value;
    if (value)
      attrs.push(`value="${value.slice(0, 40)}"`);
    if (el.checked)
      attrs.push("checked");
    if (el.disabled)
      attrs.push("disabled");
  }
  if (tag === "select" || tag === "textarea") {
    const value = el.value;
    if (value)
      attrs.push(`value="${value.slice(0, 40)}"`);
  }
  if (tag === "img") {
    const src = el.getAttribute("src");
    if (src)
      attrs.push(`src="${src.slice(0, 60)}"`);
    const alt = el.getAttribute("alt");
    if (alt)
      attrs.push(`alt="${alt.slice(0, 40)}"`);
  }
  const expanded = el.getAttribute("aria-expanded");
  if (expanded)
    attrs.push(`expanded=${expanded}`);
  const pressed = el.getAttribute("aria-pressed");
  if (pressed)
    attrs.push(`pressed=${pressed}`);
  const selected = el.getAttribute("aria-selected");
  if (selected === "true")
    attrs.push("selected");
  const ariaHidden = el.getAttribute("aria-hidden");
  if (ariaHidden === "true")
    attrs.push("aria-hidden");
  if (el.ariaDisabled === "true" || el.disabled)
    attrs.push("disabled");
  const live = el.getAttribute("aria-live");
  if (live && live !== "off")
    attrs.push(`live="${live}"`);
  const required = el.getAttribute("aria-required") || (el.hasAttribute("required") ? "true" : null);
  if (required === "true")
    attrs.push("required");
  const invalid = el.getAttribute("aria-invalid");
  if (invalid === "true")
    attrs.push("invalid");
  return attrs.join(" ");
}
function hasOwnPointerCursor(cursor, parentCursor) {
  return cursor === "pointer" && parentCursor !== "pointer";
}
function getStyleBundle(el) {
  const cs = getComputedStyle(el);
  const parts = [];
  for (const prop of STYLE_BUNDLE_PROPS) {
    const cssName = prop === "backgroundColor" ? "background-color" : prop === "fontSize" ? "font-size" : prop === "fontWeight" ? "font-weight" : prop;
    const v = cs.getPropertyValue(cssName);
    if (!v)
      continue;
    const trimmed = (v.length > 40 ? v.slice(0, 40) : v).replace(/\s+/g, " ").trim();
    parts.push(`${prop}=${trimmed.includes(" ") ? `'${trimmed}'` : trimmed}`);
  }
  return parts.join(" ");
}
function buildElementTree(elements) {
  return elements.map((e) => {
    const role = getEffectiveRole(e.element);
    const name = e.text ? ` "${e.text}"` : "";
    const attrStr = e.attrs ? ` ${e.attrs}` : "";
    return `[${e.refId}] ${role || e.tag}${name}${attrStr}`;
  }).join(`
`);
}
var STYLE_BUNDLE_PROPS;
var init_element_tree = __esm(() => {
  init_a11y_tree();
  STYLE_BUNDLE_PROPS = [
    "display",
    "visibility",
    "color",
    "backgroundColor",
    "fontSize",
    "fontWeight",
    "cursor",
    "opacity"
  ];
});

// extension/src/content/a11y-tree.ts
function isUploadTarget(el, maxDepth = 3) {
  if (el instanceof HTMLInputElement && el.type === "file")
    return true;
  let frontier = [el];
  for (let d = 0;d < maxDepth && frontier.length; d++) {
    const next = [];
    for (const node of frontier) {
      for (const child of Array.from(node.children)) {
        if (child instanceof HTMLInputElement && child.type === "file")
          return true;
        next.push(child);
      }
    }
    frontier = next;
  }
  return false;
}
function shouldDescendDespiteZeroArea(display, position) {
  return position === "fixed" || position === "absolute" || display === "inline";
}
function getEffectiveRole(el, style) {
  const explicit = el.getAttribute("role");
  if (explicit)
    return explicit;
  const tag = el.tagName.toLowerCase();
  if (tag === "a" && el.hasAttribute("href"))
    return "link";
  if (tag === "button" || tag === "summary")
    return "button";
  if (tag === "select")
    return "combobox";
  if (tag === "textarea")
    return "textbox";
  if (tag === "nav")
    return "navigation";
  if (tag === "main")
    return "main";
  if (tag === "aside")
    return "complementary";
  if (tag === "form")
    return "form";
  if (tag === "img")
    return "img";
  if (tag === "details")
    return "group";
  if (tag === "ul" || tag === "ol")
    return "list";
  if (tag === "li")
    return "listitem";
  if (tag === "table")
    return "table";
  if (tag === "tr")
    return "row";
  if (tag === "td")
    return "cell";
  if (tag === "th")
    return "columnheader";
  if (/^h[1-6]$/.test(tag))
    return "heading";
  if (tag === "header") {
    if (!el.closest("article, section"))
      return "banner";
  }
  if (tag === "footer") {
    if (!el.closest("article, section"))
      return "contentinfo";
  }
  if (tag === "section") {
    const name = el.getAttribute("aria-label") || el.getAttribute("aria-labelledby");
    if (name)
      return "region";
  }
  if (el.namespaceURI === "http://www.w3.org/2000/svg") {
    if (tag === "a")
      return "link";
    if (el.hasAttribute("onclick") || (style ?? getComputedStyle(el)).cursor === "pointer")
      return "button";
    return "img";
  }
  if (tag === "input") {
    const type = (el.getAttribute("type") || "text").toLowerCase();
    const inputRoles = {
      checkbox: "checkbox",
      radio: "radio",
      range: "slider",
      search: "searchbox",
      email: "textbox",
      tel: "textbox",
      url: "textbox",
      number: "spinbutton",
      text: "textbox",
      password: "textbox"
    };
    return inputRoles[type] || "textbox";
  }
  return "";
}
function getAccessibleName(el) {
  const ariaLabel = el.getAttribute("aria-label");
  if (ariaLabel && ariaLabel.trim())
    return ariaLabel.trim();
  const labelledBy = el.getAttribute("aria-labelledby");
  if (labelledBy) {
    const parts = labelledBy.split(/\s+/).map((id) => {
      const ref = document.getElementById(id);
      return ref ? (ref.textContent || "").trim() : "";
    }).filter(Boolean);
    if (parts.length)
      return parts.join(" ");
  }
  const tag = el.tagName;
  if (tag === "INPUT" || tag === "SELECT" || tag === "TEXTAREA") {
    const id = el.getAttribute("id");
    if (id) {
      const label = document.querySelector(`label[for="${CSS.escape(id)}"]`);
      if (label && (label.textContent || "").trim())
        return (label.textContent || "").trim();
    }
    const parentLabel = el.closest("label");
    if (parentLabel && (parentLabel.textContent || "").trim())
      return (parentLabel.textContent || "").trim();
  }
  if (tag === "IMG") {
    const alt = el.getAttribute("alt");
    if (alt && alt.trim())
      return alt.trim();
  }
  const title = el.getAttribute("title");
  if (title && title.trim())
    return title.trim();
  return (el.textContent || "").trim().slice(0, 80);
}
function compactAttrClause(attrs) {
  if (!attrs)
    return "";
  const matches = attrs.matchAll(/(\S+?)="([^"]*)"/g);
  let out = "";
  for (const m of matches)
    out += `|${m[1]}=${m[2]}`;
  return out;
}
function buildA11yTree(root, depth, maxDepth, filter, includeStyle = false, format = "verbose") {
  if (depth > maxDepth)
    return "";
  const lines = [];
  const compact = format === "compact";
  function walk(el, d) {
    if (d > maxDepth)
      return;
    const style = el.tagName === "BODY" ? null : getComputedStyle(el);
    const selfVisible = el.tagName === "BODY" || isVisible(el, style);
    if (!selfVisible) {
      if (style.display === "none" || style.visibility === "hidden")
        return;
      if (!shouldDescendDespiteZeroArea(style.display, style.position))
        return;
    }
    const role = getEffectiveRole(el, style ?? undefined);
    const tag = el.tagName.toLowerCase();
    const isLandmark = LANDMARK_ROLES.has(role) || LANDMARK_TAGS.has(el.tagName);
    const isHeading = /^h[1-6]$/.test(tag) || role === "heading";
    const isInteractiveEl = isInteractive(el, INTERACTIVE_TAGS, INTERACTIVE_ROLES, style ?? undefined);
    const prefix = compact ? ">".repeat(d) : "  ".repeat(d);
    if (selfVisible && isLandmark && !isInteractiveEl) {
      const name = getAccessibleName(el);
      const hasName = !!name && name !== (el.textContent || "").trim().slice(0, 80);
      if (compact) {
        lines.push(`${prefix}${role || tag}${hasName ? `|${name}` : ""}`);
      } else {
        const nameStr = hasName ? ` "${name}"` : "";
        lines.push(`${prefix}${role || tag}${nameStr}`);
      }
    }
    if (selfVisible && isHeading && filter === "all") {
      const name = getAccessibleName(el);
      if (compact) {
        lines.push(`${prefix}heading|${name}`);
      } else {
        lines.push(`${prefix}heading "${name}"`);
      }
    }
    if (selfVisible && isInteractiveEl) {
      const refId = getOrAssignRef(el);
      const name = getAccessibleName(el);
      const attrs = getRelevantAttrs(el);
      const styleBundle = includeStyle ? getStyleBundle(el) : "";
      const uploadable = isUploadTarget(el);
      if (compact) {
        const nameClause = name ? `|${name}` : "";
        const attrClause = compactAttrClause(attrs);
        const styleClause = styleBundle ? `|style={${styleBundle}}` : "";
        const uploadClause = uploadable ? "|upload" : "";
        lines.push(`${prefix}[${refId}|${role || tag}${nameClause}${attrClause}${styleClause}${uploadClause}]`);
      } else {
        const nameStr = name ? ` "${name}"` : "";
        const attrStr = attrs ? ` ${attrs}` : "";
        const styleStr = styleBundle ? ` style="${styleBundle}"` : "";
        const uploadStr = uploadable ? ` upload="interceptor upload ${refId} <path>"` : "";
        lines.push(`${prefix}[${refId}] ${role || tag}${nameStr}${attrStr}${styleStr}${uploadStr}`);
      }
    }
    const shadow = getShadowRoot(el);
    if (shadow) {
      const shadowPrefix = compact ? ">".repeat(d + 1) : `${prefix}  `;
      lines.push(`${shadowPrefix}shadow-root`);
      for (const child of Array.from(shadow.children)) {
        walk(child, d + 2);
      }
    }
    for (const child of Array.from(el.children)) {
      walk(child, isLandmark && selfVisible ? d + 1 : d);
    }
  }
  walk(root, depth);
  return lines.join(`
`);
}
var LANDMARK_ROLES, LANDMARK_TAGS;
var init_a11y_tree = __esm(() => {
  init_element_discovery();
  init_ref_registry();
  init_element_tree();
  LANDMARK_ROLES = new Set(["banner", "navigation", "main", "complementary", "contentinfo", "search", "form", "region"]);
  LANDMARK_TAGS = new Set(["NAV", "MAIN", "ASIDE", "HEADER", "FOOTER", "FORM", "SECTION"]);
});

// extension/src/content/element-discovery.ts
function getShadowRoot(el) {
  if (el.shadowRoot)
    return el.shadowRoot;
  try {
    if (typeof chrome !== "undefined" && chrome.dom?.openOrClosedShadowRoot) {
      return chrome.dom.openOrClosedShadowRoot(el);
    }
  } catch {}
  return null;
}
function walkWithShadow(root, callback) {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT);
  let node = walker.nextNode();
  while (node) {
    const el = node;
    callback(el);
    const shadow = getShadowRoot(el);
    if (shadow)
      walkWithShadow(shadow, callback);
    node = walker.nextNode();
  }
}
function isVisible(el, style = getComputedStyle(el)) {
  if (style.visibility === "hidden" || style.display === "none")
    return false;
  const pos = style.position;
  if (pos !== "fixed" && pos !== "sticky") {
    if (!el.offsetParent && el.tagName !== "BODY")
      return false;
  }
  const rect = el.getBoundingClientRect();
  if (rect.width === 0 && rect.height === 0)
    return false;
  return true;
}
function isInteractive(el, tags, roles, style = getComputedStyle(el)) {
  if (tags.has(el.tagName))
    return true;
  const role = el.getAttribute("role");
  if (role && roles.has(role))
    return true;
  if (el.hasAttribute("onclick"))
    return true;
  if (el.getAttribute("contenteditable") === "true")
    return true;
  if (el.hasAttribute("tabindex") && el.getAttribute("tabindex") !== "-1")
    return true;
  if (el.namespaceURI === "http://www.w3.org/2000/svg") {
    const svgTag = el.tagName.toLowerCase();
    if (svgTag === "a" && (el.hasAttribute("href") || el.getAttributeNS("http://www.w3.org/1999/xlink", "href")))
      return true;
    if (el.hasAttribute("onclick") || el.hasAttribute("tabindex"))
      return true;
    if (role && roles.has(role))
      return true;
    if (style.cursor === "pointer")
      return true;
  }
  if (style.cursor === "pointer" && el.tagName !== "BODY" && el.tagName !== "HTML") {
    const parent = el.parentElement;
    const parentCursor = parent ? getComputedStyle(parent).cursor : null;
    if (hasOwnPointerCursor(style.cursor, parentCursor))
      return true;
  }
  return false;
}
function getInteractiveElements() {
  selectorMap.clear();
  nextIndex = 0;
  pruneStaleRefs();
  const results = [];
  walkWithShadow(document.body, (el) => {
    const style = getComputedStyle(el);
    if (isInteractive(el, INTERACTIVE_TAGS, INTERACTIVE_ROLES, style) && isVisible(el, style)) {
      const idx = nextIndex++;
      const selector = buildSelector(el);
      selectorMap.set(idx, selector);
      const refId = getOrAssignRef(el);
      const tag = el.tagName.toLowerCase();
      const text = getAccessibleName(el);
      const attrs = getRelevantAttrs(el);
      refMetadata.set(refId, { role: getEffectiveRole(el, style), name: text, tag, value: (el.value || "").slice(0, 40) });
      results.push({ index: idx, refId, element: el, selector, tag, text, attrs });
    }
  });
  return results;
}
var selectorMap, nextIndex = 0, INTERACTIVE_TAGS, INTERACTIVE_ROLES;
var init_element_discovery = __esm(() => {
  init_ref_registry();
  init_a11y_tree();
  init_element_tree();
  selectorMap = new Map;
  INTERACTIVE_TAGS = new Set(["A", "BUTTON", "INPUT", "SELECT", "TEXTAREA", "DETAILS", "SUMMARY"]);
  INTERACTIVE_ROLES = new Set(["button", "link", "tab", "menuitem", "checkbox", "radio", "switch", "textbox", "combobox", "listbox", "option", "slider"]);
});

// extension/src/content/semantic-match.ts
function findBestMatch(name, role, text) {
  const query = (name || text || "").toLowerCase();
  const targetRole = (role || "").toLowerCase();
  const isTextPseudoRole = targetRole === "text";
  let best = null;
  for (const [refId, weakRef] of refRegistry) {
    const el = weakRef.deref();
    if (!el || !el.isConnected || !isVisible(el))
      continue;
    const elRole = getEffectiveRole(el).toLowerCase();
    const elName = getAccessibleName(el).toLowerCase();
    let score = 0;
    if (targetRole && !isTextPseudoRole && elRole !== targetRole)
      continue;
    if (targetRole && !isTextPseudoRole && elRole === targetRole)
      score += 50;
    if (query) {
      if (elName === query)
        score += 100;
      else if (elName.includes(query))
        score += 60;
      const id = el.getAttribute("id")?.toLowerCase();
      if (id?.includes(query))
        score += 50;
      const placeholder = el.getAttribute("placeholder")?.toLowerCase();
      if (placeholder?.includes(query))
        score += 40;
      if (isTextPseudoRole) {
        const elText = (el.textContent || "").trim().toLowerCase();
        if (elText === query)
          score += 80;
        else if (elText.includes(query))
          score += 50;
      }
    }
    if (score >= 30 && (!best || score > best.score)) {
      best = { refId, role: getEffectiveRole(el), name: getAccessibleName(el), score, element: el };
    }
  }
  return best;
}
var init_semantic_match = __esm(() => {
  init_ref_registry();
  init_element_discovery();
  init_a11y_tree();
});

// extension/src/content/ref-registry.ts
function getStaleWarning() {
  return staleWarning;
}
function clearStaleWarning() {
  staleWarning = null;
}
function getOrAssignRef(el) {
  const existing = elementToRef.get(el);
  if (existing) {
    const ref = refRegistry.get(existing);
    const live = ref?.deref();
    if (live === el)
      return existing;
    if (!live) {
      refRegistry.set(existing, new WeakRef(el));
      return existing;
    }
    refRegistry.set(existing, new WeakRef(el));
    return existing;
  }
  const refId = `e${refIdCounter.value++}`;
  refRegistry.set(refId, new WeakRef(el));
  elementToRef.set(el, refId);
  return refId;
}
function resolveRef(refId) {
  const ref = refRegistry.get(refId);
  if (ref) {
    const el = ref.deref();
    if (el && el.isConnected)
      return el;
  }
  const meta = refMetadata.get(refId);
  if (meta) {
    const match = findBestMatch(meta.name, meta.role);
    if (match && match.score >= 70) {
      staleWarning = `stale ref ${refId} re-resolved to ${match.refId} (${match.role} '${match.name}', score: ${match.score})`;
      return match.element;
    }
  }
  return null;
}
function pruneStaleRefs() {
  for (const [id, ref] of refRegistry) {
    const el = ref.deref();
    if (!el || !el.isConnected)
      refRegistry.delete(id);
  }
}
var g, refRegistry, elementToRef, refMetadata, refIdCounter, staleWarning = null;
var init_ref_registry = __esm(() => {
  init_semantic_match();
  g = globalThis;
  refRegistry = g.__interceptor_refRegistry ?? (g.__interceptor_refRegistry = new Map);
  elementToRef = g.__interceptor_elementToRef ?? (g.__interceptor_elementToRef = new WeakMap);
  refMetadata = g.__interceptor_refMetadata ?? (g.__interceptor_refMetadata = new Map);
  refIdCounter = g.__interceptor_nextRefId ?? (g.__interceptor_nextRefId = { value: 1 });
});

// extension/src/content/snapshot-diff.ts
var exports_snapshot_diff = {};
__export(exports_snapshot_diff, {
  lastSnapshot: () => lastSnapshot,
  computeSnapshotDiff: () => computeSnapshotDiff,
  cacheSnapshot: () => cacheSnapshot
});
function cacheSnapshot() {
  const entries = [];
  for (const [refId, weakRef] of refRegistry) {
    const el = weakRef.deref();
    if (!el || !el.isConnected)
      continue;
    entries.push({
      refId,
      role: getEffectiveRole(el),
      name: getAccessibleName(el),
      value: (el.value || "").slice(0, 40),
      states: getRelevantAttrs(el)
    });
  }
  lastSnapshot = entries;
}
function computeSnapshotDiff() {
  if (lastSnapshot.length === 0) {
    return { success: false, error: "no previous snapshot — run 'interceptor tree' first" };
  }
  const oldMap = new Map(lastSnapshot.map((e) => [e.refId, e]));
  const current = [];
  for (const [refId, weakRef] of refRegistry) {
    const el = weakRef.deref();
    if (!el || !el.isConnected)
      continue;
    current.push({
      refId,
      role: getEffectiveRole(el),
      name: getAccessibleName(el),
      value: (el.value || "").slice(0, 40),
      states: getRelevantAttrs(el)
    });
  }
  const newMap = new Map(current.map((e) => [e.refId, e]));
  const changes = [];
  for (const [id] of oldMap) {
    if (!newMap.has(id))
      changes.push(`- ${id} (removed)`);
  }
  for (const [id, cur] of newMap) {
    const old = oldMap.get(id);
    if (!old) {
      changes.push(`+ ${id} ${cur.role} "${cur.name}" (new)`);
    } else {
      if (old.value !== cur.value)
        changes.push(`~ ${id} value: "${old.value}" → "${cur.value}"`);
      if (old.states !== cur.states)
        changes.push(`~ ${id} states: ${old.states} → ${cur.states}`);
      if (old.name !== cur.name)
        changes.push(`~ ${id} name: "${old.name}" → "${cur.name}"`);
    }
  }
  lastSnapshot = current;
  return { success: true, data: changes.length ? changes.join(`
`) : "no changes" };
}
var lastSnapshot;
var init_snapshot_diff = __esm(() => {
  init_ref_registry();
  init_a11y_tree();
  init_element_tree();
  lastSnapshot = [];
});

// extension/src/content/input-simulation.ts
function resolveElement(indexOrRef, ref) {
  if (ref) {
    return resolveRef(ref);
  }
  if (indexOrRef === undefined)
    return null;
  const selector = selectorMap.get(indexOrRef);
  if (!selector)
    return null;
  const el = document.querySelector(selector);
  if (!el)
    return null;
  if (!isVisible(el))
    return null;
  return el;
}
function scrollIntoViewIfNeeded(el) {
  const rect = el.getBoundingClientRect();
  if (rect.top < 0 || rect.bottom > window.innerHeight) {
    el.scrollIntoView({ block: "center", behavior: "instant" });
  }
}
function dispatchClickSequence(el, atX, atY) {
  const rect = el.getBoundingClientRect();
  const x = atX !== undefined ? rect.left + atX : rect.left + rect.width / 2;
  const y = atY !== undefined ? rect.top + atY : rect.top + rect.height / 2;
  let acked = false;
  const onAck = () => {
    acked = true;
  };
  el.addEventListener("__interceptor_click_ack", onAck, true);
  try {
    el.dispatchEvent(new CustomEvent("__interceptor_click", { bubbles: true, detail: { x, y } }));
  } finally {
    el.removeEventListener("__interceptor_click_ack", onAck, true);
  }
  if (acked)
    return;
  const opts = { bubbles: true, cancelable: true, clientX: x, clientY: y, button: 0 };
  el.dispatchEvent(new PointerEvent("pointerover", opts));
  el.dispatchEvent(new MouseEvent("mouseover", opts));
  el.dispatchEvent(new PointerEvent("pointerdown", opts));
  el.dispatchEvent(new MouseEvent("mousedown", opts));
  if (el.focus)
    el.focus();
  el.dispatchEvent(new PointerEvent("pointerup", opts));
  el.dispatchEvent(new MouseEvent("mouseup", opts));
  el.dispatchEvent(new MouseEvent("click", opts));
}
function dispatchHoverSequence(el) {
  const rect = el.getBoundingClientRect();
  const x = rect.left + rect.width / 2;
  const y = rect.top + rect.height / 2;
  const opts = { bubbles: true, cancelable: true, clientX: x, clientY: y };
  el.dispatchEvent(new PointerEvent("pointerover", opts));
  el.dispatchEvent(new MouseEvent("mouseover", opts));
  el.dispatchEvent(new PointerEvent("pointermove", opts));
  el.dispatchEvent(new MouseEvent("mousemove", opts));
}
function getKeyCode(key) {
  if (KEY_CODES[key])
    return KEY_CODES[key];
  if (key.length === 1 && key >= "0" && key <= "9")
    return `Digit${key}`;
  if (key.length === 1 && /^[a-zA-Z]$/.test(key))
    return `Key${key.toUpperCase()}`;
  return KEY_CODES[key] || `Key${key.toUpperCase()}`;
}
function dispatchKeySequence(target, combo) {
  const parts = combo.split("+");
  const key = parts[parts.length - 1];
  const modifiers = {
    ctrlKey: parts.includes("Control"),
    shiftKey: parts.includes("Shift"),
    altKey: parts.includes("Alt"),
    metaKey: parts.includes("Meta")
  };
  const code = getKeyCode(key);
  const keyOpts = { key, code, bubbles: true, cancelable: true, ...modifiers };
  target.dispatchEvent(new KeyboardEvent("keydown", keyOpts));
  target.dispatchEvent(new KeyboardEvent("keypress", keyOpts));
  target.dispatchEvent(new KeyboardEvent("keyup", keyOpts));
}
function waitForMutation(timeoutMs) {
  return new Promise((resolve) => {
    let resolved = false;
    const observer = new MutationObserver(() => {
      if (!resolved) {
        resolved = true;
        observer.disconnect();
        resolve(true);
      }
    });
    observer.observe(document.body, { childList: true, subtree: true, attributes: true });
    setTimeout(() => {
      if (!resolved) {
        resolved = true;
        observer.disconnect();
        resolve(false);
      }
    }, timeoutMs);
  });
}
function waitForElement(selector, timeout) {
  return new Promise((resolve) => {
    const existing = document.querySelector(selector);
    if (existing) {
      resolve(existing);
      return;
    }
    const timer = setTimeout(() => {
      observer.disconnect();
      resolve(null);
    }, timeout);
    const observer = new MutationObserver(() => {
      const el = document.querySelector(selector);
      if (el) {
        clearTimeout(timer);
        observer.disconnect();
        resolve(el);
      }
    });
    observer.observe(document.body, { childList: true, subtree: true });
  });
}
function waitForDomStable(debounceMs = 200, timeoutMs = 5000) {
  return new Promise((resolve) => {
    const start = Date.now();
    let mutationCount = 0;
    let debounceTimer = null;
    const hardTimeout = setTimeout(() => {
      observer.disconnect();
      if (debounceTimer)
        clearTimeout(debounceTimer);
      resolve({ stable: false, elapsed: Date.now() - start, mutations: mutationCount });
    }, timeoutMs);
    const observer = new MutationObserver(() => {
      mutationCount++;
      if (debounceTimer)
        clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => {
        observer.disconnect();
        clearTimeout(hardTimeout);
        resolve({ stable: true, elapsed: Date.now() - start, mutations: mutationCount });
      }, debounceMs);
    });
    observer.observe(document.body, { childList: true, subtree: true, attributes: true });
    debounceTimer = setTimeout(() => {
      observer.disconnect();
      clearTimeout(hardTimeout);
      resolve({ stable: true, elapsed: Date.now() - start, mutations: mutationCount });
    }, debounceMs);
  });
}
var KEY_CODES;
var init_input_simulation = __esm(() => {
  init_ref_registry();
  init_element_discovery();
  init_element_discovery();
  KEY_CODES = {
    Enter: "Enter",
    Tab: "Tab",
    Escape: "Escape",
    Backspace: "Backspace",
    Space: "Space",
    Delete: "Delete",
    Home: "Home",
    End: "End",
    PageUp: "PageUp",
    PageDown: "PageDown",
    ArrowUp: "ArrowUp",
    ArrowDown: "ArrowDown",
    ArrowLeft: "ArrowLeft",
    ArrowRight: "ArrowRight",
    F1: "F1",
    F2: "F2",
    F3: "F3",
    F4: "F4",
    F5: "F5",
    F6: "F6",
    F7: "F7",
    F8: "F8",
    F9: "F9",
    F10: "F10",
    F11: "F11",
    F12: "F12"
  };
});

// extension/src/content/scene/ops.ts
var exports_ops = {};
__export(exports_ops, {
  scrollElementIntoView: () => scrollElementIntoView,
  parseTranslate: () => parseTranslate,
  parseScale: () => parseScale,
  parseDocCoord: () => parseDocCoord,
  isVisibleRect: () => isVisibleRect,
  focusIframeTextbox: () => focusIframeTextbox,
  findElementById: () => findElementById,
  findAncestorScale: () => findAncestorScale,
  dispatchKeysIn: () => dispatchKeysIn,
  dblclickElementCenter: () => dblclickElementCenter,
  clickElementCenter: () => clickElementCenter,
  clickAtViewport: () => clickAtViewport,
  boundingBox: () => boundingBox
});
function boundingBox(el) {
  const r = el.getBoundingClientRect();
  return {
    x: Math.round(r.left),
    y: Math.round(r.top),
    w: Math.round(r.width),
    h: Math.round(r.height),
    cx: Math.round(r.left + r.width / 2),
    cy: Math.round(r.top + r.height / 2)
  };
}
function isVisibleRect(r) {
  return r.w > 0 && r.h > 0;
}
function parseTranslate(transform) {
  if (!transform)
    return null;
  const m = transform.match(TRANSLATE_RE);
  if (!m)
    return null;
  return { x: parseFloat(m[1]), y: parseFloat(m[2]) };
}
function parseScale(transform) {
  if (!transform)
    return null;
  const m = transform.match(SCALE_RE);
  if (!m)
    return null;
  return parseFloat(m[1]);
}
function findAncestorScale(el) {
  let cur = el;
  for (let i = 0;i < 20 && cur; i++) {
    const s = parseScale(cur.style?.transform);
    if (s !== null)
      return s;
    cur = cur.parentElement;
  }
  return null;
}
function parseDocCoord(el) {
  const he = el;
  const t = parseTranslate(he.style?.transform);
  const w = parseFloat(he.style?.width || "");
  const h = parseFloat(he.style?.height || "");
  if (!t || isNaN(w) || isNaN(h))
    return null;
  return { x: t.x, y: t.y, w, h };
}
function scrollElementIntoView(el) {
  const r = el.getBoundingClientRect();
  if (r.top < 0 || r.bottom > window.innerHeight || r.left < 0 || r.right > window.innerWidth) {
    try {
      el.scrollIntoView({ block: "center", inline: "center", behavior: "instant" });
    } catch {}
  }
}
function clickElementCenter(el) {
  scrollElementIntoView(el);
  const r = boundingBox(el);
  clickAtViewport(r.cx, r.cy);
  return r;
}
function dblclickElementCenter(el) {
  scrollElementIntoView(el);
  const r = boundingBox(el);
  const rect = el.getBoundingClientRect();
  const opts = { bubbles: true, cancelable: true, clientX: r.cx, clientY: r.cy, button: 0 };
  dispatchClickSequence(el);
  el.dispatchEvent(new MouseEvent("dblclick", opts));
  return r;
}
function clickAtViewport(x, y) {
  const el = document.elementFromPoint(x, y);
  if (!el)
    return null;
  const opts = { bubbles: true, cancelable: true, clientX: x, clientY: y, button: 0 };
  try {
    el.dispatchEvent(new PointerEvent("pointerover", opts));
    el.dispatchEvent(new MouseEvent("mouseover", opts));
    el.dispatchEvent(new PointerEvent("pointerdown", opts));
    el.dispatchEvent(new MouseEvent("mousedown", opts));
    if (el.focus)
      el.focus();
    el.dispatchEvent(new PointerEvent("pointerup", opts));
    el.dispatchEvent(new MouseEvent("mouseup", opts));
    el.dispatchEvent(new MouseEvent("click", opts));
  } catch {}
  return el;
}
function focusIframeTextbox(iframe) {
  try {
    const doc = iframe.contentDocument;
    if (!doc)
      return null;
    const textbox = doc.querySelector("[role=textbox]") || doc.querySelector("[contenteditable]");
    if (!textbox)
      return null;
    try {
      iframe.focus();
    } catch {}
    try {
      textbox.focus();
    } catch {}
    return { doc, textbox };
  } catch {
    return null;
  }
}
function dispatchKeysIn(target, keys) {
  dispatchKeySequence(target, keys);
}
function findElementById(id) {
  try {
    const direct = document.getElementById(id);
    if (direct)
      return direct;
  } catch {}
  try {
    return document.querySelector(`#${CSS.escape(id)}`);
  } catch {
    return null;
  }
}
var TRANSLATE_RE, SCALE_RE;
var init_ops = __esm(() => {
  init_input_simulation();
  TRANSLATE_RE = /translate\(\s*(-?[\d.]+)(?:px)?\s*,\s*(-?[\d.]+)(?:px)?\s*\)/;
  SCALE_RE = /scale\(\s*([\d.]+)(?:\s*,\s*([\d.]+))?\s*\)/;
});

// extension/src/content/canvas-bridge.ts
var CANVAS_LOG_CAP = 1000;
var CANVAS_OBJECT_CAP = 500;
var canvasLogBuffer = [];
var canvasObjectBuffer = [];
var canvasMetaById = new Map;
var lastCanvasStatus = null;
function getCanvasBridgeStatus() {
  return lastCanvasStatus || {
    installed: false,
    logSize: 0,
    objectSize: 0,
    kindCounts: {}
  };
}
function canvasOrder() {
  return [...canvasMetaById.values()].sort((a, b) => {
    const left = typeof a.domIndex === "number" ? a.domIndex : Number.MAX_SAFE_INTEGER;
    const right = typeof b.domIndex === "number" ? b.domIndex : Number.MAX_SAFE_INTEGER;
    if (left !== right)
      return left - right;
    return String(a.canvasId || "").localeCompare(String(b.canvasId || ""));
  });
}
function resolveCanvasIdForIndex(canvasIndex) {
  if (canvasIndex === undefined)
    return;
  const ordered = canvasOrder();
  return String(ordered[canvasIndex]?.canvasId || "") || null;
}
function getCanvasBridgeLog(opts) {
  const kinds = (opts?.kinds || []).map((k) => String(k).trim()).filter(Boolean);
  const canvasId = resolveCanvasIdForIndex(opts?.canvasIndex);
  let entries = canvasLogBuffer.slice();
  if (canvasId === null)
    entries = [];
  else if (canvasId)
    entries = entries.filter((entry) => String(entry.canvasId || "") === canvasId);
  if (kinds.length > 0) {
    entries = entries.filter((entry) => kinds.includes(String(entry.kind || "").trim()));
  }
  return {
    installed: true,
    total: entries.length,
    kindCounts: summarizeKinds(entries),
    entries: entries.slice(-Math.max(1, opts?.limit || 100))
  };
}
function getCanvasBridgeObjects(opts) {
  const kind = String(opts?.kind || "").trim();
  const canvasId = resolveCanvasIdForIndex(opts?.canvasIndex);
  let objects = canvasObjectBuffer.slice();
  if (canvasId === null)
    objects = [];
  else if (canvasId)
    objects = objects.filter((entry) => String(entry.canvasId || "") === canvasId);
  if (kind) {
    objects = objects.filter((entry) => String(entry.kind || "").trim() === kind);
  }
  return {
    installed: true,
    total: objects.length,
    objects: objects.slice(-Math.max(1, opts?.limit || 100))
  };
}
function updateCanvasMeta(entry) {
  const detailMeta = entry.canvas && typeof entry.canvas === "object" ? entry.canvas : null;
  const canvasId = String(detailMeta?.canvasId || entry.canvasId || "").trim();
  if (!canvasId)
    return;
  const next = { ...canvasMetaById.get(canvasId) || {}, canvasId };
  if (detailMeta)
    Object.assign(next, detailMeta);
  if (typeof entry.domIndex === "number")
    next.domIndex = entry.domIndex;
  canvasMetaById.set(canvasId, next);
}
function pushBounded(arr, item, cap) {
  if (arr.length >= cap)
    arr.shift();
  arr.push(item);
}
function summarizeKinds(entries) {
  const out = {};
  for (const entry of entries) {
    const kind = String(entry.kind || "").trim();
    if (!kind)
      continue;
    out[kind] = (out[kind] || 0) + 1;
  }
  return out;
}
document.addEventListener("__interceptor_canvas_log", (e) => {
  try {
    const entry = e.detail;
    updateCanvasMeta(entry);
    pushBounded(canvasLogBuffer, entry, CANVAS_LOG_CAP);
    lastCanvasStatus = {
      installed: true,
      logSize: canvasLogBuffer.length,
      objectSize: canvasObjectBuffer.length,
      kindCounts: summarizeKinds(canvasLogBuffer)
    };
  } catch {}
});
document.addEventListener("__interceptor_canvas_object", (e) => {
  try {
    pushBounded(canvasObjectBuffer, e.detail, CANVAS_OBJECT_CAP);
    lastCanvasStatus = {
      installed: true,
      logSize: canvasLogBuffer.length,
      objectSize: canvasObjectBuffer.length,
      kindCounts: summarizeKinds(canvasLogBuffer)
    };
  } catch {}
});
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type === "get_canvas_bridge_status") {
    sendResponse({
      success: true,
      data: getCanvasBridgeStatus()
    });
    return true;
  }
  if (msg.type === "get_canvas_bridge_log") {
    sendResponse({
      success: true,
      data: getCanvasBridgeLog({
        kinds: Array.isArray(msg.kinds) ? msg.kinds : [],
        limit: msg.limit,
        canvasIndex: typeof msg.canvasIndex === "number" ? msg.canvasIndex : undefined
      })
    });
    return true;
  }
  if (msg.type === "get_canvas_bridge_objects") {
    sendResponse({
      success: true,
      data: getCanvasBridgeObjects({
        kind: msg.kind,
        limit: msg.limit,
        canvasIndex: typeof msg.canvasIndex === "number" ? msg.canvasIndex : undefined
      })
    });
    return true;
  }
});

// extension/src/content/dom-observer.ts
var domDirty = false;
function getDomDirty() {
  return domDirty;
}
function setDomDirty(v) {
  domDirty = v;
}
var domObserver = new MutationObserver(() => {
  domDirty = true;
});
if (document.body) {
  domObserver.observe(document.body, { childList: true, subtree: true });
}
window.addEventListener("beforeunload", () => {
  domObserver.disconnect();
});

// extension/src/content/sensitive.ts
var sensitiveElements = new WeakSet;
function markSensitive(el) {
  sensitiveElements.add(el);
}
function isSensitive(el) {
  return sensitiveElements.has(el);
}
var SECURE_MASK = "***SECURE***";

// extension/src/content/monitor.ts
init_ref_registry();
init_a11y_tree();
var armed = false;
var sessionId = "";
var seq = 0;
var recentUserActions = [];
var RECENT_CAP = 16;
var CAUSE_WINDOW_MS = 500;
var mutationBatch = null;
var mutationFlushTimer = null;
var MUTATION_DEBOUNCE_MS = 50;
var MUTATION_TARGET_CAP = 5;
var scrollLastEmit = 0;
var scrollAccX = 0;
var scrollAccY = 0;
var scrollFlushTimer = null;
var SCROLL_THROTTLE_MS = 100;
var mutationObserver = null;
var NET_BODY_PREVIEW_CAP_DEFAULT = 64 * 1024;
var netBodyCap = NET_BODY_PREVIEW_CAP_DEFAULT;
var persistBodiesAlways = false;
var attachedListeners = [];
function safe(fn, fallback) {
  try {
    return fn();
  } catch {
    return fallback;
  }
}
function emit(evt) {
  if (!armed)
    return;
  try {
    const full = {
      t: Date.now(),
      s: seq++,
      k: evt.k || "unknown",
      sid: sessionId,
      ...evt
    };
    chrome.runtime.sendMessage({ type: "mon_evt", obj: full }).catch(() => {});
  } catch {}
}
function pushUserAction(s, t) {
  recentUserActions.push({ s, t });
  if (recentUserActions.length > RECENT_CAP)
    recentUserActions.shift();
}
function findCause(eventT) {
  for (let i = recentUserActions.length - 1;i >= 0; i--) {
    const ua = recentUserActions[i];
    if (eventT - ua.t <= CAUSE_WINDOW_MS)
      return ua.s;
    if (eventT - ua.t > CAUSE_WINDOW_MS)
      return;
  }
  return;
}
function describeTarget(target) {
  if (!target || !(target instanceof Element))
    return {};
  const el = target;
  const out = {};
  out.ref = safe(() => getOrAssignRef(el), "");
  const role = safe(() => getEffectiveRole(el), "");
  if (role)
    out.r = role;
  const name = safe(() => getAccessibleName(el), "");
  if (name)
    out.n = name.slice(0, 80);
  const tag = safe(() => el.tagName.toLowerCase(), "");
  if (tag && !role)
    out.tg = tag;
  return out;
}
function isPasswordLike(el) {
  if (isSensitive(el))
    return true;
  if (!(el instanceof HTMLInputElement))
    return false;
  const type = (el.type || "").toLowerCase();
  if (type === "password")
    return true;
  const autocomplete = (el.autocomplete || "").toLowerCase();
  if (autocomplete.startsWith("cc-"))
    return true;
  const name = (el.name || "").toLowerCase();
  if (/card|cvv|cvc|credit/.test(name))
    return true;
  return false;
}
function maskedValue(el) {
  if (isSensitive(el))
    return SECURE_MASK;
  const len = (el.value || "").length;
  return `***${len}***`;
}
function truncate(s, max) {
  if (s.length <= max)
    return s;
  return s.slice(0, max) + "…";
}
function shouldPersistBody(contentType, body) {
  const ct = (contentType || "").toLowerCase();
  if (ct.includes("application/json"))
    return true;
  if (ct.includes("+json"))
    return true;
  if (ct.startsWith("text/"))
    return true;
  if (ct.includes("xml"))
    return true;
  if (ct.includes("javascript"))
    return true;
  if (!ct && /^[\[{]/.test(body.trim()))
    return true;
  return false;
}
function redactSensitiveText(text) {
  return text.replace(/("?(authorization|cookie|set-cookie|access[_-]?token|refresh[_-]?token|csrf|session(id)?|jwt)"?\s*[:=]\s*"?)([^"\s,&}]+)/gi, "$1[REDACTED]").replace(/\beyJ[A-Za-z0-9._-]{20,}\b/g, "[REDACTED_JWT]");
}
function buildBodyPreview(contentType, body) {
  if (!body)
    return null;
  if (!persistBodiesAlways && !shouldPersistBody(contentType, body))
    return null;
  const redacted = redactSensitiveText(body);
  const truncated = redacted.length > netBodyCap;
  const preview = truncated ? redacted.slice(0, netBodyCap) : redacted;
  return { preview, bytes: body.length, truncated };
}
function targetFromEvent(e) {
  try {
    const path = e.composedPath && e.composedPath() || [];
    if (path.length > 0)
      return path[0] ?? null;
  } catch {}
  return e.target;
}
function makeClickHandler(kind) {
  return (e) => {
    try {
      const me = e;
      const target = targetFromEvent(e);
      const info = describeTarget(target);
      const t = Date.now();
      const sSnapshot = seq;
      emit({
        k: kind,
        ...info,
        x: me.clientX,
        y: me.clientY,
        tr: me.isTrusted,
        ic: e.composed === true
      });
      pushUserAction(sSnapshot, t);
    } catch {}
  };
}
function handleInput(e) {
  try {
    const target = targetFromEvent(e);
    if (!(target instanceof Element))
      return;
    const info = describeTarget(target);
    let v = "";
    if (isSensitive(target)) {
      v = SECURE_MASK;
    } else if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) {
      if (target instanceof HTMLInputElement && isPasswordLike(target)) {
        v = maskedValue(target);
      } else {
        v = truncate(target.value || "", 120);
      }
    } else if (target.isContentEditable) {
      v = truncate(target.textContent || "", 120);
    }
    const t = Date.now();
    const sSnapshot = seq;
    emit({
      k: "input",
      ...info,
      v,
      tr: e.isTrusted
    });
    pushUserAction(sSnapshot, t);
  } catch {}
}
function handleChange(e) {
  try {
    const target = targetFromEvent(e);
    if (!(target instanceof Element))
      return;
    const info = describeTarget(target);
    let v = "";
    if (isSensitive(target)) {
      v = SECURE_MASK;
    } else if (target instanceof HTMLInputElement) {
      if (isPasswordLike(target)) {
        v = maskedValue(target);
      } else if (target.type === "checkbox" || target.type === "radio") {
        v = target.checked ? "true" : "false";
      } else {
        v = truncate(target.value || "", 120);
      }
    } else if (target instanceof HTMLSelectElement) {
      v = truncate(target.value || "", 120);
    } else if (target instanceof HTMLTextAreaElement) {
      v = truncate(target.value || "", 120);
    }
    const t = Date.now();
    const sSnapshot = seq;
    emit({
      k: "change",
      ...info,
      v,
      tr: e.isTrusted
    });
    pushUserAction(sSnapshot, t);
  } catch {}
}
function handleSubmit(e) {
  try {
    const target = targetFromEvent(e);
    const info = describeTarget(target);
    const t = Date.now();
    const sSnapshot = seq;
    emit({
      k: "submit",
      ...info,
      tr: e.isTrusted
    });
    pushUserAction(sSnapshot, t);
  } catch {}
}
function handleKeydown(e) {
  try {
    const ke = e;
    const parts = [];
    if (ke.ctrlKey)
      parts.push("Control");
    if (ke.shiftKey)
      parts.push("Shift");
    if (ke.altKey)
      parts.push("Alt");
    if (ke.metaKey)
      parts.push("Meta");
    parts.push(ke.key);
    const target = targetFromEvent(e);
    const info = describeTarget(target);
    const t = Date.now();
    const sSnapshot = seq;
    emit({
      k: "key",
      ...info,
      kc: parts.join("+"),
      tr: ke.isTrusted
    });
    if (ke.key === "Enter" || ke.key === "Tab" || ke.key === "Escape" || ke.key.startsWith("Arrow")) {
      pushUserAction(sSnapshot, t);
    }
  } catch {}
}
function handleFocusEvent(kind) {
  return (e) => {
    try {
      const target = targetFromEvent(e);
      const info = describeTarget(target);
      emit({
        k: kind,
        ...info,
        tr: e.isTrusted
      });
    } catch {}
  };
}
function handleCopyPaste(kind) {
  return (e) => {
    try {
      const target = targetFromEvent(e);
      const info = describeTarget(target);
      emit({
        k: kind,
        ...info,
        tr: e.isTrusted
      });
    } catch {}
  };
}
function flushScroll() {
  if (!armed)
    return;
  if (scrollAccX === 0 && scrollAccY === 0)
    return;
  emit({
    k: "scroll",
    sx: scrollAccX,
    sy: scrollAccY
  });
  scrollAccX = 0;
  scrollAccY = 0;
  scrollLastEmit = Date.now();
}
function handleScroll(_e) {
  try {
    const now = Date.now();
    scrollAccX = window.scrollX;
    scrollAccY = window.scrollY;
    if (now - scrollLastEmit >= SCROLL_THROTTLE_MS) {
      flushScroll();
    } else if (!scrollFlushTimer) {
      scrollFlushTimer = setTimeout(() => {
        scrollFlushTimer = null;
        flushScroll();
      }, SCROLL_THROTTLE_MS);
    }
  } catch {}
}
function ensureMutationBatch() {
  if (!mutationBatch) {
    mutationBatch = { add: 0, rem: 0, attr: 0, txt: 0, targets: new Set };
  }
  return mutationBatch;
}
function flushMutationBatch() {
  if (!armed)
    return;
  if (!mutationBatch)
    return;
  const batch = mutationBatch;
  mutationBatch = null;
  if (mutationFlushTimer) {
    clearTimeout(mutationFlushTimer);
    mutationFlushTimer = null;
  }
  const total = batch.add + batch.rem + batch.attr + batch.txt;
  if (total === 0)
    return;
  const now = Date.now();
  const cause = findCause(now);
  emit({
    k: "mut",
    c: total,
    add: batch.add,
    rem: batch.rem,
    attr: batch.attr,
    txt: batch.txt,
    tgts: Array.from(batch.targets).slice(0, MUTATION_TARGET_CAP),
    ...cause !== undefined ? { cause } : {}
  });
}
function scheduleMutationFlush() {
  if (mutationFlushTimer)
    return;
  mutationFlushTimer = setTimeout(() => {
    mutationFlushTimer = null;
    flushMutationBatch();
  }, MUTATION_DEBOUNCE_MS);
}
function onMutations(mutations) {
  if (!armed)
    return;
  try {
    const batch = ensureMutationBatch();
    for (const m of mutations) {
      if (m.type === "childList") {
        batch.add += m.addedNodes.length;
        batch.rem += m.removedNodes.length;
      } else if (m.type === "attributes") {
        batch.attr += 1;
      } else if (m.type === "characterData") {
        batch.txt += 1;
      }
      if (batch.targets.size < MUTATION_TARGET_CAP) {
        const t = m.target;
        if (t instanceof Element) {
          const ref = safe(() => getOrAssignRef(t), "");
          if (ref)
            batch.targets.add(ref);
        }
      }
    }
    scheduleMutationFlush();
  } catch {}
}
function onInterceptorNet(e) {
  if (!armed)
    return;
  try {
    const detail = e.detail;
    if (!detail)
      return;
    const bodyLen = typeof detail.body === "string" ? detail.body.length : 0;
    const now = Date.now();
    const cause = findCause(now);
    const contentType = truncate(detail.contentType || "", 120);
    const preview = persistBodiesAlways || cause !== undefined ? buildBodyPreview(detail.contentType || "", detail.body || "") : null;
    emit({
      k: detail.type === "xhr" ? "xhr" : "fetch",
      u: truncate(detail.url || "", 512),
      m: detail.method || "GET",
      st: detail.status,
      bz: bodyLen,
      ...contentType ? { ct: contentType } : {},
      ...preview ? { bp: preview.preview, bt: preview.bytes, trn: preview.truncated || detail.truncated === true } : {},
      ...cause !== undefined ? { cause } : {}
    });
  } catch {}
}
function onInterceptorSse(e) {
  if (!armed)
    return;
  try {
    const detail = e.detail;
    if (!detail)
      return;
    const chunkLen = typeof detail.chunk === "string" ? detail.chunk.length : 0;
    const now = Date.now();
    const cause = findCause(now);
    emit({
      k: "sse",
      u: truncate(detail.url || "", 512),
      bz: chunkLen,
      ...cause !== undefined ? { cause } : {}
    });
  } catch {}
}
function onInterceptorPageComm(e) {
  if (!armed)
    return;
  try {
    emitPageCommDetail(e.detail);
  } catch {}
}
function emitPageCommDetail(rawDetail) {
  if (!armed)
    return;
  const detail = rawDetail;
  if (!detail)
    return;
  const now = Date.now();
  const cause = findCause(now);
  const kind = detail.event || detail.type || "page_comm";
  const payloadPreview = typeof detail.payloadPreview === "string" ? truncate(detail.payloadPreview, netBodyCap) : undefined;
  emit({
    k: kind,
    ...detail.url ? { u: truncate(detail.url, 512) } : {},
    ...detail.method ? { m: detail.method } : {},
    ...detail.direction ? { dir: detail.direction } : {},
    ...detail.socketId ? { skt: detail.socketId } : {},
    ...detail.channelId ? { ch: detail.channelId } : {},
    ...detail.channelName ? { cn: truncate(detail.channelName, 160) } : {},
    ...detail.payloadKind ? { pk: detail.payloadKind } : {},
    ...payloadPreview !== undefined ? { bp: payloadPreview } : {},
    ...typeof detail.payloadBytes === "number" ? { bt: detail.payloadBytes } : {},
    ...detail.payloadEncoding ? { enc: detail.payloadEncoding } : {},
    ...detail.returnValue !== undefined ? { rv: detail.returnValue } : {},
    ...detail.truncated === true || payloadPreview && payloadPreview.length >= netBodyCap ? { trn: true } : {},
    ...typeof detail.code === "number" ? { code: detail.code } : {},
    ...detail.reason ? { reason: truncate(detail.reason, 240) } : {},
    ...typeof detail.wasClean === "boolean" ? { clean: detail.wasClean } : {},
    ...typeof detail.readyState === "number" ? { rs: detail.readyState } : {},
    ...detail.error ? { err: truncate(detail.error, 240) } : {},
    ...cause !== undefined ? { cause } : {},
    tr: false
  });
}
function drainBufferedPageComm(startedAt) {
  const pageCommSnapshot = globalThis.__interceptorPageCommSnapshot;
  if (typeof pageCommSnapshot !== "function")
    return;
  for (const entry of pageCommSnapshot()) {
    if (typeof entry.timestamp === "number" && entry.timestamp < startedAt)
      continue;
    emitPageCommDetail(entry);
  }
}
function attach(type, fn, opts) {
  document.addEventListener(type, fn, opts);
  attachedListeners.push({ type, fn, opts });
}
function arm(newSessionId, _startedAt, opts) {
  if (armed)
    return;
  armed = true;
  sessionId = newSessionId;
  seq = 0;
  recentUserActions.length = 0;
  mutationBatch = null;
  if (mutationFlushTimer) {
    clearTimeout(mutationFlushTimer);
    mutationFlushTimer = null;
  }
  scrollAccX = 0;
  scrollAccY = 0;
  scrollLastEmit = 0;
  persistBodiesAlways = Boolean(opts?.persistBodies);
  netBodyCap = typeof opts?.bodyCapBytes === "number" && opts.bodyCapBytes > 0 ? opts.bodyCapBytes : NET_BODY_PREVIEW_CAP_DEFAULT;
  const captureOpts = { capture: true, passive: true };
  attach("click", makeClickHandler("click"), captureOpts);
  attach("dblclick", makeClickHandler("dblclick"), captureOpts);
  attach("contextmenu", makeClickHandler("rclick"), captureOpts);
  attach("input", handleInput, captureOpts);
  attach("change", handleChange, captureOpts);
  attach("submit", handleSubmit, captureOpts);
  attach("keydown", handleKeydown, captureOpts);
  attach("focus", handleFocusEvent("focus"), captureOpts);
  attach("blur", handleFocusEvent("blur"), captureOpts);
  attach("copy", handleCopyPaste("copy"), captureOpts);
  attach("paste", handleCopyPaste("paste"), captureOpts);
  attach("scroll", handleScroll, captureOpts);
  document.addEventListener("__interceptor_net", onInterceptorNet);
  document.addEventListener("__interceptor_sse", onInterceptorSse);
  document.addEventListener("__interceptor_page_comm", onInterceptorPageComm);
  drainBufferedPageComm(_startedAt);
  mutationObserver = new MutationObserver(onMutations);
  if (document.documentElement) {
    mutationObserver.observe(document.documentElement, {
      childList: true,
      subtree: true,
      attributes: true,
      characterData: true
    });
  }
}
function disarm() {
  if (!armed)
    return { evt: 0, mut: 0, net: 0 };
  flushMutationBatch();
  flushScroll();
  for (const l of attachedListeners) {
    try {
      document.removeEventListener(l.type, l.fn, l.opts);
    } catch {}
  }
  attachedListeners.length = 0;
  try {
    document.removeEventListener("__interceptor_net", onInterceptorNet);
  } catch {}
  try {
    document.removeEventListener("__interceptor_sse", onInterceptorSse);
  } catch {}
  try {
    document.removeEventListener("__interceptor_page_comm", onInterceptorPageComm);
  } catch {}
  if (mutationObserver) {
    try {
      mutationObserver.disconnect();
    } catch {}
    mutationObserver = null;
  }
  if (mutationFlushTimer) {
    clearTimeout(mutationFlushTimer);
    mutationFlushTimer = null;
  }
  if (scrollFlushTimer) {
    clearTimeout(scrollFlushTimer);
    scrollFlushTimer = null;
  }
  const counts = { evt: seq, mut: 0, net: 0 };
  armed = false;
  sessionId = "";
  seq = 0;
  recentUserActions.length = 0;
  return counts;
}
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg || typeof msg !== "object")
    return;
  if (msg.type === "monitor_arm") {
    try {
      arm(msg.sessionId, msg.startedAt || Date.now(), {
        persistBodies: msg.persistBodies === true,
        bodyCapBytes: typeof msg.bodyCapBytes === "number" ? msg.bodyCapBytes : undefined
      });
      sendResponse({ success: true, armed: true });
    } catch (err) {
      sendResponse({ success: false, error: err.message });
    }
    return true;
  }
  if (msg.type === "monitor_disarm") {
    try {
      const counts = disarm();
      sendResponse({ success: true, counts });
    } catch (err) {
      sendResponse({ success: false, error: err.message });
    }
    return true;
  }
  if (msg.type === "monitor_ping") {
    sendResponse({ success: true, armed, sessionId });
    return true;
  }
});

// extension/src/content.ts
init_ref_registry();
init_snapshot_diff();
init_ref_registry();
init_a11y_tree();

// extension/src/content/state.ts
init_element_discovery();
init_element_tree();
init_ref_registry();
init_a11y_tree();
init_snapshot_diff();
function getPageState(full = false) {
  setDomDirty(false);
  const elements = getInteractiveElements();
  const tree = buildElementTree(elements);
  const scrollY = window.scrollY;
  const scrollHeight = document.documentElement.scrollHeight;
  const viewportHeight = window.innerHeight;
  const active = document.activeElement;
  let focusedStr = "none";
  if (active && active !== document.body && active !== document.documentElement) {
    const fRef = getOrAssignRef(active);
    const fRole = getEffectiveRole(active);
    const fName = getAccessibleName(active);
    focusedStr = `${fRef} ${fRole || active.tagName.toLowerCase()} "${fName}"`;
  }
  const state = {
    url: location.href,
    title: document.title,
    elementTree: tree,
    focused: focusedStr,
    scrollPosition: { y: scrollY, height: scrollHeight, viewportHeight },
    timestamp: Date.now()
  };
  if (full) {
    state.staticText = document.body.innerText.slice(0, 5000);
  }
  cacheSnapshot();
  return { success: true, data: state };
}

// extension/src/content.ts
init_input_simulation();

// extension/src/content/actions/click.ts
init_input_simulation();
init_ref_registry();
init_a11y_tree();
async function handleClick(action) {
  const el = resolveElement(action.index, action.ref);
  if (!el)
    return { success: false, error: `stale element [${action.index}] — run interceptor state to refresh` };
  scrollIntoViewIfNeeded(el);
  const mutation = waitForMutation(200);
  dispatchClickSequence(el, action.x, action.y);
  const clickMsg = `clicked [${action.ref || action.index}]${action.x !== undefined ? ` at (${action.x},${action.y})` : ""}`;
  const mutated = await mutation;
  if (!mutated) {
    return { success: true, data: clickMsg, warning: "no DOM change after click — if the site requires trusted events, try: interceptor click --trusted " + (action.ref || action.index) };
  }
  return { success: true, data: clickMsg };
}
async function handleClickSelector(action) {
  const selector = String(action.selector ?? "");
  if (!selector)
    return { success: false, error: "click_selector: no selector given" };
  let matches;
  try {
    matches = document.querySelectorAll(selector);
  } catch {
    return { success: false, error: `click_selector: invalid CSS selector ${JSON.stringify(selector)}` };
  }
  const nth = typeof action.nth === "number" ? action.nth : 0;
  const el = matches[nth];
  if (!el) {
    return {
      success: false,
      error: `click_selector: ${selector} matched ${matches.length} element(s); no index ${nth}`
    };
  }
  scrollIntoViewIfNeeded(el);
  const mutation = waitForMutation(200);
  dispatchClickSequence(el, action.x, action.y);
  const clickedRef = getOrAssignRef(el);
  const mutated = await mutation;
  const msg = `clicked ${clickedRef} — ${selector}[${nth}] of ${matches.length}`;
  if (!mutated) {
    return { success: true, data: msg, refId: clickedRef, warning: `no DOM change after click — if the site requires trusted events, try: interceptor click --trusted ${clickedRef}` };
  }
  return { success: true, data: msg, refId: clickedRef };
}
async function handleDblclick(action) {
  const el = resolveElement(action.index, action.ref);
  if (!el)
    return { success: false, error: `stale element [${action.index}] — run interceptor state to refresh` };
  scrollIntoViewIfNeeded(el);
  dispatchClickSequence(el, action.x, action.y);
  const rect = el.getBoundingClientRect();
  const cx = action.x !== undefined ? rect.left + action.x : rect.left + rect.width / 2;
  const cy = action.y !== undefined ? rect.top + action.y : rect.top + rect.height / 2;
  el.dispatchEvent(new MouseEvent("dblclick", { bubbles: true, cancelable: true, clientX: cx, clientY: cy }));
  return { success: true };
}
async function handleRightclick(action) {
  const el = resolveElement(action.index, action.ref);
  if (!el)
    return { success: false, error: `stale element [${action.index}] — run interceptor state to refresh` };
  scrollIntoViewIfNeeded(el);
  const rect = el.getBoundingClientRect();
  const x = action.x !== undefined ? rect.left + action.x : rect.left + rect.width / 2;
  const y = action.y !== undefined ? rect.top + action.y : rect.top + rect.height / 2;
  el.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: x, clientY: y, button: 2 }));
  return { success: true };
}
async function handleClickAt(action) {
  const cx = action.x;
  const cy = action.y;
  const targetEl = document.elementFromPoint(cx, cy);
  if (!targetEl)
    return { success: false, error: `no element at viewport coordinates (${cx}, ${cy})` };
  const opts = { bubbles: true, cancelable: true, clientX: cx, clientY: cy, button: 0 };
  targetEl.dispatchEvent(new PointerEvent("pointerover", opts));
  targetEl.dispatchEvent(new MouseEvent("mouseover", opts));
  targetEl.dispatchEvent(new PointerEvent("pointerdown", opts));
  targetEl.dispatchEvent(new MouseEvent("mousedown", opts));
  if (targetEl.focus)
    targetEl.focus();
  targetEl.dispatchEvent(new PointerEvent("pointerup", opts));
  targetEl.dispatchEvent(new MouseEvent("mouseup", opts));
  targetEl.dispatchEvent(new MouseEvent("click", opts));
  const targetRef = getOrAssignRef(targetEl);
  return { success: true, data: { clicked: targetRef, tag: targetEl.tagName.toLowerCase(), at: { x: cx, y: cy } } };
}
async function handleWhatAt(action) {
  const wx = action.x;
  const wy = action.y;
  const whatEl = document.elementFromPoint(wx, wy);
  if (!whatEl)
    return { success: true, data: { element: null, at: { x: wx, y: wy } } };
  const whatRef = getOrAssignRef(whatEl);
  const whatRect = whatEl.getBoundingClientRect();
  return {
    success: true,
    data: {
      ref: whatRef,
      tag: whatEl.tagName.toLowerCase(),
      role: getEffectiveRole(whatEl),
      name: getAccessibleName(whatEl),
      rect: { top: whatRect.top, left: whatRect.left, width: whatRect.width, height: whatRect.height }
    }
  };
}

// extension/src/content/actions/type.ts
init_input_simulation();
init_element_discovery();
init_ref_registry();
async function handleInputText(action) {
  const el = resolveElement(action.index, action.ref);
  if (!el)
    return { success: false, error: `stale element [${action.index}] — run interceptor state to refresh` };
  if (action.sensitive === true)
    markSensitive(el);
  el.focus();
  const text = action.text;
  const tag = el.tagName;
  const isContentEditable = el.getAttribute("contenteditable") === "true" || el.isContentEditable;
  const isStandardInput = tag === "INPUT" || tag === "TEXTAREA";
  if (isStandardInput) {
    const inputEl = el;
    if (action.clear) {
      inputEl.value = "";
      inputEl.dispatchEvent(new Event("input", { bubbles: true }));
    }
    const nativeInputValueSetter = Object.getOwnPropertyDescriptor(tag === "TEXTAREA" ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype, "value")?.set;
    if (nativeInputValueSetter) {
      nativeInputValueSetter.call(inputEl, (action.clear ? "" : inputEl.value) + text);
    } else {
      inputEl.value = (action.clear ? "" : inputEl.value) + text;
    }
    inputEl.dispatchEvent(new Event("input", { bubbles: true }));
    inputEl.dispatchEvent(new Event("change", { bubbles: true }));
    return { success: true, data: { typed: true, elementType: "input", method: "nativeSetter" } };
  }
  if (isContentEditable) {
    if (action.clear) {
      document.execCommand("selectAll", false);
      document.execCommand("delete", false);
    }
    document.execCommand("insertText", false, text);
    el.dispatchEvent(new Event("input", { bubbles: true }));
    return { success: true, data: { typed: true, elementType: "contenteditable", method: "execCommand" } };
  }
  const shadowRoot = getShadowRoot(el);
  if (shadowRoot) {
    const innerInput = shadowRoot.querySelector("input, textarea, [contenteditable='true']");
    if (innerInput) {
      return handleInputText({ type: "input_text", ref: getOrAssignRef(innerInput), text, clear: action.clear, sensitive: action.sensitive });
    }
  }
  const role = el.getAttribute("role");
  if (role === "textbox" || role === "combobox") {
    if (action.clear) {
      el.textContent = "";
    }
    el.textContent = (action.clear ? "" : el.textContent || "") + text;
    el.dispatchEvent(new Event("input", { bubbles: true }));
    return { success: true, data: { typed: true, elementType: `role=${role}`, method: "textContent" } };
  }
  return { success: false, error: `element is <${tag.toLowerCase()}${isContentEditable ? " contenteditable" : ""}> — unsupported input type` };
}
async function handleSelectOption(action) {
  const el = resolveElement(action.index, action.ref);
  if (!el)
    return { success: false, error: `stale element [${action.index}] — run interceptor state to refresh` };
  el.value = action.value;
  el.dispatchEvent(new Event("change", { bubbles: true }));
  return { success: true };
}
async function handleCheck(action) {
  const el = resolveElement(action.index, action.ref);
  if (!el)
    return { success: false, error: `stale element [${action.index}] — run interceptor state to refresh` };
  const target = action.checked !== undefined ? !!action.checked : !el.checked;
  if (el.checked !== target) {
    el.checked = target;
    el.dispatchEvent(new Event("change", { bubbles: true }));
    el.dispatchEvent(new Event("input", { bubbles: true }));
  }
  return { success: true, data: { checked: el.checked } };
}

// extension/src/content/actions/scroll.ts
init_input_simulation();
async function handleScroll2(action) {
  const dir = action.direction;
  const amount = action.amount || window.innerHeight * 0.8;
  switch (dir) {
    case "up":
      window.scrollBy(0, -amount);
      break;
    case "down":
      window.scrollBy(0, amount);
      break;
    case "top":
      window.scrollTo(0, 0);
      break;
    case "bottom":
      window.scrollTo(0, document.documentElement.scrollHeight);
      break;
  }
  return { success: true };
}
async function handleScrollAbsolute(action) {
  window.scrollTo(0, action.y);
  return { success: true };
}
async function handleScrollTo(action) {
  const el = resolveElement(action.index, action.ref);
  if (!el)
    return { success: false, error: `stale element [${action.index}] — run interceptor state to refresh` };
  el.scrollIntoView({ block: "center", behavior: "instant" });
  return { success: true };
}
async function handleGetPageDimensions(_action) {
  return {
    success: true,
    data: {
      scrollHeight: document.documentElement.scrollHeight,
      scrollWidth: document.documentElement.scrollWidth,
      viewportHeight: window.innerHeight,
      viewportWidth: window.innerWidth,
      scrollY: window.scrollY,
      scrollX: window.scrollX,
      devicePixelRatio: window.devicePixelRatio
    }
  };
}

// extension/src/content/actions/wait.ts
init_input_simulation();
async function handleWait(action) {
  await new Promise((r) => setTimeout(r, action.ms));
  return { success: true };
}
async function handleWaitFor(action) {
  const selector = action.selector;
  const timeout = action.timeout || 1e4;
  const el = await waitForElement(selector, timeout);
  return el ? { success: true, data: `found: ${selector}` } : { success: false, error: `timeout waiting for: ${selector}` };
}
async function handleWaitStable(action) {
  const debounceMs = action.ms || 200;
  const timeoutMs = action.timeout || 5000;
  const stableResult = await waitForDomStable(debounceMs, timeoutMs);
  return { success: true, data: stableResult };
}

// extension/src/content/actions/drag.ts
init_input_simulation();
async function handleDrag(action) {
  const el = resolveElement(action.index, action.ref);
  if (!el)
    return { success: false, error: `stale element [${action.index}] — run interceptor state to refresh` };
  scrollIntoViewIfNeeded(el);
  const dragRect = el.getBoundingClientRect();
  const fromX = dragRect.left + action.fromX;
  const fromY = dragRect.top + action.fromY;
  const toX = dragRect.left + action.toX;
  const toY = dragRect.top + action.toY;
  const steps = action.steps || 10;
  const duration = action.duration;
  const baseOpts = { bubbles: true, cancelable: true, button: 0 };
  el.dispatchEvent(new PointerEvent("pointerdown", { ...baseOpts, clientX: fromX, clientY: fromY }));
  el.dispatchEvent(new MouseEvent("mousedown", { ...baseOpts, clientX: fromX, clientY: fromY }));
  if (duration) {
    await new Promise((resolve) => {
      let step = 0;
      function tick() {
        step++;
        if (step > steps) {
          resolve();
          return;
        }
        const t = step / steps;
        const cx = fromX + (toX - fromX) * t;
        const cy = fromY + (toY - fromY) * t;
        const mx = (toX - fromX) / steps;
        const my = (toY - fromY) / steps;
        el.dispatchEvent(new PointerEvent("pointermove", { ...baseOpts, clientX: cx, clientY: cy, movementX: mx, movementY: my }));
        el.dispatchEvent(new MouseEvent("mousemove", { ...baseOpts, clientX: cx, clientY: cy, movementX: mx, movementY: my }));
        setTimeout(tick, duration / steps);
      }
      tick();
    });
  } else {
    for (let i = 1;i <= steps; i++) {
      const t = i / steps;
      const cx = fromX + (toX - fromX) * t;
      const cy = fromY + (toY - fromY) * t;
      const mx = (toX - fromX) / steps;
      const my = (toY - fromY) / steps;
      el.dispatchEvent(new PointerEvent("pointermove", { ...baseOpts, clientX: cx, clientY: cy, movementX: mx, movementY: my }));
      el.dispatchEvent(new MouseEvent("mousemove", { ...baseOpts, clientX: cx, clientY: cy, movementX: mx, movementY: my }));
    }
  }
  el.dispatchEvent(new PointerEvent("pointerup", { ...baseOpts, clientX: toX, clientY: toY }));
  el.dispatchEvent(new MouseEvent("mouseup", { ...baseOpts, clientX: toX, clientY: toY }));
  return { success: true, data: `dragged from (${action.fromX},${action.fromY}) to (${action.toX},${action.toY}) in ${steps} steps` };
}

// extension/src/content/actions/file.ts
init_input_simulation();
function base64ToBytes(b64) {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0;i < binary.length; i++)
    bytes[i] = binary.charCodeAt(i);
  return bytes;
}
function findFileInput(el) {
  if (el instanceof HTMLInputElement && el.type === "file")
    return el;
  const inner = el.querySelector?.('input[type="file"]');
  if (inner)
    return inner;
  let anc = el.parentElement;
  let hops = 0;
  while (anc && hops < 5) {
    if (anc instanceof HTMLInputElement && anc.type === "file")
      return anc;
    const found = anc.querySelector?.('input[type="file"]');
    if (found)
      return found;
    anc = anc.parentElement;
    hops++;
  }
  const all = Array.from(document.querySelectorAll('input[type="file"]'));
  if (all.length === 1)
    return all[0];
  return null;
}
function isolatedDrop(target, file) {
  const rect = target.getBoundingClientRect();
  const x = rect.left + rect.width / 2;
  const y = rect.top + rect.height / 2;
  const base = { bubbles: true, cancelable: true, composed: true, clientX: x, clientY: y };
  for (const type of ["dragenter", "dragover", "drop"]) {
    const dt = new DataTransfer;
    dt.items.add(file);
    target.dispatchEvent(new DragEvent(type, { ...base, dataTransfer: dt }));
  }
}
function bridgedDrop(target, bytes, name, type) {
  return new Promise((resolve) => {
    const rect = target.getBoundingClientRect();
    const x = rect.left + rect.width / 2;
    const y = rect.top + rect.height / 2;
    const blob = new Blob([bytes.buffer], { type: type || "application/octet-stream" });
    const blobUrl = URL.createObjectURL(blob);
    const id = "fd_" + Math.random().toString(36).slice(2) + Date.now().toString(36);
    let settled = false;
    const finish = (ok) => {
      if (settled)
        return;
      settled = true;
      target.removeEventListener("__interceptor_file_drop_ack", onAck, true);
      clearTimeout(timer);
      try {
        URL.revokeObjectURL(blobUrl);
      } catch {}
      resolve(ok);
    };
    const onAck = (e) => {
      const detail = e.detail;
      if (!detail || detail.id !== id)
        return;
      finish(detail.ok === true);
    };
    target.addEventListener("__interceptor_file_drop_ack", onAck, true);
    const timer = setTimeout(() => finish(false), 3000);
    target.dispatchEvent(new CustomEvent("__interceptor_file_drop", {
      bubbles: true,
      detail: { id, blobUrl, name, type, x, y }
    }));
  });
}
function anyInputHasFiles() {
  for (const inp of Array.from(document.querySelectorAll('input[type="file"]'))) {
    if (inp.files && inp.files.length > 0)
      return true;
  }
  return false;
}
function nameVisibleIn(scope, needle) {
  return (scope.textContent || "").toLowerCase().includes(needle);
}
function verifyUploaded(target, fileName, nameAlreadyPresent) {
  return new Promise((resolve) => {
    const started = Date.now();
    const needle = fileName.toLowerCase();
    const scope = target.closest("form") || document.body;
    const check = () => {
      if (anyInputHasFiles())
        return true;
      if (!nameAlreadyPresent && needle && nameVisibleIn(scope, needle))
        return true;
      return false;
    };
    const tick = () => {
      if (check())
        return resolve(true);
      if (Date.now() - started > 1500)
        return resolve(false);
      setTimeout(tick, 150);
    };
    tick();
  });
}
function stageForPicker(bytes, name, type) {
  const blob = new Blob([bytes.buffer], { type: type || "application/octet-stream" });
  const blobUrl = URL.createObjectURL(blob);
  document.dispatchEvent(new CustomEvent("__interceptor_stage_file", {
    detail: { blobUrl, name, type }
  }));
}
var chunkBuffers = new Map;
function handleFileUploadChunk(action) {
  const uploadId = String(action.uploadId || "");
  const seq2 = Number(action.seq);
  const total = Number(action.total);
  const chunk = typeof action.chunk === "string" ? action.chunk : "";
  if (!uploadId || !Number.isInteger(seq2) || !Number.isInteger(total) || total <= 0) {
    return { success: false, error: "file_upload_chunk: malformed chunk header" };
  }
  let buf = chunkBuffers.get(uploadId);
  if (!buf) {
    buf = { parts: new Array(total).fill(null), total };
    chunkBuffers.set(uploadId, buf);
  }
  if (seq2 < 0 || seq2 >= buf.total) {
    return { success: false, error: `file_upload_chunk: seq ${seq2} out of range 0..${buf.total - 1}` };
  }
  buf.parts[seq2] = chunk;
  const received = buf.parts.reduce((n, p) => n + (p !== null ? 1 : 0), 0);
  return { success: true, data: { buffered: received, of: buf.total } };
}
async function handleFileUpload(action) {
  let dataBase64;
  if (typeof action.dataBase64 === "string") {
    dataBase64 = action.dataBase64;
  } else if (typeof action.uploadId === "string") {
    const buf = chunkBuffers.get(action.uploadId);
    if (!buf)
      return { success: false, error: `file_upload: no buffered chunks for uploadId ${action.uploadId} — the tab may have reloaded mid-upload; retry` };
    if (buf.parts.some((p) => p === null))
      return { success: false, error: `file_upload: missing chunks for uploadId ${action.uploadId}` };
    dataBase64 = buf.parts.join("");
    chunkBuffers.delete(action.uploadId);
  } else {
    return { success: false, error: "file_upload: missing dataBase64" };
  }
  const el = resolveElement(action.index, action.ref);
  if (!el) {
    return { success: false, error: `stale element [${String(action.ref ?? action.index)}] — run interceptor state to refresh` };
  }
  const fileName = String(action.fileName || "file");
  const mimeType = String(action.mimeType || "application/octet-stream");
  let bytes;
  try {
    bytes = base64ToBytes(dataBase64);
  } catch (e) {
    return { success: false, error: `file_upload: invalid base64 (${e.message})` };
  }
  const file = new File([bytes.buffer], fileName, { type: mimeType });
  if (action.picker === true) {
    stageForPicker(bytes, fileName, mimeType);
    return {
      success: true,
      data: {
        method: "picker-staged",
        fileName,
        size: bytes.byteLength,
        verified: false,
        note: "file staged for the next window.showOpenFilePicker() — now click the element that opens the file picker"
      }
    };
  }
  const forceDropzone = action.dropzone === true;
  const fileInput = forceDropzone ? null : findFileInput(el);
  if (fileInput) {
    if (fileInput.disabled)
      return { success: false, error: "file_upload: <input type=file> is disabled" };
    const dt = new DataTransfer;
    dt.items.add(file);
    fileInput.files = dt.files;
    fileInput.dispatchEvent(new Event("input", { bubbles: true }));
    fileInput.dispatchEvent(new Event("change", { bubbles: true }));
    const verified2 = fileInput.files.length > 0;
    return {
      success: true,
      data: { method: "input", fileName, size: bytes.byteLength, verified: verified2, multiple: fileInput.multiple, accept: fileInput.accept || null }
    };
  }
  const target = el;
  const scope = target.closest("form") || document.body;
  const nameAlreadyPresent = nameVisibleIn(scope, fileName.toLowerCase());
  const bridged = await bridgedDrop(target, bytes, fileName, mimeType);
  if (!bridged)
    isolatedDrop(target, file);
  const method = bridged ? "dropzone-trusted" : "dropzone-isolated";
  const verified = await verifyUploaded(target, fileName, nameAlreadyPresent);
  return {
    success: true,
    data: {
      method,
      fileName,
      size: bytes.byteLength,
      verified,
      ...verified ? {} : { hint: "the page showed no sign of accepting the drop — the target may not be the dropzone, or it opens a native file picker (retry with --picker)" }
    }
  };
}

// extension/src/content/actions/hover.ts
init_input_simulation();
async function handleHover(action) {
  const el = resolveElement(action.index, action.ref);
  if (!el)
    return { success: false, error: `stale element [${action.index}] — run interceptor state to refresh` };
  const hoverFromX = action.fromX;
  const hoverFromY = action.fromY;
  if (hoverFromX !== undefined && hoverFromY !== undefined) {
    const rect = el.getBoundingClientRect();
    const targetX = rect.left + rect.width / 2;
    const targetY = rect.top + rect.height / 2;
    const hoverSteps = action.steps || 5;
    const baseOpts = { bubbles: true, cancelable: true };
    for (let i = 0;i <= hoverSteps; i++) {
      const t = i / hoverSteps;
      const cx = hoverFromX + (targetX - hoverFromX) * t;
      const cy = hoverFromY + (targetY - hoverFromY) * t;
      const mx = (targetX - hoverFromX) / hoverSteps;
      const my = (targetY - hoverFromY) / hoverSteps;
      el.dispatchEvent(new PointerEvent("pointermove", { ...baseOpts, clientX: cx, clientY: cy, movementX: mx, movementY: my }));
      el.dispatchEvent(new MouseEvent("mousemove", { ...baseOpts, clientX: cx, clientY: cy, movementX: mx, movementY: my }));
    }
    el.dispatchEvent(new PointerEvent("pointerover", { ...baseOpts, clientX: targetX, clientY: targetY }));
    el.dispatchEvent(new MouseEvent("mouseover", { ...baseOpts, clientX: targetX, clientY: targetY }));
  } else {
    dispatchHoverSequence(el);
  }
  return { success: true };
}

// extension/src/content/actions/focus.ts
init_input_simulation();
init_ref_registry();
init_a11y_tree();
async function handleFocus(action) {
  const el = resolveElement(action.index, action.ref);
  if (!el)
    return { success: false, error: `stale element [${action.index}] — run interceptor state to refresh` };
  el.focus();
  return { success: true };
}
async function handleBlur(_action) {
  document.activeElement?.blur();
  return { success: true };
}
async function handleGetFocus(_action) {
  const active = document.activeElement;
  if (!active || active === document.body || active === document.documentElement) {
    return { success: true, data: { focused: null } };
  }
  const focusRef = getOrAssignRef(active);
  const focusRole = getEffectiveRole(active);
  const focusName = getAccessibleName(active);
  const isEditable = active.tagName === "INPUT" || active.tagName === "TEXTAREA" || active.isContentEditable || active.getAttribute("role") === "textbox";
  return {
    success: true,
    data: {
      focused: {
        ref: focusRef,
        tag: active.tagName.toLowerCase(),
        role: focusRole,
        name: focusName,
        type: active.type || undefined,
        editable: isEditable
      }
    }
  };
}

// extension/src/content/data/extract.ts
init_input_simulation();

// extension/src/content/data/markdown-extract.ts
init_element_discovery();
var SKIP_TAGS = new Set(["SCRIPT", "STYLE", "NOSCRIPT", "TEMPLATE", "HEAD", "META", "LINK", "TITLE"]);
var BLOCK_TAGS = new Set(["P", "DIV", "SECTION", "ARTICLE", "HEADER", "FOOTER", "MAIN", "ASIDE", "NAV", "FORM", "FIELDSET", "DETAILS", "SUMMARY", "FIGURE", "FIGCAPTION", "ADDRESS", "DD", "DT", "DL"]);
function renderMarkdown(root) {
  const out = walkNode(root);
  return out.replace(/[ \t]+\n/g, `
`).replace(/\n{3,}/g, `

`).replace(/^\s+|\s+$/g, "");
}
function walkNode(node) {
  if (node.nodeType === Node.TEXT_NODE) {
    return (node.textContent || "").replace(/\s+/g, " ");
  }
  if (node.nodeType !== Node.ELEMENT_NODE)
    return "";
  const el = node;
  const tag = el.tagName;
  if (SKIP_TAGS.has(tag))
    return "";
  if (!isVisible(el) && tag !== "BODY")
    return "";
  switch (tag) {
    case "H1":
    case "H2":
    case "H3":
    case "H4":
    case "H5":
    case "H6": {
      const level = parseInt(tag[1]);
      const content = inlineChildren(el);
      return content ? `

${"#".repeat(level)} ${content}

` : "";
    }
    case "P": {
      const content = inlineChildren(el);
      return content ? `

${content}

` : "";
    }
    case "BR":
      return `
`;
    case "HR":
      return `

---

`;
    case "PRE":
      return renderPre(el);
    case "BLOCKQUOTE":
      return renderBlockquote(el);
    case "UL":
      return renderList(el, "ul", 0);
    case "OL":
      return renderList(el, "ol", 0);
    case "TABLE":
      return renderTable(el);
    case "STRONG":
    case "B": {
      const c = inlineChildren(el);
      return c ? `**${c}**` : "";
    }
    case "EM":
    case "I": {
      const c = inlineChildren(el);
      return c ? `*${c}*` : "";
    }
    case "CODE": {
      if (el.closest("pre"))
        return el.textContent || "";
      const c = (el.textContent || "").trim();
      return c ? `\`${c}\`` : "";
    }
    case "A": {
      const href = el.getAttribute("href") || "";
      const text = inlineChildren(el);
      if (!text)
        return "";
      if (!href || href.startsWith("javascript:") || href === "#" || href.startsWith("#"))
        return text;
      return `[${text}](${href})`;
    }
    case "IMG": {
      const alt = (el.getAttribute("alt") || "").trim();
      const src = el.getAttribute("src") || "";
      if (!alt && !src)
        return "";
      return `![${alt}](${src})`;
    }
  }
  let out = "";
  for (const child of el.childNodes)
    out += walkNode(child);
  if (BLOCK_TAGS.has(tag) && out.trim()) {
    if (!out.startsWith(`
`))
      out = `
` + out;
    if (!out.endsWith(`
`))
      out = out + `
`;
  }
  return out;
}
function inlineChildren(el) {
  let out = "";
  for (const child of el.childNodes)
    out += walkNode(child);
  return out.replace(/\s+/g, " ").trim();
}
function renderPre(el) {
  const code = (el.textContent || "").replace(/^\n+|\n+$/g, "");
  if (!code)
    return "";
  const codeEl = el.querySelector("code");
  const lang = codeEl?.className.match(/language-(\S+)/)?.[1] || "";
  return `

\`\`\`${lang}
${code}
\`\`\`

`;
}
function renderBlockquote(el) {
  let inner = "";
  for (const child of el.childNodes)
    inner += walkNode(child);
  inner = inner.replace(/\n{3,}/g, `

`).trim();
  if (!inner)
    return "";
  const quoted = inner.split(`
`).map((l) => l ? `> ${l}` : ">").join(`
`);
  return `

${quoted}

`;
}
function renderList(el, kind, indent) {
  const items = [];
  let idx = 1;
  for (const child of el.children) {
    const childTag = child.tagName;
    if (childTag !== "LI")
      continue;
    if (!isVisible(child))
      continue;
    const parts = renderListItem(child, kind, idx, indent);
    if (parts)
      items.push(parts);
    if (kind === "ol")
      idx++;
  }
  if (!items.length)
    return "";
  return `

${items.join(`
`)}

`;
}
function renderListItem(el, kind, index, indent) {
  const pad = "  ".repeat(indent);
  const bullet = kind === "ul" ? "-" : `${index}.`;
  let mainLine = "";
  const nested = [];
  for (const child of el.childNodes) {
    if (child.nodeType === Node.ELEMENT_NODE) {
      const c = child;
      if (c.tagName === "UL") {
        const sub = renderList(c, "ul", indent + 1).trim();
        if (sub)
          nested.push(sub);
        continue;
      }
      if (c.tagName === "OL") {
        const sub = renderList(c, "ol", indent + 1).trim();
        if (sub)
          nested.push(sub);
        continue;
      }
    }
    mainLine += walkNode(child);
  }
  mainLine = mainLine.replace(/\s+/g, " ").trim();
  if (!mainLine && !nested.length)
    return "";
  const head = `${pad}${bullet} ${mainLine}`.trimEnd();
  return nested.length ? `${head}
${nested.join(`
`)}` : head;
}
function renderTable(el) {
  const rows = Array.from(el.querySelectorAll("tr"));
  if (!rows.length)
    return "";
  const matrix = [];
  let headerIdx = -1;
  for (let i = 0;i < rows.length; i++) {
    const row = rows[i];
    if (!isVisible(row))
      continue;
    const cells = [];
    let hasTh = false;
    for (const cell of Array.from(row.children)) {
      if (cell.tagName !== "TH" && cell.tagName !== "TD")
        continue;
      if (cell.tagName === "TH")
        hasTh = true;
      const text = inlineChildren(cell).replace(/\|/g, "\\|").replace(/\n/g, " ");
      cells.push(text);
    }
    if (!cells.length)
      continue;
    matrix.push(cells);
    if (hasTh && headerIdx === -1)
      headerIdx = matrix.length - 1;
  }
  if (!matrix.length)
    return "";
  const width = Math.max(...matrix.map((r) => r.length));
  for (const r of matrix)
    while (r.length < width)
      r.push("");
  let header;
  let body;
  if (headerIdx === 0) {
    header = matrix[0];
    body = matrix.slice(1);
  } else {
    header = Array.from({ length: width }, (_, i) => `Col ${i + 1}`);
    body = matrix;
  }
  const sep = Array.from({ length: width }, () => "---");
  const lines = [
    `| ${header.join(" | ")} |`,
    `| ${sep.join(" | ")} |`,
    ...body.map((r) => `| ${r.join(" | ")} |`)
  ];
  return `

${lines.join(`
`)}

`;
}

// extension/src/content/data/extract.ts
var DEFAULT_TEXT_MAX_CHARS = 200000;
var DEFAULT_HTML_MAX_CHARS = 200000;
var ELEMENT_MAX_CHARS = 50000;
function withTruncationMarker(text, cap) {
  if (text.length <= cap)
    return text;
  const totalLen = text.length;
  return text.slice(0, cap) + `
... (truncated: showed ${cap} of ${totalLen} chars. To see more: scope with 'read e<ref> --text-only', search with 'find "<term>"', or pass 'maxChars=<n>' in raw action. Do NOT fetch ?action=raw or view-source — raw markup is harder to parse than rendered text.)`;
}
async function handleExtractText(action) {
  const maxChars = typeof action.maxChars === "number" && action.maxChars > 0 ? action.maxChars : DEFAULT_TEXT_MAX_CHARS;
  if (action.index !== undefined || action.ref !== undefined) {
    const el = resolveElement(action.index, action.ref);
    if (!el) {
      const label = String(action.ref ?? action.index ?? "unknown");
      return { success: false, error: `stale element [${label}] — run interceptor state to refresh` };
    }
    const raw = (el.textContent || "").trim();
    return { success: true, data: withTruncationMarker(raw, Math.min(maxChars, ELEMENT_MAX_CHARS)) };
  }
  return { success: true, data: withTruncationMarker(document.body.innerText, maxChars) };
}
async function handleExtractMarkdown(action) {
  const maxChars = typeof action.maxChars === "number" && action.maxChars > 0 ? action.maxChars : DEFAULT_TEXT_MAX_CHARS;
  if (action.index !== undefined || action.ref !== undefined) {
    const el = resolveElement(action.index, action.ref);
    if (!el) {
      const label = String(action.ref ?? action.index ?? "unknown");
      return { success: false, error: `stale element [${label}] — run interceptor state to refresh` };
    }
    return { success: true, data: withTruncationMarker(renderMarkdown(el), Math.min(maxChars, ELEMENT_MAX_CHARS)) };
  }
  return { success: true, data: withTruncationMarker(renderMarkdown(document.body), maxChars) };
}
async function handleExtractHtml(action) {
  const maxChars = typeof action.maxChars === "number" && action.maxChars > 0 ? action.maxChars : DEFAULT_HTML_MAX_CHARS;
  if (action.index !== undefined || action.ref !== undefined) {
    const el = resolveElement(action.index, action.ref);
    if (!el) {
      const label = String(action.ref ?? action.index ?? "unknown");
      return { success: false, error: `stale element [${label}] — run interceptor state to refresh` };
    }
    return { success: true, data: withTruncationMarker(el.outerHTML, Math.min(maxChars, ELEMENT_MAX_CHARS)) };
  }
  return { success: true, data: withTruncationMarker(document.documentElement.outerHTML, maxChars) };
}

// extension/src/content/data/query.ts
init_input_simulation();
init_ref_registry();
async function handleQuery(action) {
  const selector = action.selector;
  const els = document.querySelectorAll(selector);
  return {
    success: true,
    data: {
      count: els.length,
      elements: Array.from(els).slice(0, 20).map((el, i) => ({
        index: i,
        ref: getOrAssignRef(el),
        tag: el.tagName.toLowerCase(),
        text: (el.textContent || "").trim().slice(0, 80),
        id: el.id || undefined,
        classes: el.className || undefined
      }))
    }
  };
}
async function handleQueryOne(action) {
  const el = document.querySelector(action.selector);
  if (!el)
    return { success: false, error: `no element matching: ${action.selector}` };
  return {
    success: true,
    data: {
      tag: el.tagName.toLowerCase(),
      text: (el.textContent || "").trim().slice(0, 200),
      html: el.outerHTML.slice(0, 500),
      id: el.id || undefined,
      rect: el.getBoundingClientRect()
    }
  };
}
async function handleExists(action) {
  const el = document.querySelector(action.selector);
  return { success: true, data: !!el };
}
async function handleCount(action) {
  const els = document.querySelectorAll(action.selector);
  return { success: true, data: els.length };
}
async function handleTableData(action) {
  const table = action.index !== undefined ? resolveElement(action.index, action.ref) : document.querySelector(action.selector || "table");
  if (!table)
    return { success: false, error: "table not found" };
  const rows = [];
  table.querySelectorAll("tr").forEach((tr) => {
    const cells = [];
    tr.querySelectorAll("td, th").forEach((cell) => cells.push((cell.textContent || "").trim()));
    rows.push(cells);
  });
  return { success: true, data: rows };
}
async function handleAttrGet(action) {
  const el = resolveElement(action.index, action.ref) || document.querySelector(action.selector);
  if (!el)
    return { success: false, error: "element not found" };
  const name = action.name;
  return { success: true, data: el.getAttribute(name) };
}
async function handleAttrSet(action) {
  const el = resolveElement(action.index, action.ref) || document.querySelector(action.selector);
  if (!el)
    return { success: false, error: "element not found" };
  el.setAttribute(action.name, action.value);
  return { success: true };
}
async function handleStyleGet(action) {
  const el = resolveElement(action.index, action.ref) || document.querySelector(action.selector);
  if (!el)
    return { success: false, error: "element not found" };
  const computed = getComputedStyle(el);
  if (action.property) {
    return { success: true, data: computed.getPropertyValue(action.property) };
  }
  const props = ["display", "visibility", "color", "backgroundColor", "fontSize", "position", "width", "height", "margin", "padding"];
  const styles = {};
  for (const p of props)
    styles[p] = computed.getPropertyValue(p);
  return { success: true, data: styles };
}

// extension/src/content/data/forms.ts
async function handleForms(_action) {
  const forms = document.querySelectorAll("form");
  return {
    success: true,
    data: Array.from(forms).map((f, i) => ({
      index: i,
      action: f.action,
      method: f.method,
      id: f.id || undefined,
      fields: Array.from(f.elements).map((el) => ({
        tag: el.tagName.toLowerCase(),
        type: el.type,
        name: el.name,
        value: el.value?.slice(0, 40),
        placeholder: el.placeholder
      }))
    }))
  };
}
async function handleLinks(_action) {
  const links = document.querySelectorAll("a[href]");
  return {
    success: true,
    data: Array.from(links).slice(0, 100).map((a) => ({
      href: a.href,
      text: (a.textContent || "").trim().slice(0, 60)
    }))
  };
}
async function handleImages(_action) {
  const imgs = document.querySelectorAll("img");
  return {
    success: true,
    data: Array.from(imgs).slice(0, 50).map((img) => ({
      src: img.src,
      alt: img.alt,
      width: img.naturalWidth,
      height: img.naturalHeight
    }))
  };
}
async function handleMeta(_action) {
  const metas = document.querySelectorAll("meta");
  const data = {};
  metas.forEach((m) => {
    const key = m.getAttribute("name") || m.getAttribute("property") || m.getAttribute("http-equiv");
    const val = m.getAttribute("content");
    if (key && val)
      data[key] = val.slice(0, 200);
  });
  data["title"] = document.title;
  data["canonical"] = document.querySelector('link[rel="canonical"]')?.href || "";
  data["lang"] = document.documentElement.lang || "";
  return { success: true, data };
}
async function handlePageInfo(_action) {
  return {
    success: true,
    data: {
      url: location.href,
      title: document.title,
      readyState: document.readyState,
      doctype: document.doctype?.name,
      charset: document.characterSet,
      referrer: document.referrer,
      contentType: document.contentType,
      lastModified: document.lastModified,
      domain: document.domain,
      viewport: { width: window.innerWidth, height: window.innerHeight },
      scroll: { x: window.scrollX, y: window.scrollY, maxX: document.documentElement.scrollWidth, maxY: document.documentElement.scrollHeight }
    }
  };
}

// extension/src/content/data/storage.ts
async function handleStorageRead(action) {
  const storageType = action.storageType === "session" ? sessionStorage : localStorage;
  if (action.key) {
    return { success: true, data: storageType.getItem(action.key) };
  }
  const all = {};
  for (let i = 0;i < storageType.length; i++) {
    const key = storageType.key(i);
    all[key] = storageType.getItem(key).slice(0, 200);
  }
  return { success: true, data: all };
}
async function handleStorageWrite(action) {
  const storageType = action.storageType === "session" ? sessionStorage : localStorage;
  storageType.setItem(action.key, action.value);
  return { success: true };
}
async function handleStorageDelete(action) {
  const storageType = action.storageType === "session" ? sessionStorage : localStorage;
  storageType.removeItem(action.key);
  return { success: true };
}

// extension/src/content/data/clipboard.ts
init_input_simulation();
async function handleClipboardRead(_action) {
  const text = await navigator.clipboard.readText();
  return { success: true, data: text };
}
async function handleClipboardWrite(action) {
  await navigator.clipboard.writeText(action.text);
  return { success: true };
}
async function handleSelectionGet(_action) {
  const sel = window.getSelection();
  return { success: true, data: sel?.toString() || "" };
}
async function handleSelectionSet(action) {
  const el = resolveElement(action.index, action.ref);
  if (!el)
    return { success: false, error: `stale element [${action.index}] — run interceptor state to refresh` };
  el.setSelectionRange(action.start, action.end);
  return { success: true };
}

// extension/src/content/inspection/rect.ts
init_input_simulation();
init_element_discovery();
init_a11y_tree();
async function handleRect(action) {
  const el = resolveElement(action.index, action.ref) || document.querySelector(action.selector);
  if (!el)
    return { success: false, error: "element not found" };
  const r = el.getBoundingClientRect();
  return { success: true, data: { top: r.top, left: r.left, width: r.width, height: r.height, bottom: r.bottom, right: r.right } };
}
async function handleRegions(_action) {
  const regionElements = getInteractiveElements();
  const regions = regionElements.map((e) => {
    const rect = e.element.getBoundingClientRect();
    return {
      ref: e.refId,
      role: getEffectiveRole(e.element) || e.tag,
      name: e.text,
      x: Math.round(rect.left),
      y: Math.round(rect.top),
      w: Math.round(rect.width),
      h: Math.round(rect.height)
    };
  });
  regions.sort((a, b) => a.y === b.y ? a.x - b.x : a.y - b.y);
  return { success: true, data: regions };
}

// extension/src/content/inspection/modals.ts
init_element_discovery();
init_ref_registry();
init_a11y_tree();
async function handleModals(_action) {
  const modals = [];
  const dialogEls = document.querySelectorAll('dialog[open], [role="dialog"], [aria-modal="true"]');
  dialogEls.forEach((el) => {
    if (!isVisible(el))
      return;
    const ref = getOrAssignRef(el);
    const rect = el.getBoundingClientRect();
    const interactiveChildren = el.querySelectorAll('a, button, input, select, textarea, [role="button"], [role="link"], [role="textbox"]').length;
    modals.push({
      ref,
      role: getEffectiveRole(el) || "dialog",
      name: getAccessibleName(el),
      rect: { top: rect.top, left: rect.left, width: rect.width, height: rect.height },
      children: interactiveChildren
    });
  });
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const overlays = document.querySelectorAll("*");
  overlays.forEach((el) => {
    if (el.matches('dialog[open], [role="dialog"], [aria-modal="true"]'))
      return;
    const style = getComputedStyle(el);
    if (style.position !== "fixed" && style.position !== "absolute")
      return;
    const z = parseInt(style.zIndex);
    if (isNaN(z) || z < 100)
      return;
    const rect = el.getBoundingClientRect();
    if (rect.width * rect.height > vw * vh * 0.25) {
      const ref = getOrAssignRef(el);
      modals.push({
        ref,
        role: "overlay",
        name: getAccessibleName(el) || el.tagName.toLowerCase(),
        rect: { top: rect.top, left: rect.left, width: rect.width, height: rect.height },
        children: el.querySelectorAll("a, button, input, select, textarea").length
      });
    }
  });
  return { success: true, data: { modals } };
}
async function handlePanels(_action) {
  const panels = [];
  const expandedEls = document.querySelectorAll('[aria-expanded="true"]');
  expandedEls.forEach((el) => {
    if (!isVisible(el))
      return;
    const ref = getOrAssignRef(el);
    const controls = el.getAttribute("aria-controls");
    let contentRef;
    if (controls) {
      const controlledEl = document.getElementById(controls);
      if (controlledEl)
        contentRef = getOrAssignRef(controlledEl);
    }
    panels.push({
      ref,
      role: getEffectiveRole(el) || el.tagName.toLowerCase(),
      name: getAccessibleName(el),
      expanded: true,
      contentRef
    });
  });
  return { success: true, data: { panels } };
}

// extension/src/content/find.ts
init_semantic_match();
init_ref_registry();
init_element_discovery();
init_a11y_tree();
init_input_simulation();
function findRenderedText(renderedText, rawQuery, limit = 10, contextChars = 80) {
  const query = rawQuery.trim();
  const boundedLimit = Number.isFinite(limit) ? Math.max(0, Math.floor(limit)) : 10;
  const matches = [];
  let total = 0;
  if (query.length > 0) {
    const haystack = renderedText.toLowerCase();
    const needle = query.toLowerCase();
    let from = 0;
    while (from <= haystack.length - needle.length) {
      const start = haystack.indexOf(needle, from);
      if (start === -1)
        break;
      const end = start + query.length;
      total++;
      if (matches.length < boundedLimit) {
        const snippetStart = Math.max(0, start - contextChars);
        const snippetEnd = Math.min(renderedText.length, end + contextChars);
        const prefix = snippetStart > 0 ? "…" : "";
        const suffix = snippetEnd < renderedText.length ? "…" : "";
        matches.push({
          start,
          end,
          matchedText: renderedText.slice(start, end),
          snippet: `${prefix}${renderedText.slice(snippetStart, snippetEnd).replace(/\s+/g, " ").trim()}${suffix}`
        });
      }
      from = end;
    }
  }
  return {
    total,
    returned: matches.length,
    truncated: total > matches.length,
    scannedCharacters: renderedText.length,
    scanTruncated: false,
    matches
  };
}
function findAccessibleElements(rawQuery, rawRole, limit = 10) {
  const query = rawQuery.trim().toLowerCase();
  const targetRole = rawRole.trim().toLowerCase();
  const boundedLimit = Number.isFinite(limit) ? Math.max(0, Math.floor(limit)) : 10;
  const results = [];
  for (const [refId, weakRef] of refRegistry) {
    const el = weakRef.deref();
    if (!el || !el.isConnected || !isVisible(el))
      continue;
    const effectiveRole = getEffectiveRole(el);
    const accessibleName = getAccessibleName(el);
    const role = effectiveRole.toLowerCase();
    const name = accessibleName.toLowerCase();
    let score = 0;
    if (targetRole && role !== targetRole)
      continue;
    if (targetRole && role === targetRole)
      score += 50;
    if (query) {
      if (name === query)
        score += 100;
      else if (name.includes(query))
        score += 60;
      const id = el.getAttribute("id")?.toLowerCase();
      if (id?.includes(query))
        score += 50;
      const placeholder = el.getAttribute("placeholder")?.toLowerCase();
      if (placeholder?.includes(query))
        score += 40;
      const value = (el.value || "").toLowerCase();
      if (value.includes(query))
        score += 30;
    }
    if (score > 0)
      results.push({ refId, role: effectiveRole, name: accessibleName, score });
  }
  results.sort((a, b) => b.score - a.score);
  const matches = results.slice(0, boundedLimit);
  return { total: results.length, returned: matches.length, truncated: results.length > matches.length, matches };
}
async function handleFindElement(action) {
  const query = String(action.query || "").trim();
  if (!query)
    return { success: false, error: "find requires a non-empty query" };
  const role = String(action.role || "");
  const limit = typeof action.limit === "number" ? action.limit : 10;
  const requestedMode = action.mode === "text" || action.mode === "elements" ? action.mode : "hybrid";
  const mode = role ? "elements" : requestedMode;
  const data = { query, mode };
  if (mode !== "elements") {
    data.text = findRenderedText(document.body?.innerText || "", query, limit);
  }
  if (mode !== "text") {
    data.elements = findAccessibleElements(query, role, limit);
  }
  return { success: true, data };
}
async function handleSemanticResolve(action) {
  const match = findBestMatch(action.name, action.role);
  if (!match)
    return { success: false, error: `no element matching ${action.role}:${action.name}` };
  return { success: true, data: { ref: match.refId, role: match.role, name: match.name, score: match.score } };
}
async function handleFindAndClick(action) {
  const match = findBestMatch(action.name, action.role, action.text);
  if (!match)
    return { success: false, error: "no matching element found (score < 30)" };
  scrollIntoViewIfNeeded(match.element);
  dispatchClickSequence(match.element, action.x, action.y);
  return { success: true, data: { matched: { ref: match.refId, role: match.role, name: match.name, score: match.score }, actionResult: `clicked [${match.refId}]` } };
}
async function handleFindAndType(action) {
  const match = findBestMatch(action.name, action.role, action.text);
  if (!match)
    return { success: false, error: "no matching element found (score < 30)" };
  const typeResult = await handleInputText({ type: "input_text", ref: match.refId, text: action.inputText, clear: action.clear, sensitive: action.sensitive });
  return { success: true, data: { matched: { ref: match.refId, role: match.role, name: match.name, score: match.score }, actionResult: typeResult } };
}
async function handleFindAndCheck(action) {
  const match = findBestMatch(action.name, action.role, action.text);
  if (!match)
    return { success: false, error: "no matching element found (score < 30)" };
  const checkResult = await handleCheck({ type: "check", ref: match.refId, checked: action.checked });
  return { success: true, data: { matched: { ref: match.refId, role: match.role, name: match.name, score: match.score }, actionResult: checkResult } };
}

// extension/src/content/scene/adaptive.ts
init_a11y_tree();
init_element_discovery();
init_ops();
var sceneRefRegistry = new Map;
var sceneElementToId = new WeakMap;
var sceneRefMeta = new Map;
var nextSceneId = 1;
var cachedDiscovery = null;
function discoveryCacheKey() {
  const structuralCount = document.querySelectorAll('[data-page-id], [role="application"], [role="document"], [role="main"], [contenteditable="true"], canvas, svg').length;
  const active = document.activeElement;
  const activeSig = active ? [active.tagName, active.getAttribute("role") || "", active.getAttribute("aria-label") || "", active.getAttribute("data-hidden-input") || ""].join("|") : "none";
  return [location.href, structuralCount, activeSig].join("::");
}
function isHtmlElement(el) {
  return !!el && el instanceof HTMLElement;
}
function normalizeRect(rect) {
  return `${Math.round(rect.x)}:${Math.round(rect.y)}:${Math.round(rect.w)}:${Math.round(rect.h)}`;
}
function candidateArea(rect) {
  return Math.max(0, rect.w) * Math.max(0, rect.h);
}
function isLikelyWritable(el) {
  if (!isHtmlElement(el))
    return false;
  if (el.tagName === "INPUT" || el.tagName === "TEXTAREA")
    return true;
  if (el.isContentEditable || el.getAttribute("contenteditable") === "true")
    return true;
  const role = el.getAttribute("role");
  return role === "textbox" || role === "searchbox" || role === "combobox" || role === "application";
}
function isHiddenProxyInput(el) {
  if (!isHtmlElement(el) || el.tagName !== "INPUT")
    return false;
  const hiddenAttr = el.getAttribute("data-hidden-input");
  const inputMode = el.getAttribute("inputmode");
  const role = el.getAttribute("role");
  return hiddenAttr === "true" || role === "application" && inputMode === "none";
}
function readElementText(el) {
  if (!isHtmlElement(el))
    return "";
  if (el.tagName === "INPUT" || el.tagName === "TEXTAREA") {
    return (el.value || "").toString();
  }
  if (el.isContentEditable || el.getAttribute("contenteditable") === "true") {
    return (el.textContent || "").toString();
  }
  const role = el.getAttribute("role");
  if (role === "textbox" || role === "combobox" || role === "searchbox") {
    return (el.textContent || "").toString();
  }
  return (getAccessibleName(el) || el.getAttribute("aria-label") || el.textContent || "").toString();
}
function visibleOrActive(el) {
  return isVisible(el) || document.activeElement === el;
}
function candidateLabel(el) {
  const text = readElementText(el).trim();
  if (text)
    return text.slice(0, 80);
  const aria = el.getAttribute("aria-label") || getAccessibleName(el);
  return aria ? aria.slice(0, 80) : undefined;
}
function isPageLikeSurface(el, rect) {
  const area = candidateArea(rect);
  const viewportArea = window.innerWidth * window.innerHeight;
  if (el.hasAttribute("data-page-id"))
    return true;
  if (!isHtmlElement(el))
    return false;
  const inlineStyle = el.getAttribute("style") || "";
  const centered = rect.cx >= window.innerWidth * 0.15 && rect.cx <= window.innerWidth * 0.85;
  if (!centered)
    return false;
  if (area >= viewportArea * 0.12 && (inlineStyle.includes("transform") || inlineStyle.includes("touch-action")))
    return true;
  return false;
}
function maybeClassifyCandidate(el) {
  const rect = boundingBox(el);
  if (rect.w < 2 || rect.h < 2)
    return null;
  if (!visibleOrActive(el))
    return null;
  const tag = el.tagName.toLowerCase();
  const role = getEffectiveRole(el);
  const area = candidateArea(rect);
  const viewportArea = Math.max(1, window.innerWidth * window.innerHeight);
  if (el.hasAttribute("data-page-id")) {
    return {
      el,
      type: "page",
      strategy: "page-container",
      text: candidateLabel(el),
      extras: { pageId: el.getAttribute("data-page-id") || undefined }
    };
  }
  if (tag === "canvas" && area >= viewportArea * 0.08) {
    return { el, type: "page", strategy: "graphic-surface", text: candidateLabel(el) };
  }
  if (tag === "svg" && area >= viewportArea * 0.02) {
    return {
      el,
      type: area >= viewportArea * 0.12 ? "page" : "shape",
      strategy: "graphic-surface",
      text: candidateLabel(el)
    };
  }
  if (role === "application" || role === "document" || role === "main") {
    const hiddenProxy = isHiddenProxyInput(el);
    if (hiddenProxy || area >= viewportArea * 0.04 || document.activeElement === el) {
      return {
        el,
        type: role === "main" || role === "document" ? "page" : "group",
        strategy: hiddenProxy ? "focus-proxy" : "semantic-root",
        text: candidateLabel(el),
        extras: { hiddenProxy }
      };
    }
  }
  if (isLikelyWritable(el)) {
    return {
      el,
      type: "text",
      strategy: isHiddenProxyInput(el) ? "focus-proxy" : "writable-surface",
      text: candidateLabel(el),
      extras: {
        writable: true,
        hiddenProxy: isHiddenProxyInput(el),
        focused: document.activeElement === el
      }
    };
  }
  if (isPageLikeSurface(el, rect)) {
    return {
      el,
      type: "page",
      strategy: "structural-surface",
      text: candidateLabel(el)
    };
  }
  return null;
}
function elementSignature(el) {
  const rect = boundingBox(el);
  const pageId = el.getAttribute("data-page-id") || "";
  const role = el.getAttribute("role") || "";
  const aria = (el.getAttribute("aria-label") || getAccessibleName(el) || "").slice(0, 60);
  return [
    el.tagName.toLowerCase(),
    role,
    pageId,
    aria,
    normalizeRect(rect)
  ].join("|");
}
function getOrAssignSceneId(el, type, strategy) {
  const existing = sceneElementToId.get(el);
  if (existing) {
    const ref = sceneRefRegistry.get(existing);
    if (ref?.deref() === el)
      return existing;
  }
  const id = `s${nextSceneId++}`;
  sceneRefRegistry.set(id, new WeakRef(el));
  sceneElementToId.set(el, id);
  sceneRefMeta.set(id, { signature: elementSignature(el), type, strategy });
  return id;
}
function resolveSceneId(id) {
  const ref = sceneRefRegistry.get(id);
  if (ref) {
    const el = ref.deref();
    if (el && el.isConnected)
      return el;
  }
  const meta = sceneRefMeta.get(id);
  if (!meta)
    return null;
  let found = null;
  walkWithShadow(document.body, (el) => {
    if (found || !visibleOrActive(el))
      return;
    if (elementSignature(el) === meta.signature)
      found = el;
  });
  if (found) {
    sceneRefRegistry.set(id, new WeakRef(found));
    sceneElementToId.set(found, id);
  }
  return found;
}
function discoverAdaptiveSceneObjects(opts) {
  const cacheKey = discoveryCacheKey();
  if (cachedDiscovery && cachedDiscovery.key === cacheKey && Date.now() - cachedDiscovery.generatedAt < 1000) {
    return opts?.type ? cachedDiscovery.objects.filter((o) => o.type === opts.type) : cachedDiscovery.objects;
  }
  const out = [];
  const seen = new Set;
  walkWithShadow(document.body, (el) => {
    const candidate = maybeClassifyCandidate(el);
    if (!candidate)
      return;
    if (opts?.type && opts.type !== candidate.type)
      return;
    const rect = boundingBox(candidate.el);
    const key = `${candidate.type}:${candidate.strategy}:${normalizeRect(rect)}`;
    if (seen.has(key))
      return;
    seen.add(key);
    const id = getOrAssignSceneId(candidate.el, candidate.type, candidate.strategy);
    out.push({
      id,
      type: candidate.type,
      rect,
      text: candidate.text,
      extras: {
        ...candidate.extras || {},
        strategy: candidate.strategy,
        profile: opts?.profileName || "generic"
      }
    });
  });
  const sorted = out.sort((a, b) => {
    const areaDiff = candidateArea(b.rect) - candidateArea(a.rect);
    if (areaDiff !== 0)
      return areaDiff;
    return a.id.localeCompare(b.id);
  });
  cachedDiscovery = {
    key: cacheKey,
    generatedAt: Date.now(),
    objects: sorted
  };
  return opts?.type ? sorted.filter((o) => o.type === opts.type) : sorted;
}
function resolveAdaptiveSceneTarget(id) {
  const el = resolveSceneId(id);
  if (!el)
    return null;
  return {
    id,
    element: el,
    rect: boundingBox(el),
    text: candidateLabel(el),
    extras: {
      role: getEffectiveRole(el),
      hiddenProxy: isHiddenProxyInput(el),
      writable: isLikelyWritable(el)
    }
  };
}
function hitTestAdaptiveScene(x, y) {
  const list = discoverAdaptiveSceneObjects({ profileName: "generic" });
  let best = null;
  let bestArea = Infinity;
  for (const item of list) {
    if (x >= item.rect.x && x <= item.rect.x + item.rect.w && y >= item.rect.y && y <= item.rect.y + item.rect.h) {
      const area = candidateArea(item.rect);
      if (area < bestArea) {
        bestArea = area;
        best = item;
      }
    }
  }
  if (best)
    return best;
  const el = document.elementFromPoint(x, y);
  const candidate = el ? maybeClassifyCandidate(el) : null;
  if (!candidate)
    return null;
  const id = getOrAssignSceneId(candidate.el, candidate.type, candidate.strategy);
  return {
    id,
    type: candidate.type,
    rect: boundingBox(candidate.el),
    text: candidate.text,
    extras: {
      ...candidate.extras || {},
      strategy: candidate.strategy
    }
  };
}
function deepestActiveElement(root = document) {
  let active = root.activeElement;
  while (active) {
    const shadow = getShadowRoot(active);
    const nested = shadow?.activeElement;
    if (!nested || nested === active)
      break;
    active = nested;
  }
  return active;
}
function findFocusedWritableSurface() {
  const active = deepestActiveElement();
  if (!active)
    return null;
  const tag = active.tagName;
  const role = active.getAttribute("role");
  if (tag === "TEXTAREA") {
    return { element: active, kind: "textarea", text: active.value || "" };
  }
  if (tag === "INPUT") {
    const hiddenProxy = isHiddenProxyInput(active);
    return {
      element: active,
      kind: hiddenProxy ? role === "application" ? "application-proxy" : "hidden-input" : "input",
      text: active.value || ""
    };
  }
  if (active.isContentEditable || active.getAttribute("contenteditable") === "true") {
    return { element: active, kind: "contenteditable", text: active.textContent || "" };
  }
  if (role === "textbox" || role === "combobox" || role === "searchbox") {
    return { element: active, kind: "textbox", text: active.textContent || "" };
  }
  return null;
}
function readFocusedWritableText() {
  const surface = findFocusedWritableSurface();
  if (!surface)
    return null;
  return {
    text: surface.text,
    length: surface.text.length
  };
}
function setInputValue(el, text) {
  const tag = el.tagName === "TEXTAREA" ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(tag, "value")?.set;
  if (setter)
    setter.call(el, text);
  else
    el.value = text;
  el.dispatchEvent(new InputEvent("beforeinput", { bubbles: true, cancelable: true, inputType: "insertText", data: text }));
  el.dispatchEvent(new Event("input", { bubbles: true }));
  el.dispatchEvent(new Event("change", { bubbles: true }));
  return el.value === text;
}
function writeToFocusedWritableSurface(text, clear = false) {
  const surface = findFocusedWritableSurface();
  if (!surface)
    return { success: false, error: "no focused writable editor surface" };
  const current = surface.text;
  const next = clear ? text : current + text;
  try {
    surface.element.focus();
  } catch {}
  if (surface.kind === "input" || surface.kind === "textarea" || surface.kind === "hidden-input" || surface.kind === "application-proxy") {
    const ok = setInputValue(surface.element, next);
    return {
      success: ok,
      error: ok ? undefined : "focused input surface did not accept the value update",
      method: "dom",
      verified: ok
    };
  }
  if (surface.kind === "contenteditable") {
    try {
      if (clear) {
        document.execCommand("selectAll", false);
        document.execCommand("delete", false);
      }
      document.execCommand("insertText", false, text);
      surface.element.dispatchEvent(new Event("input", { bubbles: true }));
      const updated = surface.element.textContent || "";
      const verified = clear ? updated === text : updated.includes(text);
      return {
        success: verified,
        error: verified ? undefined : "contenteditable surface did not reflect inserted text",
        method: "dom",
        verified
      };
    } catch (err) {
      return { success: false, error: err.message };
    }
  }
  if (surface.kind === "textbox") {
    surface.element.textContent = next;
    surface.element.dispatchEvent(new Event("input", { bubbles: true }));
    const updated = surface.element.textContent || "";
    const verified = updated === next;
    return {
      success: verified,
      error: verified ? undefined : "textbox surface did not reflect inserted text",
      method: "dom",
      verified
    };
  }
  return { success: false, error: "focused writable surface is unsupported" };
}
function selectedAdaptiveScene() {
  const writable = findFocusedWritableSurface();
  if (writable) {
    const id = getOrAssignSceneId(writable.element, "text", "focused-writable");
    const label2 = getAccessibleName(writable.element) || writable.element.getAttribute("aria-label") || writable.kind;
    return {
      has: true,
      id,
      label: label2,
      text: writable.text.slice(0, 200),
      extras: {
        kind: writable.kind,
        writable: true,
        focused: true
      }
    };
  }
  const active = deepestActiveElement();
  if (active) {
    const id = getOrAssignSceneId(active, "group", "focused-element");
    return {
      has: true,
      id,
      label: getAccessibleName(active) || active.getAttribute("aria-label") || active.tagName.toLowerCase(),
      text: readElementText(active).slice(0, 200),
      extras: {
        role: getEffectiveRole(active),
        focused: true
      }
    };
  }
  const app = document.querySelector('[role="application"]');
  const label = app?.getAttribute("aria-label") || undefined;
  return { has: !!label, label };
}
function cursorToAdaptiveScene(x, y) {
  try {
    clickAtViewport(x, y);
    return { success: true };
  } catch (err) {
    return { success: false, error: err.message };
  }
}
function describeAdaptiveProfile(name = "generic", notes) {
  const objects = discoverAdaptiveSceneObjects({ profileName: name });
  const strategies = Array.from(new Set(objects.map((o) => String(o.extras?.strategy || "unknown")).concat(findFocusedWritableSurface() ? ["focused-writable"] : [])));
  const writable = findFocusedWritableSurface();
  const capabilities = ["list", "resolve", "selected", "hitTest", "cursorTo", "trustedInput"];
  if (objects.length > 0)
    capabilities.push("geometry");
  if (writable)
    capabilities.push("text", "writeAtCursor");
  return {
    name,
    capabilities,
    strategies: strategies.length > 0 ? strategies : ["fallback"],
    geometryAddressable: objects.length > 0,
    focusAddressable: !!document.activeElement,
    textWritable: !!writable,
    modelProbe: false,
    trustedInput: true,
    notes
  };
}

// extension/src/content/scene/profiles/generic.ts
var observerObjectCache = new Map;
function asNumber(value) {
  if (typeof value === "number" && Number.isFinite(value))
    return value;
  return null;
}
function toRect(entry) {
  const base = entry.rect || entry.bbox;
  const x = asNumber(base?.x ?? entry.x);
  const y = asNumber(base?.y ?? entry.y);
  const w = asNumber(base?.w);
  const h = asNumber(base?.h);
  if (x === null || y === null)
    return null;
  const width = w ?? 1;
  const height = h ?? 1;
  return {
    x,
    y,
    w: width,
    h: height,
    cx: x + width / 2,
    cy: y + height / 2
  };
}
function observerKindToSceneType(kind) {
  if (kind === "text")
    return "text";
  if (kind === "image")
    return "image";
  if (kind === "rect" || kind === "path")
    return "shape";
  return "unknown";
}
function observerSceneObjects(profileName) {
  observerObjectCache.clear();
  const data = getCanvasBridgeObjects({ limit: 200 });
  if (!data.installed)
    return [];
  return data.objects.map((entry, idx) => {
    const rect = toRect(entry);
    if (!rect)
      return null;
    const kind = String(entry.kind || "").trim();
    const id = `cvobj-${String(entry.canvasId || "unknown")}-${idx}`;
    const obj = {
      id,
      type: observerKindToSceneType(kind),
      rect,
      text: typeof entry.text === "string" ? entry.text : undefined,
      extras: {
        strategy: "canvas-observer",
        profile: profileName,
        canvasId: entry.canvasId,
        observerKind: kind,
        source: entry.source,
        confidence: entry.confidence
      }
    };
    observerObjectCache.set(id, obj);
    return obj;
  }).filter((entry) => !!entry);
}
var genericProfile = {
  name: "generic",
  detect() {
    return true;
  },
  list(opts) {
    const base = discoverAdaptiveSceneObjects({ type: opts?.type, profileName: "generic" });
    const observer = observerSceneObjects("generic");
    if (opts?.type) {
      return [...base, ...observer.filter((entry) => entry.type === opts.type)];
    }
    return [...base, ...observer];
  },
  resolve(id) {
    if (id.startsWith("cvobj-")) {
      const cached = observerObjectCache.get(id);
      if (cached)
        return cached;
    }
    return resolveAdaptiveSceneTarget(id);
  },
  selected() {
    return selectedAdaptiveScene();
  },
  text() {
    return readFocusedWritableText();
  },
  writeAtCursor(text) {
    return writeToFocusedWritableSurface(text);
  },
  cursorTo(opts) {
    return cursorToAdaptiveScene(opts.x, opts.y);
  },
  hitTest(x, y) {
    const observer = observerSceneObjects("generic");
    const hit = observer.find((o) => x >= o.rect.x && x <= o.rect.x + o.rect.w && y >= o.rect.y && y <= o.rect.y + o.rect.h);
    if (hit)
      return hit;
    return hitTestAdaptiveScene(x, y);
  },
  describe() {
    return describeAdaptiveProfile("generic", [
      "Capability-driven fallback profile",
      "Uses semantics, geometry, focus, and writable-surface detection",
      "Consumes canvas-observer objects when available"
    ]);
  }
};

// extension/src/content/scene/profiles/canva.ts
var canvaProfile = {
  name: "canva",
  autoDetect: false,
  detect() {
    return false;
  },
  list(opts) {
    return discoverAdaptiveSceneObjects({ type: opts?.type, profileName: "canva" });
  },
  resolve(id) {
    return resolveAdaptiveSceneTarget(id);
  },
  selected() {
    return selectedAdaptiveScene();
  },
  zoom() {
    const all = Array.from(document.querySelectorAll('[style*="scale"]'));
    for (const el of all) {
      const m = (el.style.transform || "").match(/scale\(([\d.]+)\)/);
      if (m) {
        const s = parseFloat(m[1]);
        if (s > 0 && s < 10)
          return s;
      }
    }
    return 1;
  },
  text() {
    return readFocusedWritableText();
  },
  writeAtCursor(text) {
    return writeToFocusedWritableSurface(text);
  },
  cursorTo(opts) {
    return cursorToAdaptiveScene(opts.x, opts.y);
  },
  hitTest(x, y) {
    return hitTestAdaptiveScene(x, y);
  },
  describe() {
    return describeAdaptiveProfile("canva", [
      "Optional adapter alias",
      "Delegates to capability-driven discovery instead of vendor-specific ids"
    ]);
  }
};

// extension/src/content/scene/profiles/google-docs.ts
init_ops();
function findTextEventTarget() {
  const iframe = document.querySelector(".docs-texteventtarget-iframe");
  if (!iframe)
    return null;
  try {
    const doc = iframe.contentDocument;
    if (!doc)
      return null;
    const textbox = doc.querySelector('[role="textbox"]') || doc.querySelector("[contenteditable]");
    if (!textbox)
      return null;
    return { iframe, doc, textbox };
  } catch {
    return null;
  }
}
function kixPages() {
  return Array.from(document.querySelectorAll(".kix-page-paginated"));
}
function kixEmbeds() {
  return Array.from(document.querySelectorAll(".kix-embeddedobjectdragger, .kix-embeddedobjectdragger-embeddedentity"));
}
var googleDocsProfile = {
  name: "google-docs",
  detect() {
    try {
      return location.host === "docs.google.com" && location.pathname.startsWith("/document/");
    } catch {
      return false;
    }
  },
  list(opts) {
    const out = [];
    if (!opts?.type || opts.type === "page") {
      const pages = kixPages();
      pages.forEach((p, i) => {
        const rect = p.getBoundingClientRect();
        if (rect.width < 2 || rect.height < 2)
          return;
        out.push({
          id: `page-${i}`,
          type: "page",
          rect: boundingBox(p),
          extras: { pageIndex: i }
        });
      });
    }
    if (!opts?.type || opts.type === "embed") {
      const embeds = kixEmbeds();
      embeds.forEach((e, i) => {
        const rect = e.getBoundingClientRect();
        if (rect.width < 2 || rect.height < 2)
          return;
        const aria = e.getAttribute("aria-label") || undefined;
        out.push({
          id: `embed-${i}`,
          type: "embed",
          rect: boundingBox(e),
          text: aria,
          extras: { embedIndex: i }
        });
      });
    }
    return out;
  },
  resolve(id) {
    const pageMatch = id.match(/^page-(\d+)$/);
    if (pageMatch) {
      const idx = parseInt(pageMatch[1]);
      const el = kixPages()[idx];
      return el ? { id, element: el, rect: boundingBox(el), extras: { pageIndex: idx } } : null;
    }
    const embedMatch = id.match(/^embed-(\d+)$/);
    if (embedMatch) {
      const idx = parseInt(embedMatch[1]);
      const el = kixEmbeds()[idx];
      return el ? { id, element: el, rect: boundingBox(el), extras: { embedIndex: idx } } : null;
    }
    return null;
  },
  selected() {
    const tet = findTextEventTarget();
    if (!tet)
      return { has: false };
    try {
      const sel = tet.iframe.contentWindow?.getSelection();
      if (!sel || sel.rangeCount === 0)
        return { has: false };
      const range = sel.getRangeAt(0);
      const text = range.toString();
      return {
        has: text.length > 0,
        text: text.slice(0, 200),
        label: text ? `selection(${text.length} chars)` : "caret"
      };
    } catch {
      return { has: false };
    }
  },
  text(opts) {
    const tet = findTextEventTarget();
    if (!tet)
      return null;
    const text = (tet.textbox.textContent || "").toString();
    return {
      text,
      html: opts?.withHtml ? tet.textbox.innerHTML : undefined,
      length: text.length
    };
  },
  writeAtCursor(text) {
    const tet = findTextEventTarget();
    if (!tet)
      return { success: false, error: "text event target iframe not found" };
    try {
      try {
        tet.iframe.focus();
      } catch {}
      try {
        tet.textbox.focus();
      } catch {}
      const iframeDoc = tet.doc;
      let ok = false;
      try {
        ok = !!iframeDoc.execCommand && iframeDoc.execCommand("insertText", false, text);
      } catch {}
      if (!ok) {
        try {
          const ev = new InputEvent("beforeinput", { bubbles: true, cancelable: true, inputType: "insertText", data: text });
          tet.textbox.dispatchEvent(ev);
          const ev2 = new InputEvent("input", { bubbles: true, cancelable: true, inputType: "insertText", data: text });
          tet.textbox.dispatchEvent(ev2);
          ok = true;
        } catch {}
      }
      if (!ok)
        return { success: false, error: "both execCommand and InputEvent dispatch failed" };
      return { success: true };
    } catch (err) {
      return { success: false, error: err.message };
    }
  },
  cursorTo(opts) {
    try {
      clickAtViewport(opts.x, opts.y);
      return { success: true };
    } catch (err) {
      return { success: false, error: err.message };
    }
  },
  async render(id) {
    const pageMatch = id.match(/^page-(\d+)$/);
    if (!pageMatch)
      return null;
    const idx = parseInt(pageMatch[1]);
    const page = kixPages()[idx];
    if (!page)
      return null;
    const canvas = page.querySelector(".kix-canvas-tile-content");
    if (!canvas)
      return null;
    try {
      const dataUrl = canvas.toDataURL("image/png");
      return {
        id,
        width: canvas.width,
        height: canvas.height,
        dataUrl,
        format: "png"
      };
    } catch (err) {
      throw new Error(`render failed: ${err.message}`);
    }
  },
  describe() {
    return {
      name: "google-docs",
      capabilities: ["list", "resolve", "selected", "text", "writeAtCursor", "cursorTo", "render", "trustedInput"],
      strategies: ["profile:google-docs", "hidden-iframe-textbox", "canvas-page-render"],
      geometryAddressable: true,
      focusAddressable: true,
      textWritable: true,
      modelProbe: false,
      trustedInput: true,
      notes: ["Uses the hidden text-event-target iframe for text read/write"]
    };
  }
};

// extension/src/content/scene/profiles/google-slides.ts
init_ops();
var FILMSTRIP_ID = /^filmstrip-slide-(\d+)-(gd[a-z0-9_-]+)$/i;
function gatherSlides() {
  const all = Array.from(document.querySelectorAll('g[id^="filmstrip-slide-"]'));
  const byIndex = new Map;
  for (const g2 of all) {
    if (g2.id.endsWith("-bg"))
      continue;
    const m = g2.id.match(FILMSTRIP_ID);
    if (!m)
      continue;
    const index = parseInt(m[1], 10);
    if (byIndex.has(index))
      continue;
    const rect = boundingBox(g2);
    const img = g2.querySelector("image");
    const blob = img ? img.getAttribute("xlink:href") || img.getAttribute("href") || undefined : undefined;
    const wrapper = g2.closest("g.punch-filmstrip-thumbnail");
    const pageId = wrapper?.getAttribute("data-slide-page-id") || undefined;
    byIndex.set(index, { index, id: g2.id, rect, blobUrl: blob, pageId });
  }
  const out = Array.from(byIndex.values()).sort((a, b) => a.index - b.index);
  const current = currentSlideId();
  if (current) {
    for (const s of out) {
      const sWithPage = s;
      if (sWithPage.pageId === current)
        s.current = true;
    }
  }
  return out;
}
function currentSlideId() {
  try {
    const h = window.location.hash;
    const m = h.match(/slide=id\.([A-Za-z0-9_]+)/);
    if (m) {
      const pageId = m[1];
      if (pageId === "p") {
        const firstThumb = document.querySelector("g.punch-filmstrip-thumbnail");
        return firstThumb?.getAttribute("data-slide-page-id") || null;
      }
      return pageId;
    }
  } catch {}
  const main = document.querySelector("#editor-p");
  if (!main)
    return null;
  for (const child of Array.from(main.children)) {
    const id = child.id || "";
    if (id.startsWith("editor-gd"))
      return id.replace(/^editor-/, "");
  }
  return null;
}
var googleSlidesProfile = {
  name: "google-slides",
  detect() {
    try {
      return location.host === "docs.google.com" && location.pathname.startsWith("/presentation/");
    } catch {
      return false;
    }
  },
  list() {
    const slides = gatherSlides();
    return slides.map((s) => ({
      id: s.id,
      type: "slide",
      rect: s.rect,
      text: s.blobUrl ? `[blob: ${s.blobUrl.slice(0, 40)}]` : undefined,
      extras: { slideIndex: s.index, current: !!s.current, blobUrl: s.blobUrl }
    }));
  },
  resolve(id) {
    const el = document.getElementById(id);
    return el ? { id, element: el, rect: boundingBox(el) } : null;
  },
  selected() {
    const app = document.querySelector("[role=application]");
    const label = app?.getAttribute("aria-label") || undefined;
    const current = currentSlideId();
    return { has: !!label || !!current, label, id: current || undefined };
  },
  slides() {
    return gatherSlides();
  },
  slideCurrent() {
    const slides = gatherSlides();
    return slides.find((s) => s.current) || slides[0] || null;
  },
  slideGoto(index) {
    const slides = gatherSlides();
    if (index < 0 || index >= slides.length)
      return { success: false, error: `slide index ${index} out of range (0..${slides.length - 1})` };
    const target = slides[index];
    const filmstripGroup = document.getElementById(target.id);
    if (!filmstripGroup)
      return { success: false, error: `slide ${target.id} not in DOM` };
    const thumbWrapper = filmstripGroup.closest("g.punch-filmstrip-thumbnail");
    if (!thumbWrapper)
      return { success: false, error: "no punch-filmstrip-thumbnail ancestor" };
    const pageId = thumbWrapper.getAttribute("data-slide-page-id");
    if (!pageId)
      return { success: false, error: "no data-slide-page-id on thumbnail" };
    const newHash = `#slide=id.${pageId}`;
    try {
      window.location.hash = newHash;
      return { success: true };
    } catch (err) {
      return { success: false, error: err.message };
    }
  },
  notes(slideIndex) {
    const paragraphs = Array.from(document.querySelectorAll('[id^="speakernotes-i"][id*="paragraph"]'));
    if (paragraphs.length === 0) {
      const notesContainer = document.getElementById("speakernotes") || document.getElementById("speakernotes-workspace");
      if (notesContainer)
        return (notesContainer.textContent || "").trim() || null;
      return null;
    }
    const text = paragraphs.map((p) => (p.textContent || "").trim()).filter(Boolean).join(`
`);
    return text || null;
  },
  text() {
    const iframe = document.querySelector(".docs-texteventtarget-iframe");
    if (!iframe)
      return null;
    try {
      const doc = iframe.contentDocument;
      if (!doc)
        return null;
      const textbox = doc.querySelector("[role=textbox]") || doc.querySelector("[contenteditable]");
      if (!textbox)
        return null;
      const text = (textbox.textContent || "").trim();
      return { text, length: text.length };
    } catch {
      return null;
    }
  },
  async render(id) {
    const slide = document.getElementById(id);
    if (!slide)
      return null;
    const img = slide.querySelector("image");
    if (!img)
      return null;
    const href = img.getAttribute("xlink:href") || img.getAttribute("href");
    if (!href)
      return null;
    try {
      const resp = await fetch(href);
      const blob = await resp.blob();
      const bitmap = await createImageBitmap(blob);
      const canvas = document.createElement("canvas");
      canvas.width = bitmap.width;
      canvas.height = bitmap.height;
      const ctx = canvas.getContext("2d");
      if (!ctx)
        return null;
      ctx.drawImage(bitmap, 0, 0);
      const dataUrl = canvas.toDataURL("image/png");
      return { id, width: bitmap.width, height: bitmap.height, dataUrl, format: "png" };
    } catch {
      return null;
    }
  },
  describe() {
    return {
      name: "google-slides",
      capabilities: ["list", "resolve", "selected", "slides", "slideCurrent", "slideGoto", "notes", "render", "text", "trustedInput"],
      strategies: ["profile:google-slides", "filmstrip-svg", "hash-navigation", "notes-dom"],
      geometryAddressable: true,
      focusAddressable: true,
      textWritable: false,
      modelProbe: false,
      trustedInput: true,
      notes: ["Slide navigation uses the URL hash/page-id model rather than synthetic thumbnail clicks"]
    };
  }
};

// extension/src/content/scene/engine.ts
init_input_simulation();
var profiles = [];
var genericRegistered = false;
var builtinsRegistered = false;
function ensureBuiltins() {
  if (builtinsRegistered)
    return;
  builtinsRegistered = true;
  profiles.push(canvaProfile);
  profiles.push(googleSlidesProfile);
  profiles.push(googleDocsProfile);
}
function ensureGeneric() {
  if (genericRegistered)
    return;
  genericRegistered = true;
  profiles.push(genericProfile);
}
function detectProfile(override) {
  ensureBuiltins();
  ensureGeneric();
  if (override) {
    const match = profiles.find((p) => p.name === override);
    if (match)
      return match;
  }
  for (const p of profiles) {
    try {
      if (p === genericProfile)
        continue;
      if (p.autoDetect === false)
        continue;
      if (p.detect())
        return p;
    } catch {}
  }
  return genericProfile;
}
function wrap(profile, fn) {
  try {
    const data = fn();
    if (data === null || data === undefined) {
      return { success: false, error: "no data", profile: profile.name };
    }
    return { success: true, data, profile: profile.name };
  } catch (err) {
    return { success: false, error: err.message, profile: profile.name };
  }
}
async function wrapAsync(profile, fn) {
  try {
    const data = await fn();
    if (data === null || data === undefined) {
      return { success: false, error: "no data", profile: profile.name };
    }
    return { success: true, data, profile: profile.name };
  } catch (err) {
    return { success: false, error: err.message, profile: profile.name };
  }
}
function inferDescription(p) {
  const caps = [];
  if (p.list)
    caps.push("list");
  if (p.resolve)
    caps.push("resolve");
  if (p.selected)
    caps.push("selected");
  if (p.zoom)
    caps.push("zoom");
  if (p.text)
    caps.push("text");
  if (p.writeAtCursor)
    caps.push("writeAtCursor");
  if (p.cursorTo)
    caps.push("cursorTo");
  if (p.render)
    caps.push("render");
  if (p.slides)
    caps.push("slides");
  if (p.slideCurrent)
    caps.push("slideCurrent");
  if (p.slideGoto)
    caps.push("slideGoto");
  if (p.notes)
    caps.push("notes");
  if (p.hitTest)
    caps.push("hitTest");
  caps.push("trustedInput");
  return {
    name: p.name,
    capabilities: caps,
    strategies: [`profile:${p.name}`],
    geometryAddressable: !!(p.list || p.resolve || p.hitTest),
    focusAddressable: !!p.selected,
    textWritable: !!p.writeAtCursor,
    modelProbe: false,
    trustedInput: true
  };
}
function canvasProfileName(override) {
  const p = detectProfile(override);
  const data = p.describe ? p.describe() : inferDescription(p);
  return { success: true, data, profile: p.name };
}
function canvasList(opts) {
  const p = detectProfile(opts?.profile);
  if (!p.list)
    return { success: false, error: `profile '${p.name}' does not support list()`, profile: p.name };
  return wrap(p, () => p.list({ type: opts?.type }));
}
function canvasResolve(id, profileOverride) {
  const p = detectProfile(profileOverride);
  if (!p.resolve)
    return { success: false, error: `profile '${p.name}' does not support resolve()`, profile: p.name };
  const resolved = p.resolve(id);
  if (!resolved)
    return { success: false, error: `no element matches id '${id}'`, profile: p.name };
  return { success: true, data: resolved, profile: p.name };
}
function canvasSelected(profileOverride) {
  const p = detectProfile(profileOverride);
  if (!p.selected)
    return { success: false, error: `profile '${p.name}' does not support selected()`, profile: p.name };
  return wrap(p, () => p.selected());
}
function canvasZoom(profileOverride) {
  const p = detectProfile(profileOverride);
  if (!p.zoom)
    return { success: false, error: `profile '${p.name}' does not support zoom()`, profile: p.name };
  return wrap(p, () => p.zoom());
}
function canvasText(opts) {
  const p = detectProfile(opts?.profile);
  if (!p.text)
    return { success: false, error: `profile '${p.name}' does not support text()`, profile: p.name };
  return wrap(p, () => p.text({ withHtml: opts?.withHtml }));
}
function canvasInsertText(text, profileOverride) {
  const p = detectProfile(profileOverride);
  if (!p.writeAtCursor)
    return { success: false, error: `profile '${p.name}' does not support writeAtCursor()`, profile: p.name };
  const r = p.writeAtCursor(text);
  if (!r.success)
    return { success: false, error: r.error || "writeAtCursor failed", profile: p.name };
  return {
    success: true,
    data: {
      inserted: text.length,
      method: r.method || "dom",
      verified: r.verified !== false,
      text: r.text
    },
    profile: p.name
  };
}
function canvasCursorTo(x, y, profileOverride) {
  const p = detectProfile(profileOverride);
  if (!p.cursorTo)
    return { success: false, error: `profile '${p.name}' does not support cursorTo()`, profile: p.name };
  const r = p.cursorTo({ x, y });
  if (!r.success)
    return { success: false, error: r.error || "cursorTo failed", profile: p.name };
  return { success: true, data: { x, y }, profile: p.name };
}
async function canvasRender(id, profileOverride) {
  const p = detectProfile(profileOverride);
  if (!p.render)
    return { success: false, error: `profile '${p.name}' does not support render()`, profile: p.name };
  return wrapAsync(p, () => p.render(id));
}
function canvasSlideList(profileOverride) {
  const p = detectProfile(profileOverride);
  if (!p.slides)
    return { success: false, error: `profile '${p.name}' does not support slides()`, profile: p.name };
  return wrap(p, () => p.slides());
}
function canvasSlideCurrent(profileOverride) {
  const p = detectProfile(profileOverride);
  if (!p.slideCurrent)
    return { success: false, error: `profile '${p.name}' does not support slideCurrent()`, profile: p.name };
  return wrap(p, () => p.slideCurrent());
}
function canvasSlideGoto(index, profileOverride) {
  const p = detectProfile(profileOverride);
  if (!p.slideGoto)
    return { success: false, error: `profile '${p.name}' does not support slideGoto()`, profile: p.name };
  const r = p.slideGoto(index);
  if (!r.success)
    return { success: false, error: r.error || "slideGoto failed", profile: p.name };
  return { success: true, data: { index }, profile: p.name };
}
function canvasNotes(slideIndex, profileOverride) {
  const p = detectProfile(profileOverride);
  if (!p.notes)
    return { success: false, error: `profile '${p.name}' does not support notes()`, profile: p.name };
  return wrap(p, () => p.notes(slideIndex));
}
function canvasHit(x, y, profileOverride) {
  const p = detectProfile(profileOverride);
  if (p.hitTest)
    return wrap(p, () => p.hitTest(x, y));
  if (p.list) {
    const list = p.list({}) || [];
    const best = list.find((o) => x >= o.rect.x && x <= o.rect.x + o.rect.w && y >= o.rect.y && y <= o.rect.y + o.rect.h);
    if (!best)
      return { success: false, error: "no scene object at coordinates", profile: p.name };
    return { success: true, data: best, profile: p.name };
  }
  return { success: false, error: `profile '${p.name}' cannot hit-test`, profile: p.name };
}
function selectionChanged(before, after) {
  try {
    return JSON.stringify(before) !== JSON.stringify(after);
  } catch {
    return before !== after;
  }
}
async function handleCanvasAction(action) {
  const profileOverride = action.profile;
  try {
    switch (action.type) {
      case "scene_profile": {
        const verbose = !!action.verbose;
        const r = canvasProfileName(profileOverride);
        if (verbose)
          return r;
        if (r.success && r.data)
          return { success: true, data: r.data.name };
        return r;
      }
      case "scene_list": {
        const r = canvasList({ type: action.filter, profile: profileOverride });
        return r;
      }
      case "scene_click":
      case "scene_dblclick":
      case "scene_select": {
        const id = action.id;
        if (!id)
          return { success: false, error: "missing id" };
        const resolved = canvasResolve(id, profileOverride);
        if (!resolved.success)
          return resolved;
        const { clickElementCenter: clickElementCenter2, dblclickElementCenter: dblclickElementCenter2 } = await Promise.resolve().then(() => (init_ops(), exports_ops));
        const target = resolved.data;
        const beforeSelection = canvasSelected(profileOverride);
        const cx = Math.round(target.rect.cx);
        const cy = Math.round(target.rect.cy);
        if (action.type === "scene_click" && action.os) {
          return {
            success: true,
            data: {
              id,
              clicked: false,
              at: { x: cx, y: cy },
              method: "os_click"
            }
          };
        }
        if (action.type === "scene_dblclick") {
          if (target.element)
            dblclickElementCenter2(target.element);
          else {
            const clicked = document.elementFromPoint(cx, cy);
            if (clicked)
              dblclickElementCenter2(clicked);
          }
          return {
            success: true,
            data: { id, clicked: true, at: { x: cx, y: cy }, method: "synthetic" }
          };
        }
        const click = target.element ? () => clickElementCenter2(target.element) : await Promise.resolve().then(() => (init_ops(), exports_ops)).then(({ clickAtViewport: clickAtViewport3 }) => () => clickAtViewport3(cx, cy));
        const mutation = waitForMutation(200);
        click();
        const mutated = await mutation;
        const afterSelection = canvasSelected(profileOverride);
        const changed = mutated || selectionChanged(beforeSelection.data, afterSelection.data);
        return {
          success: true,
          data: { id, clicked: true, at: { x: cx, y: cy }, method: "synthetic" },
          warning: changed || action.escalate === false ? undefined : "no DOM change after scene click — try: interceptor scene click --trusted " + id
        };
      }
      case "scene_selected":
        return canvasSelected(profileOverride);
      case "scene_zoom":
        return canvasZoom(profileOverride);
      case "scene_text":
        return canvasText({ withHtml: !!action.withHtml, profile: profileOverride });
      case "scene_insert":
        return canvasInsertText(action.text, profileOverride);
      case "scene_cursor_to":
        return canvasCursorTo(action.x, action.y, profileOverride);
      case "scene_cursor":
        return canvasSelected(profileOverride);
      case "scene_slide_list":
        return canvasSlideList(profileOverride);
      case "scene_slide_current":
        return canvasSlideCurrent(profileOverride);
      case "scene_slide_goto":
        return canvasSlideGoto(action.index, profileOverride);
      case "scene_notes":
        return canvasNotes(action.slideIndex, profileOverride);
      case "scene_render": {
        const r = await canvasRender(action.id, profileOverride);
        return r;
      }
      case "scene_hit":
        return canvasHit(action.x, action.y, profileOverride);
      default:
        return { success: false, error: `unknown scene action: ${action.type}` };
    }
  } catch (err) {
    return { success: false, error: err.message };
  }
}

// extension/src/content/dom-screenshot.ts
init_input_simulation();
var TRANSPARENT_1PX = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYGBgAAAABQABh6FO1AAAAABJRU5ErkJggg==";
var SKIP_TAGS2 = new Set(["script", "noscript", "style", "link", "meta", "template", "iframe", "object", "embed"]);
function extractUrls(cssValue) {
  const out = [];
  const re = /url\((['"]?)([^'")]+)\1\)/g;
  let m;
  while ((m = re.exec(cssValue)) !== null) {
    const u = (m[2] || "").trim();
    if (u && u.indexOf("data:") !== 0)
      out.push(u);
  }
  return out;
}
async function fetchResourceAsDataUrl(url) {
  try {
    const res = await fetch(url, { mode: "cors", cache: "force-cache" });
    if (!res.ok)
      return TRANSPARENT_1PX;
    const blob = await res.blob();
    return await new Promise((resolve) => {
      const reader = new FileReader;
      reader.onloadend = () => resolve(typeof reader.result === "string" ? reader.result : TRANSPARENT_1PX);
      reader.onerror = () => resolve(TRANSPARENT_1PX);
      reader.readAsDataURL(blob);
    });
  } catch {
    return TRANSPARENT_1PX;
  }
}
function loadSvgImage(svgDataUrl) {
  return new Promise((resolve, reject) => {
    const img = new Image;
    img.onload = () => {
      img.decode().then(() => resolve(img)).catch(() => resolve(img));
    };
    img.onerror = () => reject(new Error("foreignObject SVG failed to rasterize"));
    img.src = svgDataUrl;
  });
}
function inlineComputedStyle(srcEl, cloneEl, collect) {
  const cs = window.getComputedStyle(srcEl);
  let cssText = "";
  for (let i = 0;i < cs.length; i++) {
    const name = cs[i];
    let value = cs.getPropertyValue(name);
    if (name === "font-size" && value.endsWith("px")) {
      const n = parseFloat(value);
      if (n > 0)
        value = `${n - 0.1}px`;
    }
    cssText += `${name}:${value};`;
  }
  try {
    cloneEl.style.cssText = cssText;
  } catch {}
  const bg = cs.getPropertyValue("background-image");
  if (bg && bg.indexOf("url(") !== -1) {
    collect.bgJobs.push({ el: cloneEl, value: bg });
    for (const u of extractUrls(bg))
      collect.urls.add(u);
  }
}
function buildStyledClone(src, collect) {
  if (src.nodeType === Node.TEXT_NODE)
    return src.cloneNode(false);
  if (src.nodeType !== Node.ELEMENT_NODE)
    return null;
  const el = src;
  const tag = (el.tagName || "").toLowerCase();
  if (SKIP_TAGS2.has(tag))
    return null;
  if (tag === "canvas") {
    try {
      const dataUrl = el.toDataURL();
      const img = document.createElement("img");
      img.setAttribute("src", dataUrl);
      inlineComputedStyle(el, img, collect);
      return img;
    } catch {}
  }
  if (tag === "svg") {
    const c2 = el.cloneNode(true);
    try {
      inlineComputedStyle(el, c2, collect);
    } catch {}
    return c2;
  }
  const c = el.cloneNode(false);
  if (c.style)
    inlineComputedStyle(el, c, collect);
  if (tag === "img") {
    const im = el;
    const url = im.currentSrc || im.src;
    if (url && url.indexOf("data:") !== 0) {
      c.removeAttribute("srcset");
      collect.imgJobs.push({ el: c, url });
      collect.urls.add(url);
    }
  }
  const kids = el.childNodes;
  for (let i = 0;i < kids.length; i++) {
    const cc = buildStyledClone(kids[i], collect);
    if (cc)
      c.appendChild(cc);
  }
  return c;
}
async function nativeRenderToDataUrl(node, o) {
  const collect = { imgJobs: [], bgJobs: [], urls: new Set };
  const clone = buildStyledClone(node, collect);
  if (!clone)
    throw new Error("nothing to render");
  const urlList = Array.from(collect.urls);
  const dataUrlMap = new Map;
  await Promise.all(urlList.map(async (u) => {
    dataUrlMap.set(u, await fetchResourceAsDataUrl(u));
  }));
  for (const job of collect.imgJobs) {
    job.el.setAttribute("src", dataUrlMap.get(job.url) || TRANSPARENT_1PX);
  }
  for (const job of collect.bgJobs) {
    let v = job.value;
    for (const u of extractUrls(job.value)) {
      const d = dataUrlMap.get(u);
      if (d)
        v = v.split(u).join(d);
    }
    try {
      job.el.style.backgroundImage = v;
    } catch {}
  }
  if (o.isFull) {
    clone.style.width = `${o.width}px`;
    clone.style.height = `${o.height}px`;
  } else {
    clone.style.margin = "0";
  }
  clone.setAttribute("xmlns", "http://www.w3.org/1999/xhtml");
  const xml = new XMLSerializer().serializeToString(clone);
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${o.width}" height="${o.height}">` + `<foreignObject x="0" y="0" width="100%" height="100%">${xml}</foreignObject></svg>`;
  const svgUrl = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
  const img = await loadSvgImage(svgUrl);
  const canvas = document.createElement("canvas");
  const fullW = Math.max(1, Math.round(o.width * o.pixelRatio));
  const fullH = Math.max(1, Math.round(o.height * o.pixelRatio));
  canvas.width = o.crop ? Math.max(1, Math.round(o.crop.width * o.pixelRatio)) : fullW;
  canvas.height = o.crop ? Math.max(1, Math.round(o.crop.height * o.pixelRatio)) : fullH;
  const ctx = canvas.getContext("2d");
  if (!ctx)
    throw new Error("2d canvas context unavailable");
  if (o.crop) {
    ctx.drawImage(img, -Math.round(o.crop.x * o.pixelRatio), -Math.round(o.crop.y * o.pixelRatio), fullW, fullH);
  } else {
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
  }
  const out = o.format === "jpeg" ? canvas.toDataURL("image/jpeg", o.quality) : canvas.toDataURL("image/png");
  return checkRasterizeOutput(out, canvas.width, canvas.height);
}
function checkRasterizeOutput(dataUrl, width, height) {
  const payloadStart = dataUrl.indexOf(",") + 1;
  if (payloadStart > 0 && dataUrl.length - payloadStart >= 24)
    return dataUrl;
  throw new Error(`rendered canvas ${width}x${height}px exceeds the browser's canvas size limit and produced no image data — ` + `capture a smaller area with --region, or reduce output size with --target-max-long-edge or a smaller --scale`);
}
function resolveTarget(action) {
  const mode = action.mode || "full";
  switch (mode) {
    case "full":
    case "region":
      return { node: document.documentElement };
    case "element": {
      if (action.ref === undefined && action.index === undefined) {
        return { node: null, error: "element mode requires ref or index" };
      }
      const el = resolveElement(action.index, action.ref);
      if (!el) {
        const label = String(action.ref ?? action.index ?? "unknown");
        return { node: null, error: `stale element [${label}] — run interceptor state to refresh` };
      }
      if (!(el instanceof HTMLElement)) {
        return { node: null, error: `target is not an HTMLElement (got ${el.constructor.name})` };
      }
      return { node: el };
    }
    case "selector": {
      if (!action.selector) {
        return { node: null, error: "selector mode requires selector string" };
      }
      const el = document.querySelector(action.selector);
      if (!el)
        return { node: null, error: `selector not found: ${action.selector}` };
      if (!(el instanceof HTMLElement)) {
        return { node: null, error: `selector matched non-HTMLElement (got ${el.constructor.name})` };
      }
      return { node: el };
    }
    default:
      return { node: null, error: `unknown screenshot mode: ${mode}` };
  }
}
async function handleDomScreenshot(action) {
  const { node, error } = resolveTarget(action);
  if (!node)
    return { success: false, error: error || "no target resolved" };
  const format = action.format === "jpeg" ? "jpeg" : "png";
  const qualityPct = typeof action.quality === "number" ? Math.max(1, Math.min(100, action.quality)) : 92;
  const basePixelRatio = typeof action.scale === "number" && action.scale > 0 ? action.scale : window.devicePixelRatio || 1;
  const mode = action.mode || "full";
  const isFull = mode === "full" || mode === "region";
  let width;
  let height;
  if (isFull) {
    width = Math.max(document.documentElement.scrollWidth, document.body?.scrollWidth || 0);
    height = Math.max(document.documentElement.scrollHeight, document.body?.scrollHeight || 0);
  } else {
    const rect = node.getBoundingClientRect();
    width = Math.max(1, Math.ceil(rect.width));
    height = Math.max(1, Math.ceil(rect.height));
  }
  let pixelRatio = basePixelRatio;
  const target = typeof action.target_max_long_edge === "number" && action.target_max_long_edge > 0 ? action.target_max_long_edge : undefined;
  if (target !== undefined) {
    const longEdgeCss = Math.max(width, height);
    if (longEdgeCss > 0 && longEdgeCss * pixelRatio > target) {
      pixelRatio = Math.max(0.05, target / longEdgeCss);
    }
  }
  try {
    const crop = mode === "region" && action.region ? action.region : undefined;
    const dataUrl = await nativeRenderToDataUrl(node, {
      width,
      height,
      pixelRatio,
      format,
      quality: qualityPct / 100,
      isFull,
      crop
    });
    const outWidth = Math.round((crop ? crop.width : width) * pixelRatio);
    const outHeight = Math.round((crop ? crop.height : height) * pixelRatio);
    return {
      success: true,
      data: { dataUrl, format, width: outWidth, height: outHeight, pixelRatio, mode }
    };
  } catch (err) {
    return { success: false, error: `dom render failed: ${describeRenderError(err)}` };
  }
}
function describeRenderError(err) {
  if (err instanceof Error && err.message)
    return err.message;
  if (typeof Event !== "undefined" && err instanceof Event) {
    const target = err.target;
    return `image load failed (${err.type}${target?.tagName ? ` on <${target.tagName.toLowerCase()}>` : ""}) — the rendered SVG could not be decoded, likely too large or a resource blocked`;
  }
  const s = typeof err === "string" ? err : String(err);
  if (!s || s === "undefined" || s === "null" || s === "[object Object]") {
    return "unknown render error (non-Error thrown)";
  }
  return s;
}

// extension/src/content.ts
var __interceptorContentGlobal = globalThis;
var __interceptorContentAlreadyLoaded = __interceptorContentGlobal.__interceptorContentLoaded === true;
__interceptorContentGlobal.__interceptorContentLoaded = true;
if (!__interceptorContentAlreadyLoaded)
  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg.type === "execute_action") {
      handleAction(msg.action).then(sendResponse).catch((err) => sendResponse({ success: false, error: err.message }));
      return true;
    }
    if (msg.type === "get_state") {
      try {
        sendResponse(getPageState(msg.full));
      } catch (err) {
        sendResponse({ success: false, error: err.message });
      }
      return true;
    }
  });
async function handleAction(action) {
  const warnDirty = getDomDirty();
  clearStaleWarning();
  const wantChanges = !!action.changes;
  if (wantChanges)
    cacheSnapshot();
  const result = await executeAction(action);
  const note = getStaleWarning() ?? (warnDirty ? "DOM has changed since last state read" : null);
  if (note && result.success)
    result.warning = result.warning ? `${result.warning}; ${note}` : note;
  if (wantChanges && result.success) {
    const diffResult = computeSnapshotDiff();
    if (diffResult.success)
      result.changes = diffResult.data;
  }
  return result;
}
async function executeAction(action) {
  try {
    switch (action.type) {
      case "get_state":
        return getPageState(action.full);
      case "click":
        return handleClick(action);
      case "click_selector":
        return handleClickSelector(action);
      case "dblclick":
        return handleDblclick(action);
      case "rightclick":
        return handleRightclick(action);
      case "drag":
        return handleDrag(action);
      case "file_upload":
        return handleFileUpload(action);
      case "file_upload_chunk":
        return handleFileUploadChunk(action);
      case "input_text":
        return handleInputText(action);
      case "select_option":
        return handleSelectOption(action);
      case "check":
        return handleCheck(action);
      case "scroll":
        return handleScroll2(action);
      case "scroll_absolute":
        return handleScrollAbsolute(action);
      case "get_page_dimensions":
        return handleGetPageDimensions(action);
      case "scroll_to":
        return handleScrollTo(action);
      case "send_keys": {
        const keys = action.keys;
        const target = document.activeElement || document.body;
        dispatchKeySequence(target, keys);
        return { success: true };
      }
      case "wait":
        return handleWait(action);
      case "wait_for":
        return handleWaitFor(action);
      case "extract_text":
        return handleExtractText(action);
      case "extract_markdown":
        return handleExtractMarkdown(action);
      case "extract_html":
        return handleExtractHtml(action);
      case "focus":
        return handleFocus(action);
      case "blur":
        return handleBlur(action);
      case "hover":
        return handleHover(action);
      case "query":
        return handleQuery(action);
      case "query_one":
        return handleQueryOne(action);
      case "attr_get":
        return handleAttrGet(action);
      case "attr_set":
        return handleAttrSet(action);
      case "style_get":
        return handleStyleGet(action);
      case "forms":
        return handleForms(action);
      case "links":
        return handleLinks(action);
      case "images":
        return handleImages(action);
      case "meta":
        return handleMeta(action);
      case "storage_read":
        return handleStorageRead(action);
      case "storage_write":
        return handleStorageWrite(action);
      case "storage_delete":
        return handleStorageDelete(action);
      case "clipboard_read":
        return handleClipboardRead(action);
      case "clipboard_write":
        return handleClipboardWrite(action);
      case "selection_get":
        return handleSelectionGet(action);
      case "selection_set":
        return handleSelectionSet(action);
      case "rect":
        return handleRect(action);
      case "exists":
        return handleExists(action);
      case "count":
        return handleCount(action);
      case "table_data":
        return handleTableData(action);
      case "page_info":
        return handlePageInfo(action);
      case "get_a11y_tree": {
        const maxDepth = action.depth || 15;
        const filter = action.filter || "interactive";
        const maxChars = action.maxChars || 50000;
        const includeStyle = action.includeStyle === true;
        const treeFormat = action.treeFormat === "compact" ? "compact" : "verbose";
        const wantsTarget = action.index !== undefined || action.ref !== undefined;
        pruneStaleRefs();
        const root = wantsTarget ? resolveElement(action.index, action.ref) : document.body;
        if (wantsTarget && !root) {
          const label = String(action.ref ?? action.index ?? "unknown");
          return { success: false, error: `stale element [${label}] — run interceptor state to refresh` };
        }
        const treeOutput = buildA11yTree(root || document.body, 0, maxDepth, filter, includeStyle, treeFormat);
        const truncated = treeOutput.length > maxChars ? treeOutput.slice(0, maxChars) + `
... (truncated)` : treeOutput;
        cacheSnapshot();
        return { success: true, data: truncated };
      }
      case "diff": {
        if (!getDomDirty() && (await Promise.resolve().then(() => (init_snapshot_diff(), exports_snapshot_diff))).lastSnapshot.length > 0) {
          return { success: true, data: { changes: 0, added: [], removed: [], changed: [] } };
        }
        const diffResult = computeSnapshotDiff();
        if (diffResult.success && typeof diffResult.data === "string") {
          const lines = diffResult.data === "no changes" ? [] : diffResult.data.split(`
`);
          const added = lines.filter((l) => l.startsWith("+ "));
          const removed = lines.filter((l) => l.startsWith("- "));
          const changed = lines.filter((l) => l.startsWith("~ "));
          return { success: true, data: { changes: lines.length, added, removed, changed, total: lines.length } };
        }
        return diffResult;
      }
      case "find_element":
        return handleFindElement(action);
      case "dom_screenshot":
        return handleDomScreenshot(action);
      case "modals":
        return handleModals(action);
      case "panels":
        return handlePanels(action);
      case "click_at":
        return handleClickAt(action);
      case "what_at":
        return handleWhatAt(action);
      case "regions":
        return handleRegions(action);
      case "get_focus":
        return handleGetFocus(action);
      case "semantic_resolve":
        return handleSemanticResolve(action);
      case "find_and_click":
        return handleFindAndClick(action);
      case "find_and_type":
        return handleFindAndType(action);
      case "find_and_check":
        return handleFindAndCheck(action);
      case "scene_list":
      case "scene_click":
      case "scene_dblclick":
      case "scene_select":
      case "scene_hit":
      case "scene_selected":
      case "scene_text":
      case "scene_insert":
      case "scene_cursor_to":
      case "scene_cursor":
      case "scene_slide_list":
      case "scene_slide_goto":
      case "scene_slide_current":
      case "scene_notes":
      case "scene_render":
      case "scene_zoom":
      case "scene_profile":
        return await handleCanvasAction(action);
      case "wait_stable":
        return handleWaitStable(action);
      case "batch": {
        const actions = action.actions;
        if (!actions || !Array.isArray(actions))
          return { success: false, error: "batch requires actions array" };
        if (actions.length > 100)
          return { success: false, error: "batch limited to 100 sub-actions" };
        const stopOnError = !!action.stopOnError;
        const batchTimeout = action.timeout || 30000;
        const batchStart = Date.now();
        const results = [];
        for (const subAction of actions) {
          if (Date.now() - batchStart > batchTimeout) {
            results.push({ action: subAction.type, success: false, error: "batch timeout exceeded" });
            break;
          }
          try {
            const subResult = await executeAction(subAction);
            results.push({ action: subAction.type, success: subResult.success, data: subResult.data, error: subResult.error, warning: subResult.warning });
            if (!subResult.success && stopOnError)
              break;
          } catch (err) {
            results.push({ action: subAction.type, success: false, error: err.message });
            if (stopOnError)
              break;
          }
        }
        return { success: true, data: { results, elapsed: Date.now() - batchStart } };
      }
      case "evaluate":
        return { success: false, error: "evaluate is handled by background script — this should not be reached" };
      default:
        return { success: false, error: `unknown action type: ${action.type}` };
    }
  } catch (err) {
    return { success: false, error: err.message };
  }
}
var _swKeepaliveLeader = true;
if (!__interceptorContentAlreadyLoaded)
  setInterval(() => {
    if (!_swKeepaliveLeader)
      return;
    try {
      chrome.runtime.sendMessage({ type: "sw_keepalive" }).then((resp) => {
        if (resp && resp.leader === false)
          _swKeepaliveLeader = false;
      }).catch(() => {});
    } catch {}
  }, 25000);
