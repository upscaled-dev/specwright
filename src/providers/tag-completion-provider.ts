import * as vscode from "vscode";
import { TagIndex } from "./tag-index";
import { detectTagToken } from "./tag-line-detector";

export class TagCompletionProvider implements vscode.CompletionItemProvider {
  private readonly tagIndex: TagIndex;

  constructor(tagIndex: TagIndex) {
    this.tagIndex = tagIndex;
  }

  public async provideCompletionItems(
    document: vscode.TextDocument,
    position: vscode.Position
  ): Promise<vscode.CompletionItem[] | undefined> {
    const lineUpToCursor = document.lineAt(position.line).text.slice(0, position.character);
    const ctx = detectTagToken(lineUpToCursor);
    if (!ctx) {return undefined;}

    const tags = await this.tagIndex.getAllTags();
    const range = new vscode.Range(
      position.line,
      ctx.tokenStart,
      position.line,
      position.character
    );

    const items: vscode.CompletionItem[] = [];
    for (const tag of tags) {
      const item = new vscode.CompletionItem(tag, vscode.CompletionItemKind.Constant);
      item.insertText = tag;
      item.range = range;
      item.detail = "Playwright-BDD · tag";
      item.filterText = tag;
      items.push(item);
    }
    return items;
  }
}
