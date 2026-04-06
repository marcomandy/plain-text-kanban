import {KanbanBoard} from './types';

export function serializeKanban(board: KanbanBoard): string {
	const lines: string[] = [];

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
