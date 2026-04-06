export interface KanbanCard {
	title: string;
	rawBodyLines: string[];
}

export interface KanbanColumn {
	title: string;
	cards: KanbanCard[];
}

export interface KanbanBoard {
	columns: KanbanColumn[];
	labelColors: Record<string, string>;
}
