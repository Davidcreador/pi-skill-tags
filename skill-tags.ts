import { readFile } from "node:fs/promises";
import * as path from "node:path";
import { stripFrontmatter, type SlashCommandInfo, type Theme } from "@earendil-works/pi-coding-agent";
import type {
	AutocompleteItem,
	AutocompleteProvider,
	AutocompleteSuggestions,
} from "@earendil-works/pi-tui";

export interface SkillCommand {
	name: string;
	description?: string;
	path: string;
	scope: "project" | "user" | "temporary";
}

export const EDITOR_RENDER_HOOK = Symbol.for("pi.editor.renderHook");
export const EDITOR_COMPONENT_CHANGED_EVENT = "ui-pack:v1:editor-component-changed";
export const SKILL_TAGS_EDITOR_FACTORY = Symbol.for("skill-tags.editorFactory");
const SKILL_COMPLETION_ITEM = Symbol("skill-tags.completionItem");
const ANSI_OR_CONTROL_RE = /\x1b(?:\[[0-?]*[ -/]*[@-~]|_[^\x07]*\x07|\][^\x07]*(?:\x07|\x1b\\))/y;
const TAG_RE = /\$\[([A-Za-z0-9_-]+)\]/g;

export function getSkillCommands(commands: SlashCommandInfo[]): SkillCommand[] {
	return commands
		.filter((command) => command.source === "skill")
		.map((command) => ({
			name: command.name.startsWith("skill:") ? command.name.slice(6) : command.name,
			description: command.description,
			path: command.sourceInfo.path,
			scope: command.sourceInfo.scope,
		}))
		.sort((a, b) => {
			const scopeOrder = (skill: SkillCommand) => (skill.scope === "project" ? 0 : 1);
			return scopeOrder(a) - scopeOrder(b) || a.name.localeCompare(b.name);
		});
}

export function skillScopeLabel(skill: SkillCommand): string {
	if (skill.scope === "project") return "Project skill";
	if (skill.scope === "temporary") return "Temporary skill";
	return "Global skill";
}

export function extractSkillPrefix(textBeforeCursor: string): string | undefined {
	return textBeforeCursor.match(/(?:^|\s)(\$\[?[^\s\]]*)$/)?.[1];
}

export function applySkillCompletion(
	lines: string[],
	cursorLine: number,
	cursorCol: number,
	item: AutocompleteItem,
	prefix: string,
): { lines: string[]; cursorLine: number; cursorCol: number } {
	const next = [...lines];
	const line = next[cursorLine] ?? "";
	const start = cursorCol - prefix.length;
	const tokenRemainder = line.slice(cursorCol).match(/^[A-Za-z0-9_-]*\]?/)?.[0] ?? "";
	const suffix = line.slice(cursorCol + tokenRemainder.length);
	const trailingSpace = suffix === "" || !/^[\s\p{P}]/u.test(suffix) ? " " : "";
	const insertion = `$[${item.value}]${trailingSpace}`;
	next[cursorLine] = line.slice(0, start) + insertion + suffix;
	return { lines: next, cursorLine, cursorCol: start + insertion.length };
}

export function createSkillAutocompleteProvider(
	current: AutocompleteProvider,
	getSkills: () => SkillCommand[],
): AutocompleteProvider {
	return {
		triggerCharacters: [...new Set([...(current.triggerCharacters ?? []), "$"])],
		async getSuggestions(lines, cursorLine, cursorCol, options): Promise<AutocompleteSuggestions | null> {
			const prefix = extractSkillPrefix((lines[cursorLine] ?? "").slice(0, cursorCol));
			if (prefix === undefined) return current.getSuggestions(lines, cursorLine, cursorCol, options);
			const query = prefix.replace(/^\$\[?/, "").toLocaleLowerCase();
			const items = getSkills()
				.filter((skill) => skill.name.toLocaleLowerCase().includes(query))
				.map((skill) => ({
					value: skill.name,
					label: skill.name,
					description: [skillScopeLabel(skill), skill.description].filter(Boolean).join(" · "),
					[SKILL_COMPLETION_ITEM]: true,
				}));
			return items.length > 0
				? { items, prefix }
				: current.getSuggestions(lines, cursorLine, cursorCol, options);
		},
		applyCompletion(lines, cursorLine, cursorCol, item, prefix) {
			return (item as AutocompleteItem & { [SKILL_COMPLETION_ITEM]?: boolean })[SKILL_COMPLETION_ITEM]
				? applySkillCompletion(lines, cursorLine, cursorCol, item, prefix)
				: current.applyCompletion(lines, cursorLine, cursorCol, item, prefix);
		},
		shouldTriggerFileCompletion(lines, cursorLine, cursorCol) {
			return current.shouldTriggerFileCompletion?.(lines, cursorLine, cursorCol) ?? true;
		},
	};
}

function escapeXmlAttribute(value: string): string {
	return value.replace(/[&<>"']/g, (character) => ({
		"&": "&amp;",
		"<": "&lt;",
		">": "&gt;",
		'"': "&quot;",
		"'": "&apos;",
	})[character] ?? character);
}

interface LoadedSkill extends SkillCommand {
	body: string;
	baseDir: string;
}

function renderSkillBlock(loaded: LoadedSkill[]): string {
	if (loaded.length === 1) {
		const skill = loaded[0];
		return `<skill name="${escapeXmlAttribute(skill.name)}" location="${escapeXmlAttribute(skill.path)}">\nReferences are relative to ${skill.baseDir}.\n\n${skill.body}\n</skill>`;
	}

	const label = loaded.map((skill) => skill.name).join(" + ");
	const sections = loaded.map((skill) => [
		`Name: ${skill.name}`,
		`Path: ${skill.path}`,
		`Base directory: ${skill.baseDir}`,
		"Body:",
		skill.body,
	].join("\n"));
	return `<skill name="${escapeXmlAttribute(label)}" location="multiple skills">\n${sections.join("\n\n---\n\n")}\n</skill>`;
}

export async function expandSkillTags(
	text: string,
	skills: SkillCommand[],
	load: (filePath: string) => Promise<string> = (filePath) => readFile(filePath, "utf8"),
): Promise<string> {
	const byName = new Map(skills.map((skill) => [skill.name, skill]));
	const matches = [...text.matchAll(TAG_RE)];
	if (matches.length === 0) return text;

	const loadedByName = new Map<string, LoadedSkill>();
	const failedNames = new Set<string>();
	for (const match of matches) {
		const skill = byName.get(match[1]);
		if (!skill || loadedByName.has(skill.name) || failedNames.has(skill.name)) continue;
		try {
			loadedByName.set(skill.name, {
				...skill,
				body: stripFrontmatter(await load(skill.path)).trim(),
				baseDir: path.dirname(skill.path),
			});
		} catch {
			failedNames.add(skill.name);
		}
	}
	const loaded = [...loadedByName.values()];
	if (loaded.length === 0) return text;

	const readableMessage = text.replace(TAG_RE, (token, name: string) => loadedByName.has(name) ? name : token);
	const nonTagText = text.replace(TAG_RE, (token, name: string) => loadedByName.has(name) ? "" : token).trim();
	const block = renderSkillBlock(loaded);
	return nonTagText ? `${block}\n\n${readableMessage}` : block;
}

interface ChipTheme {
	fg(token: "accent" | "text", text: string): string;
	bg(token: "selectedBg", text: string): string;
}

function splitControls(line: string): { plain: string; controls: string[][] } {
	let plain = "";
	const controls: string[][] = [[]];
	for (let index = 0; index < line.length;) {
		ANSI_OR_CONTROL_RE.lastIndex = index;
		const control = ANSI_OR_CONTROL_RE.exec(line);
		if (control) {
			controls[plain.length].push(control[0]);
			index += control[0].length;
			continue;
		}
		plain += line[index];
		controls.push([]);
		index++;
	}
	return { plain, controls };
}

export function decorateSkillTags(line: string, knownNames: ReadonlySet<string>, theme: ChipTheme): string {
	const { plain, controls } = splitControls(line);
	const matches = [...plain.matchAll(TAG_RE)].filter((match) => knownNames.has(match[1]));
	if (matches.length === 0) return line;
	const byStart = new Map(matches.map((match) => [match.index, match]));
	let output = "";
	for (let index = 0; index < plain.length;) {
		const match = byStart.get(index);
		if (!match) {
			output += controls[index].join("") + plain[index];
			index++;
			continue;
		}
		const chip = `✦ ${match[1]} `;
		for (let chipIndex = 0; chipIndex < chip.length; chipIndex++) {
			const color = chipIndex === 0 ? "accent" : "text";
			output += controls[index + chipIndex].join("");
			output += theme.bg("selectedBg", theme.fg(color, chip[chipIndex]));
		}
		index += match[0].length;
	}
	return output + controls[plain.length].join("");
}

export function decorateEditorLines(lines: string[], knownNames: ReadonlySet<string>, theme: Theme): string[] {
	return lines.map((line) => decorateSkillTags(line, knownNames, theme));
}
