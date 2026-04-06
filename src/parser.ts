import {KanbanBoard, KanbanColumn, KanbanCard} from './types';

export function parseKanban(content: string): KanbanBoard {
	const lines = content.split('\n');
	const columns: KanbanColumn[] = [];
	let currentColumn: KanbanColumn | null = null;
	let currentCard: KanbanCard | null = null;

	for (const line of lines) {
		const columnMatch = line.match(/^- # (.+)/);
		if (columnMatch?.[1]) {
			currentCard = null;
			currentColumn = {title: columnMatch[1], cards: []};
			columns.push(currentColumn);
			continue;
		}

		const cardMatch = line.match(/^\t- ## (.+)/);
		if (cardMatch?.[1] && currentColumn) {
			currentCard = {title: cardMatch[1], rawBodyLines: []};
			currentColumn.cards.push(currentCard);
			continue;
		}

		if (currentCard) {
			currentCard.rawBodyLines.push(line);
		}
	}

	// Trim trailing empty lines from each card body
	for (const column of columns) {
		for (const card of column.cards) {
			while (card.rawBodyLines.length > 0 &&
				card.rawBodyLines[card.rawBodyLines.length - 1]?.trim() === '') {
				card.rawBodyLines.pop();
			}
		}
	}

	return {columns};
}
