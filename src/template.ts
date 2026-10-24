import { moment, normalizePath } from 'obsidian';
import type { NoteDetail, NoteSection } from './parse';

/** Frontmatter key that links an imported note to its ideashell note (dedupe key). */
export const IMPORT_ID_KEY = 'ideashell_id';

export const DEFAULT_TEMPLATE = `---
ideashell_id: "{{ideashell_id}}"
title: {{ideashell_title_yaml}}
date: {{ideashell_date}}
created: {{ideashell_created}}
{{#ideashell_url}}ideashell_url: {{ideashell_url}}
{{/ideashell_url}}tags:
  - ideashell
{{ideashell_tags_list}}
---
{{#ideashell_summary}}## Summary

{{ideashell_summary}}

{{/ideashell_summary}}{{#ideashell_content}}## Note

{{ideashell_content}}

{{/ideashell_content}}{{#ideashell_transcript}}## Transcript

{{ideashell_transcript}}

{{/ideashell_transcript}}{{#ideashell_attachments}}## Attachments

{{ideashell_attachments}}
{{/ideashell_attachments}}`;

/** Parse the server's creation time; invalid when it cannot be read. */
export function parseCreated(created: string): moment.Moment {
	const strict = moment(created, moment.ISO_8601, true);
	if (strict.isValid()) return strict;
	return moment(created.trim().replace(' ', 'T'), moment.ISO_8601);
}

export function buildVariables(note: NoteDetail, includeTranscripts: boolean): Record<string, string> {
	const created = parseCreated(note.created);
	const tags = note.tags
		.map((t) => t.replace(/^#/, '').replace(/[\s,#]+/g, '-').replace(/^-+|-+$/g, ''))
		.filter((t) => t && t.toLowerCase() !== 'ideashell');
	return {
		ideashell_id: note.id,
		ideashell_title: note.title,
		ideashell_title_yaml: JSON.stringify(note.title),
		ideashell_date: created.isValid() ? created.format('YYYY-MM-DD') : '',
		ideashell_time: created.isValid() ? created.format('LT') : '',
		ideashell_created: created.isValid() ? created.toISOString() : note.created,
		ideashell_url: note.url,
		ideashell_summary: note.summary,
		ideashell_content: note.body,
		ideashell_transcript: includeTranscripts ? joinSections(note.transcripts) : '',
		ideashell_attachments: joinSections(note.extras),
		ideashell_tags: tags.join(', '),
		ideashell_tags_list: tags.map((t) => `  - ${JSON.stringify(t)}`).join('\n'),
	};
}

function joinSections(sections: NoteSection[]): string {
	if (sections.length === 1) return sections[0]?.content ?? '';
	return sections.map((s) => `### ${s.name}\n\n${s.content}`).join('\n\n');
}

/**
 * Render a template. `{{#var}}…{{/var}}` keeps its content only when `var` is non-empty
 * (nested blocks work). Conditionals are resolved on the template before any value is
 * substituted, and substitution is one pass, so note text containing `{{…}}` is written
 * out verbatim instead of being interpreted.
 */
export function applyTemplate(template: string, variables: Record<string, string>): string {
	const rendered = renderConditionals(template, variables);
	return rendered.replace(/\{\{(\w+)\}\}/g, (m, key: string) => variables[key] ?? m);
}

function renderConditionals(template: string, variables: Record<string, string>): string {
	return template.replace(/\{\{#(\w+)\}\}([\s\S]*?)\{\{\/\1\}\}/g, (_m, key: string, inner: string) =>
		variables[key]?.trim() ? renderConditionals(inner, variables) : '',
	);
}

/**
 * Make sure the rendered note carries `ideashell_id` in its frontmatter even if a custom
 * template left it out — without it the next sync could not recognise the note and would
 * create a duplicate.
 */
export function ensureImportId(content: string, id: string): string {
	const line = `${IMPORT_ID_KEY}: ${JSON.stringify(id)}`;
	const fm = /^---\r?\n([\s\S]*?)\r?\n---(\r?\n|$)/.exec(content);
	if (fm) {
		if (new RegExp(`^${IMPORT_ID_KEY}\\s*:`, 'm').test(fm[1] ?? '')) return content;
		return content.replace(/^---\r?\n/, `---\n${line}\n`);
	}
	return `---\n${line}\n---\n${content}`;
}

const UNSAFE_FILENAME_CHARS = /[/\\?%*:|"<>]/g;
const CONTROL_CHARS = /\p{Cc}/gu;
const FORMAT_CHARS = /(?!\u200d)\p{Cf}/gu;
/** Legal in filenames but they break [[wikilinks]]. */
const WIKILINK_UNSAFE_CHARS = /[#^[\]]/g;
const MAX_FILENAME_LENGTH = 100;

export function sanitizeFilename(name: string): string {
	const cleaned = name
		.replace(CONTROL_CHARS, ' ')
		.replace(FORMAT_CHARS, '')
		.replace(UNSAFE_FILENAME_CHARS, '-')
		.replace(WIKILINK_UNSAFE_CHARS, '-')
		.replace(/\s+/g, ' ')
		.trim();
	const truncated = Array.from(cleaned).slice(0, MAX_FILENAME_LENGTH).join('');
	return truncated.replace(/^[.-]+/, '').replace(/[ .-]+$/, '').trim() || 'Untitled';
}

const DATE_TOKEN = /\{date(?::([^}]+))?\}/g;

/** Expand `{date}` (YYYY-MM-DD) and `{date:FORMAT}` (moment format) using the note's creation time. */
export function resolveDatePattern(pattern: string, created: string): string {
	const m = parseCreated(created);
	return pattern.replace(DATE_TOKEN, (_x, format: string | undefined) =>
		m.isValid() ? m.format(format ?? 'YYYY-MM-DD') : '',
	);
}

/** Fixed leading part of a folder pattern, before any date token. */
export function folderBase(pattern: string): string {
	return normalizePath((pattern.split(/\{date/)[0] ?? '').replace(/\/+$/, '') || '/');
}

/** Expand `{date}`, `{date:FORMAT}`, `{title}` and `{id}` in the filename pattern. Never yields a path. */
export function generateFilename(pattern: string, note: NoteDetail): string {
	const values: Record<string, string> = { title: sanitizeFilename(note.title), id: note.id.slice(0, 8) };
	const name = resolveDatePattern(pattern, note.created)
		.replace(/\{(title|id)\}/g, (_m, token: string) => values[token] ?? '')
		.replace(UNSAFE_FILENAME_CHARS, '-')
		.replace(/\s+/g, ' ')
		.trim();
	return sanitizeFilename(name);
}

/** Folder (created on demand) and full path for a note. */
export function resolveNotePath(folderPattern: string, filenamePattern: string, note: NoteDetail): { folder: string; path: string } {
	const folder = normalizePath(resolveDatePattern(folderPattern, note.created) || '/');
	const filename = generateFilename(filenamePattern, note);
	return { folder, path: normalizePath(`${folder}/${filename}.md`) };
}
