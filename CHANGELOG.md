# Changelog

## 1.0.5 - 25-04-2026

- Improved element highlight and outline detection for components whose visible area comes from nested content rather than a simple outer box.
- Fixed an issue where hover highlights could fail on some nested app layouts because selector paths rooted at stable element IDs were being generated incorrectly.
- This also improves annotation tracking reliability for dynamic SPA pages with deeply nested panels and statistic cards.


## 1.0.4 - 24-04-2026

- Fixed a small issue that caused the site preview to slightly overflow the viewport at the bottom.
- Split the injected annotation runtime into multiple files for better organization and maintainability.
- Removed the "Preview" label from the extension as it is now fairly stable and ready for broader use.
- Moved the individual VSIX release packages to a separate /releases directory to reduce clutter in the main repository and make it easier to find the latest release.
- Fixed an issue where the annotation markers and highlights would not update their positions when the page was scrolled. They now properly track the annotated elements even when you scroll the page after creating annotations.