import {KanbanBoard, KanbanColumn, KanbanCard} from './types';

const LABEL_COLORS_RE = /^<!--\s*kanban-labels:\s*(\{.*\})\s*-->$/;

export function parseKanban(content: string): KanbanBoard {
	const lines = content.split('\n');
	const columns: KanbanColumn[] = [];
	let currentColumn: KanbanColumn | null = null;
	let currentCard: KanbanCard | null = null;
	let labelColors: Record<string, string> = {};

	for (const line of lines) {
		const labelMatch = line.match(LABEL_COLORS_RE);
		if (labelMatch?.[1]) {
			try {
				const raw = JSON.parse(labelMatch[1]);
				for (const key of Object.keys(raw)) {
					labelColors[key.toLowerCase()] = raw[key];
				}
			} catch { /* ignore malformed */ }
			continue;
		}

		const columnMatch = line.match(/^- # (.+)/);
		if (columnMatch?.[1]) {
			currentCard = null;
			let title = columnMatch[1];
			let archived = false;
			if (title.endsWith(' __archived__')) {
				title = title.slice(0, -' __archived__'.length);
				archived = true;
			}
			currentColumn = {title, cards: [], archived};
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

	return {columns, labelColors};
}
