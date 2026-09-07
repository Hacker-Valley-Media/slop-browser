---
title: Interceptor Privacy Policy
---

# Interceptor Privacy Policy

Effective date: 2026-09-05. Applies to the Interceptor browser extension for Chrome, Brave, and Edge, published by Hacker Valley Media, LLC.

## What the extension is

Interceptor is a command-line tool that lets software running on your own computer (an AI coding agent or a script) operate your browser. The extension is the browser side of that tool. It connects to the Interceptor daemon on the same computer and carries out commands that arrive from the `interceptor` CLI. Its content scripts also install local page and network observation hooks when matching pages load, as described below.

## Data the extension can access

The extension can read or act on:

- page content, page structure, and text of tabs in its tab group;
- screenshots of those tabs;
- network requests and responses made by those tabs;
- cookies, browsing history, bookmarks, downloads, and recently closed sessions;
- the clipboard;
- tab and window metadata (URLs, titles, groups);
- form fields it types into on your behalf.

On matching pages, content scripts run at `document_start` in every frame. They automatically observe fetch and XMLHttpRequest traffic, including URLs, methods, request and response headers, status codes, and response bodies. They also observe bounded previews of WebSocket, Beacon, BroadcastChannel, and server-sent-event activity. These observations stay in entry-count-capped, in-memory page buffers so a later local CLI command can inspect traffic that happened before the command was issued.

Other reads and every browser action occur only because a command was issued on your computer. Interceptor does not send the passive buffers to its daemon, CLI, publisher, or another server unless a local command requests them.

## Where the data goes

All data moves between the extension and the Interceptor daemon on the same machine, over Chrome native messaging or a localhost WebSocket. The daemon hands it to the CLI or agent that asked for it.

- Hacker Valley Media operates no servers for the extension. Nothing is sent to us.
- The extension contains no analytics, advertising, or tracking code.
- No data is sold or shared with third parties.
- OCR runs locally with a bundled Tesseract engine. Images never leave your computer.
- Credentials delivered through the Interceptor secret vault are typed into the page and are never written to the extension's logs or monitor output.

What the CLI or agent does with the data afterwards is under your control and governed by the tools you run, not by this extension.

## What the extension stores

The extension stores its own settings (tab-group policy, idle timeout, browser context id) in the browser's local extension storage. Passive capture is stored in memory in the page: up to 500 fetch/XHR entries, 200 header entries, 1,000 page-communication entries, and 50 completed server-sent-event streams per frame. Entries are evicted when those limits are reached and are removed when the page is unloaded or the buffer is cleared. A captured fetch/XHR response body can be as large as the response supplied by the page; the CLI applies a separate response budget when returning logs. Monitor commands can explicitly persist selected, redacted, size-capped evidence to local disk.

## Remote code

The extension ships all of its code in the package. It does not download or execute code from the network.

## Your choices

Disable or remove the extension from your browser's extensions page at any time. Removing the extension removes its stored settings. The daemon and CLI are uninstalled separately using the uninstaller shipped with the installer.

## Changes

Changes to this policy are posted at this URL with an updated effective date.

## Contact

Open an issue at https://github.com/Hacker-Valley-Media/Interceptor/issues or use the support contact on the store listing.
