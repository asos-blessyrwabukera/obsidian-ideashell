import { App, TFile, TFolder, moment, normalizePath, stringifyYaml } from 'obsidian';
import { IdeashellApi, TODO_LIST_MAX } from './ideashell-api';
import { Todo, parseTodos } from './parse';
import {
	BLOCK_PREFIX,
	FM_TODO_ID,
	TodoPlan,
	TodoSnapshot,
	escapeTodoText,
	isClosedStatus,
	isSafeTodoId,
	normalizeTags,
	parseInlineTask,
	planTodo,
	plainTodoText,
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

export interface TodoResult {
	created: number;
	updated: number;
	unchanged: number;
	/** Not written: completed and completed to-dos are off, deleted from the vault, or an unusable id. */
	skipped: number;
	/** Marked complete in ideashell (two-way completion). */
	completedRemote: number;
	failed: number;
	lastError: string | null;
	/** A `todo_list` call hit its item limit, so some to-dos may be missing. */
	truncated: boolean;
}

/** Where an imported to-do lives in the vault. */
type Located = { kind: 'tasknotes'; file: TFile } | { kind: 'inline'; file: TFile };

/** A change to one inline file, applied in a single `vault.process`. */
interface InlineEdit {
	updates: Map<string, Todo>;
	inserts: { heading: string; todos: Todo[] };
}

/**
 * ideashell to-dos → vault tasks. Each to-do becomes a TaskNotes file (`ideashell_todo_id` in
 * frontmatter) or an inline Tasks-format line (`^ideashell-<id>` block id). The last values
 * written are kept in plugin data, so a re-import only writes fields that changed in ideashell
 * and a task deleted from the vault is not brought back.
 */
export class TodoService {
	private running = false;
	private pushing = false;

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
		const result: TodoResult = { created: 0, updated: 0, unchanged: 0, skipped: 0, completedRemote: 0, failed: 0, lastError: null, truncated: false };
		const tz = localTimezone();

		onProgress?.('Listing to-dos…');
		const open = await this.list(false, tz, result);
		// Completed to-dos drop out of the open list, so fetch them when importing them or when a
		// task already in the vault may have been completed in ideashell.
		const openIds = new Set(open.map((t) => t.id));
		const needCompleted = s.todosIncludeCompleted || Object.entries(state.synced).some(([id, p]) => !p.completed && !openIds.has(id));
		const completed = needCompleted ? await this.list(true, tz, result) : [];
		const todos = [...open, ...completed.filter((t) => !openIds.has(t.id))];

		const located = this.locate();
		const inlineEdits = new Map<string, InlineEdit>();
		const pushes: string[] = [];
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
					const outcome = await this.updateTaskNote(hit.file, t, prev, today, pushes);
					result[outcome]++;
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
				const n = edit.updates.size + edit.inserts.todos.length;
				result.failed += n;
				result.lastError = `${path}: ${errorMessage(e)}`;
				console.error('[ideashell] writing to-dos failed', path, e);
			}
		}

		if (pushes.length > 0) {
			onProgress?.('Marking to-dos complete in ideashell…');
			result.completedRemote += await this.push(pushes, tz, result);
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
		const title = plainTodoText(t.content) || 'ideashell to-do';
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

	private async updateTaskNote(
		file: TFile,
		t: Todo,
		prev: TodoSnapshot | undefined,
		today: string,
		pushes: string[],
	): Promise<'updated' | 'unchanged'> {
		const s = this.settings();
		const fm = this.app.metadataCache.getFileCache(file)?.frontmatter ?? {};
		const localDone = this.isTaskNoteDone(fm);
		const plan = planTodo(snapshotOf(t), prev, localDone, s.todosTwoWay);
		const snapshot = snapshotOf(t);
		if (plan.push) {
			pushes.push(t.id);
			// recorded as open until ideashell confirms, so a failed push is retried next run
		}

		let changed = false;
		if (plan.schedule || plan.done !== null) {
			const when = taskNotesDate(t.date, t.time, s.todosIncludeTime);
			await this.app.fileManager.processFrontMatter(file, (f: Record<string, unknown>) => {
				if (plan.schedule) {
					if (when) f[s.todosDateField] = when;
					else delete f[s.todosDateField];
				}
				if (plan.done === true) {
					f.status = s.todosDoneStatus;
					f.completedDate = today;
				} else if (plan.done === false) {
					f.status = s.todosOpenStatus;
					delete f.completedDate;
				}
				f.dateModified = moment().format('YYYY-MM-DDTHH:mm:ss.SSSZ');
			});
			changed = true;
		}
		if (plan.content) {
			const name = sanitizeFilename(plainTodoText(t.content) || 'ideashell to-do');
			if (name !== file.basename) {
				const folder = file.parent?.path ?? '/';
				const target = this.freePath(folder === '/' ? `${name}.md` : `${folder}/${name}.md`, t.id);
				await this.app.fileManager.renameFile(file, target);
				changed = true;
			}
		}
		this.settings().todoState.synced[t.id] = snapshot;
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

	private async applyInline(path: string, edit: InlineEdit, today: string, pushes: string[], result: TodoResult): Promise<void> {
		const s = this.settings();
		const file = this.app.vault.getAbstractFileByPath(path);
		if (!(file instanceof TFile)) throw new Error('file not found');
		const tags = [s.todosTaskTag, s.todosTag];
		const synced = s.todoState.synced;
		await this.app.vault.process(file, (text) => {
			const lines = text.split('\n');
			const seen = new Set<string>();
			for (let i = 0; i < lines.length; i++) {
				const marker = parseInlineTask(lines[i] ?? '');
				const t = marker ? edit.updates.get(marker.id) : undefined;
				if (!marker || !t || seen.has(t.id)) continue;
				seen.add(t.id);
				const plan = planTodo(snapshotOf(t), synced[t.id], isClosedStatus(marker.status), s.todosTwoWay);
				if (plan.push) pushes.push(t.id);
				synced[t.id] = snapshotOf(t);
				if (!plan.content && !plan.schedule && plan.done === null) {
					result.unchanged++;
					continue;
				}
				lines[i] = marker.indent + this.rerenderInline(lines[i] ?? '', marker.status, t, plan, tags, today);
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

	/** New text for an existing line: the local status (and ✅ date) are kept unless the plan changes them. */
	private rerenderInline(line: string, status: string, t: Todo, plan: TodoPlan, tags: string[], today: string): string {
		const done = plan.done ?? isClosedStatus(status);
		const oldDoneDate = /✅\s*(\d{4}-\d{2}-\d{2})/u.exec(line)?.[1];
		const rendered = renderInlineTask(t, { done, doneDate: oldDoneDate ?? today, tags, dateField: this.settings().todosDateField });
		// keep custom closed states such as `-` (cancelled) when completion did not change
		return plan.done === null && done ? rendered.replace(/^- \[x\]/, `- [${status}]`) : rendered;
	}

	// --- two-way completion ---

	/**
	 * Called when a file changes: push completions of imported tasks ticked in Obsidian. Only ids
	 * this plugin imported (and last saw open) are sent; nothing else is ever written to ideashell.
	 */
	async pushCompletionsIn(file: TFile): Promise<void> {
		const s = this.settings();
		if (!s.todosTwoWay || this.running || this.pushing) return;
		const cache = this.app.metadataCache.getFileCache(file);
		const ids: string[] = [];
		const fmId: unknown = cache?.frontmatter?.[FM_TODO_ID];
		if (typeof fmId === 'string' && this.isTaskNoteDone(cache?.frontmatter ?? {})) ids.push(fmId.trim());
		for (const item of cache?.listItems ?? []) {
			if (item.id?.startsWith(BLOCK_PREFIX) && item.task !== undefined && isClosedStatus(item.task)) {
				ids.push(item.id.slice(BLOCK_PREFIX.length));
			}
		}
		const todo = ids.filter((id) => s.todoState.synced[id] && !s.todoState.synced[id]?.completed);
		if (todo.length === 0) return;
		this.pushing = true;
		try {
			const result: TodoResult = { created: 0, updated: 0, unchanged: 0, skipped: 0, completedRemote: 0, failed: 0, lastError: null, truncated: false };
			await this.push(todo, localTimezone(), result);
			await this.save();
			if (result.lastError) console.error('[ideashell] completing to-dos in ideashell failed', result.lastError);
		} finally {
			this.pushing = false;
		}
	}

	private async push(ids: string[], timezone: string, result: TodoResult): Promise<number> {
		const unique = [...new Set(ids)];
		try {
			await this.api.completeTodos(unique, timezone);
		} catch (e) {
			result.failed += unique.length;
			result.lastError = `todo_update: ${errorMessage(e)}`;
			return 0;
		}
		for (const id of unique) {
			const snap = this.settings().todoState.synced[id];
			if (snap) snap.completed = true;
		}
		return unique.length;
	}

	// --- helpers ---

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
	if (r.completedRemote > 0) parts.push(`${r.completedRemote} completed in ideashell`);
	if (r.failed > 0) parts.push(`${r.failed} failed`);
	if (r.truncated) parts.push(`ideashell returned its ${TODO_LIST_MAX}-item maximum, so some to-dos may be missing`);
	return parts.join(', ');
}
