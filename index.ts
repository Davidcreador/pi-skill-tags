import {
	CustomEditor,
	type ExtensionAPI,
	type ExtensionContext,
	type Theme,
} from "@earendil-works/pi-coding-agent";
import { matchesKey, type EditorComponent } from "@earendil-works/pi-tui";
import {
	createSkillAutocompleteProvider,
	decorateEditorLines,
	deleteSkillTagAtCursor,
	EDITOR_COMPONENT_CHANGED_EVENT,
	EDITOR_RENDER_HOOK,
	expandSkillTags,
	extractSkillPrefix,
	getSkillCommands,
	SKILL_TAGS_EDITOR_FACTORY,
	type SkillCommand,
} from "./skill-tags.ts";

type RenderHook = (lines: string[], theme: Theme) => string[];
type EditorFactory = NonNullable<ReturnType<ExtensionContext["ui"]["getEditorComponent"]>>;
type MarkedEditorFactory = EditorFactory & { [SKILL_TAGS_EDITOR_FACTORY]?: true };
type WrappedEditor = EditorComponent & {
	focused?: boolean;
	wantsKeyRelease?: boolean;
	borderColor?: ((str: string) => string) | undefined;
	onSubmit?: ((text: string) => void) | undefined;
	onChange?: ((text: string) => void) | undefined;
	addToHistory?: (text: string) => void;
	insertTextAtCursor?: (text: string) => void;
	getExpandedText?: () => string;
	setAutocompleteProvider?: (provider: unknown) => void;
	setPaddingX?: (padding: number) => void;
	setAutocompleteMaxVisible?: (maxVisible: number) => void;
	onEscape?: (() => void) | undefined;
	onCtrlD?: (() => void) | undefined;
	onPasteImage?: (() => void) | undefined;
	onExtensionShortcut?: ((data: string) => boolean) | undefined;
	actionHandlers?: Map<string, () => void>;
	onAction?: (action: string, handler: () => void) => void;
	autocompleteState?: unknown;
	tryTriggerAutocomplete?: (explicitTab?: boolean) => void;
	pushUndoSnapshot?: () => void;
	setCursorCol?: (col: number) => void;
	cancelAutocomplete?: () => void;
	exitHistoryBrowsing?: () => void;
	lastAction?: unknown;
	state?: {
		lines?: string[];
		cursorLine?: number;
		cursorCol?: number;
	};
};

function getTextBeforeCursor(editor: WrappedEditor): string | undefined {
	return typeof editor.state?.cursorLine === "number" && typeof editor.state?.cursorCol === "number"
		? (editor.state.lines?.[editor.state.cursorLine] ?? "").slice(0, editor.state.cursorCol)
		: undefined;
}

export class SkillTagsEditorWrapper implements EditorComponent {
	private readonly inner: WrappedEditor;
	private readonly theme: Theme;
	private readonly keybindings: { matches(data: string, action: string): boolean };
	private readonly getKnownSkillNames: () => ReadonlySet<string>;
	private fallbackFocused = false;
	private readonly fallbackActionHandlers = new Map<string, () => void>();

	constructor(
		inner: WrappedEditor,
		theme: Theme,
		keybindings: { matches(data: string, action: string): boolean },
		getKnownSkillNames: () => ReadonlySet<string> = () => liveSkillNames,
	) {
		this.inner = inner;
		this.theme = theme;
		this.keybindings = keybindings;
		this.getKnownSkillNames = getKnownSkillNames;
	}

	get focused(): boolean {
		return typeof this.inner.focused === "boolean" ? this.inner.focused : this.fallbackFocused;
	}

	set focused(value: boolean) {
		this.fallbackFocused = value;
		if ("focused" in this.inner) {
			this.inner.focused = value;
		}
	}

	get wantsKeyRelease(): boolean {
		return this.inner.wantsKeyRelease ?? false;
	}

	get borderColor() {
		return this.inner.borderColor;
	}

	set borderColor(value) {
		this.inner.borderColor = value;
	}

	get onSubmit() {
		return this.inner.onSubmit;
	}

	set onSubmit(value) {
		this.inner.onSubmit = value;
	}

	get onChange() {
		return this.inner.onChange;
	}

	set onChange(value) {
		this.inner.onChange = value;
	}

	get onEscape() {
		return this.inner.onEscape;
	}

	set onEscape(value) {
		this.inner.onEscape = value;
	}

	get onCtrlD() {
		return this.inner.onCtrlD;
	}

	set onCtrlD(value) {
		this.inner.onCtrlD = value;
	}

	get onPasteImage() {
		return this.inner.onPasteImage;
	}

	set onPasteImage(value) {
		this.inner.onPasteImage = value;
	}

	get onExtensionShortcut() {
		return this.inner.onExtensionShortcut;
	}

	set onExtensionShortcut(value) {
		this.inner.onExtensionShortcut = value;
	}

	get actionHandlers() {
		return this.inner.actionHandlers ?? this.fallbackActionHandlers;
	}

	onAction(action: string, handler: () => void): void {
		if (typeof this.inner.onAction === "function") {
			this.inner.onAction(action, handler);
			return;
		}
		this.actionHandlers.set(action, handler);
	}

	render(width: number): string[] {
		return decorateEditorLines(this.inner.render(width), liveSkillNames, this.theme);
	}

	handleInput(data: string): void {
		const backward = this.keybindings.matches(data, "tui.editor.deleteCharBackward") || matchesKey(data, "shift+backspace");
		const forward = this.keybindings.matches(data, "tui.editor.deleteCharForward") || matchesKey(data, "shift+delete");
		if ((backward || forward) && this.deleteSkillTag(backward ? "backward" : "forward")) return;

		const beforeCursor = getTextBeforeCursor(this.inner);
		if (
			beforeCursor !== undefined &&
			extractSkillPrefix(beforeCursor) !== undefined &&
			!this.inner.autocompleteState &&
			typeof this.inner.tryTriggerAutocomplete === "function" &&
			this.keybindings.matches(data, "tui.input.tab")
		) {
			this.inner.tryTriggerAutocomplete(true);
			return;
		}
		this.inner.handleInput(data);
	}

	private deleteSkillTag(direction: "backward" | "forward"): boolean {
		const state = this.inner.state;
		if (
			!state ||
			!Array.isArray(state.lines) ||
			typeof state.cursorLine !== "number" ||
			typeof state.cursorCol !== "number" ||
			typeof this.inner.pushUndoSnapshot !== "function" ||
			typeof this.inner.setCursorCol !== "function"
		) {
			return false;
		}

		const result = deleteSkillTagAtCursor(
			state.lines,
			state.cursorLine,
			state.cursorCol,
			direction,
			this.getKnownSkillNames(),
		);
		if (!result) return false;

		this.inner.cancelAutocomplete?.();
		this.inner.exitHistoryBrowsing?.();
		this.inner.lastAction = null;
		this.inner.pushUndoSnapshot();
		state.lines = result.lines;
		state.cursorLine = result.cursorLine;
		this.inner.setCursorCol(result.cursorCol);
		this.inner.onChange?.(this.inner.getText());
		return true;
	}

	getText(): string {
		return this.inner.getText();
	}

	setText(text: string): void {
		this.inner.setText(text);
	}

	invalidate(): void {
		this.inner.invalidate();
	}

	addToHistory(text: string): void {
		this.inner.addToHistory?.(text);
	}

	insertTextAtCursor(text: string): void {
		this.inner.insertTextAtCursor?.(text);
	}

	getExpandedText(): string {
		return this.inner.getExpandedText?.() ?? this.inner.getText();
	}

	setAutocompleteProvider(provider: unknown): void {
		this.inner.setAutocompleteProvider?.(provider);
	}

	setPaddingX(padding: number): void {
		this.inner.setPaddingX?.(padding);
	}

	setAutocompleteMaxVisible(maxVisible: number): void {
		this.inner.setAutocompleteMaxVisible?.(maxVisible);
	}
}

export function wrapEditorFactory(factory: EditorFactory | undefined, theme: Theme): EditorFactory {
	if ((factory as MarkedEditorFactory | undefined)?.[SKILL_TAGS_EDITOR_FACTORY]) return factory!;
	const wrapped: MarkedEditorFactory = (tui, editorTheme, keybindings) => {
		const editor: WrappedEditor = (factory?.(tui, editorTheme, keybindings) ?? new CustomEditor(tui, editorTheme, keybindings)) as WrappedEditor;
		return new SkillTagsEditorWrapper(editor, theme, keybindings);
	};
	Object.defineProperty(wrapped, SKILL_TAGS_EDITOR_FACTORY, { value: true });
	return wrapped;
}

export function installSkillTagsEditor(ctx: ExtensionContext): void {
	const current = ctx.ui.getEditorComponent();
	if ((current as MarkedEditorFactory | undefined)?.[SKILL_TAGS_EDITOR_FACTORY]) return;
	ctx.ui.setEditorComponent(wrapEditorFactory(current, ctx.ui.theme));
}

let liveSkills: SkillCommand[] = [];
let liveSkillNames: ReadonlySet<string> = new Set();
const renderHook: RenderHook = (lines, theme) => decorateEditorLines(lines, liveSkillNames, theme);

const EDITOR_CHANGED_LISTENER = Symbol.for("skill-tags.editorChangedListener");

export default function (pi: ExtensionAPI): void {
	const hooks = globalThis as Record<PropertyKey, unknown>;
	hooks[EDITOR_RENDER_HOOK] = renderHook;

	let disposeEditorChanged: (() => void) | undefined;
	let wrapScheduled = false;
	let wrapInstalled = false;
	let wrapTimer: ReturnType<typeof setTimeout> | undefined;

	const hasInstalledEditorWrapper = (ctx: ExtensionContext): boolean => {
		const current = ctx.ui.getEditorComponent() as MarkedEditorFactory | undefined;
		return current?.[SKILL_TAGS_EDITOR_FACTORY] === true;
	};

	const bindEditorChanged = () => {
		if (disposeEditorChanged && hooks[EDITOR_CHANGED_LISTENER] === disposeEditorChanged) return;
		const priorListener = hooks[EDITOR_CHANGED_LISTENER];
		if (typeof priorListener === "function") priorListener();
		disposeEditorChanged = pi.events.on(EDITOR_COMPONENT_CHANGED_EVENT, (payload) => {
			try {
				installSkillTagsEditor(payload as ExtensionContext);
			} catch {
				// A stale session context can outlive its editor-change event.
			}
		});
		hooks[EDITOR_CHANGED_LISTENER] = disposeEditorChanged;
	};

	const ensureEditorWrapperLater = (ctx: ExtensionContext) => {
		if (wrapInstalled || wrapScheduled || hasInstalledEditorWrapper(ctx)) {
			wrapInstalled = wrapInstalled || hasInstalledEditorWrapper(ctx);
			if (wrapInstalled) bindEditorChanged();
			return;
		}
		wrapScheduled = true;
		wrapTimer = setTimeout(() => {
			wrapScheduled = false;
			if (wrapInstalled || hasInstalledEditorWrapper(ctx)) {
				wrapInstalled = true;
				bindEditorChanged();
				return;
			}
			try {
				installSkillTagsEditor(ctx);
				wrapInstalled = true;
				bindEditorChanged();
			} catch {
				// Ignore stale-session / UI timing issues; the next skill use can try again.
			}
		}, 0);
	};

	pi.on("session_start", (_event, ctx) => {
		hooks[EDITOR_RENDER_HOOK] = renderHook;
		liveSkills = getSkillCommands(pi.getCommands());
		liveSkillNames = new Set(liveSkills.map((skill) => skill.name));
		wrapScheduled = false;
		wrapInstalled = hasInstalledEditorWrapper(ctx);
		if (wrapInstalled) bindEditorChanged();
		ctx.ui.addAutocompleteProvider((current) => {
			const provider = createSkillAutocompleteProvider(current, () => liveSkills);
			return {
				...provider,
				async getSuggestions(lines, cursorLine, cursorCol, options) {
					const line = lines[cursorLine] ?? "";
					const beforeCursor = line.slice(0, cursorCol);
					if (extractSkillPrefix(beforeCursor) !== undefined) ensureEditorWrapperLater(ctx);
					return provider.getSuggestions(lines, cursorLine, cursorCol, options);
				},
			};
		});
	});

	pi.on("input", async (event) => {
		if (event.source === "extension" || !event.text.includes("$[")) return { action: "continue" };
		const expanded = await expandSkillTags(event.text, liveSkills);
		return expanded === event.text
			? { action: "continue" }
			: { action: "transform", text: expanded, images: event.images };
	});

	pi.on("session_shutdown", () => {
		if (wrapTimer) clearTimeout(wrapTimer);
		wrapTimer = undefined;
		wrapScheduled = false;
		wrapInstalled = false;
		if (hooks[EDITOR_RENDER_HOOK] === renderHook) delete hooks[EDITOR_RENDER_HOOK];
		if (disposeEditorChanged && hooks[EDITOR_CHANGED_LISTENER] === disposeEditorChanged) {
			disposeEditorChanged();
			delete hooks[EDITOR_CHANGED_LISTENER];
		}
	});
}
