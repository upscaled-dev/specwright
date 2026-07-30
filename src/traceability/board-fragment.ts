import { escapeHtml } from "../utils/webview";
import { SurfaceFragment } from "./webview-host";

// Each board pane fills main and owns its own scrolling. Mapping is a flex column whose two card
// columns scroll independently; Matrix and Executions hand all their leftover height to the one
// scroller that holds the sticky-headed table. `minmax(0, 1fr)` is what lets the card columns compress
// below their content: plain `1fr` refuses to, and the whole document scrolls sideways instead.
const BOARD_CSS = `
  .board-pane { display: flex; flex-direction: column; }
  .board-pane .mapping-hint { flex: none; margin: 0 0 0.6rem; padding: 0.5rem 0.7rem; border: 1px solid var(--vscode-widget-border, var(--vscode-panel-border, transparent)); border-radius: 5px; background: var(--vscode-editorWidget-background, var(--vscode-editor-background)); color: var(--vscode-descriptionForeground); font-size: 0.85em; line-height: 1.4; }
  .board-pane .columns { flex: 1; min-height: 0; display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); grid-template-rows: minmax(0, 1fr); gap: 0.75rem; }
  .board-pane .column { min-width: 0; min-height: 0; overflow-y: auto; }
  .board-pane .column h2 { font-size: 0.8rem; text-transform: uppercase; letter-spacing: 0.04em; color: var(--vscode-descriptionForeground); font-weight: 600; margin: 0 0 0.6rem; }
  .board-pane .count { color: var(--vscode-descriptionForeground); font-weight: 400; }
  .board-pane .cards { display: flex; flex-direction: column; gap: 0.375rem; }
  .board-pane .card {
    border: 1px solid var(--vscode-widget-border, var(--vscode-panel-border, transparent));
    border-radius: 5px;
    padding: 0.45rem 0.55rem;
    background: var(--vscode-editorWidget-background, var(--vscode-editor-background));
  }
  .board-pane .card .title { font-weight: 600; word-break: break-word; }
  .board-pane .card .pick { display: flex; align-items: flex-start; gap: 0.45rem; }
  .board-pane .card .pick input { margin: 0.15rem 0 0; }
  .board-pane .verb { padding: 0.25rem 0.7rem; font-family: inherit; font-size: 0.78rem; border: none; border-radius: 3px; background: var(--vscode-button-background); color: var(--vscode-button-foreground); cursor: pointer; }
  .board-pane .verb:hover:enabled { background: var(--vscode-button-hoverBackground); }
  .board-pane .verb:disabled { opacity: 0.55; cursor: default; }
  .board-pane .verbs { flex: none; display: flex; flex-wrap: wrap; gap: 0.4rem; margin: 0 0 0.6rem; }
  .board-pane .card .key { font-family: var(--vscode-editor-font-family, monospace); color: var(--vscode-textLink-foreground); }
  .board-pane .card .meta { color: var(--vscode-descriptionForeground); font-size: 0.85em; margin-top: 0.2rem; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .board-pane .pills { display: flex; flex-wrap: wrap; gap: 0.3rem; margin-top: 0.4rem; }
  .board-pane .pill { font-size: 0.72rem; padding: 0.08rem 0.4rem; border-radius: 999px; background: var(--vscode-badge-background); color: var(--vscode-badge-foreground); }
  .board-pane .group + .group { margin-top: 0.9rem; }
  .board-pane .empty { color: var(--vscode-descriptionForeground); font-style: italic; padding: 0.4rem 0; }
  .board-pane .pill-button { font-family: inherit; font-size: 0.72rem; padding: 0.05rem 0.45rem; border: none; border-radius: 999px; background: var(--vscode-button-secondaryBackground, transparent); color: var(--vscode-button-secondaryForeground, var(--vscode-foreground)); cursor: pointer; }
  .board-pane .pill-button:hover:enabled { background: var(--vscode-button-secondaryHoverBackground, var(--vscode-button-hoverBackground)); }
  .board-pane .pill-button:disabled { cursor: default; }
  .board-pane .empty .sync-now { display: block; margin-top: 0.4rem; }
  .board-pane .card[draggable="true"] { cursor: grab; }
  .board-pane .card.drop-target { outline: 2px dashed var(--vscode-focusBorder); outline-offset: -2px; }
  .board-pane .link-row { display: flex; flex-wrap: wrap; align-items: flex-start; gap: 0.35rem 0.5rem; padding-top: 0.4rem; margin-top: 0.45rem; border-top: 1px solid var(--vscode-widget-border, var(--vscode-panel-border, transparent)); }
  .board-pane .link-row .name { flex: 1 1 12rem; min-width: 0; word-break: break-word; }
  .board-pane .link-row .row-actions { display: flex; flex-wrap: nowrap; gap: 0.3rem; margin-left: auto; }
  .board-pane .matrix-scroll { flex: 1; min-height: 0; overflow: auto; border: 1px solid var(--vscode-widget-border, var(--vscode-panel-border, transparent)); border-radius: 5px; }
  .board-pane table.matrix { border-collapse: collapse; width: 100%; font-size: 0.9em; }
  .board-pane table.matrix th, .board-pane table.matrix td { text-align: left; padding: 0.4rem 0.6rem; white-space: nowrap; border-bottom: 1px solid var(--vscode-widget-border, var(--vscode-panel-border, transparent)); }
  .board-pane table.matrix thead th { position: sticky; top: 0; z-index: 1; background: var(--vscode-editorWidget-background, var(--vscode-editor-background)); font-weight: 600; }
  .board-pane table.matrix td.hole { background: var(--vscode-inputValidation-warningBackground, transparent); }
  .board-pane table.matrix .key { font-family: var(--vscode-editor-font-family, monospace); color: var(--vscode-textLink-foreground); }
  .board-pane table.matrix .wrap { white-space: normal; overflow-wrap: anywhere; min-width: 10rem; }
  .board-pane table.matrix a.link { font-family: var(--vscode-editor-font-family, monospace); color: var(--vscode-textLink-foreground); cursor: pointer; text-decoration: none; }
  .board-pane table.matrix a.link:hover { text-decoration: underline; }
  .board-pane table.matrix td.group-cell { padding: 0; }
  .board-pane table.matrix td.older-cell { text-align: center; }
  .board-pane .group-toggle { display: flex; width: 100%; align-items: baseline; gap: 0.4rem; padding: 0.4rem 0.6rem; border: none; background: var(--vscode-editorWidget-background, var(--vscode-editor-background)); color: var(--vscode-foreground); font-family: inherit; font-size: inherit; font-weight: 600; text-align: left; cursor: pointer; }
  .board-pane .group-toggle:hover { background: var(--vscode-list-hoverBackground, var(--vscode-editorWidget-background)); }
  .board-pane table.matrix tr.execution-parent th, .board-pane table.matrix tr.execution-parent td { background: var(--vscode-editorWidget-background, var(--vscode-editor-background)); font-weight: 600; }
  .board-pane .execution-toggle { width: 1.4rem; margin: 0 0.3rem 0 0; padding: 0; border: none; background: transparent; color: var(--vscode-foreground); font-family: inherit; cursor: pointer; }
  .board-pane .execution-toggle:hover { color: var(--vscode-textLink-activeForeground, var(--vscode-textLink-foreground)); }
  .board-pane tr.execution-child td:first-child { padding-left: 1.4rem; color: var(--vscode-descriptionForeground); }
  #executions-empty { flex: none; }
  @media (max-width: 540px) {
    .board-pane .columns { flex: none; grid-template-columns: minmax(0, 1fr); grid-template-rows: auto; }
    .board-pane .column { overflow: visible; }
  }`;

function boardPanesHtml(providerLabel: string): string {
  const availableHeading = escapeHtml(`Available ${providerLabel} tests`);
  const mappedHeading = escapeHtml(`Mapped ${providerLabel} tests`);
  const testColumn = escapeHtml(`${providerLabel} test`);
  return `    <section id="pane-mapping" class="pane board-pane" data-tab="mapping" hidden>
      <p class="mapping-hint">Drag a scenario from the left onto a test on the right to link them. An available test can also be dragged onto a scenario.</p>
      <div class="columns">
        <div class="column">
          <h2>Untraced scenarios <span id="scenario-count" class="count"></span></h2>
          <div class="verbs">
            <button id="create-tests" class="verb" type="button" disabled>Create tests</button>
          </div>
          <div id="scenario-cards" class="cards"></div>
        </div>
        <div class="column">
          <div class="verbs">
            <button id="create-test-set" class="verb" type="button" disabled>Create Test Set</button>
            <button id="create-test-plan" class="verb" type="button" disabled>Create Test Plan</button>
          </div>
          <div class="group">
            <h2>${availableHeading} <span id="available-count" class="count"></span></h2>
            <div id="available-cards" class="cards"></div>
          </div>
          <div class="group">
            <h2>${mappedHeading} <span id="mapped-count" class="count"></span></h2>
            <div id="mapped-cards" class="cards"></div>
          </div>
        </div>
      </div>
    </section>
    <section id="pane-matrix" class="pane board-pane" data-tab="matrix" hidden>
      <div class="matrix-scroll">
        <table class="matrix">
          <thead>
            <tr><th>Requirement</th><th>${testColumn}</th><th>Scenario</th><th>Tag in file</th><th>Last result</th></tr>
          </thead>
          <tbody id="matrix-rows"></tbody>
        </table>
      </div>
    </section>
    <section id="pane-executions" class="pane board-pane" data-tab="executions" hidden>
      <div class="verbs">
        <button id="create-execution" class="verb" type="button" disabled>Create Execution</button>
      </div>
      <div id="executions-empty" class="empty" hidden>Execution activity from this workspace appears here.</div>
      <div id="executions-scroll" class="matrix-scroll">
        <table class="matrix">
          <thead>
            <tr><th>Execution</th><th>Summary</th><th>Action</th><th>Imported</th><th>Pass rate</th><th>Date</th><th>Activity</th></tr>
          </thead>
          <tbody id="executions-rows"></tbody>
        </table>
      </div>
    </section>`;
}

const BOARD_SCRIPT = `
  const search = document.getElementById('search');
  const scopeSelect = document.getElementById('scope-select');
  const scenarioCards = document.getElementById('scenario-cards');
  const createTests = document.getElementById('create-tests');
  const createTestSet = document.getElementById('create-test-set');
  const createTestPlan = document.getElementById('create-test-plan');
  const createExecution = document.getElementById('create-execution');
  const availableCards = document.getElementById('available-cards');
  const mappedCards = document.getElementById('mapped-cards');
  const scenarioCount = document.getElementById('scenario-count');
  const availableCount = document.getElementById('available-count');
  const mappedCount = document.getElementById('mapped-count');
  const matrixRows = document.getElementById('matrix-rows');
  const executionsRows = document.getElementById('executions-rows');
  const executionsEmpty = document.getElementById('executions-empty');
  const executionsScroll = document.getElementById('executions-scroll');
  const syncStrip = document.getElementById('sync-strip');
  const syncStripText = document.getElementById('sync-strip-text');

  // What the board looks like rather than what it holds: which matrix files are unfolded, which
  // execution histories are folded, and how far the executions window has been pulled down. All ride
  // the webview's own state, so a window reload gets the board back the way it was left, and none reaches
  // the host.
  // State outlives the script that wrote it, so a key left by another version is read as data, never
  // trusted: a throw on this line would take the fragment's message handler with it, and the bad value
  // persists, so the pane would come back blank on every reload.
  const boardState = window.__spec.state();
  const matrixOpen = new Set(Array.isArray(boardState.matrixOpen) ? boardState.matrixOpen : []);
  const executionsCollapsed = new Set(
    Array.isArray(boardState.executionsCollapsed) ? boardState.executionsCollapsed : []
  );
  const EXECUTIONS_PAGE = 50;
  let executionsShown = Number(boardState.executionsShown) || EXECUTIONS_PAGE;
  let executionItems = [];
  let olderRow = null;

  // A scenario card carries kind 'scenario' + its drop id; a test card kind 'test' + its key. A drop is
  // valid only across the two kinds, so a scenario lands on any test card and an available test on a
  // scenario, never like on like. The drop normalizes both directions to {scenario, key}.
  let dragged = null;
  function clearDropTargets() {
    const marked = document.querySelectorAll('.drop-target');
    for (const el of Array.prototype.slice.call(marked)) { el.classList.remove('drop-target'); }
  }
  function isLinkDrag(kind) {
    return dragged && dragged.kind !== kind;
  }
  function wireCardDrag(el, kind, id, draggable) {
    if (draggable) {
      el.draggable = true;
      el.addEventListener('dragstart', function (e) {
        dragged = { kind: kind, id: id };
        if (e.dataTransfer) { e.dataTransfer.effectAllowed = 'link'; }
      });
      el.addEventListener('dragend', function () { dragged = null; clearDropTargets(); });
    }
    el.addEventListener('dragover', function (e) {
      if (isLinkDrag(kind)) {
        e.preventDefault();
        if (e.dataTransfer) { e.dataTransfer.dropEffect = 'link'; }
        el.classList.add('drop-target');
      }
    });
    el.addEventListener('dragleave', function () { el.classList.remove('drop-target'); });
    el.addEventListener('drop', function (e) {
      if (!isLinkDrag(kind)) { return; }
      e.preventDefault();
      el.classList.remove('drop-target');
      const scenario = dragged.kind === 'scenario' ? dragged.id : id;
      const key = dragged.kind === 'scenario' ? id : dragged.id;
      window.__spec.post('board', { type: 'drop', scenario: scenario, key: key });
      dragged = null;
    });
  }

  function pillEl(text) {
    const el = document.createElement('span');
    el.className = 'pill';
    el.textContent = text;
    return el;
  }

  function pillsEl(pills) {
    const wrap = document.createElement('div');
    wrap.className = 'pills';
    for (const pill of pills) { wrap.appendChild(pillEl(pill)); }
    return wrap;
  }

  // A card's secondary line: one line, ellipsized when it does not fit, with the whole text on hover so
  // a truncated path is still readable.
  function metaEl(text) {
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
  function renderScope(projects, project) {
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

  // A column or group's empty line. Under a query the group is empty because of the filter, not because
  // there is nothing there, so say that instead of its own empty text.
  function emptyEl(text) {
    const el = document.createElement('div');
    el.className = 'empty';
    el.textContent = filtering ? 'No matches.' : text;
    return el;
  }

  // A create verb, painted from the host's decision: label, enabled, and the tooltip that says what a
  // disabled button is waiting for.
  function renderVerb(button, verb, fallback) {
    button.textContent = verb.label || fallback;
    button.disabled = verb.enabled !== true;
    button.title = verb.hint || '';
  }

  // A card's checkbox. The host owns both selections, so this posts the box's new state under its
  // target and paints whatever comes back on the next render.
  function selectBox(target, id, label, checked) {
    const check = document.createElement('input');
    check.type = 'checkbox';
    check.checked = checked === true;
    check.setAttribute('aria-label', label);
    check.addEventListener('change', function () {
      window.__spec.post('board', { type: 'select', target: target, id: id, on: check.checked });
    });
    return check;
  }

  function renderScenarios(cards) {
    scenarioCards.textContent = '';
    scenarioCount.textContent = '(' + cards.length + ')';
    if (cards.length === 0) {
      scenarioCards.appendChild(emptyEl('No untraced scenarios.'));
      return;
    }
    for (const card of cards) {
      const el = document.createElement('div');
      el.className = 'card';
      const head = document.createElement('div');
      head.className = 'pick';
      head.appendChild(selectBox('scenario', card.dropId, 'Select scenario ' + card.name, card.selected));
      const title = document.createElement('div');
      title.className = 'title';
      title.textContent = card.name;
      head.appendChild(title);
      el.appendChild(head);
      el.appendChild(metaEl(card.location));
      if (card.pills.length > 0) { el.appendChild(pillsEl(card.pills)); }
      wireCardDrag(el, 'scenario', card.dropId, true);
      scenarioCards.appendChild(el);
    }
  }

  // One of a link row's two buttons. The host owns every decision behind them; this only posts the
  // row's {scenario, key} under the given message type.
  function rowAction(label, title, type, link, key) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'pill-button';
    btn.textContent = label;
    btn.title = title;
    btn.setAttribute('aria-label', label + ' scenario ' + link.name);
    btn.addEventListener('click', function () {
      window.__spec.post('board', { type: type, scenario: link.unlinkId, key: key });
    });
    return btn;
  }

  // A linked scenario on a mapped test card: its name, its location, and the two buttons that act on
  // just this link. The unlink id is the scenario's drop id, the host's only handle back to the tag. The
  // buttons share one nowrap group, so a long name pushes them onto their own line rather than being
  // squeezed to a couple of characters.
  function linkRow(link, key) {
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

  // The empty available group's way into the sync the palette also runs, so nobody has to leave the
  // board to load tests. The host owns the run; the disabled state lasts until the next repaint, which
  // rebuilds the group either way.
  function syncButton() {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'pill-button sync-now';
    btn.textContent = 'Sync now';
    btn.addEventListener('click', function () {
      btn.disabled = true;
      btn.textContent = 'Syncing';
      window.__spec.post('board', { type: 'sync' });
    });
    return btn;
  }

  // One group of the right column. Only the available group's cards drag onto a scenario; every card,
  // available or mapped, still accepts a dropped scenario, since a test can carry several.
  function renderTestGroup(container, count, cards, draggable, empty) {
    container.textContent = '';
    count.textContent = '(' + cards.length + ')';
    if (cards.length === 0) {
      container.appendChild(empty);
      return;
    }
    for (const card of cards) {
      const el = document.createElement('div');
      el.className = 'card';
      const head = document.createElement('div');
      head.className = 'pick';
      head.appendChild(selectBox('test', card.key, 'Select test ' + card.key, card.selected));
      const title = document.createElement('div');
      title.className = 'title key';
      title.textContent = card.key;
      head.appendChild(title);
      el.appendChild(head);
      if (card.summary) { el.appendChild(metaEl(card.summary)); }
      if (card.pills.length > 0) { el.appendChild(pillsEl(card.pills)); }
      for (const link of card.links) { el.appendChild(linkRow(link, card.key)); }
      wireCardDrag(el, 'test', card.key, draggable);
      container.appendChild(el);
    }
  }

  function renderTests(available, mapped, availableEmptyText, offerSync) {
    const availableEmpty = emptyEl(availableEmptyText);
    if (offerSync && !filtering) { availableEmpty.appendChild(syncButton()); }
    renderTestGroup(availableCards, availableCount, available, true, availableEmpty);
    renderTestGroup(mappedCards, mappedCount, mapped, false, emptyEl('No mapped tests yet.'));
  }

  // Cells are nowrap by default so keys, dates and counts stay on one line; only the prose columns ask
  // for 'wrap' and give the table somewhere to lose width when the board is narrow.
  function matrixCell(text, cls) {
    const td = document.createElement('td');
    if (text === '') { td.className = 'hole'; return td; }
    td.textContent = text;
    if (cls) { td.className = cls; }
    return td;
  }

  function matrixRowEl(row) {
    const tr = document.createElement('tr');
    tr.appendChild(matrixCell(row.requirement, 'wrap'));
    tr.appendChild(matrixCell(row.test, 'key'));
    tr.appendChild(matrixCell(row.scenario, 'wrap'));
    tr.appendChild(matrixCell(row.tag, 'key'));
    tr.appendChild(matrixCell(row.result, ''));
    return tr;
  }

  // One feature file's fold. A collapsed group holds no row elements at all, which is the point of the
  // fold: a workspace of thousands of rows never builds the ones nobody is looking at. Toggling touches
  // only this group's rows, so no repaint and no host round-trip.
  function renderMatrixGroup(group) {
    const head = document.createElement('tr');
    const cell = document.createElement('td');
    cell.colSpan = 5;
    cell.className = 'group-cell';
    const toggle = document.createElement('button');
    toggle.type = 'button';
    toggle.className = 'group-toggle';
    const twisty = document.createElement('span');
    twisty.setAttribute('aria-hidden', 'true');
    const name = document.createElement('span');
    name.textContent = group.file || 'Available tests';
    const count = document.createElement('span');
    count.className = 'count';
    count.textContent = '(' + group.count + ')';
    toggle.appendChild(twisty);
    toggle.appendChild(name);
    toggle.appendChild(count);
    cell.appendChild(toggle);
    head.appendChild(cell);
    matrixRows.appendChild(head);

    let open = filtering || matrixOpen.has(group.file);
    let rows = [];
    function paint() {
      twisty.textContent = open ? '▾' : '▸';
      toggle.setAttribute('aria-expanded', open ? 'true' : 'false');
      if (!open) {
        for (const el of rows) { el.remove(); }
        rows = [];
        return;
      }
      rows = group.rows.map(matrixRowEl);
      const frag = document.createDocumentFragment();
      for (const el of rows) { frag.appendChild(el); }
      matrixRows.insertBefore(frag, head.nextSibling);
    }
    // A query opens the groups it matched, and a toggle under one is display only, neither touching the
    // persisted set, so clearing the box folds the board back the way the user left it.
    toggle.addEventListener('click', function () {
      open = !open;
      if (!filtering) {
        if (open) { matrixOpen.add(group.file); } else { matrixOpen.delete(group.file); }
        window.__spec.saveState({ matrixOpen: Array.from(matrixOpen) });
      }
      paint();
    });
    paint();
  }

  function renderMatrix(groups) {
    matrixRows.textContent = '';
    if (groups.length === 0) {
      const tr = document.createElement('tr');
      const td = document.createElement('td');
      td.colSpan = 5;
      td.className = 'empty';
      td.textContent = 'Nothing to trace yet.';
      tr.appendChild(td);
      matrixRows.appendChild(tr);
      return;
    }
    for (const group of groups) { renderMatrixGroup(group); }
  }

  function executionCell(text, cls) {
    const td = document.createElement('td');
    td.textContent = text;
    if (cls) { td.className = cls; }
    return td;
  }

  // The host decides what this cell says; the only call left here is whether there is a reference to open.
  function executionKeyCell(row, toggle) {
    const cell = document.createElement('th');
    cell.scope = 'row';
    if (toggle) { cell.appendChild(toggle); }
    if (!row.key) {
      cell.appendChild(document.createTextNode(row.keyLabel));
      return cell;
    }
    const link = document.createElement('a');
    link.className = 'link';
    link.href = '#';
    link.textContent = row.keyLabel;
    link.addEventListener('click', function (e) {
      e.preventDefault();
      window.__spec.post('board', { type: 'open', key: row.key });
    });
    cell.appendChild(link);
    return cell;
  }

  function activityCountText(count) {
    return String(count) + (count === 1 ? ' entry' : ' entries');
  }

  function executionActivityRowEl(activity) {
    const tr = document.createElement('tr');
    tr.className = 'execution-child';
    const branch = executionCell('');
    const arrow = document.createElement('span');
    arrow.textContent = '↳';
    arrow.setAttribute('aria-hidden', 'true');
    branch.appendChild(arrow);
    tr.appendChild(branch);
    tr.appendChild(executionCell(''));
    tr.appendChild(executionCell(activity.action));
    tr.appendChild(executionCell(activity.resultsImported));
    tr.appendChild(executionCell(activity.passRate));
    tr.appendChild(executionCell(activity.publishedAt));
    tr.appendChild(executionCell(''));
    return tr;
  }

  function unknownExecutionRowEl(row) {
    const tr = document.createElement('tr');
    tr.appendChild(executionKeyCell(row));
    tr.appendChild(executionCell(row.summary, 'wrap'));
    tr.appendChild(executionCell(row.action));
    tr.appendChild(executionCell(row.resultsImported));
    tr.appendChild(executionCell(row.passRate));
    tr.appendChild(executionCell(row.publishedAt));
    tr.appendChild(executionCell(activityCountText(row.activityCount)));
    return tr;
  }

  function renderExecutionGroup(group) {
    const head = document.createElement('tr');
    head.className = 'execution-parent';
    const toggle = document.createElement('button');
    toggle.type = 'button';
    toggle.className = 'execution-toggle';
    head.appendChild(executionKeyCell(group, toggle));
    head.appendChild(executionCell(group.summary, 'wrap'));
    head.appendChild(executionCell(''));
    head.appendChild(executionCell(''));
    head.appendChild(executionCell(''));
    head.appendChild(executionCell(group.latestPublishedAt));
    head.appendChild(executionCell(activityCountText(group.activityCount)));
    executionsRows.appendChild(head);

    let rows = [];
    let open = filtering || !executionsCollapsed.has(group.key);
    function paint() {
      toggle.textContent = open ? '▾' : '▸';
      toggle.setAttribute('aria-expanded', open ? 'true' : 'false');
      toggle.setAttribute(
        'aria-label',
        (open ? 'Hide activity for ' : 'Show activity for ') + group.keyLabel
      );
      for (const row of rows) { row.remove(); }
      rows = [];
      if (!open) { return; }
      rows = group.activities.map(executionActivityRowEl);
      const frag = document.createDocumentFragment();
      for (const row of rows) { frag.appendChild(row); }
      executionsRows.insertBefore(frag, head.nextSibling);
    }
    // A query opens the groups it matched. Folding one while filtering is temporary, so clearing the
    // query restores the user's saved view.
    toggle.addEventListener('click', function () {
      open = !open;
      if (!filtering) {
        if (open) { executionsCollapsed.delete(group.key); } else { executionsCollapsed.add(group.key); }
        window.__spec.saveState({ executionsCollapsed: Array.from(executionsCollapsed) });
      }
      paint();
    });
    paint();
  }

  function renderExecutionItem(item) {
    if (item.kind === 'group') {
      renderExecutionGroup(item);
    } else {
      executionsRows.appendChild(unknownExecutionRowEl(item));
    }
  }

  function olderRowEl(remaining) {
    const tr = document.createElement('tr');
    const td = document.createElement('td');
    td.colSpan = 7;
    td.className = 'older-cell';
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'pill-button';
    btn.textContent = 'Show older (' + remaining + ' more)';
    btn.addEventListener('click', function () {
      const from = Math.min(executionsShown, executionItems.length);
      executionsShown = from + EXECUTIONS_PAGE;
      window.__spec.saveState({ executionsShown: executionsShown });
      paintExecutions(from);
    });
    td.appendChild(btn);
    tr.appendChild(td);
    return tr;
  }

  // Paint whole top-level items from the given index up to the revealed count, then re-hang the control
  // that reveals the next page. A group and its children are never split across pages.
  function paintExecutions(from) {
    if (olderRow) { olderRow.remove(); olderRow = null; }
    const shown = Math.min(executionsShown, executionItems.length);
    for (let i = from; i < shown; i++) { renderExecutionItem(executionItems[i]); }
    if (shown < executionItems.length) {
      olderRow = olderRowEl(executionItems.length - shown);
      executionsRows.appendChild(olderRow);
    }
  }

  function renderExecutions(rows) {
    executionsRows.textContent = '';
    olderRow = null;
    executionItems = rows;
    const empty = rows.length === 0;
    executionsEmpty.textContent = filtering
      ? 'No executions match this filter.'
      : 'Execution activity from this workspace appears here.';
    executionsEmpty.hidden = !empty;
    executionsScroll.hidden = empty;
    if (empty) { return; }
    paintExecutions(0);
  }

  // The strip sits above the panes, so a sync reads the same on every tab. The host owns its words: an
  // empty text clears it, and so does every render, so a finished or failed sync cannot strand it.
  function renderSyncProgress(text) {
    syncStripText.textContent = text;
    syncStrip.hidden = text === '';
  }

  search.addEventListener('input', function () { window.__spec.post('board', { type: 'search', value: search.value }); });
  scopeSelect.addEventListener('change', function () { window.__spec.post('board', { type: 'scope', project: scopeSelect.value }); });
  createTests.addEventListener('click', function () { window.__spec.post('board', { type: 'bulkCreate' }); });
  createTestSet.addEventListener('click', function () { window.__spec.post('board', { type: 'createTestSet' }); });
  createTestPlan.addEventListener('click', function () { window.__spec.post('board', { type: 'createTestPlan' }); });
  createExecution.addEventListener('click', function () { window.__spec.post('board', { type: 'createTestExecution' }); });

  window.__spec.register('board', function (msg) {
    if (msg.type === 'render') {
      filtering = msg.filtering === true;
      renderScope(msg.projects || [], msg.project || '');
      renderVerb(createTests, msg.createVerb || {}, 'Create tests');
      renderVerb(createTestSet, msg.testSetVerb || {}, 'Create Test Set');
      renderVerb(createTestPlan, msg.testPlanVerb || {}, 'Create Test Plan');
      renderVerb(createExecution, msg.executionVerb || {}, 'Create Execution');
      renderScenarios(msg.scenarios || []);
      renderTests(msg.available || [], msg.mapped || [], msg.availableEmptyText || '', msg.offerSync === true);
      renderMatrix(msg.matrix || []);
      renderExecutions(msg.executions || []);
      renderSyncProgress('');
    } else if (msg.type === 'syncProgress') {
      renderSyncProgress(msg.text || '');
    }
  });`;

export function boardFragment(providerLabel: string): SurfaceFragment {
  return { css: BOARD_CSS, paneHtml: boardPanesHtml(providerLabel), script: BOARD_SCRIPT };
}
