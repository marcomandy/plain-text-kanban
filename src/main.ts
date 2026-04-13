import {MarkdownView, Plugin, TFile, Menu} from 'obsidian';
import {KanbanView, KANBAN_VIEW_TYPE} from './kanban-view';
import {KanbanPluginSettings, BoardViewSettings, PersistedData} from './settings';

export default class KanbanPlugin extends Plugin {
	boardSettings: Record<string, BoardViewSettings> = {};

	async onload() {
		await this.loadSettings();

		this.registerView(KANBAN_VIEW_TYPE, (leaf) => new KanbanView(leaf, this));

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
		void this.app.workspace.getLeaf(false).setViewState({
			type: KANBAN_VIEW_TYPE,
			state: {file: filePath},
		});
	}

	async loadSettings(): Promise<void> {
		const raw: PersistedData = (await this.loadData()) ?? {};
		this.boardSettings = raw.boardSettings ?? {};
	}

	async saveSettings(): Promise<void> {
		const data: PersistedData = {boardSettings: this.boardSettings};
		await this.saveData(data);
		this.app.workspace.getLeavesOfType(KANBAN_VIEW_TYPE).forEach(leaf => {
			if (leaf.view instanceof KanbanView) {
				leaf.view.refreshSettings();
			}
		});
	}

	getBoardSettings(filePath: string): BoardViewSettings {
		return this.boardSettings[filePath] ?? {};
	}

	async setBoardSetting(filePath: string, key: keyof KanbanPluginSettings, value: boolean): Promise<void> {
		if (!this.boardSettings[filePath]) {
			this.boardSettings[filePath] = {};
		}
		(this.boardSettings[filePath] as Record<string, boolean>)[key] = value;
		await this.saveSettings();
	}
}
