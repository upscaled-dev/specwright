import {
  WEBVIEW_ATTACHMENT_LIMIT,
  type AttachmentSuggestion,
  type PublishAttachmentsModel,
  type PublishDialogModel,
  type PublishHostMessage,
  type PublishRunOption,
  type PublishTarget,
} from "../protocol";

export function installPublish(): void {
  interface ResultList extends HTMLElement {
    __token?: number;
    __input?: HTMLInputElement;
  }
  type MutableRun = Omit<PublishRunOption, "pendingAttachments"> & { pendingAttachments?: PublishRunOption["pendingAttachments"] };
  type SearchKind = "execution" | "test-plan" | "project";
  type VisiblePane = "idle" | "empty" | "busy" | "form";
  const element = <T extends HTMLElement>(id: string): T => {
    const found = document.getElementById(id);
    if (!found) {throw new Error(`Missing publish element: ${id}`);}
    return found as T;
  };
  const idleBox = element<HTMLElement>('publish-idle');
  const emptyBox = element<HTMLElement>('publish-empty');
  const busyBox = element<HTMLElement>('publish-busy');
  const formBox = element<HTMLElement>('publish-form');
  const titleEl = element<HTMLElement>('publish-title');
  const runSelect = element<HTMLSelectElement>('run-select');
  const subtitle = element<HTMLElement>('subtitle');
  const banners = element<HTMLElement>('banners');
  const createFields = element<HTMLElement>('create-fields');
  const appendFields = element<HTMLElement>('append-fields');
  const projectInput = element<HTMLInputElement>('project');
  const projectHint = element<HTMLElement>('project-hint');
  const summaryInput = element<HTMLInputElement>('summary');
  const planInput = element<HTMLInputElement>('plan');
  const envInput = element<HTMLInputElement>('environments');
  const execInput = element<HTMLInputElement>('execution');
  const execResults = element<ResultList>('exec-results');
  const planResults = element<ResultList>('plan-results');
  const projectResults = element<ResultList>('project-results');
  const errProject = element<HTMLElement>('err-project');
  const errSummary = element<HTMLElement>('err-summary');
  const errExecution = element<HTMLElement>('err-execution');
  const execHint = element<HTMLElement>('exec-hint');
  const attachHint = element<HTMLElement>('attach-hint');
  const attachList = element<HTMLElement>('attach-list');
  const browseButton = element<HTMLButtonElement>('browse');
  const attachDisabled = element<HTMLElement>('attach-disabled');
  const modeCreate = element<HTMLInputElement>('mode-create');

  let runs: MutableRun[] = [];
  let selectedRunId = "";
  let searchable = false;
  let knownKeys: readonly string[] = [];
  let attachModel: PublishAttachmentsModel = { available: false, suggestions: [], uploadLimitBytes: 0, evidenceStream: 'evidence' };
  let seenPaths = new Set<string>();
  let token = 0;
  const timers: Partial<Record<SearchKind, number>> = {};
  const pendingBusy = new Set<string>();
  let acceptingUpdates = false;

  function findRun(id: string): MutableRun | undefined { return runs.find((run) => run.id === id); }

  // Both banners print the target the host resolved (a key, or its phrase for a publish the import
  // response never named); neither works out what to call it.
  function republishText(n: NonNullable<PublishRunOption["republish"]>): string {
    const when = new Date(n.publishedAt).toLocaleString();
    if (n.outcomeUnknown) {
      return `The previous publish possibly succeeded on ${  when  } (correlation ${  n.operationId  }). Check Xray before explicitly publishing again; another publish may create a duplicate.`;
    }
    const mode = n.mode === 'append' ? 'appended' : (n.mode === 'create-new' ? 'new execution' : '');
    const modePart = mode ? ` (${  mode  })` : '';
    return `Already published to ${  n.target  } on ${  when  }${modePart  }. Publishing again creates a duplicate.`;
  }
  function pendingText(n: NonNullable<PublishRunOption["pendingAttachments"]>): string {
    const files = n.count === 1 ? 'file' : 'files';
    return `${n.count  } attachment ${  files  } from the last publish to ${  n.target  } did not upload.`;
  }
  function evidenceStreamLine(stream: PublishAttachmentsModel["evidenceStream"]): string {
    if (stream === 'issue') { return "Per-test evidence uploads to the execution's Jira issue (xray.attachTo)."; }
    if (stream === 'both') { return "Per-test evidence rides the result payload and the Jira issue (xray.attachTo)."; }
    return "Per-test evidence rides the result payload (xray.attachTo).";
  }
  function attachHintText(att: PublishAttachmentsModel): string {
    return `${evidenceStreamLine(att.evidenceStream)  } These run-level files always attach to the execution's Jira issue.`;
  }
  function renderBanners(run: MutableRun): void {
    banners.textContent = '';
    if (run.republish) {
      const div = document.createElement('div');
      div.className = 'banner';
      div.textContent = republishText(run.republish);
      banners.appendChild(div);
    }
    if (run.pendingAttachments) {
      const div = document.createElement('div');
      div.className = 'banner pending';
      const span = document.createElement('span');
      span.textContent = pendingText(run.pendingAttachments);
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'link';
      btn.textContent = 'Attach pending files';
      btn.disabled = pendingBusy.has(run.id);
      btn.setAttribute('aria-busy', String(btn.disabled));
      btn.addEventListener('click', () => {
        if (pendingBusy.has(run.id)) {return;}
        window.__spec.post('publish', { type: 'attachPending', runId: run.id });
      });
      div.appendChild(span);
      div.appendChild(btn);
      banners.appendChild(div);
    }
  }
  // Switching runs re-derives everything the selected run owns: subtitle, project prefill + hint,
  // the summary default, the plan prefill, and both banners.
  function applyRun(run: MutableRun): void {
    subtitle.textContent = run.subtitle;
    projectInput.value = run.project.value;
    projectHint.hidden = !run.project.fromDerivation && !run.project.fromScope;
    projectHint.textContent = run.project.fromScope ? "from the board's project scope" : "from this run's test keys";
    summaryInput.value = run.defaultSummary;
    planInput.value = run.prefillPlanKey ?? '';
    clearResults(projectResults);
    renderBanners(run);
  }

  function formatSize(bytes: number): string {
    if (bytes >= 1024 * 1024) { return `${(bytes / (1024 * 1024)).toFixed(1)  } MB`; }
    if (bytes >= 1024) { return `${Math.round(bytes / 1024)  } KB`; }
    return `${bytes  } B`;
  }

  function addAttachmentRow(file: AttachmentSuggestion): void {
    if (seenPaths.has(file.path)) { return; }
    if (seenPaths.size >= WEBVIEW_ATTACHMENT_LIMIT) {
      attachHint.hidden = false;
      attachHint.textContent = `Choose at most ${WEBVIEW_ATTACHMENT_LIMIT} attachments.`;
      return;
    }
    seenPaths.add(file.path);
    const over = file.size > attachModel.uploadLimitBytes;
    const row = document.createElement('li');
    row.className = 'attach-row';
    const check = document.createElement('input');
    check.type = 'checkbox';
    check.className = 'attach-check';
    check.checked = !over;
    check.disabled = over;
    check.dataset["path"] = file.path;
    check.setAttribute('aria-label', `Attach ${file.name}`);
    const name = document.createElement('span');
    name.className = 'name';
    name.textContent = file.name;
    const size = document.createElement('span');
    size.className = 'size';
    size.textContent = formatSize(file.size);
    row.appendChild(check);
    row.appendChild(name);
    row.appendChild(size);
    if (over) {
      const warn = document.createElement('span');
      warn.className = 'over';
      warn.textContent = 'over limit';
      row.appendChild(warn);
    }
    attachList.appendChild(row);
  }

  function selectedAttachments(): string[] | undefined {
    const paths: string[] = [];
    if (attachModel.available) {
      for (const cb of document.querySelectorAll<HTMLInputElement>('.attach-check')) {
        const path = cb.dataset["path"];
        if (cb.checked && !cb.disabled && path) { paths.push(path); }
      }
    }
    if (paths.length > WEBVIEW_ATTACHMENT_LIMIT) {
      attachHint.hidden = false;
      attachHint.textContent = `Choose at most ${WEBVIEW_ATTACHMENT_LIMIT} attachments.`;
      return undefined;
    }
    return paths;
  }

  function clearSearchTimers(): void {
    for (const kind of Object.keys(timers) as SearchKind[]) {
      const timer = timers[kind];
      if (timer !== undefined) {clearTimeout(timer);}
      delete timers[kind];
    }
  }

  function currentMode(): "create" | "append" {
    return document.querySelector<HTMLInputElement>('input[name="publish-mode"]:checked')?.value === "append" ? "append" : "create";
  }

  function applyMode(): void {
    const append = currentMode() === 'append';
    appendFields.hidden = !append;
    createFields.hidden = append;
  }

  function runSearch(kind: SearchKind, query: string, listEl: ResultList, targetInput: HTMLInputElement): void {
    if (!searchable) { return; }
    const myToken = ++token;
    const previous = timers[kind];
    if (previous !== undefined) {clearTimeout(previous);}
    timers[kind] = setTimeout(() => {
      window.__spec.post('publish', { type: 'search', token: myToken, kind, query });
    }, 400);
    listEl.__token = myToken;
    listEl.__input = targetInput;
  }

  // A cleared list also retires its token, so a debounced response still in flight cannot repaint a
  // field the user has already committed or dismissed.
  function clearResults(listEl: ResultList): void {
    listEl.textContent = '';
    listEl.__token = -1;
  }

  // A failed search prints why, above whatever local matches still stand: an empty list alone reads
  // as "no such issue", which is the one thing a failure does not tell us.
  function renderSearchError(listEl: ResultList, message: string): void {
    const li = document.createElement('li');
    li.className = 'search-error';
    li.textContent = message;
    listEl.insertBefore(li, listEl.firstChild);
  }

  function renderResults(listEl: ResultList, items: readonly PublishTarget[]): void {
    listEl.textContent = '';
    for (const item of items) {
      const li = document.createElement('li');
      li.textContent = item.label;
      // mousedown, not click: the list must commit before the input's blur can dismiss it.
      li.addEventListener('mousedown', () => {
        if (listEl.__input) {listEl.__input.value = item.key;}
        clearResults(listEl);
      });
      listEl.appendChild(li);
    }
  }

  function matchingKnownKeys(query: string): readonly string[] {
    const needle = query.toLowerCase();
    return knownKeys.filter((key) => { return needle === '' || key.toLowerCase().indexOf(needle) >= 0; });
  }

  // Known project keys are local data, so this list renders with or without Jira search; a live result
  // for the same query merges over it when one arrives.
  function showKnownKeys(query: string): void {
    projectResults.__input = projectInput;
    renderResults(projectResults, matchingKnownKeys(query).map((key) => { return { key, label: key }; }));
  }

  // A remote hit wins its slot; the local keys the site did not return still follow, so a project known
  // only from the workspace's own config stays reachable.
  function mergedProjectItems(items: readonly PublishTarget[]): PublishTarget[] {
    const merged = [...items];
    const seen = new Set(items.map((item) => { return item.key; }));
    for (const key of matchingKnownKeys(projectInput.value.trim())) {
      if (!seen.has(key)) { merged.push({ key, label: key }); }
    }
    return merged;
  }

  // The last host-acknowledged pane. Intents never move it: a stale revision can be rejected before it
  // reaches the surface, so only model/retry/busy/settled messages may make a transition durable.
  let visible: VisiblePane = 'idle';

  function show(which: VisiblePane): void {
    visible = which;
    idleBox.hidden = which !== 'idle';
    emptyBox.hidden = which !== 'empty';
    busyBox.hidden = which !== 'busy';
    formBox.hidden = which !== 'form';
  }

  // A run refresh may reshape only a form the host already acknowledged; it never clears busy or revives
  // a settled dialog. The busy replay following `runs` owns that state explicitly.
  function showForRuns(): void {
    if (visible === 'form' || visible === 'empty') { show(runs.length === 0 ? 'empty' : 'form'); }
  }

  // The dropdown and the selection the host now holds. The fields follow only when the pick actually
  // moved, which happens only when the run the user had chosen stopped being offered; everything else on
  // the form is theirs. Shared by the in-place refresh and the retry, which carries the same list.
  function applyRuns(msg: Extract<PublishHostMessage, { type: "runs" | "retry" }>): void {
    const had = selectedRunId;
    runs = msg.runs.map((run) => ({ ...run }));
    selectedRunId = msg.selectedRunId;
    renderRunOptions();
    const selected = findRun(selectedRunId);
    if (selected && selectedRunId !== had) { applyRun(selected); }
  }

  // The dropdown alone, off whatever runs and selection are in hand. A whole-model paint and an in-place
  // run refresh build it the same way; only the refresh leaves the rest of the form standing.
  function renderRunOptions(): void {
    runSelect.textContent = '';
    runs.forEach((run) => {
      const opt = document.createElement('option');
      opt.value = run.id;
      opt.textContent = run.label;
      if (run.id === selectedRunId) { opt.selected = true; }
      runSelect.appendChild(opt);
    });
  }

  // Repaint the whole form from a fresh run model, clearing every mutable field first so a second
  // present never inherits the previous run's dropdown, banners, prefill, attach rows, or mode.
  function applyModel(model: PublishDialogModel): void {
    acceptingUpdates = true;
    clearSearchTimers();
    runs = model.runs.map((run) => ({ ...run }));
    selectedRunId = model.selectedRunId;
    searchable = model.jiraSearchAvailable;
    knownKeys = model.knownProjectKeys;
    attachModel = model.attachments;
    seenPaths = new Set<string>();
    titleEl.textContent = model.title;
    renderRunOptions();
    const selected = findRun(selectedRunId) ?? runs[0];
    errProject.textContent = '';
    errSummary.textContent = '';
    errExecution.textContent = '';
    projectInput.setAttribute('aria-invalid', 'false');
    summaryInput.setAttribute('aria-invalid', 'false');
    execInput.setAttribute('aria-invalid', 'false');
    execInput.value = '';
    envInput.value = '';
    clearResults(execResults);
    clearResults(planResults);
    clearResults(projectResults);
    modeCreate.checked = true;
    applyMode();
    execHint.textContent = searchable
      ? 'Type a project key to search its Test Executions, or type an execution key directly.'
      : 'Type the execution key to append to. Add Jira access in Xray setup to search instead.';
    attachList.textContent = '';
    if (attachModel.available) {
      attachHint.hidden = false;
      attachHint.textContent = attachHintText(attachModel);
      attachDisabled.hidden = true;
      browseButton.hidden = false;
      attachModel.suggestions.forEach(addAttachmentRow);
    } else {
      attachHint.hidden = true;
      browseButton.hidden = true;
      attachDisabled.hidden = false;
      attachDisabled.textContent = attachModel.reason ?? 'Add Jira access in Xray setup to attach run-level files.';
    }
    if (selected) { selectedRunId = selected.id; applyRun(selected); }
    // A whole-model paint over an emptied list reaches here through a reload or a retry on a rebuilt
    // document, and a form with nothing in its dropdown offers a Publish button with nothing behind it.
    show(runs.length === 0 ? 'empty' : 'form');
  }

  runSelect.addEventListener('change', () => {
    selectedRunId = runSelect.value;
    const run = findRun(selectedRunId);
    if (run) {
      applyRun(run);
      window.__spec.post('publish', { type: 'selectRun', runId: selectedRunId });
    }
  });
  for (const radio of document.querySelectorAll<HTMLInputElement>('input[name="publish-mode"]')) {
    radio.addEventListener('change', applyMode);
  }
  execInput.addEventListener('input', () => { runSearch('execution', execInput.value.trim(), execResults, execInput); });
  planInput.addEventListener('input', () => { runSearch('test-plan', planInput.value.trim(), planResults, planInput); });
  projectInput.addEventListener('focus', () => { showKnownKeys(''); });
  projectInput.addEventListener('input', () => {
    const query = projectInput.value.trim();
    showKnownKeys(query);
    runSearch('project', query, projectResults, projectInput);
  });
  projectInput.addEventListener('blur', () => { clearResults(projectResults); });
  projectInput.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') { clearResults(projectResults); }
  });

  element<HTMLButtonElement>('cancel').addEventListener('click', () => {
    window.__spec.post('publish', { type: 'cancel' });
  });

  element<HTMLButtonElement>('publish').addEventListener('click', () => {
    errProject.textContent = '';
    errSummary.textContent = '';
    errExecution.textContent = '';
    projectInput.setAttribute('aria-invalid', 'false');
    summaryInput.setAttribute('aria-invalid', 'false');
    execInput.setAttribute('aria-invalid', 'false');
    const attachments = selectedAttachments();
    if (attachments === undefined) {return;}
    if (currentMode() === 'append') {
      const executionKey = execInput.value.trim();
      if (executionKey === '') { errExecution.textContent = 'Enter the execution key to append to.'; execInput.setAttribute('aria-invalid', 'true'); execInput.focus(); return; }
      window.__spec.post('publish', { type: 'confirm', runId: selectedRunId, request: { mode: 'append', executionKey }, attachments });
      return;
    }
    const project = projectInput.value.trim();
    if (project === '') { errProject.textContent = 'Enter the project key to create the execution in.'; projectInput.setAttribute('aria-invalid', 'true'); projectInput.focus(); return; }
    const summary = summaryInput.value.trim();
    if (summary === '') { errSummary.textContent = 'Enter a summary for the new execution.'; summaryInput.setAttribute('aria-invalid', 'true'); summaryInput.focus(); return; }
    const environments = envInput.value.split(',').map((s) => { return s.trim(); }).filter((s) => { return s !== ''; });
    const request: { mode: "create-new"; project: string; summary: string; testPlanKey?: string; environments?: string[] } = { mode: 'create-new', project, summary };
    const plan = planInput.value.trim();
    if (plan !== '') { request.testPlanKey = plan; }
    if (environments.length > 0) { request.environments = environments; }
    window.__spec.post('publish', { type: 'confirm', runId: selectedRunId, request, attachments });
  });

  window.__spec.register('publish', (msg: PublishHostMessage) => {
    if (msg.type === 'model') {
      applyModel(msg.model);
    } else if (msg.type === 'runs') {
      // The list always lands; the pane only follows where the run list is what the user is reading.
      applyRuns(msg);
      showForRuns();
    } else if (msg.type === 'retry') {
      acceptingUpdates = true;
      // A failed publish comes back to the form, and it comes back to the list as it stands now: runs
      // recorded while the publish was out are offered, and evicted ones are not.
      applyRuns(msg);
      show(runs.length === 0 ? 'empty' : 'form');
    } else if (msg.type === 'settled') {
      acceptingUpdates = false;
      clearSearchTimers();
      show('idle');
    } else if (msg.type === 'publish-busy') {
      acceptingUpdates = !msg.busy;
      if (msg.busy) {clearSearchTimers();}
      show(msg.busy ? 'busy' : (runs.length === 0 ? 'empty' : 'form'));
    } else if (msg.type === 'search-result') {
      if (!acceptingUpdates) {return;}
      const listEl = msg.kind === 'execution' ? execResults : (msg.kind === 'project' ? projectResults : planResults);
      if (listEl.__token !== msg.token) { return; }
      const items = msg.error ? [] : msg.items;
      renderResults(listEl, msg.kind === 'project' ? mergedProjectItems(items) : items);
      if (msg.error) { renderSearchError(listEl, `Search failed: ${  msg.error}`); }
    } else if (msg.type === 'browse-result') {
      if (!acceptingUpdates) {return;}
      for (const file of msg.items) { addAttachmentRow(file); }
    } else if (msg.type === 'attachment-error') {
      if (!acceptingUpdates) {return;}
      attachHint.hidden = false;
      attachHint.textContent = msg.text;
    } else if (msg.type === 'pending-busy') {
      if (msg.busy) {pendingBusy.add(msg.runId);} else {pendingBusy.delete(msg.runId);}
      const run = findRun(msg.runId);
      if (acceptingUpdates && run && msg.runId === selectedRunId) {renderBanners(run);}
    } else if (msg.type === 'pending-result') {
      if (!acceptingUpdates) {return;}
      const run = findRun(msg.runId);
      if (run) {
        run.pendingAttachments = msg.remaining > 0 && run.pendingAttachments
          ? { target: run.pendingAttachments.target, count: msg.remaining }
          : undefined;
        if (msg.runId === selectedRunId) { renderBanners(run); }
      }
    }
  });
}
