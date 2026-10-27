import { App, TFile, TFolder, moment, normalizePath, stringifyYaml } from 'obsidian';
import { IdeashellApi, TODO_LIST_MAX, TodoUpdate } from './ideashell-api';
import { Todo, parseTodos } from './parse';
import {
	BLOCK_PREFIX,
	FM_TODO_ID,
	TodoFields,
	TodoSnapshot,
	escapeTodoText,
	isSafeTodoId,
	normalizeTags,
	parseInlineTask,
	plainTodoText,
	readInlineTask,
	reconcileTodo,
	renderInlineTask,
	snapshotOf,
	taskNotesDate,
} from './todo-format';
import { sanitizeFilename } from './template';
import type { IdeashellSettings } from './settings';
import { errorMessage } from './settings';
import { DailyNoteLinker, insertUnderHeading } from './daily-notes';

/** Every dated to-do; `todo_list` drops undated ones when `date_from` is set. */
const ALL_DATES_FROM = '2000-01-01';
/** File names longer than this are cut by `sanitizeFilename`; the full text then goes in the body. */
const MAX_TITLE = 100;
const EMPTY_TITLE = 'ideashell to-do';

export interface TodoResult {
	created: number;
	updated: number;
	unchanged: number;
	/** Not written: completed and completed to-dos are off, deleted from the vault, or an unusable id. */
	skipped: number;
	/** To-dos updated in ideashell from vault edits (two-way sync). */
	pushed: number;
	failed: number;
	lastError: string | null;
	/** A `todo_list` call hit its item limit, so some to-dos may be missing. */
	truncated: boolean;
}

function emptyResult(): TodoResult {
	return { created: 0, updated: 0, unchanged: 0, skipped: 0, pushed: 0, failed: 0, lastError: null, truncated: false };
}

/** Where an imported to-do lives in the vault. */
interface Located {
	kind: 'tasknotes' | 'inline';
	file: TFile;
}

/** A change to one inline file, applied in a single `vault.process`. */
interface InlineEdit {
	updates: Map<string, Todo>;
	inserts: { heading: string; todos: Todo[] };
}

/**
 * ideashell to-dos ⇄ vault tasks. Each to-do becomes a TaskNotes file (`ideashell_todo_id` in
 * frontmatter) or an inline Tasks-format line (`^ideashell-<id>` block id). The values last
 * synced are kept in plugin data, so each run knows which side changed a field: ideashell's
 * changes are written to the vault, and with two-way sync the vault's changes to the text, date,
 * time and completion are sent to ideashell. When both changed a field, ideashell wins.
 */
export class TodoService {
	private running = false;

	constructor(
		private app: App,
		private api: IdeashellApi,
		private settings: () => IdeashellSettings,
		private save: () => Promise<void>,
		private daily: DailyNoteLinker,
	) {}

	get isRunning(): boolean {
		return this.running;
	}

	async run(onProgress?: (m: string) => void): Promise<TodoResult | null> {
		if (this.running) return null;
		this.running = true;
		try {
			return await this.doRun(onProgress);
		} finally {
			this.running = false;
		}
	}

	private async doRun(onProgress?: (m: string) => void): Promise<TodoResult> {
		const s = this.settings();
		const state = s.todoState;
		const result = emptyResult();
		const tz = localTimezone();

		onProgress?.('Listing to-dos…');
		const open = await this.list(false, tz, result);
		// Completed to-dos drop out of the open list, so fetch them when importing them or when a
		// task already in the vault is not open in ideashell (completed there, or completed and
		// then reopened in the vault).
		const openIds = new Set(open.map((t) => t.id));
		const needCompleted = s.todosIncludeCompleted || Object.keys(state.synced).some((id) => !openIds.has(id));
		const completed = needCompleted ? await this.list(true, tz, result) : [];
		const todos = [...open, ...completed.filter((t) => !openIds.has(t.id))];

		const located = this.locate();
		const inlineEdits = new Map<string, InlineEdit>();
		const pushes = new Map<string, TodoFields>();
		const today = moment().format('YYYY-MM-DD');

		let done = 0;
		for (const t of todos) {
			onProgress?.(`Importing to-dos ${++done}/${todos.length}…`);
			if (!isSafeTodoId(t.id)) {
				result.skipped++;
				console.warn('[ideashell] skipping to-do with an unexpected id', t.id);
				continue;
			}
			const prev = state.synced[t.id];
			const hit = located.get(t.id);
			try {
				if (!hit) {
					// deleted from the vault after an earlier import: leave it deleted
					if (prev || (t.completed && !s.todosIncludeCompleted)) {
						result.skipped++;
						continue;
					}
					if (s.todosFormat === 'tasknotes') {
						await this.createTaskNote(t, today);
						state.synced[t.id] = snapshotOf(t);
						result.created++;
					} else {
						const target = await this.inlineTarget(t);
						const edit = editFor(inlineEdits, target.path);
						edit.inserts.heading = target.heading;
						edit.inserts.todos.push(t);
					}
				} else if (hit.kind === 'tasknotes') {
					result[await this.syncTaskNote(hit.file, t, prev, today, pushes)]++;
				} else {
					editFor(inlineEdits, hit.file.path).updates.set(t.id, t);
				}
			} catch (e) {
				result.failed++;
				result.lastError = errorMessage(e);
				console.error('[ideashell] to-do import failed', t.id, e);
			}
		}

		for (const [path, edit] of inlineEdits) {
			try {
				await this.applyInline(path, edit, today, pushes, result);
			} catch (e) {
				result.failed += edit.updates.size + edit.inserts.todos.length;
				result.lastError = `${path}: ${errorMessage(e)}`;
				console.error('[ideashell] writing to-dos failed', path, e);
			}
		}

		if (pushes.size > 0) {
			onProgress?.('Sending changes to ideashell…');
			await this.push(pushes, tz, result);
		}

		state.lastRunAt = new Date().toISOString();
		state.lastResult = summarizeTodos(result);
		await this.save();
		return result;
	}

	/** Open or completed to-dos: the default window (recent and undated) merged with every dated one. */
	private async list(completed: boolean, timezone: string, result: TodoResult): Promise<Todo[]> {
		const recent = parseTodos(await this.api.listTodos({ completed, timezone }));
		const dated = parseTodos(await this.api.listTodos({ completed, timezone, dateFrom: ALL_DATES_FROM }));
		if (recent.length >= TODO_LIST_MAX || dated.length >= TODO_LIST_MAX) result.truncated = true;
		const out = [...recent];
		const seen = new Set(out.map((t) => t.id));
		for (const t of dated) if (!seen.has(t.id)) out.push(t);
		return out;
	}

	/** Every imported to-do in the vault, by id: TaskNotes frontmatter first, then inline block ids. */
	private locate(): Map<string, Located> {
		const map = new Map<string, Located>();
		for (const file of this.app.vault.getMarkdownFiles()) {
			const cache = this.app.metadataCache.getFileCache(file);
			const raw: unknown = cache?.frontmatter?.[FM_TODO_ID];
			if (typeof raw === 'string' && raw.trim() && !map.has(raw.trim())) {
				map.set(raw.trim(), { kind: 'tasknotes', file });
			}
			for (const key of Object.keys(cache?.blocks ?? {})) {
				if (!key.startsWith(BLOCK_PREFIX)) continue;
				const id = key.slice(BLOCK_PREFIX.length);
				if (!map.has(id)) map.set(id, { kind: 'inline', file });
			}
		}
		return map;
	}

	// --- TaskNotes files ---

	private async createTaskNote(t: Todo, today: string): Promise<void> {
		const s = this.settings();
		const title = plainTodoText(t.content) || EMPTY_TITLE;
		const folder = normalizePath(s.todosFolder.trim() || '/');
		await this.ensureFolder(folder);
		const name = sanitizeFilename(title);
		const path = this.freePath(folder === '/' ? `${name}.md` : `${folder}/${name}.md`, t.id);

		const now = moment().format('YYYY-MM-DDTHH:mm:ss.SSSZ');
		const fm: Record<string, unknown> = {
			type: 'task',
			status: t.completed ? s.todosDoneStatus : s.todosOpenStatus,
			priority: 'normal',
		};
		const when = taskNotesDate(t.date, t.time, s.todosIncludeTime);
		if (when) fm[s.todosDateField] = when;
		fm.tags = normalizeTags([s.todosTaskTag, s.todosTag]);
		fm.dateCreated = now;
		fm.dateModified = now;
		if (t.completed) fm.completedDate = today;
		fm[FM_TODO_ID] = t.id;

		// the file name holds the title; keep the full text when it had to be shortened
		const body = Array.from(title).length > MAX_TITLE ? `\n${escapeTodoText(t.content)}\n` : '';
		await this.app.vault.create(path, `---\n${stringifyYaml(fm)}---\n${body}`);
	}

	/** The to-do as the TaskNotes file has it now; fields the file cannot show are taken from `base`. */
	private readTaskNote(file: TFile, base: TodoSnapshot, id: string): TodoSnapshot {
		const s = this.settings();
		const fm = this.app.metadataCache.getFileCache(file)?.frontmatter ?? {};
		// the file name is the title; an id suffix added to avoid a name clash is not part of it
		const name = file.basename.replace(new RegExp(` ${id.slice(0, 8)}( \\d+)?$`), '');
		const content = name === sanitizeFilename(plainTodoText(base.content) || EMPTY_TITLE) ? base.content : name;
		const raw: unknown = fm[s.todosDateField];
		const when = /^(\d{4}-\d{2}-\d{2})(?:T(\d{2}:\d{2}))?/.exec(typeof raw === 'string' ? raw : '');
		return {
			content,
			date: when?.[1] ?? null,
			time: s.todosIncludeTime ? (when?.[2] ?? null) : base.time,
			completed: this.isTaskNoteDone(fm),
		};
	}

	private async syncTaskNote(
		file: TFile,
		t: Todo,
		prev: TodoSnapshot | undefined,
		today: string,
		pushes: Map<string, TodoFields>,
	): Promise<'updated' | 'unchanged'> {
		const s = this.settings();
		const remote = snapshotOf(t);
		const local = this.readTaskNote(file, prev ?? remote, t.id);
		const { write, push } = reconcileTodo(remote, prev, local, s.todosTwoWay);
		if (Object.keys(push).length > 0) pushes.set(t.id, push);
		// recorded as ideashell has it; pushed fields are recorded once ideashell accepts them
		s.todoState.synced[t.id] = remote;

		let changed = false;
		const schedule = 'date' in write || 'time' in write;
		if (schedule || write.completed !== undefined) {
			const when = taskNotesDate(write.date !== undefined ? write.date : local.date, write.time !== undefined ? write.time : local.time, s.todosIncludeTime);
			await this.app.fileManager.processFrontMatter(file, (f: Record<string, unknown>) => {
				if (schedule) {
					if (when) f[s.todosDateField] = when;
					else delete f[s.todosDateField];
				}
				if (write.completed === true) {
					f.status = s.todosDoneStatus;
					f.completedDate = today;
				} else if (write.completed === false) {
					f.status = s.todosOpenStatus;
					delete f.completedDate;
				}
				f.dateModified = moment().format('YYYY-MM-DDTHH:mm:ss.SSSZ');
			});
			changed = true;
		}
		if (write.content !== undefined) {
			const name = sanitizeFilename(plainTodoText(write.content) || EMPTY_TITLE);
			if (name !== file.basename) {
				const folder = file.parent?.path ?? '/';
				const target = this.freePath(folder === '/' ? `${name}.md` : `${folder}/${name}.md`, t.id);
				await this.app.fileManager.renameFile(file, target);
				changed = true;
			}
		}
		return changed ? 'updated' : 'unchanged';
	}

	private isTaskNoteDone(fm: Record<string, unknown>): boolean {
		const status = typeof fm.status === 'string' ? fm.status : '';
		return status === this.settings().todosDoneStatus || status === 'cancelled';
	}

	// --- inline Tasks lines ---

	/** Daily note for the to-do's date (created when allowed), else the to-dos file. */
	private async inlineTarget(t: Todo): Promise<{ path: string; heading: string }> {
		const s = this.settings();
		const heading = s.todosHeading.trim();
		if (s.todosTarget === 'daily' && t.date) {
			const date = moment(t.date, 'YYYY-MM-DD');
			const path = this.daily.pathFor(date);
			const existing = this.app.vault.getAbstractFileByPath(path);
			if (existing instanceof TFile) return { path, heading };
			if (!existing && s.dailyNotesCreate) {
				await this.daily.ensureDailyNote(path, date);
				return { path, heading };
			}
		}
		const path = normalizePath(s.todosFile.trim() || 'ideashell/Todos.md');
		if (!(this.app.vault.getAbstractFileByPath(path) instanceof TFile)) {
			const slash = path.lastIndexOf('/');
			if (slash > 0) await this.ensureFolder(path.slice(0, slash));
			if (!this.app.vault.getAbstractFileByPath(path)) await this.app.vault.create(path, '');
		}
		return { path, heading };
	}

	/** The to-do as an inline line has it now; the time, which lines cannot show, comes from `base`. */
	private readInline(line: string, base: TodoSnapshot): TodoSnapshot | null {
		const s = this.settings();
		const read = readInlineTask(line, [s.todosTaskTag, s.todosTag], s.todosDateField);
		if (!read) return null;
		const rendered = plainTodoText(base.content) || '(empty to-do)';
		return { content: read.content === rendered ? base.content : read.content, date: read.date, time: base.time, completed: read.completed };
	}

	private async applyInline(path: string, edit: InlineEdit, today: string, pushes: Map<string, TodoFields>, result: TodoResult): Promise<void> {
		const s = this.settings();
		const tags = [s.todosTaskTag, s.todosTag];
		const synced = s.todoState.synced;
		await this.app.vault.process(this.fileAt(path), (text) => {
			const lines = text.split('\n');
			const seen = new Set<string>();
			for (let i = 0; i < lines.length; i++) {
				const line = lines[i] ?? '';
				const marker = parseInlineTask(line);
				const t = marker ? edit.updates.get(marker.id) : undefined;
				if (!marker || !t || seen.has(t.id)) continue;
				seen.add(t.id);
				const remote = snapshotOf(t);
				const prev = synced[t.id];
				const local = this.readInline(line, prev ?? remote);
				if (!local) continue;
				const { write, push } = reconcileTodo(remote, prev, local, s.todosTwoWay);
				if (Object.keys(push).length > 0) pushes.set(t.id, push);
				synced[t.id] = remote;
				if (Object.keys(write).length === 0) {
					result.unchanged++;
					continue;
				}
				const merged: Todo = { ...t, ...local, ...write, id: t.id };
				const doneDate = /✅\s*(\d{4}-\d{2}-\d{2})/u.exec(line)?.[1] ?? today;
				let rendered = renderInlineTask(merged, { done: merged.completed, doneDate, tags, dateField: s.todosDateField });
				// keep a custom closed state such as `-` (cancelled) when completion did not change
				if (write.completed === undefined && merged.completed) rendered = rendered.replace(/^- \[x\]/, `- [${marker.status}]`);
				lines[i] = marker.indent + rendered;
				result.updated++;
			}
			// an id the cache placed here but the text no longer has (edited meanwhile): count, don't add
			for (const id of edit.updates.keys()) if (!seen.has(id)) result.skipped++;

			const fresh = edit.inserts.todos.filter((t) => !seen.has(t.id) && !text.includes(`^${BLOCK_PREFIX}${t.id}`));
			if (fresh.length === 0) return lines.join('\n');
			const rendered = fresh.map((t) => {
				synced[t.id] = snapshotOf(t);
				return renderInlineTask(t, { done: t.completed, doneDate: today, tags, dateField: s.todosDateField });
			});
			result.created += fresh.length;
			return insertUnderHeading(lines.join('\n'), edit.inserts.heading, rendered);
		});
	}

	// --- two-way sync ---

	/**
	 * Whether `file` holds an imported to-do edited in the vault since the last sync. Used to run
	 * a sync soon after a task is edited; the sync itself fetches ideashell first, so a change
	 * made there in the meantime still wins.
	 */
	async hasLocalEdits(file: TFile): Promise<boolean> {
		const synced = this.settings().todoState.synced;
		const cache = this.app.metadataCache.getFileCache(file);
		const fmId: unknown = cache?.frontmatter?.[FM_TODO_ID];
		if (typeof fmId === 'string') {
			const prev = synced[fmId.trim()];
			if (prev && differs(this.readTaskNote(file, prev, fmId.trim()), prev)) return true;
		}
		if (!cache?.listItems?.some((li) => li.id?.startsWith(BLOCK_PREFIX))) return false;
		for (const line of (await this.app.vault.cachedRead(file)).split('\n')) {
			const marker = parseInlineTask(line);
			const prev = marker ? synced[marker.id] : undefined;
			const local = prev ? this.readInline(line, prev) : null;
			if (prev && local && differs(local, prev)) return true;
		}
		return false;
	}

	private async push(pushes: Map<string, TodoFields>, timezone: string, result: TodoResult): Promise<void> {
		const items: TodoUpdate[] = [...pushes].map(([todo_id, f]) => ({
			todo_id,
			...(f.content !== undefined ? { content: f.content } : {}),
			...(f.date ? { date: f.date } : {}),
			...(f.time ? { time: f.time } : {}),
			...(f.completed !== undefined ? { is_completed: f.completed } : {}),
		}));
		try {
			await this.api.updateTodos(items, timezone);
		} catch (e) {
			// not recorded as synced, so the next run sends them again
			result.failed += items.length;
			result.lastError = `todo_update: ${errorMessage(e)}`;
			return;
		}
		const synced = this.settings().todoState.synced;
		for (const [id, f] of pushes) {
			const snap = synced[id];
			if (snap) synced[id] = { ...snap, ...f };
		}
		result.pushed += items.length;
	}

	// --- helpers ---

	private fileAt(path: string): TFile {
		const file = this.app.vault.getAbstractFileByPath(path);
		if (!(file instanceof TFile)) throw new Error(`${path}: file not found`);
		return file;
	}

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

	private async ensureFolder(folderPath: string): Promise<void> {
		let current = '';
		for (const part of normalizePath(folderPath).split('/').filter(Boolean)) {
			current = current ? `${current}/${part}` : part;
			const f = this.app.vault.getAbstractFileByPath(current);
			if (!f) await this.app.vault.createFolder(current);
			else if (!(f instanceof TFolder)) throw new Error(`"${current}" exists and is not a folder`);
		}
	}
}

function differs(a: TodoSnapshot, b: TodoSnapshot): boolean {
	return a.content !== b.content || a.date !== b.date || a.time !== b.time || a.completed !== b.completed;
}

function editFor(edits: Map<string, InlineEdit>, path: string): InlineEdit {
	let e = edits.get(path);
	if (!e) {
		e = { updates: new Map(), inserts: { heading: '', todos: [] } };
		edits.set(path, e);
	}
	return e;
}

/** The system IANA time zone, so ideashell renders dates on the user's calendar day. */
function localTimezone(): string {
	try {
		return Intl.DateTimeFormat().resolvedOptions().timeZone || '';
	} catch {
		return '';
	}
}

export function summarizeTodos(r: TodoResult): string {
	const parts = [`${r.created} created`, `${r.updated} updated`, `${r.unchanged} unchanged`];
	if (r.skipped > 0) parts.push(`${r.skipped} skipped`);
	if (r.pushed > 0) parts.push(`${r.pushed} updated in ideashell`);
	if (r.failed > 0) parts.push(`${r.failed} failed`);
	if (r.truncated) parts.push(`ideashell returned its ${TODO_LIST_MAX}-item maximum, so some to-dos may be missing`);
	return parts.join(', ');
}
