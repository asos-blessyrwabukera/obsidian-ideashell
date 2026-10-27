import { App, TFile, TFolder, normalizePath } from 'obsidian';
import type { IdeashellApi } from './ideashell-api';
import { ListedNote, NoteDetail, parseNoteDetail, parseRecentNotes } from './parse';
import { DEFAULT_TEMPLATE, IMPORT_ID_KEY, applyTemplate, buildVariables, ensureImportId, folderBase, parseCreated, resolveNotePath } from './template';
import { FM_HASH } from './convert';
import type { IdeashellSettings, ImportTimeRange } from './settings';
import { errorMessage } from './settings';
import { DailyEntry, DailyNoteLinker } from './daily-notes';
import { isImported } from './sync';
import { FM_TODO_ID } from './todo-format';

/** Notes per `recent_notes` page. */
const PAGE_SIZE = 20;
/** Upper bound on notes listed in one run, as a guard against a pagination loop. */
const MAX_NOTES = 20_000;
/** Incremental runs re-list a little before the last run to cover clock skew and late writes. */
const OVERLAP_MS = 10 * 60 * 1000;
/** Notes still transcribing are re-checked on later runs for this long. */
const PENDING_TTL_MS = 3 * 24 * 60 * 60 * 1000;
/** "All time" lower bound passed to the server. */
const EPOCH = '2000-01-01T00:00:00.000Z';
const PACE_MS = 250;

export interface ImportResult {
	created: number;
	updated: number;
	unchanged: number;
	skipped: number;
	pending: number;
	failed: number;
	/** Links added to daily notes. */
	linked: number;
	lastError: string | null;
}

export interface ImportOptions {
	/** Ignore the incremental window and list the whole time range. */
	full?: boolean;
	onProgress?: (message: string) => void;
}

const RANGE_DAYS: Record<ImportTimeRange, number | null> = { all: null, '7': 7, '30': 30, '90': 90, '365': 365 };

/** Kind of vault file already holding an ideashell note. */
interface Existing {
	file: TFile;
	/** Created by sending an Obsidian note to ideashell — never overwritten by import. */
	sent: boolean;
}

/**
 * ideashell → Obsidian import. Each ideashell note becomes one Markdown file rendered from a
 * template; `ideashell_id` in frontmatter is the dedupe key, looked up anywhere in the vault so
 * moved or renamed notes are updated rather than duplicated.
 */
export class ImportService {
	private running = false;
	private ensuredFolders = new Set<string>();
	readonly daily: DailyNoteLinker;

	constructor(
		private app: App,
		private api: IdeashellApi,
		private settings: () => IdeashellSettings,
		private save: () => Promise<void>,
	) {
		this.daily = new DailyNoteLinker(app, settings);
	}

	get isRunning(): boolean {
		return this.running;
	}

	async run(opts: ImportOptions = {}): Promise<ImportResult | null> {
		if (this.running) return null;
		this.running = true;
		this.ensuredFolders.clear();
		try {
			return await this.doRun(opts);
		} finally {
			this.running = false;
		}
	}

	private async doRun(opts: ImportOptions): Promise<ImportResult> {
		const s = this.settings();
		const state = s.importState;
		const result: ImportResult = { created: 0, updated: 0, unchanged: 0, skipped: 0, pending: 0, failed: 0, linked: 0, lastError: null };
		const startedAt = new Date();

		const template = await this.loadTemplate(s.importTemplatePath);
		const folderPattern = normalizePath(s.importFolder.trim() || '/');
		await this.ensureFolder(folderBase(folderPattern));
		await this.waitForMetadata();
		const existing = this.indexVault(folderBase(folderPattern));

		// Listing window: the configured range, narrowed to "since the last run" when existing
		// notes are skipped anyway (overwrite mode needs the whole range to pick up edits).
		const rangeDays = RANGE_DAYS[s.importTimeRange] ?? null;
		let start = rangeDays === null ? EPOCH : new Date(startedAt.getTime() - rangeDays * 86_400_000).toISOString();
		const incremental =
			!opts.full && s.importSkipExisting && state.lastRunAt !== null && state.lastRunRange === s.importTimeRange;
		if (incremental && state.lastRunAt) {
			const since = new Date(Date.parse(state.lastRunAt) - OVERLAP_MS).toISOString();
			if (since > start) start = since;
		}

		opts.onProgress?.('Listing notes…');
		const listed = await this.listNotes(start, opts.onProgress);

		// Notes deferred on earlier runs because a recording was still transcribing.
		const now = startedAt.getTime();
		const pending = { ...state.pending };
		/** Pending ids the listing did not return this time; they may have been deleted in ideashell. */
		const pendingOnly = new Set<string>();
		for (const [id, since] of Object.entries(pending)) {
			if (now - Date.parse(since) > PENDING_TTL_MS) delete pending[id];
			else if (!listed.some((n) => n.id === id)) {
				listed.push({ id, title: '', created: '' });
				pendingOnly.add(id);
			}
		}

		const todo = listed.filter((n) => {
			const hit = existing.get(n.id);
			if (!hit) return true;
			if (hit.sent || s.importSkipExisting) {
				result.skipped++;
				delete pending[n.id];
				return false;
			}
			return true;
		});

		const createdNotes: DailyEntry[] = [];
		let done = 0;
		for (const listedNote of todo) {
			opts.onProgress?.(`Importing ${++done}/${todo.length}…`);
			try {
				const detail = parseNoteDetail(await this.api.noteDetail(listedNote.id), listedNote);
				if (pendingOnly.has(listedNote.id) && !detail.title && !detail.body && detail.transcripts.length === 0) {
					// nothing usable came back (note deleted?) — stop re-checking it
					delete pending[listedNote.id];
					continue;
				}
				if (detail.transcribing) {
					pending[listedNote.id] ??= startedAt.toISOString();
					result.pending++;
					continue;
				}
				delete pending[listedNote.id];
				const { outcome, file } = await this.writeNote(detail, template, folderPattern, existing);
				result[outcome]++;
				if (outcome === 'created') createdNotes.push({ file, title: detail.title, created: parseCreated(detail.created) });
			} catch (e) {
				if (pendingOnly.has(listedNote.id)) {
					// a deferred note that can no longer be read was most likely deleted in ideashell;
					// drop it rather than failing every run until it expires
					delete pending[listedNote.id];
					console.warn('[ideashell] dropping deferred note that can no longer be read', listedNote.id, e);
					continue;
				}
				result.failed++;
				result.lastError = errorMessage(e);
				console.error('[ideashell] import failed', listedNote.id, e);
			}
			await sleep(PACE_MS);
		}

		if (s.dailyNotesEnabled && createdNotes.length > 0) {
			opts.onProgress?.('Linking daily notes…');
			try {
				const r = await this.daily.link(createdNotes);
				result.linked = r.added;
				if (r.errors.length > 0) result.lastError = `daily notes: ${r.errors[0]}`;
			} catch (e) {
				// the notes themselves are imported; "Link imported notes in daily notes" can redo this
				result.lastError = `daily notes: ${errorMessage(e)}`;
				console.error('[ideashell] daily note linking failed', e);
			}
		}

		state.pending = pending;
		// Advance the incremental window only when every note was handled; otherwise the next
		// run lists the same range again and retries the failures.
		if (result.failed === 0) {
			state.lastRunAt = startedAt.toISOString();
			state.lastRunRange = s.importTimeRange;
		}
		state.lastResult = summarize(result);
		await this.save();
		return result;
	}

	/** Page through `recent_notes` (newest first) from now back to `start`. */
	private async listNotes(start: string, onProgress?: (m: string) => void): Promise<ListedNote[]> {
		const out: ListedNote[] = [];
		const seen = new Set<string>();
		let end: string | undefined;
		while (out.length < MAX_NOTES) {
			const page = parseRecentNotes(await this.api.recentNotes({ limit: PAGE_SIZE, startTime: start, endTime: end }));
			let added = 0;
			for (const n of page) {
				if (seen.has(n.id)) continue;
				seen.add(n.id);
				out.push(n);
				added++;
			}
			onProgress?.(`Listing notes… ${out.length}`);
			if (page.length < PAGE_SIZE || added === 0) break;
			// Next page ends at the oldest creation time seen so far (inclusive; repeats are deduped).
			const oldest = page
				.map((n) => parseCreated(n.created))
				.filter((m) => m.isValid())
				.reduce<number | null>((min, m) => (min === null || m.valueOf() < min ? m.valueOf() : min), null);
			if (oldest === null) break;
			const next = new Date(oldest).toISOString();
			if (next === end) break;
			end = next;
			await sleep(PACE_MS);
		}
		return out;
	}

	private async writeNote(
		note: NoteDetail,
		template: string,
		folderPattern: string,
		existing: Map<string, Existing>,
	): Promise<{ outcome: 'created' | 'updated' | 'unchanged'; file: TFile }> {
		const s = this.settings();
		const content = ensureImportId(applyTemplate(template, buildVariables(note, s.importTranscripts)), note.id);
		const hit = existing.get(note.id);
		if (hit) {
			if ((await this.app.vault.read(hit.file)) === content) return { outcome: 'unchanged', file: hit.file };
			await this.app.vault.modify(hit.file, content);
			return { outcome: 'updated', file: hit.file };
		}
		const { folder, path } = resolveNotePath(folderPattern, s.importFilenamePattern || '{date} {title}', note);
		await this.ensureFolder(folder);
		const file = await this.app.vault.create(this.freePath(path, note.id), content);
		existing.set(note.id, { file, sent: false });
		return { outcome: 'created', file };
	}

	/**
	 * Link every imported note in the vault from its daily note (backfill). The creation time is
	 * read from the note's `created` frontmatter, falling back to `date`.
	 */
	/** Backfill daily-note links for every imported note. Returns null when an import is running. */
	async linkAllInDailyNotes(): Promise<{ linked: number; notes: number; undated: number; errors: string[] } | null> {
		if (this.running) return null;
		this.running = true;
		try {
			return await this.collectAndLink();
		} finally {
			this.running = false;
		}
	}

	private async collectAndLink(): Promise<{ linked: number; notes: number; undated: number; errors: string[] }> {
		await this.waitForMetadata();
		const entries: DailyEntry[] = [];
		let undated = 0;
		const templatePath = normalizePath(this.settings().importTemplatePath.trim() || 'Templates/ideashell.md');
		for (const file of this.app.vault.getMarkdownFiles()) {
			if (file.path === templatePath) continue;
			const fm = this.app.metadataCache.getFileCache(file)?.frontmatter;
			// to-dos are tasks, not notes; they are not linked from daily notes
			if (!isImported(fm) || fm?.[FM_TODO_ID]) continue;
			const raw: unknown = fm?.created ?? fm?.date;
			const created = typeof raw === 'string' ? parseCreated(raw) : null;
			if (!created?.isValid()) {
				undated++;
				continue;
			}
			const title: unknown = fm?.title;
			entries.push({ file, title: typeof title === 'string' ? title : file.basename, created });
		}
		const r = await this.daily.link(entries);
		return { linked: r.added, notes: entries.length, undated, errors: r.errors };
	}

	/** `path`, or a variant with the short id / a counter when another file already uses it. */
	private freePath(path: string, id: string): string {
		if (!this.app.vault.getAbstractFileByPath(path)) return path;
		const base = path.replace(/\.md$/, '');
		const withId = `${base} ${id.slice(0, 8)}.md`;
		if (!this.app.vault.getAbstractFileByPath(withId)) return withId;
		for (let i = 2; ; i++) {
			const p = `${base} ${id.slice(0, 8)} ${i}.md`;
			if (!this.app.vault.getAbstractFileByPath(p)) return p;
		}
	}

	/** Map of ideashell id → file across the whole vault, preferring files under the import folder. */
	private indexVault(baseFolder: string): Map<string, Existing> {
		const prefix = baseFolder === '/' ? '' : `${baseFolder}/`;
		const files = this.app.vault.getMarkdownFiles();
		const ordered = prefix ? [...files.filter((f) => f.path.startsWith(prefix)), ...files.filter((f) => !f.path.startsWith(prefix))] : files;
		const map = new Map<string, Existing>();
		for (const file of ordered) {
			const fm = this.app.metadataCache.getFileCache(file)?.frontmatter;
			const raw: unknown = fm?.[IMPORT_ID_KEY];
			const id = typeof raw === 'string' ? raw.trim() : typeof raw === 'number' ? String(raw) : '';
			if (!id || map.has(id)) continue;
			map.set(id, { file, sent: fm?.[FM_HASH] !== undefined });
		}
		return map;
	}

	/** Template file contents; the default template is written to the path when it is missing. */
	async loadTemplate(templatePath: string): Promise<string> {
		const path = normalizePath(templatePath.trim() || 'Templates/ideashell.md');
		const file = this.app.vault.getAbstractFileByPath(path);
		if (file instanceof TFile) return this.app.vault.read(file);
		const slash = path.lastIndexOf('/');
		if (slash > 0) await this.ensureFolder(path.slice(0, slash));
		await this.app.vault.create(path, DEFAULT_TEMPLATE);
		return DEFAULT_TEMPLATE;
	}

	/** Create `folderPath` and any missing parents. */
	private async ensureFolder(folderPath: string): Promise<void> {
		const norm = normalizePath(folderPath);
		if (norm === '/' || this.ensuredFolders.has(norm)) return;
		let current = '';
		for (const part of norm.split('/').filter(Boolean)) {
			current = current ? `${current}/${part}` : part;
			const f = this.app.vault.getAbstractFileByPath(current);
			if (!f) await this.app.vault.createFolder(current);
			else if (!(f instanceof TFolder)) throw new Error(`"${current}" exists and is not a folder`);
		}
		this.ensuredFolders.add(norm);
	}

	/**
	 * Frontmatter must be indexed before scanning for ids, or a startup run would create
	 * duplicates. `resolved` is not in the public typings, so it is only trusted when present,
	 * and the wait is capped so a missed event cannot stall imports forever.
	 */
	private waitForMetadata(): Promise<void> {
		const cache = this.app.metadataCache as typeof this.app.metadataCache & { resolved?: boolean };
		if (cache.resolved !== false) return Promise.resolve();
		return new Promise((resolve) => {
			const done = () => {
				this.app.metadataCache.offref(ref);
				window.clearTimeout(timer);
				resolve();
			};
			const ref = this.app.metadataCache.on('resolved', done);
			const timer = window.setTimeout(done, 30_000);
		});
	}
}

export function summarize(r: ImportResult): string {
	const parts = [`${r.created} created`, `${r.updated} updated`, `${r.unchanged} unchanged`, `${r.skipped} skipped`];
	if (r.pending > 0) parts.push(`${r.pending} still transcribing`);
	if (r.failed > 0) parts.push(`${r.failed} failed`);
	if (r.linked > 0) parts.push(`${r.linked} linked in daily notes`);
	return parts.join(', ');
}

function sleep(ms: number): Promise<void> {
	return new Promise((r) => window.setTimeout(r, ms));
}
