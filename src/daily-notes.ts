import { App, TFile, TFolder, moment, normalizePath } from 'obsidian';
import type { IdeashellSettings } from './settings';

/** An imported note to be linked from the daily note of the day it was created. */
export interface DailyEntry {
	file: TFile;
	title: string;
	created: moment.Moment;
}

interface DailyNoteConfig {
	folder: string;
	format: string;
	/** Template file for new daily notes (core Daily notes plugin setting). */
	template: string;
}

interface CoreDailyNotes {
	enabled?: boolean;
	instance?: { options?: { folder?: string; format?: string; template?: string } };
}

const DEFAULT_FORMAT = 'YYYY-MM-DD';

/**
 * Adds links to imported ideashell notes into Obsidian daily notes, under a heading.
 * A note already linked from its daily note (anywhere in it) is not added again, so runs are
 * idempotent and lines the user moved elsewhere in the note are respected.
 */
export class DailyNoteLinker {
	constructor(
		private app: App,
		private settings: () => IdeashellSettings,
	) {}

	/** Folder / format / template: plugin settings first, then the core Daily notes plugin, then defaults. */
	config(): DailyNoteConfig {
		const s = this.settings();
		const core = this.coreOptions();
		return {
			folder: (s.dailyNotesFolder.trim() || core?.folder?.trim() || '').replace(/^\/+|\/+$/g, ''),
			format: s.dailyNotesFormat.trim() || core?.format?.trim() || DEFAULT_FORMAT,
			template: core?.template?.trim() ?? '',
		};
	}

	/** Vault path of the daily note for `date` (local calendar day). */
	pathFor(date: moment.Moment, cfg = this.config()): string {
		const name = date.clone().local().format(cfg.format);
		return normalizePath(cfg.folder ? `${cfg.folder}/${name}.md` : `${name}.md`);
	}

	/** Link every entry from its daily note. Returns the number of links added and per-daily-note errors. */
	async link(entries: DailyEntry[]): Promise<{ added: number; errors: string[] }> {
		const cfg = this.config();
		const byPath = new Map<string, { date: moment.Moment; entries: DailyEntry[] }>();
		for (const e of entries) {
			if (!e.created.isValid()) continue;
			const path = this.pathFor(e.created, cfg);
			// a daily note never links to itself
			if (path === e.file.path) continue;
			const group = byPath.get(path) ?? { date: e.created, entries: [] };
			group.entries.push(e);
			byPath.set(path, group);
		}

		let added = 0;
		const errors: string[] = [];
		for (const [path, group] of byPath) {
			// one unwritable daily note must not stop the others
			try {
				added += await this.linkInto(path, group.date, group.entries, cfg);
			} catch (e) {
				console.error(`[ideashell] linking daily note ${path} failed`, e);
				errors.push(`${path}: ${e instanceof Error ? e.message : String(e)}`);
			}
		}
		return { added, errors };
	}

	private async linkInto(path: string, date: moment.Moment, entries: DailyEntry[], cfg: DailyNoteConfig): Promise<number> {
		const s = this.settings();
		const existing = this.app.vault.getAbstractFileByPath(path);
		if (existing && !(existing instanceof TFile)) return 0;
		const alreadyLinked = new Set(Object.keys(existing ? this.app.metadataCache.resolvedLinks[path] ?? {} : {}));
		const todo = entries
			.filter((e) => !alreadyLinked.has(e.file.path))
			.sort((a, b) => a.created.valueOf() - b.created.valueOf());
		if (todo.length === 0) return 0;

		let daily: TFile;
		if (existing) daily = existing;
		else if (s.dailyNotesCreate) daily = await this.createDailyNote(path, date, cfg);
		else return 0;

		const lines = todo.map((e) => ({ e, line: this.renderLine(e, path) }));
		let added = 0;
		await this.app.vault.process(daily, (text) => {
			// links can be written while the metadata cache lags behind, so also check the text
			const fresh = lines.filter(({ e, line }) => !text.includes(line) && !containsLinkTo(text, e.file));
			added = fresh.length;
			if (fresh.length === 0) return text;
			return insertUnderHeading(text, s.dailyNotesHeading.trim(), fresh.map((l) => l.line));
		});
		return added;
	}

	private renderLine(e: DailyEntry, sourcePath: string): string {
		const title = e.title.replace(/[|[\]\n\r]/g, ' ').replace(/\s+/g, ' ').trim() || e.file.basename;
		const link = this.app.fileManager.generateMarkdownLink(e.file, sourcePath, undefined, title);
		const values: Record<string, string> = {
			link,
			title,
			time: e.created.clone().local().format('HH:mm'),
		};
		const format = this.settings().dailyNotesLine || '- {{time}} {{link}}';
		return format.replace(/\{\{(link|title|time)\}\}/g, (_m, key: string) => values[key] ?? '');
	}

	private async createDailyNote(path: string, date: moment.Moment, cfg: DailyNoteConfig): Promise<TFile> {
		const slash = path.lastIndexOf('/');
		if (slash > 0) await this.ensureFolder(path.slice(0, slash));
		let content = '';
		if (cfg.template) {
			const tpl = this.app.metadataCache.getFirstLinkpathDest(cfg.template.replace(/\.md$/, ''), '');
			if (tpl) content = expandCoreTemplate(await this.app.vault.read(tpl), date, cfg.format);
		}
		try {
			return await this.app.vault.create(path, content);
		} catch (e) {
			// another plugin (e.g. core Daily notes on startup) may have just created it
			const now = this.app.vault.getAbstractFileByPath(path);
			if (now instanceof TFile) return now;
			throw e;
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

	private coreOptions(): { folder?: string; format?: string; template?: string } | null {
		// The core plugin's settings are not part of the public API; read them defensively.
		const internal = (this.app as App & { internalPlugins?: { getPluginById?: (id: string) => CoreDailyNotes | null } })
			.internalPlugins;
		const plugin = internal?.getPluginById?.('daily-notes');
		if (!plugin?.enabled) return null;
		return plugin.instance?.options ?? null;
	}
}

/** Whether `text` already contains a wikilink or markdown link that points at `file`. */
function containsLinkTo(text: string, file: TFile): boolean {
	const noExt = file.path.replace(/\.md$/, '');
	const targets = [file.path, noExt, file.basename];
	const wiki = /\[\[([^\]|#]+)(?:#[^\]|]*)?(?:\|[^\]]*)?\]\]/g;
	for (const m of text.matchAll(wiki)) {
		if (targets.includes((m[1] ?? '').trim())) return true;
	}
	const md = /\]\(<?([^)>]+)>?\)/g;
	for (const m of text.matchAll(md)) {
		let target = (m[1] ?? '').trim();
		try {
			target = decodeURI(target);
		} catch {
			// keep as-is
		}
		if (targets.includes(target.replace(/^\.?\//, ''))) return true;
	}
	return false;
}

/**
 * Append `lines` at the end of the section under `heading` (before the next heading of the same
 * or higher level). The heading is added at the end of the note when missing; with no heading
 * configured, lines go at the end of the note.
 */
export function insertUnderHeading(text: string, heading: string, lines: string[]): string {
	const block = lines.join('\n');
	if (!heading) return appendBlock(text, block);

	const all = text.split('\n');
	const level = /^#+/.exec(heading)?.[0].length ?? 0;
	const headingIdx = all.findIndex((l) => l.trim() === heading);
	if (headingIdx < 0) return appendBlock(text, `${heading}\n\n${block}`);

	let end = all.length;
	for (let i = headingIdx + 1; i < all.length; i++) {
		const h = /^(#+)\s/.exec(all[i] ?? '');
		if (h && (level === 0 || (h[1]?.length ?? 0) <= level)) {
			end = i;
			break;
		}
	}
	// insert after the section's last non-blank line, keeping blank lines before the next heading
	let at = end;
	while (at > headingIdx + 1 && !(all[at - 1] ?? '').trim()) at--;
	const insert = at === headingIdx + 1 ? ['', ...lines] : [...lines];
	if (at === end && end < all.length) insert.push('');
	all.splice(at, 0, ...insert);
	return all.join('\n');
}

function appendBlock(text: string, block: string): string {
	if (!text.trim()) return `${block}\n`;
	return `${text.replace(/\s*$/, '')}\n\n${block}\n`;
}

/** The subset of core template variables the Daily notes plugin fills in: {{date}}, {{time}}, {{title}}. */
export function expandCoreTemplate(template: string, date: moment.Moment, format: string): string {
	const now = moment();
	return template
		.replace(/\{\{\s*title\s*\}\}/gi, () => date.format(format).split('/').pop() ?? '')
		.replace(/\{\{\s*date\s*(?::([^}]+))?\}\}/gi, (_m, f: string | undefined) => date.format(f?.trim() || format))
		.replace(/\{\{\s*time\s*(?::([^}]+))?\}\}/gi, (_m, f: string | undefined) => now.format(f?.trim() || 'HH:mm'));
}
