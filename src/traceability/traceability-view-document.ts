import * as vscode from "vscode";
import { contentSecurityPolicy, createNonce } from "../utils/webview";

export function renderTraceabilityViewDocument(webview: vscode.Webview, assetRoot: vscode.Uri, session: string): string {
  const nonce = createNonce();
  const script = webview.asWebviewUri(vscode.Uri.joinPath(assetRoot, "traceability-view.js"));
  const codicons = webview.asWebviewUri(vscode.Uri.joinPath(assetRoot, "codicon.css"));
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="${contentSecurityPolicy(nonce, webview.cspSource)}">
  <link rel="stylesheet" href="${codicons}">
  <title>Traceability</title>
  <style>
    html,body{height:100%;margin:0;color:var(--vscode-foreground);font-family:var(--vscode-font-family);font-size:var(--vscode-font-size)}
    body{display:flex;flex-direction:column}
    #filter{box-sizing:border-box;width:100%;margin:0;padding:.45rem .6rem;border:0;border-bottom:1px solid var(--vscode-widget-border);background:var(--vscode-input-background);color:var(--vscode-input-foreground)}
    #tree{flex:1;min-height:0;overflow:auto;position:relative}
    .row{height:28px;box-sizing:border-box;display:flex;align-items:center;gap:.35rem;padding-right:.4rem;white-space:nowrap}
    .codicon{width:16px;height:16px;flex:0 0 16px}
    .twisty{width:16px;height:22px;padding:0;border:0;color:inherit;background:transparent}
    .row:hover{background:var(--vscode-list-hoverBackground)}
    .row:focus-visible,#tree:focus-visible,#filter:focus-visible,button:focus-visible{outline:1px solid var(--vscode-focusBorder);outline-offset:-1px}
    .row[aria-selected=true]{background:var(--vscode-list-activeSelectionBackground);color:var(--vscode-list-activeSelectionForeground)}
    .tone-success>.state-icon{color:var(--vscode-testing-iconPassed)}
    .tone-error>.state-icon{color:var(--vscode-testing-iconFailed)}
    .tone-skipped>.state-icon{color:var(--vscode-testing-iconSkipped)}
    .tone-pending>.state-icon{color:var(--vscode-testing-iconQueued)}
    .tone-warning>.state-icon{color:var(--vscode-problemsWarningIcon-foreground,var(--vscode-editorWarning-foreground))}
    .tone-info>.state-icon{color:var(--vscode-testing-iconQueued)}
    .label{overflow:hidden;text-overflow:ellipsis}
    .description{color:var(--vscode-descriptionForeground);overflow:hidden;text-overflow:ellipsis}
    .actions{margin-left:auto;display:flex;gap:.2rem}
    .actions button{display:none;width:24px;height:24px;padding:3px;border:0;color:var(--vscode-icon-foreground);background:transparent}
    .actions button:hover{background:var(--vscode-toolbar-hoverBackground)}
    .row:hover .actions button,.row:focus-within .actions button{display:block}
    .spacer{width:100%}
    .state-title{margin:0;padding:1rem 1rem 0;font-weight:600;white-space:normal}
    .state{margin:0;padding:.35rem 1rem .5rem;white-space:normal;color:var(--vscode-descriptionForeground)}
    .state-actions{display:flex;gap:.4rem;padding:0 1rem}
    .state-actions button{color:var(--vscode-button-foreground);background:var(--vscode-button-background);border:0;padding:.35rem .55rem}
    .state-actions button:hover{background:var(--vscode-button-hoverBackground)}
    #status{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0)}
  </style>
</head>
<body data-session="${session}">
  <input id="filter" type="search" maxlength="4096" aria-label="Filter traceability" placeholder="Filter traceability">
  <div id="tree" role="tree" aria-label="Traceability tree" tabindex="0"></div>
  <div id="status" role="status" aria-live="polite"></div>
  <script nonce="${nonce}" src="${script}"></script>
</body>
</html>`;
}
