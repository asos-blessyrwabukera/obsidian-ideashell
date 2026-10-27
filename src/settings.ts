import { App, Notice, PluginSettingTab, Setting } from 'obsidian';
import type IdeashellPlugin from './main';
import type { TodoDateField, TodoSnapshot } from './todo-format';

export type Region = 'cn' | 'global' | 'custom';

export const REGION_ENDPOINTS: Record<Exclude<Region, 'custom'>, string> = {
	cn: 'https://api.ideashell.cn/ideashell/mcp',
	global: 'https://api.ideashell.com/ideashell/mcp',
};

export type ImportTimeRange = 'all' | '7' | '30' | '90' | '365';
export type ImportFrequency = 'manual' | 'startup' | '1m' | '15m' | '30m' | '60m' | '12h';

export const IMPORT_FREQUENCY_MS: Record<ImportFrequency, number | null> = {
	manual: null,
	startup: null,
	'1m': 60_000,
	'15m': 15 * 60_000,
	'30m': 30 * 60_000,
	'60m': 60 * 60_000,
	'12h': 12 * 60 * 60_000,
};

/** Bookkeeping for ideashell → Obsidian imports, persisted with the settings. */
export interface ImportState {
	/** Start of the last fully successful run (ISO); later runs only list notes created since. */
	lastRunAt: string | null;
	/** Time range in effect for `lastRunAt`; changing the range forces a full listing. */
	lastRunRange: ImportTimeRange | null;
	/** Notes deferred because a recording was still transcribing: id → first seen (ISO). */
	pending: Record<string, string>;
	/** Human-readable summary of the last run. */
	lastResult: string;
}

/** Bookkeeping for to-do imports, persisted with the settings. */
export interface TodoState {
	/** Values last written to the vault per todo_id; field-level merges and "deleted stays deleted" rely on it. */
	synced: Record<string, TodoSnapshot>;
	lastRunAt: string | null;
	lastResult: string;
}

export type TodoFormat = 'tasknotes' | 'inline';
export type TodoTarget = 'file' | 'daily';

export interface IdeashellSettings {
	region: Region;
	customEndpoint: string;
	accessKey: string;
	/** Tag added to every note sent from Obsidian (empty = none). */
	sourceTag: string;
	/** Map the Obsidian parent folder of a note to an ideashell folder. */
	mapFolders: boolean;
	/** Only Obsidian folders under these paths are synced by "Sync all"; empty = whole vault (marked notes only). */
	syncFolders: string[];
	/** Re-send previously synced notes automatically after they are modified. */
	autoSyncSynced: boolean;
	/** Debounce (seconds) for auto sync. */
	autoSyncDelay: number;
	/** Convert [[wikilinks]] to plain text (true) or leave as-is (false). */
	stripWikilinks: boolean;

	// --- import (ideashell → Obsidian) ---
	/** Vault folder for imported notes; supports `{date}` / `{date:FORMAT}`. */
	importFolder: string;
	/** File name pattern; supports `{date}`, `{date:FORMAT}`, `{title}`, `{id}`. */
	importFilenamePattern: string;
	importTemplatePath: string;
	importTimeRange: ImportTimeRange;
	importFrequency: ImportFrequency;
	/** Leave notes that already exist in the vault untouched (preserves local edits). */
	importSkipExisting: boolean;
	importTranscripts: boolean;
	importRibbon: boolean;
	importState: ImportState;

	// --- daily notes ---
	/** Link newly imported notes from the daily note of the day they were created. */
	dailyNotesEnabled: boolean;
	/** Daily notes folder; empty = the core Daily notes plugin's folder. */
	dailyNotesFolder: string;
	/** moment format of daily note names; empty = the core Daily notes plugin's format. */
	dailyNotesFormat: string;
	/** Heading the links go under (added when missing); empty = end of the note. */
	dailyNotesHeading: string;
	/** Line per note; supports {{time}}, {{link}}, {{title}}. */
	dailyNotesLine: string;
	/** Create the daily note when it does not exist yet. */
	dailyNotesCreate: boolean;

	// --- to-dos (ideashell → Obsidian tasks) ---
	/** Show the to-do import command and settings. */
	todosEnabled: boolean;
	/** Also import to-dos on the scheduled import. */
	todosAutoSync: boolean;
	/** One TaskNotes file per to-do, or one Tasks-format line per to-do. */
	todosFormat: TodoFormat;
	/** Folder for TaskNotes files. */
	todosFolder: string;
	/** Inline lines: a single file, or the daily note of the to-do's date. */
	todosTarget: TodoTarget;
	/** Inline lines: the single file, also used for undated to-dos in daily mode. */
	todosFile: string;
	/** Inline lines go under this heading (added when missing); empty = end of the note. */
	todosHeading: string;
	todosIncludeCompleted: boolean;
	/** Tag every task needs: the TaskNotes task tag or the Tasks global filter. Empty = none. */
	todosTaskTag: string;
	/** Extra tag on every imported to-do. Empty = none. */
	todosTag: string;
	/** Task field the to-do's date goes in. */
	todosDateField: TodoDateField;
	/** TaskNotes files: add the to-do's time to the date. */
	todosIncludeTime: boolean;
	todosOpenStatus: string;
	todosDoneStatus: string;
	/** Mark to-dos complete in ideashell when they are completed in Obsidian. */
	todosTwoWay: boolean;
	todoState: TodoState;
}

export const DEFAULT_SETTINGS: IdeashellSettings = {
	region: 'cn',
	customEndpoint: '',
	accessKey: '',
	sourceTag: 'obsidian',
	mapFolders: true,
	syncFolders: [],
	autoSyncSynced: false,
	autoSyncDelay: 10,
	stripWikilinks: true,
	importFolder: 'ideashell',
	importFilenamePattern: '{date} {title}',
	importTemplatePath: 'Templates/ideashell.md',
	importTimeRange: 'all',
	importFrequency: 'manual',
	importSkipExisting: true,
	importTranscripts: true,
	importRibbon: true,
	importState: { lastRunAt: null, lastRunRange: null, pending: {}, lastResult: '' },
	dailyNotesEnabled: false,
	dailyNotesFolder: '',
	dailyNotesFormat: '',
	dailyNotesHeading: '## ideashell',
	dailyNotesLine: '- {{time}} {{link}}',
	dailyNotesCreate: true,
	todosEnabled: false,
	todosAutoSync: false,
	todosFormat: 'tasknotes',
	todosFolder: '60 Tasks',
	todosTarget: 'file',
	todosFile: 'ideashell/Todos.md',
	todosHeading: '## ideashell',
	todosIncludeCompleted: false,
	todosTaskTag: 'task',
	todosTag: 'ideashell',
	todosDateField: 'scheduled',
	todosIncludeTime: true,
	todosOpenStatus: 'ready',
	todosDoneStatus: 'done',
	todosTwoWay: true,
	todoState: { synced: {}, lastRunAt: null, lastResult: '' },
};

export function resolveEndpoint(s: IdeashellSettings): string {
	if (s.region === 'custom') return s.customEndpoint.trim().replace(/\/+$/, '');
	return REGION_ENDPOINTS[s.region];
}

export class IdeashellSettingTab extends PluginSettingTab {
	constructor(app: App, private plugin: IdeashellPlugin) {
		super(app, plugin);
	}

	display(): void {
		this.render();
	}

	/** Redraw the tab; `display` itself is deprecated for direct calls. */
	private render(): void {
		const { containerEl } = this;
		containerEl.empty();
		const s = this.plugin.settings;

		new Setting(containerEl).setName('Connection').setHeading();

		new Setting(containerEl)
			.setName('Region')
			.setDesc('Choose the ideashell server that hosts your account.')
			.addDropdown((d) =>
				d
					.addOptions({ cn: 'China (ideashell.cn)', global: 'Global (ideashell.com)', custom: 'Custom endpoint' })
					.setValue(s.region)
					.onChange(async (v) => {
						s.region = v as Region;
						await this.plugin.saveSettings();
						this.render();
					}),
			);

		if (s.region === 'custom') {
			new Setting(containerEl)
				.setName('Custom endpoint')
				.setDesc('Full URL of your ideashell endpoint.')
				.addText((t) =>
					t.setPlaceholder('Endpoint URL').setValue(s.customEndpoint).onChange(async (v) => {
						s.customEndpoint = v;
						await this.plugin.saveSettings();
					}),
				);
		}

		new Setting(containerEl)
			.setName('API key')
			.setDesc('Your ideashell API key. Copy it from the ideashell app settings; it is the same key used for other AI clients.')
			.addText((t) => {
				t.inputEl.type = 'password';
				t.inputEl.addClass('ideashell-wide-input');
				t.setPlaceholder('32-character key').setValue(s.accessKey).onChange(async (v) => {
					s.accessKey = v.trim();
					this.plugin.resetClient();
					await this.plugin.saveSettings();
				});
			});

		new Setting(containerEl)
			.setName('Test connection')
			.setDesc('Verify the endpoint and API key.')
			.addButton((b) =>
				b.setButtonText('Test').onClick(async () => {
					b.setDisabled(true);
					try {
						await this.plugin.api.listFolders();
						new Notice('Connected to ideashell');
					} catch (e) {
						new Notice(`Connection failed: ${errorMessage(e)}`, 8000);
					} finally {
						b.setDisabled(false);
					}
				}),
			);

		new Setting(containerEl).setName('Send notes').setHeading();

		new Setting(containerEl)
			.setName('Source tag')
			.setDesc('Tag added to every note sent from Obsidian. Leave empty to disable.')
			.addText((t) =>
				t.setValue(s.sourceTag).onChange(async (v) => {
					s.sourceTag = v.trim().replace(/^#/, '');
					await this.plugin.saveSettings();
				}),
			);

		new Setting(containerEl)
			.setName('Map folders')
			.setDesc(
				'Put each note into an ideashell folder named after its Obsidian folder path. Notes in the vault root stay unfiled.',
			)
			.addToggle((t) =>
				t.setValue(s.mapFolders).onChange(async (v) => {
					s.mapFolders = v;
					await this.plugin.saveSettings();
				}),
			);

		new Setting(containerEl)
			.setName('Folders to sync')
			.setDesc(
				'One vault folder path per line. "Sync all" sends every note under these folders. Leave empty to only sync notes marked with `ideashell: true` in frontmatter.',
			)
			.addTextArea((t) => {
				t.inputEl.rows = 4;
				t.inputEl.addClass('ideashell-wide-input');
				t.setPlaceholder('One folder path per line').setValue(s.syncFolders.join('\n')).onChange(async (v) => {
					s.syncFolders = v
						.split('\n')
						.map((x) => x.trim().replace(/^\/+|\/+$/g, ''))
						.filter((x) => x.length > 0);
					await this.plugin.saveSettings();
				});
			});

		new Setting(containerEl)
			.setName('Auto-sync synced notes')
			.setDesc(
				'After a note has been sent once, automatically re-send it when you modify it. New notes are never sent automatically.',
			)
			.addToggle((t) =>
				t.setValue(s.autoSyncSynced).onChange(async (v) => {
					s.autoSyncSynced = v;
					await this.plugin.saveSettings();
				}),
			);

		new Setting(containerEl)
			.setName('Auto-sync delay (seconds)')
			.setDesc('Wait this long after the last edit before re-sending.')
			.addSlider((sl) =>
				sl
					.setLimits(3, 120, 1)
					.setValue(s.autoSyncDelay)
					.onChange(async (v) => {
						s.autoSyncDelay = v;
						await this.plugin.saveSettings();
					}),
			);

		new Setting(containerEl)
			.setName('Convert wikilinks to text')
			.setDesc('Replace wikilinks with their display text, since ideashell cannot resolve vault links.')
			.addToggle((t) =>
				t.setValue(s.stripWikilinks).onChange(async (v) => {
					s.stripWikilinks = v;
					await this.plugin.saveSettings();
				}),
			);

		this.displayImport(containerEl);
	}

	private displayImport(containerEl: HTMLElement): void {
		const s = this.plugin.settings;

		new Setting(containerEl)
			.setName('Import notes')
			.setDesc('Bring ideashell notes, summaries and voice transcripts into the vault as Markdown files.')
			.setHeading();

		new Setting(containerEl)
			.setName('Import now')
			.setDesc(s.importState.lastRunAt || s.importState.lastResult ? lastRunText(s) : 'Not imported yet.')
			.addButton((b) =>
				b
					.setButtonText('Import')
					.setCta()
					.onClick(async () => {
						b.setDisabled(true);
						await this.plugin.runImport({ manual: true });
						b.setDisabled(false);
						this.render();
					}),
			)
			.addButton((b) =>
				b
					.setButtonText('Full re-scan')
					.setTooltip('List every note in the time range again, not just new ones.')
					.onClick(async () => {
						b.setDisabled(true);
						await this.plugin.runImport({ manual: true, full: true });
						b.setDisabled(false);
						this.render();
					}),
			);

		new Setting(containerEl)
			.setName('Sync frequency')
			.setDesc('How often to import automatically.')
			.addDropdown((d) =>
				d
					.addOptions({
						manual: 'Manual only',
						startup: 'On startup',
						'1m': 'Every minute',
						'15m': 'Every 15 minutes',
						'30m': 'Every 30 minutes',
						'60m': 'Every hour',
						'12h': 'Every 12 hours',
					})
					.setValue(s.importFrequency)
					.onChange(async (v) => {
						s.importFrequency = v as ImportFrequency;
						await this.plugin.saveSettings();
						this.plugin.setupImportInterval();
					}),
			);

		new Setting(containerEl)
			.setName('Time range')
			.setDesc('Only import notes created within this period.')
			.addDropdown((d) =>
				d
					.addOptions({ all: 'All notes', '7': 'Last 7 days', '30': 'Last 30 days', '90': 'Last 90 days', '365': 'Last year' })
					.setValue(s.importTimeRange)
					.onChange(async (v) => {
						s.importTimeRange = v as ImportTimeRange;
						await this.plugin.saveSettings();
					}),
			);

		new Setting(containerEl)
			.setName('Folder')
			.setDesc('Vault folder for imported notes. Date tokens create subfolders, for example ideashell/{date:YYYY/MM}.')
			.addText((t) =>
				t
					.setPlaceholder('Folder path')
					.setValue(s.importFolder)
					.onChange(async (v) => {
						s.importFolder = v.trim();
						await this.plugin.saveSettings();
					}),
			);

		new Setting(containerEl)
			.setName('File name pattern')
			.setDesc('Supports {date}, {date:FORMAT}, {title} and {id}.')
			.addText((t) =>
				t
					.setPlaceholder('{date} {title}')
					.setValue(s.importFilenamePattern)
					.onChange(async (v) => {
						s.importFilenamePattern = v.trim();
						await this.plugin.saveSettings();
					}),
			);

		new Setting(containerEl)
			.setName('Template file')
			.setDesc('Markdown template for imported notes. A default template is created at this path if it does not exist.')
			.addText((t) =>
				t
					.setPlaceholder('Templates/ideashell.md')
					.setValue(s.importTemplatePath)
					.onChange(async (v) => {
						s.importTemplatePath = v.trim();
						await this.plugin.saveSettings();
					}),
			);

		new Setting(containerEl)
			.setName('Skip existing notes')
			.setDesc(
				'Leave notes that are already in the vault untouched so your edits are kept. Turn off to overwrite them with the latest version from ideashell on every import.',
			)
			.addToggle((t) =>
				t.setValue(s.importSkipExisting).onChange(async (v) => {
					s.importSkipExisting = v;
					await this.plugin.saveSettings();
				}),
			);

		new Setting(containerEl)
			.setName('Include transcripts')
			.setDesc('Add the transcribed text of voice memos and recordings to each note.')
			.addToggle((t) =>
				t.setValue(s.importTranscripts).onChange(async (v) => {
					s.importTranscripts = v;
					await this.plugin.saveSettings();
				}),
			);

		new Setting(containerEl)
			.setName('Show import ribbon icon')
			.addToggle((t) =>
				t.setValue(s.importRibbon).onChange(async (v) => {
					s.importRibbon = v;
					await this.plugin.saveSettings();
					this.plugin.updateImportRibbon();
				}),
			);

		this.displayDailyNotes(containerEl);
		this.displayTodos(containerEl);
	}

	private displayDailyNotes(containerEl: HTMLElement): void {
		const s = this.plugin.settings;

		new Setting(containerEl)
			.setName('Daily notes')
			.setDesc('Link imported notes from the daily note of the day they were created.')
			.setHeading();

		new Setting(containerEl)
			.setName('Link imported notes in daily notes')
			.setDesc('Applies to notes created by an import. For notes imported earlier, run the matching command from the command palette.')
			.addToggle((t) =>
				t.setValue(s.dailyNotesEnabled).onChange(async (v) => {
					s.dailyNotesEnabled = v;
					await this.plugin.saveSettings();
				}),
			);

		const core = this.plugin.dailyNoteConfig();
		new Setting(containerEl)
			.setName('Daily notes folder')
			.setDesc('Leave empty to use the folder from the core daily notes plugin.')
			.addText((t) =>
				t
					.setPlaceholder(core.folder || 'Vault root')
					.setValue(s.dailyNotesFolder)
					.onChange(async (v) => {
						s.dailyNotesFolder = v.trim();
						await this.plugin.saveSettings();
					}),
			);

		new Setting(containerEl)
			.setName('Daily note date format')
			.setDesc('Moment.js format of daily note names. Leave empty to use the core daily notes plugin format.')
			.addText((t) =>
				t
					.setPlaceholder(core.format)
					.setValue(s.dailyNotesFormat)
					.onChange(async (v) => {
						s.dailyNotesFormat = v.trim();
						await this.plugin.saveSettings();
					}),
			);

		new Setting(containerEl)
			.setName('Heading')
			.setDesc('Links are added at the end of this section; the heading is added if missing. Leave empty to append to the end of the note.')
			.addText((t) =>
				t
					.setPlaceholder('## ideashell')
					.setValue(s.dailyNotesHeading)
					.onChange(async (v) => {
						s.dailyNotesHeading = v.trim();
						await this.plugin.saveSettings();
					}),
			);

		new Setting(containerEl)
			.setName('Line format')
			.setDesc('One line per note. Supports {{time}}, {{link}} and {{title}}.')
			.addText((t) =>
				t
					.setPlaceholder('- {{time}} {{link}}')
					.setValue(s.dailyNotesLine)
					.onChange(async (v) => {
						s.dailyNotesLine = v;
						await this.plugin.saveSettings();
					}),
			);

		new Setting(containerEl)
			.setName('Create missing daily notes')
			.setDesc(
				'Create the daily note (from the core daily notes template, if set) when it does not exist. When off, notes from days without a daily note are not linked.',
			)
			.addToggle((t) =>
				t.setValue(s.dailyNotesCreate).onChange(async (v) => {
					s.dailyNotesCreate = v;
					await this.plugin.saveSettings();
				}),
			);
	}

	private displayTodos(containerEl: HTMLElement): void {
		const s = this.plugin.settings;
		const text = (name: string, desc: string, placeholder: string, get: () => string, set: (v: string) => void) =>
			new Setting(containerEl)
				.setName(name)
				.setDesc(desc)
				.addText((t) =>
					t
						.setPlaceholder(placeholder)
						.setValue(get())
						.onChange(async (v) => {
							set(v.trim());
							await this.plugin.saveSettings();
						}),
				);

		new Setting(containerEl)
			.setName('Import to-dos')
			.setDesc('Bring ideashell to-dos into the vault as tasks that task plugins can read.')
			.setHeading();

		new Setting(containerEl)
			.setName('Enable to-do import')
			.setDesc('Adds a command that imports to-dos from ideashell.')
			.addToggle((t) =>
				t.setValue(s.todosEnabled).onChange(async (v) => {
					s.todosEnabled = v;
					await this.plugin.saveSettings();
					this.render();
				}),
			);
		if (!s.todosEnabled) return;

		new Setting(containerEl)
			.setName('Import to-dos now')
			.setDesc(s.todoState.lastRunAt ? `Last run: ${new Date(s.todoState.lastRunAt).toLocaleString()}, ${s.todoState.lastResult}.` : 'Not imported yet.')
			.addButton((b) =>
				b
					.setButtonText('Import to-dos')
					.setCta()
					.onClick(async () => {
						b.setDisabled(true);
						await this.plugin.runTodoImport({ manual: true });
						b.setDisabled(false);
						this.render();
					}),
			);

		new Setting(containerEl)
			.setName('Include in scheduled import')
			.setDesc('Also import to-dos whenever notes are imported automatically (see sync frequency).')
			.addToggle((t) =>
				t.setValue(s.todosAutoSync).onChange(async (v) => {
					s.todosAutoSync = v;
					await this.plugin.saveSettings();
				}),
			);

		new Setting(containerEl)
			.setName('Task format')
			.setDesc('One task note per to-do, for the task notes plugin and task apps that read it, or one task line per to-do in the emoji format of the tasks plugin.')
			.addDropdown((d) =>
				d
					.addOptions({ tasknotes: 'TaskNotes file per to-do', inline: 'Task line (Tasks emoji format)' })
					.setValue(s.todosFormat)
					.onChange(async (v) => {
						s.todosFormat = v as TodoFormat;
						await this.plugin.saveSettings();
						this.render();
					}),
			);

		if (s.todosFormat === 'tasknotes') {
			text('Task folder', 'Folder for new task files. Files you move elsewhere, including archived tasks, are still updated.', '60 Tasks', () => s.todosFolder, (v) => (s.todosFolder = v));
			text('Open status', 'TaskNotes status for open to-dos.', 'ready', () => s.todosOpenStatus, (v) => (s.todosOpenStatus = v || 'ready'));
			text('Done status', 'TaskNotes status for completed to-dos.', 'done', () => s.todosDoneStatus, (v) => (s.todosDoneStatus = v || 'done'));
			new Setting(containerEl)
				.setName('Include time')
				.setDesc('Write the to-do time after the date, as the vault does for scheduled times.')
				.addToggle((t) =>
					t.setValue(s.todosIncludeTime).onChange(async (v) => {
						s.todosIncludeTime = v;
						await this.plugin.saveSettings();
					}),
				);
		} else {
			new Setting(containerEl)
				.setName('Target')
				.setDesc('One file for all to-dos, or the daily note of each to-do\'s date. Undated to-dos always go in the file.')
				.addDropdown((d) =>
					d
						.addOptions({ file: 'Single file', daily: 'Daily note of the to-do date' })
						.setValue(s.todosTarget)
						.onChange(async (v) => {
							s.todosTarget = v as TodoTarget;
							await this.plugin.saveSettings();
						}),
				);
			text('To-dos file', 'File for to-do lines.', 'ideashell/Todos.md', () => s.todosFile, (v) => (s.todosFile = v));
			text('Heading', 'New lines are added under this heading, which is created when missing. Leave empty to append to the end.', '## ideashell', () => s.todosHeading, (v) => (s.todosHeading = v));
		}

		new Setting(containerEl)
			.setName('Date field')
			.setDesc('Task field for the to-do date.')
			.addDropdown((d) =>
				d
					.addOptions({ due: 'Due', scheduled: 'Scheduled' })
					.setValue(s.todosDateField)
					.onChange(async (v) => {
						s.todosDateField = v as TodoDateField;
						await this.plugin.saveSettings();
					}),
			);

		text('Task tag', 'Tag every task needs: the TaskNotes task tag, or the Tasks plugin global filter. Leave empty for none.', 'task', () => s.todosTaskTag, (v) => (s.todosTaskTag = v.replace(/^#/, '')));
		text('Extra tag', 'Added to every imported to-do. Leave empty for none.', 'ideashell', () => s.todosTag, (v) => (s.todosTag = v.replace(/^#/, '')));

		new Setting(containerEl)
			.setName('Import completed to-dos')
			.setDesc('Also add to-dos that are already completed in ideashell. Tasks imported earlier are marked done either way.')
			.addToggle((t) =>
				t.setValue(s.todosIncludeCompleted).onChange(async (v) => {
					s.todosIncludeCompleted = v;
					await this.plugin.saveSettings();
				}),
			);

		new Setting(containerEl)
			.setName('Two-way completion')
			.setDesc(
				'When you complete an imported task in Obsidian or a task app that edits the vault, mark it complete in ideashell too. Nothing else is sent back. With this off, tasks you complete in Obsidian stay done, but ideashell is not changed.',
			)
			.addToggle((t) =>
				t.setValue(s.todosTwoWay).onChange(async (v) => {
					s.todosTwoWay = v;
					await this.plugin.saveSettings();
				}),
			);
	}
}

function lastRunText(s: IdeashellSettings): string {
	const when = s.importState.lastRunAt ? new Date(s.importState.lastRunAt).toLocaleString() : 'never';
	return `Last complete import: ${when}.${s.importState.lastResult ? ` Last run: ${s.importState.lastResult}.` : ''}`;
}

export function errorMessage(e: unknown): string {
	return e instanceof Error ? e.message : String(e);
}
