import test from "node:test";
import assert from "node:assert/strict";
import { CustomEditor } from "@earendil-works/pi-coding-agent";
import { CURSOR_MARKER, KeybindingsManager, setKeybindings, TUI_KEYBINDINGS } from "@earendil-works/pi-tui";
import { SkillTagsEditorWrapper, wrapEditorFactory } from "../index.ts";
import { createSkillAutocompleteProvider, type SkillCommand } from "../skill-tags.ts";

const theme = { fg: (_token: string, text: string) => text, bg: (_token: string, text: string) => text } as any;
const tui = {} as any;
const editorTheme = {} as any;
const keybindings = {
	matches(data: string, action: string) {
		return action === "tui.input.tab" && data === "\t";
	},
} as any;

const baseProvider = {
	triggerCharacters: [],
	async getSuggestions() {
		return null;
	},
	applyCompletion(lines: string[], cursorLine: number, cursorCol: number) {
		return { lines, cursorLine, cursorCol };
	},
	shouldTriggerFileCompletion() {
		return true;
	},
};

const skills: SkillCommand[] = [
	{
		name: "dispatching-parallel-agents",
		description: "parallel agents",
		path: "/tmp/dispatching/SKILL.md",
		scope: "user",
	},
	{
		name: "speak-human-tw",
		description: "speak human",
		path: "/tmp/speak/SKILL.md",
		scope: "user",
	},
	{
		name: "ppt-master",
		description: "slides",
		path: "/tmp/ppt/SKILL.md",
		scope: "user",
	},
];

function makeEditorStub(text: string, overrides: Record<string, unknown> = {}) {
	const state = {
		lines: [text],
		cursorLine: 0,
		cursorCol: text.length,
	};
	return {
		render: (): string[] => [],
		handleInput: () => {},
		getText: () => state.lines.join("\n"),
		setText: (next: string) => {
			state.lines = [next];
			state.cursorLine = 0;
			state.cursorCol = next.length;
		},
		invalidate: () => {},
		state,
		...overrides,
	};
}

function makeWrappedCustomEditor(text: string, knownNames: string[]) {
	const manager = new KeybindingsManager(TUI_KEYBINDINGS);
	setKeybindings(manager);
	const inner = new CustomEditor(
		{ terminal: { rows: 24 }, requestRender() {} } as any,
		{ borderColor: (value: string) => value, selectList: {} } as any,
		manager as any,
	);
	inner.setText(text);
	return {
		inner,
		wrapper: new SkillTagsEditorWrapper(inner as any, theme, manager, () => new Set(knownNames)),
	};
}

test("wrapper forwards focus so cursor markers still render", () => {
	const inner = makeEditorStub("$[ppt-master]", {
		focused: false,
	}) as ReturnType<typeof makeEditorStub> & { focused: boolean; render: () => string[] };
	inner.render = () => [inner.focused ? `before${CURSOR_MARKER}after` : "beforeafter"];
	const wrapper = new SkillTagsEditorWrapper(inner as any, theme, keybindings);

	wrapper.focused = true;
	assert.equal((inner as any).focused, true);
	assert.ok(wrapper.render(80)[0].includes(CURSOR_MARKER));

	wrapper.focused = false;
	assert.equal((inner as any).focused, false);
	assert.ok(!wrapper.render(80)[0].includes(CURSOR_MARKER));
});

test("skill prefix Tab opens autocomplete instead of forwarding directly to editor", () => {
	let forwarded = 0;
	let triggered = 0;
	const wrappedFactory = wrapEditorFactory(() => makeEditorStub("$ppt-master", {
		handleInput: () => {
			forwarded += 1;
		},
		tryTriggerAutocomplete: (explicitTab: boolean) => {
			assert.equal(explicitTab, true);
			triggered += 1;
		},
		autocompleteState: null,
	}), theme);

	const editor = wrappedFactory(tui, editorTheme, keybindings);
	editor.handleInput("\t");

	assert.equal(triggered, 1);
	assert.equal(forwarded, 0);
});

test("wrapper deletes a completed skill chip in one Backspace and undo restores it", () => {
	const original = "Use $[ppt-master] ";
	const { wrapper } = makeWrappedCustomEditor(original, ["ppt-master"]);

	wrapper.handleInput("\x7f");
	assert.equal(wrapper.getText(), "Use ");

	wrapper.handleInput("\x1f");
	assert.equal(wrapper.getText(), original);
});

test("wrapper handles forward Delete at the start of a known skill tag", () => {
	const { inner, wrapper } = makeWrappedCustomEditor("Use $[ppt-master] now", ["ppt-master"]);
	inner.handleInput("\x1b[H");
	for (let index = 0; index < "Use ".length; index++) inner.handleInput("\x1b[C");

	wrapper.handleInput("\x1b[3~");
	assert.equal(wrapper.getText(), "Use  now");
});

test("wrapper delegates deletion for tags that are not loaded skills", () => {
	const { wrapper } = makeWrappedCustomEditor("$[unknown]", []);

	wrapper.handleInput("\x7f");
	assert.equal(wrapper.getText(), "$[unknown");
});

test("fuzzy ranking prefers speak-human-tw for $sp", async () => {
	const provider = createSkillAutocompleteProvider(baseProvider, () => skills);
	const suggestions = await provider.getSuggestions(["$sp"], 0, 3, { signal: new AbortController().signal });

	assert.ok(suggestions);
	assert.equal(suggestions.items[0]?.value, "speak-human-tw");
});

test("fuzzy matching finds hyphenated skill names from compact queries", async () => {
	const provider = createSkillAutocompleteProvider(baseProvider, () => skills);
	const suggestions = await provider.getSuggestions(["$pptm"], 0, 5, { signal: new AbortController().signal });

	assert.ok(suggestions);
	assert.equal(suggestions.items[0]?.value, "ppt-master");
});

test("Tab falls through once autocomplete is already open", () => {
	let forwarded = 0;
	let triggered = 0;
	const wrappedFactory = wrapEditorFactory(() => makeEditorStub("$ppt-master", {
		handleInput: () => {
			forwarded += 1;
		},
		tryTriggerAutocomplete: () => {
			triggered += 1;
		},
		autocompleteState: "regular",
	}), theme);

	const editor = wrappedFactory(tui, editorTheme, keybindings);
	editor.handleInput("\t");

	assert.equal(triggered, 0);
	assert.equal(forwarded, 1);
});
