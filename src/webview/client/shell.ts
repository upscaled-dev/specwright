import type { ShellTab } from "../protocol";

export function installShell(): void {
  const buttons = [...document.querySelectorAll<HTMLButtonElement>('[role="tab"]')];
  const panes = [...document.querySelectorAll<HTMLElement>('[role="tabpanel"]')];
  const search = document.querySelector<HTMLElement>(".search");
  const scope = document.querySelector<HTMLElement>(".scope");
  const boardTabs = new Set<ShellTab>(["mapping", "matrix", "executions"]);

  function showTab(tab: ShellTab, focus = false): void {
    for (const button of buttons) {
      const active = button.dataset["tab"] === tab;
      button.classList.toggle("active", active);
      button.setAttribute("aria-selected", String(active));
      button.tabIndex = active ? 0 : -1;
      if (active && focus) {button.focus();}
    }
    for (const pane of panes) {pane.hidden = pane.dataset["tab"] !== tab;}
    if (search) {search.hidden = !boardTabs.has(tab);}
    if (scope) {scope.hidden = !boardTabs.has(tab);}
  }

  function activate(button: HTMLButtonElement): void {
    const tab = button.dataset["tab"] as ShellTab | undefined;
    if (tab) {window.__spec.postShell({ type: "tab", tab });}
  }

  for (const button of buttons) {
    button.addEventListener("click", () => activate(button));
    button.addEventListener("keydown", (event) => {
      const visible = buttons.filter((item) => !item.hidden);
      const current = visible.indexOf(button);
      let target: HTMLButtonElement | undefined;
      if (event.key === "Home") {target = visible[0];}
      else if (event.key === "End") {target = visible.at(-1);}
      else if (event.key === "ArrowRight") {target = visible[(current + 1) % visible.length];}
      else if (event.key === "ArrowLeft") {target = visible[(current - 1 + visible.length) % visible.length];}
      if (target) {event.preventDefault(); activate(target); target.focus();}
    });
  }

  window.__spec.registerShell((message) => {
    if (message.type === "activate") {showTab(message.tab as ShellTab, true);}
    else if (message.type === "linkTab") {
      const link = document.querySelector<HTMLButtonElement>('[role="tab"][data-tab="link"]');
      if (link) {link.hidden = !message.visible; if (message.title) {link.title = message.title;}}
    }
  });
  window.__spec.postShell({ type: "ready" });
}
