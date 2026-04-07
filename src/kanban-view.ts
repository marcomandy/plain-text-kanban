import {ItemView, WorkspaceLeaf, TFile, MarkdownRenderer, Component, ViewStateResult, Scope, setIcon} from 'obsidian';
import {KanbanBoard, KanbanColumn, KanbanCard} from './types';
import {parseKanban} from './parser';
import {serializeKanban} from './serializer';
import type KanbanPlugin from './main';

export const KANBAN_VIEW_TYPE = 'plain-text-kanban';

interface DragState {
	type: 'card' | 'column';
	sourceColIndex: number;
	sourceCardIndex: number;
}

export class KanbanView extends ItemView {
	private board: KanbanBoard = {columns: [], labelColors: {}};
	private filePath = '';
	private isWriting = false;
	private dragState: DragState | null = null;
	private renderChild: Component | null = null;
	private undoStack: string[] = [];
	private redoStack: string[] = [];
	private dragPlaceholder: HTMLElement | null = null;
	private static readonly MAX_HISTORY = 50;

	constructor(leaf: WorkspaceLeaf, private plugin: KanbanPlugin) {
		super(leaf);
	}

	getViewType(): string {
		return KANBAN_VIEW_TYPE;
	}

	getDisplayText(): string {
		const file = this.filePath
			? this.app.vault.getAbstractFileByPath(this.filePath)
			: null;
		return file ? `Kanban: ${file.name}` : 'Kanban Board';
	}

	getIcon(): string {
		return 'columns-3';
	}

	async onOpen(): Promise<void> {
		this.contentEl.addClass('kanban-view-content');

		this.scope = new Scope(this.app.scope);

		this.addAction('file-text', 'View as markdown', () => {
			this.leaf.setViewState({
				type: 'markdown',
				state: {file: this.filePath},
			});
		});

		this.registerEvent(
			this.app.vault.on('modify', (file) => {
				if (file instanceof TFile && file.path === this.filePath && !this.isWriting) {
					this.loadAndRender();
				}
			})
		);

		this.scope.register(['Mod'], 'z', (e) => {
			e.preventDefault();
			this.undo();
			return false;
		});
		this.scope.register(['Mod', 'Shift'], 'z', (e) => {
			e.preventDefault();
			this.redo();
			return false;
		});
		this.scope.register(['Mod'], 'y', (e) => {
			e.preventDefault();
			this.redo();
			return false;
		});
	}

	async onClose(): Promise<void> {
		if (this.renderChild) {
			this.removeChild(this.renderChild);
			this.renderChild = null;
		}
		this.contentEl.empty();
	}

	async setState(state: unknown, result: ViewStateResult): Promise<void> {
		const s = state as Record<string, unknown> | null;
		if (s?.file && typeof s.file === 'string') {
			this.filePath = s.file;
			await this.loadAndRender();
		}
		await super.setState(state, result);
	}

	getState(): Record<string, unknown> {
		return {file: this.filePath};
	}

	refreshSettings(): void {
		this.render();
	}

	private async loadAndRender(): Promise<void> {
		const file = this.app.vault.getAbstractFileByPath(this.filePath);
		if (!(file instanceof TFile)) return;

		const content = await this.app.vault.read(file);
		this.board = parseKanban(content);
		await this.render();
	}

	private async saveBoard(): Promise<void> {
		const file = this.app.vault.getAbstractFileByPath(this.filePath);
		if (!(file instanceof TFile)) return;

		this.isWriting = true;
		try {
			const content = serializeKanban(this.board);
			await this.app.vault.modify(file, content);
		} finally {
			setTimeout(() => {
				this.isWriting = false;
			}, 200);
		}
	}

	private pushUndo(): void {
		this.undoStack.push(serializeKanban(this.board));
		if (this.undoStack.length > KanbanView.MAX_HISTORY) {
			this.undoStack.shift();
		}
		this.redoStack.length = 0;
	}

	private async undo(): Promise<void> {
		if (this.undoStack.length === 0) return;
		this.redoStack.push(serializeKanban(this.board));
		const prev = this.undoStack.pop()!;
		this.board = parseKanban(prev);
		await this.saveBoard();
		await this.render();
	}

	private async redo(): Promise<void> {
		if (this.redoStack.length === 0) return;
		this.undoStack.push(serializeKanban(this.board));
		const next = this.redoStack.pop()!;
		this.board = parseKanban(next);
		await this.saveBoard();
		await this.render();
	}

	private async render(): Promise<void> {
		// Save scroll positions
		const existingBoard = this.contentEl.querySelector('.kanban-board') as HTMLElement | null;
		const savedScrollLeft = existingBoard?.scrollLeft ?? 0;
		const savedColumnScrollTops: number[] = [];
		if (existingBoard) {
			existingBoard.querySelectorAll('.kanban-column-body').forEach((body) => {
				savedColumnScrollTops.push((body as HTMLElement).scrollTop);
			});
		}

		// Clean up previous render components
		if (this.renderChild) {
			this.removeChild(this.renderChild);
		}
		this.renderChild = new Component();
		this.addChild(this.renderChild);

		const container = this.contentEl;
		container.empty();

		const boardEl = container.createDiv({cls: 'kanban-board'});

		const settings = this.plugin.settings;
		if (settings.hideCardCounter) boardEl.addClass('kanban-hide-counter');
		if (settings.hideAddLabelButtons) boardEl.addClass('kanban-hide-add-label');
		if (settings.hideAddDescription) boardEl.addClass('kanban-hide-add-description');
		if (settings.hoverOnlyButtons) boardEl.addClass('kanban-hover-buttons');

		if (this.board.columns.length === 0) {
			const addColBtn = boardEl.createDiv({cls: 'kanban-add-column-btn'});
			addColBtn.setText('+ Add column');
			addColBtn.addEventListener('click', () => this.addColumn());
			return;
		}

		const renderPromises: Promise<void>[] = [];
		this.board.columns.forEach((column, colIndex) => {
			if (!column.archived) {
				renderPromises.push(this.renderColumn(boardEl, column, colIndex));
			}
		});

		await Promise.all(renderPromises);

		this.setupBoardDropZone(boardEl);

		// Add column button
		const addColBtn = boardEl.createDiv({cls: 'kanban-add-column-btn'});
		addColBtn.setText('+ Add column');
		addColBtn.addEventListener('click', () => this.addColumn());

		// Restore scroll positions
		boardEl.scrollLeft = savedScrollLeft;
		boardEl.querySelectorAll('.kanban-column-body').forEach((body, i) => {
			if (savedColumnScrollTops[i] !== undefined) {
				(body as HTMLElement).scrollTop = savedColumnScrollTops[i];
			}
		});
	}

	private async renderColumn(boardEl: HTMLElement, column: KanbanColumn, colIndex: number): Promise<void> {
		const columnEl = boardEl.createDiv({cls: 'kanban-column'});
		columnEl.dataset.colIndex = String(colIndex);

		// Column header
		const headerEl = columnEl.createDiv({cls: 'kanban-column-header'});

		const dragHandle = headerEl.createDiv({cls: 'kanban-drag-handle'});
		setIcon(dragHandle, 'grip-vertical');

		const headerLeft = headerEl.createDiv({cls: 'kanban-column-header-left'});
		const titleSpan = headerLeft.createEl('span', {text: column.title, cls: 'kanban-column-title'});
		headerLeft.createEl('span', {text: String(column.cards.length), cls: 'kanban-column-count'});

		titleSpan.addEventListener('click', (e) => {
			e.stopPropagation();
			this.startEditingColumnTitle(colIndex, headerEl, column);
		});

		const headerButtons = headerEl.createDiv({cls: 'kanban-column-header-buttons'});

		const archiveBtn = headerButtons.createEl('button', {cls: 'kanban-column-archive', attr: {'aria-label': 'Archive column'}});
		setIcon(archiveBtn, 'archive');
		archiveBtn.addEventListener('click', (e) => {
			e.stopPropagation();
			this.archiveColumn(colIndex);
		});

		const deleteBtn = headerButtons.createEl('button', {cls: 'kanban-column-delete', attr: {'aria-label': 'Delete column'}});
		deleteBtn.setText('\u00D7');
		deleteBtn.addEventListener('click', (e) => {
			e.stopPropagation();
			this.deleteColumn(colIndex);
		});

		this.setupColumnDrag(dragHandle, columnEl, colIndex);

		// Card container
		const bodyEl = columnEl.createDiv({cls: 'kanban-column-body'});

		const cardPromises: Promise<void>[] = [];
		column.cards.forEach((card, cardIndex) => {
			cardPromises.push(this.renderCard(bodyEl, card, colIndex, cardIndex));
		});

		await Promise.all(cardPromises);

		// Add card button
		const addCardBtn = bodyEl.createDiv({cls: 'kanban-add-card-btn'});
		addCardBtn.setText('+ Add card');
		addCardBtn.addEventListener('click', () => this.addCard(colIndex));

		this.setupCardDropZone(bodyEl, colIndex);
	}

	private async renderCard(
		bodyEl: HTMLElement,
		card: KanbanCard,
		colIndex: number,
		cardIndex: number,
	): Promise<void> {
		const cardEl = bodyEl.createDiv({cls: 'kanban-card'});
		cardEl.dataset.cardIndex = String(cardIndex);

		// Drag handle
		const dragHandle = cardEl.createDiv({cls: 'kanban-drag-handle kanban-card-drag-handle'});
		setIcon(dragHandle, 'grip-vertical');

		// Extract tags and display title
		const tags = this.extractTags(card.title);
		const displayTitle = this.getTitleWithoutTags(card.title);

		const titleEl = cardEl.createDiv({cls: 'kanban-card-title'});
		titleEl.setText(displayTitle);

		const deleteCardBtn = cardEl.createEl('button', {cls: 'kanban-card-delete', attr: {'aria-label': 'Delete card'}});
		deleteCardBtn.setText('\u00D7');
		deleteCardBtn.addEventListener('click', (e) => {
			e.stopPropagation();
			this.deleteCard(colIndex, cardIndex);
		});

		titleEl.addEventListener('click', (e) => {
			e.stopPropagation();
			this.startEditingCardTitle(colIndex, cardIndex, titleEl, card, cardEl);
		});

		// Labels row
		const labelsEl = cardEl.createDiv({cls: 'kanban-card-labels'});
		for (const tag of tags) {
			this.renderLabel(labelsEl, tag, colIndex, cardIndex, card);
		}
		const addLabelBtn = labelsEl.createEl('button', {cls: 'kanban-label-add', attr: {'aria-label': 'Add label'}});
		addLabelBtn.setText('+ Add label');
		addLabelBtn.addEventListener('click', (e) => {
			e.stopPropagation();
			this.addLabelToCard(colIndex, cardIndex, card);
		});

		if (card.rawBodyLines.length > 0 && this.renderChild) {
			const bodyContentEl = cardEl.createDiv({cls: 'kanban-card-body'});
			const displayBody = this.getDisplayBody(card.rawBodyLines);
			if (displayBody) {
				await MarkdownRenderer.render(this.app, displayBody, bodyContentEl, this.filePath, this.renderChild);
				this.linkifyOsPaths(bodyContentEl);

				// Setup checkbox toggle handlers
				const checkboxes = bodyContentEl.querySelectorAll('input[type="checkbox"]');
				checkboxes.forEach((cb, i) => {
					const input = cb as HTMLInputElement;
					input.addEventListener('click', (e) => {
						e.preventDefault();
						this.toggleCheckbox(colIndex, cardIndex, i);
					});
				});

				bodyContentEl.addEventListener('click', (e) => {
					const target = e.target as HTMLElement;
					if (target.tagName === 'INPUT' || target.closest('a')) return;
					this.startEditingCardBody(colIndex, cardIndex, bodyContentEl, card, cardEl);
				});
			}
		} else {
			const placeholderEl = cardEl.createDiv({cls: 'kanban-card-body-placeholder'});
			placeholderEl.setText('Add description...');
			placeholderEl.addEventListener('click', (e) => {
				e.stopPropagation();
				this.startEditingCardBody(colIndex, cardIndex, placeholderEl, card, cardEl);
			});
		}

		this.setupCardDrag(dragHandle, cardEl, colIndex, cardIndex);
	}

	// --- Drag & Drop: Cards ---

	private setupCardDrag(dragHandle: HTMLElement, cardEl: HTMLElement, colIndex: number, cardIndex: number): void {
		dragHandle.addEventListener('mousedown', () => {
			cardEl.draggable = true;
		});
		dragHandle.addEventListener('mouseup', () => {
			cardEl.draggable = false;
		});

		cardEl.addEventListener('dragstart', (e) => {
			if (!cardEl.draggable) {
				e.preventDefault();
				return;
			}
			e.stopPropagation();
			this.dragState = {type: 'card', sourceColIndex: colIndex, sourceCardIndex: cardIndex};
			if (e.dataTransfer) {
				e.dataTransfer.effectAllowed = 'move';
				e.dataTransfer.setData('text/plain', '');
			}
			setTimeout(() => cardEl.addClass('dragging'), 0);
		});

		cardEl.addEventListener('dragend', () => {
			cardEl.draggable = false;
			cardEl.removeClass('dragging');
			this.dragState = null;
			this.removePlaceholder();
			this.clearDropIndicators();
		});
	}

	private setupCardDropZone(bodyEl: HTMLElement, targetColIndex: number): void {
		bodyEl.addEventListener('dragover', (e) => {
			if (!this.dragState || this.dragState.type !== 'card') return;
			e.preventDefault();
			e.stopPropagation();
			if (e.dataTransfer) {
				e.dataTransfer.dropEffect = 'move';
			}

			this.removePlaceholder();

			const cards = Array.from(bodyEl.querySelectorAll('.kanban-card:not(.dragging)'));
			let insertIndex = cards.length;

			for (let i = 0; i < cards.length; i++) {
				const rect = cards[i]?.getBoundingClientRect();
				if (rect && e.clientY < rect.top + rect.height / 2) {
					insertIndex = i;
					break;
				}
			}

			const placeholder = document.createElement('div');
			placeholder.className = 'kanban-card-placeholder';
			if (insertIndex < cards.length) {
				cards[insertIndex]?.before(placeholder);
			} else {
				const addBtn = bodyEl.querySelector('.kanban-add-card-btn');
				if (addBtn) addBtn.before(placeholder);
				else bodyEl.appendChild(placeholder);
			}
			this.dragPlaceholder = placeholder;

			// Highlight target column
			this.contentEl.querySelectorAll('.kanban-column').forEach(col => col.classList.remove('drag-target-column'));
			bodyEl.closest('.kanban-column')?.classList.add('drag-target-column');
		});

		bodyEl.addEventListener('dragleave', (e) => {
			if (!bodyEl.contains(e.relatedTarget as Node)) {
				if (this.dragPlaceholder && bodyEl.contains(this.dragPlaceholder)) {
					this.dragPlaceholder.remove();
					this.dragPlaceholder = null;
				}
				bodyEl.closest('.kanban-column')?.classList.remove('drag-target-column');
			}
		});

		bodyEl.addEventListener('drop', (e) => {
			e.preventDefault();
			e.stopPropagation();
			if (!this.dragState || this.dragState.type !== 'card') return;

			const cards = Array.from(bodyEl.querySelectorAll('.kanban-card:not(.dragging)'));
			let targetIndex = cards.length;

			for (let i = 0; i < cards.length; i++) {
				const rect = cards[i]?.getBoundingClientRect();
				if (rect && e.clientY < rect.top + rect.height / 2) {
					targetIndex = i;
					break;
				}
			}

			this.moveCard(
				this.dragState.sourceColIndex,
				this.dragState.sourceCardIndex,
				targetColIndex,
				targetIndex,
			);
			this.removePlaceholder();
			this.clearDropIndicators();
		});
	}

	// --- Drag & Drop: Columns ---

	private setupColumnDrag(dragHandle: HTMLElement, columnEl: HTMLElement, colIndex: number): void {
		dragHandle.addEventListener('mousedown', () => {
			columnEl.draggable = true;
		});
		dragHandle.addEventListener('mouseup', () => {
			columnEl.draggable = false;
		});

		columnEl.addEventListener('dragstart', (e) => {
			if (!columnEl.draggable) {
				e.preventDefault();
				return;
			}
			this.dragState = {type: 'column', sourceColIndex: colIndex, sourceCardIndex: -1};
			if (e.dataTransfer) {
				e.dataTransfer.effectAllowed = 'move';
				e.dataTransfer.setData('text/plain', '');
			}
			setTimeout(() => columnEl.addClass('dragging'), 0);
		});

		columnEl.addEventListener('dragend', () => {
			columnEl.draggable = false;
			columnEl.removeClass('dragging');
			this.dragState = null;
			this.removePlaceholder();
			this.clearDropIndicators();
		});
	}

	private setupBoardDropZone(boardEl: HTMLElement): void {
		boardEl.addEventListener('dragover', (e) => {
			if (!this.dragState || this.dragState.type !== 'column') return;
			e.preventDefault();
			if (e.dataTransfer) {
				e.dataTransfer.dropEffect = 'move';
			}

			this.removePlaceholder();

			const columns = Array.from(boardEl.querySelectorAll('.kanban-column:not(.dragging)')) as HTMLElement[];
			let insertBefore: Element | null = null;

			for (const col of columns) {
				const rect = col.getBoundingClientRect();
				if (e.clientX < rect.left + rect.width / 2) {
					insertBefore = col;
					break;
				}
			}

			const placeholder = document.createElement('div');
			placeholder.className = 'kanban-column-placeholder';
			if (insertBefore) {
				insertBefore.before(placeholder);
			} else {
				const addBtn = boardEl.querySelector('.kanban-add-column-btn');
				if (addBtn) addBtn.before(placeholder);
				else boardEl.appendChild(placeholder);
			}
			this.dragPlaceholder = placeholder;
		});

		boardEl.addEventListener('dragleave', (e) => {
			if (!this.dragState || this.dragState.type !== 'column') return;
			if (!boardEl.contains(e.relatedTarget as Node)) {
				this.removePlaceholder();
			}
		});

		boardEl.addEventListener('drop', (e) => {
			if (!this.dragState || this.dragState.type !== 'column') return;
			e.preventDefault();

			const columns = Array.from(boardEl.querySelectorAll('.kanban-column:not(.dragging)')) as HTMLElement[];
			let targetIndex = this.board.columns.length;

			for (const col of columns) {
				const rect = col.getBoundingClientRect();
				if (e.clientX < rect.left + rect.width / 2) {
					targetIndex = parseInt(col.dataset.colIndex ?? '0');
					break;
				}
			}

			this.moveColumn(this.dragState.sourceColIndex, targetIndex);
			this.removePlaceholder();
			this.clearDropIndicators();
		});
	}

	private removePlaceholder(): void {
		if (this.dragPlaceholder) {
			this.dragPlaceholder.remove();
			this.dragPlaceholder = null;
		}
		this.contentEl.querySelectorAll('.kanban-column').forEach(col => col.classList.remove('drag-target-column'));
	}

	// --- Data operations ---

	private moveCard(fromCol: number, fromIndex: number, toCol: number, toIndex: number): void {
		const sourceColumn = this.board.columns[fromCol];
		const targetColumn = this.board.columns[toCol];
		if (!sourceColumn || !targetColumn) return;

		if (fromCol === toCol && fromIndex === toIndex) return;

		this.pushUndo();
		const card = sourceColumn.cards.splice(fromIndex, 1)[0];
		if (!card) return;

		// Adjust target index if moving within the same column and source was before target
		if (fromCol === toCol && fromIndex < toIndex) {
			toIndex--;
		}

		targetColumn.cards.splice(toIndex, 0, card);
		this.saveBoard();
		this.render();
	}

	private moveColumn(fromIndex: number, toIndex: number): void {
		if (fromIndex === toIndex || fromIndex === toIndex - 1) return;

		this.pushUndo();
		const column = this.board.columns.splice(fromIndex, 1)[0];
		if (!column) return;

		if (fromIndex < toIndex) {
			toIndex--;
		}

		this.board.columns.splice(toIndex, 0, column);
		this.saveBoard();
		this.render();
	}

	private async toggleCheckbox(colIndex: number, cardIndex: number, checkboxIndex: number): Promise<void> {
		const card = this.board.columns[colIndex]?.cards[cardIndex];
		if (!card) return;

		this.pushUndo();

		let count = 0;
		for (let i = 0; i < card.rawBodyLines.length; i++) {
			const line = card.rawBodyLines[i];
			if (!line) continue;

			const checkboxMatch = line.match(/^(\s*- \[)([ x])(\].*)$/);
			if (checkboxMatch) {
				if (count === checkboxIndex) {
					const isChecked = checkboxMatch[2] === 'x';
					card.rawBodyLines[i] = `${checkboxMatch[1]}${isChecked ? ' ' : 'x'}${checkboxMatch[3]}`;
					break;
				}
				count++;
			}
		}

		await this.saveBoard();
		await this.render();
	}

	// --- Add / Delete operations ---

	private async addCard(colIndex: number): Promise<void> {
		const column = this.board.columns[colIndex];
		if (!column) return;
		this.pushUndo();
		column.cards.push({title: 'New card', rawBodyLines: []});
		await this.saveBoard();
		await this.render();
	}

	private async addColumn(): Promise<void> {
		this.pushUndo();
		this.board.columns.push({title: 'New column', cards: []});
		await this.saveBoard();
		await this.render();
		// Scroll to the new column
		const boardEl = this.contentEl.querySelector('.kanban-board') as HTMLElement | null;
		if (boardEl) boardEl.scrollLeft = boardEl.scrollWidth;
	}

	private async deleteColumn(colIndex: number): Promise<void> {
		const column = this.board.columns[colIndex];
		if (!column) return;
		this.pushUndo();
		this.board.columns.splice(colIndex, 1);
		await this.saveBoard();
		await this.render();
	}

	private async deleteCard(colIndex: number, cardIndex: number): Promise<void> {
		const column = this.board.columns[colIndex];
		if (!column || !column.cards[cardIndex]) return;
		this.pushUndo();
		column.cards.splice(cardIndex, 1);
		await this.saveBoard();
		await this.render();
	}

	private async archiveColumn(colIndex: number): Promise<void> {
		const column = this.board.columns[colIndex];
		if (!column) return;
		this.pushUndo();
		column.archived = true;
		await this.saveBoard();
		await this.render();
	}

	// --- Inline Editing ---

	private startEditingColumnTitle(colIndex: number, headerEl: HTMLElement, column: KanbanColumn): void {
		if (headerEl.querySelector('.kanban-edit-input')) return;

		const titleSpan = headerEl.querySelector('.kanban-column-title') ?? headerEl.querySelector('.kanban-column-header-left .kanban-column-title');
		if (!titleSpan) return;

		const input = document.createElement('input');
		input.type = 'text';
		input.value = column.title;
		input.className = 'kanban-edit-input kanban-column-title-edit';

		titleSpan.replaceWith(input);
		input.focus();
		input.select();

		let saved = false;
		const save = async () => {
			if (saved) return;
			saved = true;
			const newTitle = input.value.trim();
			if (newTitle && newTitle !== column.title) {
				this.pushUndo();
				column.title = newTitle;
				await this.saveBoard();
			}
			await this.render();
		};

		input.addEventListener('blur', () => save());
		input.addEventListener('keydown', (e) => {
			if (e.key === 'Enter') {
				e.preventDefault();
				input.blur();
			} else if (e.key === 'Escape') {
				saved = true;
				this.render();
			}
		});
		input.addEventListener('click', (e) => e.stopPropagation());
	}

	private startEditingCardTitle(
		colIndex: number,
		cardIndex: number,
		titleEl: HTMLElement,
		card: KanbanCard,
		cardEl: HTMLElement,
	): void {
		if (titleEl.querySelector('.kanban-edit-input')) return;

		const input = document.createElement('input');
		input.type = 'text';
		input.value = card.title;
		input.className = 'kanban-edit-input kanban-card-title-edit';

		titleEl.empty();
		titleEl.appendChild(input);
		input.focus();
		input.select();

		let saved = false;
		const save = async () => {
			if (saved) return;
			saved = true;
			const newTitle = input.value.trim();
			if (newTitle && newTitle !== card.title) {
				this.pushUndo();
				card.title = newTitle;
				await this.saveBoard();
			}
			await this.render();
		};

		input.addEventListener('blur', () => save());
		input.addEventListener('keydown', (e) => {
			if (e.key === 'Enter') {
				e.preventDefault();
				input.blur();
			} else if (e.key === 'Escape') {
				saved = true;
				this.render();
			}
		});
		input.addEventListener('click', (e) => e.stopPropagation());
	}

	private startEditingCardBody(
		colIndex: number,
		cardIndex: number,
		bodyEl: HTMLElement,
		card: KanbanCard,
		cardEl: HTMLElement,
	): void {
		if (bodyEl.querySelector('.kanban-edit-textarea')) return;

		const displayBody = this.getDisplayBody(card.rawBodyLines);
		const prefix = this.getBodyPrefix(card.rawBodyLines);

		const textarea = document.createElement('textarea');
		textarea.value = displayBody;
		textarea.className = 'kanban-edit-textarea kanban-card-body-edit';

		bodyEl.empty();
		bodyEl.appendChild(textarea);
		textarea.focus();

		const autoResize = () => {
			textarea.style.height = 'auto';
			textarea.style.height = textarea.scrollHeight + 'px';
		};
		autoResize();
		textarea.addEventListener('input', autoResize);

		let saved = false;
		const save = async () => {
			if (saved) return;
			saved = true;
			const newText = textarea.value;
			const oldBody = card.rawBodyLines.join('\n');
			if (newText.trim() === '') {
				if (oldBody.trim() !== '') this.pushUndo();
				card.rawBodyLines = [];
			} else {
				const newLines = newText.split('\n').map(line => {
					if (line.trim() === '') return '';
					return prefix + line;
				});
				if (newLines.join('\n') !== oldBody) this.pushUndo();
				card.rawBodyLines = newLines;
			}
			await this.saveBoard();
			await this.render();
		};

		textarea.addEventListener('blur', () => save());
		textarea.addEventListener('keydown', (e) => {
			if (e.key === 'Escape') {
				saved = true;
				this.render();
			}
		});
		textarea.addEventListener('click', (e) => e.stopPropagation());
	}

	private getBodyPrefix(rawLines: string[]): string {
		const nonEmpty = rawLines.filter(l => l.trim() !== '');
		if (nonEmpty.length === 0) return '\t\t';
		const match = nonEmpty[0]?.match(/^(\s+)/);
		return match?.[1] ?? '\t\t';
	}

	// --- Labels ---

	private static readonly DEFAULT_LABEL_COLORS = [
		'#e03e3e', '#d9730d', '#dfab01', '#0f7b6c', '#2f80ed',
		'#6940a5', '#ad1a72', '#64748b', '#0ea5e9', '#10b981',
	];

	private extractTags(title: string): string[] {
		const matches = title.match(/#([\w][\w-]*)/g);
		if (!matches) return [];
		const seen = new Set<string>();
		const result: string[] = [];
		for (const m of matches) {
			const tag = m.substring(1);
			const lower = tag.toLowerCase();
			if (!seen.has(lower)) {
				seen.add(lower);
				result.push(tag);
			}
		}
		return result;
	}

	private getTitleWithoutTags(title: string): string {
		return title.replace(/#[\w][\w-]*/g, '').replace(/\s{2,}/g, ' ').trim();
	}

	private getLabelColor(tag: string): string {
		const key = tag.toLowerCase();
		if (this.board.labelColors[key]) return this.board.labelColors[key];
		// Assign a deterministic default color based on tag hash
		let hash = 0;
		for (let i = 0; i < key.length; i++) {
			hash = ((hash << 5) - hash + key.charCodeAt(i)) | 0;
		}
		const idx = Math.abs(hash) % KanbanView.DEFAULT_LABEL_COLORS.length;
		return KanbanView.DEFAULT_LABEL_COLORS[idx] ?? '#64748b';
	}

	private renderLabel(
		container: HTMLElement,
		tag: string,
		colIndex: number,
		cardIndex: number,
		card: KanbanCard,
	): void {
		const color = this.getLabelColor(tag);
		const labelEl = container.createDiv({cls: 'kanban-label'});
		labelEl.style.backgroundColor = color;
		labelEl.style.color = this.getContrastColor(color);

		const nameSpan = labelEl.createSpan({cls: 'kanban-label-name', text: tag});

		const deleteBtn = labelEl.createEl('button', {cls: 'kanban-label-delete', attr: {'aria-label': 'Remove label'}});
		deleteBtn.setText('\u00D7');
		deleteBtn.addEventListener('click', (e) => {
			e.stopPropagation();
			this.removeLabelFromCard(colIndex, cardIndex, card, tag);
		});

		nameSpan.addEventListener('click', (e) => {
			e.stopPropagation();
			this.startEditingLabel(labelEl, tag);
		});
	}

	private getContrastColor(hex: string): string {
		const r = parseInt(hex.slice(1, 3), 16);
		const g = parseInt(hex.slice(3, 5), 16);
		const b = parseInt(hex.slice(5, 7), 16);
		const luminance = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
		return luminance > 0.55 ? '#000000' : '#ffffff';
	}

	private async addLabelToCard(colIndex: number, cardIndex: number, card: KanbanCard): Promise<void> {
		// Find the labels container for this card
		const cardEl = this.contentEl.querySelectorAll('.kanban-card')[
			this.getGlobalCardIndex(colIndex, cardIndex)
		] as HTMLElement | undefined;
		if (!cardEl) return;
		const labelsEl = cardEl.querySelector('.kanban-card-labels') as HTMLElement | null;
		if (!labelsEl) return;
		const addBtn = labelsEl.querySelector('.kanban-label-add') as HTMLElement | null;
		if (!addBtn || labelsEl.querySelector('.kanban-label-new-input')) return;

		addBtn.style.display = 'none';

		const input = document.createElement('input');
		input.type = 'text';
		input.placeholder = 'label name';
		input.className = 'kanban-label-new-input';
		labelsEl.appendChild(input);
		input.focus();

		let done = false;
		const finish = async (commit: boolean) => {
			if (done) return;
			done = true;
			const newTag = input.value.trim().replace(/\s+/g, '-').replace(/^#/, '');
			if (commit && newTag) {
				const existing = this.extractTags(card.title);
				if (!existing.some(t => t.toLowerCase() === newTag.toLowerCase())) {
					this.pushUndo();
					card.title = card.title.trimEnd() + ` #${newTag}`;
					const colorKey = newTag.toLowerCase();
					if (!this.board.labelColors[colorKey]) {
						this.board.labelColors[colorKey] = this.getLabelColor(newTag);
					}
					await this.saveBoard();
				}
			}
			await this.render();
		};

		input.addEventListener('blur', () => finish(true));
		input.addEventListener('keydown', (e) => {
			if (e.key === 'Enter') { e.preventDefault(); input.blur(); }
			else if (e.key === 'Escape') { finish(false); }
		});
		input.addEventListener('click', (e) => e.stopPropagation());
	}

	private getGlobalCardIndex(colIndex: number, cardIndex: number): number {
		let idx = 0;
		for (let c = 0; c < colIndex; c++) {
			idx += this.board.columns[c]?.cards.length ?? 0;
		}
		return idx + cardIndex;
	}

	private async removeLabelFromCard(colIndex: number, cardIndex: number, card: KanbanCard, tag: string): Promise<void> {
		this.pushUndo();
		card.title = card.title.replace(new RegExp(`\\s*#${this.escapeRegex(tag)}\\b`, 'gi'), '');
		await this.saveBoard();
		await this.render();
	}

	private escapeRegex(str: string): string {
		return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
	}

	private startEditingLabel(labelEl: HTMLElement, oldTag: string): void {
		if (labelEl.querySelector('.kanban-label-edit-container')) return;

		const color = this.getLabelColor(oldTag);

		const editContainer = document.createElement('div');
		editContainer.className = 'kanban-label-edit-container';

		const nameInput = document.createElement('input');
		nameInput.type = 'text';
		nameInput.value = oldTag;
		nameInput.className = 'kanban-label-name-input';

		const colorInput = document.createElement('input');
		colorInput.type = 'color';
		colorInput.value = color;
		colorInput.className = 'kanban-label-color-input';

		editContainer.appendChild(nameInput);
		editContainer.appendChild(colorInput);

		labelEl.empty();
		labelEl.appendChild(editContainer);
		labelEl.style.backgroundColor = 'var(--background-primary)';
		labelEl.style.color = '';
		nameInput.focus();
		nameInput.select();

		let saved = false;
		const save = async () => {
			if (saved) return;
			saved = true;
			const newTag = nameInput.value.trim().replace(/\s+/g, '-').replace(/^#/, '');
			const newColor = colorInput.value;
			const colorWasChanged = newColor !== color;
			const oldKey = oldTag.toLowerCase();
			const newKey = newTag.toLowerCase();
			if (newTag && (oldKey !== newKey || colorWasChanged)) {
				this.pushUndo();
				delete this.board.labelColors[oldKey];
				if (colorWasChanged || !this.board.labelColors[newKey]) {
					this.board.labelColors[newKey] = newColor;
				}
				// Rename tag in all card titles
				if (oldKey !== newKey) {
					for (const col of this.board.columns) {
						for (const card of col.cards) {
							card.title = card.title.replace(
								new RegExp(`#${this.escapeRegex(oldTag)}\\b`, 'gi'),
								`#${newTag}`,
							);
						}
					}
				}
				await this.saveBoard();
			}
			await this.render();
		};

		const handleBlur = (e: FocusEvent) => {
			// Only save when focus leaves both inputs
			const related = e.relatedTarget as HTMLElement | null;
			if (related && editContainer.contains(related)) return;
			save();
		};

		nameInput.addEventListener('blur', handleBlur);
		colorInput.addEventListener('blur', handleBlur);
		nameInput.addEventListener('keydown', (e) => {
			if (e.key === 'Enter') { e.preventDefault(); nameInput.blur(); colorInput.blur(); save(); }
			else if (e.key === 'Escape') { saved = true; this.render(); }
		});
		colorInput.addEventListener('change', () => {
			// Live preview: update label background as user picks color
			labelEl.style.backgroundColor = colorInput.value;
		});
		nameInput.addEventListener('click', (e) => e.stopPropagation());
		colorInput.addEventListener('click', (e) => e.stopPropagation());
	}

	// --- Helpers ---

	private clearDropIndicators(): void {
		this.contentEl.querySelectorAll('.drop-above, .drop-below, .drop-before, .drop-after, .drop-at-end')
			.forEach(el => {
				el.classList.remove('drop-above', 'drop-below', 'drop-before', 'drop-after', 'drop-at-end');
			});
		this.removePlaceholder();
	}

	private linkifyOsPaths(container: HTMLElement): void {
		const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT);
		const textNodes: Text[] = [];
		let node: Text | null;
		while ((node = walker.nextNode() as Text | null)) {
			textNodes.push(node);
		}

		const pathRegex = /([A-Za-z]:[\\\/][^\s<>"*?|]+|\/(?:[\w.-]+\/)+[\w.-]+)/g;

		for (const textNode of textNodes) {
			if (textNode.parentElement?.closest('a, code, pre')) continue;

			const text = textNode.textContent || '';
			pathRegex.lastIndex = 0;
			if (!pathRegex.test(text)) continue;
			pathRegex.lastIndex = 0;

			const fragment = document.createDocumentFragment();
			let lastIndex = 0;
			let match: RegExpExecArray | null;
			let hasMatch = false;

			while ((match = pathRegex.exec(text)) !== null) {
				hasMatch = true;
				if (match.index > lastIndex) {
					fragment.appendChild(document.createTextNode(text.slice(lastIndex, match.index)));
				}

				const pathStr = match[0];
				const link = document.createElement('a');
				link.textContent = pathStr;
				link.className = 'external-link';

				let fileUri: string;
				if (/^[A-Za-z]:/.test(pathStr)) {
					fileUri = 'file:///' + pathStr.replace(/\\/g, '/');
				} else {
					fileUri = 'file://' + pathStr;
				}
				link.setAttribute('href', fileUri);
				fragment.appendChild(link);

				lastIndex = match.index + match[0].length;
			}

			if (hasMatch) {
				if (lastIndex < text.length) {
					fragment.appendChild(document.createTextNode(text.slice(lastIndex)));
				}
				textNode.parentNode?.replaceChild(fragment, textNode);
			}
		}
	}

	private getDisplayBody(rawLines: string[]): string {
		const nonEmptyLines = rawLines.filter(l => l.trim() !== '');
		if (nonEmptyLines.length === 0) return '';

		// Find the common leading whitespace prefix from the first non-empty line
		const firstNonEmpty = nonEmptyLines[0];
		if (!firstNonEmpty) return '';

		const prefixMatch = firstNonEmpty.match(/^(\s+)/);
		if (!prefixMatch?.[1]) return rawLines.join('\n').trim();

		const prefix = prefixMatch[1];

		return rawLines.map(line => {
			if (line.trim() === '') return '';
			if (line.startsWith(prefix)) return line.substring(prefix.length);
			return line.trimStart();
		}).join('\n').trim();
	}
}
