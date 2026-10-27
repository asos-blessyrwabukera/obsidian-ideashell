import { Editor, MarkdownView, Menu, Notice, Plugin, TAbstractFile, TFile, TFolder, debounce } from 'obsidian';
import { McpClient } from './mcp-client';
import { IdeashellApi } from './ideashell-api';
import { SyncService } from './sync';
import { DEFAULT_SETTINGS, IMPORT_FREQUENCY_MS, IdeashellSettingTab, IdeashellSettings, errorMessage, resolveEndpoint } from './settings';
import { FM_MARK } from './convert';
import { ImportService, summarize } from './import';
import { TodoService, summarizeTodos } from './todos';

/** Wait after the last edit to an imported task before syncing it to ideashell. */
const TODO_EDIT_DELAY_MS = 5000;

export default class IdeashellPlugin extends Plugin {
	settings: IdeashellSettings = DEFAULT_SETTINGS;
	api!: IdeashellApi;
	private client: McpClient | null = null;
	private sync!: SyncService;
	private statusEl: HTMLElement | null = null;
	private pendingAuto = new Map<string, number>();
	private importer!: ImportService;
	private todos!: TodoService;
	private pendingTodoPush = new Map<string, number>();
	private importIntervalId: number | null = null;
	private importRibbonEl: HTMLElement | null = null;
	/** Automatic imports report a failure once, not on every run, until one succeeds again. */
	private autoImportFailureShown = false;

	async onload(): Promise<void> {
		await this.loadSettings();
		this.api = new IdeashellApi(() => this.getClient());
		this.sync = new SyncService(this.app, this.api, () => this.settings);
		this.importer = new ImportService(this.app, this.api, () => this.settings, () => this.saveSettings());
		this.todos = new TodoService(this.app, this.api, () => this.settings, () => this.saveSettings(), this.importer.daily);
		this.addSettingTab(new IdeashellSettingTab(this.app, this));
		this.statusEl = this.addStatusBarItem();

		this.addRibbonIcon('shell', 'Sync current note to ideashell', () => void this.syncActive());

		this.addCommand({
			id: 'sync-current-note',
			name: 'Sync current note',
			checkCallback: (checking) => {
				const file = this.app.workspace.getActiveFile();
				if (!file || file.extension !== 'md') return false;
				if (!checking) void this.syncActive();
				return true;
			},
		});

		this.addCommand({
			id: 'send-selection',
			name: 'Send selection as a new note',
			editorCheckCallback: (checking, editor: Editor, view) => {
				const sel = editor.getSelection();
				if (!sel.trim()) return false;
				if (!checking) void this.sync.syncSelection(sel, view.file ?? null);
				return true;
			},
		});

		this.addCommand({
			id: 'mark-current-note',
			name: 'Mark current note for sync',
			checkCallback: (checking) => {
				const file = this.app.workspace.getActiveFile();
				if (!file || file.extension !== 'md') return false;
				if (!checking) {
					void this.app.fileManager.processFrontMatter(file, (fm: Record<string, unknown>) => {
						fm[FM_MARK] = true;
					});
					new Notice(`Marked "${file.basename}" for ideashell sync`);
				}
				return true;
			},
		});

		this.addCommand({
			id: 'import-notes',
			name: 'Import new notes',
			callback: () => void this.runImport({ manual: true }),
		});

		this.addCommand({
			id: 'import-all-notes',
			name: 'Import all notes (full re-scan)',
			callback: () => void this.runImport({ manual: true, full: true }),
		});

		this.addCommand({
			id: 'import-todos',
			name: 'Import to-dos',
			checkCallback: (checking) => {
				if (!this.settings.todosEnabled) return false;
				if (!checking) void this.runTodoImport({ manual: true });
				return true;
			},
		});

		this.addCommand({
			id: 'link-daily-notes',
			name: 'Link imported notes in daily notes',
			callback: () => void this.linkDailyNotes(),
		});

		this.updateImportRibbon();
		this.app.workspace.onLayoutReady(() => {
			if (this.settings.importFrequency !== 'manual') void this.runScheduled();
			this.setupImportInterval();
		});

		this.addCommand({
			id: 'sync-all',
			name: 'Sync all marked notes and sync folders',
			callback: () => void this.syncAll(),
		});

		// Right-click on one file or one folder in the explorer.
		this.registerEvent(
			this.app.workspace.on('file-menu', (menu: Menu, file) => {
				if (file instanceof TFile && file.extension === 'md') {
					menu.addItem((item) =>
						item
							.setTitle('Sync to ideashell')
							.setIcon('shell')
							.onClick(() => void this.sync.syncFile(file)),
					);
				} else if (file instanceof TFolder) {
					const notes = markdownFilesIn(file);
					if (notes.length === 0) return;
					menu.addItem((item) =>
						item
							.setTitle(`Sync folder to ideashell (${notes.length} notes)`)
							.setIcon('shell')
							.onClick(() => void this.syncBatch(notes, file.name)),
					);
				}
			}),
		);

		// Right-click with several files/folders selected in the explorer.
		this.registerEvent(
			this.app.workspace.on('files-menu', (menu: Menu, files: TAbstractFile[]) => {
				const notes = dedupeFiles(files.flatMap((f) => (f instanceof TFolder ? markdownFilesIn(f) : f instanceof TFile && f.extension === 'md' ? [f] : [])));
				if (notes.length === 0) return;
				menu.addItem((item) =>
					item
						.setTitle(`Sync ${notes.length} notes to ideashell`)
						.setIcon('shell')
						.onClick(() => void this.syncBatch(notes, `${notes.length} notes`)),
				);
			}),
		);

		this.registerEvent(
			this.app.workspace.on('editor-menu', (menu: Menu, editor: Editor, view) => {
				if (!editor.getSelection().trim()) return;
				menu.addItem((item) =>
					item
						.setTitle('Send selection to ideashell')
						.setIcon('shell')
						.onClick(() => void this.sync.syncSelection(editor.getSelection(), view.file ?? null)),
				);
			}),
		);

		// Auto re-sync: only notes that were synced before, only when enabled, debounced per file.
		this.registerEvent(
			this.app.vault.on('modify', (file) => {
				if (!this.settings.autoSyncSynced) return;
				if (!(file instanceof TFile) || file.extension !== 'md') return;
				if (!this.sync.isSynced(file)) return;
				this.scheduleAutoSync(file);
			}),
		);

		// Two-way sync: after an imported task is edited, sync to-dos once the edit settles. The
		// sync fetches ideashell first, so ideashell still wins when both sides changed.
		this.registerEvent(
			this.app.metadataCache.on('changed', (file) => {
				if (!this.settings.todosEnabled || !this.settings.todosTwoWay) return;
				const prev = this.pendingTodoPush.get(file.path);
				if (prev) window.clearTimeout(prev);
				this.pendingTodoPush.set(
					file.path,
					window.setTimeout(() => {
						this.pendingTodoPush.delete(file.path);
						void this.syncEditedTodos(file);
					}, TODO_EDIT_DELAY_MS),
				);
			}),
		);

		this.registerEvent(
			this.app.workspace.on('active-leaf-change', () => this.refreshStatus()),
		);
		this.registerEvent(this.app.metadataCache.on('changed', (file) => {
			if (file === this.app.workspace.getActiveFile()) this.refreshStatus();
		}));
		this.refreshStatus();
	}

	onunload(): void {
		for (const t of this.pendingAuto.values()) window.clearTimeout(t);
		this.pendingAuto.clear();
		for (const t of this.pendingTodoPush.values()) window.clearTimeout(t);
		this.pendingTodoPush.clear();
		this.clearImportInterval();
	}

	/** Write the default template when the plugin is first enabled, so it can be customised before the first import. */
	onUserEnable(): void {
		void this.importer.loadTemplate(this.settings.importTemplatePath).catch((e: unknown) => {
			console.error('[ideashell] failed to create the default template', e);
		});
	}

	// --- import (ideashell → Obsidian) ---

	async runImport(opts: { manual: boolean; full?: boolean }): Promise<void> {
		if (this.importer.isRunning) {
			if (opts.manual) new Notice('An ideashell import is already running');
			return;
		}
		if (!this.settings.accessKey) {
			if (opts.manual) new Notice('Add your ideashell API key in settings first');
			return;
		}
		const notice = opts.manual ? new Notice('Importing from ideashell…', 0) : null;
		try {
			const result = await this.importer.run({
				full: opts.full,
				onProgress: (m) => notice?.setMessage(`ideashell: ${m}`),
			});
			notice?.hide();
			if (!result) return;
			const reason = result.failed > 0 && result.lastError ? ` — ${result.lastError}` : '';
			const showFailure = result.failed > 0 && !this.autoImportFailureShown;
			if (opts.manual || result.created > 0 || showFailure) {
				new Notice(`ideashell import: ${summarize(result)}${reason}`, result.failed > 0 ? 12000 : 8000);
			}
			if (!opts.manual) this.autoImportFailureShown = result.failed > 0;
		} catch (e) {
			notice?.hide();
			console.error('[ideashell] import failed', e);
			if (opts.manual || !this.autoImportFailureShown) new Notice(`ideashell import failed: ${errorMessage(e)}`, 12000);
			if (!opts.manual) this.autoImportFailureShown = true;
		}
	}

	/** Scheduled run: notes, then to-dos when they are part of the schedule. */
	private async runScheduled(): Promise<void> {
		await this.runImport({ manual: false });
		if (this.settings.todosEnabled && this.settings.todosAutoSync) await this.runTodoImport({ manual: false });
	}

	private async syncEditedTodos(file: TFile): Promise<void> {
		if (this.todos.isRunning || !(await this.todos.hasLocalEdits(file))) return;
		await this.runTodoImport({ manual: false });
	}

	async runTodoImport(opts: { manual: boolean }): Promise<void> {
		if (this.todos.isRunning) {
			if (opts.manual) new Notice('An ideashell to-do import is already running');
			return;
		}
		if (!this.settings.accessKey) {
			if (opts.manual) new Notice('Add your ideashell API key in settings first');
			return;
		}
		const notice = opts.manual ? new Notice('Importing to-dos from ideashell…', 0) : null;
		try {
			const result = await this.todos.run((m) => notice?.setMessage(`ideashell: ${m}`));
			notice?.hide();
			if (!result) return;
			const reason = result.failed > 0 && result.lastError ? ` — ${result.lastError}` : '';
			if (opts.manual || result.created > 0 || result.failed > 0) {
				new Notice(`ideashell to-dos: ${summarizeTodos(result)}${reason}`, result.failed > 0 ? 12000 : 8000);
			}
		} catch (e) {
			notice?.hide();
			console.error('[ideashell] to-do import failed', e);
			if (opts.manual) new Notice(`ideashell to-do import failed: ${errorMessage(e)}`, 12000);
		}
	}

	/** Effective daily note folder / format (plugin settings, else the core Daily notes plugin). */
	dailyNoteConfig(): { folder: string; format: string } {
		return this.importer.daily.config();
	}

	private async linkDailyNotes(): Promise<void> {
		if (this.importer.isRunning) {
			new Notice('An import is already running. Try again when it finishes.');
			return;
		}
		const notice = new Notice('Linking imported notes in daily notes…', 0);
		try {
			const r = await this.importer.linkAllInDailyNotes();
			notice.hide();
			if (!r) {
				new Notice('An import is already running. Try again when it finishes.');
				return;
			}
			const undated = r.undated > 0 ? ` ${r.undated} imported notes have no created/date frontmatter and were skipped.` : '';
			const failed = r.errors.length > 0 ? ` ${r.errors.length} daily notes could not be updated (first: ${r.errors[0]}).` : '';
			new Notice(`Added ${r.linked} links to daily notes (${r.notes} imported notes checked).${undated}${failed}`, r.errors.length > 0 ? 15000 : 8000);
		} catch (e) {
			notice.hide();
			console.error('[ideashell] daily note linking failed', e);
			new Notice(`Linking daily notes failed: ${errorMessage(e)}`, 12000);
		}
	}

	setupImportInterval(): void {
		this.clearImportInterval();
		const ms = IMPORT_FREQUENCY_MS[this.settings.importFrequency];
		if (!ms) return;
		this.importIntervalId = window.setInterval(() => void this.runScheduled(), ms);
		this.registerInterval(this.importIntervalId);
	}

	private clearImportInterval(): void {
		if (this.importIntervalId !== null) {
			window.clearInterval(this.importIntervalId);
			this.importIntervalId = null;
		}
	}

	updateImportRibbon(): void {
		if (this.settings.importRibbon && !this.importRibbonEl) {
			this.importRibbonEl = this.addRibbonIcon('download', 'Import notes from ideashell', () => void this.runImport({ manual: true }));
		} else if (!this.settings.importRibbon && this.importRibbonEl) {
			this.importRibbonEl.remove();
			this.importRibbonEl = null;
		}
	}

	// --- helpers ---

	getClient(): McpClient {
		if (!this.client) {
			this.client = new McpClient(resolveEndpoint(this.settings), this.settings.accessKey, this.manifest.version);
		}
		return this.client;
	}

	resetClient(): void {
		this.client = null;
		this.sync?.invalidateFolders();
	}

	private async syncActive(): Promise<void> {
		const view = this.app.workspace.getActiveViewOfType(MarkdownView);
		const file = this.app.workspace.getActiveFile();
		if (!file || file.extension !== 'md') {
			new Notice('Open a Markdown note first');
			return;
		}
		// flush unsaved editor content so we read what the user sees
		if (view?.file === file) await view.save();
		await this.sync.syncFile(file);
		this.refreshStatus();
	}

	private async syncAll(): Promise<void> {
		const files = this.sync.collectSyncTargets();
		if (files.length === 0) {
			new Notice('Nothing to sync. Mark notes with `ideashell: true` or configure sync folders.');
			return;
		}
		await this.syncBatch(files, 'marked notes');
	}

	private async syncBatch(files: TFile[], label: string): Promise<void> {
		const notice = new Notice(`Syncing ${label} 0/${files.length}…`, 0);
		const counts = await this.sync.syncMany(files, (done, total) =>
			notice.setMessage(`Syncing ${label} ${done}/${total}…`),
		);
		notice.hide();
		const reason = counts.failed > 0 && this.sync.lastError ? ` — ${this.sync.lastError}` : '';
		new Notice(
			`Synced: ${counts.created} created, ${counts.updated} updated, ${counts.unchanged} unchanged, ${counts.failed} failed${reason}`,
			counts.failed > 0 ? 12000 : 8000,
		);
		this.refreshStatus();
	}

	private scheduleAutoSync(file: TFile): void {
		const prev = this.pendingAuto.get(file.path);
		if (prev) window.clearTimeout(prev);
		this.pendingAuto.set(
			file.path,
			window.setTimeout(() => {
				this.pendingAuto.delete(file.path);
				void this.sync.syncFile(file, { silent: true }).then((r) => {
					if (r === 'updated') new Notice(`Updated "${file.basename}" in ideashell`, 2000);
					this.refreshStatus();
				});
			}, this.settings.autoSyncDelay * 1000),
		);
	}

	private refreshStatus = debounce(() => {
		if (!this.statusEl) return;
		const file = this.app.workspace.getActiveFile();
		if (!file || file.extension !== 'md') {
			this.statusEl.setText('');
			return;
		}
		this.statusEl.setText(this.sync.isSynced(file) ? 'ideashell ✓' : '');
	}, 200, true);

	async loadSettings(): Promise<void> {
		const data = ((await this.loadData()) ?? {}) as Partial<IdeashellSettings>;
		this.settings = Object.assign({}, DEFAULT_SETTINGS, data);
		// nested object: copy so runs never mutate the defaults
		this.settings.importState = {
			...DEFAULT_SETTINGS.importState,
			...data.importState,
			pending: { ...data.importState?.pending },
		};
		this.settings.todoState = {
			...DEFAULT_SETTINGS.todoState,
			...data.todoState,
			synced: { ...data.todoState?.synced },
		};
	}

	async saveSettings(): Promise<void> {
		await this.saveData(this.settings);
	}
}

/** All markdown notes under a folder, recursively, in explorer order. */
function markdownFilesIn(folder: TFolder): TFile[] {
	const out: TFile[] = [];
	const walk = (f: TFolder) => {
		for (const child of f.children) {
			if (child instanceof TFolder) walk(child);
			else if (child instanceof TFile && child.extension === 'md') out.push(child);
		}
	};
	walk(folder);
	return out;
}

function dedupeFiles(files: TFile[]): TFile[] {
	const seen = new Set<string>();
	return files.filter((f) => (seen.has(f.path) ? false : (seen.add(f.path), true)));
}
