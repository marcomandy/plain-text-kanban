import {App, PluginSettingTab, Setting} from 'obsidian';
import type KanbanPlugin from './main';

export interface KanbanPluginSettings {
	hideCardCounter: boolean;
	hideAddLabelButtons: boolean;
	hideAddDescription: boolean;
	hoverOnlyButtons: boolean;
	hideSwimlanes: boolean;
}

export const DEFAULT_SETTINGS: KanbanPluginSettings = {
	hideCardCounter: false,
	hideAddLabelButtons: false,
	hideAddDescription: false,
	hoverOnlyButtons: false,
	hideSwimlanes: false,
};

/** Per-board overrides — every key is optional (absent = use global default). */
export type BoardViewOverrides = Partial<KanbanPluginSettings>;

/** Shape of what we persist via saveData / loadData. */
export interface PersistedData extends KanbanPluginSettings {
	boardSettings?: Record<string, BoardViewOverrides>;
}

/** Resolve effective settings for a board by merging global defaults with per-board overrides. */
export function resolveSettings(global: KanbanPluginSettings, overrides?: BoardViewOverrides): KanbanPluginSettings {
	if (!overrides) return {...global};
	return {...global, ...overrides};
}

export class KanbanSettingTab extends PluginSettingTab {
	plugin: KanbanPlugin;

	constructor(app: App, plugin: KanbanPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const {containerEl} = this;
		containerEl.empty();

		new Setting(containerEl)
			.setName('Hide card counter')
			.setDesc('Hide the card count badge on each column.')
			.addToggle(toggle =>
				toggle
					.setValue(this.plugin.settings.hideCardCounter)
					.onChange(async (value) => {
						this.plugin.settings.hideCardCounter = value;
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName('Hide "Add label" buttons')
			.setDesc('Hide the "+ Add label" button on cards.')
			.addToggle(toggle =>
				toggle
					.setValue(this.plugin.settings.hideAddLabelButtons)
					.onChange(async (value) => {
						this.plugin.settings.hideAddLabelButtons = value;
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName('Hide "Add description"')
			.setDesc('Hide the "Add description..." placeholder on cards.')
			.addToggle(toggle =>
				toggle
					.setValue(this.plugin.settings.hideAddDescription)
					.onChange(async (value) => {
						this.plugin.settings.hideAddDescription = value;
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName('Show buttons on hover only')
			.setDesc('Show archive and delete buttons for columns and cards only when hovering.')
			.addToggle(toggle =>
				toggle
					.setValue(this.plugin.settings.hoverOnlyButtons)
					.onChange(async (value) => {
						this.plugin.settings.hoverOnlyButtons = value;
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName('Hide swimlanes')
			.setDesc('Hide the swimlane UI and show a single unfiltered board.')
			.addToggle(toggle =>
				toggle
					.setValue(this.plugin.settings.hideSwimlanes)
					.onChange(async (value) => {
						this.plugin.settings.hideSwimlanes = value;
						await this.plugin.saveSettings();
					})
			);
	}
}
