import {MarkdownView, Plugin} from 'obsidian';
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
						const filePath = view.file.path;
						this.app.workspace.getLeaf(false).setViewState({
							type: KANBAN_VIEW_TYPE,
							state: {file: filePath},
						});
					}
					return true;
				}
				return false;
			},
		});
	}
}
