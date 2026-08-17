import type { LinkedRow, LinkHostMessage, LinkPickerRow } from "../protocol";

// Existing DOM renderer moved intact from the host template. Protocol traffic is typed and validated
// by router.ts before this surface receives it.
export function installLink(): void {
  const element = <T extends HTMLElement>(id: string): T => {
    const found = document.getElementById(id);
    if (!found) {throw new Error(`Missing link element: ${id}`);}
    return found as T;
  };
  const linkPane = element<HTMLElement>('pane-link');
  const title = element<HTMLElement>('link-title');
  const search = element<HTMLInputElement>('link-search');
  const results = element<HTMLElement>('link-results');
  const linkedSection = element<HTMLElement>('link-linked-section');
  const linkedList = element<HTMLElement>('link-linked');
  const busy = element<HTMLElement>('link-busy');
  let rows: readonly LinkPickerRow[] = [];
  let linkedRows: readonly LinkedRow[] = [];
  let highlightedId: string | null = null;
  let highlightedIndex = -1;

  // The "Linked" section sits outside the navigable results list, so its rows are inherently skipped
  // by combobox arrow keys and Enter; their own keyboard buttons keep native activation.
  function renderLinked(): void {
    linkedSection.hidden = linkedRows.length === 0;
    linkedList.textContent = '';
    linkedRows.forEach((row) => {
      const li = document.createElement('li');
      li.className = 'linked-row';
      const key = document.createElement('span');
      key.className = 'key';
      key.textContent = row.key;
      li.appendChild(key);
      if (row.remoteMissing) {
        const warn = document.createElement('span');
        warn.className = 'warn';
        warn.textContent = '⚠ not found on remote';
        li.appendChild(warn);
      } else if (row.summary) {
        const summary = document.createElement('span');
        summary.className = 'summary';
        summary.textContent = row.summary;
        li.appendChild(summary);
      }
      const actions = document.createElement('span');
      actions.className = 'actions';
      const open = document.createElement('button');
      open.type = 'button';
      open.textContent = 'Open in Jira';
      open.addEventListener('click', () => { window.__spec.post('link', { type: 'openLinked', key: row.key }); });
      const unlink = document.createElement('button');
      unlink.type = 'button';
      unlink.textContent = 'Unlink';
      unlink.addEventListener('click', () => { window.__spec.post('link', { type: 'unlink', key: row.key }); });
      actions.appendChild(open);
      actions.appendChild(unlink);
      li.appendChild(actions);
      linkedList.appendChild(li);
    });
  }

  function navigable(): number[] {
    const out: number[] = [];
    rows.forEach((row, index) => { if (row.kind !== 'hint') { out.push(index); } });
    return out;
  }

  // Preserve the highlight on the same row id across re-renders (so a debounced remote append doesn't
  // yank it to the top); if that row is gone, clamp to the navigable row nearest the old position.
  function resolveHighlight(): void {
    const nav = navigable();
    if (nav.length === 0) { highlightedId = null; highlightedIndex = -1; return; }
    const first = nav[0];
    if (first === undefined) {return;}
    let index = rows.findIndex((row) => { return row.id === highlightedId; });
    if (index < 0 || rows[index]?.kind === 'hint') {
      const target = highlightedIndex < 0 ? first : highlightedIndex;
      index = nav.reduce((best, candidate) => {
        return Math.abs(candidate - target) < Math.abs(best - target) ? candidate : best;
      }, first);
    }
    highlightedIndex = index;
    highlightedId = rows[index]?.id ?? null;
  }

  function render(): void {
    resolveHighlight();
    results.textContent = '';
    rows.forEach((row, index) => {
      const li = document.createElement('li');
      const hint = row.kind === 'hint';
      li.id = `link-option-${  index}`;
      li.setAttribute('role', 'option');
      li.setAttribute('aria-selected', String(!hint && index === highlightedIndex));
      li.className = `row${
         row.kind === 'create' ? ' create' : ''
         }${hint ? ' hint-row' : ''
         }${index === highlightedIndex ? ' active' : ''}`;
      if (hint) {
        const note = document.createElement('span');
        note.textContent = row.key;
        li.appendChild(note);
      } else if (row.kind === 'create') {
        const label = document.createElement('span');
        label.className = 'create-label';
        label.textContent = row.key;
        li.appendChild(label);
      } else {
        const key = document.createElement('span');
        key.className = 'key';
        key.textContent = row.key;
        li.appendChild(key);
        if (row.summary) {
          const summary = document.createElement('span');
          summary.className = 'summary';
          summary.textContent = row.summary;
          li.appendChild(summary);
        }
      }
      if (!hint) {
        li.addEventListener('click', () => { confirmRow(index); });
        li.addEventListener('mousemove', () => {
          if (highlightedId !== row.id) { highlightedId = row.id; highlightedIndex = index; render(); }
        });
      }
      results.appendChild(li);
    });
    search.setAttribute('aria-expanded', String(navigable().length > 0));
    if (highlightedIndex >= 0) {search.setAttribute('aria-activedescendant', `link-option-${  highlightedIndex}`);}
    else {search.removeAttribute('aria-activedescendant');}
  }

  function confirmRow(index: number): void {
    const row = rows[index];
    if (row && row.kind !== 'hint') { window.__spec.post('link', { type: 'confirm', id: row.id }); }
  }

  function move(delta: number): void {
    const nav = navigable();
    if (nav.length === 0) { return; }
    let pos = nav.indexOf(highlightedIndex);
    if (pos < 0) { pos = 0; }
    pos = (pos + delta + nav.length) % nav.length;
    const next = nav[pos];
    if (next === undefined) {return;}
    highlightedIndex = next;
    highlightedId = rows[highlightedIndex]?.id ?? null;
    render();
    const active = results.children[highlightedIndex];
    if (active) { active.scrollIntoView({ block: 'nearest' }); }
  }

  search.addEventListener('input', () => {
    window.__spec.post('link', { type: 'search', value: search.value });
  });

  search.addEventListener('keydown', (event) => {
    if (linkPane.hidden) { return; }
    if (event.key === 'ArrowDown') { event.preventDefault(); move(1); }
    else if (event.key === 'ArrowUp') { event.preventDefault(); move(-1); }
    else if (event.key === 'Enter') { event.preventDefault(); confirmRow(highlightedIndex); }
    else if (event.key === 'Escape') { event.preventDefault(); window.__spec.post('link', { type: 'cancel' }); }
  });

  window.__spec.register('link', (msg: LinkHostMessage) => {
    if (msg.type === 'reset') {
      title.textContent = msg.title;
      search.placeholder = msg.searchPlaceholder;
      search.value = '';
      rows = [];
      linkedRows = [];
      highlightedId = null;
      highlightedIndex = -1;
      busy.hidden = true;
      renderLinked();
      render();
      setTimeout(() => { search.focus(); }, 0);
    } else if (msg.type === 'rows') {
      rows = msg.rows || [];
      render();
    } else if (msg.type === 'linked') {
      linkedRows = msg.rows || [];
      renderLinked();
    } else if (msg.type === 'busy') {
      busy.hidden = !msg.busy;
    }
  });
}
