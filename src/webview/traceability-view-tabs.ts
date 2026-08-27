export type TraceabilityViewTab = "workspace" | "repository" | "test-sets";

export function installTraceabilityTabs(
  tabs: readonly HTMLButtonElement[],
  initial: TraceabilityViewTab,
  select: (view: TraceabilityViewTab, focus: boolean) => void
): void {
  const activate = (view: TraceabilityViewTab, focus = false): void => {
    for (const tab of tabs) {
      const selected = tab.dataset["view"] === view;
      tab.setAttribute("aria-selected", String(selected));
      tab.tabIndex = selected ? 0 : -1;
      if (selected && focus) {tab.focus();}
    }
    select(view, focus);
  };
  for (const tab of tabs) {
    tab.onclick = () => {
      const view = tab.dataset["view"];
      if (view === "workspace" || view === "repository" || view === "test-sets") {activate(view);}
    };
    tab.onkeydown = (event) => {
      const current = tabs.indexOf(tab);
      const next = event.key === "Home" ? 0
        : event.key === "End" ? tabs.length - 1
          : event.key === "ArrowRight" ? (current + 1) % tabs.length
            : event.key === "ArrowLeft" ? (current - 1 + tabs.length) % tabs.length
              : undefined;
      if (next === undefined) {return;}
      event.preventDefault();
      const view = tabs[next]?.dataset["view"];
      if (view === "workspace" || view === "repository" || view === "test-sets") {activate(view, true);}
    };
  }
  activate(initial);
}
