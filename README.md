# Plain Text Kanban

An [Obsidian](https://obsidian.md) plugin that turns simple nested markdown lists into fully interactive kanban boards, while keeping your files plain text and readable in any editor.

> **Note:** This plugin was entirely developed with **Claude Opus 4.6**.

## Installation

### From Obsidian Community Plugins
1. Open **Settings → Community plugins → Browse**
2. Search for **Plain Text Kanban**
3. Select **Install**, then **Enable**

### Manual
1. Download `main.js`, `manifest.json`, and `styles.css` from the [latest release](../../releases/latest)
2. Create a folder at `<your vault>/.obsidian/plugins/plain-text-kanban/`
3. Copy the three files into that folder
4. Restart Obsidian and enable the plugin in **Settings → Community plugins**

## How to use
To open a board, run **Open current file as kanban board** from the command palette, or right-click a markdown file in the file explorer and choose **Open as kanban board** from the context menu. The kanban view will load that `.md` file and keep the text file readable while giving you full board interaction.

## File format

```markdown
<!-- kanban-labels: {"bug":"#e03e3e","feature":"#2f80ed"} -->
- # To Do
	- ## Fix login page #bug
		Some description in **markdown**.
	- ## Add dark mode #feature
- # In Progress
	- ## Refactor API #feature
		- [x] Extract helpers
		- [ ] Write tests
- # Done
```

Columns are `- # Title`, cards are `\t- ## Title`, and everything below a card is its body. Labels are `#hashtags` in the card title. Colors and swimlane config are stored as HTML comments.

## Features

### Board & columns
- Horizontal scrolling board with fixed-width columns
- Add, delete, and archive columns
- Inline rename — click a column title to edit it
- Drag-and-drop column reordering with visual placeholders
- Card count badge per column

### Cards
- Add, delete, and inline-edit card titles and bodies
- Full markdown rendering in card bodies (bold, links, images, lists, code, etc.)
- Interactive checkboxes, click to toggle `- [ ]` / `- [x]` directly
- Drag-and-drop within and across columns
- Auto-detected and clickable file paths (Windows & Unix) in card descriptions

### Labels
- Tag-based labels derived from `#hashtags` in card titles
- Colored pills with auto-assigned or custom colors
- Add, remove, and rename labels inline
- Rename propagates across all cards on the board
- Inline color picker with live preview
- Contrast-aware text (auto black/white based on background)

### Swimlanes
- Filter the board into multiple horizontal swimlanes by label
- Add/remove swimlanes and label filters with a searchable dropdown
- Special "no label" filter for untagged cards
- New cards auto-inherit the swimlane's filter labels

### Settings
| Setting | Description |
|---|---|
| Hide card counter | Hides the card count badge on columns |
| Hide "Add label" buttons | Hides the "+ Add label" button on cards |
| Hide "Add description" | Hides the body placeholder on empty cards |
| Show buttons on hover only | Archive/delete buttons appear only on hover |
| Hide swimlanes | Hides swimlane UI, shows a single unfiltered board |

### Other
- Open any `.md` file as a kanban via the command palette or the file context menu
- Switch back to the standard markdown editor with one click
- Works on desktop and mobile
- Themed with Obsidian CSS variables, adapts to any theme

## License

[Apache License 2.0](LICENSE)
