// src/extension.ts
import * as vscode from 'vscode';
import * as path from 'path'; // Import the 'path' module
import { CodeGraph, GraphNode, GraphEdge, NodeKind, EdgeType, generateNodeId, toNodeKind } from './graphTypes'; // Import our new types

// Define your graph node and edge interfaces
// We've expanded INode to hold crucial semantic data for later retrieval
interface INode {
    id: string; // Unique ID for the node (e.g., file URI + symbol FQN)
    label: string; // Display label (e.g., file name, symbol name)
    kind: string; // Type of element (e.g., 'File', 'Class', 'Method', 'Variable')
    uri: string; // URI of the file this node represents or belongs to
    range?: { start: { line: number, character: number }, end: { line: number, character: number } }; // Location of the element in the file
    parentIds?: string[]; // To track hierarchy, useful for displaying nested structure
    // Add other properties relevant to your LLM context retrieval
    // For example, if you want to store full function signatures, docstrings, etc.
    // codeSnippet?: string; // Could store the actual code lines here if pre-extracted
}

interface IEdge {
    from: string; // ID of the source node
    to: string; // ID of the target node
    label?: string; // Type of relationship (e.g., 'CONTAINS', 'CALLS', 'REFERENCES', 'INHERITS')
}

let currentGraph: CodeGraph = new CodeGraph(); // Our in-memory graph instance
// Declare panel globally so it can be reused or disposed
let panel: vscode.WebviewPanel | undefined = undefined;

// IMPORTANT: Replace with your actual OpenAI API key for chat completions
// For a production extension, store this securely in VS Code settings.
const OPENAI_CHAT_API_KEY = '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';

// IMPORTANT: Replace with your actual OpenAI API key for embeddings (can be the same as chat)
const OPENAI_EMBEDDING_API_KEY = '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';

// Global variable to store the embedded schema chunks for the current workspace
// This will act as our in-memory vector store.
let cachedSchemaChunks: { text: string, embedding: number[] }[] = [];
let isSchemaLoading = false; // Flag to prevent concurrent loading

// Global variable to store the resolved base URI for SQL files (e.g., the 'dbo' folder)
let sqlFilesBaseUri: vscode.Uri | undefined;


export function activate(context: vscode.ExtensionContext) {

    console.log('Congratulations, your extension "SaralFlow" is now active!');

    // Initial load of the schema context when the extension activates
    // This ensures the vector store is ready when the user first opens the generator.
    loadSchemaContext();

    // Set up a file system watcher to detect changes in .sql files
    // This will trigger a reload of the schema context when files are added, changed, or deleted.
    const sqlWatcher = vscode.workspace.createFileSystemWatcher('**/*.sql');

    // Debounce the context reload to prevent excessive API calls and re-embeddings
    let reloadTimeout: NodeJS.Timeout | undefined;
    const debouncedReload = () => {
        if (reloadTimeout) {
            clearTimeout(reloadTimeout);
        }
        reloadTimeout = setTimeout(() => {
            vscode.window.showInformationMessage('SQL files changed. Reloading schema context...');
            loadSchemaContext();
        }, 2000); // 2-second debounce
    };

    sqlWatcher.onDidChange(debouncedReload);
    sqlWatcher.onDidCreate(debouncedReload);
    sqlWatcher.onDidDelete(debouncedReload);

    // Ensure the watcher is disposed when the extension deactivates
    context.subscriptions.push(sqlWatcher);


    // Register the existing "Hello World" command
    const disposableHelloWorld = vscode.commands.registerCommand('SaralFlow.helloWorld', () => {
        vscode.window.showInformationMessage('Hello World from SaralFlow!');
    });
    context.subscriptions.push(disposableHelloWorld);

    // Register our new command
    let disposable = vscode.commands.registerCommand('SaralFlow.showGraph', async () => {
        vscode.window.showInformationMessage('Generating Code Semantic Graph...');
        

        currentGraph.clear();

        const activeEditor = vscode.window.activeTextEditor;
        if (!activeEditor) {
            vscode.window.showInformationMessage('No active text editor found.');
            return;
        }

        const document = activeEditor.document;
        if (document.uri.scheme !== 'file') {
            vscode.window.showInformationMessage('SaralFlow: Only file-based documents can be analyzed.');
            return;
        }

        try {
            // 1. Add the current file as a node
            // Pass an object that conforms to SimpleSymbolInfo { name, kind }
            const fileNodeId = generateNodeId(document.uri, { name: document.fileName, kind: vscode.SymbolKind.File }); // <-- CHANGE HERE
            currentGraph.addNode({
                id: fileNodeId,
                label: document.fileName,
                kind: NodeKind.File,
                uri: document.uri,
                range: new vscode.Range(0, 0, 0, 0)
            });

            const symbols: vscode.DocumentSymbol[] | vscode.SymbolInformation[] = await vscode.commands.executeCommand(
                'vscode.executeDocumentSymbolProvider',
                document.uri
            );

            if (symbols && symbols.length > 0) {
                vscode.window.showInformationMessage(`Found ${symbols.length} symbols in ${document.fileName}.`);
                console.log('Document Symbols:', symbols);

                await processDocumentSymbols(document, symbols, currentGraph, fileNodeId);

                for (const node of currentGraph.getNodes()) {
                    if (node.uri.toString() !== document.uri.toString()) {
                        continue;
                    }

                    if (node.kind === NodeKind.Function || node.kind === NodeKind.Method || node.kind === NodeKind.Constructor) {
                        await fetchAndProcessCallHierarchy(document, node, currentGraph);
                    }
                }

                console.log('--- Final Graph Data ---');
                console.log('Nodes:', currentGraph.getNodes());
                console.log('Edges:', currentGraph.getEdges());
                vscode.window.showInformationMessage(`SaralFlow: Graph built with ${currentGraph.nodes.size} nodes and ${currentGraph.edges.size} edges.`);
                
                if (panel) {
                    panel.dispose();
                }

                // Create and show a new webview panel
                panel = vscode.window.createWebviewPanel(
                    'saralFlowGraph', // Internal webview type
                    'SaralFlow Code Graph', // Title displayed to the user
                    vscode.ViewColumn.Two, // Show in the second editor column
                    {
                        enableScripts: true, // Essential: Allows JavaScript to run in the webview
                        retainContextWhenHidden: true, // Keeps webview state when hidden
                        // Restrict local resource loading to the 'webview/dist' folder
                        // (where `cpx` will copy your webview files during build)
                        localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, 'dist', 'webview')]
                    }
                );

                // Read the HTML content from your webview/index.html file
                const htmlPath = vscode.Uri.joinPath(context.extensionUri, 'dist', 'webview', 'index.html');
                const htmlContent = (await vscode.workspace.fs.readFile(htmlPath)).toString();

                // Get webview-accessible URIs for your local assets (CSS, JS)
                // These will replace the {{cspSource}} placeholders in index.html
                const styleUri = panel.webview.asWebviewUri(vscode.Uri.joinPath(context.extensionUri, 'dist', 'webview', 'style.css'));
                const scriptUri = panel.webview.asWebviewUri(vscode.Uri.joinPath(context.extensionUri, 'dist', 'webview', 'main.js'));
                const visNetworkScriptUri = panel.webview.asWebviewUri(vscode.Uri.joinPath(context.extensionUri, 'dist', 'webview', 'vis-network.min.js')); // <--- THIS LINE

                // Get the Content Security Policy (CSP) source value for 'self' and VS Code specific origins.
                // This is used for the <meta http-equiv="Content-Security-Policy"> tag.
                const cspSource = panel.webview.cspSource;

                // *** CRITICAL CHANGE: NEW ORDER OF REPLACEMENTS ***
                // Step 1: Replace specific asset paths (e.g., {{cspSource}}/style.css) with their generated webview URIs.
                // This ensures that the full correct URI is in place for your <link> and <script> tags.
                let finalHtml = htmlContent
                    .replace(/{{cspSource}}\/style.css/g, styleUri.toString())
                    .replace(/{{cspSource}}\/main.js/g, scriptUri.toString())
                    .replace(/{{cspSource}}\/vis-network.min.js/g, visNetworkScriptUri.toString()); // <--- THIS REPLACE CALL

                // Step 2: Now, replace the general {{cspSource}} for the CSP meta tag.
                // This will correctly inject "'self' https://*.vscode-cdn.net" into your CSP string.
                finalHtml = finalHtml.replace(/{{cspSource}}/g, cspSource);

                // Assign the final processed HTML to the webview
                panel.webview.html = finalHtml;

                // Handle messages received from the webview (e.g., 'webviewReady', 'nodeClicked')
                panel.webview.onDidReceiveMessage(
                    async message => {
                        switch (message.command) {
                            case 'webviewReady':

                                const { nodes, edges } = await extractSemanticGraph(); // <-- Call it here
                                if (panel) { 
                                     panel.webview.postMessage({ command: 'renderGraph', nodes: nodes, edges: edges });
                                }
                                else
                                {
                                     console.error("SaralFlow: Webview panel is not open. Cannot render graph.");
                                }
                               

                                /*console.log('Webview reported ready. Sending graph data...');
                                // Webview is ready, send the current graph nodes and edges
                                panel?.webview.postMessage({
                                    command: 'renderGraph',
                                    // Map GraphNode and GraphEdge objects to vis-network's expected format
                                    nodes: currentGraph.getNodes().map(node => ({
                                        id: node.id,
                                        label: node.label,
                                        group: node.kind, // Use NodeKind for grouping/styling in vis-network
                                        // Add a title for hover tooltip
                                        title: `${node.label} (${NodeKind[node.kind]}) - ${node.uri.fsPath.split('/').pop()}:${node.range.start.line + 1}`
                                    })),
                                    edges: currentGraph.getEdges().map(edge => ({
                                        from: edge.sourceId,
                                        to: edge.targetId,
                                        label: edge.type, // Label edge with its type (CALLS, CONTAINS)
                                        arrows: 'to',      // Ensure arrows are drawn
                                        title: `${edge.sourceId.split('#').pop()} --(${edge.type})--> ${edge.targetId.split('#').pop()}`
                                    }))
                                });
                                return; */
                            case 'nodeClicked':
                                console.log('Node clicked in webview:', message.nodeId);
                                // Example: Open the document and highlight the range of the clicked node
                                const clickedNode = currentGraph.getNode(message.nodeId);
                                if (clickedNode) {
                                    vscode.workspace.openTextDocument(clickedNode.uri).then(document => {
                                        vscode.window.showTextDocument(document, { selection: clickedNode.range, preview: true, preserveFocus: true });
                                    }).then(undefined, err => {
                                        console.error('Error opening document for clicked node:', err);
                                        vscode.window.showErrorMessage(`Could not open document for ${clickedNode.label}: ${err.message}`);
                                    });
                                }
                                return;
                        }
                    },
                    undefined,
                    context.subscriptions
                );

                // Clean up resources when the webview panel is closed by the user
                panel.onDidDispose(() => {
                    panel = undefined;
                }, null, context.subscriptions);


            } else {
                vscode.window.showInformationMessage(`No symbols found in ${document.fileName}. Graph will only contain the file node.`);
            }

        } catch (error) {
            console.error('Error building semantic graph:', error);
            vscode.window.showErrorMessage(`SaralFlow: Failed to build semantic graph. Error: ${error instanceof Error ? error.message : String(error)}. Ensure a language extension is active for this file type.`);
        }
    });

    context.subscriptions.push(disposable);

    const memGraphStatusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 90);
    memGraphStatusBarItem.text = `$(robot) SaralGraph`;
    memGraphStatusBarItem.tooltip = 'Show Graph';
    memGraphStatusBarItem.command = 'SaralFlow.showGraph'; // Link to the new command
    memGraphStatusBarItem.show();
    context.subscriptions.push(memGraphStatusBarItem);

    // Register the new command to open the SQL Generator UI
    const disposableSqlGenerator = vscode.commands.registerCommand('SaralFlow.openSqlGenerator', () => {
        // Create and show a new webview panel
        const panel = vscode.window.createWebviewPanel(
            'saralFlowSqlGenerator', // Unique ID for the panel
            'SaralFlow SQL Generator', // Title displayed in the panel header
            vscode.ViewColumn.One, // Editor column to show the new webview panel in.
            {
                enableScripts: true // Enable JavaScript in the webview
            }
        );
    
    

        // Set the HTML content for the webview
        panel.webview.html = getWebviewContent(panel.webview, context.extensionUri);

        // Handle messages from the webview
        panel.webview.onDidReceiveMessage(
            async message => { // Mark as async because we'll be using await for fetch
                switch (message.command) {
                    case 'generateSql':
                        const scenario = message.text;
                        let proposedSql = '';

                       

                        // Use the cached schema chunks directly
                        if (isSchemaLoading) {
                            proposedSql = 'Schema context is currently loading. Please wait a moment and try again.';
                            panel.webview.postMessage({ command: 'displaySql', text: proposedSql });
                            vscode.window.showWarningMessage('SQL schema context is still loading. Please wait.');
                            return;
                        }

                        let relevantSqlContext = '';
                        if (cachedSchemaChunks.length > 0) {
                            panel.webview.postMessage({ command: 'displaySql', text: 'Searching for relevant schema...' }); // Update UI
                            // 1. Embed the user's scenario
                            const scenarioEmbedding = await getEmbedding(scenario, OPENAI_EMBEDDING_API_KEY);

                            if (scenarioEmbedding) {
                                // 2. Perform similarity search on cached chunks
                                const topN = 5; // Get top 5 most relevant schema chunks
                                const rankedChunks = cachedSchemaChunks
                                    .map(chunk => ({
                                        text: chunk.text,
                                        similarity: cosineSimilarity(scenarioEmbedding, chunk.embedding)
                                    }))
                                    .sort((a, b) => b.similarity - a.similarity) // Sort descending by similarity
                                    .slice(0, topN); // Take top N

                                relevantSqlContext = rankedChunks
                                    .map(chunk => `-- Similarity: ${chunk.similarity.toFixed(4)}\n${chunk.text}`)
                                    .join('\n-- --- Relevant Schema Chunk ---\n');

                                vscode.window.showInformationMessage(`Found ${rankedChunks.length} relevant schema chunks.`);
                            } else {
                                vscode.window.showErrorMessage('Failed to generate embedding for scenario.');
                            }
                        } else {
                            vscode.window.showInformationMessage('No SQL files found or processed for context. Please ensure .sql files are in your workspace.');
                        }


                        // Construct the prompt for the LLM with filtered context
                        const prompt = `You are an expert SQL Server database developer.
                                        Generate SQL Server DDL (Data Definition Language) statements.
                                        For new tables, provide 'CREATE TABLE' statements.
                                        For changes to existing tables (e.g., adding a column, modifying a column), provide the full 'CREATE TABLE' statement reflecting the new desired state. Do NOT use ALTER TABLE for these types of changes, instead provide the complete CREATE TABLE statement.
                                        For new stored procedures, views, or functions, provide 'CREATE PROCEDURE', 'CREATE VIEW', or 'CREATE FUNCTION' statements.
                                        For modifications to existing stored procedures, views, or functions, provide 'CREATE OR ALTER PROCEDURE', 'CREATE OR ALTER VIEW', or 'CREATE OR ALTER FUNCTION' statements to ensure idempotency.
                                        For dropping objects, provide 'DROP TABLE', 'DROP PROCEDURE', 'DROP VIEW', or 'DROP FUNCTION' statements.
                                        IMPORTANT: Each distinct DDL statement (CREATE, ALTER, DROP) MUST be separated by a 'GO' command on its own line. For example:
                                        CREATE TABLE MyNewTable (Id INT PRIMARY KEY);
                                        GO
                                        CREATE OR ALTER PROCEDURE MySproc AS BEGIN SELECT 1; END;
                                        GO
                                        ALTER TABLE ExistingTable ADD NewColumn INT; -- Note: LLM should avoid ALTER TABLE for full table changes as per above.
                                        GO
                                        Focus on SQL Server syntax. Consider the existing database schema provided below.
                                        Provide only the SQL code, no conversational text or explanations. If no changes are needed, state "No changes needed."

                                        --- Relevant Existing SQL Server Schema Context ---
                                        ${relevantSqlContext || 'No relevant existing SQL schema context found.'}
                                        --- End of Schema Context ---

                                        Scenario: "${scenario}"

                                        SQL:`;

                        try {
                            panel.webview.postMessage({ command: 'displaySql', text: 'Sending to LLM for generation...' }); // Update UI
                            const response = await fetch('https://api.openai.com/v1/chat/completions', {
                                method: 'POST',
                                headers: {
                                    'Content-Type': 'application/json',
                                    'Authorization': `Bearer ${OPENAI_CHAT_API_KEY}`
                                },
                                body: JSON.stringify({
                                    model: 'gpt-3.5-turbo', // Consider 'gpt-4' for better context handling
                                    messages: [{ role: 'user', content: prompt }],
                                    temperature: 0.7,
                                    max_tokens: 1000
                                })
                            });

                            if (!response.ok) {
                                const errorData: any = await response.json();
                                console.error('OpenAI API error:', errorData);
                                throw new Error(`OpenAI API error: ${response.status} - ${errorData.error ? errorData.error.message : response.statusText}`);
                            }

                            const data: any = await response.json();
                            proposedSql = data.choices[0].message.content.trim();

                        } catch (error: any) {
                            console.error('Error generating SQL:', error);
                            proposedSql = `Error generating SQL: ${error.message || 'An unknown error occurred.'}\n\nPlease check your API key, internet connection, and ensure your prompt/context are not too large for the LLM.`;
                            vscode.window.showErrorMessage(`Failed to generate SQL: ${error.message || 'Check Debug Console.'}`);
                        }
                        // --- LLM Integration Ends Here ---

                        // Send the proposed SQL back to the webview
                        panel.webview.postMessage({ command: 'displaySql', text: proposedSql });
                        return;

                    case 'acceptChange':
                        const sqlToApply = message.text;
                        if (sqlToApply.trim()) {
                            vscode.window.showInformationMessage(
                                'Are you sure you want to apply these SQL changes to your project?',
                                'Yes', 'No'
                            ).then(async selection => {
                                if (selection === 'Yes') {
                                    panel.webview.postMessage({ command: 'displaySql', text: 'Applying changes...' });
                                    await applySqlChanges(sqlToApply);
                                    panel.webview.postMessage({ command: 'displaySql', text: 'Changes applied. Please review your files.' });
                                } else {
                                    panel.webview.postMessage({ command: 'displaySql', text: 'Changes not applied.' });
                                }
                            });
                        } else {
                            vscode.window.showWarningMessage('No SQL code to apply.');
                        }
                        return;
                }
            },
            undefined,
            context.subscriptions
        );
    });

    context.subscriptions.push(disposableSqlGenerator);

    // Add a status bar item for quick access to the SQL Generator
    const sqlStatusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 90);
    sqlStatusBarItem.text = `$(flame) SaralFlow`;
    sqlStatusBarItem.tooltip = 'Open SaralFlow Code Generator';
    sqlStatusBarItem.command = 'SaralFlow.openSqlGenerator'; // Link to the new command
    sqlStatusBarItem.show();
    context.subscriptions.push(sqlStatusBarItem);
}

/**
 * Generates an embedding for the given text using OpenAI's embedding API.
 * @param text The text to embed.
 * @param apiKey Your OpenAI API key.
 * @returns A promise that resolves to the embedding vector (number[]) or null if an error occurs.
 */
async function getEmbedding(text: string, apiKey: string): Promise<number[] | null> {
    try {
        const response = await fetch('https://api.openai.com/v1/embeddings', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${apiKey}`
            },
            body: JSON.stringify({
                model: 'text-embedding-ada-002', // Recommended embedding model
                input: text
            })
        });

        if (!response.ok) {
            const errorData: any = await response.json();
            console.error('OpenAI Embedding API error:', errorData);
            throw new Error(`Embedding API error: ${response.status} - ${errorData.error ? errorData.error.message : response.statusText}`);
        }

        const data: any = await response.json();
        return data.data[0].embedding;
    } catch (error: any) {
        console.error('Error getting embedding:', error);
        // Do not show error message here, as it might spam if many files fail.
        // The calling function (loadSchemaContext) will handle overall errors.
        return null;
    }
}

/**
 * Loads the SQL project context by finding, chunking, and embedding .sql files.
 * Updates the global `cachedSchemaChunks` variable and `sqlFilesBaseUri`.
 */
async function loadSchemaContext() {
    if (isSchemaLoading) {
        console.log('Schema loading is already in progress. Skipping new load request.');
        return;
    }
    isSchemaLoading = true;
    cachedSchemaChunks = []; // Clear existing cache
    sqlFilesBaseUri = undefined; // Clear existing base URI

    try {
        // Find the 'dbo' folder first to establish the base path for SQL files
        // Adjust the glob pattern to find 'dbo' within any subfolder of the workspace root
        const dboFolders = await vscode.workspace.findFiles('**/dbo', '**/node_modules/**', 1); // Find one dbo folder

        if (dboFolders.length > 0) {
            // Use the first found 'dbo' folder as the base URI
            sqlFilesBaseUri = dboFolders[0]; 
            vscode.window.showInformationMessage(`Found SQL base folder: ${sqlFilesBaseUri.fsPath}`);
        } else if (vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders.length > 0) {
            // Fallback: If no 'dbo' folder, assume SQL files are directly under the workspace root
            sqlFilesBaseUri = vscode.workspace.workspaceFolders[0].uri;
            vscode.window.showWarningMessage('Could not find a "dbo" folder. Assuming SQL files are relative to workspace root.');
        } else {
            vscode.window.showErrorMessage('No workspace folder open. Cannot load SQL context.');
            isSchemaLoading = false;
            return;
        }

        // Now, find all .sql files within the determined base URI (or entire workspace if no dbo)
        // We'll filter later if findFiles returns outside the desired base.
        const sqlFiles = await vscode.workspace.findFiles('**/*.sql', '**/node_modules/**', 100);

        if (sqlFiles.length === 0) {
            vscode.window.showInformationMessage('No .sql files found in the workspace for context. The generator will proceed without schema context.');
            isSchemaLoading = false;
            return;
        }

        // Filter files to ensure they are under the identified sqlFilesBaseUri
        // This ensures we only process SQL files relevant to the detected 'dbo' structure.
        const relevantSqlFiles = sqlFiles.filter(fileUri => fileUri.fsPath.startsWith(sqlFilesBaseUri!.fsPath));

        if (relevantSqlFiles.length === 0) {
            vscode.window.showInformationMessage('No relevant .sql files found under the determined SQL base folder.');
            isSchemaLoading = false;
            return;
        }


        vscode.window.showInformationMessage(`Found ${relevantSqlFiles.length} relevant .sql files for context. Generating embeddings... This might take a moment.`);

        let processedChunks: { text: string, embedding: number[] }[] = [];
        for (const fileUri of relevantSqlFiles) { // Iterate over filtered files
            try {
                const fileContent = await vscode.workspace.fs.readFile(fileUri);
                const sqlText = new TextDecoder().decode(fileContent);

                // Simple chunking: Split by common DDL/DML keywords to get logical blocks
                const chunks = sqlText.split(/(CREATE TABLE|ALTER TABLE|CREATE PROCEDURE|ALTER PROCEDURE|INSERT INTO|UPDATE|DELETE FROM)\s/gi)
                                      .filter(chunk => chunk.trim().length > 0)
                                      .map((chunk, index, arr) => {
                                          // Re-attach the keyword that was used for splitting
                                          if (index > 0 && arr[index - 1].match(/^(CREATE TABLE|ALTER TABLE|CREATE PROCEDURE|ALTER PROCEDURE|INSERT INTO|UPDATE|DELETE FROM)$/i)) {
                                              return arr[index - 1] + ' ' + chunk;
                                          }
                                          return chunk;
                                      })
                                      .filter(chunk => chunk.trim().length > 0);

                for (const chunk of chunks) {
                    const embedding = await getEmbedding(chunk, OPENAI_EMBEDDING_API_KEY);
                    if (embedding) {
                        processedChunks.push({ text: chunk, embedding: embedding });
                    }
                }
            } catch (readError: any) {
                console.warn(`Could not process file ${fileUri.fsPath}: ${readError.message}`);
            }
        }
        cachedSchemaChunks = processedChunks; // Update the global cache
        vscode.window.showInformationMessage(`Generated embeddings for ${cachedSchemaChunks.length} schema chunks. Context ready.`);
    } catch (error: any) {
        console.error('Error finding, reading, or embedding SQL files:', error);
        vscode.window.showErrorMessage(`Error processing SQL project context: ${error.message}`);
        cachedSchemaChunks = []; // Clear cache on error
        sqlFilesBaseUri = undefined; // Clear base URI on error
    } finally {
        isSchemaLoading = false;
    }
}

/**
 * Calculates the cosine similarity between two vectors.
 * @param vec1 The first vector.
 * @param vec2 The second vector.
 * @returns The cosine similarity (a number between -1 and 1).
 */
function cosineSimilarity(vec1: number[], vec2: number[]): number {
    if (vec1.length !== vec2.length) {
        console.error("Vectors must be of the same length for cosine similarity.");
        return 0;
    }

    let dotProduct = 0;
    let magnitude1 = 0;
    let magnitude2 = 0;

    for (let i = 0; i < vec1.length; i++) {
        dotProduct += vec1[i] * vec2[i];
        magnitude1 += vec1[i] * vec1[i];
        magnitude2 += vec2[i] * vec2[i];
    }

    magnitude1 = Math.sqrt(magnitude1);
    magnitude2 = Math.sqrt(magnitude2);

    if (magnitude1 === 0 || magnitude2 === 0) {
        return 0; // Avoid division by zero
    }

    return dotProduct / (magnitude1 * magnitude2);
}

/**
 * Applies the generated SQL code to the project files.
 * This function parses the SQL, determines file paths, and writes/updates files.
 * @param sqlCode The SQL code generated by the LLM.
 */
async function applySqlChanges(sqlCode: string) {
    if (!sqlFilesBaseUri) {
        vscode.window.showErrorMessage('SQL base folder not identified. Please ensure your project has a "dbo" folder or similar structure.');
        return;
    }

    const statements = splitSqlStatements(sqlCode); // Split into individual statements

    // Check if the LLM returned multiple objects in a single 'GO' block
    if (statements.length === 1 && containsMultipleSqlObjects(statements[0])) {
        vscode.window.showWarningMessage(
            'The generated SQL contains multiple object definitions in a single block. ' +
            'Please ensure the LLM separates each object with a "GO" command for proper file splitting. ' +
            'You may need to manually split this file after applying changes.',
            'Understood'
        );
    }

    for (const stmt of statements) {
        const { type, name, action } = getSqlObjectNameTypeAndAction(stmt); // Get action (CREATE, ALTER, DROP)
        console.log(`Processing statement: Action=${action}, Type=${type}, Name=${name}, StatementSnippet=${stmt.substring(0, 50)}...`);

        if (!type || !name || !action) {
            vscode.window.showWarningMessage(`Could not determine object type, name, or action for SQL statement: ${stmt.substring(0, 50)}... Skipping.`);
            console.warn('Skipping statement due to unknown type/name/action.');
            continue;
        }

        const targetRelativePathInDbo = resolveSqlFilePath(type, name); // This returns path relative to dbo
        if (!targetRelativePathInDbo) {
            // resolveSqlFilePath already shows a warning if type is unsupported (e.g., DML)
            continue;
        }

        // Construct the full URI using the resolved sqlFilesBaseUri (the dbo folder)
        const targetFileUri = vscode.Uri.joinPath(sqlFilesBaseUri, targetRelativePathInDbo);
        console.log(`Target file URI: ${targetFileUri.fsPath}`);

        try {
            let fileExists = false;
            try {
                await vscode.workspace.fs.stat(targetFileUri);
                fileExists = true;
                console.log(`File ${targetFileUri.fsPath} exists.`);
            } catch (e: any) {
                if (e.code === 'FileNotFound') {
                    console.log(`File ${targetFileUri.fsPath} does not exist.`);
                } else {
                    console.warn(`Error checking file ${targetFileUri.fsPath}: ${e.message}`);
                }
            }

            if (action === 'CREATE' || action === 'CREATE OR ALTER') { // Handle CREATE OR ALTER as a CREATE action for file management
                if (fileExists) {
                    const selection = await vscode.window.showInformationMessage(
                        `File for ${type} ${name} already exists. What do you want to do?`,
                        'Overwrite', 'Append', 'Cancel'
                    );
                    if (selection === 'Overwrite') {
                        console.log(`Overwriting ${targetFileUri.fsPath} with new content.`);
                        await vscode.workspace.fs.writeFile(targetFileUri, new TextEncoder().encode(stmt.trim()));
                        vscode.window.showInformationMessage(`Overwrote existing ${type} ${name} at ${targetFileUri.fsPath.replace(sqlFilesBaseUri.fsPath, '')}.`);
                    } else if (selection === 'Append') {
                        console.log(`Appending to ${targetFileUri.fsPath}.`);
                        const existingContent = new TextDecoder().decode(await vscode.workspace.fs.readFile(targetFileUri));
                        await vscode.workspace.fs.writeFile(targetFileUri, new TextEncoder().encode(existingContent.trim() + '\n\n' + stmt.trim()));
                        vscode.window.showInformationMessage(`Appended new ${type} ${name} to existing file ${targetFileUri.fsPath.replace(sqlFilesBaseUri.fsPath, '')}.`);
                    } else {
                        vscode.window.showInformationMessage(`Action for ${type} ${name} cancelled.`);
                        console.log(`Action for ${type} ${name} cancelled by user.`);
                        continue; // Skip to next statement
                    }
                } else {
                    // For new files, ensure the directory exists
                    const dirUri = vscode.Uri.file(path.dirname(targetFileUri.fsPath));
                    console.log(`Creating directory ${dirUri.fsPath} for new file.`);
                    await vscode.workspace.fs.createDirectory(dirUri);
                    console.log(`Writing new file ${targetFileUri.fsPath}.`);
                    await vscode.workspace.fs.writeFile(targetFileUri, new TextEncoder().encode(stmt.trim()));
                    vscode.window.showInformationMessage(`Created new file for ${type} ${name} at ${targetFileUri.fsPath.replace(sqlFilesBaseUri.fsPath, '')}.`);
                }
            } else if (action === 'ALTER') {
                if (fileExists) {
                    console.log(`Appending ALTER statement to existing file ${targetFileUri.fsPath}.`);
                    const existingContent = new TextDecoder().decode(await vscode.workspace.fs.readFile(targetFileUri));
                    await vscode.workspace.fs.writeFile(targetFileUri, new TextEncoder().encode(existingContent.trim() + '\n\n' + stmt.trim()));
                    vscode.window.showInformationMessage(`Appended ALTER statement for ${type} ${name} to ${targetFileUri.fsPath.replace(sqlFilesBaseUri.fsPath, '')}.`);
                } else {
                    vscode.window.showWarningMessage(`Cannot ALTER ${type} ${name}. File does not exist at ${targetFileUri.fsPath.replace(sqlFilesBaseUri.fsPath, '')}. Skipping.`);
                    console.warn(`Cannot ALTER non-existent file: ${targetFileUri.fsPath}`);
                }
            } else if (action === 'DROP') {
                if (fileExists) {
                    const selection = await vscode.window.showInformationMessage(
                        `Are you sure you want to DELETE the file for ${type} ${name}? This action cannot be undone easily.`,
                        'Yes, Delete', 'No, Keep'
                    );
                    if (selection === 'Yes, Delete') {
                        console.log(`Deleting file ${targetFileUri.fsPath}.`);
                        await vscode.workspace.fs.delete(targetFileUri, { recursive: false, useTrash: true }); // Move to trash
                        vscode.window.showInformationMessage(`Deleted file for ${type} ${name} from ${targetFileUri.fsPath.replace(sqlFilesBaseUri.fsPath, '')}.`);
                    } else {
                        vscode.window.showInformationMessage(`Deletion of ${type} ${name} cancelled.`);
                        console.log(`Deletion of ${type} ${name} cancelled by user.`);
                    }
                } else {
                    vscode.window.showInformationMessage(`Cannot DROP ${type} ${name}. File does not exist at ${targetFileUri.fsPath.replace(sqlFilesBaseUri.fsPath, '')}. It might already be removed.`);
                    console.log(`Cannot DROP non-existent file: ${targetFileUri.fsPath}`);
                }
            } else {
                vscode.window.showWarningMessage(`Unsupported SQL action '${action}' for ${type} ${name}. Skipping statement.`);
                console.warn(`Unsupported action: ${action} for ${type} ${name}`);
            }

            // Open the file in the editor after writing/modifying (if it still exists)
            if (action !== 'DROP' || (action === 'DROP' && !fileExists)) { // Only open if not deleting, or if it was a non-existent drop
                try {
                    const document = await vscode.workspace.openTextDocument(targetFileUri);
                    await vscode.window.showTextDocument(document);
                    console.log(`Opened file ${targetFileUri.fsPath} in editor.`);
                } catch (openError: any) {
                    // This might happen if a file was just deleted
                    console.warn(`Could not open file ${targetFileUri.fsPath}: ${openError.message}`);
                }
            }


        } catch (writeError: any) {
            vscode.window.showErrorMessage(`Failed to apply SQL change for ${type} ${name}: ${writeError.message}`);
            console.error(`Error writing to file ${targetFileUri.fsPath}:`, writeError);
        }
    }
    vscode.window.showInformationMessage('SQL changes application complete. Please review affected files.');
}

/**
 * Splits a block of SQL code into individual statements.
 * Uses 'GO' as a delimiter, common in SQL Server.
 * @param sqlCode The full SQL code string.
 * @returns An array of individual SQL statements.
 */
function splitSqlStatements(sqlCode: string): string[] {
    // Split by 'GO' keyword on a new line, case-insensitive, and trim empty results
    return sqlCode.split(/^\s*GO\s*$/gim)
                  .map(s => s.trim())
                  .filter(s => s.length > 0);
}

/**
 * Checks if a single SQL block contains definitions for multiple distinct SQL objects.
 * This is a heuristic to warn the user if the LLM failed to insert 'GO' delimiters.
 * @param sqlBlock A single SQL statement block (potentially containing multiple objects).
 * @returns True if multiple object definitions are detected, false otherwise.
 */
function containsMultipleSqlObjects(sqlBlock: string): boolean {
    const objectDefinitionKeywords = [
        'CREATE\\s+TABLE', 'ALTER\\s+TABLE',
        'CREATE\\s+PROCEDURE', 'ALTER\\s+PROCEDURE', 'CREATE\\s+OR\\s+ALTER\\s+PROCEDURE',
        'CREATE\\s+VIEW', 'ALTER\\s+VIEW', 'CREATE\\s+OR\\s+ALTER\\s+VIEW',
        'CREATE\\s+FUNCTION', 'ALTER\\s+FUNCTION', 'CREATE\\s+OR\\s+ALTER\\s+FUNCTION',
        'DROP\\s+TABLE', 'DROP\\s+PROCEDURE', 'DROP\\s+VIEW', 'DROP\\s+FUNCTION'
    ];
    const regex = new RegExp(objectDefinitionKeywords.join('|'), 'gi');
    
    // Count occurrences of object definition keywords
    const matches = sqlBlock.match(regex);
    return matches ? matches.length > 1 : false;
}

/**
 * Extracts the object type (TABLE, PROCEDURE, etc.), name, and action (CREATE, ALTER, DROP) from a SQL statement.
 * @param sqlStatement The SQL statement.
 * @returns An object with 'type', 'name', and 'action', or null if not found.
 */
function getSqlObjectNameTypeAndAction(sqlStatement: string): { type: string | null, name: string | null, action: string | null } {
    let type: string | null = null;
    let name: string | null = null;
    let action: string | null = null;

    // Regex for CREATE/ALTER/DROP TABLE
    let match = sqlStatement.match(/^(CREATE|ALTER|DROP)\s+TABLE\s+\[?(\w+)\]?(?:\.\[?(\w+)\]?)?/i);
    if (match) {
        action = match[1].toUpperCase();
        type = 'TABLE';
        name = match[3] || match[2]; // Prioritize schema.objectname, otherwise just objectname
        return { type, name, action };
    }

    // Regex for CREATE/ALTER/DROP PROCEDURE
    // Updated regex to specifically capture 'CREATE OR ALTER' as a single action if present
    match = sqlStatement.match(/^(CREATE\s+OR\s+ALTER|CREATE|ALTER|DROP)\s+PROCEDURE\s+\[?(\w+)\]?(?:\.\[?(\w+)\]?)?/i);
    if (match) {
        action = match[1].toUpperCase().replace(/\s+/g, ' '); // Normalize 'CREATE OR ALTER'
        type = 'STORED_PROCEDURE';
        name = match[3] || match[2];
        return { type, name, action };
    }

    // Regex for CREATE/ALTER/DROP VIEW
    match = sqlStatement.match(/^(CREATE|ALTER|DROP)\s+VIEW\s+\[?(\w+)\]?(?:\.\[?(\w+)\]?)?/i);
    if (match) {
        action = match[1].toUpperCase();
        type = 'VIEW';
        name = match[3] || match[2];
        return { type, name, action };
    }

    // Regex for CREATE/ALTER/DROP FUNCTION
    match = sqlStatement.match(/^(CREATE|ALTER|DROP)\s+FUNCTION\s+\[?(\w+)\]?(?:\.\[?(\w+)\]?)?/i);
    if (match) {
        action = match[1].toUpperCase();
        type = 'FUNCTION';
        name = match[3] || match[2];
        return { type, name, action };
    }

    // Fallback for DML (INSERT, UPDATE, DELETE) - these don't map to specific files in this structure
    if (sqlStatement.match(/^(INSERT|UPDATE|DELETE)\s+FROM/i)) {
        action = sqlStatement.match(/^(INSERT|UPDATE|DELETE)/i)![1].toUpperCase();
        type = 'DML'; // A generic type for DML
        name = 'DML_Statement'; // Generic name, as DML doesn't have a single object name
        return { type, name, action };
    }


    return { type: null, name: null, action: null };
}

/**
 * Resolves the relative file path for a given SQL object type and name, relative to the 'dbo' folder.
 * Assumes a structure like:
 * - /Tables/MyTable.sql
 * - /Stored Procedures/MySproc.sql
 * @param objectType The type of SQL object (e.g., 'TABLE', 'STORED_PROCEDURE').
 * @param objectName The name of the SQL object.
 * @returns The relative path *within the 'dbo' folder*, or null if the type is not recognized.
 */
function resolveSqlFilePath(objectType: string, objectName: string): string | null {
    const fileName = `${objectName}.sql`;
    switch (objectType.toUpperCase()) {
        case 'TABLE':
            return path.join('Tables', fileName);
        case 'STORED_PROCEDURE':
            return path.join('Stored Procedures', fileName);
        case 'VIEW':
            return path.join('Views', fileName); // Assuming a 'Views' folder
        case 'FUNCTION':
            return path.join('Functions', fileName); // Assuming a 'Functions' folder
        case 'DML':
            // DML statements usually don't go into dedicated files by object name.
            // You might want to handle these differently (e.g., append to a script.sql or log).
            // For now, we'll return null to prevent creating files for DML.
            vscode.window.showWarningMessage(`DML statements are not automatically saved to object-specific files. Please copy manually.`);
            return null;
        default:
            vscode.window.showWarningMessage(`Unsupported SQL object type for file path resolution: ${objectType}`);
            return null;
    }
}


function getWebviewContent(webview: vscode.Webview, extensionUri: vscode.Uri) {
    // Local path to the Tailwind CSS CDN script
    const tailwindCssCdnUri = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'node_modules', 'tailwindcss', 'tailwind.min.js'));

    // Note: Tailwind CSS is typically used via CDN for quick prototyping in webviews.
    // For production, you'd usually compile it.
    // We're loading it directly from node_modules for self-containment.
    // Make sure 'tailwindcss' is installed as a dev dependency: npm install -D tailwindcss

    return `<!DOCTYPE html>
    <html lang="en">
    <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>SaralFlow SQL Generator</title>
        <!-- Load Tailwind CSS from CDN -->
        <script src="https://cdn.tailwindcss.com"></script>
        <style>
            body {
                font-family: 'Inter', sans-serif;
                background-color: #1e1e1e; /* VS Code dark background */
                color: #cccccc; /* VS Code foreground color */
            }
            textarea {
                background-color: #333333; /* Darker background for textareas */
                color: #cccccc;
                border: 1px solid #555555;
                border-radius: 8px; /* Rounded corners */
                padding: 12px;
                resize: vertical; /* Allow vertical resizing */
                font-family: monospace; /* Monospace for code */
            }
            button {
                background-color: #007acc; /* VS Code primary blue */
                color: white;
                padding: 10px 20px;
                border-radius: 8px;
                cursor: pointer;
                transition: background-color 0.2s;
                font-weight: bold;
            }
            button:hover {
                background-color: #005f99;
            }
            .button-group {
                display: flex;
                gap: 1rem; /* Space between buttons */
                justify-content: center;
                margin-top: 1.5rem;
            }
            .button-group button {
                flex-grow: 1; /* Allow buttons to grow */
                max-width: 200px; /* Limit max width */
            }
            /* Specific styling for the Generate SQL button */
            #generateButton {
                background-color: #007acc; /* VS Code primary blue */
                color: white;
                box-shadow: 0 4px 6px rgba(0, 0, 0, 0.1); /* Subtle shadow */
                border: none; /* Remove default border */
            }
            #generateButton:hover {
                background-color: #005f99;
                box-shadow: 0 6px 8px rgba(0, 0, 0, 0.2); /* Slightly larger shadow on hover */
            }
        </style>
    </head>
    <body class="p-6">
        <div class="max-w-4xl mx-auto bg-gray-800 p-8 rounded-lg shadow-lg">
            <h1 class="text-2xl font-bold mb-6 text-center text-white">Story to TSQL Code Generation</h1>

            <div class="mb-6">
                <label for="scenarioInput" class="block text-gray-300 text-sm font-bold mb-2">
                    Story Description / Scenario:
                </label>
                <textarea id="scenarioInput" class="w-full h-32 focus:outline-none focus:ring-2 focus:ring-blue-500"
                    placeholder="Describe what you want to do in a clear and concise way."></textarea>
            </div>

            <div class="button-group">
                <button id="generateButton">Generate SQL</button>
                <button id="acceptButton" class="bg-green-600 hover:bg-green-700">Accept Change</button>
            </div>

            <div class="mt-6">
                <label for="proposedCodeOutput" class="block text-gray-300 text-sm font-bold mb-2">
                    Proposed SQL Code:
                </label>
                <textarea id="proposedCodeOutput" class="w-full h-48 focus:outline-none focus:ring-2 focus:ring-blue-500"
                    placeholder="Generated SQL code will appear here..." readonly></textarea>
            </div>
        </div>

        <script>
            const vscode = acquireVsCodeApi(); // VS Code API for webviews

            const scenarioInput = document.getElementById('scenarioInput');
            const generateButton = document.getElementById('generateButton');
            const acceptButton = document.getElementById('acceptButton'); // Get the new button
            const proposedCodeOutput = document.getElementById('proposedCodeOutput');

            generateButton.addEventListener('click', () => {
                const scenarioText = scenarioInput.value;
                if (scenarioText.trim()) {
                    vscode.postMessage({
                        command: 'generateSql',
                        text: scenarioText
                    });
                    proposedCodeOutput.value = 'Generating SQL...';
                } else {
                    proposedCodeOutput.value = 'Please enter a story description/scenario.';
                }
            });

            // Add event listener for the new Accept Change button
            acceptButton.addEventListener('click', () => {
                const sqlToApply = proposedCodeOutput.value;
                if (sqlToApply.trim() && sqlToApply !== 'Generating SQL...' && sqlToApply !== 'Error generating SQL...' && sqlToApply !== 'Changes not applied.' && sqlToApply !== 'Changes applied. Please review your files.') {
                    vscode.postMessage({
                        command: 'acceptChange',
                        text: sqlToApply
                    });
                } else {
                    vscode.window.showWarningMessage('No valid SQL code to apply.');
                }
            });

            // Handle messages from the extension
            window.addEventListener('message', event => {
                const message = event.data;
                switch (message.command) {
                    case 'displaySql':
                        proposedCodeOutput.value = message.text;
                        break;
                }
            });
        </script>
    </body>
    </html>`;
}

export function deactivate() {
    // Dispose of the file system watcher when the extension deactivates
    // (This is implicitly handled by context.subscriptions.push(sqlWatcher) in activate)
}



/**
 * Extracts semantic information from the workspace and constructs a graph.
 * This version includes:
 * - File discovery across the workspace.
 * - Document symbol extraction for containment relationships.
 * - Robust C# extension activation.
 * - Building interdependencies (REFERENCES via LSP with fallback, INHERITS via LSP with C# regex fallback).
 */
async function extractSemanticGraph(): Promise<{ nodes: INode[]; edges: IEdge[] }> {
    const nodes: INode[] = [];
    const edges: IEdge[] = [];
    const nodeMap = new Map<string, INode>(); // Map<NodeId, INode> for quick lookup
    const processedFiles = new Set<string>(); // Set<Filepath> to track files already processed

    if (!vscode.workspace.workspaceFolders || vscode.workspace.workspaceFolders.length === 0) {
        vscode.window.showInformationMessage('No workspace folder open. Cannot build graph.');
        console.error('[SaralFlow Graph] ERROR: No workspace folder open.');
        return { nodes: [], edges: [] };
    }

    const workspaceFolder = vscode.workspace.workspaceFolders[0].uri;
    console.log(`[SaralFlow Graph] Starting graph extraction for workspace: ${workspaceFolder.fsPath}`);

    // --- Auxiliary Data Structure for Efficient Lookup ---
    const fileSymbolsMap = new Map<string, INode[]>(); // Key: file URI string, Value: Array of INode (symbols)

    const findContainingSymbolId = (fileUriStr: string, position: vscode.Position): string | null => {
        const symbolsInFile = fileSymbolsMap.get(fileUriStr);
        if (!symbolsInFile) {
            return null;
        }
        for (let i = symbolsInFile.length - 1; i >= 0; i--) {
            const symbol = symbolsInFile[i];
            if (!symbol.range) {continue;}
            const start = new vscode.Position(symbol.range.start.line, symbol.range.start.character);
            const end = new vscode.Position(symbol.range.end.line, symbol.range.end.character);
            const symbolRange = new vscode.Range(start, end);
            if (symbolRange.contains(position)) {
                return symbol.id;
            }
        }
        return null;
    };

    // --- 0. Robust Wait for C# Extension Activation (Simpler Delay Approach) ---
    console.log('[SaralFlow Graph] Ensuring C# extension is active...');
    vscode.window.showInformationMessage('SaralFlow Graph: Activating C# language services...');

    const csharpExtensionId = 'ms-dotnettools.csharp';
    const csharpExtension = vscode.extensions.getExtension(csharpExtensionId);

    if (!csharpExtension) {
        console.error(`[SaralFlow Graph] ERROR: C# extension "${csharpExtensionId}" not found. Please ensure it is installed.`);
        vscode.window.showErrorMessage(`SaralFlow Graph: C# extension not found. Please install it for C# features.`);
        return { nodes: [], edges: [] };
    }

    if (!csharpExtension.isActive) {
        console.log(`[SaralFlow Graph] C# extension "${csharpExtensionId}" is not active, activating...`);
        try {
            await csharpExtension.activate();
            console.log(`[SaralFlow Graph] C# extension "${csharpExtensionId}" activated.`);
        } catch (e: any) {
            console.error(`[SaralFlow Graph] ERROR activating C# extension: ${e.message}`);
            vscode.window.showErrorMessage(`SaralFlow Graph: Failed to activate C# extension: ${e.message}`);
            return { nodes: [], edges: [] };
        }
    } else {
        console.log(`[SaralFlow Graph] C# extension "${csharpExtensionId}" is already active.`);
    }

    // Give the language server a substantial amount of time to load the project's semantic model.
    // This is a heuristic, but often necessary for complex language servers in the Extension Host.
    const initialLSPWaitTimeMs = 15000; // 15 seconds
    console.log(`[SaralFlow Graph] Waiting ${initialLSPWaitTimeMs / 1000} seconds for C# language server to initialize...`);
    await new Promise(resolve => setTimeout(resolve, initialLSPWaitTimeMs));
    console.log('[SaralFlow Graph] Initial C# language server wait complete, proceeding with graph build.');


    // --- 1. Discover all relevant code files ---
    const files = await vscode.workspace.findFiles('**/*.{ts,tsx,js,jsx,cs,py}', '{**/node_modules/**,**/bin/**,**/obj/**,**/__pycache__/**,**/.venv/**}');

    console.log(`[SaralFlow Graph] DEBUG: vscode.workspace.findFiles found ${files.length} files.`);
    if (files.length === 0) {
        vscode.window.showWarningMessage('SaralFlow Graph: No code files found matching the pattern. Check your workspace or glob pattern.');
        console.warn('[SaralFlow Graph] No files found, returning empty graph.');
        return { nodes: [], edges: [] };
    }

    console.log(`[SaralFlow Graph] Found ${files.length} code files matching pattern.`);
    vscode.window.showInformationMessage(`SaralFlow Graph: Found ${files.length} code files. Processing...`);


    // --- 2. Process each file to extract document symbols and build containment graph ---
    for (const fileUri of files) {
        const filePath = fileUri.fsPath;
        const relativePath = vscode.workspace.asRelativePath(fileUri, true);

        if (processedFiles.has(filePath)) {
            continue;
        }
        processedFiles.add(filePath);

        const fileNodeId = fileUri.toString();
        if (!nodeMap.has(fileNodeId)) {
            const fileNode: INode = {
                id: fileNodeId,
                label: relativePath,
                kind: 'File',
                uri: fileNodeId,
                range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } }
            };
            nodes.push(fileNode);
            nodeMap.set(fileNodeId, fileNode);
        }

        try {
            const document = await vscode.workspace.openTextDocument(fileUri);
            console.log(`[SaralFlow Graph] Processing file: ${relativePath}`);

            const documentSymbols = await vscode.commands.executeCommand<vscode.DocumentSymbol[]>(
                'vscode.executeDocumentSymbolProvider',
                document.uri
            );

            console.log(`[SaralFlow Graph] DEBUG: Found ${documentSymbols ? documentSymbols.length : 0} symbols in ${relativePath}`);

            if (documentSymbols && documentSymbols.length > 0) {
                const processSymbol = (symbol: vscode.DocumentSymbol, parentId: string) => {
                    const symbolUniqueQualifier = `${symbol.name}:${symbol.range.start.line}:${symbol.range.start.character}`;
                    const symbolId = `${parentId}#${symbolUniqueQualifier}`;

                    if (!nodeMap.has(symbolId)) {
                        const symbolNode: INode = {
                            id: symbolId,
                            label: symbol.name,
                            kind: vscode.SymbolKind[symbol.kind],
                            uri: fileUri.toString(),
                            range: {
                                start: { line: symbol.range.start.line, character: symbol.range.start.character },
                                end: { line: symbol.range.end.line, character: symbol.range.end.character }
                            },
                            parentIds: [parentId]
                        };
                        nodes.push(symbolNode);
                        nodeMap.set(symbolId, symbolNode);

                        edges.push({
                            from: parentId,
                            to: symbolId,
                            label: 'CONTAINS'
                        });

                        if (symbolNode.kind !== 'File' && symbolNode.range) {
                            let symbolsInFile = fileSymbolsMap.get(fileUri.toString());
                            if (!symbolsInFile) {
                                symbolsInFile = [];
                                fileSymbolsMap.set(fileUri.toString(), symbolsInFile);
                            }
                            symbolsInFile.push(symbolNode);
                        }
                    }

                    if (symbol.children && symbol.children.length > 0) {
                        symbol.children.forEach(childSymbol => {
                            processSymbol(childSymbol, symbolId);
                        });
                    }
                };

                documentSymbols.forEach(topLevelSymbol => {
                    processSymbol(topLevelSymbol, fileNodeId);
                });
            } else {
                console.log(`[SaralFlow Graph] No document symbols found in: ${relativePath}`);
            }

        } catch (error: any) {
            console.error(`[SaralFlow Graph] Failed to open or process document ${relativePath}: ${error.message}`);
            vscode.window.showErrorMessage(`SaralFlow Graph: Error processing ${relativePath}: ${error.message}`);
        }
    }

    console.log('[SaralFlow Graph] Sorting symbols for quick lookup...');
    fileSymbolsMap.forEach(symbols => {
        symbols.sort((a, b) => {
            if (!a.range || !b.range) {return 0;}
            return a.range.start.line - b.range.start.line || a.range.start.character - b.range.start.character;
        });
    });
    console.log('[SaralFlow Graph] Finished sorting symbols.');
    console.log(`[SaralFlow Graph] DEBUG: After initial file and symbol processing: nodes.length = ${nodes.length}, edges.length = ${edges.length}`);


    // --- 3. Build Interdependencies: REFERENCES (LSP with Fallback) ---
    console.log('[SaralFlow Graph] Building interdependencies (References)...');
    vscode.window.showInformationMessage('SaralFlow Graph: Building interdependencies (References)...');

    let referenceEdgesCount = 0;

    for (const [symbolNodeId, symbolNode] of nodeMap.entries()) {
        if (symbolNode.kind === 'File' || !symbolNode.uri || !symbolNode.range) {
            continue;
        }

        let references: vscode.Location[] | null | undefined = null;
        let successViaLSPReferences = false;

        // Try LSP for References
        try {
            const definitionUri = vscode.Uri.parse(symbolNode.uri);
            const definitionPosition = new vscode.Position(symbolNode.range.start.line, symbolNode.range.start.character);

            console.log(`[SaralFlow Graph] DEBUG: Querying references via LSP for: ${symbolNode.label} (Kind: ${symbolNode.kind}) at URI: ${symbolNode.uri}, Position: ${definitionPosition.line}:${definitionPosition.character}`);

            references = await vscode.commands.executeCommand<vscode.Location[]>(
                'vscode.executeReferenceProvider',
                definitionUri,
                definitionPosition
            );

            console.log(`[SaralFlow Graph] DEBUG: executeReferenceProvider for "${symbolNode.label}" returned: ${references ? references.length + ' references' : 'null/undefined'}.`);

            if (references && references.length > 0) {
                successViaLSPReferences = true;
                references.forEach(referenceLocation => {
                    const refFileUriStr = referenceLocation.uri.toString();

                    if (refFileUriStr === symbolNode.uri && referenceLocation.range.start.isEqual(definitionPosition)) {
                        return; // Skip self-reference
                    }
                    if (!processedFiles.has(referenceLocation.uri.fsPath)) {
                        console.log(`[SaralFlow Graph] DEBUG: Skipping external reference to "${symbolNode.label}" in ${referenceLocation.uri.fsPath}`);
                        return; // Skip references outside our processed files
                    }

                    const fromNodeId = findContainingSymbolId(refFileUriStr, referenceLocation.range.start);

                    if (fromNodeId && nodeMap.has(fromNodeId) && fromNodeId !== symbolNodeId) {
                        const isDuplicateEdge = edges.some(e => e.from === fromNodeId && e.to === symbolNodeId && e.label === 'REFERENCES');
                        if (!isDuplicateEdge) {
                            edges.push({ from: fromNodeId, to: symbolNodeId, label: 'REFERENCES' });
                            referenceEdgesCount++;
                            console.log(`[SaralFlow Graph] DEBUG: Added REFERENCES edge (LSP) from ${nodeMap.get(fromNodeId)?.label} to ${symbolNode.label}`);
                        }
                    } else if (fromNodeId === null) {
                        const fileContainingRefId = referenceLocation.uri.toString();
                        if (nodeMap.has(fileContainingRefId) && fileContainingRefId !== symbolNodeId) {
                            const isDuplicateEdge = edges.some(e => e.from === fileContainingRefId && e.to === symbolNodeId && e.label === 'REFERENCES');
                            if (!isDuplicateEdge) {
                                edges.push({ from: fileContainingRefId, to: symbolNodeId, label: 'REFERENCES' });
                                referenceEdgesCount++;
                                console.log(`[SaralFlow Graph] DEBUG: Added REFERENCES edge (LSP) from file ${nodeMap.get(fileContainingRefId)?.label} to ${symbolNode.label}`);
                            }
                        }
                    } else {
                         console.log(`[SaralFlow Graph] DEBUG: Ref to ${symbolNode.label} from ${refFileUriStr} not added (fromNodeId is self or not in nodeMap: ${fromNodeId})`);
                    }
                });
            } else if (references === null || references === undefined || references.length === 0) {
                console.log(`[SaralFlow Graph] DEBUG: LSP Reference provider returned empty/null/undefined for "${symbolNode.label}".`);
            }
        } catch (error: any) {
            console.error(`[SaralFlow Graph] ERROR: LSP Reference lookup failed for ${symbolNode.label} (${symbolNode.uri}): ${error.message}. Attempting fallback.`);
        }

        // --- Fallback for REFERENCES (Simple text search - less accurate) ---
        if (!successViaLSPReferences && symbolNode.kind !== 'File' && symbolNode.label) { // Only fallback for non-file nodes
            try {
                const symbolNameRegex = new RegExp(`\\b${symbolNode.label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'g'); // Escape regex special chars

                for (const fileToCheckUri of files) {
                    const fileToCheckPath = fileToCheckUri.fsPath;
                    if (fileToCheckPath === symbolNode.uri) continue; // Don't check the file defining the symbol

                    if (!processedFiles.has(fileToCheckPath)) continue; // Only check files we actually processed

                    const documentToCheck = await vscode.workspace.openTextDocument(fileToCheckUri);
                    const fileContent = documentToCheck.getText();

                    let match;
                    while ((match = symbolNameRegex.exec(fileContent)) !== null) {
                        const startPosition = documentToCheck.positionAt(match.index);
                        const endPosition = documentToCheck.positionAt(match.index + match[0].length);
                        const referenceRange = new vscode.Range(startPosition, endPosition);

                        const fromNodeId = findContainingSymbolId(fileToCheckUri.toString(), referenceRange.start);

                        if (fromNodeId && nodeMap.has(fromNodeId) && fromNodeId !== symbolNodeId) {
                            const isDuplicateEdge = edges.some(e => e.from === fromNodeId && e.to === symbolNodeId && e.label === 'REFERENCES');
                            if (!isDuplicateEdge) {
                                edges.push({ from: fromNodeId, to: symbolNodeId, label: 'REFERENCES' });
                                referenceEdgesCount++;
                                console.log(`[SaralFlow Graph] DEBUG: Added REFERENCES edge (Fallback) from ${nodeMap.get(fromNodeId)?.label} to ${symbolNode.label} in ${vscode.workspace.asRelativePath(fileToCheckUri)}`);
                            }
                        } else if (fromNodeId === null) {
                            const fileContainingRefId = fileToCheckUri.toString();
                            if (nodeMap.has(fileContainingRefId) && fileContainingRefId !== symbolNodeId) {
                                const isDuplicateEdge = edges.some(e => e.from === fileContainingRefId && e.to === symbolNodeId && e.label === 'REFERENCES');
                                if (!isDuplicateEdge) {
                                    edges.push({ from: fileContainingRefId, to: symbolNodeId, label: 'REFERENCES' });
                                    referenceEdgesCount++;
                                    console.log(`[SaralFlow Graph] DEBUG: Added REFERENCES edge (Fallback) from file ${nodeMap.get(fileContainingRefId)?.label} to ${symbolNode.label} in ${vscode.workspace.asRelativePath(fileToCheckUri)}`);
                                }
                            }
                        } else {
                            console.log(`[SaralFlow Graph] DEBUG: Fallback Ref to ${symbolNode.label} from ${vscode.workspace.asRelativePath(fileToCheckUri)} not added (fromNodeId is self or not in nodeMap: ${fromNodeId})`);
                        }
                    }
                }
            } catch (error: any) {
                console.error(`[SaralFlow Graph] ERROR: Fallback Reference lookup failed for ${symbolNode.label}: ${error.message}`);
            }
        }
    }
    console.log(`[SaralFlow Graph] Finished building references. Added ${referenceEdgesCount} reference edges. Current total edges: ${edges.length}`);


    // --- 4. Build Interdependencies: INHERITANCE (LSP with C#-specific Regex Fallback) ---
    console.log('[SaralFlow Graph] Building interdependencies (Inheritance)...');
    vscode.window.showInformationMessage('SaralFlow Graph: Building inheritance relationships...');

    let inheritanceEdgesCount = 0;

    for (const [symbolNodeId, symbolNode] of nodeMap.entries()) {
        if ((symbolNode.kind === vscode.SymbolKind[vscode.SymbolKind.Class] ||
             symbolNode.kind === vscode.SymbolKind[vscode.SymbolKind.Interface]) &&
            symbolNode.uri && symbolNode.range)
        {
            const classUri = vscode.Uri.parse(symbolNode.uri);
            const classPosition = new vscode.Position(symbolNode.range.start.line, symbolNode.range.start.character);

            let supertypes: vscode.TypeHierarchyItem[] | null | undefined = null;
            let successViaLSP = false;

            // Try LSP for Inheritance first
            try {
                console.log(`[SaralFlow Graph] DEBUG: Querying Type Hierarchy via LSP for: ${symbolNode.label} (Kind: ${symbolNode.kind}) at URI: ${symbolNode.uri}, Position: ${symbolNode.range.start.line}:${symbolNode.range.start.character}`);

                const typeHierarchyItems = await vscode.commands.executeCommand<vscode.TypeHierarchyItem[]>(
                    'vscode.prepareTypeHierarchy',
                    classUri,
                    classPosition
                );
                console.log(`[SaralFlow Graph] DEBUG: prepareTypeHierarchy for "${symbolNode.label}" returned: ${typeHierarchyItems ? typeHierarchyItems.length + ' items' : 'null/undefined'}.`);


                if (typeHierarchyItems && typeHierarchyItems.length > 0) {
                    const classHierarchyItem = typeHierarchyItems[0];
                    console.log(`[SaralFlow Graph] DEBUG: prepareTypeHierarchy successful for ${symbolNode.label}. Resolving supertypes...`);

                    supertypes = await vscode.commands.executeCommand<vscode.TypeHierarchyItem[]>(
                        'vscode.executeTypeHierarchySupertypes',
                        classHierarchyItem
                    );

                    console.log(`[SaralFlow Graph] DEBUG: executeTypeHierarchySupertypes for "${symbolNode.label}" returned: ${supertypes ? supertypes.length + ' supertypes' : 'null/undefined'}.`);


                    if (supertypes && supertypes.length > 0) {
                        successViaLSP = true;
                        supertypes.forEach(supertypeItem => {
                            const supertypeUri = supertypeItem.uri.toString();
                            const supertypeSymbolId = findContainingSymbolId(supertypeUri, supertypeItem.selectionRange.start);

                            if (supertypeSymbolId && nodeMap.has(supertypeSymbolId) && supertypeSymbolId !== symbolNodeId) {
                                const isDuplicateEdge = edges.some(e => e.from === symbolNodeId && e.to === supertypeSymbolId && e.label === 'INHERITS');
                                if (!isDuplicateEdge) {
                                    edges.push({
                                        from: symbolNodeId,
                                        to: supertypeSymbolId,
                                        label: 'INHERITS'
                                    });
                                    inheritanceEdgesCount++;
                                    console.log(`[SaralFlow Graph] DEBUG: Added INHERITS edge via LSP from ${symbolNode.label} to ${nodeMap.get(supertypeSymbolId)?.label}`);
                                }
                            } else {
                                console.log(`[SaralFlow Graph] DEBUG: LSP Supertype node for "${symbolNode.label}" not found in nodeMap or is self: ${supertypeSymbolId}`);
                            }
                        });
                    } else if (supertypes === null || supertypes === undefined || supertypes.length === 0) {
                         console.log(`[SaralFlow Graph] DEBUG: LSP executeTypeHierarchySupertypes returned empty/null/undefined for "${symbolNode.label}".`);
                    }
                } else if (typeHierarchyItems === null || typeHierarchyItems === undefined || typeHierarchyItems.length === 0) {
                    console.log(`[SaralFlow Graph] DEBUG: LSP prepareTypeHierarchy returned empty/null/undefined for "${symbolNode.label}".`);
                }
            } catch (error: any) {
                console.error(`[SaralFlow Graph] ERROR: LSP Type Hierarchy lookup failed for ${symbolNode.label} (${symbolNode.uri}): ${error.message}. Attempting fallback.`);
            }

            // --- Fallback for INHERITANCE (C#-specific Regex) ---
            if (!successViaLSP) { // This condition checks if LSP was NOT successful
                try {
                    const document = await vscode.workspace.openTextDocument(classUri);
                    const classTextLine = document.lineAt(classPosition.line).text;
                    // Regex for C# inheritance: looks for 'class ClassName : BaseType'
                    const inheritanceRegex = /(?:class|interface)\s+([A-Za-z0-9_]+)\s*:\s*([A-Za-z0-9_,.\s<>]+)/;
                    const match = classTextLine.match(inheritanceRegex);

                    if (match && match[1] === symbolNode.label && match[2]) {
                        const baseTypesRaw = match[2];
                        const baseTypeNames = baseTypesRaw.split(',').map(name => name.trim().replace(/<.*>/g, ''));

                        for (const baseTypeName of baseTypeNames) {
                            // Find the base type node by label and a 'Class' kind (heuristic)
                            const baseTypeNode = nodes.find(n => n.label === baseTypeName && n.kind === vscode.SymbolKind[vscode.SymbolKind.Class]);
                            if (baseTypeNode && baseTypeNode.id !== symbolNodeId) {
                                const isDuplicateEdge = edges.some(e => e.from === symbolNodeId && e.to === baseTypeNode.id && e.label === 'INHERITS');
                                if (!isDuplicateEdge) {
                                    edges.push({
                                        from: symbolNodeId,
                                        to: baseTypeNode.id,
                                        label: 'INHERITS'
                                    });
                                    inheritanceEdgesCount++;
                                    console.log(`[SaralFlow Graph] DEBUG: Added INHERITS edge via fallback from ${symbolNode.label} to ${baseTypeNode.label}`);
                                }
                            } else {
                                console.log(`[SaralFlow Graph] DEBUG: Fallback: Base type "${baseTypeName}" node not found in graph for ${symbolNode.label}`);
                            }
                        }
                    }
                } catch (error: any) {
                    console.error(`[SaralFlow Graph] ERROR: Fallback inheritance parsing failed for ${symbolNode.label}: ${error.message}`);
                }
            }
        }
    }
    console.log(`[SaralFlow Graph] Finished building inheritance. Added ${inheritanceEdgesCount} inheritance edges. Current total edges: ${edges.length}`);


    // --- (Optional: Step 5 - Build Call Hierarchy - Uncomment and use if needed) ---
    /*
    console.log('[SaralFlow Graph] Building Call Hierarchy (if supported)...');
    let callEdgesCount = 0;
    for (const [symbolNodeId, symbolNode] of nodeMap.entries()) {
        if ((symbolNode.kind === vscode.SymbolKind[vscode.SymbolKind.Method] || symbolNode.kind === vscode.SymbolKind[vscode.SymbolKind.Function] || symbolNode.kind === vscode.SymbolKind[vscode.SymbolKind.Constructor]) &&
            symbolNode.uri && symbolNode.range) {
            let successViaLSPCalls = false;
            // Removed provider check here, as it was causing compilation errors.
            // LSP calls will now always be attempted for these symbols after initial delay.
            try {
                const callableUri = vscode.Uri.parse(symbolNode.uri);
                const callablePosition = new vscode.Position(symbolNode.range.start.line, symbolNode.range.start.character);

                console.log(`[SaralFlow Graph] DEBUG: Querying Call Hierarchy via LSP for: ${symbolNode.label} (Kind: ${symbolNode.kind})`);

                const callHierarchyItems = await vscode.commands.executeCommand<vscode.CallHierarchyItem[]>(
                    'vscode.prepareCallHierarchy',
                    callableUri,
                    callablePosition
                );
                console.log(`[SaralFlow Graph] DEBUG: prepareCallHierarchy for "${symbolNode.label}" returned: ${callHierarchyItems ? callHierarchyItems.length + ' items' : 'null/undefined'}.`);

                if (callHierarchyItems && callHierarchyItems.length > 0) {
                    const callItem = callHierarchyItems[0];
                    console.log(`[SaralFlow Graph] DEBUG: prepareCallHierarchy successful for ${symbolNode.label}. Resolving outgoing calls...`);

                    const outgoingCalls = await vscode.commands.executeCommand<vscode.CallHierarchyOutgoingCall[]>(
                        'vscode.executeCallHierarchyOutgoingCalls',
                        callItem
                    );
                    console.log(`[SaralFlow Graph] DEBUG: executeCallHierarchyOutgoingCalls for "${symbolNode.label}" returned: ${outgoingCalls ? outgoingCalls.length + ' calls' : 'null/undefined'}.`);

                    if (outgoingCalls && outgoingCalls.length > 0) {
                        successViaLSPCalls = true;
                        outgoingCalls.forEach(call => {
                            const calleeUri = call.to.uri.toString();
                            const calleeSymbolId = findContainingSymbolId(calleeUri, call.to.selectionRange.start);
                            if (calleeSymbolId && nodeMap.has(calleeSymbolId) && calleeSymbolId !== symbolNodeId) {
                                const isDuplicateEdge = edges.some(e => e.from === symbolNodeId && e.to === calleeSymbolId && e.label === 'CALLS');
                                if (!isDuplicateEdge) {
                                    edges.push({
                                        from: symbolNodeId,
                                        to: calleeSymbolId,
                                        label: 'CALLS'
                                    });
                                    callEdgesCount++;
                                    console.log(`[SaralFlow Graph] DEBUG: Added CALLS edge (LSP) from ${symbolNode.label} to ${nodeMap.get(calleeSymbolId)?.label}`);
                                }
                            } else {
                                console.log(`[SaralFlow Graph] DEBUG: LSP Callee node for "${symbolNode.label}" not found/self: ${calleeSymbolId}`);
                            }
                        });
                    } else if (outgoingCalls === null || outgoingCalls === undefined || outgoingCalls.length === 0) {
                         console.log(`[SaralFlow Graph] DEBUG: LSP executeCallHierarchyOutgoingCalls returned empty/null/undefined for "${symbolNode.label}".`);
                    }
                } else if (callHierarchyItems === null || callHierarchyItems === undefined || callHierarchyItems.length === 0) {
                    console.log(`[SaralFlow Graph] DEBUG: LSP prepareCallHierarchy returned empty/null/undefined for "${symbolNode.label}".`);
                }
            } catch (e: any) {
                console.error(`[SaralFlow Graph] ERROR: LSP Call Hierarchy lookup failed for ${symbolNode.label} (${symbolNode.uri}): ${e.message}. Attempting fallback.`);
            }

            // --- Fallback for CALLS (basic regex/text search for function calls) ---
            // This would be highly heuristic and error-prone.
            // Only implement if LSP Call Hierarchy consistently fails AND you absolutely need some calls.
            // if (!successViaLSPCalls && symbolNode.kind !== 'File') {
            //     try {
            //         const document = await vscode.workspace.openTextDocument(vscode.Uri.parse(symbolNode.uri));
            //         const fileContent = document.getText();
            //         // This is a VERY simple regex. Real call parsing is complex.
            //         // It looks for symbolNode.label() or symbolNode.label.
            //         const callRegex = new RegExp(`\\b${symbolNode.label}\\s*\\(`, 'g');
            //         let match;
            //         while ((match = callRegex.exec(fileContent)) !== null) {
            //             const startPosition = document.positionAt(match.index);
            //             const fromNodeId = findContainingSymbolId(symbolNode.uri, startPosition);
            //             if (fromNodeId && nodeMap.has(fromNodeId) && fromNodeId !== symbolNodeId) {
            //                 const isDuplicateEdge = edges.some(e => e.from === fromNodeId && e.to === symbolNodeId && e.label === 'CALLS');
            //                 if (!isDuplicateEdge) {
            //                     edges.push({ from: fromNodeId, to: symbolNodeId, label: 'CALLS' });
            //                     callEdgesCount++;
            //                     console.log(`[SaralFlow Graph] DEBUG: Added CALLS edge (Fallback) from ${nodeMap.get(fromNodeId)?.label} to ${symbolNode.label}`);
            //                 }
            //             }
            //         }
            //     } catch (error: any) {
            //         console.error(`[SaralFlow Graph] ERROR: Fallback Call parsing failed for ${symbolNode.label}: ${error.message}`);
            //     }
            // }
        }
    }
    console.log(`[SaralFlow Graph] Finished building call hierarchy. Added ${callEdgesCount} call edges. Current total edges: ${edges.length}`);
    */


    console.log(`[SaralFlow Graph] Graph construction complete. Final nodes: ${nodes.length}, final edges: ${edges.length}`);
    return { nodes, edges };
}

async function processDocumentSymbols(
    document: vscode.TextDocument,
    symbols: vscode.DocumentSymbol[] | vscode.SymbolInformation[],
    graph: CodeGraph,
    parentNodeId: string
) {
    for (const symbol of symbols) {
        const nodeId = generateNodeId(document.uri, symbol); // This line is fine because SimpleSymbolInfo only needs 'name' and 'kind'

        // --- Determine the correct range and URI ---
        let symbolRange: vscode.Range;
        let symbolUri: vscode.Uri;

        if ('range' in symbol) { // This is true for vscode.DocumentSymbol
            symbolRange = symbol.range;
            symbolUri = document.uri; // DocumentSymbol doesn't have its own URI field, it's implicitly the document's URI
        } else { // This is true for vscode.SymbolInformation
            symbolRange = symbol.location.range;
            symbolUri = symbol.location.uri;
        }

        const nodeKind = toNodeKind(symbol.kind);

        graph.addNode({
            id: nodeId,
            label: symbol.name,
            kind: nodeKind,
            uri: symbolUri, // <-- Use the determined URI
            range: symbolRange, // <-- Use the determined range
            detail: 'detail' in symbol ? symbol.detail : undefined
        });

        graph.addEdge({
            sourceId: parentNodeId,
            targetId: nodeId,
            type: EdgeType.CONTAINS
        });

        // If it's a DocumentSymbol and has children, recurse
        // `DocumentSymbol` has `children`, `SymbolInformation` does not.
        if ('children' in symbol && symbol.children && symbol.children.length > 0) {
            await processDocumentSymbols(document, symbol.children, graph, nodeId);
        }
    }
}

async function fetchAndProcessCallHierarchy(document: vscode.TextDocument, node: GraphNode, graph: CodeGraph) {
    try {
        const callHierarchyItems: vscode.CallHierarchyItem[] | undefined = await vscode.commands.executeCommand(
            'vscode.executeCallHierarchyPrepare',
            node.uri,
            node.range.start
        );

        if (!callHierarchyItems || callHierarchyItems.length === 0) {
            return;
        }

        const callHierarchyItem = callHierarchyItems[0];

        const outgoingCalls: vscode.CallHierarchyOutgoingCall[] = await vscode.commands.executeCommand(
            'vscode.executeCallHierarchyOutgoingCalls',
            callHierarchyItem
        );

        for (const outgoingCall of outgoingCalls) {
            const targetNodeId = generateNodeId(outgoingCall.to.uri, outgoingCall.to);
            graph.addNode({
                id: targetNodeId,
                label: outgoingCall.to.name,
                kind: toNodeKind(outgoingCall.to.kind),
                uri: outgoingCall.to.uri,
                range: outgoingCall.to.range,
                detail: outgoingCall.to.detail
            });

            graph.addEdge({
                sourceId: node.id,
                targetId: targetNodeId,
                type: EdgeType.CALLS
            });
        }

        const incomingCalls: vscode.CallHierarchyIncomingCall[] = await vscode.commands.executeCommand(
            'vscode.executeCallHierarchyIncomingCalls',
            callHierarchyItem
        );

        for (const incomingCall of incomingCalls) {
            const sourceNodeId = generateNodeId(incomingCall.from.uri, incomingCall.from);
            graph.addNode({
                id: sourceNodeId,
                label: incomingCall.from.name,
                kind: toNodeKind(incomingCall.from.kind),
                uri: incomingCall.from.uri,
                range: incomingCall.from.range,
                detail: incomingCall.from.detail
            });

            graph.addEdge({
                sourceId: sourceNodeId,
                targetId: node.id,
                type: EdgeType.CALLED_BY
            });
        }

    } catch (error) {
        console.warn(`Could not fetch call hierarchy for ${node.label}:`, error);
    }
}