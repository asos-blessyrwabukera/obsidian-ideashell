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

export interface TodoPlan {
	/** ideashell changed the text (or it was never synced): write it. */
	content: boolean;
	/** ideashell changed the date or time: write them. */
	schedule: boolean;
	/** New local completion state, or null to leave the vault as it is. */
	done: boolean | null;
	/** Mark the to-do complete in ideashell (two-way completion). */
	push: boolean;
}

/**
 * Field-level merge. Only fields ideashell changed since the last sync are written, so edits made
 * in Obsidian survive. A task completed in Obsidian is never reopened from ideashell unless
 * two-way completion is on and ideashell itself reopened it after both sides agreed it was done.
 */
export function planTodo(remote: TodoSnapshot, prev: TodoSnapshot | undefined, localDone: boolean, twoWay: boolean): TodoPlan {
	const plan: TodoPlan = {
		content: !prev || prev.content !== remote.content,
		schedule: !prev || prev.date !== remote.date || prev.time !== remote.time,
		done: null,
		push: false,
	};
	const remoteChanged = !prev || prev.completed !== remote.completed;
	if (remote.completed && !localDone) {
		// completed in ideashell; if it was reopened here after that, keep it open
		if (remoteChanged) plan.done = true;
	} else if (!remote.completed && localDone && twoWay) {
		if (prev?.completed) plan.done = false;
		else plan.push = true;
	}
	return plan;
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
