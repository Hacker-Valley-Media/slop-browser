type ActionResult = { success: boolean; error?: string; data?: unknown; tabId?: number }

/**
 * Gecko surfaces most bookmarks failures as the bare string "An unexpected
 * error occurred", which tells the caller nothing about whether the API is
 * missing, unpermitted, or genuinely failing. Name the browser-side condition
 * we can actually check — API presence — and pass the original text through.
 */
function bookmarksError(err: unknown): ActionResult {
  const api = (chrome as unknown as { bookmarks?: unknown }).bookmarks
  const detail = err instanceof Error ? err.message : String(err)
  if (!api) {
    return { success: false, error: "this browser does not expose a bookmarks API" }
  }
  return { success: false, error: `bookmarks call failed: ${detail}` }
}

export async function handleBookmarkActions(
  action: { type: string; [key: string]: unknown },
  _tabId: number
): Promise<ActionResult> {
  try {
    return await dispatchBookmarkAction(action)
  } catch (err) {
    return bookmarksError(err)
  }
}

async function dispatchBookmarkAction(
  action: { type: string; [key: string]: unknown }
): Promise<ActionResult> {
  switch (action.type) {
    case "bookmark_tree": {
      const tree = await chrome.bookmarks.getTree()
      return { success: true, data: tree }
    }

    case "bookmark_search": {
      const results = await chrome.bookmarks.search(action.query as string)
      return {
        success: true,
        data: results.map(b => ({ id: b.id, title: b.title, url: b.url, parentId: b.parentId }))
      }
    }

    case "bookmark_create": {
      const bm = await chrome.bookmarks.create({
        title: action.title as string,
        url: action.url as string | undefined,
        parentId: action.parentId as string | undefined
      })
      return { success: true, data: bm }
    }

    case "bookmark_delete":
      await chrome.bookmarks.remove(action.id as string)
      return { success: true }

    case "bookmark_update":
      await chrome.bookmarks.update(action.id as string, {
        title: action.title as string | undefined,
        url: action.url as string | undefined
      })
      return { success: true }
  }
  return { success: false, error: `unknown bookmark action: ${action.type}` }
}
