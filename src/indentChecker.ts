import * as vscode from 'vscode'
import { EXT_NAME } from './extension';

/*---------------------- Types ------------------------------------------------------------------*/
enum State {
    Code,
    LineComment,
    BlockComment,
    String,
    Char,
}

enum IndentType {
    None,
    Spaces,
    Tabs,
    TabsThenSpaces,
    TabsThenTooManySpaces,
    Mixed,
}

type ViolatingRange = {
    range: vscode.Range
    expectedIndentation: string
}

type Setting = {
    setting: string
    default: any
}

/*---------------------- Globals ----------------------------------------------------------------*/
const S_LB_INDENT_W: Setting = { setting: "lineBreakIndentWidth", default: 8 }
const S_LB_TAB_SIZE: Setting = { setting: "lineBreakTabSize", default: 4 }

const S_RULER_ENA: Setting = { setting: "rulerHighlight", default: true }
const S_RULER_COLOR: Setting = { setting: "rulerHighlightColor", default: "#8F24B3EF" }
const S_TEXT_BG_ENA: Setting = { setting: "textHighlight", default: true }
const S_TEXT_BG_COLOR: Setting = { setting: "textHighlightColor", default: "#B82EE620" }

let badIndentDeco: vscode.TextEditorDecorationType | undefined

/*---------------------- APIs -------------------------------------------------------------------*/
export function activate(context: vscode.ExtensionContext) {
    refreshAllIndentationViolations(false)

    // Subscribe to events
    context.subscriptions.push(vscode.workspace.onDidSaveTextDocument(
        refreshIndentationViolations));
    context.subscriptions.push(vscode.window.onDidChangeVisibleTextEditors(
        _ => refreshAllIndentationViolations(false)))
    context.subscriptions.push(vscode.workspace.onDidChangeConfiguration(
        _ => refreshAllIndentationViolations(true)))

    // Register commands
    context.subscriptions.push(vscode.commands.registerCommand('bmx-workspace.fixLineBreaks',
        _ => fixIndentationViolationsInActiveEditor()));
}

export function deactivate() {
    badIndentDeco?.dispose();
}

/*---------------------- Helpers ----------------------------------------------------------------*/
function getConf(s: Setting) {
    return vscode.workspace.getConfiguration(EXT_NAME).get(s.setting, s.default)
}

function refreshAllIndentationViolations(resetDecorations: boolean) {
    // Clear old decorations if needed
    if (resetDecorations && badIndentDeco !== undefined) {
        badIndentDeco?.dispose()
        badIndentDeco = undefined;
    }

    // Initialize new decorations if needed
    if (badIndentDeco === undefined) {
        const rulerColor = (getConf(S_RULER_ENA)) ? getConf(S_RULER_COLOR) : undefined
        const bgColor = (getConf(S_TEXT_BG_ENA)) ? getConf(S_TEXT_BG_COLOR) : undefined

        badIndentDeco = vscode.window.createTextEditorDecorationType({
            overviewRulerLane: vscode.OverviewRulerLane.Center,
            overviewRulerColor: rulerColor,
            backgroundColor: bgColor,
            rangeBehavior: vscode.DecorationRangeBehavior.ClosedClosed
        });
    }

    // Render decorations in all opened editors
    const rangeCache = new Map<string, vscode.Range[]>()
    for (const ed of vscode.window.visibleTextEditors) {
        if (ed.document.languageId !== "c") continue

        const docUri = ed.document.uri.toString(true);
        let offendingRanges = rangeCache.get(docUri)
        if (offendingRanges === undefined) {
            offendingRanges = getViolatingParenRanges(ed.document)
            rangeCache.set(docUri, offendingRanges)
        }
        ed.setDecorations(badIndentDeco, offendingRanges)
    }
}

async function fixIndentationViolationsInActiveEditor() {
    const editor = vscode.window.activeTextEditor;
    if (editor === undefined) {
        return
    }

    const parenRanges = getParenRanges(editor.document);
    await editor.edit(editBuilder => {
        for (const pr of parenRanges) {
            const virs = getViolatingIndentRanges(editor.document, pr)
            for (const vir of virs) {
                if (vir.range.isEmpty) {
                    // Remove blank lines within a parenthesis range
                    editBuilder.delete(editor.document.lineAt(vir.range.start.line).rangeIncludingLineBreak)
                } else {
                    // Fix indentation of non-blank lines
                    editBuilder.replace(vir.range, vir.expectedIndentation)
                }
            }
        }
    })

    if (editor.document.isDirty) refreshIndentationViolations(editor.document)
}

function refreshIndentationViolations(doc: vscode.TextDocument) {
    if (doc.languageId !== "c" || badIndentDeco === undefined) return

    const offendingRanges = getViolatingParenRanges(doc);
    for (const ed of vscode.window.visibleTextEditors) {
        if (ed.document.uri.toString() === doc.uri.toString()) {
            ed.setDecorations(badIndentDeco, offendingRanges);
        }
    }
}

function clearIndentationViolations(doc: vscode.TextDocument) {
    if (doc.languageId !== "c" || badIndentDeco === undefined) return

    for (const ed of vscode.window.visibleTextEditors) {
        if (ed.document.uri.toString() === doc.uri.toString()) {
            ed.setDecorations(badIndentDeco, []);
        }
    }
}

function indentWidth(text: string, tabSize: number): [number, IndentType] {
    let type = IndentType.None
    let nSpacesAfterTabs = 0
    let w = 0
    for (const c of text) {
        if (c === " ") {
            switch (type) {
                case IndentType.None:
                case IndentType.Spaces:
                    type = IndentType.Spaces
                    break
                case IndentType.Tabs:
                    type = IndentType.TabsThenSpaces
                    break
                case IndentType.TabsThenSpaces:
                    nSpacesAfterTabs++
                    // Number of spaces after tabs must not exceed tab size
                    if (nSpacesAfterTabs > tabSize) {
                        type = IndentType.TabsThenTooManySpaces
                    }
                case IndentType.TabsThenTooManySpaces:
                    type = IndentType.TabsThenTooManySpaces
                    break
                case IndentType.Mixed:
                    type = IndentType.Mixed
                    break
            }
            w += 1
        } else if (c === "\t") {
            switch (type) {
                case IndentType.None:
                case IndentType.Tabs:
                    type = IndentType.Tabs
                    break
                case IndentType.Spaces:
                case IndentType.TabsThenSpaces:
                case IndentType.TabsThenTooManySpaces:
                case IndentType.Mixed:
                    type = IndentType.Mixed
                    break
            }
            w += tabSize
        } else {
            break;
        }
    }

    return [w, type];
}

function isWhitespace(ch: string) {
    return (ch === " " || ch === "\t");
}

function isLineComment(ch: string, next: string) {
    return (ch === "/" && next === "/");
}

function isBlockCommentStart(ch: string, next: string) {
    return (ch === "/" && next === "*");
}

function isBlockCommentEnd(ch: string, next: string) {
    return (ch === "*" && next === "/");
}

function isLineSplicedAt(text: string, i: number): boolean {
    if (text[i] != '\n') return false

    // Backtrack to the last non-whitespace and non-\r character
    for (; i > 1 && (text[i] === "\r" || isWhitespace(text[i])); --i) { }
    i--;

    return text[i] === "\\";
}

function getParenRanges(doc: vscode.TextDocument) {
    const text = doc.getText()

    const stack: number[] = []
    const ranges: vscode.Range[] = []
    let state = State.Code
    let escape = false
    let atLineStart = true     // Saw nothing except whitespace since last newline
    let inDirective = false    // Currently inside a preprocessor directive definition

    console.log("Parsing ", doc.fileName)
    for (let i = 0; i < text.length; ++i) {
        if (text[i] == '\r') i++
        const ch = text[i]
        const next = (i + 1 < text.length) ? text[i + 1] : ""

        switch (state) {
            case State.LineComment: {
                if (ch === "\n") state = State.Code
                break;
            }

            case State.BlockComment: {
                if (isBlockCommentEnd(ch, next)) { state = State.Code; i++; }
                break;
            }

            case State.String: {
                if (escape) escape = false
                else if (ch === "\\") escape = true
                else if (ch === '"') state = State.Code
                break;
            }

            case State.Char: {
                if (escape) escape = false
                else if (ch === "\\") escape = true
                else if (ch === "'") state = State.Code
                break;
            }

            case State.Code: {
                // Detect first non-whitespace character
                if (atLineStart && !isWhitespace(ch)) {
                    atLineStart = false;

                    // It's a preprocessor directive start if character is #
                    if (!inDirective && ch === "#") inDirective = true;
                }

                // End directive if this newline isn't spliced
                if (inDirective && text[i] == '\n' && !isLineSplicedAt(text, i)) {
                    inDirective = false;
                }

                // Enter comments
                if (isLineComment(ch, next)) {
                    state = State.LineComment;
                    i++;
                    break;
                }
                if (isBlockCommentStart(ch, next)) {
                    state = State.BlockComment;
                    i++;
                    break;
                }

                // Enter strings/chars
                if (ch === '"') {
                    state = State.String;
                    escape = false;
                    break;
                }
                if (ch === "'") {
                    state = State.Char;
                    escape = false;
                    break;
                }

                // Detect parenthesis range starts/ends. Add to list of ranges once end is found.
                if (!inDirective) {
                    if (ch === "(") {
                        stack.push(i);
                    } else if (ch === ")") {
                        const start = stack.pop();
                        if (start !== undefined && stack.length === 0) {
                            // Range is [start, i+1) so it includes both '(' and ')'
                            const startPos = doc.positionAt(start);
                            const endPos = doc.positionAt(i + 1);
                            const range = new vscode.Range(startPos, endPos);
                            ranges.push(range);
                        }
                    }
                }

                break;
            }
        }

        if (ch === "\n") atLineStart = true
    }

    return ranges;
}

function getViolatingParenRanges(doc: vscode.TextDocument) {
    const violatingRanges: vscode.Range[] = [];

    for (const r of getParenRanges(doc)) {
        if (getViolatingIndentRanges(doc, r).length > 0) {
            violatingRanges.push(r);
        }
    }

    return violatingRanges;
}

function getViolatingIndentRangeFromLine(
    doc: vscode.TextDocument, lineIdx: number, expectedIndent: number
): ViolatingRange | undefined {
    if ((lineIdx < 0) || (lineIdx >= doc.lineCount)) return undefined

    const tabSize = getConf(S_LB_TAB_SIZE)
    const line = doc.lineAt(lineIdx);
    // Select indentation range on the next line
    const indentRange = new vscode.Range(
        new vscode.Position(line.lineNumber, 0),
        new vscode.Position(line.lineNumber, line.firstNonWhitespaceCharacterIndex)
    )
    const [actualIndent, indentType] = indentWidth(doc.getText(indentRange), tabSize)

    // Check if line has bad indentation
    if (
        // Expected some indentation, but found none
        (expectedIndent > 0 && indentType === IndentType.None) ||
        // Unexpected indentation type
        (indentType === IndentType.Mixed || indentType == IndentType.TabsThenTooManySpaces) ||
        // Unexpected indentation width
        (expectedIndent != actualIndent) ||
        // Desired indentation can be achieved with only tabs, but spaces found
        (indentType == IndentType.TabsThenSpaces && actualIndent % tabSize == 0)
    ) {
        console.log("Line %d violates indentation", lineIdx)

        // Construct the desired indetation string
        let expectedIndentStr: string
        if (indentType === IndentType.Tabs ||
            indentType == IndentType.TabsThenSpaces ||
            indentType === IndentType.TabsThenTooManySpaces
        ) {
            // Use as many tabs as possible, pad the rest with spaces
            expectedIndentStr = "\t".repeat(Math.trunc(expectedIndent / tabSize)) +
                " ".repeat(expectedIndent % tabSize)
        } else {
            // Use only spaces
            expectedIndentStr = " ".repeat(expectedIndent)
        }

        return { range: indentRange, expectedIndentation: expectedIndentStr }
    }
}

function getViolatingIndentRanges(doc: vscode.TextDocument, range: vscode.Range): ViolatingRange[] {
    const violatingRanges: ViolatingRange[] = []
    const tabSize = getConf(S_LB_TAB_SIZE)
    const text = doc.getText(range);
    let lineIdx = range.start.line;
    const indentStack: number[] = [];
    let state = State.Code;
    let escape = false;

    for (let i = 0; i < text.length; i++) {
        if (text[i] === "\r") i++;
        const ch = text[i];
        const next = i + 1 < text.length ? text[i + 1] : "";

        switch (state) {
            case State.LineComment:
                if (ch == "\n") state = State.Code;
                break;

            case State.BlockComment:
                if (isBlockCommentEnd(ch, next)) { state = State.Code; i++; }
                break;

            case State.String:
                if (escape) escape = false;
                else if (ch === "\\") escape = true;
                else if (ch === '"') state = State.Code;
                break;

            case State.Char:
                if (escape) escape = false;
                else if (ch === "\\") escape = true;
                else if (ch === "'") state = State.Code;
                break;

            case State.Code: {
                // Enter comments
                if (isLineComment(ch, next)) { state = State.LineComment; i++; break; }
                if (isBlockCommentStart(ch, next)) { state = State.BlockComment; i++; break; }

                // Enter strings/chars
                if (ch === '"') { state = State.String; escape = false; break; }
                if (ch === "'") { state = State.Char; escape = false; break; }

                // Keep track of line indentations for all opening parentheses
                if (ch === "(") {
                    const [indent, _] = indentWidth(doc.lineAt(lineIdx).text, tabSize);
                    indentStack.push(indent);
                } else if (ch === ")") {
                    indentStack.pop();
                }

                // When inside a parenthesis range and at end of line,
                // Check next line for indentation violations and add to list if found any
                if ((ch === "\n") && (indentStack.length !== 0)) {
                    const expectedIndentIncrease = getConf(S_LB_INDENT_W)
                    const expectedIndent = indentStack[indentStack.length - 1] + expectedIndentIncrease
                    const vr = getViolatingIndentRangeFromLine(doc, lineIdx + 1, expectedIndent)
                    if (vr) violatingRanges.push(vr)
                }
                break;
            }
        }

        if (text[i] === "\n") lineIdx++
    }

    return violatingRanges;
}
