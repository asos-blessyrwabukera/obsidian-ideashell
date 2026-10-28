import { McpClient, McpError } from './mcp-client';

/** Limits enforced by the ideashell MCP tools. */
export const TITLE_MAX = 30;
export const SUMMARY_MAX = 500;
export const TAG_MAX = 32;
export const FOLDER_NAME_MAX = 50;
export const MOVE_NOTES_MAX = 50;
/** `todo_list` limit maximum; the tool has no paging. */
export const TODO_LIST_MAX = 200;
/** Items per `todo_update` call (the tool sets no limit; keep requests small). */
export const TODO_UPDATE_MAX = 50;

export interface NoteImage {
	/** base64 bytes */
	data: string;
	name: string;
}

export interface CreateNoteInput {
	title: string;
	content: string;
	summary?: string;
	tags?: string[];
	folderId?: string;
	images?: NoteImage[];
}

export const IMAGES_MAX = 9;
export const IMAGE_MAX_BYTES = 10 * 1024 * 1024;

/** Origin marker stored on every note this plugin creates. */
export const SOURCE = 'obsidian';

export interface UpdateNoteInput {
	title?: string;
	content?: string;
	summary?: string;
	tags?: string[];
	/** Images to add; the server keeps existing attachments and skips identical bytes. */
	images?: NoteImage[];
}

export interface CreatedNote {
	note_id: string;
	url?: string;
}

/** One `todo_update` item: the id plus at least one field to change. */
export interface TodoUpdate {
	todo_id: string;
	content?: string;
	/** YYYY-MM-DD */
	date?: string;
	/** HH:MM, 24-hour */
	time?: string;
	is_completed?: boolean;
}

export interface FolderInfo {
	folder_id: string;
	name: string;
}

/** Typed wrappers around the ideashell MCP tools used by the plugin. */
export class IdeashellApi {
	constructor(private client: () => McpClient) {}

	async createNote(input: CreateNoteInput): Promise<CreatedNote> {
		const text = await this.client().callTool('note_create', {
			title: input.title,
			content: input.content,
			...(input.summary ? { summary: input.summary } : {}),
			...(input.tags && input.tags.length > 0 ? { tags: input.tags } : {}),
			...(input.folderId ? { folder_id: input.folderId } : {}),
			...(input.images && input.images.length > 0 ? { images: input.images } : {}),
			source: SOURCE,
		});
		const parsed = parseJson<CreatedNote>(text);
		if (!parsed?.note_id) throw new McpError(`note_create returned no note_id: ${text.slice(0, 200)}`);
		return parsed;
	}

	async updateNote(noteId: string, input: UpdateNoteInput): Promise<void> {
		const { images, ...rest } = input;
		await this.client().callTool('note_update', {
			note_id: noteId,
			...rest,
			...(images && images.length > 0 ? { images } : {}),
		});
	}

	/**
	 * One page of notes ordered newest first. `start_time` / `end_time` are ISO timestamps
	 * bounding the creation time; the raw tool text is returned for `parseRecentNotes`.
	 */
	async recentNotes(args: { limit: number; startTime?: string; endTime?: string }): Promise<string> {
		return this.client().callTool('recent_notes', {
			limit: args.limit,
			...(args.startTime ? { start_time: args.startTime } : {}),
			...(args.endTime ? { end_time: args.endTime } : {}),
		});
	}

	/** Full note: body plus memos (voice transcripts), audios and links. Raw text for `parseNoteDetail`. */
	async noteDetail(noteId: string): Promise<string> {
		return this.client().callTool('note_detail', { note_id: noteId, scope: 'full' });
	}

	/**
	 * One call to `todo_list` (at most TODO_LIST_MAX items, no paging). Without `dateFrom` the
	 * server returns roughly the last 30 days plus undated to-dos; with it, dated to-dos only.
	 * Raw text for `parseTodos`.
	 */
	async listTodos(args: { completed: boolean; dateFrom?: string; timezone?: string }): Promise<string> {
		return this.client().callTool('todo_list', {
			limit: TODO_LIST_MAX,
			...(args.completed ? { is_completed: true } : {}),
			...(args.dateFrom ? { date_from: args.dateFrom } : {}),
			...(args.timezone ? { timezone: args.timezone } : {}),
		});
	}

	/** Change to-dos; only the fields given are changed. Ids go back exactly as `todo_list` returned them. */
	async updateTodos(items: TodoUpdate[], timezone?: string): Promise<void> {
		for (let i = 0; i < items.length; i += TODO_UPDATE_MAX) {
			await this.client().callTool('todo_update', {
				items: items.slice(i, i + TODO_UPDATE_MAX),
				...(timezone ? { timezone } : {}),
			});
		}
	}

	async listFolders(): Promise<FolderInfo[]> {
		const text = await this.client().callTool('folder_list', {});
		// Lines look like: "- 📚 Reading #tag (pinned) [folder_id: 123]"
		const folders: FolderInfo[] = [];
		const re = /^- (.*?) \[folder_id: ([^\]]+)\]\s*$/;
		for (const line of text.split('\n')) {
			const m = re.exec(line);
			if (!m) continue;
			let name = m[1] ?? '';
			// strip trailing flags and tags appended by the server formatter
			name = name.replace(/\s\((pinned|archived)(, (pinned|archived))?\)$/, '');
			name = name.replace(/(\s#[^\s#]+)+$/, '');
			// the server prefixes the folder emoji (default 📁) to the name
			name = name.replace(/^[\p{Extended_Pictographic}\p{Emoji_Component}️‍\s]+/u, '');
			folders.push({ folder_id: (m[2] ?? '').trim(), name: name.trim() });
		}
		return folders;
	}

	async createFolder(name: string): Promise<FolderInfo> {
		const text = await this.client().callTool('folder_create', { name });
		const parsed = parseJson<{ folder_id: string; name: string }>(text);
		if (!parsed?.folder_id) throw new McpError(`folder_create returned no folder_id: ${text.slice(0, 200)}`);
		return { folder_id: parsed.folder_id, name: parsed.name ?? name };
	}

	async removeFromFolder(noteIds: string[]): Promise<void> {
		for (let i = 0; i < noteIds.length; i += MOVE_NOTES_MAX) {
			await this.client().callTool('note_move', {
				note_ids: noteIds.slice(i, i + MOVE_NOTES_MAX),
				remove_from_folder: true,
			});
		}
	}

	async moveNotes(noteIds: string[], folderId: string): Promise<void> {
		for (let i = 0; i < noteIds.length; i += MOVE_NOTES_MAX) {
			await this.client().callTool('note_move', {
				note_ids: noteIds.slice(i, i + MOVE_NOTES_MAX),
				folder_id: folderId,
			});
		}
	}
}

function parseJson<T>(text: string): T | null {
	try {
		return JSON.parse(text) as T;
	} catch {
		return null;
	}
}

/**
 * Case-insensitive folder lookup cache. The server strips the emoji into its own field,
 * so names compare on the plain text only.
 */
export class FolderResolver {
	private cache: Map<string, string> | null = null;
	constructor(private api: IdeashellApi) {}

	invalidate(): void {
		this.cache = null;
	}

	async resolve(name: string): Promise<string> {
		const key = name.toLowerCase();
		if (!this.cache) {
			this.cache = new Map();
			for (const f of await this.api.listFolders()) {
				if (!this.cache.has(f.name.toLowerCase())) this.cache.set(f.name.toLowerCase(), f.folder_id);
			}
		}
		const hit = this.cache.get(key);
		if (hit) return hit;
		const created = await this.api.createFolder(name);
		this.cache.set(key, created.folder_id);
		return created.folder_id;
	}
}
