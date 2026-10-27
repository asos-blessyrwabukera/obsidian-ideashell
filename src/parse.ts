/**
 * Parsers for the text the ideashell MCP read tools return.
 *
 * `recent_notes` lists notes as blocks:
 *
 *     # Title @ 2026-07-11T19:52:42.721Z
 *     note_id: 3ab8b88088673df9b7ea47f70d80cfca
 *
 * `note_detail` (scope "full") returns the note as markdown:
 *
 *     # Title
 *     note_id: 3ab8…
 *     time: 2026-07-11T19:52:42.721Z
 *     summary: …
 *
 *     body…
 *
 *     ## Memos
 *     **Memo 1: …**
 *     summary: …
 *     transcribed text…
 *
 * The server formats these for language models, not machines, so parsing is lenient:
 * JSON is accepted too, and anything unrecognised is kept as text rather than dropped.
 */

export interface ListedNote {
	id: string;
	title: string;
	/** Creation time as sent by the server (usually ISO 8601). */
	created: string;
}

export interface NoteSection {
	name: string;
	content: string;
}

export interface NoteDetail {
	id: string;
	title: string;
	created: string;
	summary: string;
	tags: string[];
	url: string;
	/** Markdown body of the note, without the metadata header or sub-item sections. */
	body: string;
	/** Voice memo / recording sections (transcripts). */
	transcripts: NoteSection[];
	/** Other sub-item sections (links, attachments, …). */
	extras: NoteSection[];
	/** True while a recording in the note is still being transcribed. */
	transcribing: boolean;
}

/** Section headings `note_detail` uses for sub-items; anything else is part of the body. */
const TRANSCRIPT_SECTIONS = /^(memos?|audios?|recordings?|transcripts?|voice memos?|录音|语音|转写)$/i;
const EXTRA_SECTIONS = /^(links?|link cards?|images?|attachments?|files?|documents?|链接|附件|图片|文档|文件)$/i;

const TRANSCRIBING_MARKERS = ['转写中...', '转写中…', 'transcribing...', 'transcribing…'];

export function parseRecentNotes(text: string): ListedNote[] {
	const json = parseJsonNotes(text);
	if (json) return json;

	const out: ListedNote[] = [];
	const seen = new Set<string>();
	const lines = text.split(/\r?\n/);
	let pendingTitle = '';
	let pendingCreated = '';
	for (const line of lines) {
		const heading = /^#\s+(.+?)\s*$/.exec(line);
		if (heading) {
			const h = heading[1] ?? '';
			const at = h.lastIndexOf(' @ ');
			pendingTitle = at >= 0 ? h.slice(0, at).trim() : h.trim();
			pendingCreated = at >= 0 ? h.slice(at + 3).trim() : '';
			continue;
		}
		const meta = /^\s*(?:[-*]\s*)?([a-z_]+):\s*(.*?)\s*$/i.exec(line);
		if (!meta) continue;
		const key = (meta[1] ?? '').toLowerCase();
		const value = meta[2] ?? '';
		if (key === 'note_id' || key === 'id') {
			const id = value.replace(/[`"'[\]]/g, '').trim();
			if (!id || seen.has(id)) continue;
			seen.add(id);
			out.push({ id, title: pendingTitle, created: pendingCreated });
			pendingTitle = '';
			pendingCreated = '';
		} else if ((key === 'time' || key === 'created_at' || key === 'created') && out.length > 0 && !out[out.length - 1]?.created) {
			const last = out[out.length - 1];
			if (last) last.created = value;
		}
	}
	return out;
}

export function parseNoteDetail(text: string, fallback: ListedNote): NoteDetail {
	const json = parseJsonDetail(text, fallback);
	if (json) return json;

	const lines = text.replace(/\r\n/g, '\n').split('\n');
	let i = 0;
	while (i < lines.length && !lines[i]?.trim()) i++;

	let title = fallback.title;
	const heading = /^#\s+(.+?)\s*$/.exec(lines[i] ?? '');
	if (heading) {
		title = heading[1] ?? title;
		i++;
	}

	// Metadata header: consecutive `key: value` lines right after the title.
	const meta: Record<string, string> = {};
	for (; i < lines.length; i++) {
		const m = /^([a-z_]+):\s?(.*)$/.exec(lines[i] ?? '');
		if (!m) break;
		meta[m[1] ?? ''] = (m[2] ?? '').trim();
	}

	// Body runs until the first sub-item section (## Memos, ## Links, …).
	const bodyLines: string[] = [];
	const sections: NoteSection[] = [];
	let current: NoteSection | null = null;
	let currentLines: string[] = [];
	const flush = () => {
		if (current) {
			current.content = currentLines.join('\n').trim();
			sections.push(current);
		}
	};
	for (; i < lines.length; i++) {
		const line = lines[i] ?? '';
		const sec = /^##\s+(.+?)\s*$/.exec(line);
		const name = sec?.[1]?.replace(/\s*\(\d+\)$/, '').trim();
		if (name && (TRANSCRIPT_SECTIONS.test(name) || EXTRA_SECTIONS.test(name))) {
			flush();
			current = { name: sec?.[1]?.trim() ?? name, content: '' };
			currentLines = [];
			continue;
		}
		if (current) currentLines.push(line);
		else bodyLines.push(line);
	}
	flush();

	const transcripts = sections.filter((s) => TRANSCRIPT_SECTIONS.test(s.name.replace(/\s*\(\d+\)$/, '')) && s.content);
	const extras = sections.filter((s) => !transcripts.includes(s) && s.content);
	const body = bodyLines.join('\n').trim();
	const id = meta.note_id || meta.id || fallback.id;

	return {
		id,
		title: title.trim() || fallback.title,
		created: meta.time || meta.created_at || meta.created || fallback.created,
		summary: meta.summary ?? '',
		tags: splitTags(meta.tags ?? ''),
		url: meta.url ?? '',
		body,
		transcripts,
		extras,
		transcribing: isTranscribing([body, ...transcripts.map((t) => t.content)].join('\n')),
	};
}

export function isTranscribing(text: string): boolean {
	return text.split('\n').some((l) => TRANSCRIBING_MARKERS.includes(l.trim().toLowerCase()));
}

function splitTags(raw: string): string[] {
	return raw
		.replace(/^\[|\]$/g, '')
		.split(/[,，\s]+/)
		.map((t) => t.replace(/^#/, '').replace(/^["']|["']$/g, '').trim())
		.filter((t) => t.length > 0);
}

// --- JSON fallbacks (in case the server switches to structured output) ---

function tryJson(text: string): unknown {
	const t = text.trim();
	if (!t.startsWith('{') && !t.startsWith('[')) return undefined;
	try {
		return JSON.parse(t) as unknown;
	} catch {
		return undefined;
	}
}

function str(v: unknown): string {
	return typeof v === 'string' ? v : typeof v === 'number' ? String(v) : '';
}

function parseJsonNotes(text: string): ListedNote[] | null {
	const data = tryJson(text);
	if (data === undefined) return null;
	const rec = data as Record<string, unknown>;
	const arr: unknown = Array.isArray(data) ? data : rec.notes ?? rec.items ?? rec.data;
	if (!Array.isArray(arr)) return null;
	return arr
		.map((n) => {
			const o = (n ?? {}) as Record<string, unknown>;
			return {
				id: str(o.note_id ?? o.id),
				title: str(o.title),
				created: str(o.created_at ?? o.create_time ?? o.time ?? o.created),
			};
		})
		.filter((n) => n.id);
}

function parseJsonDetail(text: string, fallback: ListedNote): NoteDetail | null {
	const data = tryJson(text);
	if (!data || Array.isArray(data)) return null;
	const o = data as Record<string, unknown>;
	if (!('content' in o) && !('note_id' in o) && !('body' in o)) return null;
	const body = str(o.content ?? o.body).trim();
	const memos = Array.isArray(o.memos) ? (o.memos as unknown[]) : [];
	const transcriptText = memos
		.map((m) => {
			const r = (m ?? {}) as Record<string, unknown>;
			return str(r.text ?? r.content ?? r.transcript).trim();
		})
		.filter((t) => t)
		.join('\n\n');
	const tags = Array.isArray(o.tags) ? (o.tags as unknown[]).map(str).filter((t) => t) : splitTags(str(o.tags));
	return {
		id: str(o.note_id ?? o.id) || fallback.id,
		title: str(o.title) || fallback.title,
		created: str(o.created_at ?? o.create_time ?? o.time) || fallback.created,
		summary: str(o.summary),
		tags,
		url: str(o.url),
		body,
		transcripts: transcriptText ? [{ name: 'Memos', content: transcriptText }] : [],
		extras: [],
		transcribing: isTranscribing([body, transcriptText].join('\n')),
	};
}

// --- to-dos ---

/**
 * One ideashell to-do. `todo_list` returns a JSON array of
 * `{ id, content, date: "YYYY-MM-DD" | null, time: "HH:MM" | null, is_completed }`;
 * the text form below is accepted too in case the server formats it for language models:
 *
 *     - [ ] Call the bank (2026-10-28 09:00)
 *       todo_id: 82831ae33f284ecb932ac1663790dbb7
 */
export interface Todo {
	/** Opaque; passed back to `todo_update` exactly as received. */
	id: string;
	content: string;
	date: string | null;
	time: string | null;
	completed: boolean;
}

const TODO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const TODO_TIME = /^\d{1,2}:\d{2}$/;

export function parseTodos(text: string): Todo[] {
	const data = tryJson(text);
	if (data !== undefined) {
		const rec = (data ?? {}) as Record<string, unknown>;
		const arr: unknown = Array.isArray(data) ? data : rec.todos ?? rec.items ?? rec.data;
		if (Array.isArray(arr)) return dedupeTodos(arr.map((t) => todoFromJson(t)));
	}
	return dedupeTodos(parseTodoText(text));
}

function todoFromJson(t: unknown): Todo {
	const o = (t ?? {}) as Record<string, unknown>;
	const completed = o.is_completed ?? o.completed ?? o.done ?? o.status;
	return {
		id: str(o.todo_id ?? o.id).trim(),
		content: str(o.content ?? o.text ?? o.title),
		date: todoDate(str(o.date)),
		time: todoTime(str(o.time)),
		completed: completed === true || completed === 'true' || completed === 1 || completed === 'completed' || completed === 'done',
	};
}

function parseTodoText(text: string): Todo[] {
	const out: Todo[] = [];
	let current: Todo | null = null;
	for (const line of text.split(/\r?\n/)) {
		const item = /^\s*(?:[-*+]|\d+[.)])\s+(?:\[([ xX])\]\s*)?(.*?)\s*$/.exec(line);
		const meta = /^\s*(?:[-*]\s*)?([a-z_]+):\s*(.*?)\s*$/i.exec(line);
		const key = (meta?.[1] ?? '').toLowerCase();
		if (meta && ['todo_id', 'id', 'date', 'time', 'is_completed', 'completed', 'content'].includes(key)) {
			const value = (meta[2] ?? '').replace(/[`"'[\]]/g, '').trim();
			if (key === 'todo_id' || key === 'id') {
				if (!current || current.id) {
					current = { id: '', content: '', date: null, time: null, completed: false };
					out.push(current);
				}
				current.id = value;
			} else if (current) {
				if (key === 'date') current.date = todoDate(value);
				else if (key === 'time') current.time = todoTime(value);
				else if (key === 'content') current.content = value;
				else current.completed = value.toLowerCase() === 'true';
			}
			continue;
		}
		if (item) {
			let body = item[2] ?? '';
			// trailing "(YYYY-MM-DD HH:MM)" or "[todo_id: …]" on the same line
			const id = /\[?(?:todo_)?id:\s*([^\]\s]+)\]?/i.exec(body);
			if (id) body = body.replace(id[0], '').trim();
			const when = /\(?(\d{4}-\d{2}-\d{2})(?:[ T](\d{1,2}:\d{2}))?\)?\s*$/.exec(body);
			if (when) body = body.slice(0, when.index).trim();
			current = {
				id: (id?.[1] ?? '').trim(),
				content: body,
				date: todoDate(when?.[1] ?? ''),
				time: todoTime(when?.[2] ?? ''),
				completed: item[1] === 'x' || item[1] === 'X',
			};
			out.push(current);
		}
	}
	return out;
}

function todoDate(v: string): string | null {
	const d = v.trim().slice(0, 10);
	return TODO_DATE.test(d) ? d : null;
}

function todoTime(v: string): string | null {
	const t = v.trim().slice(0, 5);
	if (!TODO_TIME.test(t)) return null;
	return t.length === 4 ? `0${t}` : t;
}

function dedupeTodos(todos: Todo[]): Todo[] {
	const seen = new Set<string>();
	return todos.filter((t) => t.id && !seen.has(t.id) && (seen.add(t.id), true));
}
