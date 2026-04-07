import {KanbanBoard} from './types';

export function serializeKanban(board: KanbanBoard): string {
	const lines: string[] = [];

	// Serialize label colors as a hidden comment
	if (Object.keys(board.labelColors).length > 0) {
		lines.push(`<!-- kanban-labels: ${JSON.stringify(board.labelColors)} -->`);
	}

	for (const column of board.columns) {
		const colTitle = column.archived ? `${column.title} __archived__` : column.title;
		lines.push(`- # ${colTitle}`);

		for (const card of column.cards) {
			lines.push(`\t- ## ${card.title}`);

			for (const bodyLine of card.rawBodyLines) {
				lines.push(bodyLine);
			}
		}
	}

	return lines.join('\n');
}
