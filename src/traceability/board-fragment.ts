import { escapeHtml } from "../utils/webview";
import { SurfaceFragment } from "./webview-host";

const BOARD_CSS = `
  .board-pane .mapping-hint { margin: 0 0 1rem; padding: 0.5rem 0.7rem; border: 1px solid var(--vscode-widget-border, var(--vscode-panel-border, transparent)); border-radius: 5px; background: var(--vscode-editorWidget-background, var(--vscode-editor-background)); color: var(--vscode-descriptionForeground); font-size: 0.85em; line-height: 1.4; }
  .board-pane .columns { display: grid; grid-template-columns: 1fr auto 1fr; gap: 1rem; align-items: start; }
  .board-pane .column h2 { font-size: 0.8rem; text-transform: uppercase; letter-spacing: 0.04em; color: var(--vscode-descriptionForeground); font-weight: 600; margin: 0 0 0.6rem; }
  .board-pane .count { color: var(--vscode-descriptionForeground); font-weight: 400; }
  .board-pane .cards { display: flex; flex-direction: column; gap: 0.5rem; }
  .board-pane .card {
    border: 1px solid var(--vscode-widget-border, var(--vscode-panel-border, transparent));
    border-radius: 5px;
    padding: 0.55rem 0.65rem;
    background: var(--vscode-editorWidget-background, var(--vscode-editor-background));
  }
  .board-pane .card .title { font-weight: 600; word-break: break-word; }
  .board-pane .card .pick { display: flex; align-items: flex-start; gap: 0.45rem; }
  .board-pane .card .pick input { margin: 0.15rem 0 0; }
  .board-pane .create-tests { display: block; margin: 0 0 0.6rem; padding: 0.25rem 0.7rem; font-family: inherit; font-size: 0.78rem; border: none; border-radius: 3px; background: var(--vscode-button-background); color: var(--vscode-button-foreground); cursor: pointer; }
  .board-pane .create-tests:hover:enabled { background: var(--vscode-button-hoverBackground); }
  .board-pane .create-tests:disabled { opacity: 0.55; cursor: default; }
  .board-pane .card .key { font-family: var(--vscode-editor-font-family, monospace); color: var(--vscode-textLink-foreground); }
  .board-pane .card .meta { color: var(--vscode-descriptionForeground); font-size: 0.85em; margin-top: 0.2rem; word-break: break-all; }
  .board-pane .pills { display: flex; flex-wrap: wrap; gap: 0.3rem; margin-top: 0.4rem; }
  .board-pane .pill { font-size: 0.72rem; padding: 0.08rem 0.4rem; border-radius: 999px; background: var(--vscode-badge-background); color: var(--vscode-badge-foreground); }
  .board-pane .group + .group { margin-top: 1.2rem; }
  .board-pane .gutter { display: flex; align-items: center; justify-content: center; align-self: stretch; min-width: 5.5rem; }
  .board-pane .gutter span { color: var(--vscode-descriptionForeground); font-style: italic; font-size: 0.85em; text-align: center; }
  .board-pane .empty { color: var(--vscode-descriptionForeground); font-style: italic; padding: 0.4rem 0; }
  .board-pane .empty .sync-now { display: block; margin-top: 0.4rem; font-family: inherit; font-size: 0.72rem; padding: 0.05rem 0.45rem; border: none; border-radius: 999px; background: var(--vscode-button-secondaryBackground, transparent); color: var(--vscode-button-secondaryForeground, var(--vscode-foreground)); cursor: pointer; }
  .board-pane .empty .sync-now:hover { background: var(--vscode-button-secondaryHoverBackground, var(--vscode-button-hoverBackground)); }
  .board-pane .empty .sync-now:disabled { cursor: default; background: var(--vscode-button-secondaryBackground, transparent); }
  .board-pane .card[draggable="true"] { cursor: grab; }
  .board-pane .card.drop-target { outline: 2px dashed var(--vscode-focusBorder); outline-offset: -2px; }
  .board-pane .link-row { display: flex; align-items: flex-start; gap: 0.5rem; padding-top: 0.4rem; margin-top: 0.45rem; border-top: 1px solid var(--vscode-widget-border, var(--vscode-panel-border, transparent)); }
  .board-pane .link-row .name { flex: 1; min-width: 0; word-break: break-word; }
  .board-pane .link-row .row-action { font-family: inherit; font-size: 0.72rem; padding: 0.05rem 0.45rem; border: none; border-radius: 999px; background: var(--vscode-button-secondaryBackground, transparent); color: var(--vscode-button-secondaryForeground, var(--vscode-foreground)); cursor: pointer; }
  .board-pane .link-row .row-action:hover { background: var(--vscode-button-secondaryHoverBackground, var(--vscode-button-hoverBackground)); }
  .board-pane .matrix-scroll { overflow: auto; max-height: calc(100vh - 9rem); border: 1px solid var(--vscode-widget-border, var(--vscode-panel-border, transparent)); border-radius: 5px; }
  .board-pane table.matrix { border-collapse: collapse; width: 100%; font-size: 0.9em; }
  .board-pane table.matrix th, .board-pane table.matrix td { text-align: left; padding: 0.4rem 0.6rem; white-space: nowrap; border-bottom: 1px solid var(--vscode-widget-border, var(--vscode-panel-border, transparent)); }
  .board-pane table.matrix thead th { position: sticky; top: 0; z-index: 1; background: var(--vscode-editorWidget-background, var(--vscode-editor-background)); font-weight: 600; }
  .board-pane table.matrix td.hole { background: var(--vscode-inputValidation-warningBackground, transparent); }
  .board-pane table.matrix .key { font-family: var(--vscode-editor-font-family, monospace); color: var(--vscode-textLink-foreground); }
  .board-pane table.matrix a.link { font-family: var(--vscode-editor-font-family, monospace); color: var(--vscode-textLink-foreground); cursor: pointer; text-decoration: none; }
  .board-pane table.matrix a.link:hover { text-decoration: underline; }`;

function boardPanesHtml(providerLabel: string): string {
  const availableHeading = escapeHtml(`Available ${providerLabel} tests`);
  const mappedHeading = escapeHtml(`Mapped ${providerLabel} tests`);
  const testColumn = escapeHtml(`${providerLabel} test`);
  return `    <section id="pane-mapping" class="pane board-pane" data-tab="mapping" hidden>
      <p class="mapping-hint">Drag a scenario from the left onto a test on the right to link them. An available test can also be dragged onto a scenario.</p>
      <div class="columns">
        <div class="column">
          <h2>Untraced scenarios <span id="scenario-count" class="count"></span></h2>
          <button id="create-tests" class="create-tests" type="button" disabled>Create tests</button>
          <div id="scenario-cards" class="cards"></div>
        </div>
        <div class="gutter"><span>drag to link</span></div>
        <div class="column">
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
      <div id="executions-empty" class="empty" hidden>Publishes from this workspace appear here.</div>
      <div id="executions-scroll" class="matrix-scroll">
        <table class="matrix">
          <thead>
            <tr><th>Execution</th><th>Summary</th><th>Action</th><th>Imported</th><th>Pass rate</th><th>Published</th><th>From here</th></tr>
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
  const availableCards = document.getElementById('available-cards');
  const mappedCards = document.getElementById('mapped-cards');
  const scenarioCount = document.getElementById('scenario-count');
  const availableCount = document.getElementById('available-count');
  const mappedCount = document.getElementById('mapped-count');
  const matrixRows = document.getElementById('matrix-rows');
  const executionsRows = document.getElementById('executions-rows');
  const executionsEmpty = document.getElementById('executions-empty');
  const executionsScroll = document.getElementById('executions-scroll');

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

  // The Create tests verb, painted from the host's decision: label, enabled, and the tooltip that says
  // what a disabled button is waiting for.
  function renderCreateVerb(verb) {
    createTests.textContent = verb.label || 'Create tests';
    createTests.disabled = verb.enabled !== true;
    createTests.title = verb.hint || '';
  }

  // The bulk-create checkbox. The host owns the selection, so this posts the box's new state and paints
  // whatever comes back on the next render.
  function selectBox(card) {
    const check = document.createElement('input');
    check.type = 'checkbox';
    check.checked = card.selected === true;
    check.setAttribute('aria-label', 'Select scenario ' + card.name);
    check.addEventListener('change', function () {
      window.__spec.post('board', { type: 'select', id: card.dropId, on: check.checked });
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
      head.appendChild(selectBox(card));
      const title = document.createElement('div');
      title.className = 'title';
      title.textContent = card.name;
      head.appendChild(title);
      el.appendChild(head);
      const meta = document.createElement('div');
      meta.className = 'meta';
      meta.textContent = card.location;
      el.appendChild(meta);
      el.appendChild(pillsEl(card.pills));
      wireCardDrag(el, 'scenario', card.dropId, true);
      scenarioCards.appendChild(el);
    }
  }

  // One of a link row's two buttons. The host owns every decision behind them; this only posts the
  // row's {scenario, key} under the given message type.
  function rowAction(label, title, type, link, key) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'row-action';
    btn.textContent = label;
    btn.title = title;
    btn.setAttribute('aria-label', label + ' scenario ' + link.name);
    btn.addEventListener('click', function () {
      window.__spec.post('board', { type: type, scenario: link.unlinkId, key: key });
    });
    return btn;
  }

  // A linked scenario on a mapped test card: its name, its location, and the two buttons that act on
  // just this link. The unlink id is the scenario's drop id, the host's only handle back to the tag.
  function linkRow(link, key) {
    const row = document.createElement('div');
    row.className = 'link-row';
    const name = document.createElement('div');
    name.className = 'name';
    name.textContent = link.name;
    const loc = document.createElement('div');
    loc.className = 'meta';
    loc.textContent = link.location;
    name.appendChild(loc);
    row.appendChild(name);
    row.appendChild(rowAction('Push', 'Sends the local text of this scenario to the test.', 'pushText', link, key));
    row.appendChild(rowAction('Unlink', 'Removes only this test link.', 'unlink', link, key));
    return row;
  }

  // The empty available group's way into the sync the palette also runs, so nobody has to leave the
  // board to load tests. The host owns the run; the disabled state lasts until the next repaint, which
  // rebuilds the group either way.
  function syncButton() {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'sync-now';
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
      const title = document.createElement('div');
      title.className = 'title key';
      title.textContent = card.key;
      el.appendChild(title);
      if (card.summary) {
        const meta = document.createElement('div');
        meta.className = 'meta';
        meta.textContent = card.summary;
        el.appendChild(meta);
      }
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

  function matrixCell(text, isKey) {
    const td = document.createElement('td');
    if (text === '') { td.className = 'hole'; }
    else {
      td.textContent = text;
      if (isKey) { td.className = 'key'; }
    }
    return td;
  }

  function renderMatrix(rows) {
    matrixRows.textContent = '';
    if (rows.length === 0) {
      const tr = document.createElement('tr');
      const td = document.createElement('td');
      td.colSpan = 5;
      td.className = 'empty';
      td.textContent = 'Nothing to trace yet.';
      tr.appendChild(td);
      matrixRows.appendChild(tr);
      return;
    }
    for (const row of rows) {
      const tr = document.createElement('tr');
      tr.appendChild(matrixCell(row.requirement, false));
      tr.appendChild(matrixCell(row.test, true));
      tr.appendChild(matrixCell(row.scenario, false));
      tr.appendChild(matrixCell(row.tag, true));
      tr.appendChild(matrixCell(row.result, false));
      matrixRows.appendChild(tr);
    }
  }

  function executionCell(text) {
    const td = document.createElement('td');
    td.textContent = text;
    return td;
  }

  function renderExecutions(rows) {
    executionsRows.textContent = '';
    const empty = rows.length === 0;
    executionsEmpty.hidden = !empty;
    executionsScroll.hidden = empty;
    if (empty) { return; }
    for (const row of rows) {
      const tr = document.createElement('tr');
      const keyTd = document.createElement('td');
      const link = document.createElement('a');
      link.className = 'link';
      link.href = '#';
      link.textContent = row.key;
      link.addEventListener('click', function (e) {
        e.preventDefault();
        window.__spec.post('board', { type: 'open', key: row.key });
      });
      keyTd.appendChild(link);
      tr.appendChild(keyTd);
      tr.appendChild(executionCell(row.summary));
      tr.appendChild(executionCell(row.action));
      tr.appendChild(executionCell(row.resultsImported));
      tr.appendChild(executionCell(row.passRate));
      tr.appendChild(executionCell(row.publishedAt));
      tr.appendChild(executionCell(String(row.timesFromHere)));
      executionsRows.appendChild(tr);
    }
  }

  search.addEventListener('input', function () { window.__spec.post('board', { type: 'search', value: search.value }); });
  scopeSelect.addEventListener('change', function () { window.__spec.post('board', { type: 'scope', project: scopeSelect.value }); });
  createTests.addEventListener('click', function () { window.__spec.post('board', { type: 'bulkCreate' }); });

  window.__spec.register('board', function (msg) {
    if (msg.type === 'render') {
      filtering = msg.filtering === true;
      renderScope(msg.projects || [], msg.project || '');
      renderCreateVerb(msg.createVerb || {});
      renderScenarios(msg.scenarios || []);
      renderTests(msg.available || [], msg.mapped || [], msg.availableEmptyText || '', msg.offerSync === true);
      renderMatrix(msg.matrix || []);
      renderExecutions(msg.executions || []);
    }
  });`;

export function boardFragment(providerLabel: string): SurfaceFragment {
  return { css: BOARD_CSS, paneHtml: boardPanesHtml(providerLabel), script: BOARD_SCRIPT };
}
