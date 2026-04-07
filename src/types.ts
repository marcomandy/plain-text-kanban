export const NO_LABEL_TOKEN = '__no_label__';

export interface KanbanCard {
	title: string;
	rawBodyLines: string[];
}

export interface KanbanColumn {
	title: string;
	cards: KanbanCard[];
	archived?: boolean;
}

export interface Swimlane {
	labels: string[];
}

export interface KanbanBoard {
	columns: KanbanColumn[];
	labelColors: Record<string, string>;
	swimlanes: Swimlane[];
}
