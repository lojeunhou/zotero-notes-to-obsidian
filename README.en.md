# Zotero Notes to Obsidian

Sync notes from Zotero Desktop into an Obsidian vault as Markdown files.

This is a small local-first tool for researchers who keep annotations, excerpts, or reading notes in Zotero and want them available inside Obsidian without manually exporting them one by one.

## What It Does

- Reads Zotero notes from the Zotero Desktop local API.
- Converts Zotero note HTML into Markdown.
- Writes one Markdown file per Zotero note.
- Adds useful frontmatter: Zotero key, parent item title, creators, year, tags, dates, and `zotero://` links.
- Creates an `_index.md` file for quick browsing inside Obsidian.
- Stores a `.zotero-notes-manifest.json` file so sync results can be checked later.

## Requirements

- Python 3.10 or newer
- Zotero Desktop running locally
- Zotero local API reachable at `http://127.0.0.1:23119`
- An Obsidian vault folder on your computer

No third-party Python packages are required.

## Install

From a local clone:

```bash
python3 -m pip install .
```

For development:

```bash
python3 -m pip install -e .
```

## Quick Start

Check whether Zotero is reachable:

```bash
zotero-notes-to-obsidian --check
```

Sync notes into a vault:

```bash
zotero-notes-to-obsidian --vault "/path/to/Your Obsidian Vault"
```

By default, notes are written to:

```text
Reading Notes/Zotero Notes
```

Use an exact target folder if you prefer:

```bash
zotero-notes-to-obsidian --target "/path/to/Your Vault/Zotero Notes"
```

Preview without writing files:

```bash
zotero-notes-to-obsidian --vault "/path/to/Your Vault" --dry-run
```

## Obsidian Plugin

This repository also includes an Obsidian plugin version in [`obsidian-plugin/`](obsidian-plugin/).

The plugin includes:

- A ribbon button for one-click sync
- A command palette sync command
- A Zotero local API check command
- A settings tab
- Optional startup sync and interval sync while Obsidian is open

Build it with:

```bash
cd obsidian-plugin
npm install
npm run build
```

For manual installation, copy `main.js`, `manifest.json`, and `styles.css` into:

```text
YourVault/.obsidian/plugins/zotero-notes-to-obsidian/
```

## Config File

Copy `config.example.json` and edit the paths:

```bash
cp config.example.json config.json
zotero-notes-to-obsidian --config config.json
```

Example:

```json
{
  "vault": "/path/to/Obsidian/My Vault",
  "subdir": "Reading Notes/Zotero Notes",
  "base_url": "http://127.0.0.1:23119/api/users/0",
  "page_limit": 100
}
```

## Output Format

Each synced note looks roughly like this:

```markdown
---
source: zotero
tags:
  - zotero-note
zotero_key: "ABCD1234"
zotero_select: "zotero://select/library/items/ABCD1234"
parent_title: "Example Book"
parent_creators:
  - "Jane Author"
parent_year: "2024"
---

# Example Book

- Zotero note: [open](zotero://select/library/items/ABCD1234)
- Zotero parent: [open](zotero://select/library/items/PARENT01)

## Note

Your Zotero note content appears here.
```

## Scheduling

You can run the command from cron, launchd, Windows Task Scheduler, systemd timers, or any automation app.

Example cron entry for every Wednesday and Sunday at 14:00:

```cron
0 14 * * 0,3 zotero-notes-to-obsidian --config /path/to/config.json
```

## Notes and Limits

- This tool only reads from Zotero. It does not write back into Zotero.
- It does not sync PDFs or attachments yet.
- Existing synced files with the same Zotero key are overwritten on the next run.
- File names include the Zotero note key, so duplicate parent titles are safe.
- Image references inside Zotero note HTML are preserved as Markdown image links when possible, but attachment extraction is not implemented yet.

## Development

Run tests:

```bash
python3 -m unittest discover -s tests
```

## License

MIT
