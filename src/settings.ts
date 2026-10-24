import { App, Notice, PluginSettingTab, Setting } from 'obsidian';
import type IdeashellPlugin from './main';

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
						this.display();
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
						this.display();
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
						this.display();
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
	}
}

function lastRunText(s: IdeashellSettings): string {
	const when = s.importState.lastRunAt ? new Date(s.importState.lastRunAt).toLocaleString() : 'never';
	return `Last complete import: ${when}.${s.importState.lastResult ? ` Last run: ${s.importState.lastResult}.` : ''}`;
}

export function errorMessage(e: unknown): string {
	return e instanceof Error ? e.message : String(e);
}
