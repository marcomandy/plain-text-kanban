import {MarkdownView, Plugin, TFile, Menu} from 'obsidian';
import {KanbanView, KANBAN_VIEW_TYPE} from './kanban-view';
import {KanbanPluginSettings, DEFAULT_SETTINGS, KanbanSettingTab} from './settings';

export default class KanbanPlugin extends Plugin {
	settings: KanbanPluginSettings = DEFAULT_SETTINGS;

	async onload() {
		await this.loadSettings();

		this.registerView(KANBAN_VIEW_TYPE, (leaf) => new KanbanView(leaf, this));

		this.addSettingTab(new KanbanSettingTab(this.app, this));

		this.addCommand({
			id: 'open-as-kanban',
			name: 'Open current file as kanban board',
			checkCallback: (checking) => {
				const view = this.app.workspace.getActiveViewOfType(MarkdownView);
				if (view?.file) {
					if (!checking) {
						this.openAsKanban(view.file.path);
					}
					return true;
				}
				return false;
			},
		});

		this.registerEvent(
			this.app.workspace.on('file-menu', (menu: Menu, file) => {
				if (file instanceof TFile && file.extension === 'md') {
					menu.addItem((item) => {
						item
							.setTitle('Open as kanban board')
							.setIcon('columns-3')
							.onClick(() => this.openAsKanban(file.path));
					});
				}
			})
		);
	}

	private openAsKanban(filePath: string): void {
		this.app.workspace.getLeaf(false).setViewState({
			type: KANBAN_VIEW_TYPE,
			state: {file: filePath},
		});
	}

	async loadSettings(): Promise<void> {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
	}

	async saveSettings(): Promise<void> {
		await this.saveData(this.settings);
		this.app.workspace.getLeavesOfType(KANBAN_VIEW_TYPE).forEach(leaf => {
			if (leaf.view instanceof KanbanView) {
				leaf.view.refreshSettings();
			}
		});
	}
}
