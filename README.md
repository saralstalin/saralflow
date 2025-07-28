# SaralFlow - Code Semantic Graph Extension

This VS Code extension aims to help in the "story to code" generation process by building a comprehensive semantic graph of your codebase.

## Features

-   **Project-Wide Graph Construction:** Scans all relevant code files (e.g., C#, TypeScript, Python) in your workspace to identify classes, methods, properties, and files.
-   **Containment Relationships:** Maps hierarchical relationships (e.g., files contain classes, classes contain methods).
-   **Interdependency Mapping:** (Future/Targeted) Aims to identify references between symbols and inheritance relationships between types.
-   **LLM Context Provider:** The core purpose is to use this graph to provide highly relevant and structured code context to Large Language Models (LLMs) to facilitate accurate code generation and modifications based on natural language stories.

## Usage

1.  Open a workspace/folder containing your code.
2.  Open the VS Code Command Palette (`Ctrl+Shift+P` or `Cmd+Shift+P`).
3.  Type `SaralFlow: Show Code Semantic Graph` and press Enter.
4.  The extension will analyze your codebase and display a visual representation of the semantic graph in a new webview panel.

## Development

This extension is built using TypeScript and the VS Code Extension API.

## Known Issues

-   References and inheritance relationships may not be fully resolved due to limitations or timing issues with language server programmatic access in the extension development host. We are actively investigating robust solutions for this.

---
**SaralFlow** - *Auto generate code changes from story description*