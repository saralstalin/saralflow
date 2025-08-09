# SaralFlow - Story to Code Extension

This VS Code extension helps you go from a high-level **natural language story** to a concrete code change. It builds a comprehensive semantic graph of your codebase to provide highly relevant context to an LLM, which then generates a proposed code change that can be reviewed and applied directly within VS Code.

## Features

* **Project-Wide Graph Construction:** Scans all relevant code files (e.g., C#, TypeScript, Python) in your workspace to identify classes, methods, properties, and files.

* **Containment Relationships:** Maps hierarchical relationships (e.g., files contain classes, classes contain methods).

* **LLM Context Provider:** The core purpose is to use this graph to provide highly relevant and structured code context to Large Language Models (LLMs) to facilitate accurate code generation and modifications based on natural language stories.

* **VS Code Integration & Diff Application:** Generates code changes as a VS Code diff view, allowing you to review, select, and apply the proposed changes directly to your files with a single click.

## Usage

1.  Open a workspace/folder containing your code.

2.  Click the `SaralFlow` button in the VS Code activity bar to launch the panel.

3.  In the new webview panel, describe the feature or change you want to implement.

4.  Click "Generate Code" and review the proposed changes.

5.  Use the "Apply Changes" button to apply the selected modifications to your files.

## Development

This extension is built using TypeScript and the VS Code Extension API.

## Known Issues

-   Generating indepth graphs and graph search can cause delays for large projects. This can cause slow performance of VS Code and Story to code generation also might take a few minutes. We are working on a new version which will limit graph size for large projects to optimize performance.


**SaralFlow** - *Auto generate code changes from story description*