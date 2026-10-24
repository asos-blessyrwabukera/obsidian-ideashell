import { App, Notice, TFile, arrayBufferToBase64 } from 'obsidian';
import { FolderResolver, IdeashellApi, IMAGES_MAX, IMAGE_MAX_BYTES, NoteImage } from './ideashell-api';
import {
	FM_FOLDER,
	FM_HASH,
	FM_ID,
	FM_IMAGES,
	FM_MARK,
	FM_SYNCED,
	FM_URL,
	IMAGE_EXTENSIONS,
	convertNote,
	convertSelection,
	folderNameForPath,
} from './convert';
import type { IdeashellSettings } from './settings';
import { errorMessage } from './settings';

export type SyncOutcome = 'created' | 'updated' | 'unchanged' | 'failed';

export class SyncService {
	private folders: FolderResolver;
	private inFlight = new Set<string>();
	/** Message of the most recent failure, surfaced in batch summaries. */
	lastError: string | null = null;

	constructor(
		private app: App,
		private api: IdeashellApi,
		private settings: () => IdeashellSettings,
	) {
		this.folders = new FolderResolver(api);
	}

	invalidateFolders(): void {
		this.folders.invalidate();
	}

	/** Send one note. Creates on first sync, updates afterwards, skips when content hash is unchanged (unless forced). */
	async syncFile(file: TFile, opts: { force?: boolean; silent?: boolean } = {}): Promise<SyncOutcome> {
		if (this.inFlight.has(file.path)) return 'unchanged';
		this.inFlight.add(file.path);
		try {
			return await this.doSync(file, opts);
		} finally {
			this.inFlight.delete(file.path);
		}
	}

	private async doSync(file: TFile, opts: { force?: boolean; silent?: boolean }): Promise<SyncOutcome> {
		const s = this.settings();
		const raw = await this.app.vault.read(file);
		const meta = this.app.metadataCache.getFileCache(file);
		const note = convertNote(file, raw, meta, { stripWikilinks: s.stripWikilinks, sourceTag: s.sourceTag });

		const existingId = meta?.frontmatter?.[FM_ID] as string | undefined;
		const existingHash = meta?.frontmatter?.[FM_HASH] as string | undefined;

		// Notes imported from ideashell are rendered copies; sending them back would overwrite
		// the original note in ideashell with the template output.
		if (isImported(meta?.frontmatter)) {
			if (!opts.silent) new Notice(`"${file.basename}" was imported from ideashell and is not sent back`);
			return 'unchanged';
		}

		// Images already sent for this note (vault paths); only new embeds are uploaded on update.
		const attachedBefore = new Set<string>(
			existingId && Array.isArray(meta?.frontmatter?.[FM_IMAGES])
				? (meta?.frontmatter?.[FM_IMAGES] as unknown[]).map(String)
				: [],
		);
		const pendingImages = this.embeddedImages(file, attachedBefore);
		const folderName = s.mapFolders ? folderNameForPath(file.parent?.path ?? '') : null;
		const folderBefore = (meta?.frontmatter?.[FM_FOLDER] as string | undefined) ?? null;
		const folderChanged = existingId ? folderName !== folderBefore : false;

		// Text unchanged, no new images, same folder → nothing to send.
		// (Images and folder are not part of the text hash, so they are checked separately.)
		if (existingId && existingHash === note.hash && pendingImages.length === 0 && !folderChanged && !opts.force) {
			if (!opts.silent) new Notice(`"${file.basename}" is already up to date`);
			return 'unchanged';
		}

		try {
			const folderId = folderName ? await this.folders.resolve(folderName) : undefined;

			const { images, paths, skipped } = await this.readImages(pendingImages, attachedBefore.size);

			let noteId = existingId;
			let url: string | undefined;
			if (noteId) {
				// Only send text when it changed; a folder-only or image-only change skips note_update.
				if (existingHash !== note.hash || images.length > 0) {
					await this.api.updateNote(noteId, { title: note.title, content: note.content, tags: note.tags, images });
				}
				// keep the ideashell folder in step with where the file lives now
				if (folderChanged) {
					if (folderId) await this.api.moveNotes([noteId], folderId);
					else await this.api.removeFromFolder([noteId]);
				}
			} else {
				const created = await this.api.createNote({
					title: note.title,
					content: note.content,
					tags: note.tags,
					folderId,
					images,
				});
				noteId = created.note_id;
				url = created.url;
			}
			if (skipped.length > 0 && !opts.silent) {
				new Notice(`${skipped.length} image(s) not attached: ${skipped.join(', ')}`, 8000);
			}

			const attachedNow = [...attachedBefore, ...paths];
			await this.app.fileManager.processFrontMatter(file, (fm: Record<string, unknown>) => {
				fm[FM_ID] = noteId;
				fm[FM_HASH] = note.hash;
				fm[FM_SYNCED] = new Date().toISOString();
				if (url) fm[FM_URL] = url;
				if (attachedNow.length > 0) fm[FM_IMAGES] = attachedNow;
				if (folderName) fm[FM_FOLDER] = folderName;
				else delete fm[FM_FOLDER];
			});

			const outcome: SyncOutcome = existingId ? 'updated' : 'created';
			if (!opts.silent) new Notice(`"${file.basename}" ${outcome} in ideashell`);
			return outcome;
		} catch (e) {
			// folder cache may be stale (folder deleted in app) → refresh for next attempt
			this.folders.invalidate();
			this.lastError = errorMessage(e);
			if (!opts.silent) new Notice(`Failed to sync "${file.basename}": ${errorMessage(e)}`, 8000);
			console.error('[ideashell] sync failed', file.path, e);
			return 'failed';
		}
	}

	/**
	 * Local raster images embedded as `![[x.png]]` that have not been sent yet
	 * (`already` = vault paths recorded in frontmatter by earlier syncs). Resolution goes through
	 * Obsidian's link resolver, so `![[red.png]]` finds `img/red.png` the same way the editor does.
	 * Removing an embed does not detach the image in ideashell (attachments are add-only).
	 */
	private embeddedImages(file: TFile, already: Set<string>): TFile[] {
		const out: TFile[] = [];
		const seen = new Set<string>(already);
		const embeds = this.app.metadataCache.getFileCache(file)?.embeds ?? [];
		for (const embed of embeds) {
			const linkpath = embed.link.split('#')[0] ?? embed.link;
			const target = this.app.metadataCache.getFirstLinkpathDest(linkpath, file.path);
			if (!target || !IMAGE_EXTENSIONS.has(target.extension.toLowerCase()) || seen.has(target.path)) continue;
			seen.add(target.path);
			out.push(target);
		}
		return out;
	}

	private async readImages(
		targets: TFile[],
		alreadyCount: number,
	): Promise<{ images: NoteImage[]; paths: string[]; skipped: string[] }> {
		const images: NoteImage[] = [];
		const paths: string[] = [];
		const skipped: string[] = [];
		for (const target of targets) {
			if (alreadyCount + images.length >= IMAGES_MAX) {
				skipped.push(`${target.name} (max ${IMAGES_MAX})`);
				continue;
			}
			if (target.stat.size > IMAGE_MAX_BYTES) {
				skipped.push(`${target.name} (>10MB)`);
				continue;
			}
			const bytes = await this.app.vault.readBinary(target);
			images.push({ data: arrayBufferToBase64(bytes), name: target.name });
			paths.push(target.path);
		}
		return { images, paths, skipped };
	}

	/** Send selected text as a brand-new note (like a quick memo). Not tracked in frontmatter. */
	async syncSelection(selection: string, sourceFile: TFile | null): Promise<void> {
		const s = this.settings();
		const { title, content } = convertSelection(selection, { stripWikilinks: s.stripWikilinks, sourceTag: s.sourceTag });
		try {
			const folderName = s.mapFolders && sourceFile ? folderNameForPath(sourceFile.parent?.path ?? '') : null;
			const folderId = folderName ? await this.folders.resolve(folderName) : undefined;
			await this.api.createNote({ title, content, tags: s.sourceTag ? [s.sourceTag] : undefined, folderId });
			new Notice(`Selection sent to ideashell as "${title}"`);
		} catch (e) {
			this.folders.invalidate();
			new Notice(`Failed to send selection: ${errorMessage(e)}`, 8000);
			console.error('[ideashell] selection sync failed', e);
		}
	}

	/** All markdown files that are either marked `ideashell: true` or live under a configured sync folder. */
	collectSyncTargets(): TFile[] {
		const s = this.settings();
		const folders = s.syncFolders;
		return this.app.vault.getMarkdownFiles().filter((f) => {
			const fm = this.app.metadataCache.getFileCache(f)?.frontmatter;
			if (isImported(fm)) return false;
			if (fm?.[FM_MARK] === true || fm?.[FM_ID]) return true;
			return folders.some((dir) => f.path === dir || f.path.startsWith(dir + '/'));
		});
	}

	/** Sequential batch with a short pause; the endpoint is rate-limited per minute. */
	async syncMany(files: TFile[], onProgress?: (done: number, total: number) => void): Promise<Record<SyncOutcome, number>> {
		const counts: Record<SyncOutcome, number> = { created: 0, updated: 0, unchanged: 0, failed: 0 };
		let i = 0;
		for (const f of files) {
			const r = await this.syncFile(f, { silent: true });
			counts[r]++;
			onProgress?.(++i, files.length);
			if (r === 'created' || r === 'updated') await sleep(400);
		}
		return counts;
	}

	/** Sent to ideashell from Obsidian before (imported notes do not count). */
	isSynced(file: TFile): boolean {
		const fm = this.app.metadataCache.getFileCache(file)?.frontmatter;
		return Boolean(fm?.[FM_ID]) && !isImported(fm);
	}
}

/**
 * A note imported from ideashell carries `ideashell_id` but never `ideashell_hash`, which only
 * sending a note from Obsidian writes.
 */
export function isImported(fm: Record<string, unknown> | undefined): boolean {
	return Boolean(fm?.[FM_ID]) && fm?.[FM_HASH] === undefined;
}

function sleep(ms: number): Promise<void> {
	return new Promise((r) => window.setTimeout(r, ms));
}
