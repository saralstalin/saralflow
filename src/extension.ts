// src/extension.ts
import * as vscode from 'vscode';
import * as path from 'path'; // Import the 'path' module
import { CodeGraph, GraphNode, GraphEdge, INode, IEdge, NodeKind, EdgeType, generateNodeId, toNodeKind } from './graphTypes'; 
import { getEmbedding, cosineSimilarity } from'./embeddingService';
import fetch from 'node-fetch';
const DiffMatchPatch: any = require('diff-match-patch'); 
import pLimit from 'p-limit';

// Keep track of the last parsed changes to apply them
let lastProposedChanges: ProposedFileChange[] = [];
const limit = pLimit(10);

import {extractSemanticGraph, processDocumentSymbols, fetchAndProcessCallHierarchy} from './graphBuilder';

let currentGraph: CodeGraph = new CodeGraph(); // Our in-memory graph instance
// Declare panel globally so it can be reused or disposed
let graphPanel: vscode.WebviewPanel | undefined = undefined;

let codeViewPanel: vscode.WebviewPanel | undefined = undefined;

let extensionContext: vscode.ExtensionContext;

// Define the structure for the embedding API response
interface EmbeddingResponse {
    data: { embedding: number[] }[];
    // Other fields might be present depending on the API
}

// Global variable to store the built graph
let semanticGraph: { nodes: INode[]; edges: IEdge[] } = { nodes: [], edges: [] };
let isGraphBuilding = false;

// IMPORTANT: Replace with your actual OpenAI API key for chat completions
// For a production extension, store this securely in VS Code settings.
const OPENAI_CHAT_API_KEY = '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';

// IMPORTANT: Replace with your actual OpenAI API key for embeddings (can be the same as chat)
const OPENAI_EMBEDDING_API_KEY = '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';

// Function to retrieve the API Key
export function getApiKey(): string {
  const apiKey = OPENAI_EMBEDDING_API_KEY;
  return apiKey;
}

// Global variable to store the embedded schema chunks for the current workspace
// This will act as our in-memory vector store.
let cachedSchemaChunks: { text: string, embedding: number[] }[] = [];
let isSchemaLoading = false; // Flag to prevent concurrent loading

// Global variable to store the resolved base URI for SQL files (e.g., the 'dbo' folder)
let sqlFilesBaseUri: vscode.Uri | undefined;


export function activate(context: vscode.ExtensionContext) {
    extensionContext = context;

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

    // Create a status bar item
    const memGraphStatusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 90);
    memGraphStatusBarItem.text = `$(robot) SaralGraph`;
    memGraphStatusBarItem.tooltip = 'Show Graph';
    memGraphStatusBarItem.command = 'SaralFlow.showGraph'; // Link to the new command
    memGraphStatusBarItem.show();
    context.subscriptions.push(memGraphStatusBarItem);

    
    // *** Initial Graph Building on Activation ***
    let buildGraphDisposable = vscode.commands.registerCommand('SaralFlow.buildGraphOnStartup', async () => {
        if (isGraphBuilding) {
            vscode.window.showInformationMessage('SaralFlow: Graph build already in progress.');
            return;
        }
        isGraphBuilding = true;
        vscode.window.showInformationMessage('SaralFlow: Starting initial graph build...');
        console.log('[SaralFlow] Initial graph build triggered.');
        try {
            semanticGraph = await extractSemanticGraph(); // Build and store the graph
            vscode.window.showInformationMessage(`SaralFlow: Graph build complete. Nodes: ${semanticGraph.nodes.length}, Edges: ${semanticGraph.edges.length}`);
            console.log('[SaralFlow] Initial graph build complete.');

            // If a panel is already open, update it
            if (graphPanel) {
                graphPanel.webview.postMessage({
                    command: 'renderGraph',
                    nodes: semanticGraph.nodes,
                    edges: semanticGraph.edges
                });
            }

        } catch (e: any) {
            vscode.window.showErrorMessage(`SaralFlow: Graph build failed: ${e.message}`);
            console.error(`[SaralFlow] Initial graph build failed: ${e.message}`);
        } finally {
            isGraphBuilding = false;
        }
    });
    context.subscriptions.push(buildGraphDisposable);

    // Call the graph building command immediately after activation
    vscode.commands.executeCommand('SaralFlow.buildGraphOnStartup');
    // *** End Initial Graph Building ***


    // Command to show the built graph in the webview
    let showGraphCommand = vscode.commands.registerCommand('SaralFlow.showGraph', async () => {
        if (isGraphBuilding) {
            vscode.window.showInformationMessage('SaralFlow: Graph build in progress. Please wait.');
            return;
        }
        if (semanticGraph.nodes.length === 0) {
            vscode.window.showInformationMessage('SaralFlow: Graph is empty. Building now...');
            await vscode.commands.executeCommand('SaralFlow.buildGraphOnStartup'); // Build if empty
            if (semanticGraph.nodes.length === 0) {
                 vscode.window.showWarningMessage('SaralFlow: Graph could not be built. Please check logs.');
                 return;
            }
        }

        const column = vscode.window.activeTextEditor
            ? vscode.window.activeTextEditor.viewColumn
            : undefined;

        if (graphPanel) {
            graphPanel.dispose();
        } 
        graphPanel = vscode.window.createWebviewPanel(
            'saralFlowGraph', // Identifies the type of the webview. Used internally
            'SaralFlow Code Semantic Graph', // Title of the panel displayed to the user
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
        const styleUri = graphPanel.webview.asWebviewUri(vscode.Uri.joinPath(context.extensionUri, 'dist', 'webview', 'style.css'));
        const scriptUri = graphPanel.webview.asWebviewUri(vscode.Uri.joinPath(context.extensionUri, 'dist', 'webview', 'main.js'));
        const visNetworkScriptUri = graphPanel.webview.asWebviewUri(vscode.Uri.joinPath(context.extensionUri, 'dist', 'webview', 'vis-network.min.js')); // <--- THIS LINE

        // Get the Content Security Policy (CSP) source value for 'self' and VS Code specific origins.
        // This is used for the <meta http-equiv="Content-Security-Policy"> tag.
        const cspSource = graphPanel.webview.cspSource;

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

        // Set the HTML content for the webview
        graphPanel.webview.html = finalHtml;


        // Handle messages received from the webview (e.g., 'webviewReady', 'nodeClicked')
        graphPanel.webview.onDidReceiveMessage(
            async message => {
                switch (message.command) {
                    case 'webviewReady':
                        if (graphPanel) { 
                                graphPanel.webview.postMessage({ command: 'renderGraph', nodes: semanticGraph.nodes, edges: semanticGraph.edges });
                        }
                        else
                        {
                                console.error("SaralFlow: Webview panel is not open. Cannot render graph.");
                        }
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

        // Reset when the current panel is closed
        graphPanel.onDidDispose(() => {
            graphPanel = undefined;
        }, null, context.subscriptions);
      
    });
    context.subscriptions.push(showGraphCommand);

    // NEW: Command to query the graph based on a story/keyword
    let queryGraphCommand = vscode.commands.registerCommand('SaralFlow.queryGraphForLLM', async () => {
        if (isGraphBuilding) {
            vscode.window.showInformationMessage('SaralFlow: Graph build in progress. Please wait.');
            return;
        }
        if (semanticGraph.nodes.length === 0) {
            vscode.window.showInformationMessage('SaralFlow: Graph is empty. Building now...');
            await vscode.commands.executeCommand('SaralFlow.buildGraphOnStartup');
            if (semanticGraph.nodes.length === 0) {
                 vscode.window.showWarningMessage('SaralFlow: Graph could not be built. Please check logs.');
                 return;
            }
        }

        const query = await vscode.window.showInputBox({
            prompt: 'Enter a keyword or phrase related to the story/code change:',
            placeHolder: 'e.g., "user authentication", "product management", "BadBoys class"'
        });

        if (!query) {
            vscode.window.showInformationMessage('SaralFlow: Query cancelled.');
            return;
        }

        vscode.window.showInformationMessage(`SaralFlow: Querying graph for "${query}"...`);
        const relevantNodes = await querySemanticGraph(query, 2, 0.7);

        if (relevantNodes.length === 0) {
            vscode.window.showInformationMessage(`SaralFlow: No relevant code elements found for "${query}".`);
            return;
        }

        let contextForLLM = `// Relevant code context for "${query}"\n\n`;
        let snippetCount = 0;
        const maxSnippets = 5; // Limit the number of snippets for LLM prompt size

        for (const node of relevantNodes) {
            if (snippetCount >= maxSnippets) {break;}

            const snippet = await getCodeSnippet(node);
            if (snippet.trim() !== '' && !snippet.startsWith('// Error retrieving') && !snippet.startsWith('// No code snippet')) {
                contextForLLM += `// File: ${vscode.workspace.asRelativePath(vscode.Uri.parse(node.uri))}\n`;
                contextForLLM += `// Element: ${node.label} (Kind: ${node.kind})\n`;
                contextForLLM += `// ID: ${node.id}\n`;
                contextForLLM += `\`\`\`${node.uri.endsWith('.cs') ? 'csharp' : node.uri.endsWith('.ts') ? 'typescript' : 'plaintext'}\n`;
                contextForLLM += snippet;
                contextForLLM += `\n\`\`\`\n\n`;
                snippetCount++;
            }
        }

        if (snippetCount === 0) {
             vscode.window.showInformationMessage(`SaralFlow: No usable code snippets found for "${query}".`);
             return;
        }

        // Display the context in an output channel or new document
        const outputChannel = vscode.window.createOutputChannel('SaralFlow LLM Context');
        outputChannel.appendLine(contextForLLM);
        outputChannel.show(true); // Show the output channel

        vscode.window.showInformationMessage(`SaralFlow: Context generated for "${query}" (see "SaralFlow LLM Context" output).`);
    });
    context.subscriptions.push(queryGraphCommand);

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

    context.subscriptions.push(vscode.commands.registerCommand('SaralFlow.proposeCodeFromStory', async () => {
        if (!semanticGraph || semanticGraph.nodes.length === 0) {
            vscode.window.showWarningMessage('SaralFlow: Graph not built or is empty. Please build the graph first.');
            return;
        }

        const userStory = await vscode.window.showInputBox({
            prompt: 'Describe the feature or change you want to implement (User Story)',
            placeHolder: 'e.g., "As a user, I want to add a new API endpoint that lists all products with a special tag."',
            ignoreFocusOut: true,
        });

        if (!userStory) { return; }

        await proposeCodeFromStory(userStory);
    }));

    // New Command to open the Webview
    context.subscriptions.push(vscode.commands.registerCommand('SaralFlow.openGenerator', () => {
        openSaralFlowWebview(context.extensionUri);
    }));

    // Create a status bar item
    const saralCodeStatusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 90);
    saralCodeStatusBarItem.text = `$(robot) SaralCode`;
    saralCodeStatusBarItem.tooltip = 'Show Saral Code';
    saralCodeStatusBarItem.command = 'SaralFlow.openGenerator'; // Link to the new command
    saralCodeStatusBarItem.show();
    context.subscriptions.push(saralCodeStatusBarItem);

    // Add a status bar item for quick access to the SQL Generator
    const sqlStatusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 90);
    sqlStatusBarItem.text = `$(flame) SaralFlow`;
    sqlStatusBarItem.tooltip = 'Open SaralFlow Code Generator';
    sqlStatusBarItem.command = 'SaralFlow.openSqlGenerator'; // Link to the new command
    sqlStatusBarItem.show();
    context.subscriptions.push(sqlStatusBarItem);
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
        const dboFolders = await vscode.workspace.findFiles('**/dbo', '**/node_modules/**', 1);

        if (dboFolders.length > 0) {
            sqlFilesBaseUri = dboFolders[0];
            vscode.window.showInformationMessage(`Found SQL base folder: ${sqlFilesBaseUri.fsPath}`);
        } else if (vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders.length > 0) {
            sqlFilesBaseUri = vscode.workspace.workspaceFolders[0].uri;
            vscode.window.showWarningMessage('Could not find a "dbo" folder. Assuming SQL files are relative to workspace root.');
        } else {
            vscode.window.showErrorMessage('No workspace folder open. Cannot load SQL context.');
            isSchemaLoading = false;
            return;
        }

        const sqlFiles = await vscode.workspace.findFiles('**/*.sql', '**/node_modules/**', 100);

        if (sqlFiles.length === 0) {
            vscode.window.showInformationMessage('No .sql files found in the workspace for context. The generator will proceed without schema context.');
            isSchemaLoading = false;
            return;
        }

        const relevantSqlFiles = sqlFiles.filter(fileUri => fileUri.fsPath.startsWith(sqlFilesBaseUri!.fsPath));

        if (relevantSqlFiles.length === 0) {
            vscode.window.showInformationMessage('No relevant .sql files found under the determined SQL base folder.');
            isSchemaLoading = false;
            return;
        }

        vscode.window.showInformationMessage(`Found ${relevantSqlFiles.length} relevant .sql files for context. Generating embeddings... This might take a moment.`);
        
        let allChunks: { text: string; fileUri: vscode.Uri }[] = [];
        for (const fileUri of relevantSqlFiles) {
            try {
                const fileContent = await vscode.workspace.fs.readFile(fileUri);
                const sqlText = new TextDecoder().decode(fileContent);
                
                // Chunking logic remains the same
                const chunks = sqlText.split(/(CREATE TABLE|ALTER TABLE|CREATE PROCEDURE|ALTER PROCEDURE|INSERT INTO|UPDATE|DELETE FROM)\s/gi)
                                     .filter(chunk => chunk.trim().length > 0)
                                     .map((chunk, index, arr) => {
                                        if (index > 0 && arr[index - 1].match(/^(CREATE TABLE|ALTER TABLE|CREATE PROCEDURE|ALTER PROCEDURE|INSERT INTO|UPDATE|DELETE FROM)$/i)) {
                                            return arr[index - 1] + ' ' + chunk;
                                        }
                                        return chunk;
                                     })
                                     .filter(chunk => chunk.trim().length > 0);

                for (const chunk of chunks) {
                    allChunks.push({ text: chunk, fileUri: fileUri });
                }
            } catch (readError: any) {
                console.warn(`Could not process file ${fileUri.fsPath}: ${readError.message}`);
            }
        }
        
        // --- THIS IS THE NEW PARALLEL EMBEDDING SECTION ---
        
        // 1. Create an array of Promises for each embedding call
        const embeddingPromises = allChunks.map(chunkInfo => 
            getEmbedding(chunkInfo.text, OPENAI_EMBEDDING_API_KEY)
                .then(embedding => ({ text: chunkInfo.text, embedding })) // Attach the original chunk text to the result
        );

        // 2. Wait for all promises to resolve in parallel
        const results = await Promise.all(embeddingPromises);

        // 3. Filter out any failed embedding calls (where embedding is undefined)
        cachedSchemaChunks = results.filter(result => result.embedding !== undefined) as { text: string; embedding: number[] }[];
        
        // --- END OF NEW SECTION ---
        
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

// New or modified querySemanticGraph function
async function querySemanticGraph(queryText: string, maxDepth: number = 2, similarityThreshold: number = 0.7): Promise<INode[]> {
    const lowerCaseQuery = queryText.toLowerCase();
    const visitedNodes = new Set<string>();
    const relevantNodes: INode[] = [];
    const queue: { nodeId: string, depth: number }[] = [];

    
    // --- Get embedding for the query text ---
    const queryEmbedding = await getEmbedding(queryText, OPENAI_EMBEDDING_API_KEY);
    

    // --- Phase 1: Semantic & Keyword Matching (Seed Nodes) ---
    console.log(`[SaralFlow Graph] Starting semantic and keyword matching for query "${queryText}".`);
    for (const node of semanticGraph.nodes) {
        let isMatch = false;
        let similarityScore = 0;

        // Keyword Match
        if (node.label.toLowerCase().includes(lowerCaseQuery) ||
            node.kind.toLowerCase().includes(lowerCaseQuery) ||
            node.id.toLowerCase().includes(lowerCaseQuery) ||
            node.uri.toLowerCase().includes(lowerCaseQuery))
        {
            isMatch = true;
        }

        // Semantic Match (only if an embedding was successfully generated for the query)
        if (queryEmbedding && node.label) { // Use node.detail or a combination of label/kind/snippet for embedding
            // Generate embedding for node's text. You might want to cache these embeddings for performance.
            // For first run, generate on-the-fly. For production, consider storing them.
            const nodeTextForEmbedding = `${node.kind} ${node.label} || ''}`; // Combine relevant text
            const nodeEmbedding = node.embedding;

            if (nodeEmbedding) {
                similarityScore = cosineSimilarity(queryEmbedding, nodeEmbedding);
                if (similarityScore >= similarityThreshold) {
                    console.log(`[SaralFlow Graph] Semantic match: Node "${node.label}" (Kind: ${node.kind}), Score: ${similarityScore.toFixed(3)}`);
                    isMatch = true; // Mark as match if similarity is high
                }
            }
        }

        if (isMatch && !visitedNodes.has(node.id)) {
            relevantNodes.push(node);
            visitedNodes.add(node.id);
            queue.push({ nodeId: node.id, depth: 0 }); // Start traversal from this node
        }
    }

    // --- Phase 2: Graph Traversal (BFS) (remains mostly the same) ---
    console.log(`[SaralFlow Graph] Starting graph traversal for query "${queryText}" with maxDepth ${maxDepth}. Initial nodes: ${relevantNodes.length}`);

    let head = 0;
    while (head < queue.length) {
        const { nodeId, depth } = queue[head++];

        if (depth >= maxDepth) {
            continue;
        }

        // Find connected nodes via outgoing edges
        const outgoingEdges = semanticGraph.edges.filter(edge => edge.from === nodeId);
        for (const edge of outgoingEdges) {
            if (!visitedNodes.has(edge.to)) {
                const connectedNode = semanticGraph.nodes.find(n => n.id === edge.to);
                if (connectedNode) {
                    relevantNodes.push(connectedNode);
                    visitedNodes.add(connectedNode.id);
                    queue.push({ nodeId: connectedNode.id, depth: depth + 1 });
                }
            }
        }

        // Find connected nodes via incoming edges
        const incomingEdges = semanticGraph.edges.filter(edge => edge.to === nodeId);
        for (const edge of incomingEdges) {
            if (!visitedNodes.has(edge.from)) {
                const connectedNode = semanticGraph.nodes.find(n => n.id === edge.from);
                if (connectedNode) {
                    relevantNodes.push(connectedNode);
                    visitedNodes.add(connectedNode.id);
                    queue.push({ nodeId: connectedNode.id, depth: depth + 1 });
                }
            }
        }
    }

    // Optional: Sort nodes for consistent output (already present)
    relevantNodes.sort((a, b) => {
        if (a.uri !== b.uri) {
            return a.uri.localeCompare(b.uri);
        }
        if (a.range && b.range) {
            return a.range.start.line - b.range.start.line;
        }
        return 0;
    });

    console.log(`[SaralFlow Graph] Finished query. Found ${relevantNodes.length} relevant nodes.`);
    return relevantNodes;
}


// NEW: Function to get code snippet from a node
async function getCodeSnippet(node: INode): Promise<string> {
    if (!node.uri || !node.range) {
        return `// No code snippet available for ${node.label} (missing URI or range).\n`;
    }

    try {
        const uri = vscode.Uri.parse(node.uri);
        const document = await vscode.workspace.openTextDocument(uri);
        const start = new vscode.Position(node.range.start.line, node.range.start.character);
        const end = new vscode.Position(node.range.end.line, node.range.end.character);
        const range = new vscode.Range(start, end);

        // Get the full text of the lines covered by the range
        // For C# methods/classes, the range often includes the curly braces
        return document.getText(range);
    } catch (error: any) {
        console.error(`[SaralFlow Graph] Error getting code snippet for ${node.label}: ${error.message}`);
        return `// Error retrieving code snippet for ${node.label}: ${error.message}\n`;
    }
}


// Updated proposeCodeFromStory to send result to webview
async function proposeCodeFromStory(userStory: string) {
    if (!semanticGraph || !codeViewPanel) {
        vscode.window.showErrorMessage('SaralFlow: Graph not built or Webview not active.');
        return;
    }

    codeViewPanel.webview.postMessage({ command: 'showLoading' });
    codeViewPanel.webview.postMessage({ command: 'clearResults' }); // Clear previous results

    try {
       
        if (!OPENAI_CHAT_API_KEY) {
            vscode.window.showErrorMessage('SaralFlow: API Key is required to call the LLM. Please set it first.');
            codeViewPanel.webview.postMessage({ command: 'showError', text: 'API Key is required.' });
            return;
        }

        const storyEmbedding = await getEmbedding(userStory, OPENAI_EMBEDDING_API_KEY);

        if (!storyEmbedding) {
            vscode.window.showErrorMessage('SaralFlow: Failed to generate embedding for the story. Please check your API key and try again.');
            codeViewPanel.webview.postMessage({ command: 'showError', text: 'Failed to generate query embedding.' });
            return;
        }

        const relevantNodes = findRelevantNodesByStory(storyEmbedding);

        // Step 2: Fetch full file content for relevant nodes
        const fileContentsMap = new Map<string, string>(); // Map of file path to its full content
        const workspaceFolders = vscode.workspace.workspaceFolders;
        if (workspaceFolders && workspaceFolders.length > 0) {
            const rootPath = workspaceFolders[0].uri.fsPath;
            for (const node of relevantNodes) {
                const relativeFilePath = vscode.workspace.asRelativePath(vscode.Uri.parse(node.uri));
                const fullFilePath = path.join(rootPath, relativeFilePath);
                try {
                    // Read the file content
                    const fileUri = vscode.Uri.file(fullFilePath);
                    const fileBuffer = await vscode.workspace.fs.readFile(fileUri);
                    const fileContent = Buffer.from(fileBuffer).toString('utf8');
                    fileContentsMap.set(relativeFilePath, fileContent);
                } catch (error) {
                    console.warn(`SaralFlow: Could not read file ${relativeFilePath} for context: ${error}`);
                    // If we can't read the file, perhaps still provide the node.codeSnippet as fallback context
                    if (node.codeSnippet) {
                        fileContentsMap.set(relativeFilePath, node.codeSnippet); // Fallback: use just the snippet
                    }
                }
            }
        }

        const prompt = createStoryPrompt(userStory, fileContentsMap);

        const llmResponse = await callLLM(prompt, OPENAI_CHAT_API_KEY);

        // Parse the LLM response into structured changes and the explanation
        const { fileChanges, explanation } = await parseLLMResponse(llmResponse);
        lastProposedChanges = fileChanges; // Store for application

        // Send the result back to the webview
        codeViewPanel.webview.postMessage({
            command: 'displayParsedResult',
            fileChanges: fileChanges,
            explanation: explanation
        });

        vscode.window.showInformationMessage('SaralFlow: Code generation complete.');

    } catch (error: any) {
        vscode.window.showErrorMessage(`SaralFlow: Failed to generate code: ${error.message}`);
        console.error(`SaralFlow: Code generation failed: ${error.message}`);
        codeViewPanel.webview.postMessage({ command: 'showError', text: `Error: ${error.message}` });
    } finally {
        codeViewPanel.webview.postMessage({ command: 'hideLoading' });
    }
}

function findRelevantNodesByStory(storyEmbedding: number[]): INode[] {
    if (!semanticGraph) { return []; }

    const relevantNodes: { node: INode, score: number }[] = [];
    const topN = 10; // Number of top relevant nodes to include as context

    for (const node of semanticGraph.nodes) {
        if (node.embedding) {
            const similarity = cosineSimilarity(storyEmbedding, node.embedding);
            relevantNodes.push({ node, score: similarity });
        }
    }

    relevantNodes.sort((a, b) => b.score - a.score);

    return relevantNodes.slice(0, topN).map(r => r.node);
}

// Updated createStoryPrompt signature to accept the map
function createStoryPrompt(userStory: string, relevantFileContents: Map<string, string>): string {
    let prompt = "You are an expert software developer. Your task is to implement a new feature or change based on a user story and provided code context. Your response should contain markdown code blocks, each representing the *full content* of a file that needs to be created or modified. Use explicit markers for each file. After all code blocks, provide a brief markdown explanation of how to apply the changes.\n\n";

    prompt += `**User Story:**\n${userStory}\n\n`;

    if (relevantFileContents.size > 0) {
        prompt += "**Relevant Code Context (Full File Contents):**\n";
        for (const [filePath, content] of relevantFileContents.entries()) {
            prompt += `--- Context File: ${filePath} ---\n`;
            prompt += `\`\`\`csharp\n${content}\n\`\`\`\n\n`;
        }
    } else {
        prompt += "No relevant code context could be found or provided.\n\n";
    }

    prompt += "--- Proposed Changes ---\n\n";
    prompt += "For each file to be created or modified, provide its full relative path and its complete, modified content within a C# markdown block. Use `--- START FILE: <relative/path/to/file.cs> ---` and `--- END FILE: <relative/path/to/file.cs> ---` markers.\n";
    prompt += "After all file changes, provide a clear 'Explanation:' section detailing the overall approach and how to integrate the changes.\n\n";

    prompt += "Example Output Format:\n\n";
    prompt += "```\n";
    prompt += "--- START FILE: src/NewFeature/NewService.cs ---\n";
    prompt += "```csharp\n";
    prompt += "// Full content of the new file\n";
    prompt += "public class NewService { /* ... */ }\n";
    prompt += "```\n";
    prompt += "--- END FILE: src/NewFeature/NewService.cs ---\n\n";
    prompt += "--- START FILE: src/Existing/ExistingController.cs ---\n";
    prompt += "```csharp\n";
    prompt += "// Full content of the existing file, with your modifications merged in\n";
    prompt += "public class ExistingController { /* ... modified code ... */ }\n";
    prompt += "```\n";
    prompt += "--- END FILE: src/Existing/ExistingController.cs ---\n\n";
    prompt += "Explanation:\n";
    prompt += "This change introduces NewService.cs and updates ExistingController.cs to use it...\n";

    return prompt;
}

// (The `callLLM` function remains the same)

async function displayLLMResponseAsNewFile(llmResponse: string) {
    const doc = await vscode.workspace.openTextDocument({ content: llmResponse, language: 'markdown' });
    await vscode.window.showTextDocument(doc, vscode.ViewColumn.Beside);
}

async function callLLM(prompt: string, apiKey: string): Promise<string> {
    // This is a simplified example. You'll need to use an actual library like 'openai' or 'ollama'
    // This function should be in your `embeddingService.ts` or a new `llmService.ts`.

    // Assuming you're using OpenAI's chat completion API
    const { OpenAI } = require('openai'); // Make sure 'openai' is installed
    const openai = new OpenAI({ apiKey: apiKey });

    try {
        const response = await openai.chat.completions.create({
            model: "gpt-4o-mini", // Or gpt-4, gpt-3.5-turbo, etc.
            messages: [{
                role: "system",
                content: "You are an expert software developer. Your task is to propose a code change based on a user request and provided code context. Your response should be a markdown code block containing the proposed code, followed by a brief markdown explanation of the change."
            }, {
                role: "user",
                content: prompt
            }],
            temperature: 0.1, // Keep it low for more deterministic code
        });
        
        return response.choices[0]?.message?.content || "No response from LLM.";
    } catch (error: any) {
        throw new Error(`LLM API call failed: ${error.message}`);
    }
}


// This function is responsible for creating and managing the webview panel
function openSaralFlowWebview(extensionUri: vscode.Uri) {
    // If a panel already exists, just reveal it
    if (codeViewPanel) {
        codeViewPanel.reveal(vscode.ViewColumn.Beside);
        return;
    }

    // *** THIS IS THE CRITICAL PART ***
    // codeViewPanel is assigned here. After this line, within this function,
    // TypeScript knows it's no longer undefined.
    codeViewPanel = vscode.window.createWebviewPanel(
        'saralFlowGenerator', // type
        'SaralFlow Code Generator', // title
        vscode.ViewColumn.Beside, // column
        {
            enableScripts: true,
            localResourceRoots: [vscode.Uri.joinPath(extensionUri, 'codeview')], // Ensure this is correct,
            retainContextWhenHidden: true
        }
    );

    // Set the HTML content
    codeViewPanel.webview.html = getCodeViewContent(codeViewPanel.webview, extensionUri);

    // Attach the message listener to the newly created and *definitely defined* panel
    codeViewPanel.webview.onDidReceiveMessage(
        async message => {
            if (!codeViewPanel || !codeViewPanel.webview) {
                console.warn('[Extension] Message received after codeViewPanel was disposed. Skipping.');
                return; // Exit the function gracefully
            }
            switch (message.command) {
                case 'generateCode':
                    // We need to ensure proposeCodeFromStory also handles codeViewPanel potentially being undefined
                    // if this callback gets invoked after the panel has been disposed.
                    try {

                        codeViewPanel.webview.postMessage({ command: 'showLoading' });
                        await proposeCodeFromStory(message.text);
                    }
                    catch (error) {
                        // Step 4: If an error occurs, send an error message to the webview
                        let errorMessage = 'Failed to generate code: An unknown error occurred.';
                        if (error instanceof Error)
                        {
                          errorMessage = `Failed to generate code: ${error.message}`;
                        }
                        console.error('[Extension] An error occurred during LLM generation.', error);
                        codeViewPanel.webview.postMessage({
                            command: 'showError',
                            text: errorMessage,
                        });
                    }
                    finally{
                        codeViewPanel.webview.postMessage({ command: 'hideLoading' });
                    }
                    
                    break; // Use break, not return, if you have more cases after this
                case 'applyAllChanges':
                    if (lastProposedChanges.length > 0) {
                        await applyCodeChanges(lastProposedChanges);
                    } else {
                        vscode.window.showWarningMessage('No proposed changes to apply.');
                    }
                    break;
            }
        },
        undefined, // This 'thisArg' is optional
        extensionContext.subscriptions // Crucial for clean up
    );

    // Set up cleanup when the panel is closed by the user
    codeViewPanel.onDidDispose(() => {
        codeViewPanel = undefined; // Set it back to undefined when disposed
    }, null, extensionContext.subscriptions);
}

// Helper to get the HTML content for the Webview
function getCodeViewContent(webview: vscode.Webview, extensionUri: vscode.Uri) {
    // Local path to main script run in the webview
    const scriptPathOnDisk = vscode.Uri.joinPath(extensionUri, 'codeview', 'main.js');
    const markedScriptPathOnDisk = vscode.Uri.joinPath(extensionUri, 'codeview', 'marked.min.js'); 
    const stylePathOnDisk = vscode.Uri.joinPath(extensionUri, 'codeview', 'styles.css');

    // And the uri to the script and style for the webview
    const scriptUri = webview.asWebviewUri(scriptPathOnDisk);
    const markedUri = webview.asWebviewUri(markedScriptPathOnDisk);
    const styleUri = webview.asWebviewUri(stylePathOnDisk);

    // Use a nonce to only allow a specific script to be run.
    const nonce = getNonce();

    return `<!DOCTYPE html>
            <html lang="en">
            <head>
                <meta charset="UTF-8">
                <meta name="viewport" content="width=device-width, initial-scale=1.0">
                <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';">
                <link href="${styleUri}" rel="stylesheet">
                <title>SaralFlow Code Generator</title>
            </head>
            <body>
                <h1>SaralFlow: Story to Code</h1>
                <p>Describe the feature or change you want to implement:</p>
                <textarea id="userStory" rows="10" cols="60" placeholder="e.g., 'As a user, I want to add a new API endpoint that lists all products with a 'special' tag.'"></textarea>
                <br>
                <button id="generateButton">Generate Code</button>
                <hr>
                <h2>Proposed Code Change:</h2>
                <!-- CRITICAL CHANGE: Removed the inline style and added a 'hidden' class. -->
                <div id="loadingMessage" class="hidden">Generating Code Changes... Please wait.</div>
                <div id="result"></div>

                <script nonce="${nonce}" src="${markedUri}"></script>
                <script nonce="${nonce}" src="${scriptUri}"></script>
            </body>
            </html>`;
}


// Utility to generate a nonce for Content Security Policy
function getNonce() {
    let text = '';
    const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    for (let i = 0; i < 32; i++) {
        text += possible.charAt(Math.floor(Math.random() * possible.length));
    }
    return text;
}

// NEW: Function to parse LLM response into structured changes and explanation
interface ProposedFileChange {
    filePath: string;
    content: string; // The full proposed content of the file
    isNewFile: boolean;
}

interface ParsedLLMResponse {
    fileChanges: ProposedFileChange[];
    explanation: string;
}

async function parseLLMResponse(llmResponse: string): Promise<ParsedLLMResponse> {
    const fileChanges: ProposedFileChange[] = [];
    let explanation = '';
    const lines = llmResponse.split('\n');
    let currentFilePath: string | null = null;
    let currentContent: string[] = [];
    let inCodeBlock = false;
    let parsingExplanation = false;

    const startFileMarker = '--- START FILE: ';
    const endFileMarker = '--- END FILE: ';
    const codeBlockStart = '```csharp'; // Assuming C#
    const codeBlockEnd = '```';
    const explanationStart = 'Explanation:';

    for (const line of lines) {
        if (line.startsWith(startFileMarker)) {
            if (inCodeBlock && currentFilePath) {
                // If we were in a code block and hit a new file marker, save the previous one
                fileChanges.push({
                    filePath: currentFilePath,
                    content: currentContent.join('\n'),
                    isNewFile: true // Assume new for now, will differentiate later
                });
            }
            currentFilePath = line.substring(startFileMarker.length, line.indexOf(' ---', startFileMarker.length)).trim();
            currentContent = [];
            inCodeBlock = false; // Reset code block flag
            parsingExplanation = false; // Stop parsing explanation if a new file starts
        } else if (line.startsWith(endFileMarker)) {
            if (currentFilePath && currentContent.length > 0) {
                fileChanges.push({
                    filePath: currentFilePath,
                    content: currentContent.join('\n'),
                    isNewFile: false // Will determine this later by checking if file exists
                });
            }
            currentFilePath = null;
            currentContent = [];
            inCodeBlock = false; // Ensure we are out of code block
        } else if (line.trim() === codeBlockStart.trim()) {
            inCodeBlock = true;
        } else if (line.trim() === codeBlockEnd.trim()) {
            inCodeBlock = false;
        } else if (line.startsWith(explanationStart)) {
            parsingExplanation = true;
            explanation = line.substring(explanationStart.length).trim() + '\n';
        } else if (parsingExplanation) {
            explanation += line + '\n';
        } else if (inCodeBlock && currentFilePath !== null) {
            currentContent.push(line);
        }
    }

    // A final check in case the LLM doesn't end with --- END FILE ---
    if (currentFilePath && currentContent.length > 0) {
        fileChanges.push({
            filePath: currentFilePath,
            content: currentContent.join('\n'),
            isNewFile: false // Default to false, check real file system later
        });
    }

    // Now, determine isNewFile based on actual file existence
    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (workspaceFolders && workspaceFolders.length > 0) {
        const rootPath = workspaceFolders[0].uri.fsPath;
        for (const change of fileChanges) {
            const fullPath = path.join(rootPath, change.filePath);
            const fileExists = vscode.workspace.fs.stat(vscode.Uri.file(fullPath)).then(
                () => true,
                (err) => err.code === 'FileNotFound' ? false : true // Treat other errors as file existing for safety
            );
            change.isNewFile = !(await fileExists); // Mark as new if it doesn't exist
        }
    }
    
    return { fileChanges, explanation: explanation.trim() };
}


async function applyCodeChanges(changesToApply: ProposedFileChange[]) {
    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (!workspaceFolders || workspaceFolders.length === 0) {
        vscode.window.showErrorMessage('No workspace folder open to apply changes.');
        return;
    }
    const rootPath = workspaceFolders[0].uri.fsPath;
    const dmp = new DiffMatchPatch(); // Try this first

    const edit = new vscode.WorkspaceEdit();
    let filesOpenedCount = 0;

    for (const change of changesToApply) {
        const fullPath = path.join(rootPath, change.filePath);
        const fileUri = vscode.Uri.file(fullPath);

        if (change.isNewFile) {
            edit.createFile(fileUri, { ignoreIfExists: false });
            edit.insert(fileUri, new vscode.Position(0, 0), change.content);
            vscode.window.showInformationMessage(`Proposed new file: ${change.filePath}`);
            filesOpenedCount++;
        } else {
            try {
                const existingDoc = await vscode.workspace.openTextDocument(fileUri);
                const originalText = existingDoc.getText();
                const proposedText = change.content;

                const diffs = dmp.diff_main(originalText, proposedText);
                dmp.diff_cleanupSemantic(diffs);

                let currentOffset = 0;
                for (const diff of diffs) {
                    const type = diff[0]; // -1: deletion, 0: equality, 1: insertion
                    const text = diff[1];

                    // --- CHANGE THESE LINES ---
                    if (type === 0) { // Equivalent to dmp.DIFF_EQUAL
                        currentOffset += text.length;
                    } else if (type === 1) { // Equivalent to dmp.DIFF_INSERT
                        const startPos = existingDoc.positionAt(currentOffset);
                        edit.insert(fileUri, startPos, text);
                    } else if (type === -1) { // Equivalent to dmp.DIFF_DELETE
                        const startPos = existingDoc.positionAt(currentOffset);
                        const endPos = existingDoc.positionAt(currentOffset + text.length);
                        edit.delete(fileUri, new vscode.Range(startPos, endPos));
                        currentOffset += text.length;
                    }
                }
                vscode.window.showInformationMessage(`Proposed changes to: ${change.filePath}`);
                filesOpenedCount++;

            } catch (error: any) {
                vscode.window.showErrorMessage(`Failed to prepare changes for ${change.filePath}: ${error.message}`);
                console.error(`Error preparing diff for ${change.filePath}: ${error.message}`);
                continue;
            }
        }
    }

    if (filesOpenedCount === 0) {
        vscode.window.showWarningMessage('No changes to apply or no files could be processed.');
        return;
    }

    // Apply the combined edit
    const success = await vscode.workspace.applyEdit(edit);

    if (success) {
        vscode.window.showInformationMessage('SaralFlow: Code changes applied successfully!');
        // Optional: Open all modified/new files in editor
        for (const change of changesToApply) {
            const fullPath = path.join(rootPath, change.filePath);
            const fileUri = vscode.Uri.file(fullPath);
            try {
                const doc = await vscode.workspace.openTextDocument(fileUri);
                await vscode.window.showTextDocument(doc, { preview: false, preserveFocus: false });
            } catch (e) {
                console.warn(`Could not open file ${change.filePath}: ${e}`);
            }
        }
    } else {
        vscode.window.showErrorMessage('SaralFlow: Failed to apply code changes.');
    }
}

