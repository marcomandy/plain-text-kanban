import {ItemView, WorkspaceLeaf, TFile, MarkdownRenderer, Component, ViewStateResult} from 'obsidian';
import {KanbanBoard, KanbanColumn, KanbanCard} from './types';
import {parseKanban} from './parser';
import {serializeKanban} from './serializer';

export const KANBAN_VIEW_TYPE = 'plain-text-kanban';

interface DragState {
	type: 'card' | 'column';
	sourceColIndex: number;
	sourceCardIndex: number;
}

export class KanbanView extends ItemView {
	private board: KanbanBoard = {columns: []};
	private filePath = '';
	private isWriting = false;
	private dragState: DragState | null = null;
	private renderChild: Component | null = null;

	constructor(leaf: WorkspaceLeaf) {
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

	private async render(): Promise<void> {
		// Save scroll position
		const existingBoard = this.contentEl.querySelector('.kanban-board') as HTMLElement | null;
		const savedScrollLeft = existingBoard?.scrollLeft ?? 0;

		// Clean up previous render components
		if (this.renderChild) {
			this.removeChild(this.renderChild);
		}
		this.renderChild = new Component();
		this.addChild(this.renderChild);

		const container = this.contentEl;
		container.empty();

		const boardEl = container.createDiv({cls: 'kanban-board'});

		if (this.board.columns.length === 0) {
			const addColBtn = boardEl.createDiv({cls: 'kanban-add-column-btn'});
			addColBtn.setText('+ Add column');
			addColBtn.addEventListener('click', () => this.addColumn());
			return;
		}

		const renderPromises: Promise<void>[] = [];
		this.board.columns.forEach((column, colIndex) => {
			renderPromises.push(this.renderColumn(boardEl, column, colIndex));
		});

		await Promise.all(renderPromises);

		// Add column button
		const addColBtn = boardEl.createDiv({cls: 'kanban-add-column-btn'});
		addColBtn.setText('+ Add column');
		addColBtn.addEventListener('click', () => this.addColumn());

		// Restore scroll position
		boardEl.scrollLeft = savedScrollLeft;
	}

	private async renderColumn(boardEl: HTMLElement, column: KanbanColumn, colIndex: number): Promise<void> {
		const columnEl = boardEl.createDiv({cls: 'kanban-column'});
		columnEl.dataset.colIndex = String(colIndex);

		// Column header
		const headerEl = columnEl.createDiv({cls: 'kanban-column-header'});
		headerEl.draggable = true;
		const headerLeft = headerEl.createDiv({cls: 'kanban-column-header-left'});
		const titleSpan = headerLeft.createEl('span', {text: column.title, cls: 'kanban-column-title'});
		headerLeft.createEl('span', {text: String(column.cards.length), cls: 'kanban-column-count'});

		titleSpan.addEventListener('click', (e) => {
			e.stopPropagation();
			this.startEditingColumnTitle(colIndex, headerEl, column);
		});

		const deleteBtn = headerEl.createEl('button', {cls: 'kanban-column-delete', attr: {'aria-label': 'Delete column'}});
		deleteBtn.setText('\u00D7');
		deleteBtn.addEventListener('click', (e) => {
			e.stopPropagation();
			this.deleteColumn(colIndex);
		});

		this.setupColumnDrag(headerEl, columnEl, colIndex);

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
		this.setupColumnDropZone(columnEl, colIndex);
	}

	private async renderCard(
		bodyEl: HTMLElement,
		card: KanbanCard,
		colIndex: number,
		cardIndex: number,
	): Promise<void> {
		const cardEl = bodyEl.createDiv({cls: 'kanban-card'});
		cardEl.dataset.cardIndex = String(cardIndex);
		cardEl.draggable = true;

		const titleEl = cardEl.createDiv({cls: 'kanban-card-title'});
		titleEl.setText(card.title);

		titleEl.addEventListener('click', (e) => {
			e.stopPropagation();
			this.startEditingCardTitle(colIndex, cardIndex, titleEl, card, cardEl);
		});

		if (card.rawBodyLines.length > 0 && this.renderChild) {
			const bodyContentEl = cardEl.createDiv({cls: 'kanban-card-body'});
			const displayBody = this.getDisplayBody(card.rawBodyLines);
			if (displayBody) {
				await MarkdownRenderer.render(this.app, displayBody, bodyContentEl, this.filePath, this.renderChild);

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

		this.setupCardDrag(cardEl, colIndex, cardIndex);
	}

	// --- Drag & Drop: Cards ---

	private setupCardDrag(cardEl: HTMLElement, colIndex: number, cardIndex: number): void {
		cardEl.addEventListener('dragstart', (e) => {
			e.stopPropagation();
			this.dragState = {type: 'card', sourceColIndex: colIndex, sourceCardIndex: cardIndex};
			if (e.dataTransfer) {
				e.dataTransfer.effectAllowed = 'move';
				e.dataTransfer.setData('text/plain', '');
			}
			setTimeout(() => cardEl.addClass('dragging'), 0);
		});

		cardEl.addEventListener('dragend', () => {
			cardEl.removeClass('dragging');
			this.dragState = null;
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

			this.clearDropIndicators();

			const cards = Array.from(bodyEl.querySelectorAll('.kanban-card:not(.dragging)'));
			let insertIndex = cards.length;

			for (let i = 0; i < cards.length; i++) {
				const rect = cards[i]?.getBoundingClientRect();
				if (rect && e.clientY < rect.top + rect.height / 2) {
					insertIndex = i;
					break;
				}
			}

			if (insertIndex < cards.length) {
				cards[insertIndex]?.classList.add('drop-above');
			} else {
				bodyEl.addClass('drop-at-end');
			}
		});

		bodyEl.addEventListener('dragleave', (e) => {
			if (!bodyEl.contains(e.relatedTarget as Node)) {
				this.clearDropIndicators();
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
			this.clearDropIndicators();
		});
	}

	// --- Drag & Drop: Columns ---

	private setupColumnDrag(headerEl: HTMLElement, columnEl: HTMLElement, colIndex: number): void {
		headerEl.addEventListener('dragstart', (e) => {
			this.dragState = {type: 'column', sourceColIndex: colIndex, sourceCardIndex: -1};
			if (e.dataTransfer) {
				e.dataTransfer.effectAllowed = 'move';
				e.dataTransfer.setData('text/plain', '');
			}
			setTimeout(() => columnEl.addClass('dragging'), 0);
		});

		headerEl.addEventListener('dragend', () => {
			columnEl.removeClass('dragging');
			this.dragState = null;
			this.clearDropIndicators();
		});
	}

	private setupColumnDropZone(columnEl: HTMLElement, colIndex: number): void {
		columnEl.addEventListener('dragover', (e) => {
			if (!this.dragState || this.dragState.type !== 'column') return;
			if (this.dragState.sourceColIndex === colIndex) return;
			e.preventDefault();
			if (e.dataTransfer) {
				e.dataTransfer.dropEffect = 'move';
			}

			this.clearDropIndicators();
			const rect = columnEl.getBoundingClientRect();
			const midX = rect.left + rect.width / 2;

			if (e.clientX < midX) {
				columnEl.addClass('drop-before');
			} else {
				columnEl.addClass('drop-after');
			}
		});

		columnEl.addEventListener('dragleave', (e) => {
			if (!columnEl.contains(e.relatedTarget as Node)) {
				columnEl.removeClass('drop-before', 'drop-after');
			}
		});

		columnEl.addEventListener('drop', (e) => {
			e.preventDefault();
			if (!this.dragState || this.dragState.type !== 'column') return;

			const rect = columnEl.getBoundingClientRect();
			const midX = rect.left + rect.width / 2;
			let targetIndex = e.clientX < midX ? colIndex : colIndex + 1;

			this.moveColumn(this.dragState.sourceColIndex, targetIndex);
			this.clearDropIndicators();
		});
	}

	// --- Data operations ---

	private moveCard(fromCol: number, fromIndex: number, toCol: number, toIndex: number): void {
		const sourceColumn = this.board.columns[fromCol];
		const targetColumn = this.board.columns[toCol];
		if (!sourceColumn || !targetColumn) return;

		if (fromCol === toCol && fromIndex === toIndex) return;

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
		column.cards.push({title: 'New card', rawBodyLines: []});
		await this.saveBoard();
		await this.render();
	}

	private async addColumn(): Promise<void> {
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
		this.board.columns.splice(colIndex, 1);
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
		headerEl.draggable = false;
		input.focus();
		input.select();

		let saved = false;
		const save = async () => {
			if (saved) return;
			saved = true;
			const newTitle = input.value.trim();
			if (newTitle && newTitle !== column.title) {
				column.title = newTitle;
				await this.saveBoard();
			}
			headerEl.draggable = true;
			await this.render();
		};

		input.addEventListener('blur', () => save());
		input.addEventListener('keydown', (e) => {
			if (e.key === 'Enter') {
				e.preventDefault();
				input.blur();
			} else if (e.key === 'Escape') {
				saved = true;
				headerEl.draggable = true;
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
		cardEl.draggable = false;
		input.focus();
		input.select();

		let saved = false;
		const save = async () => {
			if (saved) return;
			saved = true;
			const newTitle = input.value.trim();
			if (newTitle && newTitle !== card.title) {
				card.title = newTitle;
				await this.saveBoard();
			}
			cardEl.draggable = true;
			await this.render();
		};

		input.addEventListener('blur', () => save());
		input.addEventListener('keydown', (e) => {
			if (e.key === 'Enter') {
				e.preventDefault();
				input.blur();
			} else if (e.key === 'Escape') {
				saved = true;
				cardEl.draggable = true;
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
		cardEl.draggable = false;
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
			if (newText.trim() === '') {
				card.rawBodyLines = [];
			} else {
				card.rawBodyLines = newText.split('\n').map(line => {
					if (line.trim() === '') return '';
					return prefix + line;
				});
			}
			await this.saveBoard();
			cardEl.draggable = true;
			await this.render();
		};

		textarea.addEventListener('blur', () => save());
		textarea.addEventListener('keydown', (e) => {
			if (e.key === 'Escape') {
				saved = true;
				cardEl.draggable = true;
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

	// --- Helpers ---

	private clearDropIndicators(): void {
		this.contentEl.querySelectorAll('.drop-above, .drop-below, .drop-before, .drop-after, .drop-at-end')
			.forEach(el => {
				el.classList.remove('drop-above', 'drop-below', 'drop-before', 'drop-after', 'drop-at-end');
			});
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
