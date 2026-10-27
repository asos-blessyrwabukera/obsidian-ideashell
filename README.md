<p align="center">
  <img src="assets/banner.png" alt="Obsidian → ideashell" width="760">
</p>

# ideashell for Obsidian

English | [简体中文](README.zh-CN.md)

Sync between [Obsidian](https://obsidian.md) and [ideashell (闪念贝壳)](https://ideashell.site):

- **Import** your ideashell notes, AI summaries and voice transcripts into the vault as Markdown, from a template you control.
- **Import to-dos** as tasks for TaskNotes, TaskForge or the Tasks plugin.
- **Send** Obsidian notes to ideashell — text, tags, folders and images.

Both directions deduplicate by ideashell note id, so repeating a sync never creates copies.

## Features

### Import from ideashell

| | |
|---|---|
| **All your notes** | Imports every ideashell note (or only the last 7 / 30 / 90 / 365 days), including AI summaries and voice memo transcripts. |
| **Auto-sync** | Manual only, on startup, or every 1 min / 15 min / 30 min / 1 h / 12 h. Off (manual) by default. |
| **Template-based** | Customise the frontmatter and body with `{{ideashell_*}}` variables and `{{#var}}…{{/var}}` conditional blocks. |
| **Smart deduplication** | Notes are tracked by `ideashell_id` anywhere in the vault, so moved or renamed notes are updated, not duplicated. |
| **Preserve edits** | *Skip existing notes* (on by default) never touches a note that is already in the vault. |
| **Transcripts** | Voice memo / recording transcripts are included (toggle). Notes still transcribing are imported once the text is ready. |
| **Daily notes** | Optionally link each imported note from the daily note of the day it was created, under a heading such as `## ideashell`. |
| **Dated folders** | Folder and file name patterns take `{date}`, `{date:FORMAT}`, `{title}`, `{id}` — e.g. `ideashell/{date:YYYY/MM}`. |

### Send to ideashell

| | |
|---|---|
| **Sync current note** | Command palette, ribbon icon, or right-click a file. |
| **Sync a folder** | Right-click a folder in the file explorer → *Sync folder to ideashell*. Recursive. |
| **Sync a selection of files** | Cmd/Ctrl-click several files (or folders) → right-click → *Sync N notes to ideashell*. |
| **Send selected text** | Select text in the editor → right-click → *Send selection to ideashell*. Creates a standalone quick note. |
| **Sync all** | Sends every note marked with `ideashell: true` plus everything under the folders listed in settings. |
| **Folder mapping** | `Reading/2026/note.md` lands in an ideashell folder named `Reading/2026`. ideashell folders are flat, so the Obsidian path is used as the name. Moving or renaming the folder moves the note on the next sync. |
| **Tags** | Frontmatter `tags` and inline `#tags` become ideashell tags; an `obsidian` tag is added so you can filter these notes (configurable). |
| **Images** | Local images embedded as `![[photo.png]]` (PNG/JPEG/GIF/WebP, ≤ 9 per note, ≤ 10 MB each) are uploaded and attached. Images added later are attached on the next sync. |
| **Auto re-sync** (off by default) | A note that was synced before is re-sent a few seconds after you stop editing it. New notes are never sent without you asking. |

### Import to-dos

| | |
|---|---|
| **Tasks, not notes** | ideashell to-dos become tasks: one [TaskNotes](https://github.com/callumalpass/tasknotes) file per to-do (also read by TaskForge), or one [Tasks](https://publish.obsidian.md/tasks/) emoji-format line per to-do in a single file or in the daily note of the to-do's date. |
| **No duplicates** | Each task carries the to-do id (`ideashell_todo_id` in frontmatter, or a `^ideashell-<id>` block id on the line). Re-imports update tasks in place and never touch tasks without the marker. |
| **Your edits win** | Only fields that changed in ideashell since the last import are written. A task you complete in Obsidian is never reopened, and a task you delete is not brought back. |
| **Two-way completion** (on by default) | Completing an imported task in Obsidian, or in a task app that edits the vault files such as TaskForge, marks it complete in ideashell. Nothing else is sent back. |

The two directions are kept apart: a note imported from ideashell is never sent back (that would overwrite the original with the rendered template), and a note you sent from Obsidian is never overwritten by an import.

## Setup

1. Install the plugin — Community plugins → search **ideashell**, or add this repository in [BRAT](https://github.com/TfTHacker/obsidian42-brat).
2. In ideashell (web or app) open **Settings → MCP** and copy your **API Key** (the MCP access key — the same one you use for Claude / Cursor).
3. Obsidian → Settings → **ideashell**: choose your region (China / Global), paste the key, click **Test**.

## Usage

### Import notes from ideashell
Click the download icon in the ribbon, run **Import new notes** from the command palette, or press **Import** in settings. Progress is shown in a notice; the summary reads `created / updated / unchanged / skipped`.

- The first import lists every note in the configured time range. Later imports only list notes created since the last successful import (with a 10-minute overlap), which keeps scheduled syncs cheap.
- **Import all notes (full re-scan)** (command, or *Full re-scan* in settings) lists the whole time range again — use it to bring back notes you deleted from the vault, or after changing the template with *Skip existing notes* off.
- Notes whose recording is still being transcribed are deferred and picked up automatically on a later import (for up to 3 days).
- If a file with the generated name already exists and is not the same ideashell note, the short id is appended to the name.

#### Template variables

The default template is written to *Template file* (`Templates/ideashell.md`) when the plugin is enabled or on the first import if missing. Edit it freely.

| Variable | Value |
|---|---|
| `{{ideashell_id}}` | ideashell note id (keep it in the frontmatter — it is the dedupe key; the plugin adds it if your template leaves it out) |
| `{{ideashell_title}}` | Note title |
| `{{ideashell_title_yaml}}` | Title as a quoted YAML string, safe in frontmatter |
| `{{ideashell_date}}` | Creation date, `YYYY-MM-DD` (local time) |
| `{{ideashell_time}}` | Creation time in your locale, e.g. `3:05 PM` |
| `{{ideashell_created}}` | Creation timestamp, ISO 8601 |
| `{{ideashell_url}}` | Link to the note, when ideashell provides one |
| `{{ideashell_summary}}` | AI summary |
| `{{ideashell_content}}` | Note body (Markdown) |
| `{{ideashell_transcript}}` | Voice memo / recording transcripts (empty when *Include transcripts* is off) |
| `{{ideashell_attachments}}` | Other sub-items listed by ideashell, such as link cards |
| `{{ideashell_tags}}` | Tags, comma-separated |
| `{{ideashell_tags_list}}` | Tags as YAML list items |

`{{#variable}}…{{/variable}}` keeps its content only when the variable is non-empty. Text coming from ideashell is never interpreted as template markup.

Default template:

```markdown
---
ideashell_id: "{{ideashell_id}}"
title: {{ideashell_title_yaml}}
date: {{ideashell_date}}
created: {{ideashell_created}}
{{#ideashell_url}}ideashell_url: {{ideashell_url}}
{{/ideashell_url}}tags:
  - ideashell
{{ideashell_tags_list}}
---
{{#ideashell_summary}}## Summary

{{ideashell_summary}}

{{/ideashell_summary}}{{#ideashell_content}}## Note

{{ideashell_content}}

{{/ideashell_content}}{{#ideashell_transcript}}## Transcript

{{ideashell_transcript}}

{{/ideashell_transcript}}{{#ideashell_attachments}}## Attachments

{{ideashell_attachments}}
{{/ideashell_attachments}}
```

#### Daily notes

Turn on **Link imported notes in daily notes** in settings. Each note created by an import is then linked from the daily note for the local date it was created in ideashell:

```markdown
## ideashell
- 08:00 [[ideashell/2026-07-11 Standup thoughts|Standup thoughts]]
- 09:05 [[ideashell/2026-07-11 Product idea|Product idea]]
```

- The daily notes folder and date format come from Obsidian's core **Daily notes** plugin. You can override both in this plugin's settings; without either, notes are named `YYYY-MM-DD` in the vault root.
- Links go at the end of the section under *Heading*, which is added if the note does not have it. Leave *Heading* empty to append to the end of the note.
- A missing daily note is created, using the core Daily notes template if one is set (`{{title}}`, `{{date}}`, `{{date:FORMAT}}`, `{{time}}` are filled in). Turn off *Create missing daily notes* to only link into daily notes that already exist.
- A note already linked anywhere in its daily note is never added twice, so you can move or edit the lines freely. A line you delete is not added back by later imports. The command below does add it back.
- Only notes created by an import are linked, not notes that were already in the vault. To link notes you imported earlier, run **Link imported notes in daily notes** from the command palette. It reads each note's `created` (or `date`) frontmatter, which the default template includes.
- Link style (wikilink or Markdown, shortest or full path) follows Obsidian's *Files and links* settings.

> [!warning]
> With *Create missing daily notes* on, a daily note is created for every day that has an imported note. If you turn this feature on before importing all your history (or run the backfill command over a large history), that can mean many past daily notes. Turn *Create missing daily notes* off first if you don't want that.

Imported notes are recognised by `ideashell_id` **without** `ideashell_hash` (only sending a note writes `ideashell_hash`). Don't add `ideashell_hash` to the template.

### Import to-dos from ideashell

Turn on **Enable to-do import** in settings, then run **Import to-dos** from the command palette, or press **Import to-dos** in settings. To import to-dos on the import schedule too, turn on **Include in scheduled import**.

Here is a to-do imported as a TaskNotes file with the default settings:

```markdown
---
type: task
status: ready
priority: normal
scheduled: '2026-10-28T09:00:00'
tags:
  - task
  - ideashell
dateCreated: '2026-10-27T22:04:38.734+00:00'
dateModified: '2026-10-27T22:04:38.734+00:00'
ideashell_todo_id: ba277130-68cc-4feb-975f-b4584f770217
---
```

The file name is the to-do text. If the text is too long for a file name, the full text is also written in the body.

The same to-do as a task line (*Task format* set to *Task line*):

```markdown
## ideashell

- [ ] Validate swap opportunity numbers with Emma after the MBR #task #ideashell ⏳ 2026-10-28 ^ideashell-ba277130-68cc-4feb-975f-b4584f770217
- [x] Get YouTube to Obsidian vault working #task #ideashell ⏳ 2026-10-26 ✅ 2026-10-27 ^ideashell-0f07281c-cea6-4d0f-9dc5-2305d8763428
```

On a re-import, each task is handled like this:

- **Text, date or time changed in ideashell:** only those fields are updated. A TaskNotes file is renamed to the new text; a task line is rewritten.
- **Completed in ideashell:** the task is marked done, with today as the completion date, because ideashell does not report when a to-do was completed.
- **Completed in Obsidian:** the task stays done. With **Two-way completion** on (the default), the to-do is also marked complete in ideashell: a few seconds after you complete the task in Obsidian, or on the next import when it was completed elsewhere, for example in the TaskForge app. Turn on *Include in scheduled import* so those are picked up without running the command. Archived tasks (moved to another folder) are still found.
- **Reopened in ideashell after both sides were done:** the task is reopened in Obsidian only when two-way completion is on.
- **Deleted from the vault:** the to-do is not imported again.

To-do text is treated as data, not markup. Line breaks, leading `- [ ]` markers and Tasks emoji are removed, and `[[`, `<`, `#tag` and `%%` are escaped so they cannot become links, HTML, tags or comments.

### Sync one note
Open the note and run **Sync current note** (`Cmd/Ctrl+P`), click the shell icon in the ribbon, or right-click the file. The first run creates the note; later runs update it. If nothing changed you get *already up to date* and no request is made.

### Sync a folder or several files
Right-click a folder → **Sync folder to ideashell (N notes)**. Or select multiple files with Cmd/Ctrl-click and right-click → **Sync N notes to ideashell**. Progress is shown in a notice; the summary reads `created / updated / unchanged / failed`. Safe to repeat — unchanged notes are skipped.

### Send a snippet
Select text → right-click → **Send selection to ideashell**. The first line becomes the title. This creates a new note every time and is not tracked in frontmatter.

### Keep a set of notes in sync
- Run **Mark current note for sync** to add `ideashell: true` to a note, and/or list folder paths under *Folders to sync* in settings.
- **Sync all marked notes and sync folders** sends all of them.
- Turn on **Auto-sync synced notes** if you want already-synced notes to be re-sent automatically after edits (debounced; delay configurable).

### What ends up in ideashell
- **Title**: frontmatter `title` if present, otherwise the file name (truncated to 30 characters — an ideashell limit).
- **Body**: the markdown body without frontmatter. `[[Note|alias]]` becomes `alias`, `![[photo.png]]` becomes `(photo.png)` in the text while the image itself is attached to the note. (Wikilink conversion can be turned off in settings.)
- **Tags**: `obsidian` (configurable) + frontmatter tags + inline `#tags`.
- **Folder**: named after the Obsidian folder path, created if missing. Notes in the vault root stay unfiled.
- **Images**: attached at note level (a gallery), not inline.

## Sync state in frontmatter (sending)

After a successful send the plugin writes these keys into the note. They are how the plugin knows to update instead of re-create:

```yaml
ideashell_id: "3ab8b88088673df9b7ea47f70d80cfca"   # ideashell note id
ideashell_hash: "90f30068"                          # text hash; unchanged notes are skipped
ideashell_synced: 2026-08-30T08:44:52.913Z
ideashell_url: https://…/boards/3ab8b8…              # link to the note in ideashell
ideashell_folder: ideashell-test                    # folder the note was last placed in
ideashell_images: [ideashell-test/img/red.png]      # images already attached (not re-sent)
```

- Delete `ideashell_id` to make the next sync create a fresh note.
- If you delete the note inside ideashell, the next sync fails with "note not found" — remove `ideashell_id` and sync again.
- Duplicating a synced file in Obsidian copies the `ideashell_id`; both copies would then update the same ideashell note. Remove the id from the copy.

## Settings

| Setting | Default | Meaning |
|---|---|---|
| Region / Custom endpoint | China | Which ideashell server hosts your account. |
| API Key | — | Your ideashell API Key (MCP access key). |
| Source tag | `obsidian` | Tag added to every synced note; empty to disable. |
| Map folders | on | Put notes into an ideashell folder named after the Obsidian folder path. |
| Folders to sync | — | Vault folders included by *Sync all*. |
| Auto-sync synced notes | off | Re-send already-synced notes after edits. |
| Auto-sync delay | 10 s | Wait after the last edit before re-sending. |
| Convert wikilinks to text | on | `[[Note\|alias]]` → `alias`. |

**Import notes**

| Setting | Default | Meaning |
|---|---|---|
| Sync frequency | Manual only | Manual only, On startup, every 1 min / 15 min / 30 min / 1 h / 12 h. |
| Time range | All notes | Only import notes created in the last 7 / 30 / 90 / 365 days, or all. |
| Folder | `ideashell` | Where imported notes go. Takes date tokens: `ideashell/{date:YYYY/MM}`. |
| File name pattern | `{date} {title}` | Supports `{date}`, `{date:FORMAT}` (moment format), `{title}`, `{id}` (first 8 characters). |
| Template file | `Templates/ideashell.md` | Template for imported notes; created with the default content if missing. |
| Skip existing notes | on | Never overwrite a note already in the vault (matched by `ideashell_id` anywhere in the vault). Off = refresh it from ideashell on every import. |
| Include transcripts | on | Fill `{{ideashell_transcript}}` with voice memo transcripts. |
| Show import ribbon icon | on | Ribbon button that runs an import. |

**Daily notes**

| Setting | Default | Meaning |
|---|---|---|
| Link imported notes in daily notes | off | Link notes created by an import from their creation-date daily note. |
| Daily notes folder | core plugin | Folder of daily notes. Empty = the core Daily notes plugin's folder. |
| Daily note date format | core plugin | Moment format of daily note names (may contain `/` for subfolders). Empty = the core plugin's format, else `YYYY-MM-DD`. |
| Heading | `## ideashell` | Section the links are added to (created if missing). Empty = end of the note. |
| Line format | `- {{time}} {{link}}` | One line per note; supports `{{time}}` (HH:mm), `{{link}}`, `{{title}}`. |
| Create missing daily notes | on | Create the daily note when it does not exist. Off = skip days without one. |

**Import to-dos**

| Setting | Default | Meaning |
|---|---|---|
| Enable to-do import | off | Shows the *Import to-dos* command and the settings below. |
| Include in scheduled import | off | Also import to-dos on every scheduled import (see *Sync frequency*). |
| Task format | TaskNotes file per to-do | Or *Task line* in the Tasks emoji format. |
| Task folder | `60 Tasks` | TaskNotes files: folder for new tasks. Moved or archived files are still updated. |
| Open status / Done status | `ready` / `done` | TaskNotes files: status values for open and completed to-dos. |
| Include time | on | TaskNotes files: write the to-do time with the date (`2026-10-28T09:00:00`). Task lines never carry a time, since the Tasks format has none. |
| Target | Single file | Task lines: one file, or the daily note of the to-do's date (folder and format from *Daily notes*). Undated to-dos go in the file. |
| To-dos file | `ideashell/Todos.md` | Task lines: the single file. |
| Heading | `## ideashell` | Task lines: new lines go under this heading, which is added when missing. |
| Date field | Scheduled | Whether the to-do date becomes the scheduled (`⏳`) or due (`📅`) date. ideashell to-dos are plans rather than deadlines, so scheduled is the default. |
| Task tag | `task` | The tag every task needs: TaskNotes' task tag, or the Tasks plugin global filter. Empty = none. |
| Extra tag | `ideashell` | Added to every imported to-do. Empty = none. |
| Import completed to-dos | off | Also add to-dos that are already completed. Tasks imported earlier are marked done either way. |
| Two-way completion | on | Mark to-dos complete in ideashell when you complete them in Obsidian or a task app such as TaskForge. |

## What is sent, and where

This plugin makes network requests **only** to the ideashell MCP endpoint you select in settings
(`https://api.ideashell.cn/ideashell/mcp` for China, `https://api.ideashell.com/ideashell/mcp` for Global, or a custom URL).
It sends the title, body, tags, folder name and embedded images of the notes **you choose to send**, authenticated with your API Key.
Importing reads your ideashell notes (`recent_notes`, `note_detail`) and to-dos (`todo_list`) and writes them into the vault; it uploads nothing. The only write to ideashell from an import is `todo_update` marking a to-do complete, and only when *Two-way completion* is on.
Nothing else in your vault is read or transmitted. There is no telemetry.

An ideashell account is required. The API Key grants the same permissions as your other MCP clients (Claude, Cursor, …); reset it in ideashell if it leaks.

## Limitations

- Notes are not merged both ways: an imported note is a rendered copy and is not sent back; a sent note is not refreshed from ideashell.
- Import with *Skip existing notes* on only lists notes created since the last import, so edits made in ideashell to older notes are not picked up — turn the setting off and run a full re-scan to refresh them (this overwrites local edits).
- Deleting a note in ideashell does not delete the imported file, and deleting the file does not delete the ideashell note.
- Images and audio files in ideashell notes are not downloaded; their transcripts and any text ideashell provides are.
- Image attachments are add-only: removing `![[photo.png]]` from the note does not remove the image in ideashell. Non-image attachments (PDF, audio, …) are not uploaded; the embed becomes `(file.pdf)` in the text.
- Renaming an Obsidian folder creates a new ideashell folder with the new name and moves the notes there; the old (now empty) ideashell folder is left for you to delete.
- Titles longer than 30 characters are truncated (ideashell limit).
- Deleting a note in Obsidian does not delete it in ideashell.
- `todo_list` returns at most 200 to-dos per call and has no paging. An import makes two calls (recent and undated, then every dated to-do) for open to-dos, and two more for completed ones when needed; if a call hits the limit, the summary says so.
- Imported to-dos are not moved when their date changes in ideashell; a task line stays in the daily note it was first written to.
- Recurring to-dos are not supported: the ideashell to-do tools expose no recurrence.
- Batch sync is sequential and paced under ideashell's rate limit (it waits and retries automatically on 429); very large first syncs take a while.

## Development

```bash
npm install
npm run dev     # watch build → main.js
npm run build   # type-check + production build
```

Copy `main.js`, `manifest.json`, `styles.css` into `<vault>/.obsidian/plugins/ideashell/` and reload Obsidian.

## License

MIT
