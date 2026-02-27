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
const S_LB_INDENT_W: Setting = {setting:"lineBreakIndentWidth", default: 8}
const S_LB_TAB_SIZE: Setting = {setting:"lineBreakTabSize", default: 4}

const S_RULER_ENA : Setting = {setting:"rulerHighlight", default: true}
const S_RULER_COLOR : Setting = {setting:"rulerHighlightColor", default: "#8F24B3EF"}
const S_TEXT_BG_ENA : Setting = {setting:"textHighlight", default: true}
const S_TEXT_BG_COLOR : Setting = {setting:"textHighlightColor", default: "#B82EE620"}

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
        (args: {}) => fixIndentationViolationsInActiveEditor()));
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
            offendingRanges = getViolatingRanges(ed.document)
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

    const offendingRanges = getViolatingRanges(doc);
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

function getParenRanges(doc: vscode.TextDocument) {
    const text = doc.getText();

    const stack: number[] = [];
    const ranges: vscode.Range[] = [];
    let state = State.Code;
    let escape = false;
    let atLineStart = true;     // Saw nothing except whitespace since last newline
    let inDirective = false;    // Currently inside a preprocessor directive definition

    const isNewlineChar = (ch: string) => ch === "\n" || ch === "\r";
    const isWhitespaceChar = (ch: string) => ch === "\t" || ch === " ";
    const isLineSpliceAt = (i: number): boolean => {
        let j = i - 1;
        if (j < 0) return false;

        // If we're at '\n' and previous is '\r', backslash would be before '\r'
        if (text[i] === "\n" && text[j] === "\r") j--;

        return j >= 0 && text[j] === "\\";
    };

    console.log("Parsing ", doc.fileName)
    for (let i = 0; i < text.length; i++) {
        const ch = text[i];
        const next = (i + 1 < text.length) ? text[i + 1] : "";

        if (isNewlineChar(ch)) {
            // End directive if this newline isn't spliced
            if (inDirective && !isLineSpliceAt(i)) {
                inDirective = false;
            }

            atLineStart = true;

            continue;
        }

        switch (state) {
            case State.LineComment: {
                if (ch === "\n") state = State.Code;
                break;
            }

            case State.BlockComment: {
                if (ch === "*" && next === "/") {
                    state = State.Code;
                    i++;
                }
                break;
            }

            case State.String: {
                if (escape) {
                    escape = false;
                } else if (ch === "\\") {
                    escape = true;
                } else if (ch === '"') {
                    state = State.Code;
                }
                break;
            }

            case State.Char: {
                if (escape) {
                    escape = false;
                } else if (ch === "\\") {
                    escape = true;
                } else if (ch === "'") {
                    state = State.Code;
                }
                break;
            }

            case State.Code: {
                // Detect preprocessor directive start
                if (!inDirective && atLineStart) {
                    if (isWhitespaceChar(ch)) {
                        break;
                    }
                    if (ch === "#") {
                        inDirective = true;
                        atLineStart = false;
                        break;
                    }
                }

                if (atLineStart && !(isWhitespaceChar(ch))) {
                    atLineStart = false;
                }

                if (ch === "/" && next === "/") {
                    state = State.LineComment;
                    i++;
                    break;
                }
                if (ch === "/" && next === "*") {
                    state = State.BlockComment;
                    i++;
                    break;
                }
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

                if (inDirective) {
                    break;
                }

                // Record range start/end
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
                break;
            }
        }
    }

    return ranges;
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

function getViolatingIndentRanges(doc: vscode.TextDocument, range: vscode.Range): ViolatingRange[] {
    const violatingRanges: ViolatingRange[] = []
    const tabSize = getConf(S_LB_TAB_SIZE)
    const text = doc.getText(range);
    let lineIdx = range.start.line;
    const indentStack: number[] = [];
    let state = State.Code;
    let escape = false;

    for (let i = 0; i < text.length; i++) {
        const ch = text[i];
        const next = i + 1 < text.length ? text[i + 1] : "";

        // Handle newlines (treat CRLF as one newline)
        if (ch === "\r" || ch === "\n") {
            const wasCode = (state === State.Code);

            // line comment ends at newline
            if (state === State.LineComment) state = State.Code;

            const nextLine = doc.lineAt(lineIdx + 1);
            if (
                // Only enforce indentation for line breaks seen while in Code
                wasCode && (indentStack.length !== 0) &&
                // Line within bounds
                (lineIdx + 1 >= 0) && (lineIdx + 1 < doc.lineCount)
            ) {
                const desiredIndentWidth = getConf(S_LB_INDENT_W)
                const indentRange = new vscode.Range(
                    new vscode.Position(nextLine.lineNumber, 0),
                    new vscode.Position(nextLine.lineNumber, nextLine.firstNonWhitespaceCharacterIndex)
                )
                const expected = indentStack[indentStack.length - 1] + desiredIndentWidth
                const [actual, indentType] = indentWidth(doc.getText(indentRange), tabSize)

                if (
                    // Expected some indentation, but found none
                    (expected > 0 && indentType === IndentType.None) ||
                    // Unexpected indentation type
                    (indentType === IndentType.Mixed || indentType == IndentType.TabsThenTooManySpaces) ||
                    // Unexpected indentation width
                    (expected != actual) ||
                    // Desired indentation can be achieved with only tabs
                    (indentType == IndentType.TabsThenSpaces && actual % tabSize == 0)
                ) {
                    console.log("Line %d violates indentation", lineIdx + 1)
                    let expectedIndent: string
                    if (indentType === IndentType.Tabs ||
                        indentType == IndentType.TabsThenSpaces ||
                        indentType === IndentType.TabsThenTooManySpaces
                    ) {
                        expectedIndent = "\t".repeat(Math.trunc(expected / tabSize)) + " ".repeat(expected % tabSize)
                    } else {
                        expectedIndent = " ".repeat(expected)
                    }
                    violatingRanges.push({ range: indentRange, expectedIndentation: expectedIndent })
                }
            }

            lineIdx += 1;

            // Skip the '\n' in CRLF
            if (ch === "\r" && next === "\n") i++;
            continue;
        }

        switch (state) {
            case State.Code: {
                // enter comments
                if (ch === "/" && next === "/") { state = State.LineComment; i++; break; }
                if (ch === "/" && next === "*") { state = State.BlockComment; i++; break; }

                // enter strings/chars
                if (ch === '"') { state = State.String; escape = false; break; }
                if (ch === "'") { state = State.Char; escape = false; break; }

                // parens logic (your stack rule)
                if (ch === "(") {
                    const [indent, _] = indentWidth(doc.lineAt(lineIdx).text, tabSize);
                    indentStack.push(indent);
                } else if (ch === ")") {
                    indentStack.pop();
                }
                break;
            }

            case State.BlockComment:
                if (ch === "*" && next === "/") { state = State.Code; i++; }
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

            case State.LineComment:
                // handled by newline
                break;
        }
    }

    return violatingRanges;
}

function getViolatingRanges(doc: vscode.TextDocument) {
    const offendingRanges: vscode.Range[] = [];

    for (const r of getParenRanges(doc)) {
        if (getViolatingIndentRanges(doc, r).length > 0) {
            offendingRanges.push(r);
        }
    }

    return offendingRanges;
}
