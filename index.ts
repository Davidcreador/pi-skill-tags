import {
	CustomEditor,
	type ExtensionAPI,
	type ExtensionContext,
	type Theme,
} from "@earendil-works/pi-coding-agent";
import type { EditorComponent } from "@earendil-works/pi-tui";
import {
	createSkillAutocompleteProvider,
	decorateEditorLines,
	EDITOR_COMPONENT_CHANGED_EVENT,
	EDITOR_RENDER_HOOK,
	expandSkillTags,
	getSkillCommands,
	SKILL_TAGS_EDITOR_FACTORY,
	type SkillCommand,
} from "./skill-tags.ts";

type RenderHook = (lines: string[], theme: Theme) => string[];
type EditorFactory = NonNullable<ReturnType<ExtensionContext["ui"]["getEditorComponent"]>>;
type MarkedEditorFactory = EditorFactory & { [SKILL_TAGS_EDITOR_FACTORY]?: true };

export function wrapEditorFactory(factory: EditorFactory | undefined, theme: Theme): EditorFactory {
	if ((factory as MarkedEditorFactory | undefined)?.[SKILL_TAGS_EDITOR_FACTORY]) return factory!;
	const wrapped: MarkedEditorFactory = (tui, editorTheme, keybindings) => {
		const editor: EditorComponent = factory?.(tui, editorTheme, keybindings) ?? new CustomEditor(tui, editorTheme, keybindings);
		return new Proxy(editor, {
			get(target, property) {
				if (property === "render") {
					return (width: number) => decorateEditorLines(target.render(width), liveSkillNames, theme);
				}
				const value = Reflect.get(target, property, target);
				return typeof value === "function" ? value.bind(target) : value;
			},
			set(target, property, value) {
				return Reflect.set(target, property, value, target);
			},
		}) as EditorComponent;
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
	bindEditorChanged();

	pi.on("session_start", (_event, ctx) => {
		hooks[EDITOR_RENDER_HOOK] = renderHook;
		bindEditorChanged();
		liveSkills = getSkillCommands(pi.getCommands());
		liveSkillNames = new Set(liveSkills.map((skill) => skill.name));
		ctx.ui.addAutocompleteProvider((current) => createSkillAutocompleteProvider(current, () => liveSkills));
		installSkillTagsEditor(ctx);
	});

	pi.on("input", async (event) => {
		if (event.source === "extension" || !event.text.includes("$[")) return { action: "continue" };
		const expanded = await expandSkillTags(event.text, liveSkills);
		return expanded === event.text
			? { action: "continue" }
			: { action: "transform", text: expanded, images: event.images };
	});

	pi.on("session_shutdown", () => {
		if (hooks[EDITOR_RENDER_HOOK] === renderHook) delete hooks[EDITOR_RENDER_HOOK];
		if (disposeEditorChanged && hooks[EDITOR_CHANGED_LISTENER] === disposeEditorChanged) {
			disposeEditorChanged();
			delete hooks[EDITOR_CHANGED_LISTENER];
		}
	});
}
