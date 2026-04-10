export interface KanbanPluginSettings {
	hideCardCounter: boolean;
	hideAddLabelButtons: boolean;
	hideAddDescription: boolean;
	hideAddChecklist: boolean;
	hoverOnlyButtons: boolean;
	hideSwimlanes: boolean;
}

export const DEFAULT_SETTINGS: KanbanPluginSettings = {
	hideCardCounter: false,
	hideAddLabelButtons: false,
	hideAddDescription: false,
	hideAddChecklist: false,
	hoverOnlyButtons: false,
	hideSwimlanes: false,
};

/** Per-board view settings — every key is optional (absent = use default). */
export type BoardViewSettings = Partial<KanbanPluginSettings>;

/** Shape of what we persist via saveData / loadData. */
export interface PersistedData {
	boardSettings?: Record<string, BoardViewSettings>;
}

/** Resolve effective settings for a board by merging defaults with per-board values. */
export function resolveSettings(overrides?: BoardViewSettings): KanbanPluginSettings {
	if (!overrides) return {...DEFAULT_SETTINGS};
	return {...DEFAULT_SETTINGS, ...overrides};
}
