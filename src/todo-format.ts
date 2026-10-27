import type { Todo } from './parse';

/**
 * Pure rendering and merge rules for ideashell to-dos. No Obsidian imports, so the rules can be
 * exercised outside the app.
 */

/** Frontmatter key holding the ideashell todo_id on a TaskNotes file. */
export const FM_TODO_ID = 'ideashell_todo_id';
/** Block id prefix marking an inline task line as an ideashell to-do. */
export const BLOCK_PREFIX = 'ideashell-';

/** ids are opaque, but they end up in block ids and frontmatter, so only these characters are accepted. */
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9-]{0,127}$/;

export function isSafeTodoId(id: string): boolean {
	return SAFE_ID.test(id);
}

export type TodoDateField = 'due' | 'scheduled';

/** What ideashell said about a to-do when it was last written to the vault. */
export interface TodoSnapshot {
	content: string;
	date: string | null;
	time: string | null;
	completed: boolean;
}

export function snapshotOf(t: Todo): TodoSnapshot {
	return { content: t.content, date: t.date, time: t.time, completed: t.completed };
}

const FIELDS = ['content', 'date', 'time', 'completed'] as const;
type Field = (typeof FIELDS)[number];
export type TodoFields = Partial<TodoSnapshot>;

export interface TodoReconcile {
	/** Values to write to the vault (ideashell changed them, or the task was never synced). */
	write: TodoFields;
	/** Values to send to ideashell with `todo_update` (changed only in the vault; two-way sync). */
	push: TodoFields;
}

/**
 * Field-level two-way merge against the values last synced (`prev`). For each field:
 *  - changed in ideashell since the last sync → ideashell wins and the vault is updated;
 *  - changed only in the vault → sent to ideashell when two-way sync is on, otherwise left as is.
 * With no previous sync, ideashell wins, except that a task completed in the vault stays done
 * (and is completed in ideashell with two-way sync). ideashell cannot clear a date or time, so
 * one removed in the vault is not sent.
 */
export function reconcileTodo(remote: TodoSnapshot, prev: TodoSnapshot | undefined, local: TodoSnapshot, twoWay: boolean): TodoReconcile {
	const write: TodoFields = {};
	const push: TodoFields = {};
	const set = (target: TodoFields, f: Field, v: TodoSnapshot[Field]) => {
		(target as Record<Field, TodoSnapshot[Field]>)[f] = v;
	};
	for (const f of FIELDS) {
		const r = remote[f];
		const l = local[f];
		if (l === r) continue;
		if (!prev) {
			if (f === 'completed' && l) {
				if (twoWay) set(push, f, l);
			} else set(write, f, r);
			continue;
		}
		if (r !== prev[f]) {
			set(write, f, r);
			continue;
		}
		if (!twoWay) continue;
		if ((f === 'date' || f === 'time') && !l) continue;
		if (f === 'content' && !String(l).trim()) continue;
		set(push, f, l);
	}
	return { write, push };
}

/** Tasks plugin signifiers; inside to-do text they would be read as dates, priorities, etc. */
const TASK_SIGNIFIERS = /[📅⏳🛫✅❌➕🔁⏫🔼🔽🔺⏬🆔⛔🏁]️?/gu;
const LEADING_MARKUP = /^(?:[-*+]\s+|\d+[.)]\s+|\[.?\]\s*|#{1,6}\s+|>\s*)/;

/** One line of plain text: no control characters, list or checkbox prefix, or task signifiers. */
export function plainTodoText(raw: string): string {
	let t = raw.replace(/\p{Cc}+/gu, ' ').replace(TASK_SIGNIFIERS, ' ').replace(/\s+/g, ' ').trim();
	for (let prev = ''; prev !== t; ) {
		prev = t;
		t = t.replace(LEADING_MARKUP, '').trim();
	}
	return t;
}

/** `plainTodoText`, with Markdown that could turn data into links, tags, HTML or comments escaped. */
export function escapeTodoText(raw: string): string {
	const t = plainTodoText(raw)
		.replace(/([[\]<])/g, '\\$1')
		.replace(/%%/g, '%\\%')
		.replace(/(^|\s)#(?=\S)/g, '$1\\#');
	return t || '(empty to-do)';
}

/** Tag names without `#`, spaces turned into dashes, empties and duplicates dropped. */
export function normalizeTags(tags: string[]): string[] {
	const out: string[] = [];
	for (const raw of tags) {
		const t = raw.trim().replace(/^#+/, '').replace(/\s+/g, '-');
		if (t && !out.includes(t)) out.push(t);
	}
	return out;
}

/** TaskNotes date value: `YYYY-MM-DD`, or `YYYY-MM-DDTHH:mm:00` with a time (the vault's existing form). */
export function taskNotesDate(date: string | null, time: string | null, includeTime: boolean): string | null {
	if (!date) return null;
	return includeTime && time ? `${date}T${time}:00` : date;
}

export interface InlineOptions {
	done: boolean;
	/** `YYYY-MM-DD`, written after ✅ on done tasks. */
	doneDate: string;
	tags: string[];
	dateField: TodoDateField;
}

/** `- [ ] text #tag 📅 2026-10-28 ^ideashell-<id>` in the Tasks emoji format. */
export function renderInlineTask(t: Todo, o: InlineOptions): string {
	const parts = [`- [${o.done ? 'x' : ' '}]`, escapeTodoText(t.content)];
	for (const tag of normalizeTags(o.tags)) parts.push(`#${tag}`);
	if (t.date) parts.push(`${o.dateField === 'scheduled' ? '⏳' : '📅'} ${t.date}`);
	if (o.done) parts.push(`✅ ${o.doneDate}`);
	parts.push(`^${BLOCK_PREFIX}${t.id}`);
	return parts.join(' ');
}

const INLINE_LINE = /^(\s*)(?:[-*+]|\d+[.)]) \[(.)\] .*\^ideashell-([A-Za-z0-9-]+)\s*$/;

/**
 * The to-do fields of an inline task line as the user left it: text without the tags, dates and
 * markers the import adds (escapes undone), the date from the date field's emoji, and the state.
 */
export function readInlineTask(line: string, tags: string[], dateField: TodoDateField): { content: string; date: string | null; completed: boolean } | null {
	const marker = parseInlineTask(line);
	if (!marker) return null;
	const emoji = dateField === 'scheduled' ? '⏳' : '📅';
	const date = new RegExp(`${emoji}\\uFE0F?\\s*(\\d{4}-\\d{2}-\\d{2})`, 'u').exec(line)?.[1] ?? null;
	let text = line
		.replace(/^\s*(?:[-*+]|\d+[.)]) \[.\] /, '')
		.replace(/\s*\^ideashell-[A-Za-z0-9-]+\s*$/, '')
		.replace(/[📅⏳🛫✅❌➕]\uFE0F?\s*\d{4}-\d{2}-\d{2}/gu, ' ');
	for (const tag of normalizeTags(tags)) {
		text = text.replace(new RegExp(`(^|\\s)#${tag.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?=\\s|$)`, 'g'), '$1');
	}
	const content = plainTodoText(text.replace(/\\([[\]<#%])/g, '$1'));
	return { content, date, completed: isClosedStatus(marker.status) };
}

/** The marker of an inline ideashell task line, or null for any other line. */
export function parseInlineTask(line: string): { indent: string; status: string; id: string } | null {
	const m = INLINE_LINE.exec(line);
	if (!m) return null;
	return { indent: m[1] ?? '', status: m[2] ?? ' ', id: m[3] ?? '' };
}

/** `x`, `X` and `-` (cancelled) count as closed; `/` (in progress) and custom states do not. */
export function isClosedStatus(status: string): boolean {
	return status === 'x' || status === 'X' || status === '-';
}
