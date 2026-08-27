import type { TraceabilityRunPreview } from "./traceability-view-protocol";

export interface TraceabilityPreviewDialog {
  show(preview: TraceabilityRunPreview): void;
  close(): void;
}

export function createTraceabilityPreviewDialog(options: {
  readonly dialog: HTMLDialogElement;
  readonly title: HTMLElement;
  readonly summary: HTMLElement;
  readonly members: HTMLElement;
  readonly cancel: HTMLButtonElement;
  readonly confirm: HTMLButtonElement;
  readonly post: (body: unknown) => void;
  readonly generation: () => number;
}): TraceabilityPreviewDialog {
  let current: TraceabilityRunPreview | undefined;

  const close = (): void => {
    current = undefined;
    if (typeof options.dialog.close === "function") {options.dialog.close();}
    else {options.dialog.removeAttribute("open");}
  };
  const cancel = (): void => {
    if (current) {
      options.post({ type: "cancel-preview", generation: options.generation(), previewId: current.previewId });
    }
    close();
  };
  options.cancel.onclick = cancel;
  options.dialog.addEventListener("cancel", (event) => {
    event.preventDefault();
    cancel();
  });
  options.confirm.onclick = () => {
    if (current) {
      options.post({ type: "confirm-preview", generation: options.generation(), previewId: current.previewId });
    }
    close();
  };

  return {
    close,
    show: (preview) => {
      current = preview;
      options.title.textContent = preview.title;
      options.summary.textContent = `${preview.remoteMembers} remote members · ${preview.runnable} runnable locally · ${preview.remoteOnly} remote only`;
      options.members.replaceChildren(...preview.members.map((member) => {
        const item = document.createElement("li");
        if (!member.mapped) {item.className = "remote-only";}
        const mark = document.createElement("span");
        mark.textContent = member.mapped ? "✓" : "−";
        const label = document.createElement("span");
        label.textContent = member.label;
        item.append(mark, label);
        return item;
      }));
      if (preview.displayTruncated) {
        const item = document.createElement("li");
        item.className = "remote-only";
        item.textContent = "Additional remote members are omitted from this display.";
        options.members.append(item);
      }
      options.confirm.textContent = `Run ${preview.runnable} scenarios`;
      if (typeof options.dialog.showModal === "function") {options.dialog.showModal();}
      else {options.dialog.setAttribute("open", "");}
    },
  };
}
