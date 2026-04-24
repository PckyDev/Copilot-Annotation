# Changelog

## 1.0.4 - 24-04-2026

- Fixed a small issue that caused the site preview to slightly overflow the viewport at the bottom.
- Split the injected annotation runtime into multiple files for better organization and maintainability.
- Removed the "Preview" label from the extension as it is now fairly stable and ready for broader use.
- Moved the individual VSIX release packages to a separate /releases directory to reduce clutter in the main repository and make it easier to find the latest release.
- Fixed an issue where the annotation markers and highlights would not update their positions when the page was scrolled. They now properly track the annotated elements even when you scroll the page after creating annotations.