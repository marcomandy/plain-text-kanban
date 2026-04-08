import {ItemView, WorkspaceLeaf, TFile, MarkdownRenderer, Component, ViewStateResult, Scope, setIcon} from 'obsidian';
import {KanbanBoard, KanbanColumn, KanbanCard, Swimlane, NO_LABEL_TOKEN} from './types';
import {parseKanban} from './parser';
import {serializeKanban} from './serializer';
import {KanbanPluginSettings, resolveSettings} from './settings';
import type KanbanPlugin from './main';

export const KANBAN_VIEW_TYPE = 'plain-text-kanban';

interface DragState {
	type: 'card' | 'column';
	sourceColIndex: number;
	sourceCardIndex: number;
	swimlaneIndex: number;
}

export class KanbanView extends ItemView {
	private board: KanbanBoard = {columns: [], labelColors: {}, swimlanes: []};
	private filePath = '';
	private isWriting = false;
	private dragState: DragState | null = null;
	private renderChild: Component | null = null;
	private undoStack: string[] = [];
	private redoStack: string[] = [];
	private dragPlaceholder: HTMLElement | null = null;
	private dragHandleActive = false;
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

		this.addAction('settings', 'Board view settings', (e) => {
			this.showBoardSettingsPopover(e as unknown as MouseEvent);
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

	private getEffectiveSettings(): KanbanPluginSettings {
		const overrides = this.plugin.getBoardSettings(this.filePath);
		return resolveSettings(overrides);
	}

	private showBoardSettingsPopover(evt: MouseEvent): void {
		const existing = document.querySelector('.kanban-board-settings-popover');
		if (existing) { existing.remove(); return; }

		const popover = document.createElement('div');
		popover.className = 'kanban-board-settings-popover';

		const effective = this.getEffectiveSettings();

		const settingsItems: {key: keyof KanbanPluginSettings; label: string}[] = [
			{key: 'hideCardCounter', label: 'Hide card counter'},
			{key: 'hideAddLabelButtons', label: 'Hide "Add label" buttons'},
			{key: 'hideAddDescription', label: 'Hide "Add description"'},
			{key: 'hoverOnlyButtons', label: 'Show buttons on hover only'},
			{key: 'hideSwimlanes', label: 'Hide swimlanes'},
		];

		const title = popover.createDiv({cls: 'kanban-board-settings-title'});
		title.setText('Board view settings');

		const hint = popover.createDiv({cls: 'kanban-board-settings-hint'});
		hint.setText('Stored locally on this device.');

		for (const item of settingsItems) {
			const row = popover.createDiv({cls: 'kanban-board-settings-row'});
			const labelEl = row.createDiv({cls: 'kanban-board-settings-label'});
			labelEl.createDiv({text: item.label, cls: 'kanban-board-settings-label-name'});

			const toggle = row.createDiv({cls: 'checkbox-container' + (effective[item.key] ? ' is-enabled' : '')});
			toggle.addEventListener('click', async () => {
				const newValue = !toggle.hasClass('is-enabled');
				toggle.toggleClass('is-enabled', newValue);
				await this.plugin.setBoardSetting(this.filePath, item.key, newValue);
			});
		}

		document.body.appendChild(popover);

		// Position near the clicked element
		const btnRect = (evt.target as HTMLElement).getBoundingClientRect();
		popover.style.top = `${btnRect.bottom + 4}px`;
		popover.style.right = `${document.body.clientWidth - btnRect.right}px`;

		const onClickOutside = (e: MouseEvent) => {
			if (!popover.contains(e.target as Node) && e.target !== evt.target) {
				popover.remove();
				document.removeEventListener('mousedown', onClickOutside);
			}
		};
		setTimeout(() => document.addEventListener('mousedown', onClickOutside), 0);
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
		// Save scroll positions for each board
		const existingBoards = Array.from(this.contentEl.querySelectorAll('.kanban-board'));
		const savedScrolls = existingBoards.map(b => ({
			left: (b as HTMLElement).scrollLeft,
			tops: Array.from(b.querySelectorAll('.kanban-column-body')).map(c => (c as HTMLElement).scrollTop),
		}));

		// Clean up previous render components
		if (this.renderChild) {
			this.removeChild(this.renderChild);
		}
		this.renderChild = new Component();
		this.addChild(this.renderChild);

		const container = this.contentEl;
		container.empty();

		// Ensure at least one swimlane
		if (this.board.swimlanes.length === 0) {
			this.board.swimlanes = [{labels: []}];
		}

		const settings = this.getEffectiveSettings();

		if (settings.hideSwimlanes) {
			const boardEl = container.createDiv({cls: 'kanban-board'});
			this.applyBoardClasses(boardEl);
			await this.renderBoardContent(boardEl, null, 0);
			if (savedScrolls[0]) {
				boardEl.scrollLeft = savedScrolls[0].left;
				boardEl.querySelectorAll('.kanban-column-body').forEach((body, i) => {
					if (savedScrolls[0]!.tops[i] !== undefined) {
						(body as HTMLElement).scrollTop = savedScrolls[0]!.tops[i]!;
					}
				});
			}
		} else {
			const swimlanesContainer = container.createDiv({cls: 'kanban-swimlanes-container'});
			for (let i = 0; i < this.board.swimlanes.length; i++) {
				const swimlane = this.board.swimlanes[i]!;
				const swimlaneEl = swimlanesContainer.createDiv({cls: 'kanban-swimlane'});
				this.renderSwimlaneHeader(swimlaneEl, swimlane, i);

				const boardEl = swimlaneEl.createDiv({cls: 'kanban-board'});
				this.applyBoardClasses(boardEl);
				await this.renderBoardContent(boardEl, swimlane.labels, i);
				if (savedScrolls[i]) {
					const saved = savedScrolls[i]!;
					boardEl.scrollLeft = saved.left;
					boardEl.querySelectorAll('.kanban-column-body').forEach((body, j) => {
						if (saved.tops[j] !== undefined) {
							(body as HTMLElement).scrollTop = saved.tops[j]!;
						}
					});
				}

				const addBtn = swimlanesContainer.createDiv({cls: 'kanban-add-swimlane-btn'});
				addBtn.setText('+ Add swimlane');
				const insertIdx = i + 1;
				addBtn.addEventListener('click', () => this.addSwimlane(insertIdx));
			}
		}
	}

	private applyBoardClasses(boardEl: HTMLElement): void {
		const settings = this.getEffectiveSettings();
		if (settings.hideCardCounter) boardEl.addClass('kanban-hide-counter');
		if (settings.hideAddLabelButtons) boardEl.addClass('kanban-hide-add-label');
		if (settings.hideAddDescription) boardEl.addClass('kanban-hide-add-description');
		if (settings.hoverOnlyButtons) boardEl.addClass('kanban-hover-buttons');
	}

	private async renderBoardContent(boardEl: HTMLElement, labelFilter: string[] | null, swimlaneIndex: number): Promise<void> {
		if (this.board.columns.length === 0) {
			const addColBtn = boardEl.createDiv({cls: 'kanban-add-column-btn'});
			addColBtn.setText('+ Add column');
			addColBtn.addEventListener('click', () => this.addColumn());
			return;
		}

		const renderPromises: Promise<void>[] = [];
		this.board.columns.forEach((column, colIndex) => {
			if (!column.archived) {
				renderPromises.push(this.renderColumn(boardEl, column, colIndex, labelFilter, swimlaneIndex));
			}
		});

		await Promise.all(renderPromises);
		this.setupBoardDropZone(boardEl, swimlaneIndex);

		const addColBtn = boardEl.createDiv({cls: 'kanban-add-column-btn'});
		addColBtn.setText('+ Add column');
		addColBtn.addEventListener('click', () => this.addColumn());
	}

	private cardMatchesFilter(card: KanbanCard, labelFilter: string[] | null): boolean {
		if (!labelFilter || labelFilter.length === 0) return true;
		const cardTags = this.extractTags(card.title).map(t => t.toLowerCase());
		for (const filterLabel of labelFilter) {
			if (filterLabel === NO_LABEL_TOKEN) {
				if (cardTags.length === 0) return true;
			} else if (cardTags.includes(filterLabel.toLowerCase())) {
				return true;
			}
		}
		return false;
	}

	private renderSwimlaneHeader(swimlaneEl: HTMLElement, swimlane: Swimlane, index: number): void {
		const headerEl = swimlaneEl.createDiv({cls: 'kanban-swimlane-header'});

		headerEl.addEventListener('click', (e) => {
			const target = e.target as HTMLElement;
			if (target.closest('.kanban-swimlane-label-remove') || target.closest('.kanban-swimlane-delete') || target.closest('.kanban-swimlane-label-dropdown')) return;
			this.showSwimlaneAddLabel(headerEl, index);
		});

		const labelsEl = headerEl.createDiv({cls: 'kanban-swimlane-labels'});
		if (swimlane.labels.length === 0) {
			labelsEl.createSpan({cls: 'kanban-swimlane-all-labels', text: 'All labels'});
		} else {
			for (const label of swimlane.labels) {
				const displayName = label === NO_LABEL_TOKEN ? 'no label' : label;
				const color = label === NO_LABEL_TOKEN ? '#64748b' : this.getLabelColor(label);
				const pill = labelsEl.createDiv({cls: 'kanban-swimlane-label'});
				pill.style.backgroundColor = color;
				pill.style.color = this.getContrastColor(color);
				pill.createSpan({text: displayName});
				const removeBtn = pill.createEl('button', {cls: 'kanban-swimlane-label-remove', attr: {'aria-label': 'Remove filter label'}});
				removeBtn.setText('\u00D7');
				removeBtn.addEventListener('click', (e) => {
					e.stopPropagation();
					this.removeSwimlaneLabel(index, label);
				});
			}
		}

		const addLabelBtn = headerEl.createEl('button', {cls: 'kanban-swimlane-add-label'});
		addLabelBtn.setText('+ Label');

		if (this.board.swimlanes.length > 1) {
			const deleteBtn = headerEl.createEl('button', {cls: 'kanban-swimlane-delete', attr: {'aria-label': 'Delete swimlane'}});
			deleteBtn.setText('\u00D7');
			deleteBtn.addEventListener('click', (e) => {
				e.stopPropagation();
				this.deleteSwimlane(index);
			});
		}
	}

	private showSwimlaneAddLabel(headerEl: HTMLElement, swimlaneIndex: number): void {
		if (headerEl.querySelector('.kanban-swimlane-label-dropdown')) return;

		const swimlane = this.board.swimlanes[swimlaneIndex];
		if (!swimlane) return;

		const allLabels = new Set<string>();
		for (const col of this.board.columns) {
			for (const card of col.cards) {
				for (const tag of this.extractTags(card.title)) {
					allLabels.add(tag.toLowerCase());
				}
			}
		}

		const dropdown = headerEl.createDiv({cls: 'kanban-swimlane-label-dropdown'});

		const input = dropdown.createEl('input', {
			cls: 'kanban-swimlane-label-input',
			attr: {placeholder: 'Type label name...', type: 'text'},
		});

		const optionsEl = dropdown.createDiv({cls: 'kanban-swimlane-label-options'});

		const renderOptions = (filter: string) => {
			optionsEl.empty();

			if (!swimlane.labels.includes(NO_LABEL_TOKEN)) {
				if (!filter || 'no label'.includes(filter)) {
					const opt = optionsEl.createDiv({cls: 'kanban-swimlane-label-option'});
					const pill = opt.createSpan({cls: 'kanban-label'});
					pill.style.backgroundColor = '#64748b';
					pill.style.color = '#ffffff';
					pill.setText('no label');
					opt.addEventListener('click', () => {
						this.addSwimlaneLabel(swimlaneIndex, NO_LABEL_TOKEN);
					});
				}
			}

			for (const label of allLabels) {
				if (swimlane.labels.includes(label)) continue;
				if (filter && !label.includes(filter)) continue;
				const opt = optionsEl.createDiv({cls: 'kanban-swimlane-label-option'});
				const color = this.getLabelColor(label);
				const pill = opt.createSpan({cls: 'kanban-label'});
				pill.style.backgroundColor = color;
				pill.style.color = this.getContrastColor(color);
				pill.setText(label);
				opt.addEventListener('click', () => {
					this.addSwimlaneLabel(swimlaneIndex, label);
				});
			}
		};

		renderOptions('');
		input.focus();

		input.addEventListener('input', () => {
			renderOptions(input.value.trim().toLowerCase());
		});

		input.addEventListener('keydown', (e) => {
			if (e.key === 'Enter') {
				e.preventDefault();
				const val = input.value.trim().toLowerCase().replace(/^#/, '');
				if (val) {
					if (val === 'no-label' || val === 'no label') {
						this.addSwimlaneLabel(swimlaneIndex, NO_LABEL_TOKEN);
					} else {
						this.addSwimlaneLabel(swimlaneIndex, val);
					}
				} else {
					dropdown.remove();
				}
			} else if (e.key === 'Escape') {
				dropdown.remove();
			}
		});

		const onClickOutside = (e: MouseEvent) => {
			if (!dropdown.contains(e.target as Node)) {
				dropdown.remove();
				document.removeEventListener('mousedown', onClickOutside);
			}
		};
		setTimeout(() => document.addEventListener('mousedown', onClickOutside), 0);
	}

	private async addSwimlane(afterIndex: number): Promise<void> {
		this.pushUndo();
		this.board.swimlanes.splice(afterIndex, 0, {labels: []});
		await this.saveBoard();
		await this.render();
	}

	private async deleteSwimlane(index: number): Promise<void> {
		if (this.board.swimlanes.length <= 1) return;
		this.pushUndo();
		this.board.swimlanes.splice(index, 1);
		await this.saveBoard();
		await this.render();
	}

	private async addSwimlaneLabel(swimlaneIndex: number, label: string): Promise<void> {
		const swimlane = this.board.swimlanes[swimlaneIndex];
		if (!swimlane || swimlane.labels.includes(label)) return;
		this.pushUndo();
		swimlane.labels.push(label);
		await this.saveBoard();
		await this.render();
	}

	private async removeSwimlaneLabel(swimlaneIndex: number, label: string): Promise<void> {
		const swimlane = this.board.swimlanes[swimlaneIndex];
		if (!swimlane) return;
		const idx = swimlane.labels.indexOf(label);
		if (idx < 0) return;
		this.pushUndo();
		swimlane.labels.splice(idx, 1);
		await this.saveBoard();
		await this.render();
	}

	private async renderColumn(boardEl: HTMLElement, column: KanbanColumn, colIndex: number, labelFilter: string[] | null, swimlaneIndex: number): Promise<void> {
		const columnEl = boardEl.createDiv({cls: 'kanban-column'});
		columnEl.dataset.colIndex = String(colIndex);
		columnEl.dataset.swimlaneIndex = String(swimlaneIndex);
		columnEl.draggable = true;

		// Column header
		const headerEl = columnEl.createDiv({cls: 'kanban-column-header'});

		const dragHandle = headerEl.createDiv({cls: 'kanban-drag-handle'});
		setIcon(dragHandle, 'grip-vertical');

		const headerLeft = headerEl.createDiv({cls: 'kanban-column-header-left'});
		const titleSpan = headerLeft.createEl('span', {text: column.title, cls: 'kanban-column-title'});
		const filteredCount = column.cards.filter(c => this.cardMatchesFilter(c, labelFilter)).length;
		headerLeft.createEl('span', {text: String(filteredCount), cls: 'kanban-column-count'});

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

		this.setupColumnDrag(dragHandle, columnEl, colIndex, swimlaneIndex);

		// Card container
		const bodyEl = columnEl.createDiv({cls: 'kanban-column-body'});
		bodyEl.dataset.swimlaneIndex = String(swimlaneIndex);

		const cardPromises: Promise<void>[] = [];
		column.cards.forEach((card, cardIndex) => {
			if (this.cardMatchesFilter(card, labelFilter)) {
				cardPromises.push(this.renderCard(bodyEl, card, colIndex, cardIndex, swimlaneIndex, labelFilter));
			}
		});

		await Promise.all(cardPromises);

		// Add card button
		const addCardBtn = bodyEl.createDiv({cls: 'kanban-add-card-btn'});
		addCardBtn.setText('+ Add card');
		addCardBtn.addEventListener('click', () => this.addCard(colIndex, labelFilter));

		this.setupCardDropZone(bodyEl, colIndex, swimlaneIndex);
	}

	private async renderCard(
		bodyEl: HTMLElement,
		card: KanbanCard,
		colIndex: number,
		cardIndex: number,
		swimlaneIndex: number,
		labelFilter: string[] | null,
	): Promise<void> {
		const cardEl = bodyEl.createDiv({cls: 'kanban-card'});
		cardEl.dataset.cardIndex = String(cardIndex);
		cardEl.draggable = true;

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
			this.addLabelToCard(colIndex, cardIndex, card, cardEl);
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

		this.setupCardDrag(dragHandle, cardEl, colIndex, cardIndex, swimlaneIndex);
	}

	// --- Drag & Drop: Cards ---

	private setupCardDrag(dragHandle: HTMLElement, cardEl: HTMLElement, colIndex: number, cardIndex: number, swimlaneIndex: number): void {
		dragHandle.addEventListener('mousedown', () => {
			this.dragHandleActive = true;
		});
		dragHandle.addEventListener('touchstart', () => {
			this.dragHandleActive = true;
		}, {passive: true});

		cardEl.addEventListener('dragstart', (e) => {
			if (!this.dragHandleActive) {
				e.preventDefault();
				return;
			}
			e.stopPropagation();
			this.dragState = {type: 'card', sourceColIndex: colIndex, sourceCardIndex: cardIndex, swimlaneIndex};
			if (e.dataTransfer) {
				e.dataTransfer.effectAllowed = 'move';
				e.dataTransfer.setData('text/plain', '');
			}
			setTimeout(() => cardEl.addClass('dragging'), 0);
		});

		cardEl.addEventListener('dragend', () => {
			this.dragHandleActive = false;
			cardEl.removeClass('dragging');
			this.dragState = null;
			this.removePlaceholder();
			this.clearDropIndicators();
		});
	}

	private setupCardDropZone(bodyEl: HTMLElement, targetColIndex: number, swimlaneIndex: number): void {
		bodyEl.addEventListener('dragover', (e) => {
			if (!this.dragState || this.dragState.type !== 'card') return;
			if (this.dragState.swimlaneIndex !== swimlaneIndex) return;
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
			if (this.dragState.swimlaneIndex !== swimlaneIndex) return;

			const cards = Array.from(bodyEl.querySelectorAll('.kanban-card:not(.dragging)')) as HTMLElement[];
			let targetIndex: number;

			if (cards.length === 0) {
				targetIndex = this.board.columns[targetColIndex]?.cards.length ?? 0;
			} else {
				targetIndex = parseInt(cards[cards.length - 1]?.dataset.cardIndex ?? '0') + 1;
				for (let i = 0; i < cards.length; i++) {
					const rect = cards[i]?.getBoundingClientRect();
					if (rect && e.clientY < rect.top + rect.height / 2) {
						targetIndex = parseInt(cards[i]?.dataset.cardIndex ?? '0');
						break;
					}
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

	private setupColumnDrag(dragHandle: HTMLElement, columnEl: HTMLElement, colIndex: number, swimlaneIndex: number): void {
		dragHandle.addEventListener('mousedown', () => {
			this.dragHandleActive = true;
		});
		dragHandle.addEventListener('touchstart', () => {
			this.dragHandleActive = true;
		}, {passive: true});

		columnEl.addEventListener('dragstart', (e) => {
			if (!this.dragHandleActive) {
				e.preventDefault();
				return;
			}
			this.dragState = {type: 'column', sourceColIndex: colIndex, sourceCardIndex: -1, swimlaneIndex};
			if (e.dataTransfer) {
				e.dataTransfer.effectAllowed = 'move';
				e.dataTransfer.setData('text/plain', '');
			}
			setTimeout(() => columnEl.addClass('dragging'), 0);
		});

		columnEl.addEventListener('dragend', () => {
			this.dragHandleActive = false;
			columnEl.removeClass('dragging');
			this.dragState = null;
			this.removePlaceholder();
			this.clearDropIndicators();
		});
	}

	private setupBoardDropZone(boardEl: HTMLElement, _swimlaneIndex: number): void {
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

	private async addCard(colIndex: number, labelFilter?: string[] | null): Promise<void> {
		const column = this.board.columns[colIndex];
		if (!column) return;
		this.pushUndo();
		let title = 'New card';
		if (labelFilter && labelFilter.length > 0) {
			const tags = labelFilter.filter(l => l !== NO_LABEL_TOKEN).map(l => `#${l}`);
			if (tags.length > 0) {
				title = `New card ${tags.join(' ')}`;
			}
		}
		column.cards.push({title, rawBodyLines: []});
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

	private async addLabelToCard(colIndex: number, cardIndex: number, card: KanbanCard, cardEl: HTMLElement): Promise<void> {
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

		// Match quoted paths (with spaces allowed) or unquoted paths (no spaces)
		// Group 1: quote char, Group 2: quoted path, Group 3: unquoted Windows path, Group 4: unquoted Unix path
		const pathRegex = /(?:(["'])(([A-Za-z]:[\\\/][^"'<>*?|]*[^"'<>*?|\s])|\/(?:[\w. -]+\/)+[\w.-]+)\1)|([A-Za-z]:[\\\/][^\s<>"'*?|]+)|(?:\/(?:[\w.-]+\/)+[\w.-]+)/g;

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
				const fullMatch = match[0];
				const quote = match[1];
				const quotedPath = match[2];
				const unquotedWin = match[4];
				// Determine the actual file path (strip surrounding quotes)
				const pathStr = quotedPath || unquotedWin || fullMatch;

				if (match.index > lastIndex) {
					fragment.appendChild(document.createTextNode(text.slice(lastIndex, match.index)));
				}

				// If quoted, show the quotes as text around the link
				if (quote) {
					fragment.appendChild(document.createTextNode(quote));
				}

				const link = document.createElement('a');
				link.textContent = pathStr;
				link.className = 'external-link os-path-link';
				link.setAttribute('href', '#');
				link.dataset.osPath = pathStr;
				link.addEventListener('click', (e) => {
					e.preventDefault();
					e.stopPropagation();
					this.openOsPath(pathStr);
				});
				fragment.appendChild(link);

				if (quote) {
					fragment.appendChild(document.createTextNode(quote));
				}

				lastIndex = match.index + fullMatch.length;
			}

			if (hasMatch) {
				if (lastIndex < text.length) {
					fragment.appendChild(document.createTextNode(text.slice(lastIndex)));
				}
				textNode.parentNode?.replaceChild(fragment, textNode);
			}
		}
	}

	private openOsPath(pathStr: string): void {
		// Use Electron shell to open the path natively (works for files and folders)
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		const electron = (window as any).require?.('electron');
		if (electron?.remote?.shell) {
			electron.remote.shell.openPath(pathStr);
		} else if (electron?.shell) {
			electron.shell.openPath(pathStr);
		} else {
			// Fallback: open as file:// URI
			let fileUri: string;
			if (/^[A-Za-z]:/.test(pathStr)) {
				fileUri = 'file:///' + pathStr.replace(/\\/g, '/');
			} else {
				fileUri = 'file://' + pathStr;
			}
			window.open(fileUri);
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
			if (line.trim() === '') return '&nbsp;';
			if (line.startsWith(prefix)) return line.substring(prefix.length);
			return line.trimStart();
		}).join('\n').trim();
	}
}
