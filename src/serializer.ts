import {KanbanBoard} from './types';

export function serializeKanban(board: KanbanBoard): string {
	const lines: string[] = [];

	// Serialize label colors as a hidden comment
	if (Object.keys(board.labelColors).length > 0) {
		lines.push(`<!-- kanban-labels: ${JSON.stringify(board.labelColors)} -->`);
	}

	for (const column of board.columns) {
		lines.push(`- # ${column.title}`);

		for (const card of column.cards) {
			lines.push(`\t- ## ${card.title}`);

			for (const bodyLine of card.rawBodyLines) {
				lines.push(bodyLine);
			}
		}
	}

	return lines.join('\n');
}
