import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { parseSkillBlock } from "@earendil-works/pi-coding-agent";
import { CURSOR_MARKER, visibleWidth, type AutocompleteProvider } from "@earendil-works/pi-tui";
import skillTags, { installSkillTagsEditor } from "../index.ts";
import {
	applySkillCompletion,
	createSkillAutocompleteProvider,
	decorateSkillTags,
	deleteSkillTagAtCursor,
	EDITOR_COMPONENT_CHANGED_EVENT,
	EDITOR_RENDER_HOOK,
	expandSkillTags,
	extractSkillPrefix,
	getSkillCommands,
	skillScopeLabel,
	SKILL_TAGS_EDITOR_FACTORY,
	type SkillCommand,
} from "../skill-tags.ts";

const project: SkillCommand = { name: "project-one", description: "Project help", path: "/repo/.pi/skills/project-one/SKILL.md", scope: "project" };
const globalSkill: SkillCommand = { name: "global-one", description: "Global help", path: "/home/.pi/skills/global-one/SKILL.md", scope: "user" };
const temporary: SkillCommand = { name: "temporary-one", description: "Temporary help", path: "/tmp/temporary-one/SKILL.md", scope: "temporary" };

const fallback: AutocompleteProvider = {
	async getSuggestions() { return null; },
	applyCompletion(lines, cursorLine, cursorCol) { return { lines, cursorLine, cursorCol }; },
};

const skillContent: Record<string, string> = {
	[project.path]: "---\nname: project-one\ndescription: x\n---\nProject body\n",
	[globalSkill.path]: "Global body\n",
};

const loadSkill = async (filePath: string) => skillContent[filePath];

test("package manifest exposes only the Pi extension and public runtime files", () => {
	const manifest = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
	assert.equal(manifest.name, "@davecodes/pi-skill-tags");
	assert.equal(manifest.version, "0.1.1");
	assert.deepEqual(manifest.pi, { extensions: ["./index.ts"] });
	assert.deepEqual(manifest.files, ["index.ts", "skill-tags.ts", "docs/skill-tags.png", "README.md", "LICENSE", "CHANGELOG.md"]);
	assert.deepEqual(manifest.peerDependencies, {
		"@earendil-works/pi-coding-agent": "*",
		"@earendil-works/pi-tui": "*",
	});
	assert.deepEqual(manifest.dependencies ?? {}, {});
});

test("filters loaded skills, sorts project first, and labels every scope", async () => {
	const skills = getSkillCommands([
		{ name: "skill:global-one", description: "Global help", source: "skill", sourceInfo: { path: globalSkill.path, source: "skills", scope: "user", origin: "top-level" } },
		{ name: "command", source: "extension", sourceInfo: { path: "/x", source: "extension", scope: "project", origin: "top-level" } },
		{ name: "skill:project-one", description: "Project help", source: "skill", sourceInfo: { path: project.path, source: "skills", scope: "project", origin: "top-level" } },
	]);
	assert.deepEqual(skills.map((skill) => skill.name), ["project-one", "global-one"]);
	const provider = createSkillAutocompleteProvider(fallback, () => skills);
	const result = await provider.getSuggestions(["try $"], 0, 5, { signal: new AbortController().signal });
	assert.deepEqual(result?.items.map((item) => item.description), ["Project skill · Project help", "Global skill · Global help"]);
	assert.equal(skillScopeLabel(temporary), "Temporary skill");
	assert.ok(provider.triggerCharacters?.includes("$"));
});

test("completion consumes the current token and inserts spacing only when useful", () => {
	const item = { value: "ponytail", label: "ponytail" };
	assert.equal(extractSkillPrefix("before $[proj"), "$[proj");
	assert.equal(extractSkillPrefix("before$proj"), undefined);
	assert.deepEqual(applySkillCompletion(["$ponytail"], 0, 4, item, "$pon"), { lines: ["$[ponytail] "], cursorLine: 0, cursorCol: 12 });
	assert.deepEqual(applySkillCompletion(["$[ponytail]"], 0, 6, item, "$[pony"), { lines: ["$[ponytail] "], cursorLine: 0, cursorCol: 12 });
	assert.deepEqual(applySkillCompletion(["$pony tail"], 0, 5, item, "$pony"), { lines: ["$[ponytail] tail"], cursorLine: 0, cursorCol: 11 });
	assert.deepEqual(applySkillCompletion(["$pony,next"], 0, 5, item, "$pony"), { lines: ["$[ponytail],next"], cursorLine: 0, cursorCol: 11 });
	assert.deepEqual(applySkillCompletion(["try $pony"], 0, 9, item, "$pony"), { lines: ["try $[ponytail] "], cursorLine: 0, cursorCol: 16 });
});

test("backward deletion removes a complete known skill tag", () => {
	const text = "Use $[project-one] now";
	const cursorCol = text.indexOf("]") + 1;
	assert.deepEqual(
		deleteSkillTagAtCursor([text], 0, cursorCol, "backward", new Set(["project-one"])),
		{ lines: ["Use  now"], cursorLine: 0, cursorCol: 4 },
	);
});

test("forward deletion removes a complete known skill tag", () => {
	const text = "Use $[project-one] now";
	const cursorCol = text.indexOf("$[");
	assert.deepEqual(
		deleteSkillTagAtCursor([text], 0, cursorCol, "forward", new Set(["project-one"])),
		{ lines: ["Use  now"], cursorLine: 0, cursorCol: 4 },
	);
});

test("deletion treats the inside of known tags as atomic but leaves unknown tags alone", () => {
	const text = "$[project-one] $[missing]";
	assert.deepEqual(
		deleteSkillTagAtCursor([text], 0, 5, "backward", new Set(["project-one"])),
		{ lines: [" $[missing]"], cursorLine: 0, cursorCol: 0 },
	);
	assert.deepEqual(
		deleteSkillTagAtCursor([text], 0, 5, "forward", new Set(["project-one"])),
		{ lines: [" $[missing]"], cursorLine: 0, cursorCol: 0 },
	);
	assert.equal(deleteSkillTagAtCursor([text], 0, text.length, "backward", new Set(["project-one"])), undefined);
});

test("skill provider delegates dollar-prefixed no-match suggestions and completions", async () => {
	let applied = false;
	const dollarProvider: AutocompleteProvider = {
		async getSuggestions() { return { items: [{ value: "$other", label: "$other" }], prefix: "$zzz" }; },
		applyCompletion(lines, cursorLine, cursorCol) {
			applied = true;
			return { lines: ["delegated"], cursorLine, cursorCol };
		},
	};
	const provider = createSkillAutocompleteProvider(dollarProvider, () => [project]);
	const suggestions = await provider.getSuggestions(["$zzz"], 0, 4, { signal: new AbortController().signal });
	assert.equal(suggestions?.items[0].value, "$other");
	assert.deepEqual(provider.applyCompletion(["$zzz"], 0, 4, suggestions!.items[0], suggestions!.prefix), { lines: ["delegated"], cursorLine: 0, cursorCol: 4 });
	assert.ok(applied);
});

test("single tag emits Pi core's parseable block and tag-only input has no user message", async () => {
	const expanded = await expandSkillTags("$[project-one]", [project], loadSkill);
	const parsed = parseSkillBlock(expanded);
	assert.deepEqual(parsed, {
		name: "project-one",
		location: project.path,
		content: "References are relative to /repo/.pi/skills/project-one.\n\nProject body",
		userMessage: undefined,
	});
	assert.ok(!expanded.includes("description: x"));
});

test("inline tag becomes a readable skill name without leaking its body into user text", async () => {
	const parsed = parseSkillBlock(await expandSkillTags("Use $[project-one] now.", [project], loadSkill));
	assert.ok(parsed);
	assert.equal(parsed.userMessage, "Use project-one now.");
	assert.ok(parsed.content.includes("Project body"));
	assert.ok(!parsed.userMessage?.includes("Project body"));
	assert.ok(!parsed.userMessage?.includes("<skill"));
});

test("multiple unique tags emit one aggregate parseable block with separated sections", async () => {
	const odd: SkillCommand = { name: "odd", path: "/tmp/a&b/SKILL.md", scope: "project" };
	const content = { ...skillContent, [odd.path]: "Odd body" };
	const expanded = await expandSkillTags(
		"Start $[project-one], then $[odd]; keep $[missing].",
		[project, odd],
		async (filePath) => content[filePath],
	);
	const parsed = parseSkillBlock(expanded);
	assert.ok(parsed);
	assert.equal(parsed.name, "project-one + odd");
	assert.equal(parsed.location, "multiple skills");
	assert.match(parsed.content, /Name: project-one\nPath: \/repo\/\.pi\/skills\/project-one\/SKILL\.md\nBase directory: \/repo\/\.pi\/skills\/project-one\nBody:\nProject body/);
	assert.match(parsed.content, /---\n\nName: odd\nPath: \/tmp\/a&b\/SKILL\.md\nBase directory: \/tmp\/a&b\nBody:\nOdd body/);
	assert.equal(parsed.userMessage, "Start project-one, then odd; keep $[missing].");
	assert.equal((expanded.match(/<\/skill>/g) ?? []).length, 1, "aggregate has only its top-level closing tag");
	assert.ok(!parsed.userMessage.includes("Odd body"));
});

test("repeated tags load and include a skill once and omit redundant tag-only text", async () => {
	let loads = 0;
	const expanded = await expandSkillTags("$[project-one] $[project-one]", [project], async (filePath) => {
		loads++;
		return loadSkill(filePath);
	});
	const parsed = parseSkillBlock(expanded);
	assert.ok(parsed);
	assert.equal(loads, 1);
	assert.equal(parsed.userMessage, undefined);
	assert.equal((parsed.content.match(/Project body/g) ?? []).length, 1);
});

test("unknown and unreadable tags stay unchanged", async () => {
	assert.equal(await expandSkillTags("Use $[missing].", [project], loadSkill), "Use $[missing].");
	assert.equal(await expandSkillTags("$[project-one]", [project], async () => { throw new Error("nope"); }), "$[project-one]");
	const mixed = parseSkillBlock(await expandSkillTags("$[project-one] and $[global-one]", [project, globalSkill], async (filePath) => {
		if (filePath === globalSkill.path) throw new Error("nope");
		return loadSkill(filePath);
	}));
	assert.equal(mixed?.userMessage, "project-one and $[global-one]");
});

test("editor lifecycle installs lazily on first skill autocomplete use and then rewraps editor-change events", async () => {
	const handlers = new Map<string, (...args: any[]) => any>();
	const eventHandlers = new Map<string, (payload: unknown) => void>();
	const events = {
		on(name: string, handler: (payload: unknown) => void) {
			eventHandlers.set(name, handler);
			return () => eventHandlers.delete(name);
		},
		emit(name: string, payload: unknown) { eventHandlers.get(name)?.(payload); },
	};
	const pi = {
		events,
		on: (name: string, handler: (...args: any[]) => any) => handlers.set(name, handler),
		getCommands: () => [{ name: "skill:project-one", description: "Project help", source: "skill", sourceInfo: { path: project.path, source: "skills", scope: "project", origin: "top-level" } }],
	} as any;
	const theme = {
		fg: (_token: string, text: string) => text,
		bg: (_token: string, text: string) => text,
	};
	const stockFactory = () => ({ render: () => ["$[project-one]"] });
	let current: any = stockFactory;
	let setCalls = 0;
	let autocompleteFactory: ((current: AutocompleteProvider) => AutocompleteProvider) | undefined;
	const ctx = {
		ui: {
			theme,
			getEditorComponent: () => current,
			setEditorComponent: (factory: any) => { current = factory; setCalls++; },
			addAutocompleteProvider: (factory: (current: AutocompleteProvider) => AutocompleteProvider) => {
				autocompleteFactory = factory;
			},
		},
	} as any;

	skillTags(pi);
	await handlers.get("session_start")?.({}, ctx);
	assert.equal(setCalls, 0, "session start should not wrap the editor eagerly");
	assert.equal(typeof (globalThis as Record<PropertyKey, unknown>)[EDITOR_RENDER_HOOK], "function", "session start restores owned hook");
	assert.equal(eventHandlers.has(EDITOR_COMPONENT_CHANGED_EVENT), false, "editor-change listener stays idle until wrapping is enabled");
	assert.ok(autocompleteFactory, "session start registers the autocomplete provider");

	const provider = autocompleteFactory!(fallback);
	await provider.getSuggestions(["$[proj"], 0, 6, { signal: new AbortController().signal });
	await new Promise((resolve) => setTimeout(resolve, 0));
	assert.equal(setCalls, 1, "first skill autocomplete use installs the wrapper lazily");
	assert.equal(current[SKILL_TAGS_EDITOR_FACTORY], true);
	assert.equal(eventHandlers.has(EDITOR_COMPONENT_CHANGED_EVENT), true, "lazy install also enables future rewraps");
	installSkillTagsEditor(ctx);
	assert.equal(setCalls, 1, "repeated install does not stack wrappers");

	const uiPackFactory = () => ({ render: () => ["$[project-one]"] });
	current = uiPackFactory;
	events.emit(EDITOR_COMPONENT_CHANGED_EVENT, ctx);
	assert.equal(setCalls, 2);
	assert.notEqual(current, uiPackFactory);
	assert.equal(current[SKILL_TAGS_EDITOR_FACTORY], true);
	const editor = current(undefined, undefined, undefined);
	assert.ok(editor.render(80)[0].includes("✦"), "changed current editor is decorated");

	await handlers.get("session_shutdown")?.({}, ctx);
	assert.equal((globalThis as Record<PropertyKey, unknown>)[EDITOR_RENDER_HOOK], undefined);
	assert.equal(eventHandlers.has(EDITOR_COMPONENT_CHANGED_EVENT), false, "shutdown removes owned editor-change listener");
	await handlers.get("session_start")?.({}, ctx);
	assert.equal(setCalls, 2, "session restart still keeps wrapping lazy");

	const foreignHook = () => ["foreign"];
	(globalThis as Record<PropertyKey, unknown>)[EDITOR_RENDER_HOOK] = foreignHook;
	await handlers.get("session_shutdown")?.({}, ctx);
	assert.equal((globalThis as Record<PropertyKey, unknown>)[EDITOR_RENDER_HOOK], foreignHook, "shutdown leaves a replacement hook owned by another extension");
	delete (globalThis as Record<PropertyKey, unknown>)[EDITOR_RENDER_HOOK];
});

test("renders equal-width chips without losing ANSI or cursor markers", () => {
	const theme = {
		fg: (token: string, text: string) => `\x1b[${token === "accent" ? 31 : 37}m${text}\x1b[39m`,
		bg: (_token: string, text: string) => `\x1b[44m${text}\x1b[49m`,
	};
	const raw = `x \x1b[2m$[pro${CURSOR_MARKER}\x1b[7mject-one\x1b[27m]\x1b[22m y $[unknown]`;
	const decorated = decorateSkillTags(raw, new Set(["project-one"]), theme);
	assert.equal(visibleWidth(decorated), visibleWidth(raw));
	assert.ok(decorated.includes(CURSOR_MARKER));
	assert.ok(decorated.includes("\x1b[7m"));
	assert.ok(decorated.includes("\x1b[27m"));
	assert.ok(decorated.includes("$[unknown]"));
	assert.ok(decorated.includes("✦"));
	assert.equal(decorateSkillTags(decorated, new Set(["project-one"]), theme), decorated, "decoration is idempotent");
});
