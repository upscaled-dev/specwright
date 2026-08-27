import type {
  BoardClientMessage,
  BoardHostMessage,
  BoardRenderMessage,
  BoardSectionMeta,
  BoardTestLink,
  BoardVerb,
  SelectableScenarioCard,
  SelectableTestCard,
} from "../protocol";
import { installBoardTables } from "./board-tables";

export function installBoard(): void {
  type MappingSection = "untraced" | "available" | "mapped";
  type CollapsibleSection = "available" | "mapped";
  type MappingAction = Extract<BoardClientMessage, { type: "createTestSet" | "addToTestSet" | "createTestPlan" | "addToTestPlan" }>["type"];
  interface MappingElements {
    readonly name: MappingSection;
    readonly count: HTMLElement;
    readonly cards: HTMLElement;
    readonly search: HTMLInputElement;
    readonly paginator: HTMLElement;
  }
  const element = <T extends HTMLElement>(id: string): T => {
    const found = document.getElementById(id);
    if (!found) {throw new Error(`Missing board element: ${id}`);}
    return found as T;
  };
  const search = element<HTMLInputElement>('search');
  const scopeSelect = element<HTMLSelectElement>('scope-select');
  const scenarioCards = element<HTMLElement>('scenario-cards');
  const createTests = element<HTMLButtonElement>('create-tests');
  const createExecution = element<HTMLButtonElement>('create-execution');
  const scenarioActionHelper = element<HTMLElement>('scenario-action-helper');
  const mappingActionButtons = [...document.querySelectorAll<HTMLButtonElement>('[data-mapping-action]')];
  const mappingActionHelpers = [...document.querySelectorAll<HTMLElement>('[data-mapping-helper]')];
  const availableCards = element<HTMLElement>('available-cards');
  const mappedCards = element<HTMLElement>('mapped-cards');
  const scenarioCount = element<HTMLElement>('scenario-count');
  const availableCount = element<HTMLElement>('available-count');
  const mappedCount = element<HTMLElement>('mapped-count');
  const scenarioSearch = element<HTMLInputElement>('scenario-search');
  const availableSearch = element<HTMLInputElement>('available-search');
  const mappedSearch = element<HTMLInputElement>('mapped-search');
  const scenarioPaginator = element<HTMLElement>('scenario-paginator');
  const availablePaginator = element<HTMLElement>('available-paginator');
  const mappedPaginator = element<HTMLElement>('mapped-paginator');
  const pageSizeSelect = element<HTMLSelectElement>('page-size-select');
  const syncNow = element<HTMLButtonElement>('sync-now');
  const syncScope = element<HTMLButtonElement>('sync-scope');
  const syncStrip = element<HTMLElement>('sync-strip');
  const syncStripText = element<HTMLElement>('sync-strip-text');
  const tables = installBoardTables();
  scenarioSearch.dataset["focusKey"] = "untraced-search";
  availableSearch.dataset["focusKey"] = "available-search";
  mappedSearch.dataset["focusKey"] = "mapped-search";
  pageSizeSelect.dataset["focusKey"] = "page-size";
  syncNow.dataset["focusKey"] = "sync";
  syncNow.dataset["focusFallback"] = "page-size";

  const savedCollapsed = window.__spec.state()["mappingCollapsed"];
  const collapsed = new Set<CollapsibleSection>(
    Array.isArray(savedCollapsed)
      ? savedCollapsed.filter((item): item is CollapsibleSection => item === "available" || item === "mapped")
      : []
  );
  const collapsible = (section: CollapsibleSection): { toggle: HTMLButtonElement; content: HTMLElement } => ({
    toggle: element<HTMLButtonElement>(`${section}-toggle`),
    content: element<HTMLElement>(`${section}-content`),
  });
  const collapsibleSections: Record<CollapsibleSection, { toggle: HTMLButtonElement; content: HTMLElement }> = {
    available: collapsible("available"),
    mapped: collapsible("mapped"),
  };
  const selectAllBoxes: Record<CollapsibleSection, HTMLInputElement> = {
    available: element<HTMLInputElement>("available-select-all"),
    mapped: element<HTMLInputElement>("mapped-select-all"),
  };

  function renderCollapsed(section: CollapsibleSection): void {
    const controls = collapsibleSections[section];
    const isCollapsed = collapsed.has(section);
    controls.toggle.setAttribute("aria-expanded", String(!isCollapsed));
    controls.content.hidden = isCollapsed;
  }

  function toggleSection(section: CollapsibleSection): void {
    if (collapsed.has(section)) {collapsed.delete(section);} else {collapsed.add(section);}
    renderCollapsed(section);
    window.__spec.saveState({ mappingCollapsed: [...collapsed] });
  }

  for (const section of ["available", "mapped"] as const) {
    const controls = collapsibleSections[section];
    controls.toggle.dataset["focusKey"] = `${section}-toggle`;
    controls.toggle.addEventListener("click", () => {toggleSection(section);});
    renderCollapsed(section);
    // The list's select-all posts the box's new state, like a card's own checkbox: a mixed box lands on
    // checked, so it selects the rest of the list, and a full one clears it. The host owns the scope.
    const box = selectAllBoxes[section];
    box.dataset["focusKey"] = `select-all:${section}`;
    box.dataset["focusFallback"] = `${section}-search`;
    box.addEventListener("change", () => {
      window.__spec.post('board', { type: 'select-scope', section, on: box.checked });
    });
  }

  // A scenario card carries kind 'scenario' + its drop id; a test card kind 'test' + its key. A drop is
  // valid only across the two kinds, so a scenario lands on any test card and an available test on a
  // scenario, never like on like. The drop normalizes both directions to {scenario, key}.
  let dragged: { kind: "scenario" | "test"; id: string } | undefined;
  let keyboardScenarios: string[] = [];
  let keyboardTests: string[] = [];

  function keyboardLink(label: string, scenario: string, key: string, focusFallback: string): HTMLButtonElement {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'pill-button';
    button.textContent = label;
    button.dataset["focusKey"] = `link:${scenario}:${key}`;
    button.dataset["focusFallback"] = focusFallback;
    button.addEventListener('click', () => {
      window.__spec.post('board', { type: 'drop', scenario, key });
    });
    return button;
  }
  function clearDropTargets(): void {
    const marked = document.querySelectorAll('.drop-target');
    marked.forEach((item) => item.classList.remove('drop-target'));
  }
  function isLinkDrag(kind: "scenario" | "test"): boolean {
    return dragged !== undefined && dragged.kind !== kind;
  }
  function wireCardDrag(el: HTMLElement, kind: "scenario" | "test", id: string, draggable: boolean): void {
    if (draggable) {
      el.draggable = true;
      el.addEventListener('dragstart', (e) => {
        dragged = { kind, id };
        if (e.dataTransfer) { e.dataTransfer.effectAllowed = 'link'; }
      });
      el.addEventListener('dragend', () => { dragged = undefined; clearDropTargets(); });
    }
    el.addEventListener('dragover', (e) => {
      if (isLinkDrag(kind)) {
        e.preventDefault();
        if (e.dataTransfer) { e.dataTransfer.dropEffect = 'link'; }
        el.classList.add('drop-target');
      }
    });
    el.addEventListener('dragleave', () => { el.classList.remove('drop-target'); });
    el.addEventListener('drop', (e) => {
      if (!isLinkDrag(kind)) { return; }
      e.preventDefault();
      el.classList.remove('drop-target');
      const activeDrag = dragged;
      if (!activeDrag) {return;}
      const scenario = activeDrag.kind === 'scenario' ? activeDrag.id : id;
      const key = activeDrag.kind === 'scenario' ? id : activeDrag.id;
      window.__spec.post('board', { type: 'drop', scenario, key });
      dragged = undefined;
    });
  }

  function pillEl(text: string): HTMLSpanElement {
    const el = document.createElement('span');
    el.className = 'pill';
    el.textContent = text;
    return el;
  }

  function pillsEl(pills: readonly string[]): HTMLDivElement {
    const wrap = document.createElement('div');
    wrap.className = 'pills';
    for (const pill of pills) { wrap.appendChild(pillEl(pill)); }
    return wrap;
  }

  // A card's secondary line: one line, ellipsized when it does not fit, with the whole text on hover so
  // a truncated path is still readable.
  function metaEl(text: string): HTMLDivElement {
    const el = document.createElement('div');
    el.className = 'meta';
    el.textContent = text;
    el.title = text;
    return el;
  }

  // Carried by the render, not read off the search box: the host filtered these lists against its own
  // query, and a snapshot-driven render can arrive before a keystroke or a clear reaches it.
  let filtering = false;

  // The scope selector's options, All Projects first. The host owns the list and the selection, so this
  // repaints both on every render rather than tracking either.
  function renderScope(projects: readonly string[], project: string): void {
    scopeSelect.textContent = '';
    const all = document.createElement('option');
    all.value = '';
    all.textContent = 'All projects';
    scopeSelect.appendChild(all);
    for (const key of projects) {
      const option = document.createElement('option');
      option.value = key;
      option.textContent = key;
      scopeSelect.appendChild(option);
    }
    scopeSelect.value = project;
  }

  // A section's empty line. The host passes whether that section is being filtered (its own column search
  // or the header one), so a section emptied by a query says that instead of its nothing-to-map text. The
  // flag is host-supplied per section and never read off the input boxes, which would race the render.
  function emptyEl(text: string, isFiltering: boolean): HTMLDivElement {
    const el = document.createElement('div');
    el.className = 'empty';
    el.textContent = isFiltering ? 'No matches.' : text;
    return el;
  }

  // A create verb, painted from the host's decision: label, enabled, and the tooltip that says what a
  // disabled button is waiting for.
  function renderVerb(button: HTMLButtonElement, verb: BoardVerb, fallback: string): void {
    button.textContent = verb.label || fallback;
    button.disabled = verb.enabled !== true;
    button.title = verb.hint || '';
  }

  // Icon actions keep their static SVG; only state and accessible words change on a render.
  function renderIconVerb(button: HTMLButtonElement, verb: BoardVerb, fallback: string): void {
    const label = verb.label || fallback;
    const hint = verb.hint || '';
    const tooltip = hint ? `${label  }. ${  hint}` : label;
    button.disabled = verb.enabled !== true;
    button.setAttribute('aria-label', label);
    if (button.nextElementSibling) {button.nextElementSibling.textContent = tooltip;}
  }

  function mappingAction(action: string | undefined): MappingAction | undefined {
    if (action === 'createTestSet' || action === 'addToTestSet' || action === 'createTestPlan' || action === 'addToTestPlan') {
      return action;
    }
    return undefined;
  }

  function mappingVerb(action: MappingAction, msg: BoardRenderMessage): BoardVerb {
    return action === 'createTestSet' ? msg.testSetVerb
      : action === 'addToTestSet' ? msg.addToTestSetVerb
        : action === 'createTestPlan' ? msg.testPlanVerb
          : msg.addToTestPlanVerb;
  }

  // A card's checkbox. The host owns both selections, so this posts the box's new state under its
  // target and paints whatever comes back on the next render.
  function selectBox(target: "scenario" | "test", id: string, label: string, checked: boolean): HTMLInputElement {
    const check = document.createElement('input');
    check.type = 'checkbox';
    check.checked = checked === true;
    check.setAttribute('aria-label', label);
    check.dataset["focusKey"] = `${target}:${id}`;
    check.addEventListener('change', () => {
      window.__spec.post('board', { type: 'select', target, id, on: check.checked });
    });
    return check;
  }

  function paintScenarioCards(container: HTMLElement, cards: readonly SelectableScenarioCard[]): void {
    for (const card of cards) {
      const el = document.createElement('div');
      el.className = 'card';
      const head = document.createElement('div');
      head.className = 'pick';
      head.appendChild(selectBox('scenario', card.dropId, `Select scenario ${  card.name}`, card.selected));
      const title = document.createElement('div');
      title.className = 'title';
      title.textContent = card.name;
      head.appendChild(title);
      el.appendChild(head);
      el.appendChild(metaEl(card.location));
      if (card.pills.length > 0) { el.appendChild(pillsEl(card.pills)); }
      if (keyboardTests[0]) {el.appendChild(keyboardLink('Link to selected test', card.dropId, keyboardTests[0], `scenario:${card.dropId}`));}
      wireCardDrag(el, 'scenario', card.dropId, true);
      container.appendChild(el);
    }
  }

  // One of a link row's two buttons. The host owns every decision behind them; this only posts the
  // row's {scenario, key} under the given message type.
  function rowAction(label: string, title: string, type: "pushText" | "unlink", link: BoardTestLink, key: string): HTMLButtonElement {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'pill-button';
    btn.textContent = label;
    btn.title = title;
    btn.setAttribute('aria-label', `${label  } scenario ${  link.name}`);
    btn.dataset["focusKey"] = `${type}:${link.unlinkId}:${key}`;
    btn.dataset["focusFallback"] = `test:${key}`;
    btn.addEventListener('click', () => {
      window.__spec.post('board', { type, scenario: link.unlinkId, key });
    });
    return btn;
  }

  // A linked scenario on a mapped test card: its name, its location, and the two buttons that act on
  // just this link. The unlink id is the scenario's drop id, the host's only handle back to the tag. The
  // buttons share one nowrap group, so a long name pushes them onto their own line rather than being
  // squeezed to a couple of characters.
  function linkRow(link: BoardTestLink, key: string): HTMLDivElement {
    const row = document.createElement('div');
    row.className = 'link-row';
    const name = document.createElement('div');
    name.className = 'name';
    name.textContent = link.name;
    name.appendChild(metaEl(link.location));
    row.appendChild(name);
    const actions = document.createElement('div');
    actions.className = 'row-actions';
    actions.appendChild(rowAction('Push', 'Sends the local text of this scenario to the test.', 'pushText', link, key));
    actions.appendChild(rowAction('Unlink', 'Removes only this test link.', 'unlink', link, key));
    row.appendChild(actions);
    return row;
  }

  // A right-column test card. Only the available group's cards drag onto a scenario; every card, available
  // or mapped, still accepts a dropped scenario, since a test can carry several.
  function paintTestCards(container: HTMLElement, cards: readonly SelectableTestCard[], draggable: boolean): void {
    for (const card of cards) {
      const el = document.createElement('div');
      el.className = 'card';
      const head = document.createElement('div');
      head.className = 'pick';
      head.appendChild(selectBox('test', card.key, `Select test ${  card.key}`, card.selected));
      const title = document.createElement('div');
      title.className = 'title key';
      title.textContent = card.key;
      head.appendChild(title);
      el.appendChild(head);
      if (card.summary) { el.appendChild(metaEl(card.summary)); }
      if (card.pills.length > 0) { el.appendChild(pillsEl(card.pills)); }
      for (const link of card.links) { el.appendChild(linkRow(link, card.key)); }
      if (keyboardScenarios[0]) {el.appendChild(keyboardLink('Link selected scenario', keyboardScenarios[0], card.key, `test:${card.key}`));}
      wireCardDrag(el, 'test', card.key, draggable);
      container.appendChild(el);
    }
  }

  // A section's paginator: a prev/next pair the host clamps (so a button only disables at its end) and a
  // "12-24 of 130" range over the filtered set. An empty section carries no range, so the row never reads
  // a window over nothing; the empty state under it says why.
  function pageButton(label: string, section: MappingSection, step: "prev" | "next", disabled: boolean): HTMLButtonElement {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'pill-button';
    btn.textContent = label;
    btn.disabled = disabled;
    btn.dataset["focusKey"] = `page:${section}:${step}`;
    btn.dataset["focusFallback"] = `${section}-search`;
    btn.addEventListener('click', () => {
      window.__spec.post('board', { type: 'page', section, step });
    });
    return btn;
  }

  function renderPaginator(container: HTMLElement, section: MappingSection, meta: BoardSectionMeta): void {
    container.textContent = '';
    if (meta.filtered === 0) { return; }
    const first = meta.page * meta.pageSize + 1;
    const last = Math.min(first + meta.pageSize - 1, meta.filtered);
    const range = document.createElement('span');
    range.className = 'range';
    range.textContent = `${first  }-${  last  } of ${  meta.filtered}`;
    container.appendChild(pageButton('Prev', section, 'prev', meta.page <= 0));
    container.appendChild(range);
    container.appendChild(pageButton('Next', section, 'next', meta.page >= meta.pageCount - 1));
  }

  // One card-list section's shared chrome: its header count from the honest total, its search box echoed
  // only when it is not focused so a repaint never jumps a mid-type cursor, its empty state read from the
  // host's per-section filtering flag, and its paginator. The cards are the caller's to paint, since a
  // scenario card and a test card share only this frame.
  function paintSection<T>(
    section: MappingElements,
    cards: readonly T[],
    meta: BoardSectionMeta,
    empty: HTMLElement,
    paintCards: (container: HTMLElement, cards: readonly T[]) => void
  ): void {
    section.count.textContent = `(${  meta.total  })`;
    if (document.activeElement !== section.search) { section.search.value = meta.query; }
    section.cards.textContent = '';
    if (meta.filtered === 0) {
      section.cards.appendChild(empty);
    } else {
      paintCards(section.cards, cards);
    }
    renderPaginator(section.paginator, section.name, meta);
  }

  const mapping: Record<MappingSection, MappingElements> = {
    untraced: { name: 'untraced', count: scenarioCount, cards: scenarioCards, search: scenarioSearch, paginator: scenarioPaginator },
    available: { name: 'available', count: availableCount, cards: availableCards, search: availableSearch, paginator: availablePaginator },
    mapped: { name: 'mapped', count: mappedCount, cards: mappedCards, search: mappedSearch, paginator: mappedPaginator },
  };

  // A list's select-all box, painted from the host's count over the whole filtered list. The mixed state
  // has no HTML attribute, so it is set as a property; an empty list has nothing to select, so its box
  // goes dead rather than toggling itself straight back.
  function renderSelectAll(section: CollapsibleSection, meta: BoardSectionMeta): void {
    const box = selectAllBoxes[section];
    box.checked = meta.selection === 'all';
    box.indeterminate = meta.selection === 'some';
    box.disabled = meta.filtered === 0;
  }

  function canRestoreFocus(item: HTMLElement): boolean {
    return !(item instanceof HTMLButtonElement || item instanceof HTMLInputElement || item instanceof HTMLSelectElement) || !item.disabled;
  }

  function renderMapping(msg: BoardRenderMessage): void {
    const focusKey = document.activeElement instanceof HTMLElement ? document.activeElement.dataset["focusKey"] : undefined;
    const focusFallback = document.activeElement instanceof HTMLElement ? document.activeElement.dataset["focusFallback"] : undefined;
    keyboardScenarios = msg.scenarios.filter((card) => card.selected).map((card) => card.dropId);
    keyboardTests = [...msg.available, ...msg.mapped].filter((card) => card.selected).map((card) => card.key);
    const sections = msg.sections;
    paintSection(mapping.untraced, msg.scenarios, sections.untraced, emptyEl('No untraced scenarios.', sections.untraced.filtering), paintScenarioCards);
    const availableEmpty = emptyEl(msg.availableEmptyText, sections.available.filtering);
    paintSection(mapping.available, msg.available, sections.available, availableEmpty, (container, cards) => paintTestCards(container, cards, true));
    paintSection(mapping.mapped, msg.mapped, sections.mapped, emptyEl('No mapped tests yet.', sections.mapped.filtering), (container, cards) => paintTestCards(container, cards, false));
    renderSelectAll('available', sections.available);
    renderSelectAll('mapped', sections.mapped);
    pageSizeSelect.value = String(msg.pageSize);
    if (focusKey) {
      const candidates = [...document.querySelectorAll<HTMLElement>("[data-focus-key]")];
      const target = candidates.find((item) => item.dataset["focusKey"] === focusKey && canRestoreFocus(item)) ??
        candidates.find((item) => item.dataset["focusKey"] === focusFallback && canRestoreFocus(item)) ?? scenarioSearch;
      target.focus();
    }
  }

  // The strip sits above the panes, so a sync reads the same on every tab. The host owns its words: an
  // empty text clears it, and so does every render, so a finished or failed sync cannot strand it.
  function renderSyncProgress(text: string): void {
    syncStripText.textContent = text;
    syncStrip.hidden = text === '';
  }

  search.addEventListener('input', () => { window.__spec.post('board', { type: 'search', value: search.value }); });
  scopeSelect.addEventListener('change', () => { window.__spec.post('board', { type: 'scope', project: scopeSelect.value }); });
  scenarioSearch.addEventListener('input', () => { window.__spec.post('board', { type: 'columnSearch', section: 'untraced', value: scenarioSearch.value }); });
  availableSearch.addEventListener('input', () => { window.__spec.post('board', { type: 'columnSearch', section: 'available', value: availableSearch.value }); });
  mappedSearch.addEventListener('input', () => { window.__spec.post('board', { type: 'columnSearch', section: 'mapped', value: mappedSearch.value }); });
  pageSizeSelect.addEventListener('change', () => { window.__spec.post('board', { type: 'pageSize', size: Number(pageSizeSelect.value) }); });
  syncNow.addEventListener('click', () => { window.__spec.post('board', { type: 'sync' }); });
  syncScope.addEventListener('click', () => { window.__spec.post('board', { type: 'selectSyncProjects' }); });
  createTests.addEventListener('click', () => { window.__spec.post('board', { type: 'bulkCreate' }); });
  for (const button of mappingActionButtons) {
    const action = mappingAction(button.dataset['mappingAction']);
    if (action) {button.addEventListener('click', () => { window.__spec.post('board', { type: action }); });}
  }
  createExecution.addEventListener('click', () => { window.__spec.post('board', { type: 'createTestExecution' }); });

  window.__spec.register('board', (msg: BoardHostMessage) => {
    if (msg.type === 'render') {
      filtering = msg.filtering;
      renderScope(msg.projects, msg.project);
      renderIconVerb(createTests, msg.createVerb, 'Create tests');
      for (const button of mappingActionButtons) {
        const action = mappingAction(button.dataset['mappingAction']);
        if (action) {renderIconVerb(button, mappingVerb(action, msg), button.getAttribute('aria-label') ?? '');}
      }
      renderVerb(createExecution, msg.executionVerb, 'Create Execution');
      renderVerb(syncNow, msg.syncVerb, 'Sync');
      // The picker and the sync share one admission, so the strip's two buttons go dead together rather
      // than leaving the project picker live for a click the host would drop.
      syncScope.disabled = !msg.syncVerb.enabled;
      scenarioActionHelper.textContent = msg.untracedHelper;
      for (const helper of mappingActionHelpers) {helper.textContent = msg.mappingHelper;}
      renderMapping(msg);
      tables.renderMatrix(msg.matrix, filtering);
      tables.renderExecutions(msg.executions, filtering);
      renderSyncProgress('');
    } else if (msg.type === 'syncProgress') {
      renderSyncProgress(msg.text);
    }
  });
}
