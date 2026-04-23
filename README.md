# Copilot Annotation

Copilot Annotation is an extension for VS Code that lets you visually annotate on top of a website preview to give feedback, report bugs, or take notes. Annotations are turned into powerful context that GitHub Copilot can understand more deeply than plain text, and the extension sends that context directly to Copilot when you are ready.

## What It Does

- Opens a web preview inside VS Code.
- Accepts local HTML files as well as local development server URLs.
- Automatically reloads the preview when a local HTML preview or local development server content changes.
- Injects an annotation toolbar directly into the previewed page.
- Supports text selection, single element selection, multi-selection, and area selection.
- Places numbered markers on the page and lets you edit or remove annotations later.
- Shows computed styles in the annotation editor.
- Generates consistent markdown output with the source URL and viewport size.
- Sends the markdown to a Copilot language model when available, with a clipboard and markdown-document fallback.

## How To Use It
1. Open a local HTML file or start a local development server.
2. Run the `Copilot Annotation: Open Website Preview` command from the Command Palette.
3. Use the annotation toolbar to create annotations on the page.
4. When you are ready, click the "Send Feedback" button in the annotation toolbar.
5. If you have access to a Copilot chat model and grant permission, the markdown is sent directly to Copilot. Otherwise, the markdown opens in a new editor and is copied to your clipboard for easy pasting.
6. Watch as Copilot understands the annotated context and generates more accurate and relevant responses and results.

## Project Structure

- `src/extension.ts`: command registration, webview shell, and Copilot export flow.
- `src/proxy/annotationProxyServer.ts`: local proxy server that preserves page paths, injects the annotation runtime, and rewrites same-origin requests through the proxy.
- `media/injected.js`: in-page annotation UI and markdown generator.
- `media/injected.css`: annotation styling.

## Get Started Developing the Extension

1. Run `npm install`.
2. Run `npm run compile`.
3. Press `F5` in VS Code to launch the extension host.
4. Run `Copilot Annotation: Open Website Preview` from the Command Palette.
5. Enter your local development URL, such as `http://127.0.0.1:3000`, or a local HTML file path such as `C:\site\index.html`.

## Local Files

- If the active editor is a saved `.html` or `.htm` file, the open-preview command uses that file path as the default target.
- You can also enter a `file:///...` URI or an existing local file path manually.
- Relative CSS, JS, image, and font assets next to that file continue to load through the preview proxy.
- When files in that local preview folder change, the preview reloads automatically so you do not need to reopen it.

## Auto Reload

- Local file previews automatically reload when files in the preview folder change.
- Local development server previews automatically reload when workspace files are saved, created, deleted, or renamed.

## Notes

- The proxy approach preserves same-origin relative routes and works best with local development servers and mostly same-origin assets.
- Direct Copilot sending depends on the user having access to a Copilot chat model and granting language-model permission to this extension.
- If direct Copilot sending is unavailable, the extension opens the markdown in an editor and copies it to the clipboard.

