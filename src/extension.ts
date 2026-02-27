import * as vscode from 'vscode';
import * as indentChecker from './indentChecker';

export const EXT_NAME = "bmx-workspace";

export function activate(context: vscode.ExtensionContext) {
    indentChecker.activate(context)
	console.log('BMX-Workspace activated');
}

export function deactivate() {
    indentChecker.deactivate()
}
