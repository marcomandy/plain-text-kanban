import {MarkdownView, Plugin, TFile, Menu} from 'obsidian';
import {KanbanView, KANBAN_VIEW_TYPE} from './kanban-view';

export default class KanbanPlugin extends Plugin {
	async onload() {
		this.registerView(KANBAN_VIEW_TYPE, (leaf) => new KanbanView(leaf));

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
}
