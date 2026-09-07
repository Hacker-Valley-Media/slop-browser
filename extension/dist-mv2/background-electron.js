// extension/src/background/brand-tab-group.ts
var VALID_COLORS = ["grey", "blue", "red", "yellow", "green", "pink", "purple", "cyan", "orange"];
var DEFAULT_TAB_GROUP_TITLE = "interceptor";
var DEFAULT_TAB_GROUP_COLOR = "cyan";
var SESSION_PREV_TITLE_KEY = "brandTabGroupPrevTitle";
var cachedTitle = DEFAULT_TAB_GROUP_TITLE;
var cachedColor = DEFAULT_TAB_GROUP_COLOR;
function normalizeColor(color) {
  return typeof color === "string" && VALID_COLORS.includes(color) ? color : DEFAULT_TAB_GROUP_COLOR;
}
function getTabGroupTitle() {
  return cachedTitle;
}
function getTabGroupColor() {
  return normalizeColor(cachedColor);
}
function sessionArea() {
  const storage = chrome.storage;
  return storage.session;
}
async function getPreviousTitle() {
  try {
    const area = sessionArea();
    if (!area)
      return;
    const stored = await area.get(SESSION_PREV_TITLE_KEY);
    const v = stored?.[SESSION_PREV_TITLE_KEY];
    return typeof v === "string" ? v : undefined;
  } catch {
    return;
  }
}
async function getCandidateTitles() {
  const titles = new Set;
  titles.add(cachedTitle);
  const prev = await getPreviousTitle();
  if (prev)
    titles.add(prev);
  titles.add(DEFAULT_TAB_GROUP_TITLE);
  return [...titles];
}

// extension/src/background/tab-group.ts
var interceptorGroupId = null;
function hasTabGroupApi() {
  return !!chrome.tabGroups && typeof chrome.tabGroups.query === "function";
}
async function isTabInNormalWindow(tabId) {
  if (!chrome.windows || typeof chrome.windows.get !== "function")
    return true;
  try {
    const tab = await chrome.tabs.get(tabId);
    if (tab.windowId === undefined)
      return true;
    const win = await chrome.windows.get(tab.windowId);
    return win.type === undefined || win.type === "normal";
  } catch {
    return true;
  }
}
var GROUP_LABEL_RE = /^[A-Za-z0-9_-]{1,32}$/;
var SESSION_NAMED_GROUPS_KEY = "namedTabGroups";
var namedGroups = new Map;
var namedGroupsHydrated = false;
function sessionArea2() {
  const storage = chrome.storage;
  return storage.session;
}
async function hydrateNamedGroups() {
  if (namedGroupsHydrated)
    return;
  namedGroupsHydrated = true;
  try {
    const area = sessionArea2();
    if (!area)
      return;
    const stored = await area.get(SESSION_NAMED_GROUPS_KEY);
    const raw = stored?.[SESSION_NAMED_GROUPS_KEY];
    if (raw && typeof raw === "object") {
      for (const [label, gid] of Object.entries(raw)) {
        if (GROUP_LABEL_RE.test(label) && typeof gid === "number")
          namedGroups.set(label, gid);
      }
    }
  } catch {}
}
async function persistNamedGroups() {
  try {
    const area = sessionArea2();
    if (!area)
      return;
    await area.set({ [SESSION_NAMED_GROUPS_KEY]: Object.fromEntries(namedGroups) });
  } catch {}
}
function groupTitleFor(label) {
  return `${getTabGroupTitle()}-${label}`;
}
function colorForLabel(label) {
  let h = 0;
  for (let i = 0;i < label.length; i++)
    h = h * 31 + label.charCodeAt(i) >>> 0;
  return VALID_COLORS[h % VALID_COLORS.length];
}
async function purgeNamedGroupEntry(label) {
  namedGroups.delete(label);
  await persistNamedGroups();
  try {
    const area = sessionArea2();
    if (area)
      await area.remove(`activeTabId:${label}`);
  } catch {}
}
async function ensureNamedGroup(label) {
  if (!hasTabGroupApi())
    return -1;
  await hydrateNamedGroups();
  const known = namedGroups.get(label);
  if (known !== undefined) {
    try {
      await chrome.tabGroups.get(known);
      return known;
    } catch {
      await purgeNamedGroupEntry(label);
    }
  }
  const title = groupTitleFor(label);
  const groups = await chrome.tabGroups.query({}).catch(() => []);
  const match = groups.find((g) => g.title === title);
  if (match) {
    namedGroups.set(label, match.id);
    await persistNamedGroups();
    return match.id;
  }
  return -1;
}
function addTabToNamedGroup(tabId, label, colorOverride) {
  return serializeGroupAdd(label, () => addTabToNamedGroupSerialized(tabId, label, colorOverride));
}
async function addTabToNamedGroupSerialized(tabId, label, colorOverride) {
  if (!hasTabGroupApi() || typeof chrome.tabs.group !== "function")
    return -1;
  if (!await isTabInNormalWindow(tabId))
    return -1;
  let groupId = await ensureNamedGroup(label);
  try {
    if (groupId === -1) {
      groupId = await chrome.tabs.group({ tabIds: tabId });
      const color = typeof colorOverride === "string" && VALID_COLORS.includes(colorOverride) ? normalizeColor(colorOverride) : colorForLabel(label);
      await chrome.tabGroups.update(groupId, {
        title: groupTitleFor(label),
        color
      });
      namedGroups.set(label, groupId);
      await persistNamedGroups();
    } else {
      await chrome.tabs.group({ tabIds: tabId, groupId });
    }
  } catch (err) {
    console.warn(`addTabToNamedGroup: skipping group '${label}' (tab=${tabId}):`, err);
    return -1;
  }
  return groupId;
}
async function isTabInNamedGroup(tabId, label) {
  if (!hasTabGroupApi())
    return true;
  const groupId = await ensureNamedGroup(label);
  if (groupId === -1)
    return false;
  const tab = await chrome.tabs.get(tabId);
  return tab.groupId === groupId;
}
async function isTabInAnyManagedGroup(tabId) {
  if (!hasTabGroupApi())
    return true;
  const tab = await chrome.tabs.get(tabId);
  if (interceptorGroupId === null)
    await ensureInterceptorGroup();
  if (interceptorGroupId !== null && tab.groupId === interceptorGroupId)
    return true;
  await hydrateNamedGroups();
  for (const gid of namedGroups.values()) {
    if (tab.groupId === gid)
      return true;
  }
  return false;
}
function anyManagedGroupKnown() {
  return interceptorGroupId !== null || namedGroups.size > 0;
}
function labelForGroupId(groupId) {
  for (const [label, gid] of namedGroups) {
    if (gid === groupId)
      return label;
  }
  return null;
}
async function ensureInterceptorGroup() {
  if (!hasTabGroupApi())
    return -1;
  if (interceptorGroupId !== null) {
    try {
      await chrome.tabGroups.get(interceptorGroupId);
      return interceptorGroupId;
    } catch {
      interceptorGroupId = null;
    }
  }
  const candidates = await getCandidateTitles();
  const groups = await chrome.tabGroups.query({}).catch(() => []);
  const match = groups.find((g) => typeof g.title === "string" && candidates.includes(g.title));
  if (match) {
    interceptorGroupId = match.id;
    return interceptorGroupId;
  }
  return -1;
}
var groupAddChains = new Map;
function serializeGroupAdd(key, op) {
  const prev = groupAddChains.get(key) ?? Promise.resolve(-1);
  const next = prev.then(op, op);
  groupAddChains.set(key, next);
  next.finally(() => {
    if (groupAddChains.get(key) === next)
      groupAddChains.delete(key);
  }).catch(() => {});
  return next;
}
function addTabToInterceptorGroup(tabId) {
  return serializeGroupAdd("", () => addTabToInterceptorGroupSerialized(tabId));
}
async function addTabToInterceptorGroupSerialized(tabId) {
  let groupId = await ensureInterceptorGroup();
  if (groupId === -1 && (!hasTabGroupApi() || typeof chrome.tabs.group !== "function"))
    return -1;
  if (!await isTabInNormalWindow(tabId))
    return -1;
  try {
    if (groupId === -1) {
      groupId = await chrome.tabs.group({ tabIds: tabId });
      await chrome.tabGroups.update(groupId, {
        title: getTabGroupTitle(),
        color: getTabGroupColor()
      });
      interceptorGroupId = groupId;
    } else {
      await chrome.tabs.group({ tabIds: tabId, groupId });
    }
  } catch (err) {
    console.warn(`addTabToInterceptorGroup: skipping group (tab=${tabId}):`, err);
    return -1;
  }
  return groupId;
}
var SENSITIVE_ACTIONS = new Set([
  "evaluate",
  "cookies_get",
  "cookies_set",
  "cookies_delete",
  "storage_read",
  "storage_write",
  "storage_delete"
]);
async function verifyTabUrl(tabId, expectedUrl) {
  if (!expectedUrl)
    return null;
  const tab = await chrome.tabs.get(tabId);
  if (tab.url && tab.url !== expectedUrl) {
    return `tab URL changed since last state read — expected ${expectedUrl}, got ${tab.url}`;
  }
  return null;
}

// shared/content-script-retry.ts
function shouldRetryContentScript(error) {
  if (!error)
    return false;
  return error.includes("Receiving end does not exist") || error.includes("Could not establish connection") || error.includes("disconnected port") || error.includes("message channel is closed") || error.includes("no response from content script");
}
var INPUT_ACTIONS = new Set([
  "click",
  "click_selector",
  "click_at",
  "dblclick",
  "rightclick",
  "drag",
  "input_text",
  "send_keys",
  "select_option",
  "check",
  "file_upload",
  "file_upload_chunk",
  "find_and_click",
  "find_and_type",
  "find_and_check",
  "scene_click",
  "scene_dblclick",
  "scene_select",
  "scene_insert"
]);
function isResponseLoss(error) {
  if (!error)
    return false;
  return error.includes("message channel is closed") || error.includes("disconnected port") || error.includes("no response from content script");
}

// extension/src/background/content-bridge.ts
async function injectContentScript(tabId, frameId) {
  try {
    const target = frameId !== undefined ? { tabId, frameIds: [frameId] } : { tabId };
    await chrome.scripting.executeScript({ target, files: ["content.js"] });
    await new Promise((resolve) => setTimeout(resolve, 200));
    return { success: true };
  } catch (err) {
    return { success: false, error: err.message };
  }
}
var NAVIGATION_CAPABLE_ACTIONS = new Set(["click", "click_at", "dblclick", "find_and_click", "click_selector"]);
async function sendToContentScriptOnce(tabId, action, frameId) {
  const watchesNavigation = NAVIGATION_CAPABLE_ACTIONS.has(action.type);
  let initialUrl;
  if (watchesNavigation) {
    try {
      initialUrl = (await chrome.tabs.get(tabId)).url;
    } catch {}
  }
  return new Promise((resolve) => {
    let settled = false;
    let navigationFailureTimer = null;
    let navigationListener = null;
    const finish = (result) => {
      if (settled)
        return;
      settled = true;
      if (navigationFailureTimer)
        clearTimeout(navigationFailureTimer);
      if (navigationListener)
        chrome.tabs.onUpdated.removeListener(navigationListener);
      resolve(result);
    };
    const navigationResult = (url) => ({
      success: true,
      data: { navigated: true, url }
    });
    if (watchesNavigation) {
      navigationListener = (updatedTabId, changeInfo, tab) => {
        if (updatedTabId !== tabId)
          return;
        if (changeInfo.status !== "loading" && typeof changeInfo.url !== "string")
          return;
        finish(navigationResult(changeInfo.url ?? tab.url));
      };
      chrome.tabs.onUpdated.addListener(navigationListener);
    }
    const targetFrame = frameId !== undefined ? frameId : 0;
    chrome.tabs.sendMessage(tabId, { type: "execute_action", action }, { frameId: targetFrame }, (response) => {
      if (chrome.runtime.lastError) {
        const error = chrome.runtime.lastError.message;
        if (watchesNavigation && shouldRetryContentScript(error)) {
          navigationFailureTimer = setTimeout(async () => {
            try {
              const tab = await chrome.tabs.get(tabId);
              if (tab.status === "loading" || typeof initialUrl === "string" && typeof tab.url === "string" && tab.url !== initialUrl) {
                finish(navigationResult(tab.url));
                return;
              }
            } catch {}
            finish({ success: false, error });
          }, 250);
        } else {
          finish({ success: false, error });
        }
      } else {
        finish(response ?? { success: false, error: "no response from content script" });
      }
    });
  });
}
function isChromeRestrictedInjectError(error) {
  if (!error)
    return false;
  return /Cannot access (?:contents of )?(?:url|chrome|edge|brave|webstore)/i.test(error) || /chrome:\/\/|chrome-untrusted:\/\/|edge:\/\/|brave:\/\//i.test(error) || /chromewebstore\.google\.com|chrome\.google\.com\/webstore/i.test(error) || /Extensions cannot be added to/i.test(error);
}
async function sendToContentScript(tabId, action, frameId) {
  const first = await sendToContentScriptOnce(tabId, action, frameId);
  if (first.success || !shouldRetryContentScript(first.error))
    return first;
  if (INPUT_ACTIONS.has(action.type) && isResponseLoss(first.error)) {
    let navigating = false;
    try {
      navigating = (await chrome.tabs.get(tabId)).status === "loading";
    } catch {}
    if (navigating) {
      return {
        success: true,
        data: `${action.type} delivered; the page began navigating before the reply arrived`,
        warning: "reply channel closed during navigation — re-read page state to confirm the outcome"
      };
    }
    return {
      success: false,
      error: `${action.type} was delivered but the reply channel closed (${first.error}) — not auto-retried to avoid firing it twice; re-read page state to confirm the outcome, then retry deliberately`
    };
  }
  await new Promise((resolve) => setTimeout(resolve, 250));
  const retryWithoutInject = await sendToContentScriptOnce(tabId, action, frameId);
  if (retryWithoutInject.success)
    return retryWithoutInject;
  const injected = await injectContentScript(tabId, frameId);
  if (!injected.success) {
    if (isChromeRestrictedInjectError(injected.error)) {
      return {
        success: false,
        error: `tab ${tabId} has no content script and could not be re-injected (likely a chrome://, edge://, brave://, or Chrome Web Store page). Use 'interceptor open <url>' for a fresh tab.`
      };
    }
    return {
      success: false,
      error: `content script unavailable on tab ${tabId} and reinjection failed: ${injected.error}`
    };
  }
  const retried = await sendToContentScriptOnce(tabId, action, frameId);
  if (retried.success)
    return retried;
  return {
    success: false,
    error: `content script re-injected on tab ${tabId} but action still failed: ${retried.error || "unknown error"}`
  };
}
async function sendNetDirect(tabId, msg) {
  const sendOnce = () => new Promise((resolve) => {
    chrome.tabs.sendMessage(tabId, msg, { frameId: 0 }, (response) => {
      if (chrome.runtime.lastError) {
        resolve({ success: false, error: chrome.runtime.lastError.message });
      } else {
        resolve(response ?? { success: false, error: "no response from content script" });
      }
    });
  });
  const first = await sendOnce();
  if (first.success || !shouldRetryContentScript(first.error))
    return first;
  const injected = await injectContentScript(tabId, 0);
  if (!injected.success) {
    return {
      success: false,
      error: `content script unavailable on tab ${tabId} and reinjection failed: ${injected.error}`
    };
  }
  const retried = await sendOnce();
  if (retried.success)
    return retried;
  return {
    success: false,
    error: `content script re-injected on tab ${tabId} but message still failed: ${retried.error || "unknown error"}`
  };
}
function waitForTabLoad(tabId, timeoutMs = 15000) {
  return new Promise((resolve) => {
    const start = Date.now();
    const stage1Timeout = Math.min(timeoutMs, 1e4);
    const hardTimer = setTimeout(async () => {
      chrome.tabs.onUpdated.removeListener(listener);
      const probeResult = await probeContentReady(tabId, Math.max(timeoutMs - (Date.now() - start), 1000));
      resolve({ ready: probeResult, elapsed: Date.now() - start });
    }, timeoutMs);
    function listener(updatedTabId, changeInfo) {
      if (updatedTabId === tabId && changeInfo.status === "complete") {
        clearTimeout(hardTimer);
        chrome.tabs.onUpdated.removeListener(listener);
        const remaining = Math.max(timeoutMs - (Date.now() - start), 2000);
        probeContentReady(tabId, remaining).then((ready) => {
          resolve({ ready, elapsed: Date.now() - start });
        });
      }
    }
    chrome.tabs.onUpdated.addListener(listener);
    setTimeout(async () => {
      const tab = await chrome.tabs.get(tabId).catch(() => null);
      if (tab && tab.status === "complete") {
        chrome.tabs.onUpdated.removeListener(listener);
        clearTimeout(hardTimer);
        const remaining = Math.max(timeoutMs - (Date.now() - start), 2000);
        const ready = await probeContentReady(tabId, remaining);
        resolve({ ready, elapsed: Date.now() - start });
      }
    }, stage1Timeout);
  });
}
async function probeContentReady(tabId, timeoutMs) {
  try {
    const result = await sendToContentScript(tabId, {
      type: "wait_stable",
      ms: 500,
      timeout: Math.min(timeoutMs, 5000)
    });
    return result.success && (result.data?.stable ?? true);
  } catch {
    return false;
  }
}

// extension/src/background/network-capture.ts
var networkCaptureConfigs = new Map;
var networkCaptureLogs = new Map;
var pendingNetworkEntries = new Map;
var networkOverrideConfigs = new Map;
var fetchInterceptionEnabled = new Set;
function getNetworkLogs(tabId) {
  const logs = networkCaptureLogs.get(tabId);
  if (logs)
    return logs;
  const next = [];
  networkCaptureLogs.set(tabId, next);
  return next;
}
function clearNetworkLogs(tabId) {
  networkCaptureLogs.set(tabId, []);
  for (const key of Array.from(pendingNetworkEntries.keys())) {
    if (key.startsWith(`${tabId}:`))
      pendingNetworkEntries.delete(key);
  }
}
async function ensureDebuggerSession(tabId) {
  if (debuggerAttached.has(tabId))
    return;
  await chrome.debugger.attach({ tabId }, "1.3");
  debuggerAttached.add(tabId);
}
async function refreshFetchInterception(tabId) {
  const hasOverrides = (networkOverrideConfigs.get(tabId)?.length || 0) > 0;
  await ensureDebuggerSession(tabId);
  if (hasOverrides && !fetchInterceptionEnabled.has(tabId)) {
    await chrome.debugger.sendCommand({ tabId }, "Fetch.enable", {
      patterns: [{ urlPattern: "*", requestStage: "Request" }]
    });
    fetchInterceptionEnabled.add(tabId);
    return;
  }
  if (!hasOverrides && fetchInterceptionEnabled.has(tabId)) {
    try {
      await chrome.debugger.sendCommand({ tabId }, "Fetch.disable");
    } catch {}
    fetchInterceptionEnabled.delete(tabId);
  }
}
async function enableNetworkCapture(tabId, patterns) {
  await ensureDebuggerSession(tabId);
  await chrome.debugger.sendCommand({ tabId }, "Network.enable", {
    maxTotalBufferSize: 1e7,
    maxResourceBufferSize: 2000000
  });
  networkCaptureConfigs.set(tabId, { enabled: true, patterns, startedAt: Date.now() });
  clearNetworkLogs(tabId);
}
async function disableNetworkCapture(tabId) {
  networkCaptureConfigs.set(tabId, {
    enabled: false,
    patterns: networkCaptureConfigs.get(tabId)?.patterns || [],
    startedAt: networkCaptureConfigs.get(tabId)?.startedAt || Date.now()
  });
  try {
    await chrome.debugger.sendCommand({ tabId }, "Network.disable");
  } catch {}
}

// extension/src/background/cdp.ts
var debuggerAttached = new Set;
async function cdpCommand(tabId, method, params) {
  const target = { tabId };
  const isAttached = debuggerAttached.has(tabId);
  if (!isAttached) {
    await chrome.debugger.attach(target, "1.3");
    debuggerAttached.add(tabId);
  }
  try {
    const result = await chrome.debugger.sendCommand(target, method, params);
    return result;
  } finally {
    if (!isAttached) {
      try {
        await chrome.debugger.detach(target);
        debuggerAttached.delete(tabId);
      } catch {}
    }
  }
}
async function cdpAttachActDetach(tabId, method, params) {
  try {
    const result = await cdpCommand(tabId, method, params);
    return { success: true, data: result };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

// extension/src/background/capabilities/os-input.ts
var FOREGROUND_HINT = "trusted OS input needs the target tab visible in the OS-focused window — " + "`interceptor tab switch <id>` foregrounds it (explicit focus-moving opt-in), " + "or drop --trusted for background-safe synthetic input";
async function requireForegroundTab(tabId) {
  const tab = await chrome.tabs.get(tabId).catch(() => null);
  if (!tab) {
    return { ok: false, result: { success: false, error: `tab ${tabId} not found` } };
  }
  const win = await chrome.windows.get(tab.windowId).catch(() => null);
  if (!win) {
    return { ok: false, result: { success: false, error: `window ${tab.windowId} not found for tab ${tabId}` } };
  }
  if (win.state === "minimized") {
    return { ok: false, result: {
      success: false,
      error: `window ${tab.windowId} is minimized — trusted OS input needs on-screen pixels to hit`,
      data: { hint: FOREGROUND_HINT, windowState: win.state }
    } };
  }
  if (!tab.active) {
    return { ok: false, result: {
      success: false,
      error: `tab ${tabId} is not the active tab of window ${tab.windowId} — a trusted OS event would hit the window's visible tab instead`,
      data: { hint: FOREGROUND_HINT }
    } };
  }
  if (!win.focused) {
    return { ok: false, result: {
      success: false,
      error: `window ${tab.windowId} is not the OS-focused window — trusted OS events are routed by the OS to whatever is frontmost, not to the target tab`,
      data: { hint: FOREGROUND_HINT }
    } };
  }
  return { ok: true, windowBounds: {
    left: win.left || 0,
    top: win.top || 0,
    width: win.width || 0,
    height: win.height || 0
  } };
}
async function handleOsInputActions(action, tabId) {
  switch (action.type) {
    case "os_click": {
      const fg = await requireForegroundTab(tabId);
      if (!fg.ok)
        return fg.result;
      const windowBounds = fg.windowBounds;
      let pageX = action.x;
      let pageY = action.y;
      if ((action.index !== undefined || action.ref) && (pageX === undefined || pageY === undefined)) {
        const rectResult = await sendToContentScript(tabId, {
          type: "rect",
          index: action.index,
          ref: action.ref
        });
        if (!rectResult.success || !rectResult.data) {
          return { success: false, error: "failed to get element coordinates for os_click" };
        }
        const rect = rectResult.data;
        pageX = rect.left + rect.width / 2;
        pageY = rect.top + rect.height / 2;
      }
      if (pageX === undefined || pageY === undefined) {
        return { success: false, error: "os_click requires element target or x,y coordinates" };
      }
      const chromeUiHeight = action.chromeUiHeight || 88 + (debuggerAttached.has(tabId) ? 35 : 0);
      return {
        success: true,
        data: {
          method: "os_event",
          screenTarget: { pageX, pageY },
          windowBounds,
          button: action.button || "left",
          clickCount: action.clickCount || 1,
          chromeUiHeight
        }
      };
    }
    case "os_key": {
      const fg = await requireForegroundTab(tabId);
      if (!fg.ok)
        return fg.result;
      return { success: true, data: { method: "os_event", key: action.key, modifiers: action.modifiers || [] } };
    }
    case "os_type": {
      const fg = await requireForegroundTab(tabId);
      if (!fg.ok)
        return fg.result;
      if (action.index !== undefined || action.ref) {
        await sendToContentScript(tabId, { type: "focus", index: action.index, ref: action.ref });
        await new Promise((r) => setTimeout(r, 50));
      }
      return { success: true, data: { method: "os_event", text: action.text } };
    }
    case "os_move": {
      const fg = await requireForegroundTab(tabId);
      if (!fg.ok)
        return fg.result;
      const windowBounds = fg.windowBounds;
      const chromeUiHeight = action.chromeUiHeight || 88 + (debuggerAttached.has(tabId) ? 35 : 0);
      return {
        success: true,
        data: {
          method: "os_event",
          path: action.path,
          windowBounds,
          duration: action.duration || 100,
          chromeUiHeight
        }
      };
    }
  }
  return { success: false, error: `unknown os_input action: ${action.type}` };
}

// extension/src/background/offscreen.ts
var OFFSCREEN_IDLE_MS = 30000;
var offscreenIdleTimer = null;
async function ensureOffscreen() {
  const contexts = await chrome.runtime.getContexts({
    contextTypes: ["OFFSCREEN_DOCUMENT"]
  });
  if (contexts.length > 0) {
    resetOffscreenTimer();
    return;
  }
  await chrome.offscreen.createDocument({
    url: "offscreen.html",
    reasons: ["BLOBS"],
    justification: "Image crop, stitch, and diff operations"
  });
  resetOffscreenTimer();
}
function resetOffscreenTimer() {
  if (offscreenIdleTimer)
    clearTimeout(offscreenIdleTimer);
  offscreenIdleTimer = setTimeout(async () => {
    try {
      await chrome.offscreen.closeDocument();
    } catch {}
    offscreenIdleTimer = null;
  }, OFFSCREEN_IDLE_MS);
}
async function sendToOffscreen(msg) {
  await ensureOffscreen();
  return new Promise((resolve) => {
    chrome.runtime.sendMessage({ ...msg, target: "offscreen" }, resolve);
  });
}

// extension/src/background/capabilities/screenshot-cors.ts
var SCREENSHOT_CORS_RULE_ID_BASE = 920000;
function buildScreenshotCorsRule(tabId) {
  return {
    id: SCREENSHOT_CORS_RULE_ID_BASE + tabId,
    priority: 10,
    action: {
      type: "modifyHeaders",
      responseHeaders: [
        { header: "access-control-allow-origin", operation: "set", value: "*" },
        { header: "access-control-allow-credentials", operation: "remove" },
        { header: "cross-origin-resource-policy", operation: "set", value: "cross-origin" }
      ]
    },
    condition: {
      tabIds: [tabId],
      resourceTypes: [
        "image",
        "font",
        "media",
        "stylesheet",
        "xmlhttprequest"
      ]
    }
  };
}
var corsRuleRefcount = new Map;
async function installScreenshotCorsRule(tabId) {
  const prev = corsRuleRefcount.get(tabId) ?? 0;
  corsRuleRefcount.set(tabId, prev + 1);
  if (prev === 0) {
    const rule = buildScreenshotCorsRule(tabId);
    try {
      await chrome.declarativeNetRequest.updateSessionRules({
        removeRuleIds: [rule.id],
        addRules: [rule]
      });
    } catch (err) {
      const cur = corsRuleRefcount.get(tabId) ?? 0;
      if (cur <= 1)
        corsRuleRefcount.delete(tabId);
      else
        corsRuleRefcount.set(tabId, cur - 1);
      throw err;
    }
  }
}
async function uninstallScreenshotCorsRule(tabId) {
  const prev = corsRuleRefcount.get(tabId) ?? 0;
  if (prev > 1) {
    corsRuleRefcount.set(tabId, prev - 1);
    return;
  }
  corsRuleRefcount.delete(tabId);
  const ruleId = SCREENSHOT_CORS_RULE_ID_BASE + tabId;
  try {
    await chrome.declarativeNetRequest.updateSessionRules({
      removeRuleIds: [ruleId]
    });
  } catch {}
}

// extension/src/background/capabilities/screenshot.ts
var CAPTURE_TIMEOUT_MS = 5000;
var DOM_RENDER_TIMEOUT_MS = 30000;
var VISIBILITY_HINT = "Chrome/Brave window may not be visible — bring it to the front and retry, or pass --tab <id> of a tab in a visible window.";

class CaptureTimeoutError extends Error {
  operation;
  timeoutMs;
  constructor(operation, timeoutMs) {
    super(`${operation} timed out after ${timeoutMs}ms`);
    this.name = "CaptureTimeoutError";
    this.operation = operation;
    this.timeoutMs = timeoutMs;
  }
}
function withCaptureTimeout(operation, p, ms = CAPTURE_TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new CaptureTimeoutError(operation, ms)), ms);
    p.then((val) => {
      clearTimeout(timer);
      resolve(val);
    }, (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}
function mimeTypeForFormat(format) {
  if (format === "webp")
    return "image/webp";
  if (format === "png")
    return "image/png";
  return "image/jpeg";
}
async function withCaptureVisibleTabFocus(tabId, windowId, fn) {
  const [priorActive] = await chrome.tabs.query({ active: true, windowId });
  const targetAlreadyActive = priorActive?.id === tabId;
  if (!targetAlreadyActive) {
    try {
      await chrome.tabs.update(tabId, { active: true });
    } catch {}
  }
  try {
    return await fn();
  } finally {
    if (!targetAlreadyActive && typeof priorActive?.id === "number" && priorActive.id !== tabId) {
      await chrome.tabs.update(priorActive.id, { active: true }).catch(() => {
        return;
      });
    }
  }
}
async function stitchStripsInWorker(strips, totalWidth, totalHeight, format, quality, scale = 1) {
  try {
    const outWidth = Math.max(1, Math.round(totalWidth * scale));
    const outHeight = Math.max(1, Math.round(totalHeight * scale));
    const canvas = new OffscreenCanvas(outWidth, outHeight);
    const ctx = canvas.getContext("2d");
    if (!ctx)
      return null;
    for (const strip of strips) {
      const res = await fetch(strip.dataUrl);
      const blob = await res.blob();
      const bmp = await createImageBitmap(blob);
      const dx = 0;
      const dy = Math.round(strip.y * scale);
      const dw = Math.round(bmp.width * scale);
      const dh = Math.round(bmp.height * scale);
      ctx.drawImage(bmp, 0, 0, bmp.width, bmp.height, dx, dy, dw, dh);
      bmp.close?.();
    }
    const mime = mimeTypeForFormat(format);
    const outBlob = await canvas.convertToBlob({ type: mime, quality });
    const buf = await outBlob.arrayBuffer();
    let binary = "";
    const bytes = new Uint8Array(buf);
    const chunk = 32768;
    for (let i = 0;i < bytes.length; i += chunk) {
      binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
    }
    const b64 = btoa(binary);
    return `data:${mime};base64,${b64}`;
  } catch (err) {
    console.error("[stitchStripsInWorker] failed:", err);
    return null;
  }
}
function resolveDomMode(action) {
  if (typeof action.selector === "string")
    return "selector";
  if (action.element !== undefined || typeof action.ref === "string")
    return "element";
  if (action.region || action.clip)
    return "region";
  return "full";
}
async function reencodeAsWebP(dataUrl, qualityPct) {
  const res = await fetch(dataUrl);
  const blob = await res.blob();
  const bmp = await createImageBitmap(blob);
  try {
    const canvas = new OffscreenCanvas(bmp.width, bmp.height);
    const ctx = canvas.getContext("2d");
    if (!ctx)
      throw new Error("OffscreenCanvas 2d context unavailable");
    ctx.drawImage(bmp, 0, 0);
    const out = await canvas.convertToBlob({ type: "image/webp", quality: Math.max(0, Math.min(1, qualityPct / 100)) });
    const buf = await out.arrayBuffer();
    let binary = "";
    const bytes = new Uint8Array(buf);
    for (let i = 0;i < bytes.length; i += 32768) {
      binary += String.fromCharCode(...bytes.subarray(i, i + 32768));
    }
    return `data:image/webp;base64,${btoa(binary)}`;
  } finally {
    bmp.close?.();
  }
}
async function handleDomRenderScreenshot(action, tabId) {
  const mode = resolveDomMode(action);
  const requestedFormat = action.format === "webp" ? "webp" : action.format === "jpeg" ? "jpeg" : "png";
  const renderFormat = requestedFormat === "webp" ? "png" : requestedFormat;
  const quality = typeof action.quality === "number" ? action.quality : 92;
  const webpQuality = typeof action.quality === "number" ? action.quality : 85;
  const scale = typeof action.scale === "number" ? action.scale : undefined;
  const targetMaxLongEdge = typeof action.target_max_long_edge === "number" ? action.target_max_long_edge : undefined;
  const region = action.region || action.clip;
  const targetTab = await chrome.tabs.get(tabId).catch(() => null);
  if (!targetTab) {
    return { success: false, error: `tab ${tabId} not found` };
  }
  const renderWindow = await chrome.windows.get(targetTab.windowId, { populate: false }).catch(() => null);
  if (renderWindow && renderWindow.state === "minimized") {
    return {
      success: false,
      error: `window ${targetTab.windowId} is minimized — DOM-render requires the window to be non-minimized`,
      data: { hint: VISIBILITY_HINT, layer: "preflight", windowState: renderWindow.state }
    };
  }
  await installScreenshotCorsRule(tabId);
  try {
    const dsAction = { type: "dom_screenshot", mode, format: renderFormat, quality };
    if (action.ref !== undefined)
      dsAction.ref = action.ref;
    if (action.element !== undefined)
      dsAction.index = action.element;
    if (action.selector !== undefined)
      dsAction.selector = action.selector;
    if (region)
      dsAction.region = region;
    if (scale !== undefined)
      dsAction.scale = scale;
    if (targetMaxLongEdge !== undefined)
      dsAction.target_max_long_edge = targetMaxLongEdge;
    let renderResult;
    try {
      renderResult = await withCaptureTimeout("dom-render", sendToContentScript(tabId, dsAction), DOM_RENDER_TIMEOUT_MS);
    } catch (err) {
      if (err instanceof CaptureTimeoutError) {
        return {
          success: false,
          error: `DOM-render timed out after ${DOM_RENDER_TIMEOUT_MS}ms — the content script did not return image data. The render stalled (e.g. a resource never settled); retry, or use --pixel for a compositor capture.`,
          data: { layer: "dom-render-timeout" }
        };
      }
      throw err;
    }
    if (!renderResult || !renderResult.success || !renderResult.data) {
      return { success: false, error: renderResult?.error || "dom render returned no data", fallbackEligible: true };
    }
    let dataUrl = renderResult.data.dataUrl;
    const width = renderResult.data.width;
    const height = renderResult.data.height;
    let outputFormat = renderResult.data.format;
    if (requestedFormat === "webp") {
      try {
        dataUrl = await withCaptureTimeout("webp-reencode", reencodeAsWebP(dataUrl, webpQuality), DOM_RENDER_TIMEOUT_MS);
        outputFormat = "webp";
      } catch (err) {
        if (err instanceof CaptureTimeoutError) {
          return { success: false, error: `webp re-encode timed out after ${DOM_RENDER_TIMEOUT_MS}ms — the rendered page was too large to re-encode in time` };
        }
        return { success: false, error: `webp re-encode failed: ${err.message}` };
      }
    }
    const sizeBytes = Math.round((dataUrl.length - dataUrl.indexOf(",") - 1) * 0.75);
    if (action.save) {
      return { success: true, data: { dataUrl, format: outputFormat, size: sizeBytes, width, height, mode, save: true } };
    }
    return { success: true, data: { dataUrl, format: outputFormat, size: sizeBytes, width, height, mode } };
  } finally {
    await uninstallScreenshotCorsRule(tabId);
  }
}
async function handleScreenshotBackground(action, tabId) {
  const format = action.format === "png" ? "image/png" : "image/jpeg";
  const quality = (action.quality || 50) / 100;
  try {
    const streamId = await withCaptureTimeout("tabCapture.getMediaStreamId", chrome.tabCapture.getMediaStreamId({ targetTabId: tabId }));
    const contexts = await chrome.runtime.getContexts({
      contextTypes: ["OFFSCREEN_DOCUMENT"]
    });
    if (contexts.length === 0) {
      await withCaptureTimeout("offscreen.createDocument", chrome.offscreen.createDocument({
        url: "offscreen.html",
        reasons: ["USER_MEDIA"],
        justification: "Background tab screenshot via tabCapture"
      }));
    }
    await withCaptureTimeout("offscreen.capture_start", new Promise((resolve) => {
      chrome.runtime.sendMessage({ target: "offscreen", type: "capture_start", streamId }, () => resolve());
    }));
    await new Promise((r) => setTimeout(r, 300));
    const frameResult = await withCaptureTimeout("offscreen.capture_frame", sendToOffscreen({ type: "capture_frame", format, quality }));
    await withCaptureTimeout("offscreen.capture_stop", sendToOffscreen({ type: "capture_stop" })).catch(() => {
      return;
    });
    if (!frameResult.success)
      return { success: false, error: frameResult.error || "capture frame failed" };
    const dataUrl = frameResult.data;
    const sizeBytes = Math.round((dataUrl.length - dataUrl.indexOf(",") - 1) * 0.75);
    return { success: true, data: { dataUrl, format: action.format || "jpeg", size: sizeBytes, method: "tabCapture" } };
  } catch (err) {
    if (err instanceof CaptureTimeoutError) {
      return {
        success: false,
        error: `tabCapture timed out at ${err.operation} (${err.timeoutMs}ms)`,
        data: { hint: VISIBILITY_HINT, layer: "tabCapture", timedOutAt: err.operation }
      };
    }
    return { success: false, error: `tabCapture failed: ${err.message}` };
  }
}
async function handlePixelScreenshot(action, tabId) {
  const requestedFormat = action.format === "webp" ? "webp" : action.format === "png" ? "png" : "jpeg";
  const captureFormat = requestedFormat === "webp" ? "png" : requestedFormat;
  const quality = action.quality || 50;
  const targetMaxLongEdge = typeof action.target_max_long_edge === "number" ? action.target_max_long_edge : undefined;
  if (action.full) {
    const dims = await sendToContentScript(tabId, { type: "get_page_dimensions" });
    if (!dims.success || !dims.data)
      return { success: false, error: "failed to get page dimensions" };
    const { scrollHeight, viewportHeight, viewportWidth, scrollY: origScrollY, devicePixelRatio } = dims.data;
    const stripCount = Math.ceil(scrollHeight / viewportHeight);
    const strips = [];
    const fullTab = await chrome.tabs.get(tabId).catch(() => null);
    if (!fullTab)
      return { success: false, error: `tab ${tabId} not found`, data: { hint: VISIBILITY_HINT } };
    const fullWindow = await chrome.windows.get(fullTab.windowId, { populate: false }).catch(() => null);
    if (fullWindow && fullWindow.state === "minimized") {
      return {
        success: false,
        error: `window ${fullTab.windowId} is minimized — captureVisibleTab cannot capture minimized windows`,
        data: { hint: VISIBILITY_HINT, layer: "preflight", windowState: fullWindow.state }
      };
    }
    const stripCaptureOutcome = await withCaptureVisibleTabFocus(tabId, fullTab.windowId, async () => {
      for (let i = 0;i < stripCount; i++) {
        const scrollTo = i * viewportHeight;
        await sendToContentScript(tabId, { type: "scroll_absolute", y: scrollTo });
        await new Promise((r) => setTimeout(r, 150));
        let stripUrl;
        try {
          stripUrl = await withCaptureTimeout(`captureVisibleTab(strip ${i + 1}/${stripCount})`, chrome.tabs.captureVisibleTab(fullTab.windowId, { format: captureFormat, quality }));
        } catch (err) {
          await sendToContentScript(tabId, { type: "scroll_absolute", y: origScrollY }).catch(() => {
            return;
          });
          if (err instanceof CaptureTimeoutError) {
            return {
              ok: false,
              error: {
                success: false,
                error: `full-page screenshot failed: ${err.operation} timed out after ${err.timeoutMs}ms`,
                data: { hint: VISIBILITY_HINT, layer: "captureVisibleTab", strip: i + 1, totalStrips: stripCount, timedOutAt: err.operation }
              }
            };
          }
          return {
            ok: false,
            error: { success: false, error: `captureVisibleTab failed on strip ${i + 1}/${stripCount}: ${err.message}` }
          };
        }
        strips.push({ dataUrl: stripUrl, y: Math.round(scrollTo * devicePixelRatio) });
        if (i < stripCount - 1)
          await new Promise((r) => setTimeout(r, 1100));
      }
      await sendToContentScript(tabId, { type: "scroll_absolute", y: origScrollY }).catch(() => {
        return;
      });
      return { ok: true };
    });
    if (!stripCaptureOutcome.ok)
      return stripCaptureOutcome.error;
    const naturalWidth = Math.round(viewportWidth * devicePixelRatio);
    const naturalHeight = Math.round(scrollHeight * devicePixelRatio);
    let stitchScale = 1;
    if (targetMaxLongEdge !== undefined && targetMaxLongEdge > 0) {
      const longEdge = Math.max(naturalWidth, naturalHeight);
      if (longEdge > targetMaxLongEdge)
        stitchScale = targetMaxLongEdge / longEdge;
    }
    const stitchQuality = requestedFormat === "webp" ? (typeof action.quality === "number" ? action.quality : 85) / 100 : quality / 100;
    const stitchedUrl = await stitchStripsInWorker(strips, naturalWidth, naturalHeight, requestedFormat, stitchQuality, stitchScale);
    if (!stitchedUrl)
      return { success: false, error: "stitch failed (could not render strips into OffscreenCanvas)" };
    const stitchedSize = Math.round((stitchedUrl.length - stitchedUrl.indexOf(",") - 1) * 0.75);
    if (action.save) {
      return { success: true, data: { dataUrl: stitchedUrl, format: requestedFormat, size: stitchedSize, save: true, strips: stripCount } };
    }
    return { success: true, data: { dataUrl: stitchedUrl, format: requestedFormat, size: stitchedSize, strips: stripCount } };
  }
  const targetTab = await chrome.tabs.get(tabId).catch(() => null);
  if (!targetTab) {
    return { success: false, error: `tab ${tabId} not found`, data: { hint: VISIBILITY_HINT } };
  }
  const targetWindow = await chrome.windows.get(targetTab.windowId, { populate: false }).catch(() => null);
  if (targetWindow && targetWindow.state === "minimized") {
    return {
      success: false,
      error: `window ${targetTab.windowId} is minimized — captureVisibleTab cannot capture minimized windows`,
      data: { hint: VISIBILITY_HINT, layer: "preflight", windowState: targetWindow.state }
    };
  }
  let dataUrl;
  try {
    dataUrl = await withCaptureVisibleTabFocus(tabId, targetTab.windowId, () => withCaptureTimeout("captureVisibleTab", chrome.tabs.captureVisibleTab(targetTab.windowId, { format: captureFormat, quality })));
  } catch (err) {
    if (err instanceof CaptureTimeoutError) {
      return {
        success: false,
        error: `captureVisibleTab timed out after ${err.timeoutMs}ms`,
        data: { hint: VISIBILITY_HINT, layer: "captureVisibleTab", timedOutAt: err.operation }
      };
    }
    const fallback = await handleScreenshotBackground({ type: "screenshot_background", format: action.format, quality: action.quality }, tabId);
    if (fallback.success && fallback.data) {
      fallback.data.fallback = "tabCapture (captureVisibleTab failed)";
    }
    return fallback;
  }
  let clip = action.clip;
  if (!clip && action.element !== undefined) {
    const elemResult = await sendToContentScript(tabId, {
      type: "rect",
      index: action.element
    });
    if (elemResult.success && elemResult.data)
      clip = elemResult.data;
  }
  if (clip) {
    const cropResult = await sendToOffscreen({ type: "crop", dataUrl, clip });
    if (!cropResult.success)
      return { success: false, error: cropResult.error };
    dataUrl = cropResult.data;
  }
  const transformed = await transformPixelDataUrl(dataUrl, requestedFormat, action.quality, targetMaxLongEdge);
  if (!transformed.success)
    return { success: false, error: transformed.error || "post-capture transform failed" };
  const finalUrl = transformed.dataUrl;
  const finalSize = Math.round((finalUrl.length - finalUrl.indexOf(",") - 1) * 0.75);
  if (action.save) {
    return { success: true, data: { dataUrl: finalUrl, format: requestedFormat, size: finalSize, save: true } };
  }
  if (clip) {
    return { success: true, data: { dataUrl: finalUrl, format: requestedFormat, size: finalSize, clip } };
  }
  if (requestedFormat === "png" && finalSize > 800 * 1024) {
    return {
      success: true,
      data: { dataUrl: finalUrl, format: requestedFormat, size: finalSize, warning: "PNG exceeds 800KB — consider using JPEG or WebP for smaller responses" }
    };
  }
  return { success: true, data: { dataUrl: finalUrl, format: requestedFormat, size: finalSize } };
}
async function transformPixelDataUrl(dataUrl, requestedFormat, quality, targetMaxLongEdge) {
  const currentMime = dataUrl.startsWith("data:image/webp") ? "webp" : dataUrl.startsWith("data:image/png") ? "png" : "jpeg";
  const formatChange = currentMime !== requestedFormat;
  const needsDownsample = targetMaxLongEdge !== undefined && targetMaxLongEdge > 0;
  if (!formatChange && !needsDownsample) {
    return { success: true, dataUrl };
  }
  try {
    const res = await fetch(dataUrl);
    const blob = await res.blob();
    const bmp = await createImageBitmap(blob);
    try {
      let scale = 1;
      if (needsDownsample) {
        const longEdge = Math.max(bmp.width, bmp.height);
        if (longEdge > targetMaxLongEdge)
          scale = targetMaxLongEdge / longEdge;
      }
      const outWidth = Math.max(1, Math.round(bmp.width * scale));
      const outHeight = Math.max(1, Math.round(bmp.height * scale));
      const canvas = new OffscreenCanvas(outWidth, outHeight);
      const ctx = canvas.getContext("2d");
      if (!ctx)
        return { success: false, error: "OffscreenCanvas 2d context unavailable" };
      ctx.drawImage(bmp, 0, 0, bmp.width, bmp.height, 0, 0, outWidth, outHeight);
      const mime = mimeTypeForFormat(requestedFormat);
      const encodeQuality = requestedFormat === "webp" ? Math.max(0, Math.min(1, (typeof quality === "number" ? quality : 85) / 100)) : Math.max(0, Math.min(1, (typeof quality === "number" ? quality : 50) / 100));
      const outBlob = await canvas.convertToBlob({ type: mime, quality: encodeQuality });
      const buf = await outBlob.arrayBuffer();
      let binary = "";
      const bytes = new Uint8Array(buf);
      for (let i = 0;i < bytes.length; i += 32768) {
        binary += String.fromCharCode(...bytes.subarray(i, i + 32768));
      }
      return { success: true, dataUrl: `data:${mime};base64,${btoa(binary)}` };
    } finally {
      bmp.close?.();
    }
  } catch (err) {
    return { success: false, error: `transform failed: ${err.message}` };
  }
}
async function handleOcr(action, tabId) {
  const shot = { type: "screenshot", format: "png", save: false };
  for (const k of ["selector", "element", "ref", "region", "clip", "scale", "target_max_long_edge"]) {
    if (action[k] !== undefined)
      shot[k] = action[k];
  }
  const rendered = await handleDomRenderScreenshot(shot, tabId);
  if (!rendered.success)
    return rendered;
  const dataUrl = rendered.data?.dataUrl;
  if (!dataUrl)
    return { success: false, error: "capture for OCR produced no image" };
  const ocr = await sendToOffscreen({ type: "ocr", dataUrl });
  if (!ocr.success)
    return { success: false, error: ocr.error || "OCR failed" };
  return {
    success: true,
    data: {
      text: (ocr.data?.text || "").trim(),
      source: ocr.data?.source || "tesseract",
      confidence: ocr.data?.confidence ?? null,
      width: rendered.data?.width,
      height: rendered.data?.height
    }
  };
}
function planPixelFallback(action, domResult) {
  if (action.no_fallback === true)
    return null;
  const isWholePageCapture = !(action.region || action.clip || action.selector || action.element !== undefined || action.ref !== undefined);
  if (!domResult.fallbackEligible || !isWholePageCapture)
    return null;
  const droppedOpts = [];
  if (action.scale !== undefined)
    droppedOpts.push("--scale");
  const pixelAction = {
    type: "screenshot",
    pixel: true,
    full: true
  };
  pixelAction.format = action.format !== undefined ? action.format : "png";
  pixelAction.quality = action.quality !== undefined ? action.quality : 92;
  if (action.target_max_long_edge !== undefined)
    pixelAction.target_max_long_edge = action.target_max_long_edge;
  if (action.save !== undefined)
    pixelAction.save = action.save;
  const sideEffects = "borrowed tab focus + scrolled page (both restored; --no-fallback to forbid)";
  const note = droppedOpts.length ? `dom-render (${domResult.error}) → pixel [dropped: ${droppedOpts.join(", ")}] — ${sideEffects}` : `dom-render (${domResult.error}) → pixel — ${sideEffects}`;
  return { pixelAction, note };
}
async function handleScreenshotActions(action, tabId) {
  switch (action.type) {
    case "screenshot_background":
      return handleScreenshotBackground(action, tabId);
    case "ocr":
      return handleOcr(action, tabId);
    case "page_capture": {
      const mhtml = await chrome.pageCapture.saveAsMHTML({ tabId });
      const text = await mhtml.text();
      return { success: true, data: { size: text.length, preview: text.slice(0, 500) } };
    }
    case "screenshot": {
      if (action.pixel === true) {
        return handlePixelScreenshot(action, tabId);
      }
      const domResult = await handleDomRenderScreenshot(action, tabId);
      if (domResult.success)
        return domResult;
      const plan = planPixelFallback(action, domResult);
      if (!plan)
        return domResult;
      const pixelResult = await handlePixelScreenshot(plan.pixelAction, tabId);
      if (pixelResult.success && pixelResult.data) {
        pixelResult.data.fallback = plan.note;
        return pixelResult;
      }
      return { success: false, error: `${domResult.error} (pixel fallback also failed: ${pixelResult.error})` };
    }
  }
  return { success: false, error: `unknown screenshot action: ${action.type}` };
}

// extension/src/background/capabilities/capture-stream.ts
async function handleCaptureStreamActions(action, tabId) {
  switch (action.type) {
    case "capture_start": {
      const streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId: tabId });
      const contexts = await chrome.runtime.getContexts({
        contextTypes: ["OFFSCREEN_DOCUMENT"]
      });
      if (contexts.length === 0) {
        await chrome.offscreen.createDocument({
          url: "offscreen.html",
          reasons: ["USER_MEDIA"],
          justification: "Tab capture stream processing"
        });
      }
      chrome.runtime.sendMessage({ target: "offscreen", type: "capture_start", streamId });
      return { success: true, data: { streamId, tabId } };
    }
    case "capture_frame": {
      const fmt = action.format === "png" ? "image/png" : "image/jpeg";
      const qual = action.quality || 50;
      const frameResult = await sendToOffscreen({
        type: "capture_frame",
        format: fmt,
        quality: qual / 100
      });
      if (!frameResult.success)
        return { success: false, error: frameResult.error };
      return { success: true, data: { dataUrl: frameResult.data } };
    }
    case "capture_stop": {
      await sendToOffscreen({ type: "capture_stop" });
      try {
        await chrome.offscreen.closeDocument();
      } catch {}
      return { success: true };
    }
    case "canvas_diff": {
      const diffResult = await sendToOffscreen({
        type: "diff",
        image1: action.image1,
        image2: action.image2,
        threshold: action.threshold || 0,
        returnImage: action.returnImage || false
      });
      if (!diffResult.success)
        return { success: false, error: diffResult.error };
      return { success: true, data: diffResult.data };
    }
  }
  return { success: false, error: `unknown capture action: ${action.type}` };
}

// extension/src/inject-keys.ts
var IK_NET = "z9n0";
var IK_CANVAS = "z9c0";
var IK_WS = "z9w0";
var IK_BROADCAST = "z9b0";
var IK_BEACON = "z9k0";
var IK_TT_POLICY = "z9t0";
var IK_SINK_TT_POLICY = "z9t1";
var IK_CANVAS_OBSERVER = "z9o0";
var IK_CANVAS_WRAPPED = "z9r0";
var IK_GETCTX_WRAPPED = "z9r1";
var K_NET = Symbol.for(IK_NET);
var K_CANVAS = Symbol.for(IK_CANVAS);
var K_WS = Symbol.for(IK_WS);
var K_BROADCAST = Symbol.for(IK_BROADCAST);
var K_BEACON = Symbol.for(IK_BEACON);
var K_TT_POLICY = Symbol.for(IK_TT_POLICY);
var K_CANVAS_OBSERVER = Symbol.for(IK_CANVAS_OBSERVER);
var K_CANVAS_WRAPPED = Symbol.for(IK_CANVAS_WRAPPED);
var K_GETCTX_WRAPPED = Symbol.for(IK_GETCTX_WRAPPED);
var TT_POLICY_NAME = "tt-e";
var SINK_TT_POLICY_NAME = "tt-s";

// extension/src/background/capabilities/canvas.ts
async function executeInMainWorld(tabId, func, args = []) {
  const mapped = args.map((arg) => arg === undefined ? null : arg);
  if (chrome.userScripts && typeof chrome.userScripts.execute === "function") {
    try {
      const argsLiteral = "[" + args.map((a) => a === undefined ? "undefined" : JSON.stringify(a)).join(",") + "]";
      const code = `(${func.toString()}).apply(null, ${argsLiteral})`;
      const results2 = await chrome.userScripts.execute({
        target: { tabId },
        world: "MAIN",
        js: [{ code }]
      });
      const first = results2?.[0];
      if (first && !first.error)
        return first.result;
    } catch {}
  }
  const results = await chrome.scripting.executeScript({
    target: { tabId },
    world: "MAIN",
    args: mapped,
    func
  });
  return results[0]?.result;
}
function hostCanvasSignals(limit = 20, obsKey) {
  function summarizeCanvasKinds(entries) {
    const out = {};
    for (const entry of entries) {
      const kind = String(entry.kind || "").trim();
      if (!kind)
        continue;
      out[kind] = (out[kind] || 0) + 1;
    }
    return out;
  }
  const canvases = Array.from(document.querySelectorAll("canvas"));
  const max = Number.isFinite(limit) && limit > 0 ? limit : 20;
  const safeSlice = (arr) => arr.slice(0, max);
  function parseLocalStorageJson(key) {
    try {
      const raw = localStorage.getItem(key);
      if (!raw)
        return { exists: false };
      const parsed = JSON.parse(raw);
      return {
        exists: true,
        rawLength: raw.length,
        type: Array.isArray(parsed) ? "array" : typeof parsed,
        keys: parsed && typeof parsed === "object" ? Object.keys(parsed).slice(0, max) : undefined,
        preview: JSON.stringify(parsed).slice(0, 600)
      };
    } catch {
      const raw = localStorage.getItem(key);
      return raw ? { exists: true, rawLength: raw.length, type: "raw", preview: raw.slice(0, 600) } : { exists: false };
    }
  }
  const docsIframe = document.querySelector(".docs-texteventtarget-iframe");
  let docsTextboxSummary = { exists: false };
  try {
    const docsTextbox = docsIframe?.contentDocument?.querySelector('[role="textbox"], [contenteditable]');
    if (docsTextbox) {
      const text = (docsTextbox.textContent || "").toString();
      docsTextboxSummary = { exists: true, textLength: text.length, textSample: text.slice(0, 240) };
    }
  } catch {}
  const candidateGlobals = Object.keys(window).filter((k) => /docs|kix|save|revision|model|collab|firebase|socket|scene|app|element|excal/i.test(k)).slice(0, max);
  const candidateGlobalDetails = Object.fromEntries(candidateGlobals.slice(0, Math.min(max, 15)).map((key) => {
    const value = window[key];
    return [key, {
      type: typeof value,
      isArray: Array.isArray(value),
      ctor: value && value.constructor?.name || null,
      keys: value && typeof value === "object" ? Object.keys(value).slice(0, 12) : undefined
    }];
  }));
  const observer = (obsKey ? window[Symbol.for(obsKey)] : null) || null;
  const excalidrawScene = parseLocalStorageJson("excalidraw");
  const docsSemanticMirror = !!docsTextboxSummary.exists;
  const observerReasons = Array.isArray(observer?.partialCoverageReasons) ? observer.partialCoverageReasons.slice() : [];
  const strategyHint = docsSemanticMirror ? "semantic-mirror" : excalidrawScene.exists ? "host-model" : observerReasons.includes("drawImage") ? "classify-then-ocr" : "inspect-canvas";
  return {
    href: location.href,
    host: location.host,
    canvasCount: canvases.length,
    canvases: safeSlice(canvases.map((c, i) => ({
      index: i,
      className: c.className || "",
      id: c.id || "",
      width: c.width,
      height: c.height
    }))),
    features: {
      offscreenCanvas: typeof OffscreenCanvas !== "undefined",
      createImageBitmap: typeof createImageBitmap === "function",
      worker: typeof Worker === "function",
      imageBitmapRenderingContext: typeof window.ImageBitmapRenderingContext !== "undefined"
    },
    observer: observer ? {
      installed: true,
      canvasCount: Array.isArray(observer.canvases) ? observer.canvases.length : undefined,
      logSize: Array.isArray(observer.log) ? observer.log.length : undefined,
      objectCount: Array.isArray(observer.objects) ? observer.objects.length : undefined,
      kindCounts: summarizeCanvasKinds(Array.isArray(observer.log) ? observer.log : []),
      partialCoverageReasons: observerReasons
    } : { installed: false },
    strategyHint,
    strategyReasons: [
      docsSemanticMirror ? "hidden semantic mirror present" : null,
      excalidrawScene.exists ? "host scene model present in localStorage" : null,
      observerReasons.includes("drawImage") ? "drawImage-heavy canvas pipeline" : null,
      observerReasons.includes("offscreenCanvas") ? "offscreen canvas signal present" : null
    ].filter(Boolean),
    docs: {
      textEventIframe: !!docsIframe,
      textbox: docsTextboxSummary,
      pageCount: document.querySelectorAll(".kix-page-paginated").length,
      tileCount: document.querySelectorAll(".kix-canvas-tile-content").length
    },
    excalidraw: {
      globals: candidateGlobals.filter((k) => /excal/i.test(k)).slice(0, max),
      localStorage: {
        scene: excalidrawScene,
        appState: parseLocalStorageJson("excalidraw-state"),
        collab: parseLocalStorageJson("excalidraw-collab")
      }
    },
    globals: candidateGlobalDetails
  };
}
function canvasAccessibleText(canvasIndex) {
  const canvases = Array.from(document.querySelectorAll("canvas"));
  const c = canvases[canvasIndex];
  if (!c)
    return { found: false, error: "canvas index out of range", canvasCount: canvases.length };
  const norm = (s) => (s || "").replace(/\s+/g, " ").trim();
  const byIds = (ids) => !ids ? "" : ids.split(/\s+/).map((id) => norm(document.getElementById(id)?.textContent)).filter(Boolean).join(" ");
  const sources = {};
  const ariaLabel = norm(c.getAttribute("aria-label"));
  if (ariaLabel)
    sources.ariaLabel = ariaLabel;
  const ariaLabelledby = byIds(c.getAttribute("aria-labelledby"));
  if (ariaLabelledby)
    sources.ariaLabelledby = ariaLabelledby;
  const fallback = norm(c.textContent);
  if (fallback)
    sources.fallback = fallback;
  const fig = c.closest("figure");
  const figcaption = fig ? norm(fig.querySelector("figcaption")?.textContent) : "";
  if (figcaption)
    sources.figcaption = figcaption;
  const ariaDescribedby = byIds(c.getAttribute("aria-describedby"));
  if (ariaDescribedby)
    sources.ariaDescribedby = ariaDescribedby;
  const title = norm(c.getAttribute("title"));
  if (title)
    sources.title = title;
  const text = [
    sources.ariaLabel,
    sources.ariaLabelledby,
    sources.fallback,
    sources.figcaption,
    sources.ariaDescribedby,
    sources.title
  ].filter(Boolean).join(`
`);
  return {
    found: !!text,
    text,
    role: c.getAttribute("role") || "",
    sources,
    canvasCount: canvases.length
  };
}
function canvasObserverSummary(limit = 100, kinds, canvasIndex, obsKey) {
  function normalize(kind) {
    return String(kind || "").trim();
  }
  function summarize(entries2) {
    const out = {};
    for (const entry of entries2) {
      const kind = normalize(entry.kind);
      if (!kind)
        continue;
      out[kind] = (out[kind] || 0) + 1;
    }
    return out;
  }
  function resolveCanvasId(observer2, canvasIndex2) {
    if (canvasIndex2 === undefined || canvasIndex2 === null)
      return;
    const canvases = Array.isArray(observer2?.canvases) ? observer2.canvases.slice() : [];
    const ordered = canvases.sort((a, b) => {
      const left = typeof a.domIndex === "number" ? a.domIndex : Number.MAX_SAFE_INTEGER;
      const right = typeof b.domIndex === "number" ? b.domIndex : Number.MAX_SAFE_INTEGER;
      if (left !== right)
        return left - right;
      return String(a.canvasId || "").localeCompare(String(b.canvasId || ""));
    });
    const canvasId2 = ordered[canvasIndex2]?.canvasId;
    return typeof canvasId2 === "string" && canvasId2 ? canvasId2 : null;
  }
  const observer = (obsKey ? window[Symbol.for(obsKey)] : null) || null;
  if (!observer || !Array.isArray(observer.log)) {
    return {
      installed: false,
      entries: [],
      total: 0,
      kindCounts: {},
      diagnostics: { reason: "observer not installed" }
    };
  }
  const kindFilter = (kinds || []).map(normalize).filter(Boolean);
  const canvasId = resolveCanvasId(observer, canvasIndex);
  let entries = observer.log.slice();
  if (canvasId === null)
    entries = [];
  else if (canvasId)
    entries = entries.filter((entry) => String(entry.canvasId || "") === canvasId);
  if (kindFilter.length > 0) {
    entries = entries.filter((entry) => kindFilter.includes(normalize(entry.kind)));
  }
  const bounded = entries.slice(-Math.max(1, limit));
  return {
    installed: true,
    total: entries.length,
    kindCounts: summarize(entries),
    entries: bounded
  };
}
function canvasObserverObjectsSummary(limit = 100, kind, canvasIndex, obsKey) {
  function normalize(value) {
    return String(value || "").trim();
  }
  function resolveCanvasId(observer2, canvasIndex2) {
    if (canvasIndex2 === undefined || canvasIndex2 === null)
      return;
    const canvases = Array.isArray(observer2?.canvases) ? observer2.canvases.slice() : [];
    const ordered = canvases.sort((a, b) => {
      const left = typeof a.domIndex === "number" ? a.domIndex : Number.MAX_SAFE_INTEGER;
      const right = typeof b.domIndex === "number" ? b.domIndex : Number.MAX_SAFE_INTEGER;
      if (left !== right)
        return left - right;
      return String(a.canvasId || "").localeCompare(String(b.canvasId || ""));
    });
    const canvasId2 = ordered[canvasIndex2]?.canvasId;
    return typeof canvasId2 === "string" && canvasId2 ? canvasId2 : null;
  }
  const observer = (obsKey ? window[Symbol.for(obsKey)] : null) || null;
  if (!observer || !Array.isArray(observer.objects)) {
    return {
      installed: false,
      objects: [],
      total: 0,
      diagnostics: { reason: "observer not installed" }
    };
  }
  const kindFilter = normalize(kind);
  const canvasId = resolveCanvasId(observer, canvasIndex);
  let objects = observer.objects.slice();
  if (canvasId === null)
    objects = [];
  else if (canvasId)
    objects = objects.filter((entry) => String(entry.canvasId || "") === canvasId);
  if (kindFilter) {
    objects = objects.filter((entry) => normalize(entry.kind) === kindFilter);
  }
  return {
    installed: true,
    total: objects.length,
    objects: objects.slice(-Math.max(1, limit))
  };
}
function walkCanvasElements() {
  const canvases = Array.from(document.querySelectorAll("canvas"));
  function walkShadowRoots(root) {
    const found = [];
    const children = Array.from(root.children);
    for (const child of children) {
      if (child.tagName === "CANVAS")
        found.push(child);
      const shadow = child.shadowRoot;
      if (shadow)
        found.push(...walkShadowRoots(shadow));
      found.push(...walkShadowRoots(child));
    }
    return found;
  }
  const shadowCanvases = document.body ? walkShadowRoots(document.body) : [];
  const all = [...new Set([...canvases, ...shadowCanvases])];
  return all.map((c, i) => {
    const rect = c.getBoundingClientRect();
    let contextType = "none";
    try {
      if (c.getContext("2d"))
        contextType = "2d";
      else if (c.getContext("webgl2"))
        contextType = "webgl2";
      else if (c.getContext("webgl"))
        contextType = "webgl";
      else if (c.getContext("bitmaprenderer"))
        contextType = "bitmaprenderer";
    } catch {}
    const style = getComputedStyle(c);
    const hidden = style.display === "none" || style.visibility === "hidden" || c.width === 0 && c.height === 0;
    return {
      index: i,
      width: c.width,
      height: c.height,
      cssWidth: rect.width,
      cssHeight: rect.height,
      x: rect.x,
      y: rect.y,
      contextType,
      hidden,
      id: c.id || undefined,
      className: c.className || undefined
    };
  });
}
function inferRouteCandidates(entries, filter, limit = 20) {
  const normalizedFilter = (filter || "").toLowerCase();
  const candidates = new Map;
  for (const entry of entries) {
    if (!entry.url)
      continue;
    const sampleUrl = entry.url;
    const absoluteUrl = entry.url.startsWith("http") ? entry.url : (() => {
      try {
        return new URL(entry.url, entry.tabUrl || "https://example.invalid").toString();
      } catch {
        return entry.url;
      }
    })();
    let route = absoluteUrl;
    try {
      const url = new URL(absoluteUrl, entry.tabUrl || undefined);
      route = `${url.origin}${url.pathname}`;
    } catch {}
    if (normalizedFilter && !route.toLowerCase().includes(normalizedFilter) && !sampleUrl.toLowerCase().includes(normalizedFilter)) {
      continue;
    }
    const candidate = candidates.get(route) || {
      route,
      methods: new Set,
      statuses: new Set,
      count: 0,
      lastSeen: 0,
      contentTypes: new Set,
      reasons: new Set,
      sampleUrl
    };
    candidate.methods.add(entry.method || "GET");
    candidate.statuses.add(entry.status || 0);
    candidate.count += 1;
    candidate.lastSeen = Math.max(candidate.lastSeen, entry.timestamp || 0);
    if (entry.contentType)
      candidate.contentTypes.add(entry.contentType);
    if (/\/save\b|[?&]save=|\/update\b|\/revision\b|\/sync\b|\/delta\b/i.test(entry.url))
      candidate.reasons.add("mutation-like-route");
    if ((entry.method || "").toUpperCase() !== "GET")
      candidate.reasons.add("non-get");
    if ((entry.contentType || "").toLowerCase().includes("json"))
      candidate.reasons.add("json-response");
    if (entry.body && /revision|ack|delta|operation|clientModel/i.test(entry.body))
      candidate.reasons.add("state-bearing-body");
    candidates.set(route, candidate);
  }
  return [...candidates.values()].map((candidate) => ({
    route: candidate.route,
    sampleUrl: candidate.sampleUrl,
    methods: [...candidate.methods].sort(),
    statuses: [...candidate.statuses].sort((a, b) => a - b),
    contentTypes: [...candidate.contentTypes].sort(),
    count: candidate.count,
    lastSeen: candidate.lastSeen,
    reasons: [...candidate.reasons].sort(),
    score: candidate.count + candidate.reasons.size * 2 + (candidate.methods.has("POST") ? 3 : 0) + ([...candidate.contentTypes].some((ct) => ct.toLowerCase().includes("json")) ? 2 : 0)
  })).sort((a, b) => b.score - a.score || b.count - a.count || b.lastSeen - a.lastSeen).slice(0, Math.max(1, limit));
}
async function handleCanvasActions(action, tabId) {
  switch (action.type) {
    case "canvas_list": {
      const data = await executeInMainWorld(tabId, walkCanvasElements);
      return { success: true, data: data || [] };
    }
    case "canvas_status": {
      const list = await executeInMainWorld(tabId, walkCanvasElements);
      const host = await executeInMainWorld(tabId, hostCanvasSignals, [action.limit, IK_CANVAS_OBSERVER]);
      return {
        success: true,
        data: {
          canvases: list || [],
          host
        }
      };
    }
    case "canvas_model": {
      const data = await executeInMainWorld(tabId, hostCanvasSignals, [action.limit]);
      return { success: true, data };
    }
    case "canvas_log": {
      const data = await executeInMainWorld(tabId, canvasObserverSummary, [action.limit, action.kinds, action.canvasIndex, IK_CANVAS_OBSERVER]);
      return { success: true, data };
    }
    case "canvas_objects": {
      const data = await executeInMainWorld(tabId, canvasObserverObjectsSummary, [action.limit, action.kind, action.canvasIndex, IK_CANVAS_OBSERVER]);
      return { success: true, data };
    }
    case "canvas_routes": {
      const result = await sendNetDirect(tabId, {
        type: "get_net_log"
      });
      if (!result.success) {
        return { success: false, error: result.error || "failed to read passive net log" };
      }
      const entries = (result.data || []).slice();
      const data = inferRouteCandidates(entries, action.filter, action.limit);
      return {
        success: true,
        data: {
          totalEntries: entries.length,
          candidates: data
        }
      };
    }
    case "canvas_ocr": {
      const a11y = await executeInMainWorld(tabId, canvasAccessibleText, [action.canvasIndex]);
      if (a11y && a11y.error) {
        return { success: false, error: a11y.error };
      }
      const hostSignals = await executeInMainWorld(tabId, hostCanvasSignals, [10]);
      const semanticText = hostSignals?.docs?.textbox?.exists ? hostSignals.docs.textbox.textSample || "" : "";
      const a11yText = a11y && a11y.found ? a11y.text || "" : "";
      let text = a11yText || semanticText;
      let source = a11yText ? "accessibility" : semanticText ? "semantic-textbox" : "none";
      let confidence = null;
      let ocrFallbackUsed = false;
      if (!text) {
        const readResult = await handleCanvasActions({
          type: "canvas_read",
          canvasIndex: action.canvasIndex,
          region: action.region,
          format: "png"
        }, tabId);
        const dataUrl = readResult.success ? readResult.data.dataUrl : undefined;
        if (dataUrl) {
          const ocr = await sendToOffscreen({ type: "ocr", dataUrl });
          if (ocr.success && (ocr.data?.text || "").trim()) {
            text = ocr.data.text.trim();
            source = "tesseract";
            confidence = ocr.data?.confidence ?? null;
            ocrFallbackUsed = true;
          }
        }
      }
      return {
        success: true,
        data: {
          text,
          source,
          confidence,
          diagnostics: {
            accessibilityText: !!a11yText,
            accessibilitySources: a11y?.sources || null,
            semanticTextboxAvailable: !!semanticText,
            ocrFallbackUsed,
            hint: text ? undefined : "No accessible/semantic text and pixel OCR found nothing. For a canvas-rendered editor use `interceptor scene text`."
          }
        }
      };
    }
    case "canvas_read": {
      const canvasIdx = action.canvasIndex;
      const fmt = action.format === "png" ? "image/png" : "image/jpeg";
      const qual = action.quality || 0.5;
      const region = action.region;
      const isWebgl = action.webgl;
      const results = await chrome.scripting.executeScript({
        target: { tabId },
        world: "MAIN",
        args: [canvasIdx, fmt, qual, region ?? null, isWebgl ?? false],
        func: (idx, format, quality, reg, webgl) => {
          const canvases = Array.from(document.querySelectorAll("canvas"));
          const c = canvases[idx];
          if (!c)
            return { success: false, error: `no canvas at index ${idx}` };
          try {
            if (reg) {
              const ctx = c.getContext("2d");
              if (!ctx)
                return { success: false, error: "canvas has no 2d context for region read" };
              const data = ctx.getImageData(reg.x, reg.y, reg.width, reg.height);
              const tmpCanvas = document.createElement("canvas");
              tmpCanvas.width = reg.width;
              tmpCanvas.height = reg.height;
              const tmpCtx = tmpCanvas.getContext("2d");
              tmpCtx.putImageData(data, 0, 0);
              return { success: true, data: tmpCanvas.toDataURL(format, quality) };
            }
            if (webgl) {
              const gl = c.getContext("webgl2") || c.getContext("webgl");
              if (!gl)
                return { success: false, error: "canvas has no webgl context" };
              const pixels = new Uint8Array(c.width * c.height * 4);
              gl.readPixels(0, 0, c.width, c.height, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
              const tmpCanvas = document.createElement("canvas");
              tmpCanvas.width = c.width;
              tmpCanvas.height = c.height;
              const tmpCtx = tmpCanvas.getContext("2d");
              const imageData = tmpCtx.createImageData(c.width, c.height);
              for (let row = 0;row < c.height; row++) {
                const srcOff = row * c.width * 4;
                const dstOff = (c.height - 1 - row) * c.width * 4;
                imageData.data.set(pixels.subarray(srcOff, srcOff + c.width * 4), dstOff);
              }
              tmpCtx.putImageData(imageData, 0, 0);
              return { success: true, data: tmpCanvas.toDataURL(format, quality) };
            }
            return { success: true, data: c.toDataURL(format, quality) };
          } catch (e) {
            if (e.message?.includes("tainted"))
              return { success: false, error: "canvas is tainted (cross-origin content)" };
            return { success: false, error: e.message };
          }
        }
      });
      const res = results[0]?.result;
      if (!res)
        return { success: false, error: "no result from canvas read" };
      if (!res.success)
        return { success: false, error: res.error };
      const dataUrl = res.data;
      const sizeBytes = Math.round((dataUrl.length - dataUrl.indexOf(",") - 1) * 0.75);
      if (sizeBytes > 800 * 1024) {
        return { success: true, data: { dataUrl, size: sizeBytes, warning: "Response exceeds 800KB — consider JPEG or smaller region" } };
      }
      return { success: true, data: { dataUrl, size: sizeBytes } };
    }
  }
  return { success: false, error: `unknown canvas action: ${action.type}` };
}

// extension/src/background/tab-lifecycle.ts
var DEFAULT_TAB_LIFECYCLE = { reuse: true, idleCloseMinutes: 10 };
var STORAGE_KEY = "tabLifecycle";
var GROUP_LAST_SEEN_PREFIX = "groupLastSeen:";
function normalizeTabLifecycle(raw) {
  const obj = raw && typeof raw === "object" ? raw : {};
  const reuse = typeof obj.reuse === "boolean" ? obj.reuse : DEFAULT_TAB_LIFECYCLE.reuse;
  let idle = DEFAULT_TAB_LIFECYCLE.idleCloseMinutes;
  if (typeof obj.idleCloseMinutes === "number" && Number.isFinite(obj.idleCloseMinutes)) {
    idle = Math.max(0, Math.round(obj.idleCloseMinutes));
  }
  return { reuse, idleCloseMinutes: idle };
}
function policyMayDecideReuse(action) {
  return action.reuse === undefined && action.reusePolicy === true && typeof action.group === "string" && action.group.length > 0;
}
async function readArea(area) {
  try {
    const storageArea = chrome.storage[area];
    if (!storageArea || typeof storageArea.get !== "function")
      return;
    const stored = await storageArea.get(STORAGE_KEY);
    const raw = stored?.[STORAGE_KEY];
    if (raw === undefined || raw === null)
      return;
    return normalizeTabLifecycle(raw);
  } catch {
    return;
  }
}
async function resolveTabLifecycle() {
  const managed = await readArea("managed");
  if (managed)
    return { policy: managed, source: "managed" };
  const local = await readArea("local");
  if (local)
    return { policy: local, source: "local" };
  return { policy: { ...DEFAULT_TAB_LIFECYCLE }, source: "default" };
}
function sessionArea3() {
  const storage = chrome.storage;
  return storage.session ?? chrome.storage.local;
}
function stampKey(label) {
  return `${GROUP_LAST_SEEN_PREFIX}${label}`;
}
function recordGroupActivity(label) {
  try {
    sessionArea3().set({ [stampKey(label ?? "")]: Date.now() }).catch(() => {});
  } catch {}
}

// extension/src/background/capabilities/tabs.ts
function activeTabKey(group) {
  return group ? `activeTabId:${group}` : "activeTabId";
}
function sessionArea4() {
  const storage = chrome.storage;
  return storage.session ?? chrome.storage.local;
}
function groupWarningFor(groupId, groupApiAvailable) {
  if (groupId === -1 && groupApiAvailable) {
    return "tab was not added to a tab group (non-normal window or transient group failure) — per-agent group isolation is not in effect for this tab";
  }
  return;
}
async function resolveNormalWindowPlacement(focusNew, url) {
  if (!chrome.windows || typeof chrome.windows.getAll !== "function")
    return {};
  try {
    const normal = await chrome.windows.getAll({ windowTypes: ["normal"] });
    const existing = normal.find((w) => w.focused)?.id ?? normal[0]?.id;
    if (existing !== undefined)
      return { windowId: existing };
    if (typeof chrome.windows.create === "function") {
      const created = await chrome.windows.create({ url, focused: focusNew });
      return { windowId: created?.id, createdTab: created?.tabs?.[0] };
    }
  } catch {}
  return {};
}
async function handleTabActions(action, tabId) {
  switch (action.type) {
    case "tab_create": {
      const targetUrl = action.url || "about:blank";
      const group = typeof action.group === "string" && action.group.length > 0 ? action.group : undefined;
      if (group && !GROUP_LABEL_RE.test(group)) {
        return { success: false, error: `invalid group label '${group}' — must match [A-Za-z0-9_-]{1,32}` };
      }
      let reuseWanted = action.reuse === true;
      if (!reuseWanted && policyMayDecideReuse(action)) {
        try {
          reuseWanted = (await resolveTabLifecycle()).policy.reuse;
        } catch {
          reuseWanted = false;
        }
      }
      if (reuseWanted) {
        const groupId = group ? await ensureNamedGroup(group) : await ensureInterceptorGroup();
        if (groupId !== -1) {
          const groupTabs = await chrome.tabs.query({ groupId });
          if (groupTabs.length > 0) {
            const sorted = groupTabs.filter((t) => typeof t.id === "number").sort((a, b) => b.id - a.id);
            const candidate = sorted[0];
            if (candidate?.id !== undefined) {
              try {
                const reuseActivate = action.active === true;
                let updated = candidate;
                if (action.prepareOnly === true) {
                  updated = reuseActivate ? await chrome.tabs.update(candidate.id, { active: true }) : await chrome.tabs.get(candidate.id);
                } else {
                  const updateProps = { url: targetUrl };
                  if (reuseActivate)
                    updateProps.active = true;
                  updated = await chrome.tabs.update(candidate.id, updateProps);
                  await waitForTabLoad(candidate.id);
                }
                await sessionArea4().set({ [activeTabKey(group)]: candidate.id });
                return {
                  success: true,
                  data: { tabId: candidate.id, url: updated?.url ?? targetUrl, groupId, group, reused: true }
                };
              } catch {}
            }
          }
        }
      }
      const shouldActivate = action.active === true;
      const placement = await resolveNormalWindowPlacement(shouldActivate, targetUrl);
      const newTab = placement.createdTab ?? await chrome.tabs.create({
        url: targetUrl,
        active: shouldActivate,
        ...placement.windowId !== undefined ? { windowId: placement.windowId } : {}
      });
      if (newTab.id) {
        const groupId = group ? await addTabToNamedGroup(newTab.id, group, action.groupColor) : await addTabToInterceptorGroup(newTab.id);
        if (shouldActivate)
          await chrome.tabs.update(newTab.id, { active: true });
        await sessionArea4().set({ [activeTabKey(group)]: newTab.id });
        const data = { tabId: newTab.id, url: newTab.url, groupId, group, reused: false };
        const groupWarning = groupWarningFor(groupId, hasTabGroupApi());
        if (groupWarning)
          data.groupWarning = groupWarning;
        return { success: true, data };
      }
      return { success: true, data: { tabId: newTab.id, url: newTab.url, reused: false } };
    }
    case "tab_close": {
      const closedId = action.tabId || tabId;
      await chrome.tabs.remove(closedId);
      const keys = ["activeTabId", typeof action.group === "string" ? activeTabKey(action.group) : null].filter((k) => !!k);
      const stored = await sessionArea4().get(keys);
      for (const key of keys) {
        if (stored[key] === closedId)
          await sessionArea4().remove(key);
      }
      return { success: true };
    }
    case "tab_switch": {
      await chrome.tabs.update(action.tabId, { active: true });
      return { success: true };
    }
    case "tab_list": {
      const tabs = await chrome.tabs.query({});
      await ensureInterceptorGroup();
      await hydrateNamedGroups();
      const namedIds = new Set(namedGroups.values());
      const tabData = tabs.map((t) => ({
        id: t.id,
        url: t.url,
        title: t.title,
        active: t.active,
        windowId: t.windowId,
        muted: t.mutedInfo?.muted,
        pinned: t.pinned,
        groupId: t.groupId,
        managed: interceptorGroupId !== null && t.groupId === interceptorGroupId || namedIds.has(t.groupId),
        group: labelForGroupId(t.groupId)
      }));
      return { success: true, data: tabData };
    }
    case "group_list": {
      if (!chrome.tabGroups || typeof chrome.tabGroups.query !== "function") {
        return { success: true, data: [] };
      }
      await ensureInterceptorGroup();
      await hydrateNamedGroups();
      const live = await chrome.tabGroups.query({}).catch(() => []);
      const prefix = `${groupTitleFor("")}`;
      for (const g of live) {
        if (typeof g.title !== "string" || !g.title.startsWith(prefix))
          continue;
        const label = g.title.slice(prefix.length);
        if (GROUP_LABEL_RE.test(label) && labelForGroupId(g.id) === null && g.id !== interceptorGroupId) {
          await ensureNamedGroup(label);
        }
      }
      const data = await Promise.all(live.map(async (g) => {
        const groupTabs = await chrome.tabs.query({ groupId: g.id });
        return {
          groupId: g.id,
          title: g.title,
          color: g.color,
          tabCount: groupTabs.length,
          label: labelForGroupId(g.id),
          default: interceptorGroupId !== null && g.id === interceptorGroupId,
          managed: interceptorGroupId !== null && g.id === interceptorGroupId || labelForGroupId(g.id) !== null
        };
      }));
      return { success: true, data };
    }
    case "group_close": {
      const label = action.label;
      if (!label || !GROUP_LABEL_RE.test(label)) {
        return { success: false, error: `group_close requires a valid label (got '${label ?? ""}')` };
      }
      const groupId = await ensureNamedGroup(label);
      if (groupId === -1) {
        return { success: false, error: `group '${label}' not found` };
      }
      const groupTabs = await chrome.tabs.query({ groupId });
      const ids = groupTabs.map((t) => t.id).filter((id) => typeof id === "number");
      if (ids.length > 0)
        await chrome.tabs.remove(ids);
      return { success: true, data: { label, groupId, closedTabs: ids.length } };
    }
    case "tab_duplicate": {
      const dup = await chrome.tabs.duplicate(tabId);
      return { success: true, data: { tabId: dup?.id } };
    }
    case "tab_reload":
      await chrome.tabs.reload(tabId, { bypassCache: !!action.bypassCache });
      await waitForTabLoad(tabId);
      return { success: true };
    case "tab_mute":
      await chrome.tabs.update(tabId, { muted: !!(action.muted ?? true) });
      return { success: true };
    case "tab_pin":
      await chrome.tabs.update(tabId, { pinned: !!(action.pinned ?? true) });
      return { success: true };
    case "tab_zoom_get": {
      const zoom = await chrome.tabs.getZoom(tabId);
      return { success: true, data: { zoom } };
    }
    case "tab_zoom_set":
      await chrome.tabs.setZoom(tabId, action.zoom);
      return { success: true };
    case "tab_group": {
      const groupId = await chrome.tabs.group({
        tabIds: tabId,
        groupId: action.groupId
      });
      if (action.title || action.color) {
        await chrome.tabGroups.update(groupId, {
          title: action.title,
          color: action.color
        });
      }
      return { success: true, data: { groupId } };
    }
    case "tab_ungroup":
      await chrome.tabs.ungroup(tabId);
      return { success: true };
    case "tab_move":
      await chrome.tabs.move(tabId, {
        windowId: action.windowId,
        index: action.index ?? -1
      });
      return { success: true };
    case "tab_discard":
      await chrome.tabs.discard(tabId);
      return { success: true };
  }
  return { success: false, error: `unknown tab action: ${action.type}` };
}

// extension/src/background/capabilities/windows.ts
var WINDOW_OP_TIMEOUT_MS = 8000;

class WindowOperationTimeoutError extends Error {
  operation;
  timeoutMs;
  constructor(operation, timeoutMs) {
    super(`${operation} timed out after ${timeoutMs}ms (service worker may be wedged)`);
    this.operation = operation;
    this.timeoutMs = timeoutMs;
    this.name = "WindowOperationTimeoutError";
  }
}
function withWindowTimeout(op, p, ms = WINDOW_OP_TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new WindowOperationTimeoutError(op, ms)), ms);
    p.then((value) => {
      clearTimeout(timer);
      resolve(value);
    }, (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}
function windowIdFromAction(action) {
  return typeof action.windowId === "number" && Number.isFinite(action.windowId) ? action.windowId : undefined;
}
function windowUpdateInfoFromAction(action) {
  const info = {};
  if (typeof action.width === "number")
    info.width = action.width;
  if (typeof action.height === "number")
    info.height = action.height;
  if (typeof action.left === "number")
    info.left = action.left;
  if (typeof action.top === "number")
    info.top = action.top;
  if (typeof action.state === "string")
    info.state = action.state;
  return info;
}
async function handleWindowActions(action, _tabId) {
  try {
    switch (action.type) {
      case "window_create": {
        const win = await withWindowTimeout("window_create", chrome.windows.create({
          url: action.url,
          type: action.windowType || "normal",
          width: action.width,
          height: action.height,
          left: action.left,
          top: action.top,
          incognito: !!action.incognito,
          focused: action.focused !== false
        }));
        if (!win)
          return { success: false, error: "window creation returned no window" };
        const firstTab = win.tabs?.[0];
        let groupId;
        if (firstTab?.id && !action.incognito) {
          const group = typeof action.group === "string" && GROUP_LABEL_RE.test(action.group) ? action.group : undefined;
          groupId = group ? await addTabToNamedGroup(firstTab.id, group, action.groupColor) : await addTabToInterceptorGroup(firstTab.id);
        }
        return {
          success: true,
          data: { windowId: win.id, groupId, tabs: win.tabs?.map((t) => ({ id: t.id, url: t.url })) }
        };
      }
      case "window_close": {
        const windowId = windowIdFromAction(action);
        if (windowId === undefined)
          return { success: false, error: "window_close requires a window id" };
        await withWindowTimeout("window_close", chrome.windows.remove(windowId));
        return { success: true };
      }
      case "window_focus": {
        const windowId = windowIdFromAction(action);
        if (windowId === undefined)
          return { success: false, error: "window_focus requires a window id" };
        await withWindowTimeout("window_focus", chrome.windows.update(windowId, { focused: true }));
        return { success: true };
      }
      case "window_resize": {
        const targetId = windowIdFromAction(action) ?? (await withWindowTimeout("window_getCurrent", chrome.windows.getCurrent())).id;
        if (targetId === undefined)
          return { success: false, error: "no target window id available" };
        await withWindowTimeout("window_resize", chrome.windows.update(targetId, windowUpdateInfoFromAction(action)));
        return { success: true };
      }
      case "window_list":
      case "window_get_all": {
        const windows = await withWindowTimeout("window_list", chrome.windows.getAll({ populate: true }));
        return {
          success: true,
          data: windows.map((w) => ({
            id: w.id,
            type: w.type,
            state: w.state,
            focused: w.focused,
            width: w.width,
            height: w.height,
            left: w.left,
            top: w.top,
            incognito: w.incognito,
            tabs: w.tabs?.map((t) => ({ id: t.id, url: t.url, title: t.title, active: t.active }))
          }))
        };
      }
    }
    return { success: false, error: `unknown window action: ${action.type}` };
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : String(err) };
  }
}

// extension/src/background/capabilities/navigation.ts
var HISTORY_GO_START_MS = 2000;
async function waitForNavigationStart(tabId, beforeUrl, timeoutMs = HISTORY_GO_START_MS) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const tab = await chrome.tabs.get(tabId).catch(() => null);
    if (!tab)
      return false;
    if (tab.status === "loading" || (tab.url ?? "") !== beforeUrl)
      return true;
    await new Promise((r) => setTimeout(r, 100));
  }
  return false;
}
async function historyGo(tabId, delta, deps = { waitForTabLoad }) {
  const label = delta < 0 ? "back" : "forward";
  const before = await chrome.tabs.get(tabId).catch(() => null);
  if (!before)
    return { success: false, error: `tab ${tabId} not found` };
  let apiError;
  try {
    if (delta < 0)
      await chrome.tabs.goBack(tabId);
    else
      await chrome.tabs.goForward(tabId);
    await deps.waitForTabLoad(tabId);
    return { success: true };
  } catch (err) {
    apiError = err.message;
  }
  let ack;
  try {
    const injected = await chrome.scripting.executeScript({
      target: { tabId },
      func: (d) => new Promise((resolve) => {
        for (const ev of ["popstate", "hashchange", "pagehide"])
          addEventListener(ev, () => resolve(ev), { once: true });
        setTimeout(() => resolve(false), 800);
        history.go(d);
      }),
      args: [delta]
    });
    const results = Array.isArray(injected) ? injected.map((r) => r?.result) : [];
    ack = results.find((r) => typeof r === "string");
  } catch (err) {
    if (!await waitForNavigationStart(tabId, before.url ?? "")) {
      return { success: false, error: `${apiError} (page-side history.${label}() also failed: ${err.message})` };
    }
    await deps.waitForTabLoad(tabId);
    return { success: true };
  }
  if (ack === "popstate" || ack === "hashchange")
    return { success: true };
  if (!ack && !await waitForNavigationStart(tabId, before.url ?? "")) {
    return { success: false, error: `no ${label} history for tab ${tabId} — nothing to go ${label} to` };
  }
  await deps.waitForTabLoad(tabId);
  return { success: true };
}
async function handleNavigationActions(action, tabId) {
  switch (action.type) {
    case "navigate":
      await chrome.tabs.update(tabId, { url: action.url });
      await waitForTabLoad(tabId);
      return { success: true };
    case "go_back":
      return historyGo(tabId, -1);
    case "go_forward":
      return historyGo(tabId, 1);
    case "reload":
      await chrome.tabs.reload(tabId, { bypassCache: !!action.bypassCache });
      await waitForTabLoad(tabId);
      return { success: true };
  }
  return { success: false, error: `unknown navigation action: ${action.type}` };
}

// extension/src/background/capabilities/cookies.ts
async function handleCookieActions(action, _tabId) {
  switch (action.type) {
    case "cookies_get": {
      const cookies = await chrome.cookies.getAll({ domain: action.domain });
      return { success: true, data: cookies };
    }
    case "cookies_set": {
      const cookie = await chrome.cookies.set(action.cookie);
      return { success: true, data: cookie };
    }
    case "cookies_delete":
      await chrome.cookies.remove({ url: action.url, name: action.name });
      return { success: true };
  }
  return { success: false, error: `unknown cookie action: ${action.type}` };
}

// extension/src/background/capabilities/history.ts
async function handleHistoryActions(action, _tabId) {
  switch (action.type) {
    case "history_search": {
      const items = await chrome.history.search({
        text: action.query || "",
        maxResults: action.maxResults || 50,
        startTime: action.startTime,
        endTime: action.endTime
      });
      return {
        success: true,
        data: items.map((i) => ({ url: i.url, title: i.title, lastVisit: i.lastVisitTime, visitCount: i.visitCount }))
      };
    }
    case "history_visits": {
      const visits = await chrome.history.getVisits({ url: action.url });
      return { success: true, data: visits };
    }
    case "history_delete":
      await chrome.history.deleteUrl({ url: action.url });
      return { success: true };
    case "history_delete_range":
      await chrome.history.deleteRange({
        startTime: action.startTime,
        endTime: action.endTime
      });
      return { success: true };
    case "history_delete_all":
      await chrome.history.deleteAll();
      return { success: true };
  }
  return { success: false, error: `unknown history action: ${action.type}` };
}

// extension/src/background/capabilities/bookmarks.ts
async function handleBookmarkActions(action, _tabId) {
  switch (action.type) {
    case "bookmark_tree": {
      const tree = await chrome.bookmarks.getTree();
      return { success: true, data: tree };
    }
    case "bookmark_search": {
      const results = await chrome.bookmarks.search(action.query);
      return {
        success: true,
        data: results.map((b) => ({ id: b.id, title: b.title, url: b.url, parentId: b.parentId }))
      };
    }
    case "bookmark_create": {
      const bm = await chrome.bookmarks.create({
        title: action.title,
        url: action.url,
        parentId: action.parentId
      });
      return { success: true, data: bm };
    }
    case "bookmark_delete":
      await chrome.bookmarks.remove(action.id);
      return { success: true };
    case "bookmark_update":
      await chrome.bookmarks.update(action.id, {
        title: action.title,
        url: action.url
      });
      return { success: true };
  }
  return { success: false, error: `unknown bookmark action: ${action.type}` };
}

// extension/src/background/capabilities/downloads.ts
async function handleDownloadActions(action, _tabId) {
  switch (action.type) {
    case "downloads_start": {
      const downloadId = await chrome.downloads.download({
        url: action.url,
        filename: action.filename,
        saveAs: !!action.saveAs
      });
      return { success: true, data: { downloadId } };
    }
    case "downloads_search": {
      const items = await chrome.downloads.search({
        query: action.query ? [action.query] : undefined,
        limit: action.limit || 20,
        orderBy: ["-startTime"]
      });
      return {
        success: true,
        data: items.map((d) => ({
          id: d.id,
          url: d.url,
          filename: d.filename,
          state: d.state,
          bytesReceived: d.bytesReceived,
          totalBytes: d.totalBytes,
          mime: d.mime,
          startTime: d.startTime
        }))
      };
    }
    case "downloads_cancel":
      await chrome.downloads.cancel(action.downloadId);
      return { success: true };
    case "downloads_pause":
      await chrome.downloads.pause(action.downloadId);
      return { success: true };
    case "downloads_resume":
      await chrome.downloads.resume(action.downloadId);
      return { success: true };
  }
  return { success: false, error: `unknown download action: ${action.type}` };
}

// extension/src/background/capabilities/sessions.ts
async function handleSessionActions(action, _tabId) {
  switch (action.type) {
    case "session_list": {
      const sessions = await chrome.sessions.getRecentlyClosed({
        maxResults: action.maxResults || 10
      });
      return {
        success: true,
        data: sessions.map((s) => ({
          tab: s.tab ? { url: s.tab.url, title: s.tab.title, sessionId: s.tab.sessionId } : undefined,
          window: s.window ? { sessionId: s.window.sessionId, tabCount: s.window.tabs?.length } : undefined,
          lastModified: s.lastModified
        }))
      };
    }
    case "session_restore": {
      const restored = await chrome.sessions.restore(action.sessionId);
      return { success: true, data: restored };
    }
  }
  return { success: false, error: `unknown session action: ${action.type}` };
}

// extension/src/background/capabilities/notifications.ts
async function handleNotificationActions(action, _tabId) {
  switch (action.type) {
    case "notification_create": {
      const notifId = await chrome.notifications.create(action.notifId || "", {
        type: "basic",
        title: action.title || "Interceptor",
        message: action.message || "",
        iconUrl: action.iconUrl || "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=="
      });
      return { success: true, data: { notifId } };
    }
    case "notification_clear":
      await chrome.notifications.clear(action.notifId);
      return { success: true };
  }
  return { success: false, error: `unknown notification action: ${action.type}` };
}

// extension/src/background/capabilities/search.ts
async function handleSearchActions(action, tabId) {
  const searchApi = chrome.search;
  if (action.type === "search_capability") {
    return {
      success: true,
      data: { available: typeof searchApi?.query === "function" }
    };
  }
  if (action.type === "search_query") {
    if (typeof searchApi?.query !== "function") {
      return {
        success: false,
        error: "websearch is unavailable in this browser context: chrome.search.query is not exposed; no fallback provider was used"
      };
    }
    const query = String(action.query || "");
    if (!query.trim())
      return { success: false, error: "websearch requires a non-empty query" };
    if (!Number.isInteger(tabId) || tabId <= 0) {
      return { success: false, error: "websearch requires a managed target tab" };
    }
    try {
      await searchApi.query({ text: query, tabId });
      return { success: true, data: { tabId, query } };
    } catch (err) {
      return { success: false, error: `default-provider search failed: ${err.message}` };
    }
  }
  return { success: false, error: `unknown search action: ${action.type}` };
}

// extension/src/background/capabilities/browsing-data.ts
async function handleBrowsingDataActions(action, _tabId) {
  if (action.type === "browsing_data_remove") {
    const since = action.since || 0;
    const types = {};
    const requested = action.types || ["cache"];
    for (const t of requested) {
      if (t === "cache")
        types.cache = true;
      if (t === "cookies")
        types.cookies = true;
      if (t === "history")
        types.history = true;
      if (t === "formData")
        types.formData = true;
      if (t === "downloads")
        types.downloads = true;
      if (t === "localStorage")
        types.localStorage = true;
      if (t === "indexedDB")
        types.indexedDB = true;
      if (t === "serviceWorkers")
        types.serviceWorkers = true;
      if (t === "passwords")
        types.passwords = true;
    }
    await chrome.browsingData.remove({ since }, types);
    return { success: true };
  }
  return { success: false, error: `unknown browsing data action: ${action.type}` };
}

// extension/src/background/capabilities/headers.ts
async function handleHeaderActions(action, _tabId) {
  if (action.type !== "headers_modify") {
    return { success: false, error: `unknown header action: ${action.type}` };
  }
  const rules = action.rules;
  if (!rules || rules.length === 0) {
    await chrome.declarativeNetRequest.updateDynamicRules({
      removeRuleIds: Array.from({ length: 100 }, (_, i) => i + 1)
    });
    return { success: true, data: "all header rules cleared" };
  }
  const dnrRules = rules.map((r, i) => ({
    id: i + 1,
    priority: 1,
    action: {
      type: "modifyHeaders",
      requestHeaders: [{
        header: r.header,
        operation: r.operation === "remove" ? "remove" : "set",
        value: r.value
      }]
    },
    condition: {
      urlFilter: "*",
      resourceTypes: [
        "main_frame",
        "sub_frame",
        "stylesheet",
        "script",
        "image",
        "font",
        "xmlhttprequest",
        "ping",
        "media",
        "websocket",
        "other"
      ]
    }
  }));
  await chrome.declarativeNetRequest.updateDynamicRules({
    removeRuleIds: dnrRules.map((r) => r.id),
    addRules: dnrRules
  });
  return { success: true };
}

// extension/src/background/capabilities/evaluate.ts
var CSP_BYPASS_RULE_ID_BASE = 910000;
function isTrustedTypesError(error) {
  if (!error)
    return false;
  return /trusted ?types|trustedscript|require-trusted-types-for|createPolicy/i.test(error);
}
function isCspUnsafeEvalError(error) {
  if (!error)
    return false;
  if (isTrustedTypesError(error))
    return false;
  return /content security policy|script-src|unsafe-eval/i.test(error) && /eval|evaluating a string|string as javascript/i.test(error);
}
function isCspEvalError(error) {
  if (!error)
    return false;
  return isTrustedTypesError(error) || isCspUnsafeEvalError(error);
}
function buildCspBypassRule(tabId) {
  return {
    id: CSP_BYPASS_RULE_ID_BASE + tabId,
    priority: 10,
    action: {
      type: "modifyHeaders",
      responseHeaders: [
        { header: "content-security-policy", operation: "remove" },
        { header: "content-security-policy-report-only", operation: "remove" }
      ]
    },
    condition: {
      tabIds: [tabId],
      resourceTypes: ["main_frame", "sub_frame"]
    }
  };
}
var USER_SCRIPT_CLONE = `const __c=v=>{if(v==null)return v;const t=typeof v;if(t==="string"||t==="number"||t==="boolean")return v;if(t==="bigint")return v.toString();try{return JSON.parse(JSON.stringify(v))}catch{try{return String(v)}catch{return null}}};`;
var USER_SCRIPT_CATCH = `catch(e){return{__ik:1,ok:false,error:String(e&&e.message||e)}}`;
var USER_SCRIPT_RAN_KEY = "interceptor.eval.ran";
function userScriptForms(code, nonce) {
  const key = `Symbol.for(${JSON.stringify(USER_SCRIPT_RAN_KEY)})`;
  return {
    expression: `(async()=>{${USER_SCRIPT_CLONE}try{return{__ik:1,ok:true,value:__c(await (async()=>(
${code}
))())}}${USER_SCRIPT_CATCH}})()`,
    statement: `globalThis[${key}]=${JSON.stringify(nonce)};try{
${code}
}catch(e){({__ik:1,ok:false,error:String(e&&e.message||e)})}`,
    probe: `(()=>{const k=${key};const r=globalThis[k];delete globalThis[k];return r===${JSON.stringify(nonce)}})()`,
    asyncBody: `(async()=>{${USER_SCRIPT_CLONE}try{
${code}
;return{__ik:1,ok:true}}${USER_SCRIPT_CATCH}})()`
  };
}
var USER_SCRIPT_SYNTAX_ERROR = "SyntaxError: the code did not parse as an expression or as statements (or returned a value the browser could not serialize). Check quoting; multi-statement code that needs await should end with `return <value>`.";
function unwrapUserScriptResult(raw) {
  const r = raw;
  if (r && typeof r === "object" && r.__ik === 1) {
    return r.ok ? { success: true, data: r.value } : { success: false, error: r.error ?? "eval failed" };
  }
  return { success: true, data: raw };
}
async function executeWithUserScripts(tabId, world, code, frameId) {
  try {
    if (!chrome.userScripts || typeof chrome.userScripts.execute !== "function") {
      return { available: false, reason: "chrome.userScripts.execute is unavailable (check Allow User Scripts and browser support)" };
    }
    const forms = userScriptForms(code, crypto.randomUUID());
    const run = async (js) => {
      const results = await chrome.userScripts.execute({
        target: { tabId, ...frameId !== undefined ? { frameIds: [frameId] } : {} },
        js: [{ code: js }],
        world
      });
      return frameId === undefined ? results[0] : results.find((r) => r.frameId === frameId) ?? (results.length === 1 && results[0]?.frameId === undefined ? results[0] : undefined);
    };
    const settled = (first2) => {
      if (!first2)
        return { available: true, result: { success: false, error: `no result for frame ${frameId ?? 0}` } };
      if (first2.error)
        return { available: true, result: { success: false, error: first2.error } };
      return;
    };
    let first = await run(forms.expression);
    let done = settled(first);
    if (done)
      return done;
    if (first.result !== undefined && first.result !== null)
      return { available: true, result: unwrapUserScriptResult(first.result) };
    first = await run(forms.statement);
    done = settled(first);
    if (done)
      return done;
    if (first.result !== undefined && first.result !== null)
      return { available: true, result: unwrapUserScriptResult(first.result) };
    const ran = await run(forms.probe);
    if (ran?.result === true)
      return { available: true, result: { success: true, data: first.result } };
    first = await run(forms.asyncBody);
    done = settled(first);
    if (done)
      return done;
    if (first.result !== undefined && first.result !== null)
      return { available: true, result: unwrapUserScriptResult(first.result) };
    return { available: true, result: { success: false, error: USER_SCRIPT_SYNTAX_ERROR } };
  } catch (err) {
    const message = err.message || String(err);
    if (/userScripts|Developer mode|Allow User Scripts|permission|undefined/i.test(message)) {
      return { available: false, reason: message };
    }
    return { available: true, result: { success: false, error: message } };
  }
}
async function executeEval(tabId, world, code, frameId) {
  const results = await chrome.scripting.executeScript({
    target: { tabId, ...frameId !== undefined ? { frameIds: [frameId] } : {} },
    world,
    args: [code, IK_TT_POLICY, TT_POLICY_NAME],
    func: async (c, ttKey, ttName) => {
      const TT = Symbol.for(ttKey);
      function clone(v) {
        if (v === null || v === undefined)
          return v;
        const t = typeof v;
        if (t === "string" || t === "number" || t === "boolean")
          return v;
        if (t === "bigint")
          return v.toString();
        try {
          return JSON.parse(JSON.stringify(v));
        } catch {
          try {
            return String(v);
          } catch {
            return null;
          }
        }
      }
      try {
        const w = window;
        let source = c;
        if (w.trustedTypes) {
          if (!w[TT]) {
            try {
              w[TT] = w.trustedTypes.createPolicy(ttName, {
                createScript: (s) => s
              });
            } catch {
              try {
                w[TT] = w.trustedTypes.createPolicy(ttName + "-" + Date.now(), {
                  createScript: (s) => s
                });
              } catch {}
            }
          }
          if (w[TT]) {
            source = w[TT].createScript(c);
          }
        }
        let r = (0, eval)(source);
        if (r && typeof r.then === "function") {
          r = await r;
        }
        return { success: true, data: clone(r) };
      } catch (e) {
        return { success: false, error: e?.message || String(e) };
      }
    }
  });
  const first = frameId === undefined ? results[0] : results.find((r) => r.frameId === frameId) ?? (results.length === 1 && results[0]?.frameId === undefined ? results[0] : undefined);
  return first?.result ?? { success: false, error: `no result for frame ${frameId ?? 0}` };
}
async function installCspBypassForTab(tabId) {
  const rule = buildCspBypassRule(tabId);
  await chrome.declarativeNetRequest.updateSessionRules({
    removeRuleIds: [rule.id],
    addRules: [rule]
  });
}
async function reloadTabForCspRetry(tabId) {
  await chrome.tabs.reload(tabId, { bypassCache: true });
  await waitForTabLoad(tabId, 15000);
}
async function runWithCspStripBypass(tabId, world, run) {
  const first = await run(tabId, world);
  if (first.success || world !== "MAIN") {
    return first;
  }
  if (!isCspUnsafeEvalError(first.error) && !isTrustedTypesError(first.error)) {
    return first;
  }
  try {
    await installCspBypassForTab(tabId);
    await reloadTabForCspRetry(tabId);
  } catch (err) {
    return {
      success: false,
      error: `MAIN-world eval hit page CSP and automatic CSP bypass setup failed: ${err.message}`,
      data: { originalError: first.error, cspBypassAttempted: false }
    };
  }
  let retried;
  try {
    retried = await run(tabId, "MAIN");
  } catch (err) {
    retried = { success: false, error: err instanceof Error ? err.message : String(err) };
  }
  if (retried.success) {
    return {
      ...retried,
      data: {
        value: retried.data,
        cspBypassApplied: true,
        originalError: first.error
      }
    };
  }
  return {
    success: false,
    error: retried.error || first.error || "MAIN-world eval failed after CSP bypass retry",
    data: {
      originalError: first.error,
      cspBypassApplied: true
    }
  };
}
async function handleEvaluateActions(action, tabId) {
  if (action.type !== "evaluate") {
    return { success: false, error: `unknown evaluate action: ${action.type}` };
  }
  const code = action.code;
  const frameId = action.frameId;
  if (frameId !== undefined && (!Number.isSafeInteger(frameId) || frameId < 0)) {
    return { success: false, error: "frameId must be a non-negative safe integer" };
  }
  if (typeof code !== "string" || !code.trim())
    return { success: false, error: "evaluate requires JavaScript code" };
  const world = action.world === "ISOLATED" ? "ISOLATED" : "MAIN";
  const initialUserScriptWorld = world === "MAIN" ? "MAIN" : "USER_SCRIPT";
  const userScriptAttempt = await executeWithUserScripts(tabId, initialUserScriptWorld, code, frameId);
  if (userScriptAttempt.available && (world !== "MAIN" || !isCspEvalError(userScriptAttempt.result?.error))) {
    return userScriptAttempt.result ?? { success: false, error: "no result" };
  }
  try {
    const result = action.noCspReload === true ? await executeEval(tabId, world, code, frameId) : await runWithCspStripBypass(tabId, world, (t, w) => executeEval(t, w, code, frameId));
    if (!result.success && world === "ISOLATED" && isCspEvalError(result.error)) {
      return {
        success: false,
        error: `Isolated eval is unavailable: ${userScriptAttempt.reason ?? "the userScripts execution failed"}. Enable Allow User Scripts for this extension and reload it, or explicitly use eval --main for page-world access.`,
        data: { originalError: result.error, requestedWorld: world, userScriptsAvailable: userScriptAttempt.available }
      };
    }
    return result;
  } catch (err) {
    return { success: false, error: `eval in frame ${frameId ?? 0} failed: ${err.message}` };
  }
}

// extension/src/background/capabilities/binary-sink.ts
var DEFAULT_CHUNK_SIZE = 1024 * 1024;
async function executeNormalize(tabId, world, code) {
  const results = await chrome.scripting.executeScript({
    target: { tabId },
    world,
    args: [code, IK_SINK_TT_POLICY, SINK_TT_POLICY_NAME],
    func: async (sourceCode, ttKey, ttName) => {
      const TT = Symbol.for(ttKey);
      async function normalize(value) {
        if (value && typeof value.then === "function") {
          value = await value;
        }
        if (value instanceof Blob) {
          return {
            url: URL.createObjectURL(value),
            size: value.size,
            mime: value.type || "application/octet-stream",
            kind: value instanceof File ? "file" : "blob",
            created: true
          };
        }
        if (value instanceof ArrayBuffer) {
          const blob = new Blob([value], { type: "application/octet-stream" });
          return {
            url: URL.createObjectURL(blob),
            size: blob.size,
            mime: blob.type,
            kind: "arraybuffer",
            created: true
          };
        }
        if (ArrayBuffer.isView(value)) {
          const source = value;
          const bytes = new Uint8Array(source.byteLength);
          bytes.set(new Uint8Array(source.buffer, source.byteOffset, source.byteLength));
          const blob = new Blob([bytes.buffer], { type: "application/octet-stream" });
          return {
            url: URL.createObjectURL(blob),
            size: blob.size,
            mime: blob.type,
            kind: "arraybuffer-view",
            created: true
          };
        }
        if (typeof value === "string") {
          if (value.startsWith("blob:")) {
            return {
              url: value,
              size: -1,
              mime: "application/octet-stream",
              kind: "blob-url",
              created: false
            };
          }
          const blob = new Blob([value], { type: "text/plain;charset=utf-8" });
          return {
            url: URL.createObjectURL(blob),
            size: blob.size,
            mime: blob.type,
            kind: "text",
            created: true
          };
        }
        if (value && typeof value === "object") {
          const record = value;
          const candidate = record.url ?? record.blobUrl ?? record.href;
          if (typeof candidate === "string" && candidate.startsWith("blob:")) {
            return {
              url: candidate,
              size: typeof record.size === "number" ? record.size : -1,
              mime: typeof record.type === "string" ? record.type : "application/octet-stream",
              kind: "blob-url-object",
              created: false
            };
          }
        }
        throw new Error("expression must return Blob, File, ArrayBuffer, typed array, string, or blob: URL");
      }
      try {
        const w = window;
        let evalSource = sourceCode;
        if (w.trustedTypes) {
          if (!w[TT]) {
            w[TT] = w.trustedTypes.createPolicy(ttName, {
              createScript: (s) => s
            });
          }
          evalSource = w[TT].createScript(sourceCode);
        }
        const value = (0, eval)(evalSource);
        return { success: true, data: await normalize(value) };
      } catch (err) {
        return { success: false, error: err.message || String(err) };
      }
    }
  });
  return results[0]?.result ?? { success: false, error: "no result" };
}
async function prepareByteSource(tabId, code, world) {
  const evalResult = await runWithCspStripBypass(tabId, world, (t, w) => executeNormalize(t, w, code));
  if (!evalResult.success)
    return evalResult;
  let descriptor = evalResult.data;
  if (descriptor && typeof descriptor === "object" && !("url" in descriptor) && "value" in descriptor) {
    descriptor = descriptor.value;
  }
  if (!descriptor || typeof descriptor !== "object" || typeof descriptor.url !== "string") {
    return { success: false, error: "byte source normalization returned no blob URL" };
  }
  return { success: true, data: descriptor };
}
async function cleanupByteSource(tabId, source, world) {
  if (!source.created)
    return;
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      world,
      args: [source.url],
      func: (url) => {
        try {
          URL.revokeObjectURL(url);
        } catch {}
      }
    });
  } catch {}
}
async function stageByteSource(tabId, source) {
  const results = await chrome.scripting.executeScript({
    target: { tabId },
    world: "ISOLATED",
    args: [source.url],
    func: async (url) => {
      const response = await fetch(url);
      if (!response.ok && !url.startsWith("blob:")) {
        throw new Error(`source fetch failed: ${response.status} ${response.statusText}`);
      }
      const bytes = new Uint8Array(await response.arrayBuffer());
      const key = "__interceptor_binary_sink_" + crypto.randomUUID().replace(/-/g, "");
      globalThis[key] = bytes;
      return { key, bytes: bytes.byteLength };
    }
  });
  const result = results[0]?.result;
  if (!result?.key || typeof result.bytes !== "number") {
    throw new Error("failed to stage byte source");
  }
  return result;
}
async function cleanupStagedByteSource(tabId, staged) {
  if (!staged)
    return;
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      world: "ISOLATED",
      args: [staged.key],
      func: (key) => {
        try {
          delete globalThis[key];
        } catch {}
      }
    });
  } catch {}
}
async function readStagedChunk(tabId, key, offset, length) {
  const results = await chrome.scripting.executeScript({
    target: { tabId },
    world: "ISOLATED",
    args: [key, offset, length],
    func: (sourceKey, start, count) => {
      const bytes2 = globalThis[sourceKey];
      if (!bytes2)
        throw new Error("staged bytes not found");
      const end = Math.min(start + count, bytes2.byteLength);
      const slice = bytes2.subarray(start, end);
      let binary2 = "";
      const block = 32768;
      for (let i = 0;i < slice.byteLength; i += block) {
        binary2 += String.fromCharCode(...slice.subarray(i, Math.min(i + block, slice.byteLength)));
      }
      return btoa(binary2);
    }
  });
  const b64 = results[0]?.result;
  if (typeof b64 !== "string")
    throw new Error("failed to read staged chunk");
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0;i < binary.length; i++)
    bytes[i] = binary.charCodeAt(i);
  return bytes;
}
function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
function connectSinkSocket() {
  const WS_URL = "ws://localhost:19222";
  const MAGIC = new Uint8Array([73, 66, 83, 49]);
  const encoder = new TextEncoder;
  const sinkId = crypto.randomUUID();
  const pending = new Map;
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(WS_URL);
    ws.binaryType = "arraybuffer";
    const timer = setTimeout(() => reject(new Error("binary sink websocket open timeout")), 1e4);
    ws.onopen = () => {
      clearTimeout(timer);
      const request = (payload) => {
        const id = crypto.randomUUID();
        payload.id = id;
        return new Promise((reqResolve, reqReject) => {
          pending.set(id, { resolve: reqResolve, reject: reqReject });
          ws.send(JSON.stringify(payload));
        });
      };
      const waitForBackpressure = async () => {
        while (ws.bufferedAmount > 16 * 1024 * 1024)
          await wait(5);
      };
      const sendChunk = async (seq, bytes) => {
        const header = encoder.encode(JSON.stringify({ sinkId, seq }));
        const frame = new Uint8Array(8 + header.byteLength + bytes.byteLength);
        frame.set(MAGIC, 0);
        new DataView(frame.buffer).setUint32(4, header.byteLength, true);
        frame.set(header, 8);
        frame.set(bytes, 8 + header.byteLength);
        ws.send(frame);
        await waitForBackpressure();
      };
      resolve({
        ws,
        sinkId,
        request,
        sendChunk,
        close: () => ws.close()
      });
    };
    ws.onerror = () => {
      clearTimeout(timer);
      reject(new Error("binary sink websocket failed"));
    };
    ws.onmessage = (event) => {
      if (typeof event.data !== "string")
        return;
      let message;
      try {
        message = JSON.parse(event.data);
      } catch {
        return;
      }
      if (!message.id || !pending.has(message.id))
        return;
      const callbacks = pending.get(message.id);
      pending.delete(message.id);
      callbacks.resolve(message);
    };
    ws.onclose = () => {
      for (const callbacks of pending.values()) {
        callbacks.reject(new Error("binary sink websocket closed"));
      }
      pending.clear();
    };
  });
}
async function streamByteSource(tabId, source, out, chunkSize) {
  let staged = null;
  let socket = null;
  let seq = 0;
  let streamed = 0;
  try {
    staged = await stageByteSource(tabId, source);
    socket = await connectSinkSocket();
    const open = await socket.request({
      type: "binary_sink_open",
      sinkId: socket.sinkId,
      path: out,
      expectedBytes: staged.bytes,
      mime: source.mime,
      sourceUrl: source.url
    });
    if (!open.result?.success)
      throw new Error(open.result?.error || "binary sink open failed");
    for (let offset = 0;offset < staged.bytes; offset += chunkSize) {
      const bytes = await readStagedChunk(tabId, staged.key, offset, chunkSize);
      if (bytes.byteLength === 0)
        continue;
      await socket.sendChunk(seq++, bytes);
      streamed += bytes.byteLength;
    }
    while (socket.ws.bufferedAmount > 0)
      await wait(5);
    const close = await socket.request({ type: "binary_sink_close", sinkId: socket.sinkId });
    if (!close.result?.success)
      throw new Error(close.result?.error || "binary sink close failed");
    return {
      success: true,
      data: {
        ...close.result.data || {},
        sourceKind: source.kind,
        sourceMime: source.mime,
        sourceBytes: source.size,
        stagedBytes: staged.bytes,
        streamedBytes: streamed,
        chunks: seq
      }
    };
  } catch (err) {
    if (socket) {
      try {
        await socket.request({ type: "binary_sink_abort", sinkId: socket.sinkId, reason: err.message || String(err) });
      } catch {}
    }
    return { success: false, error: err.message || String(err) };
  } finally {
    if (socket)
      socket.close();
    await cleanupStagedByteSource(tabId, staged);
  }
}
async function handleBinarySinkActions(action, tabId) {
  if (action.type !== "binary_sink_save") {
    return { success: false, error: `unknown binary-sink action: ${action.type}` };
  }
  const code = action.code;
  const out = action.out;
  const world = action.world === "ISOLATED" ? "ISOLATED" : "MAIN";
  const chunkSize = typeof action.chunkSize === "number" && action.chunkSize > 0 ? Math.floor(action.chunkSize) : DEFAULT_CHUNK_SIZE;
  if (!out)
    return { success: false, error: "missing output path" };
  if (!code)
    return { success: false, error: "missing expression" };
  const prepared = await prepareByteSource(tabId, code, world);
  if (!prepared.success)
    return prepared;
  const source = prepared.data;
  try {
    return await streamByteSource(tabId, source, out, chunkSize);
  } finally {
    await cleanupByteSource(tabId, source, world);
  }
}

// extension/src/background/capabilities/style.ts
var handleStore = new Map;
function randomHandle() {
  try {
    if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
      return "s_" + crypto.randomUUID();
    }
  } catch {}
  return "s_" + Math.random().toString(36).slice(2) + Date.now().toString(36);
}
function dropHandlesForTab(tabId) {
  for (const [handle, rec] of handleStore) {
    if (rec.tabId === tabId)
      handleStore.delete(handle);
  }
}
var listenerRegistered = false;
function ensureTabCloseListener() {
  if (listenerRegistered)
    return;
  try {
    chrome.tabs.onRemoved.addListener((tabId) => dropHandlesForTab(tabId));
    listenerRegistered = true;
  } catch {}
}
async function handleStyleInject(action, tabId) {
  ensureTabCloseListener();
  const css = action.css;
  if (typeof css !== "string" || !css.trim()) {
    return { success: false, error: "style_inject requires a non-empty 'css' string" };
  }
  const originRaw = action.origin || "USER";
  const origin = originRaw === "AUTHOR" ? "AUTHOR" : "USER";
  const frameIdsArg = action.frameIds;
  const allFrames = action.allFrames === true || !frameIdsArg && action.allFrames !== false;
  const target = frameIdsArg && frameIdsArg.length ? { tabId, frameIds: frameIdsArg } : { tabId, allFrames };
  try {
    await chrome.scripting.insertCSS({
      target,
      css,
      origin
    });
  } catch (err) {
    return { success: false, error: err.message || String(err) };
  }
  const handle = randomHandle();
  handleStore.set(handle, {
    tabId,
    frameIds: frameIdsArg,
    allFrames,
    css,
    origin
  });
  let frames = [];
  if (frameIdsArg && frameIdsArg.length)
    frames = [...frameIdsArg];
  else if (allFrames) {
    try {
      const list = await chrome.webNavigation.getAllFrames({ tabId });
      frames = list?.map((f) => f.frameId) ?? [];
    } catch {
      frames = [];
    }
  } else {
    frames = [0];
  }
  return { success: true, data: { handle, frames }, tabId };
}
async function handleStyleRemove(action, tabId) {
  const handle = action.handle;
  if (!handle)
    return { success: false, error: "style_remove requires 'handle'" };
  const rec = handleStore.get(handle);
  if (!rec) {
    return { success: true, data: { removed: false, reason: "unknown or already-removed handle" }, tabId };
  }
  const target = rec.frameIds && rec.frameIds.length ? { tabId: rec.tabId, frameIds: rec.frameIds } : { tabId: rec.tabId, allFrames: rec.allFrames };
  try {
    await chrome.scripting.removeCSS({
      target,
      css: rec.css,
      origin: rec.origin
    });
  } catch (err) {
    handleStore.delete(handle);
    return {
      success: true,
      data: {
        removed: false,
        reason: `removeCSS threw (tab may be closed): ${err.message}`
      },
      tabId
    };
  }
  handleStore.delete(handle);
  return { success: true, data: { removed: true }, tabId };
}
async function handleStyleActions(action, tabId) {
  if (action.type === "style_inject")
    return handleStyleInject(action, tabId);
  if (action.type === "style_remove")
    return handleStyleRemove(action, tabId);
  return { success: false, error: `unknown style action: ${action.type}` };
}

// extension/src/background/capabilities/frames.ts
async function handleFrameActions(action, tabId, sendFrame = sendToContentScript) {
  if (action.type === "frames_list") {
    const frames = await chrome.webNavigation.getAllFrames({ tabId });
    return {
      success: true,
      data: frames?.map((f) => ({ frameId: f.frameId, url: f.url, parentFrameId: f.parentFrameId }))
    };
  }
  if (action.type === "frames_read_tree") {
    const depth = action.depth || 15;
    const filter = action.filter || "interactive";
    const maxChars = action.maxChars || 50000;
    const includeStyle = action.includeStyle === true;
    const treeFormat = action.treeFormat === "compact" ? "compact" : "verbose";
    const includeText = action.includeText === true;
    const targetFrameId = typeof action.frameId === "number" ? action.frameId : undefined;
    const targetIndex = typeof action.index === "number" ? action.index : undefined;
    const targetRef = typeof action.ref === "string" ? action.ref : undefined;
    let frames;
    try {
      frames = await chrome.webNavigation.getAllFrames({ tabId }) || undefined;
    } catch (err) {
      return { success: false, error: `getAllFrames failed: ${err.message}` };
    }
    if (!frames || !frames.length) {
      return { success: true, data: { frames: [] }, tabId };
    }
    const frameList = targetFrameId === undefined ? frames : frames.filter((frame) => frame.frameId === targetFrameId);
    const results = await Promise.all(frameList.map(async (f) => {
      const entry = {
        frameId: f.frameId,
        parentFrameId: f.parentFrameId,
        url: f.url
      };
      try {
        const treeAction = {
          type: "get_a11y_tree",
          depth,
          filter,
          maxChars,
          includeStyle,
          frameId: f.frameId
        };
        if (targetIndex !== undefined)
          treeAction.index = targetIndex;
        if (targetRef)
          treeAction.ref = targetRef;
        const treeResp = await sendFrame(tabId, treeAction, f.frameId);
        if (!treeResp.success) {
          entry.opaque = true;
          entry.error = treeResp.error || "unreachable frame";
        } else {
          const raw = typeof treeResp.data === "string" ? treeResp.data : "";
          entry.tree = f.frameId === 0 ? raw : raw.replace(/\[e(\d+)\]/g, `[e${f.frameId}_$1]`);
        }
        if (includeText) {
          const textAction = { type: "extract_text", frameId: f.frameId };
          if (targetIndex !== undefined)
            textAction.index = targetIndex;
          if (targetRef)
            textAction.ref = targetRef;
          const textResp = await sendFrame(tabId, textAction, f.frameId);
          if (textResp.success && typeof textResp.data === "string") {
            entry.text = textResp.data;
          }
        }
      } catch (err) {
        entry.opaque = true;
        entry.error = err.message || "injection failed";
      }
      return entry;
    }));
    return { success: true, data: { frames: results }, tabId };
  }
  if (action.type === "frames_find") {
    const query = String(action.query || "").trim();
    if (!query)
      return { success: false, error: "find requires a non-empty query" };
    const limit = typeof action.limit === "number" ? Math.max(0, Math.floor(action.limit)) : 10;
    const role = typeof action.role === "string" ? action.role : "";
    const mode = role ? "elements" : action.mode === "text" || action.mode === "elements" ? action.mode : "hybrid";
    let frames;
    try {
      frames = await chrome.webNavigation.getAllFrames({ tabId }) || undefined;
    } catch (err) {
      return { success: false, error: `getAllFrames failed: ${err.message}` };
    }
    if (!frames?.length) {
      const data2 = { query, mode, frames: [] };
      if (mode !== "elements") {
        data2.text = {
          total: 0,
          returned: 0,
          truncated: false,
          scannedCharacters: 0,
          scanTruncated: false,
          matches: []
        };
      }
      if (mode !== "text") {
        data2.elements = { total: 0, returned: 0, truncated: false, matches: [] };
      }
      return { success: true, data: data2, tabId };
    }
    const perFrameResults = await Promise.all(frames.map(async (frame) => {
      const frameMeta = {
        frameId: frame.frameId,
        parentFrameId: frame.parentFrameId,
        url: frame.url
      };
      const result = {
        frameMeta,
        textMatches: [],
        elementMatches: [],
        textTotal: 0,
        elementTotal: 0,
        scannedCharacters: 0,
        scanTruncated: false
      };
      try {
        const response = await sendFrame(tabId, {
          type: "find_element",
          query,
          role,
          mode,
          limit,
          frameId: frame.frameId
        }, frame.frameId);
        if (!response.success || !response.data || typeof response.data !== "object") {
          frameMeta.opaque = true;
          frameMeta.error = response.error || "unreachable frame";
          return result;
        }
        const data2 = response.data;
        if (data2.text) {
          result.textTotal = data2.text.total;
          result.scannedCharacters = data2.text.scannedCharacters || 0;
          result.scanTruncated = data2.text.scanTruncated === true;
          result.textMatches = data2.text.matches.map((match) => ({ ...match, frameId: frame.frameId }));
        }
        if (data2.elements) {
          result.elementTotal = data2.elements.total;
          for (const match of data2.elements.matches) {
            const refId = frame.frameId === 0 ? match.refId : match.refId.replace(/^e(\d+)$/, `e${frame.frameId}_$1`);
            result.elementMatches.push({ ...match, refId, frameId: frame.frameId });
          }
        }
      } catch (err) {
        frameMeta.opaque = true;
        frameMeta.error = err.message || "injection failed";
      }
      return result;
    }));
    const frameResults = perFrameResults.map((result) => result.frameMeta);
    const textMatches = [];
    const elementMatches = [];
    let textTotal = 0;
    let elementTotal = 0;
    let scannedCharacters = 0;
    let scanTruncated = false;
    for (const result of perFrameResults) {
      textTotal += result.textTotal;
      elementTotal += result.elementTotal;
      scannedCharacters += result.scannedCharacters;
      scanTruncated ||= result.scanTruncated;
      textMatches.push(...result.textMatches);
      elementMatches.push(...result.elementMatches);
    }
    const data = { query, mode, frames: frameResults };
    if (mode !== "elements") {
      const matches = textMatches.slice(0, limit);
      data.text = {
        total: textTotal,
        returned: matches.length,
        truncated: textTotal > matches.length,
        scannedCharacters,
        scanTruncated,
        matches
      };
    }
    if (mode !== "text") {
      const matches = elementMatches.slice(0, limit);
      data.elements = {
        total: elementTotal,
        returned: matches.length,
        truncated: elementTotal > matches.length,
        matches
      };
    }
    return { success: true, data, tabId };
  }
  return { success: false, error: `unknown frame action: ${action.type}` };
}

// extension/src/background/capabilities/meta.ts
async function handleMetaActions(action, tabId) {
  switch (action.type) {
    case "status": {
      let tabLifecycle;
      try {
        const resolved = await resolveTabLifecycle();
        tabLifecycle = { ...resolved.policy, source: resolved.source };
      } catch {}
      return {
        success: true,
        data: {
          connected: true,
          version: chrome.runtime.getManifest().version,
          ...tabLifecycle ? { tabLifecycle } : {}
        }
      };
    }
    case "reload_extension":
      setTimeout(() => chrome.runtime.reload(), 100);
      return { success: true, data: "reloading in 100ms" };
    case "capabilities": {
      const daemonConnected = activeTransport !== "none";
      const hasDebugger = chrome.runtime.getManifest().permissions?.includes("debugger") ?? false;
      const hasUserScriptsPermission = chrome.runtime.getManifest().permissions?.includes("userScripts") ?? false;
      const debuggerActive = debuggerAttached.size > 0;
      let userScriptsApi = false;
      let userScriptsEnabled = false;
      let userScriptsError;
      try {
        userScriptsApi = !!chrome.userScripts;
        if (chrome.userScripts) {
          await chrome.userScripts.getScripts();
          userScriptsEnabled = true;
        }
      } catch (err) {
        userScriptsError = err.message || String(err);
      }
      return {
        success: true,
        data: {
          layers: {
            os_input: daemonConnected,
            tabCapture: true,
            cdp_debugger: hasDebugger,
            debugger_active: debuggerActive
          },
          userScripts: {
            manifest_permission: hasUserScriptsPermission,
            api_present: userScriptsApi,
            enabled: userScriptsEnabled,
            ...userScriptsError ? { error: userScriptsError } : {}
          },
          daemon: daemonConnected,
          infoBannerHeight: debuggerActive ? 35 : 0
        }
      };
    }
    case "cdp_tree": {
      const depth = action.depth || undefined;
      const result = await cdpAttachActDetach(tabId, "Accessibility.getFullAXTree", depth ? { depth } : undefined);
      if (!result.success)
        return { success: false, error: result.error };
      const nodes = result.data?.nodes || [];
      const formatted = nodes.map((n) => {
        const role = n.role?.value || "";
        const name = n.name?.value || "";
        const nodeId = n.nodeId || "";
        return `[${nodeId}] ${role} "${name}"`;
      }).join(`
`);
      return { success: true, data: formatted || "empty tree" };
    }
    case "brand_set_tab_group": {
      const title = typeof action.title === "string" ? action.title.trim() : "";
      if (!title)
        return { success: false, error: "brand_set_tab_group requires a non-empty title" };
      const color = typeof action.color === "string" ? action.color : "cyan";
      await chrome.storage.local.set({ brandTabGroup: { title, color } });
      return { success: true, data: { brandTabGroup: { title, color } } };
    }
  }
  return { success: false, error: `unknown meta action: ${action.type}` };
}

// extension/src/background/capabilities/passive-net.ts
var PAGE_COMM_CONFIG_KEY = "interceptor_page_comm_capture";
var PAGE_COMM_SCRIPT_ID = "interceptor-page-comm-capture";
async function savePageCommConfig(config) {
  await chrome.storage.local.set({ [PAGE_COMM_CONFIG_KEY]: config });
}
async function readPageCommConfig() {
  const stored = await chrome.storage.local.get(PAGE_COMM_CONFIG_KEY);
  const config = stored[PAGE_COMM_CONFIG_KEY];
  return {
    enabled: config?.enabled === true,
    patterns: Array.isArray(config?.patterns) && config.patterns.length > 0 ? config.patterns : ["<all_urls>"],
    persistAcrossSessions: config?.persistAcrossSessions === true,
    updatedAt: typeof config?.updatedAt === "number" ? config.updatedAt : 0
  };
}
async function registerPageCommScript(config) {
  try {
    await chrome.scripting.unregisterContentScripts({ ids: [PAGE_COMM_SCRIPT_ID] });
  } catch {}
  if (!config.enabled)
    return;
  await chrome.scripting.registerContentScripts([{
    id: PAGE_COMM_SCRIPT_ID,
    js: ["inject-net.js"],
    matches: config.patterns.length > 0 ? config.patterns : ["<all_urls>"],
    runAt: "document_start",
    world: "MAIN",
    allFrames: true,
    matchOriginAsFallback: true,
    persistAcrossSessions: config.persistAcrossSessions
  }]);
}
async function injectPageCommNow(tabId) {
  try {
    await chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      files: ["inject-net.js"],
      world: "MAIN",
      injectImmediately: true
    });
    return { success: true };
  } catch (err) {
    return { success: false, error: err.message };
  }
}
function restorePageCommCaptureConfig() {
  readPageCommConfig().then((config) => config.enabled ? registerPageCommScript(config) : undefined).catch((err) => console.warn("failed to restore page communication capture config:", err.message));
}
var NET_LOG_BODY_BUDGET_BYTES = 8 * 1024 * 1024;
var utf8 = new TextEncoder;
function budgetNetLogEntries(entries, budgetBytes = NET_LOG_BODY_BUDGET_BYTES) {
  const out = new Array(entries.length);
  let used = 0;
  let over = false;
  for (let i = entries.length - 1;i >= 0; i--) {
    const entry = entries[i];
    if (!over) {
      let size = 0;
      try {
        size = utf8.encode(JSON.stringify(entry)).byteLength;
      } catch {
        size = 0;
      }
      used += size;
      if (used <= budgetBytes) {
        out[i] = entry;
        continue;
      }
      over = true;
    }
    out[i] = typeof entry.body === "string" && entry.body.length > 0 ? { ...entry, body: "", truncated: true } : entry;
  }
  return out;
}
async function handlePassiveNetActions(action, tabId) {
  switch (action.type) {
    case "net_log": {
      const result = await sendNetDirect(tabId, {
        type: "get_net_log",
        filter: action.filter,
        since: action.since
      });
      if (!result.success)
        return { success: false, error: result.error || "failed to get passive net log" };
      let entries = result.data || [];
      const limit = action.limit || 100;
      entries = budgetNetLogEntries(entries.slice(-limit));
      return { success: true, data: entries };
    }
    case "page_comm_log": {
      const result = await sendNetDirect(tabId, {
        type: "get_page_comm_log",
        filter: action.filter,
        entryType: action.entryType,
        since: action.since,
        limit: action.limit
      });
      if (!result.success)
        return { success: false, error: result.error || "failed to get page communication log" };
      return { success: true, data: result.data || [] };
    }
    case "page_comm_clear": {
      const result = await sendNetDirect(tabId, { type: "clear_page_comm_log" });
      return result.success ? { success: true, data: "page communication log cleared" } : { success: false, error: result.error || "failed to clear page communication log" };
    }
    case "page_comm_enable": {
      const patterns = Array.isArray(action.patterns) && action.patterns.length > 0 ? action.patterns : ["<all_urls>"];
      const config = {
        enabled: true,
        patterns,
        persistAcrossSessions: action.persistAcrossSessions === true,
        updatedAt: Date.now()
      };
      await savePageCommConfig(config);
      await registerPageCommScript(config);
      const injected = await injectPageCommNow(tabId);
      if (!injected.success) {
        return { success: false, error: injected.error || "failed to inject page communication capture script" };
      }
      if (action.reload === true) {
        await chrome.tabs.reload(tabId);
      }
      return {
        success: true,
        data: {
          enabled: true,
          tabId,
          patterns,
          reload: action.reload === true,
          mode: action.reload === true ? "from-start" : "attach-now",
          note: action.reload === true ? "capture is armed before reload; startup WebSockets are covered after navigation starts" : "attach-now captures future WebSocket, Beacon, and BroadcastChannel activity; existing WebSocket instances are not retroactively captured"
        }
      };
    }
    case "page_comm_disable": {
      const current = await readPageCommConfig();
      const config = {
        ...current,
        enabled: false,
        updatedAt: Date.now()
      };
      await savePageCommConfig(config);
      try {
        await chrome.scripting.unregisterContentScripts({ ids: [PAGE_COMM_SCRIPT_ID] });
      } catch {}
      return { success: true, data: { enabled: false } };
    }
    case "page_comm_status": {
      return { success: true, data: await readPageCommConfig() };
    }
    case "net_clear": {
      const result = await sendNetDirect(tabId, { type: "clear_net_log" });
      return result.success ? { success: true, data: "passive net log cleared" } : { success: false, error: result.error };
    }
    case "net_headers": {
      const result = await sendNetDirect(tabId, {
        type: "get_captured_headers",
        filter: action.filter
      });
      if (!result.success)
        return { success: false, error: result.error || "failed to get captured headers" };
      return { success: true, data: result.data };
    }
    case "sse_log": {
      const result = await sendNetDirect(tabId, {
        type: "get_sse_log",
        filter: action.filter,
        limit: action.limit
      });
      if (!result.success)
        return { success: false, error: result.error || "failed to get SSE log" };
      return { success: true, data: result.data || [] };
    }
    case "sse_streams": {
      const result = await sendNetDirect(tabId, {
        type: "get_sse_streams"
      });
      if (!result.success)
        return { success: false, error: result.error || "failed to get SSE streams" };
      return { success: true, data: result.data || [] };
    }
    case "sse_chunk": {
      const result = await sendNetDirect(tabId, {
        type: "get_sse_chunk",
        filter: action.filter,
        since: action.since
      });
      if (!result.success)
        return { success: false, error: result.error || "failed to get SSE chunk" };
      return { success: true, data: result.data };
    }
    case "set_net_overrides": {
      const result = await sendNetDirect(tabId, {
        type: "set_net_overrides",
        rules: action.rules
      });
      return result.success ? { success: true, data: { overrides: "set", ruleCount: Array.isArray(action.rules) ? action.rules.length : 0 } } : { success: false, error: result.error || "failed to set net overrides" };
    }
    case "clear_net_overrides": {
      const result = await sendNetDirect(tabId, {
        type: "clear_net_overrides"
      });
      return result.success ? { success: true, data: "net overrides cleared" } : { success: false, error: result.error || "failed to clear net overrides" };
    }
  }
  return { success: false, error: `unknown passive-net action: ${action.type}` };
}

// extension/src/background/capabilities/cdp-network-actions.ts
async function handleCdpNetworkActions(action, tabId) {
  switch (action.type) {
    case "network_intercept": {
      if (action.enabled === false) {
        await disableNetworkCapture(tabId);
        return { success: true, data: { enabled: false, captured: getNetworkLogs(tabId).length } };
      }
      const patterns = Array.isArray(action.patterns) ? action.patterns : [];
      await enableNetworkCapture(tabId, patterns);
      return { success: true, data: { enabled: true, patterns } };
    }
    case "network_log": {
      const since = action.since || 0;
      const limit = action.limit || 100;
      const logs = getNetworkLogs(tabId).filter((entry) => !since || entry.timestamp >= since).slice(-limit);
      return { success: true, data: logs };
    }
    case "network_override": {
      const rules = action.enabled === false ? [] : action.rules || [];
      networkOverrideConfigs.set(tabId, rules);
      await refreshFetchInterception(tabId);
      return { success: true, data: { enabled: rules.length > 0, ruleCount: rules.length, rules } };
    }
  }
  return { success: false, error: `unknown cdp-network action: ${action.type}` };
}

// extension/src/background/capabilities/monitor.ts
async function adoptChildTab(childTabId, openerTabId) {
  try {
    if (openerTabId !== undefined && chrome.tabGroups) {
      const opener = await chrome.tabs.get(openerTabId);
      if (opener.groupId !== -1 && await isTabInAnyManagedGroup(openerTabId)) {
        await chrome.tabs.group({ tabIds: childTabId, groupId: opener.groupId });
        return;
      }
    }
  } catch {}
  await addTabToInterceptorGroup(childTabId);
}
var FOCUS_SWITCH_GUARD_MS = 2000;
var sessions = new Map;
var activeSessionByTab = new Map;
var pendingChildTabs = new Map;
var CHILD_TAB_WINDOW_MS = 5000;
var TRUSTED_ACTION_KINDS = new Set(["click", "submit", "key"]);
var webNavRegistered = false;
var tabsRegistered = false;
var runtimeMsgRegistered = false;
function attachmentKey(tabId, documentId) {
  return `${tabId}:${documentId || "unknown"}`;
}
function nextSeq(session) {
  return session.seq++;
}
function getActiveSessionForTab(tabId) {
  const sid = activeSessionByTab.get(tabId);
  if (!sid)
    return;
  return sessions.get(sid);
}
function findFirstActiveSession() {
  for (const session of sessions.values()) {
    if (!session.paused)
      return session;
  }
  return;
}
function getCurrentAttachment(session) {
  if (!session.activeAttachmentKey)
    return;
  return session.attachments.get(session.activeAttachmentKey);
}
function createAttachment(tabId, documentId, frameId, url, lifecycle, reason, openerTabId) {
  return {
    key: attachmentKey(tabId, documentId),
    tabId,
    documentId,
    frameId,
    url,
    openerTabId,
    attachedAt: Date.now(),
    detachedAt: undefined,
    lifecycle,
    reason
  };
}
function emitMonEvent(session, kind, extra = {}, attachmentOverride) {
  const seq = nextSeq(session);
  session.counts.evt++;
  if (kind === "mut")
    session.counts.mut++;
  else if (kind === "fetch" || kind === "xhr" || kind === "sse" || kind.startsWith("ws_") || kind === "beacon" || kind === "beacon_error" || kind.startsWith("broadcast_"))
    session.counts.net++;
  else if (kind === "nav")
    session.counts.nav++;
  const attachment = attachmentOverride || getCurrentAttachment(session);
  const base = {};
  if (attachment) {
    base.tid = attachment.tabId;
    if (attachment.documentId)
      base.doc = attachment.documentId;
    if (attachment.lifecycle)
      base.lif = attachment.lifecycle;
    if (attachment.url && extra.u === undefined && extra.url === undefined)
      base.u = attachment.url;
  }
  sendToHost({
    type: "event",
    event: kind,
    sid: session.sessionId,
    ...session.taskId ? { taskId: session.taskId } : {},
    s: seq,
    t: Date.now(),
    ...base,
    ...extra
  });
  return seq;
}
function recordTrustedAction(session, kind, seq, tabId, documentId) {
  if (!TRUSTED_ACTION_KINDS.has(kind))
    return;
  session.lastTrustedAction = {
    seq,
    tabId,
    documentId,
    kind,
    at: Date.now()
  };
}
function detachAttachment(session, attachment, reason) {
  attachment.detachedAt = Date.now();
  emitMonEvent(session, "mon_detach", { reason }, attachment);
}
function activateAttachment(session, attachment) {
  session.attachments.set(attachment.key, attachment);
  session.activeAttachmentKey = attachment.key;
  session.url = attachment.url || session.url;
  activeSessionByTab.set(attachment.tabId, session.sessionId);
}
function switchToAttachment(session, nextAttachment, reason) {
  const current = getCurrentAttachment(session);
  if (current && current.key === nextAttachment.key) {
    current.url = nextAttachment.url || current.url;
    current.lifecycle = nextAttachment.lifecycle || current.lifecycle;
    current.openerTabId = nextAttachment.openerTabId ?? current.openerTabId;
    current.reason = nextAttachment.reason;
    session.url = current.url || session.url;
    return;
  }
  if (current) {
    const detachReason = reason === "child_tab" ? "child_tab_handoff" : reason === "focus_switch" ? "focus_switch_handoff" : "document_replaced";
    detachAttachment(session, current, detachReason);
    if (current.tabId !== nextAttachment.tabId) {
      activeSessionByTab.delete(current.tabId);
      sendDisarmToTab(current.tabId, current.documentId);
    }
  }
  activateAttachment(session, nextAttachment);
  emitMonEvent(session, "mon_attach", {
    reason,
    ...nextAttachment.openerTabId !== undefined ? { openerTid: nextAttachment.openerTabId } : {},
    ...nextAttachment.url ? { u: nextAttachment.url } : {}
  }, nextAttachment);
}
async function sendTabMessage(tabId, payload, documentId) {
  if (documentId) {
    return chrome.tabs.sendMessage(tabId, payload, { documentId });
  }
  return chrome.tabs.sendMessage(tabId, payload);
}
async function ensureContentScript(tabId, documentId) {
  try {
    await sendTabMessage(tabId, { type: "monitor_ping" }, documentId);
    return { connected: true };
  } catch {
    try {
      await chrome.scripting.executeScript({ target: { tabId }, files: ["content.js"] });
    } catch (injectErr) {
      return { connected: false, error: `content script could not be re-injected on tab ${tabId} — try 'interceptor reload': ${injectErr.message}` };
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
    try {
      await sendTabMessage(tabId, { type: "monitor_ping" }, documentId);
      return { connected: true };
    } catch (retryErr) {
      return { connected: false, error: `content script re-injected but still not responding on tab ${tabId} — try 'interceptor reload': ${retryErr.message}` };
    }
  }
}
async function sendArmToTab(tabId, sessionId, startedAt, documentId, armOpts) {
  const check = await ensureContentScript(tabId, documentId);
  if (!check.connected)
    return { success: false, error: check.error };
  try {
    await sendTabMessage(tabId, {
      type: "monitor_arm",
      sessionId,
      startedAt,
      ...armOpts?.persistBodies ? { persistBodies: true } : {},
      ...armOpts?.bodyCapBytes ? { bodyCapBytes: armOpts.bodyCapBytes } : {}
    }, documentId);
    return { success: true };
  } catch (err) {
    return { success: false, error: err.message };
  }
}
async function rearmTabForSession(tabId, session, documentId) {
  const sRec = session;
  return sendArmToTab(tabId, session.sessionId, session.startedAt, documentId, { persistBodies: sRec._persistBodies, bodyCapBytes: sRec._bodyCapBytes });
}
async function sendDisarmToTab(tabId, documentId) {
  try {
    return await sendTabMessage(tabId, { type: "monitor_disarm" }, documentId);
  } catch (err) {
    console.error(`sendDisarmToTab failed for tab ${tabId}:`, err.message);
    return null;
  }
}
async function getTopFrameContext(tabId) {
  try {
    const frame = await chrome.webNavigation.getFrame({ tabId, frameId: 0 });
    return {
      documentId: frame?.documentId,
      url: frame?.url,
      lifecycle: frame?.documentLifecycle
    };
  } catch {
    return {};
  }
}
function registerWebNavListenersOnce() {
  if (webNavRegistered)
    return;
  const webNavigation = chrome.webNavigation;
  if (!webNavigation)
    return;
  webNavRegistered = true;
  webNavigation.onCommitted?.addListener((details) => {
    if (details.frameId !== 0)
      return;
    const pendingChild = pendingChildTabs.get(details.tabId);
    if (pendingChild) {
      const session2 = sessions.get(pendingChild.sessionId);
      if (session2 && !session2.paused) {
        adoptChildTab(details.tabId, pendingChild.openerTabId).catch(() => {});
        switchToAttachment(session2, createAttachment(details.tabId, details.documentId, details.frameId, details.url, details.documentLifecycle, "child_tab", pendingChild.openerTabId), "child_tab");
        emitMonEvent(session2, "nav", {
          u: details.url,
          typ: details.transitionType === "reload" ? "reload" : "hard",
          tt: details.transitionType,
          tq: details.transitionQualifiers
        });
      }
      pendingChildTabs.delete(details.tabId);
      return;
    }
    const session = getActiveSessionForTab(details.tabId);
    if (!session || session.paused)
      return;
    const current = getCurrentAttachment(session);
    if (!current || current.documentId !== details.documentId) {
      switchToAttachment(session, createAttachment(details.tabId, details.documentId, details.frameId, details.url, details.documentLifecycle, details.transitionType === "reload" ? "reload" : "start"), details.transitionType === "reload" ? "reload" : "start");
    } else {
      current.url = details.url;
      current.lifecycle = details.documentLifecycle;
      session.url = details.url;
    }
    emitMonEvent(session, "nav", {
      u: details.url,
      typ: details.transitionType === "reload" ? "reload" : "hard",
      tt: details.transitionType,
      tq: details.transitionQualifiers
    });
  });
  webNavigation.onHistoryStateUpdated?.addListener((details) => {
    if (details.frameId !== 0)
      return;
    const session = getActiveSessionForTab(details.tabId);
    if (!session || session.paused)
      return;
    const current = getCurrentAttachment(session);
    if (current) {
      current.url = details.url;
      current.lifecycle = details.documentLifecycle;
      if (details.documentId)
        current.documentId = details.documentId;
      session.url = details.url;
    }
    emitMonEvent(session, "nav", {
      u: details.url,
      typ: "history",
      tt: details.transitionType,
      tq: details.transitionQualifiers
    });
    rearmTabForSession(details.tabId, session, current?.documentId).then((res) => {
      if (!res.success)
        console.error(`re-arm after history nav failed on tab ${details.tabId}:`, res.error);
    });
  });
  webNavigation.onReferenceFragmentUpdated?.addListener((details) => {
    if (details.frameId !== 0)
      return;
    const session = getActiveSessionForTab(details.tabId);
    if (!session || session.paused)
      return;
    const current = getCurrentAttachment(session);
    if (current) {
      current.url = details.url;
      current.lifecycle = details.documentLifecycle;
      if (details.documentId)
        current.documentId = details.documentId;
      session.url = details.url;
    }
    emitMonEvent(session, "nav", {
      u: details.url,
      typ: "reference",
      tt: details.transitionType,
      tq: details.transitionQualifiers
    });
    rearmTabForSession(details.tabId, session, current?.documentId).then((res) => {
      if (!res.success)
        console.error(`re-arm after fragment nav failed on tab ${details.tabId}:`, res.error);
    });
  });
  webNavigation.onCompleted?.addListener((details) => {
    if (details.frameId !== 0)
      return;
    const session = getActiveSessionForTab(details.tabId);
    if (!session || session.paused)
      return;
    const current = getCurrentAttachment(session);
    rearmTabForSession(details.tabId, session, current?.documentId).then((res) => {
      if (!res.success)
        console.error(`re-arm after navigation completed failed on tab ${details.tabId}:`, res.error);
    });
  });
  webNavigation.onTabReplaced?.addListener((details) => {
    const session = getActiveSessionForTab(details.replacedTabId);
    if (!session || session.paused)
      return;
    const current = getCurrentAttachment(session);
    if (!current)
      return;
    detachAttachment(session, current, "tab_replaced");
    activeSessionByTab.delete(details.replacedTabId);
    const replacement = createAttachment(details.tabId, current.documentId, 0, current.url, current.lifecycle, "tab_replaced", current.openerTabId);
    activateAttachment(session, replacement);
    emitMonEvent(session, "mon_attach", {
      reason: "tab_replaced",
      ...replacement.url ? { u: replacement.url } : {}
    }, replacement);
  });
}
async function handleFocusActivated(tabId) {
  const session = findFirstActiveSession();
  if (!session)
    return;
  const current = getCurrentAttachment(session);
  if (current && current.tabId === tabId)
    return;
  if (pendingChildTabs.has(tabId))
    return;
  let inGroup = false;
  try {
    inGroup = await isTabInAnyManagedGroup(tabId);
  } catch {
    return;
  }
  if (!inGroup)
    return;
  if (pendingChildTabs.has(tabId))
    return;
  if (current && current.tabId === tabId)
    return;
  if (current && current.attachedAt && current.tabId === tabId && Date.now() - current.attachedAt < FOCUS_SWITCH_GUARD_MS)
    return;
  let ctx = {};
  try {
    ctx = await getTopFrameContext(tabId);
  } catch {}
  let tabUrl = ctx.url;
  if (!tabUrl) {
    try {
      const tab = await chrome.tabs.get(tabId);
      tabUrl = tab.url;
    } catch {}
  }
  const next = createAttachment(tabId, ctx.documentId, 0, tabUrl, ctx.lifecycle, "focus_switch");
  switchToAttachment(session, next, "focus_switch");
  const armRes = await rearmTabForSession(tabId, session, ctx.documentId);
  if (!armRes.success) {
    console.error(`focus_switch arm failed for tab ${tabId}: ${armRes.error}`);
  }
}
function registerTabListenersOnce() {
  if (tabsRegistered)
    return;
  const tabs = chrome.tabs;
  if (!tabs)
    return;
  tabsRegistered = true;
  tabs.onActivated?.addListener((info) => {
    handleFocusActivated(info.tabId);
  });
  tabs.onCreated?.addListener((tab) => {
    if (!tab.id || tab.openerTabId === undefined)
      return;
    const session = getActiveSessionForTab(tab.openerTabId);
    if (!session || session.paused)
      return;
    const current = getCurrentAttachment(session);
    if (!current || current.tabId !== tab.openerTabId)
      return;
    const trusted = session.lastTrustedAction;
    if (!trusted)
      return;
    if (trusted.tabId !== current.tabId)
      return;
    if (Date.now() - trusted.at > CHILD_TAB_WINDOW_MS)
      return;
    pendingChildTabs.set(tab.id, {
      sessionId: session.sessionId,
      openerTabId: tab.openerTabId,
      createdAt: Date.now()
    });
  });
  tabs.onRemoved?.addListener((tabId) => {
    pendingChildTabs.delete(tabId);
    const session = getActiveSessionForTab(tabId);
    if (!session)
      return;
    const current = getCurrentAttachment(session);
    const dur = Date.now() - session.startedAt;
    try {
      if (current) {
        try {
          detachAttachment(session, current, "tab_closed");
        } catch (err) {
          console.error(`detachAttachment during tab_closed failed:`, err.message);
        }
      }
      try {
        sendToHost({
          type: "event",
          event: "mon_stop",
          sid: session.sessionId,
          ...session.taskId ? { taskId: session.taskId } : {},
          s: nextSeq(session),
          t: Date.now(),
          reason: "tab_closed",
          evt: session.counts.evt,
          mut: session.counts.mut,
          net: session.counts.net,
          nav: session.counts.nav,
          dur
        });
      } catch (err) {
        console.error(`sendToHost(mon_stop/tab_closed) failed:`, err.message);
      }
    } finally {
      sessions.delete(session.sessionId);
      activeSessionByTab.delete(tabId);
      clearPendingChildTabsForSession(session.sessionId);
    }
  });
}
function registerRuntimeMessageListenerOnce() {
  if (runtimeMsgRegistered)
    return;
  const runtime = chrome.runtime;
  if (!runtime?.onMessage)
    return;
  runtimeMsgRegistered = true;
  runtime.onMessage.addListener(monitorRuntimeMessageListener);
}
function registerMonitorListeners() {
  registerWebNavListenersOnce();
  registerTabListenersOnce();
  registerRuntimeMessageListenerOnce();
}
function monitorRuntimeMessageListener(msg, sender, sendResponse) {
  if (!msg || typeof msg !== "object")
    return;
  if (msg.type !== "mon_evt")
    return;
  try {
    const tabId = sender.tab?.id;
    const frameId = sender.frameId ?? 0;
    const senderMeta = sender;
    const documentId = senderMeta.documentId;
    const lifecycle = senderMeta.documentLifecycle;
    if (tabId === undefined) {
      sendResponse({ success: false, error: "no tab id on sender" });
      return true;
    }
    const session = getActiveSessionForTab(tabId);
    if (!session) {
      sendResponse({ success: false, error: "no active session for tab" });
      return true;
    }
    if (session.paused) {
      sendResponse({ success: true, dropped: "paused" });
      return true;
    }
    const current = getCurrentAttachment(session);
    if (documentId && current?.documentId && current.documentId !== documentId) {
      sendResponse({ success: false, error: "sender document is not the active attachment" });
      return true;
    }
    if (current && documentId)
      current.documentId = documentId;
    if (current && lifecycle)
      current.lifecycle = lifecycle;
    const obj = msg.obj || {};
    const kind = obj.k || "unknown";
    const stripped = {};
    for (const [k, v] of Object.entries(obj)) {
      if (k === "k")
        continue;
      stripped[k] = v;
    }
    if (frameId !== 0)
      stripped.fid = frameId;
    if (tabId !== undefined)
      stripped.tid = tabId;
    if (documentId)
      stripped.doc = documentId;
    if (lifecycle)
      stripped.lif = lifecycle;
    const emittedSeq = emitMonEvent(session, kind, stripped, current);
    if (obj.tr !== false) {
      recordTrustedAction(session, kind, emittedSeq, tabId, documentId);
    }
    sendResponse({ success: true });
  } catch (err) {
    try {
      sendResponse({ success: false, error: err.message });
    } catch {}
  }
  return true;
}
async function resolveTabForMonitor(group) {
  if (group) {
    const namedGroupId = await ensureNamedGroup(group);
    if (namedGroupId !== -1) {
      const tabs = await chrome.tabs.query({ groupId: namedGroupId });
      if (tabs.length > 0) {
        const active = tabs.find((tab) => tab.active) || tabs[0];
        if (active.id)
          return { tabId: active.id };
      }
    }
    return { error: `group '${group}' has no tabs — open one with 'interceptor open <url> --group ${group}'` };
  }
  const groupId = await ensureInterceptorGroup();
  if (groupId !== -1) {
    const tabs = await chrome.tabs.query({ groupId });
    if (tabs.length > 0) {
      const active = tabs.find((tab) => tab.active) || tabs[0];
      if (active.id)
        return { tabId: active.id };
    }
  }
  const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (activeTab?.id) {
    const inGroup = await isTabInAnyManagedGroup(activeTab.id);
    if (inGroup)
      return { tabId: activeTab.id };
  }
  return { error: "no interceptor-managed tab found — use 'interceptor tab new' or pass --tab" };
}
function resolveSessionWithoutTab() {
  for (const [tid, sid] of activeSessionByTab) {
    return { tabId: tid, sessionId: sid };
  }
  return;
}
function clearPendingChildTabsForSession(sessionId) {
  for (const [tabId, pending] of pendingChildTabs) {
    if (pending.sessionId === sessionId)
      pendingChildTabs.delete(tabId);
  }
}
async function handleMonitorActions(action, tabId) {
  switch (action.type) {
    case "monitor_start": {
      let resolvedTabId = tabId;
      if (!resolvedTabId) {
        const resolved = await resolveTabForMonitor(typeof action.group === "string" && action.group.length > 0 ? action.group : undefined);
        if (resolved.error || !resolved.tabId) {
          return { success: false, error: resolved.error || "no interceptor-managed tab found" };
        }
        resolvedTabId = resolved.tabId;
      }
      if (activeSessionByTab.has(resolvedTabId)) {
        const existingSid = activeSessionByTab.get(resolvedTabId);
        return {
          success: false,
          error: `monitor already active on tab ${resolvedTabId} (session ${existingSid.slice(0, 8)})`,
          data: { sessionId: existingSid }
        };
      }
      const sessionId = crypto.randomUUID();
      const startedAt = Date.now();
      const instruction = action.instruction || undefined;
      const taskId = typeof action.taskId === "string" ? action.taskId : undefined;
      let url;
      try {
        const tab = await chrome.tabs.get(resolvedTabId);
        url = tab.url;
      } catch {}
      const frame = await getTopFrameContext(resolvedTabId);
      const initialAttachment = createAttachment(resolvedTabId, frame.documentId, 0, frame.url || url, frame.lifecycle, "start");
      const session = {
        sessionId,
        taskId,
        rootTabId: resolvedTabId,
        startedAt,
        instruction,
        paused: false,
        seq: 0,
        counts: { evt: 0, mut: 0, net: 0, nav: 0 },
        url: initialAttachment.url || url,
        attachments: new Map([[initialAttachment.key, initialAttachment]]),
        activeAttachmentKey: initialAttachment.key
      };
      const persistBodies = action.persistBodies === true;
      const bodyCapBytes = typeof action.bodyCapBytes === "number" ? action.bodyCapBytes : undefined;
      const armResult = await sendArmToTab(resolvedTabId, sessionId, startedAt, initialAttachment.documentId, { persistBodies, bodyCapBytes });
      if (!armResult.success) {
        return { success: false, error: armResult.error, tabId: resolvedTabId };
      }
      session._persistBodies = persistBodies;
      session._bodyCapBytes = bodyCapBytes;
      sessions.set(sessionId, session);
      activeSessionByTab.set(resolvedTabId, sessionId);
      sendToHost({
        type: "event",
        event: "mon_start",
        sid: sessionId,
        ...taskId ? { taskId } : {},
        s: nextSeq(session),
        t: startedAt,
        tid: resolvedTabId,
        url: session.url,
        ins: instruction
      });
      emitMonEvent(session, "mon_attach", {
        reason: "start",
        ...session.url ? { u: session.url } : {}
      }, initialAttachment);
      const capture = typeof action.capture === "string" ? action.capture : undefined;
      const shouldReload = action.reload === true;
      if (capture === "page-comm" && shouldReload) {
        try {
          await chrome.tabs.reload(resolvedTabId);
        } catch (err) {
          return { success: false, error: `monitor started but reload failed: ${err.message}`, tabId: resolvedTabId };
        }
      }
      return {
        success: true,
        data: {
          sessionId,
          tabId: resolvedTabId,
          startedAt,
          url: session.url,
          instruction,
          ...taskId ? { taskId } : {},
          ...capture ? { capture } : {},
          ...shouldReload ? { reload: true, mode: "from-start" } : {},
          ...capture === "page-comm" && !shouldReload ? { note: "page-comm attach-now captures future WebSocket, Beacon, and BroadcastChannel activity; existing WebSocket instances are not retroactively captured" } : {}
        }
      };
    }
    case "monitor_stop": {
      let resolvedTabId = tabId;
      let sid = activeSessionByTab.get(resolvedTabId);
      if (!sid) {
        const found = resolveSessionWithoutTab();
        if (found) {
          resolvedTabId = found.tabId;
          sid = found.sessionId;
        }
      }
      if (!sid) {
        return { success: false, error: `no active monitor session on tab ${resolvedTabId || "(none)"}` };
      }
      const session = sessions.get(sid);
      const current = getCurrentAttachment(session);
      const disarmRes = await sendDisarmToTab(resolvedTabId, current?.documentId);
      const dur = Date.now() - session.startedAt;
      const countsSnapshot = { ...session.counts };
      try {
        if (current) {
          try {
            detachAttachment(session, current, "user_stop");
          } catch (err) {
            console.error(`detachAttachment during monitor_stop failed:`, err.message);
          }
        }
        try {
          sendToHost({
            type: "event",
            event: "mon_stop",
            sid: session.sessionId,
            ...session.taskId ? { taskId: session.taskId } : {},
            s: nextSeq(session),
            t: Date.now(),
            reason: "user",
            evt: session.counts.evt,
            mut: session.counts.mut,
            net: session.counts.net,
            nav: session.counts.nav,
            dur
          });
        } catch (err) {
          console.error(`sendToHost(mon_stop) failed:`, err.message);
        }
      } finally {
        sessions.delete(sid);
        activeSessionByTab.delete(resolvedTabId);
        clearPendingChildTabsForSession(sid);
      }
      return {
        success: true,
        data: {
          sessionId: sid,
          tabId: resolvedTabId,
          dur,
          evt: countsSnapshot.evt,
          mut: countsSnapshot.mut,
          net: countsSnapshot.net,
          nav: countsSnapshot.nav,
          contentDisarm: disarmRes
        }
      };
    }
    case "monitor_status": {
      if (action.tabId && typeof action.tabId === "number") {
        const sid = activeSessionByTab.get(action.tabId);
        if (!sid)
          return { success: true, data: { active: false, tabId: action.tabId } };
        const session = sessions.get(sid);
        const current = getCurrentAttachment(session);
        return {
          success: true,
          data: {
            active: !session.paused,
            paused: session.paused,
            sessionId: session.sessionId,
            tabId: current?.tabId ?? action.tabId,
            documentId: current?.documentId,
            startedAt: session.startedAt,
            url: session.url,
            instruction: session.instruction,
            counts: session.counts,
            ageMs: Date.now() - session.startedAt
          }
        };
      }
      const list = Array.from(sessions.values()).map((session) => {
        const current = getCurrentAttachment(session);
        return {
          sessionId: session.sessionId,
          tabId: current?.tabId ?? session.rootTabId,
          documentId: current?.documentId,
          startedAt: session.startedAt,
          url: session.url,
          instruction: session.instruction,
          paused: session.paused,
          counts: session.counts,
          ageMs: Date.now() - session.startedAt
        };
      });
      return { success: true, data: { active: list.length > 0, sessions: list } };
    }
    case "monitor_pause": {
      let resolvedTabId = tabId;
      let sid = activeSessionByTab.get(resolvedTabId);
      if (!sid) {
        const found = resolveSessionWithoutTab();
        if (found) {
          resolvedTabId = found.tabId;
          sid = found.sessionId;
        }
      }
      if (!sid)
        return { success: false, error: `no active monitor session on tab ${resolvedTabId || "(none)"}` };
      const session = sessions.get(sid);
      session.paused = true;
      sendToHost({
        type: "event",
        event: "mon_pause",
        sid,
        ...session.taskId ? { taskId: session.taskId } : {},
        s: nextSeq(session),
        t: Date.now(),
        ...getCurrentAttachment(session) ? { tid: getCurrentAttachment(session).tabId } : {}
      });
      return { success: true, data: { sessionId: sid, paused: true } };
    }
    case "monitor_resume": {
      let resolvedTabId = tabId;
      let sid = activeSessionByTab.get(resolvedTabId);
      if (!sid) {
        const found = resolveSessionWithoutTab();
        if (found) {
          resolvedTabId = found.tabId;
          sid = found.sessionId;
        }
      }
      if (!sid)
        return { success: false, error: `no active monitor session on tab ${resolvedTabId || "(none)"}` };
      const session = sessions.get(sid);
      const current = getCurrentAttachment(session);
      session.paused = false;
      sendToHost({
        type: "event",
        event: "mon_resume",
        sid,
        ...session.taskId ? { taskId: session.taskId } : {},
        s: nextSeq(session),
        t: Date.now(),
        ...current ? { tid: current.tabId, doc: current.documentId } : {}
      });
      const armResult = await rearmTabForSession(resolvedTabId, session, current?.documentId);
      if (!armResult.success) {
        console.error(`re-arm after resume failed on tab ${resolvedTabId}:`, armResult.error);
      }
      return { success: true, data: { sessionId: sid, paused: false } };
    }
  }
  return { success: false, error: `unknown monitor action: ${action.type}` };
}

// extension/src/background/keepawake.ts
var KEEPAWAKE_STORAGE_KEY = "interceptor_keepawake";
var IDLE_DETECTION_SECONDS = 60;
async function setKeepAwake(on, level = "system") {
  if (on) {
    chrome.power.requestKeepAwake(level);
    await chrome.storage.local.set({ [KEEPAWAKE_STORAGE_KEY]: { on: true, level } });
    return { on: true, level };
  }
  chrome.power.releaseKeepAwake();
  await chrome.storage.local.set({ [KEEPAWAKE_STORAGE_KEY]: { on: false } });
  return { on: false };
}
function queryIdleState(detectionInterval = IDLE_DETECTION_SECONDS) {
  return new Promise((resolve) => {
    chrome.idle.queryState(detectionInterval, (state) => resolve(state));
  });
}
async function handlePowerIdleActions(action) {
  if (action.type === "keepawake") {
    const level = action.level === "display" ? "display" : "system";
    const result = await setKeepAwake(action.on === true, level);
    return { success: true, data: result };
  }
  if (action.type === "idle_state") {
    const interval = typeof action.detectionInterval === "number" && action.detectionInterval > 0 ? action.detectionInterval : undefined;
    const state = await queryIdleState(interval);
    return { success: true, data: { state } };
  }
  return { success: false, error: `unknown power/idle action: ${action.type}` };
}

// extension/src/background/router.ts
function initializeActionRouter() {
  registerMonitorListeners();
  restorePageCommCaptureConfig();
}
var OS_INPUT_ACTIONS = new Set(["os_click", "os_key", "os_type", "os_move"]);
var SCREENSHOT_ACTIONS = new Set(["screenshot", "screenshot_background", "page_capture", "ocr"]);
var CAPTURE_STREAM_ACTIONS = new Set(["capture_start", "capture_frame", "capture_stop", "canvas_diff"]);
var CANVAS_ACTIONS = new Set([
  "canvas_list",
  "canvas_read",
  "canvas_status",
  "canvas_log",
  "canvas_objects",
  "canvas_model",
  "canvas_routes",
  "canvas_ocr"
]);
var TAB_ACTIONS = new Set([
  "tab_create",
  "tab_close",
  "tab_switch",
  "tab_list",
  "tab_duplicate",
  "tab_reload",
  "tab_mute",
  "tab_pin",
  "tab_zoom_get",
  "tab_zoom_set",
  "tab_group",
  "tab_ungroup",
  "tab_move",
  "tab_discard",
  "group_list",
  "group_close"
]);
var WINDOW_ACTIONS = new Set([
  "window_create",
  "window_close",
  "window_focus",
  "window_resize",
  "window_list",
  "window_get_all"
]);
var NAVIGATION_ACTIONS = new Set(["navigate", "go_back", "go_forward", "reload"]);
var COOKIE_ACTIONS = new Set(["cookies_get", "cookies_set", "cookies_delete"]);
var HISTORY_ACTIONS = new Set([
  "history_search",
  "history_visits",
  "history_delete",
  "history_delete_range",
  "history_delete_all"
]);
var BOOKMARK_ACTIONS = new Set([
  "bookmark_tree",
  "bookmark_search",
  "bookmark_create",
  "bookmark_delete",
  "bookmark_update"
]);
var DOWNLOAD_ACTIONS = new Set([
  "downloads_start",
  "downloads_search",
  "downloads_cancel",
  "downloads_pause",
  "downloads_resume"
]);
var SESSION_ACTIONS = new Set(["session_list", "session_restore"]);
var NOTIFICATION_ACTIONS = new Set(["notification_create", "notification_clear"]);
var SEARCH_ACTIONS = new Set(["search_capability", "search_query"]);
var BROWSING_DATA_ACTIONS = new Set(["browsing_data_remove"]);
var HEADER_ACTIONS = new Set(["headers_modify"]);
var EVALUATE_ACTIONS = new Set(["evaluate"]);
var BINARY_SINK_ACTIONS = new Set(["binary_sink_save"]);
var STYLE_ACTIONS = new Set(["style_inject", "style_remove"]);
var FRAME_ACTIONS = new Set(["frames_list", "frames_read_tree", "frames_find"]);
var META_ACTIONS = new Set(["status", "reload_extension", "capabilities", "cdp_tree", "brand_set_tab_group"]);
var PASSIVE_NET_ACTIONS = new Set([
  "net_log",
  "net_clear",
  "net_headers",
  "sse_log",
  "sse_streams",
  "sse_chunk",
  "set_net_overrides",
  "clear_net_overrides",
  "page_comm_log",
  "page_comm_clear",
  "page_comm_enable",
  "page_comm_disable",
  "page_comm_status"
]);
var CDP_NETWORK_ACTIONS = new Set(["network_intercept", "network_log", "network_override"]);
var MONITOR_ACTIONS = new Set(["monitor_start", "monitor_stop", "monitor_status", "monitor_pause", "monitor_resume"]);
var POWER_IDLE_ACTIONS = new Set(["keepawake", "idle_state"]);
var SCENE_ACTIONS = new Set([
  "scene_list",
  "scene_click",
  "scene_dblclick",
  "scene_select",
  "scene_hit",
  "scene_selected",
  "scene_text",
  "scene_insert",
  "scene_cursor_to",
  "scene_cursor",
  "scene_slide_list",
  "scene_slide_goto",
  "scene_slide_current",
  "scene_notes",
  "scene_render",
  "scene_zoom",
  "scene_profile"
]);
async function routeAction(action, tabId) {
  if (OS_INPUT_ACTIONS.has(action.type))
    return handleOsInputActions(action, tabId);
  if (SCREENSHOT_ACTIONS.has(action.type))
    return handleScreenshotActions(action, tabId);
  if (CAPTURE_STREAM_ACTIONS.has(action.type))
    return handleCaptureStreamActions(action, tabId);
  if (CANVAS_ACTIONS.has(action.type))
    return handleCanvasActions(action, tabId);
  if (TAB_ACTIONS.has(action.type))
    return handleTabActions(action, tabId);
  if (WINDOW_ACTIONS.has(action.type))
    return handleWindowActions(action, tabId);
  if (NAVIGATION_ACTIONS.has(action.type))
    return handleNavigationActions(action, tabId);
  if (COOKIE_ACTIONS.has(action.type))
    return handleCookieActions(action, tabId);
  if (HISTORY_ACTIONS.has(action.type))
    return handleHistoryActions(action, tabId);
  if (BOOKMARK_ACTIONS.has(action.type))
    return handleBookmarkActions(action, tabId);
  if (DOWNLOAD_ACTIONS.has(action.type))
    return handleDownloadActions(action, tabId);
  if (SESSION_ACTIONS.has(action.type))
    return handleSessionActions(action, tabId);
  if (NOTIFICATION_ACTIONS.has(action.type))
    return handleNotificationActions(action, tabId);
  if (SEARCH_ACTIONS.has(action.type))
    return handleSearchActions(action, tabId);
  if (BROWSING_DATA_ACTIONS.has(action.type))
    return handleBrowsingDataActions(action, tabId);
  if (HEADER_ACTIONS.has(action.type))
    return handleHeaderActions(action, tabId);
  if (EVALUATE_ACTIONS.has(action.type))
    return handleEvaluateActions(action, tabId);
  if (BINARY_SINK_ACTIONS.has(action.type))
    return handleBinarySinkActions(action, tabId);
  if (STYLE_ACTIONS.has(action.type))
    return handleStyleActions(action, tabId);
  if (FRAME_ACTIONS.has(action.type))
    return handleFrameActions(action, tabId);
  if (META_ACTIONS.has(action.type))
    return handleMetaActions(action, tabId);
  if (PASSIVE_NET_ACTIONS.has(action.type))
    return handlePassiveNetActions(action, tabId);
  if (CDP_NETWORK_ACTIONS.has(action.type))
    return handleCdpNetworkActions(action, tabId);
  if (MONITOR_ACTIONS.has(action.type))
    return handleMonitorActions(action, tabId);
  if (POWER_IDLE_ACTIONS.has(action.type))
    return handlePowerIdleActions(action);
  const contentResult = await sendToContentScript(tabId, action, action.frameId);
  const shouldSceneEscalate = action.type === "scene_click" && contentResult.success && (action.os === true || contentResult.warning?.includes("no DOM change")) && activeTransport !== "none";
  const shouldClickEscalate = (action.type === "click" || action.type === "click_selector") && contentResult.success && contentResult.warning?.includes("no DOM change") && activeTransport !== "none";
  if (shouldClickEscalate || shouldSceneEscalate) {
    const resolvedAt = typeof contentResult.data === "object" && contentResult.data ? contentResult.data.at : undefined;
    console.log(`auto-escalating ${action.type} to OS-level input`);
    const osResult = await handleOsInputActions({
      ...action,
      type: "os_click",
      ref: contentResult.refId ?? action.ref,
      x: resolvedAt?.x ?? action.x,
      y: resolvedAt?.y ?? action.y
    }, tabId);
    if (osResult.success) {
      return {
        success: true,
        data: {
          ...typeof osResult.data === "object" && osResult.data || {},
          escalated: {
            from: action.os === true ? "explicit" : "synthetic",
            to: "os_click",
            reason: action.os === true ? "scene click requested trusted input" : "no DOM mutation after synthetic click"
          }
        },
        tabId
      };
    }
    const guardRefused = action.os !== true && !!(typeof osResult.data === "object" && osResult.data && osResult.data.hint);
    if (guardRefused) {
      return {
        ...contentResult,
        warning: `${contentResult.warning}; OS-level escalation skipped: ${osResult.error}`,
        tabId
      };
    }
    return {
      success: false,
      error: "click failed at all layers",
      data: {
        diagnostics: {
          layers_tried: ["synthetic", "os_click"],
          reason: action.os === true ? "trusted scene click failed" : "synthetic produced no DOM change, os_click failed",
          os_error: osResult.error,
          suggestion: typeof osResult.data === "object" && osResult.data && osResult.data.hint || "verify element is interactive and Chrome window is visible"
        }
      }
    };
  }
  if (!contentResult.success && contentResult.error) {
    contentResult.data = {
      ...typeof contentResult.data === "object" && contentResult.data ? contentResult.data : {},
      diagnostics: {
        layer_tried: "content_script",
        reason: contentResult.error,
        suggestion: action.type === "click" ? "try: interceptor click --trusted " + (action.ref || action.index || "") : action.type === "scene_click" ? "try: interceptor scene click --trusted " + (action.id || "") : undefined
      }
    };
  }
  return contentResult;
}

// extension/src/background/no-tab-actions.ts
var NO_TAB_ACTIONS = new Set([
  "status",
  "reload_extension",
  "tab_create",
  "tab_list",
  "window_create",
  "window_close",
  "window_focus",
  "window_resize",
  "window_list",
  "window_get_all",
  "history_search",
  "history_delete_all",
  "bookmark_tree",
  "bookmark_search",
  "bookmark_create",
  "downloads_search",
  "browsing_data_remove",
  "session_list",
  "session_restore",
  "notification_create",
  "notification_clear",
  "search_capability",
  "monitor_status",
  "monitor_start",
  "monitor_pause",
  "monitor_resume",
  "monitor_stop",
  "brand_set_tab_group",
  "group_list",
  "group_close",
  "keepawake",
  "idle_state"
]);
function needsTab(type) {
  return !NO_TAB_ACTIONS.has(type);
}

// extension/src/background/resolve-tab.ts
function resolveWorkingTabId(msgTabId, actionTabId) {
  if (typeof actionTabId === "number" && !Number.isNaN(actionTabId))
    return actionTabId;
  return msgTabId;
}

// extension/src/background/message-dispatch.ts
var MESSAGE_QUEUE_CAP = 50;
var messageQueue = [];
var EXT_REQUEST_TIMEOUT_MS = 180000;
var EXT_LONG_REQUEST_TIMEOUT_MS = 600000;
var pendingRequests = new Map;
function resolveGroupDispatchScope(action) {
  const label = typeof action.group === "string" && action.group.length > 0 ? action.group : undefined;
  const soft = label !== undefined && action.groupSoft === true;
  return { label, soft, hard: label !== undefined && !soft && action.anyTab !== true };
}
async function managedTabGateError(tabId, groupLabel, groupHard) {
  try {
    if (groupHard) {
      const inNamed = await isTabInNamedGroup(tabId, groupLabel);
      return inNamed ? null : `tab ${tabId} is not in group '${groupLabel}' — pass the owning group, or --any-tab to bypass`;
    }
    const inAny = await isTabInAnyManagedGroup(tabId);
    return !inAny && anyManagedGroupKnown() ? `tab ${tabId} is not in the interceptor group — use 'interceptor tab new' to create managed tabs` : null;
  } catch {
    const groupArg = groupHard && groupLabel ? ` --group ${groupLabel}` : "";
    return `tab ${tabId} is unavailable; run 'interceptor tabs${groupArg}' to refresh tab IDs and retry`;
  }
}
function activeTabKey2(group) {
  return group ? `activeTabId:${group}` : "activeTabId";
}
async function getActiveTabId(group) {
  const storage = chrome.storage;
  const area = storage.session ?? chrome.storage.local;
  const key = activeTabKey2(group);
  const stored = await area.get(key);
  return stored[key];
}
async function setActiveTabId(tabId, group) {
  const storage = chrome.storage;
  const area = storage.session ?? chrome.storage.local;
  await area.set({ [activeTabKey2(group)]: tabId });
}
function drainMessageQueue() {
  while (messageQueue.length > 0) {
    const queued = messageQueue.shift();
    handleDaemonMessage(queued);
  }
}
function noActiveTabError(windowCount) {
  return windowCount === 0 ? "no browser window is open in this profile — 'interceptor open <url>' creates one in the background" : "no active tab";
}
async function handleDaemonMessage(msg) {
  if (!msg.action || !msg.id)
    return;
  if (activeTransport === "none") {
    if (messageQueue.length >= MESSAGE_QUEUE_CAP) {
      const evicted = messageQueue.shift();
      if (evicted.id) {
        sendToHost({ id: evicted.id, result: { success: false, error: "message queue full — daemon not connected" } });
      }
    }
    if (messageQueue.length >= MESSAGE_QUEUE_CAP / 2) {
      console.warn(`message queue at ${messageQueue.length}/${MESSAGE_QUEUE_CAP}`);
    }
    messageQueue.push(msg);
    connectToHost();
    connectWsChannel();
    return;
  }
  const respondViaWsEarly = !!msg._viaWs;
  if (pendingRequests.has(msg.id)) {
    sendToHost({ id: msg.id, result: { success: false, error: "duplicate request ID" } }, respondViaWsEarly);
    return;
  }
  const requestTimeoutMs = msg.action.type === "binary_sink_save" ? EXT_LONG_REQUEST_TIMEOUT_MS : EXT_REQUEST_TIMEOUT_MS;
  const requestTimer = setTimeout(() => {
    const req = pendingRequests.get(msg.id);
    pendingRequests.delete(msg.id);
    sendToHost({ id: msg.id, result: { success: false, error: "extension timeout" } }, req?.viaWs);
  }, requestTimeoutMs);
  const startTime = Date.now();
  const shortId = msg.id.slice(0, 8);
  const respondViaWs = !!msg._viaWs;
  console.log(`[${shortId}] executing ${msg.action.type} (via ${respondViaWs ? "ws" : "native"})`);
  pendingRequests.set(msg.id, {
    action: msg.action.type,
    tabId: msg.tabId,
    timestamp: startTime,
    timer: requestTimer,
    viaWs: respondViaWs
  });
  const action = msg.action;
  let tabId = resolveWorkingTabId(msg.tabId, action.tabId);
  const fail = (error) => {
    clearTimeout(requestTimer);
    pendingRequests.delete(msg.id);
    sendToHost({ id: msg.id, result: { success: false, error } }, respondViaWs);
  };
  const { label: groupLabel, soft: groupSoft, hard: groupHard } = resolveGroupDispatchScope(action);
  if (groupLabel && !GROUP_LABEL_RE.test(groupLabel)) {
    fail(`invalid group label '${groupLabel}' — must match [A-Za-z0-9_-]{1,32}`);
    return;
  }
  if (!tabId && needsTab(action.type)) {
    tabId = await getActiveTabId(groupLabel);
    if (tabId && groupHard) {
      let stillInGroup = false;
      try {
        stillInGroup = await isTabInNamedGroup(tabId, groupLabel);
      } catch {}
      if (!stillInGroup)
        tabId = undefined;
    } else if (tabId && groupSoft) {
      try {
        await chrome.tabs.get(tabId);
      } catch {
        tabId = undefined;
      }
    }
  }
  if (!tabId && needsTab(action.type) && groupLabel) {
    const groupId = await ensureNamedGroup(groupLabel);
    if (groupId !== -1) {
      const groupTabs = await chrome.tabs.query({ groupId });
      const candidate = groupTabs.filter((t) => typeof t.id === "number").sort((a, b) => b.id - a.id)[0];
      tabId = candidate?.id;
    }
    if (!tabId && groupHard) {
      fail(`group '${groupLabel}' has no tabs — open one with 'interceptor open <url> --group ${groupLabel}', pass --any-tab to target the active tab, or set INTERCEPTOR_GROUP= (empty) to opt out of group scoping`);
      return;
    }
  }
  if (!tabId && needsTab(action.type)) {
    const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true }).catch(() => []);
    tabId = activeTab?.id;
  }
  if (!tabId && needsTab(action.type)) {
    const windows = await chrome.windows.getAll().catch(() => null);
    fail(noActiveTabError(windows ? windows.length : null));
    return;
  }
  if (tabId && needsTab(action.type) && !action.anyTab) {
    const membershipError = await managedTabGateError(tabId, groupLabel, groupHard);
    if (membershipError) {
      fail(membershipError);
      return;
    }
  }
  if (tabId)
    setActiveTabId(tabId, groupLabel);
  if (SENSITIVE_ACTIONS.has(action.type) && tabId && action.expectedUrl) {
    const urlErr = await verifyTabUrl(tabId, action.expectedUrl);
    if (urlErr) {
      clearTimeout(requestTimer);
      pendingRequests.delete(msg.id);
      sendToHost({ id: msg.id, result: { success: false, error: urlErr, tabId } }, respondViaWs);
      return;
    }
  }
  if (needsTab(action.type) || action.type === "tab_create")
    recordGroupActivity(groupLabel ?? "");
  try {
    const result = await routeAction(action, tabId);
    if (tabId)
      result.tabId = tabId;
    clearTimeout(requestTimer);
    pendingRequests.delete(msg.id);
    console.log(`[${shortId}] complete ${action.type} ${Date.now() - startTime}ms`);
    sendToHost({ id: msg.id, result }, respondViaWs);
  } catch (err) {
    clearTimeout(requestTimer);
    pendingRequests.delete(msg.id);
    console.error(`[${shortId}] error ${action.type} ${Date.now() - startTime}ms: ${err.message}`);
    sendToHost({ id: msg.id, result: { success: false, error: err.message, tabId } }, respondViaWs);
  }
}

// extension/src/background/safe-port-post.ts
function safePortPost(port, msg) {
  if (!port)
    return { posted: false, error: "no port" };
  try {
    port.postMessage(msg);
    return { posted: true };
  } catch (err) {
    try {
      port.disconnect?.();
    } catch {}
    return { posted: false, error: err.message };
  }
}

// extension/src/background/native-port-lifecycle.ts
function safeNativePortPost(port, msg) {
  return safePortPost(port, msg);
}
function safeNativePortPing(port) {
  return safeNativePortPost(port, { type: "ping" });
}
function safeNativePortDisconnect(port) {
  if (!port?.disconnect)
    return { disconnected: false, error: "no disconnect" };
  try {
    port.disconnect();
    return { disconnected: true };
  } catch (err) {
    return { disconnected: false, error: err.message };
  }
}

// extension/src/background/pending-request-recovery.ts
function recoverPendingRequestsAfterNativeDisconnect(pending, deliver, clearTimer = clearTimeout, logError = console.error) {
  let recovered = 0;
  let failed = 0;
  for (const [id, req] of pending) {
    clearTimer(req.timer);
    logError(`orphaned request ${id} (${req.action}) — native port disconnected`);
    const delivery = deliver({ id, result: { success: false, error: "native port disconnected" } });
    if (delivery === "failed") {
      failed += 1;
      logError(`final delivery failure for orphaned request ${id} (${req.action})`);
    } else {
      recovered += 1;
    }
  }
  return { recovered, failed };
}

// extension/src/background/reconnect-lifecycle.ts
var INITIAL_RECONNECT_DELAY_MS = 1000;
var MAX_RECONNECT_DELAY_MS = 30000;
var RECONNECT_JITTER_RATIO = 0.3;
function delayWithJitter(delayMs, random = Math.random, jitterRatio = RECONNECT_JITTER_RATIO) {
  return delayMs + random() * delayMs * jitterRatio;
}
function nextReconnectDelay(delayMs, maxMs = MAX_RECONNECT_DELAY_MS) {
  return Math.min(delayMs * 2, maxMs);
}

// extension/src/background/context-registration.ts
function registrationControlType(msg) {
  const candidate = msg;
  if (!candidate || typeof candidate.type !== "string")
    return null;
  if (candidate.type === "context_registered" || candidate.type === "context_conflict")
    return candidate.type;
  return null;
}
function getBadgeApi(chromeApi) {
  const api = chromeApi.action ?? chromeApi.browserAction;
  if (!api || typeof api.setBadgeText !== "function")
    return null;
  return api;
}
function ignoreAsyncResult(result) {
  if (result && typeof result.catch === "function") {
    result.catch((err) => console.error("action badge update failed:", err));
  }
}
function updateContextBadge(chromeApi, details) {
  const api = getBadgeApi(chromeApi);
  if (!api)
    return false;
  ignoreAsyncResult(api.setBadgeText({ text: details.text ?? "" }));
  if (details.color && api.setBadgeBackgroundColor) {
    ignoreAsyncResult(api.setBadgeBackgroundColor({ color: details.color }));
  }
  return true;
}
function setContextConflictBadge(chromeApi) {
  return updateContextBadge(chromeApi, { text: "!", color: "#e53e3e" });
}
function clearContextConflictBadge(chromeApi) {
  return updateContextBadge(chromeApi, { text: "" });
}

// extension/src/background/safari-native-relay.ts
var SAFARI_NATIVE_RELAY_APPLICATION_ID = "com.interceptor.safari";
var SAFARI_NATIVE_RELAY_MESSAGE_TYPE = "interceptor_safari_relay";
var SAFARI_NATIVE_RELAY_QUEUE_CAP = 50;
function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function defaultSleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

class SafariNativeRelayClient {
  runtime;
  contextId;
  waitMilliseconds;
  onMessage;
  onConnectionChange;
  onError;
  sleep;
  outbound = [];
  running = false;
  constructor(options) {
    this.runtime = options.runtime;
    this.contextId = options.contextId;
    this.waitMilliseconds = Math.max(100, Math.min(options.waitMilliseconds ?? 1000, 5000));
    this.onMessage = options.onMessage;
    this.onConnectionChange = options.onConnectionChange ?? (() => {});
    this.onError = options.onError ?? (() => {});
    this.sleep = options.sleep ?? defaultSleep;
  }
  enqueue(message) {
    if (this.outbound.length >= SAFARI_NATIVE_RELAY_QUEUE_CAP) {
      this.outbound.shift();
      this.onError(new Error("Safari native relay outbound queue full; dropped oldest message"));
    }
    this.outbound.push(message);
  }
  start() {
    if (this.running)
      return;
    this.running = true;
    this.runLoop();
  }
  stop() {
    this.running = false;
  }
  async exchangeOnce() {
    const outboundCount = this.outbound.length;
    const response = await this.sendNativeMessage({
      type: SAFARI_NATIVE_RELAY_MESSAGE_TYPE,
      contextId: this.contextId,
      outbound: this.outbound.slice(0, outboundCount),
      waitMilliseconds: this.waitMilliseconds
    });
    if (!isRecord(response))
      throw new Error("Safari native relay returned an invalid response");
    const reply = response;
    if (typeof reply.error === "string" && reply.error.length > 0) {
      throw new Error(reply.error);
    }
    if (outboundCount > 0)
      this.outbound.splice(0, outboundCount);
    const messages = Array.isArray(reply.messages) ? reply.messages : [];
    for (const message of messages)
      await this.onMessage(message);
    return { connected: reply.connected === true, received: messages.length };
  }
  async runLoop() {
    let retryDelay = 250;
    while (this.running) {
      try {
        const result = await this.exchangeOnce();
        this.onConnectionChange(result.connected);
        retryDelay = 250;
        if (!result.connected)
          await this.sleep(retryDelay);
      } catch (error) {
        const relayError = error instanceof Error ? error : new Error(String(error));
        this.onConnectionChange(false);
        this.onError(relayError);
        await this.sleep(retryDelay);
        retryDelay = Math.min(retryDelay * 2, 5000);
      }
    }
  }
  sendNativeMessage(message) {
    const sendNativeMessage = this.runtime.sendNativeMessage;
    if (typeof sendNativeMessage !== "function") {
      return Promise.reject(new Error("Safari runtime.sendNativeMessage is unavailable"));
    }
    return new Promise((resolve, reject) => {
      let settled = false;
      const succeed = (value) => {
        if (settled)
          return;
        settled = true;
        resolve(value);
      };
      const fail = (error) => {
        if (settled)
          return;
        settled = true;
        reject(error instanceof Error ? error : new Error(String(error)));
      };
      const callback = (response) => {
        const lastError = this.runtime.lastError;
        if (lastError?.message)
          fail(new Error(lastError.message));
        else
          succeed(response);
      };
      try {
        const maybePromise = sendNativeMessage.call(this.runtime, SAFARI_NATIVE_RELAY_APPLICATION_ID, message, callback);
        if (maybePromise && typeof maybePromise.then === "function") {
          maybePromise.then(succeed, fail);
        }
      } catch (error) {
        fail(error);
      }
    });
  }
}

// extension/src/background/transport.ts
var nativePort = null;
var activeTransport = "none";
var isConnecting = false;
var nativeReconnectDelay = INITIAL_RECONNECT_DELAY_MS;
var wsReconnectDelay = INITIAL_RECONNECT_DELAY_MS;
var nativeReconnectTimer = null;
var wsReconnectTimer = null;
var wsChannel = null;
var wsReady = false;
var wsKeepalive = { keepalivesSinceAck: 0, ackSupported: false };
var wsKeepAliveTimer = null;
var keepalivePongTimer = null;
var pendingHandshakePort = null;
var lastNativeActivityAt = 0;
var WS_URL = "ws://localhost:19222";
var configuredContextId = null;
var forceWebSocketTransport = false;
var WebSocketImpl = globalThis.WebSocket;
var safariNativeRelayEnabled = false;
var safariNativeRelayClient = null;
var WS_KEEPALIVE_MISS_LIMIT = 2;
var OUTBOUND_RECOVERY_QUEUE_CAP = 50;
var outboundRecoveryQueue = [];
function describeOutboundMessage(msg) {
  const candidate = msg;
  if (candidate && typeof candidate.id === "string") {
    const error = typeof candidate.result?.error === "string" ? ` (${candidate.result.error})` : "";
    return `${candidate.id}${error}`;
  }
  return JSON.stringify(msg).slice(0, 200);
}
function emitEvent(event, data = {}) {
  sendToHost({ type: "event", event, ...data });
}
function clearNativeStateFor(port) {
  if (nativePort === port)
    nativePort = null;
  if (pendingHandshakePort === port)
    pendingHandshakePort = null;
  if (activeTransport === "native")
    activeTransport = "none";
}
function disconnectNativePort(port) {
  if (!port)
    return;
  safeNativePortDisconnect(port);
  if (keepalivePongTimer) {
    clearTimeout(keepalivePongTimer);
    keepalivePongTimer = null;
  }
  clearNativeStateFor(port);
}
function hasNativeMessaging() {
  if (forceWebSocketTransport)
    return false;
  if (globalThis.INTERCEPTOR_FORCE_WS)
    return false;
  return typeof chrome.runtime.connectNative === "function";
}
function postNative(msg, port = nativePort) {
  if (!port)
    return false;
  const res = safeNativePortPost(port, msg);
  if (res.posted)
    return true;
  console.error("nativePort.postMessage threw (port disconnected before onDisconnect fired):", res.error);
  clearNativeStateFor(port);
  scheduleNativeReconnect();
  return false;
}
function isWsOpen() {
  if (!wsReady || !wsChannel || wsChannel.readyState !== WebSocketImpl.OPEN)
    return false;
  return true;
}
function markWsUnregistered() {
  wsReady = false;
  if (activeTransport === "websocket")
    activeTransport = "none";
}
function markWsRegistered() {
  wsReady = true;
  clearContextConflictBadge(chrome);
  if (activeTransport !== "native") {
    activeTransport = "websocket";
    wsReconnectDelay = INITIAL_RECONNECT_DELAY_MS;
    isConnecting = false;
    console.log("connection ready via ws channel");
    drainMessageQueue();
  }
  drainOutboundRecoveryQueue();
}
function sendWs(msg) {
  const channel = wsChannel;
  if (!wsReady || !channel || channel.readyState !== WebSocketImpl.OPEN)
    return false;
  try {
    channel.send(JSON.stringify(msg));
    return true;
  } catch {
    return false;
  }
}
function extensionVersion() {
  try {
    return chrome.runtime.getManifest().version;
  } catch {
    return;
  }
}
function sendWsRegistration(ws, contextId) {
  markWsUnregistered();
  try {
    ws.send(JSON.stringify({ type: "extension", contextId, version: extensionVersion() }));
    return true;
  } catch (err) {
    console.error("ws context registration send error:", err);
    return false;
  }
}
function closeWsForReconnect(ws) {
  try {
    ws.close();
  } catch {}
  if (wsChannel !== ws)
    return;
  stopWsKeepAlive();
  markWsUnregistered();
  wsChannel = null;
  scheduleWsReconnect();
}
function enqueueOutboundRecovery(msg) {
  if (outboundRecoveryQueue.length >= OUTBOUND_RECOVERY_QUEUE_CAP) {
    const dropped = outboundRecoveryQueue.shift();
    console.error("final delivery failure for queued outbound message:", describeOutboundMessage(dropped));
  }
  outboundRecoveryQueue.push(msg);
  return "queued";
}
function drainOutboundRecoveryQueue() {
  while (outboundRecoveryQueue.length > 0) {
    const msg = outboundRecoveryQueue[0];
    if (!sendWs(msg))
      return;
    outboundRecoveryQueue.shift();
  }
}
function sendToHost(msg, forceWs, allowQueue = false) {
  if (safariNativeRelayEnabled) {
    connectSafariNativeRelayChannel();
    if (!safariNativeRelayClient) {
      return allowQueue ? enqueueOutboundRecovery(msg) : "failed";
    }
    safariNativeRelayClient.enqueue(msg);
    return "queued";
  }
  if (forceWs) {
    if (sendWs(msg))
      return "sent";
    return allowQueue ? enqueueOutboundRecovery(msg) : "failed";
  }
  if (activeTransport === "native" && nativePort) {
    if (postNative(msg))
      return "sent";
  }
  if (activeTransport === "websocket" && wsReady && wsChannel) {
    if (sendWs(msg))
      return "sent";
    return allowQueue ? enqueueOutboundRecovery(msg) : "failed";
  }
  if (nativePort) {
    if (postNative(msg))
      return "sent";
  }
  if (wsReady && wsChannel) {
    if (sendWs(msg))
      return "sent";
  }
  return allowQueue ? enqueueOutboundRecovery(msg) : "failed";
}
function scheduleWsReconnect() {
  if (wsReconnectTimer)
    return;
  if (wsChannel && (wsChannel.readyState === WebSocketImpl.OPEN || wsChannel.readyState === WebSocketImpl.CONNECTING))
    return;
  const delay = delayWithJitter(wsReconnectDelay);
  wsReconnectTimer = setTimeout(() => {
    wsReconnectTimer = null;
    connectWsChannel();
  }, delay);
  wsReconnectDelay = nextReconnectDelay(wsReconnectDelay);
}
function scheduleNativeReconnect() {
  if (nativeReconnectTimer)
    return;
  if (nativePort || isConnecting)
    return;
  const delay = delayWithJitter(nativeReconnectDelay);
  nativeReconnectTimer = setTimeout(() => {
    nativeReconnectTimer = null;
    connectToHost();
  }, delay);
  nativeReconnectDelay = nextReconnectDelay(nativeReconnectDelay);
}
function connectToHost() {
  if (safariNativeRelayEnabled) {
    connectSafariNativeRelayChannel();
    return;
  }
  if (!hasNativeMessaging()) {
    if (isWsOpen())
      activeTransport = "websocket";
    else
      connectWsChannel();
    return;
  }
  if (nativePort || isConnecting)
    return;
  isConnecting = true;
  const port = chrome.runtime.connectNative("com.interceptor.host");
  const handshakeTimer = setTimeout(() => {
    console.error("native host handshake timeout (10s)");
    disconnectNativePort(port);
    scheduleNativeReconnect();
  }, 1e4);
  port.onMessage.addListener((msg) => {
    if (msg.type === "pong") {
      lastNativeActivityAt = Date.now();
      if (pendingHandshakePort === port) {
        clearTimeout(handshakeTimer);
        pendingHandshakePort = null;
        activeTransport = "native";
        nativeReconnectDelay = INITIAL_RECONNECT_DELAY_MS;
        if (nativeReconnectTimer) {
          clearTimeout(nativeReconnectTimer);
          nativeReconnectTimer = null;
        }
        isConnecting = false;
        console.log("native host connected (pong received)");
        emitEvent("connection_established");
        drainMessageQueue();
      }
      if (keepalivePongTimer) {
        clearTimeout(keepalivePongTimer);
        keepalivePongTimer = null;
      }
      return;
    }
    lastNativeActivityAt = Date.now();
    handleDaemonMessage(msg);
  });
  port.onDisconnect.addListener(() => {
    const disconnectedPort = port;
    isConnecting = false;
    const lastError = chrome.runtime.lastError;
    if (lastError)
      console.error("native host disconnected:", lastError.message);
    console.log("connection_lost", lastError?.message);
    clearNativeStateFor(disconnectedPort);
    if (isWsOpen()) {
      activeTransport = "websocket";
      console.log("native host down but ws channel active, switching to websocket");
      recoverPendingRequestsAfterNativeDisconnect(pendingRequests, (msg) => sendToHost(msg, true, true));
      pendingRequests.clear();
      scheduleNativeReconnect();
      return;
    }
    recoverPendingRequestsAfterNativeDisconnect(pendingRequests, (msg) => sendToHost(msg, true, true));
    pendingRequests.clear();
    scheduleNativeReconnect();
  });
  nativePort = port;
  pendingHandshakePort = port;
  const ping = safeNativePortPing(port);
  if (!ping.posted) {
    clearTimeout(handshakeTimer);
    clearNativeStateFor(port);
    isConnecting = false;
    scheduleNativeReconnect();
  }
}
function handleControlPlaneMessage(rawMessage, transport) {
  if (!rawMessage || typeof rawMessage !== "object")
    return;
  const msg = rawMessage;
  const controlType = registrationControlType(msg);
  if (controlType === "context_conflict") {
    if (transport === "websocket")
      markWsUnregistered();
    else if (activeTransport === "safari-native")
      activeTransport = "none";
    console.error(`[interceptor] context name conflict: '${msg.contextId}' is already registered. Change the context ID in the extension popup.`);
    setContextConflictBadge(chrome);
    return;
  }
  if (controlType === "context_registered") {
    if (transport === "websocket") {
      markWsRegistered();
    } else {
      activeTransport = "safari-native";
      clearContextConflictBadge(chrome);
      drainMessageQueue();
      while (outboundRecoveryQueue.length > 0) {
        safariNativeRelayClient?.enqueue(outboundRecoveryQueue.shift());
      }
    }
    return;
  }
  if (msg.id && msg.action) {
    msg._viaWs = true;
    handleDaemonMessage(msg);
  }
}
function connectSafariNativeRelayChannel() {
  if (!safariNativeRelayEnabled)
    return;
  if (safariNativeRelayClient) {
    safariNativeRelayClient.start();
    return;
  }
  const contextId = configuredContextId;
  if (!contextId) {
    console.error("Safari native relay requires an explicit context id");
    return;
  }
  const runtime = chrome.runtime;
  if (!runtime) {
    console.error("Safari native relay requires chrome.runtime");
    return;
  }
  safariNativeRelayClient = new SafariNativeRelayClient({
    runtime,
    contextId,
    onMessage: (message) => handleControlPlaneMessage(message, "safari-native"),
    onConnectionChange: (connected) => {
      if (!connected && activeTransport === "safari-native")
        activeTransport = "none";
    },
    onError: (error) => console.error("Safari native relay:", error.message)
  });
  safariNativeRelayClient.start();
}
function wsStateOnOpen() {
  return { keepalivesSinceAck: 0, ackSupported: false };
}
function wsStateOnKeepaliveSent(state) {
  return { ...state, keepalivesSinceAck: state.keepalivesSinceAck + 1 };
}
function wsStateOnInboundFrame(state) {
  return { ...state, keepalivesSinceAck: 0 };
}
function wsStateOnAck(state) {
  return { ...state, ackSupported: true };
}
function shouldForceWsReconnect(ackSupported, keepalivesSinceAck, missLimit) {
  return ackSupported && keepalivesSinceAck >= missLimit;
}
function startWsKeepAlive() {
  if (wsKeepAliveTimer)
    clearInterval(wsKeepAliveTimer);
  wsKeepAliveTimer = setInterval(() => {
    const channel = wsChannel;
    if (!channel || channel.readyState !== WebSocketImpl.OPEN) {
      if (wsKeepAliveTimer)
        clearInterval(wsKeepAliveTimer);
      wsKeepAliveTimer = null;
      return;
    }
    if (shouldForceWsReconnect(wsKeepalive.ackSupported, wsKeepalive.keepalivesSinceAck, WS_KEEPALIVE_MISS_LIMIT)) {
      console.error(`ws inbound stale (${wsKeepalive.keepalivesSinceAck} unacked keepalives) — forcing reconnect`);
      closeWsForReconnect(channel);
      return;
    }
    try {
      channel.send(JSON.stringify({ type: "keepalive", timestamp: Date.now() }));
      wsKeepalive = wsStateOnKeepaliveSent(wsKeepalive);
    } catch {}
  }, 20000);
}
function stopWsKeepAlive() {
  if (wsKeepAliveTimer)
    clearInterval(wsKeepAliveTimer);
  wsKeepAliveTimer = null;
}
async function getOrCreateContextId() {
  const legacyConfigured = globalThis.INTERCEPTOR_APP_CONTEXT_ID;
  const configured = configuredContextId ?? legacyConfigured;
  const storage = chrome.storage?.local;
  if (typeof configured === "string" && configured.length > 0) {
    try {
      await storage?.set({ contextId: configured });
    } catch {}
    return configured;
  }
  const stored = storage ? await storage.get("contextId") : {};
  if (stored?.contextId)
    return stored.contextId;
  const id = crypto.randomUUID();
  try {
    await storage?.set({ contextId: id });
  } catch {}
  return id;
}
function connectWsChannel() {
  if (safariNativeRelayEnabled) {
    connectSafariNativeRelayChannel();
    return;
  }
  if (wsChannel && (wsChannel.readyState === WebSocketImpl.OPEN || wsChannel.readyState === WebSocketImpl.CONNECTING))
    return;
  try {
    const ws = new WebSocketImpl(WS_URL);
    wsChannel = ws;
    ws.onopen = async () => {
      if (wsChannel !== ws) {
        try {
          ws.close();
        } catch {}
        return;
      }
      markWsUnregistered();
      if (wsReconnectTimer) {
        clearTimeout(wsReconnectTimer);
        wsReconnectTimer = null;
      }
      wsKeepalive = wsStateOnOpen();
      startWsKeepAlive();
      const contextId = await getOrCreateContextId();
      if (wsChannel !== ws) {
        try {
          ws.close();
        } catch {}
        return;
      }
      if (ws.readyState !== WebSocketImpl.OPEN)
        return;
      if (!sendWsRegistration(ws, contextId)) {
        closeWsForReconnect(ws);
        return;
      }
      console.log("ws channel connected; context registration requested");
    };
    ws.onmessage = (event) => {
      if (wsChannel !== ws)
        return;
      wsKeepalive = wsStateOnInboundFrame(wsKeepalive);
      try {
        const msg = JSON.parse(typeof event.data === "string" ? event.data : "");
        if (msg?.type === "keepalive_ack") {
          wsKeepalive = wsStateOnAck(wsKeepalive);
          return;
        }
        console.log("ws onmessage:", JSON.stringify(msg).slice(0, 200));
        handleControlPlaneMessage(msg, "websocket");
      } catch (err) {
        console.error("ws onmessage error:", err);
      }
    };
    ws.onclose = () => {
      if (wsChannel !== ws)
        return;
      stopWsKeepAlive();
      markWsUnregistered();
      wsChannel = null;
      scheduleWsReconnect();
    };
    ws.onerror = () => {
      if (wsChannel !== ws)
        return;
      stopWsKeepAlive();
      markWsUnregistered();
      wsChannel = null;
      scheduleWsReconnect();
    };
  } catch {
    markWsUnregistered();
    wsChannel = null;
    scheduleWsReconnect();
  }
}
var lastSwKeepalive = 0;
function registerSwKeepaliveListener() {
  const onMessage = chrome.runtime?.onMessage;
  if (!onMessage?.addListener)
    return;
  onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg.type !== "sw_keepalive")
      return false;
    const now = Date.now();
    if (now - lastSwKeepalive < 20000) {
      sendResponse({ leader: false });
    } else {
      lastSwKeepalive = now;
      sendResponse({ leader: true });
    }
    return false;
  });
}
function registerStorageContextListener() {
  const onChanged = chrome.storage?.onChanged;
  if (!onChanged?.addListener)
    return;
  onChanged.addListener((changes, area) => {
    if (area !== "local" || !changes.contextId)
      return;
    const newId = changes.contextId.newValue;
    if (typeof newId !== "string" || newId.length === 0)
      return;
    if (!newId || !wsChannel || wsChannel.readyState !== WebSocketImpl.OPEN)
      return;
    const channel = wsChannel;
    if (!sendWsRegistration(channel, newId)) {
      closeWsForReconnect(channel);
    }
  });
}

// extension/src/background-electron.ts
initializeActionRouter();
registerSwKeepaliveListener();
registerStorageContextListener();
connectWsChannel();
