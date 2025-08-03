import * as vscode from 'vscode';
import * as path from 'path';
import pLimit from 'p-limit';

import { CodeGraph,  INode, IEdge } from './graphTypes'; 
import { getEmbedding, cosineSimilarity } from'./embeddingService';
import {extractSemanticGraph, rebuildFileReferences, processFileAndAddToGraph, removeFileNodesFromGraph, rebuildAffectedReferences} from './graphBuilder';


const DiffMatchPatch: any = require('diff-match-patch'); 
// Keep track of the last parsed changes to apply them
let lastProposedChanges: ProposedFileChange[] = [];
const limit = pLimit(10);
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
export let semanticGraph: CodeGraph = new CodeGraph();
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
            vscode.window.showInformationMessage(`SaralFlow: Graph build complete. Nodes: ${semanticGraph.nodes.size}, Edges: ${semanticGraph.edges.length}`);
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
        if (semanticGraph.nodes.size === 0) {
            vscode.window.showInformationMessage('SaralFlow: Graph is empty. Building now...');
            await vscode.commands.executeCommand('SaralFlow.buildGraphOnStartup'); // Build if empty
            if (semanticGraph.nodes.size === 0) {
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
                            // CORRECTED LINE: Convert Map to an array of values before sending
                            graphPanel.webview.postMessage({ 
                                command: 'renderGraph', 
                                nodes: Array.from(semanticGraph.nodes.values()), 
                                edges: semanticGraph.edges 
                            });
                        } else {
                            console.error("SaralFlow: Webview panel is not open. Cannot render graph.");
                        }
                        break; // Add break to prevent fall-through
                    case 'nodeClicked':
                        /* console.log('Node clicked in webview:', message.nodeId);
                        // Example: Open the document and highlight the range of the clicked node
                        const clickedNode = currentGraph.getNode(message.nodeId);
                        if (clickedNode) {
                            vscode.workspace.openTextDocument(clickedNode.uri).then(document => {
                                vscode.window.showTextDocument(document, { selection: clickedNode.range, preview: true, preserveFocus: true });
                            }).then(undefined, err => {
                                console.error('Error opening document for clicked node:', err);
                                vscode.window.showErrorMessage(`Could not open document for ${clickedNode.label}: ${err.message}`);
                            });
                        }*/
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
        if (semanticGraph.nodes.size === 0) {
            vscode.window.showInformationMessage('SaralFlow: Graph is empty. Building now...');
            await vscode.commands.executeCommand('SaralFlow.buildGraphOnStartup');
            if (semanticGraph.nodes.size === 0) {
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
        const maxSnippets = 10; // Limit the number of snippets for LLM prompt size

        for (const node of relevantNodes) {
            if (snippetCount >= maxSnippets) {break;}

            const snippet = await getCodeSnippet(node);
            if (snippet.trim() !== '' && !snippet.startsWith('// Error retrieving') && !snippet.startsWith('// No code snippet')) {
                contextForLLM += `// File: ${vscode.workspace.asRelativePath(vscode.Uri.parse(node.uri))}\n`;
                contextForLLM += `// Element: ${node.label} (Kind: ${node.kind})\n`;
                contextForLLM += `// ID: ${node.id}\n`;
                contextForLLM += `\`\`\`${node.uri.endsWith('.cs') ? 'csharp' : node.uri.endsWith('.ts') ? 'typescript':  node.uri.endsWith('.sql') ? 'sql' :  node.uri.endsWith('.py') ? 'python' : 'plaintext'}\n`;
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


    context.subscriptions.push(vscode.commands.registerCommand('SaralFlow.proposeCodeFromStory', async () => {
        if (!semanticGraph || semanticGraph.nodes.size === 0) {
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

    // Create a status bar item
    const memGraphStatusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 90);
    memGraphStatusBarItem.text = `$(robot) SaralGraph`;
    memGraphStatusBarItem.tooltip = 'Show Graph';
    memGraphStatusBarItem.command = 'SaralFlow.showGraph'; // Link to the new command
    memGraphStatusBarItem.show();
    context.subscriptions.push(memGraphStatusBarItem);
    

    // Add a file system watcher for code files
    const codeFileWatcher = vscode.workspace.createFileSystemWatcher('**/*.{ts,tsx,js,jsx,cs,py,sql,yaml}', false, false, false);
    context.subscriptions.push(codeFileWatcher);

    let graphUpdateTimeout: NodeJS.Timeout | undefined;

    const debouncedGraphUpdate = (uri: vscode.Uri) => {
        if (graphUpdateTimeout) {
            clearTimeout(graphUpdateTimeout);
        }
        graphUpdateTimeout = setTimeout(async () => {
            vscode.window.showInformationMessage(`SaralFlow: File change detected in ${vscode.workspace.asRelativePath(uri)}. Updating graph...`);
            
            // Step 1: Remove all nodes and edges for the old version of the file and get the removed edges.
            const removedEdges = removeFileNodesFromGraph(uri);
            
            // Step 2: Process the file and add the new nodes and internal ('CONTAINS') edges.
            const newNodesInFile = await processFileAndAddToGraph(uri);

            // Step 3: Rebuild relationships only for the affected nodes (removed and newly added).
            await rebuildAffectedReferences(removedEdges, newNodesInFile);
            
            // Step 4: Optional - update the webview if it's open
            if (graphPanel) {
                graphPanel.webview.postMessage({
                    command: 'renderGraph',
                    nodes: semanticGraph.nodes,
                    edges: semanticGraph.edges
                });
            }
            
            vscode.window.showInformationMessage('SaralFlow: Graph update complete.');
        }, 4000); // 2-second debounce
    };

    // Listen for file changes, creations, and deletions
    codeFileWatcher.onDidChange(debouncedGraphUpdate);
    codeFileWatcher.onDidCreate(debouncedGraphUpdate);
    codeFileWatcher.onDidDelete(async (uri) => {
        vscode.window.showInformationMessage(`SaralFlow: File deleted: ${vscode.workspace.asRelativePath(uri)}. Updating graph...`);
        // Immediately remove deleted file's nodes without debounce
        await removeFileNodesFromGraph(uri);
        vscode.window.showInformationMessage('SaralFlow: Graph update complete.');
});
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

    // Iterate over the nodes map to find initial matches
    for (const [nodeId, node] of semanticGraph.nodes.entries()) {
        let isMatch = false;
        let similarityScore = 0;

        // Keyword Match: Search in label, kind, id, and URI
        if (node.label.toLowerCase().includes(lowerCaseQuery) ||
            node.kind.toLowerCase().includes(lowerCaseQuery) ||
            node.id.toLowerCase().includes(lowerCaseQuery) ||
            node.uri.toLowerCase().includes(lowerCaseQuery))
        {
            isMatch = true;
        }

        // Semantic Match: Use pre-computed embedding
        if (queryEmbedding && node.embedding) {
            similarityScore = cosineSimilarity(queryEmbedding, node.embedding);
            if (similarityScore >= similarityThreshold) {
                console.log(`[SaralFlow Graph] Semantic match: Node "${node.label}" (Kind: ${node.kind}), Score: ${similarityScore.toFixed(3)}`);
                isMatch = true;
            }
        }

        if (isMatch && !visitedNodes.has(node.id)) {
            relevantNodes.push(node);
            visitedNodes.add(node.id);
            queue.push({ nodeId: node.id, depth: 0 }); // Start traversal from this node
        }
    }

    // --- Phase 2: Graph Traversal (BFS) ---
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
                // Use Map.get() for efficient O(1) lookup
                const connectedNode = semanticGraph.nodes.get(edge.to);
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
                // Use Map.get() for efficient O(1) lookup
                const connectedNode = semanticGraph.nodes.get(edge.from);
                if (connectedNode) {
                    relevantNodes.push(connectedNode);
                    visitedNodes.add(connectedNode.id);
                    queue.push({ nodeId: connectedNode.id, depth: depth + 1 });
                }
            }
        }
    }

    // Optional: Sort nodes for consistent output
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
    // Check if the semantic graph is initialized and has nodes
    if (!semanticGraph || semanticGraph.nodes.size === 0) { 
        return []; 
    }

    const relevantNodes: { node: INode, score: number }[] = [];
    const topN = 10; // Number of top relevant nodes to include as context

    // Iterate over the values of the Map
    for (const node of semanticGraph.nodes.values()) {
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
            prompt += `\`\`\`code\n${content}\n\`\`\`\n\n`;
        }
    } else {
        prompt += "No relevant code context could be found or provided.\n\n";
    }

    prompt += "--- Proposed Changes ---\n\n";
    prompt += "For each file to be created or modified, provide its full relative path and its complete, modified content within a C# markdown block. Use `--- START FILE: <relative/path/to/file.cs> ---` and `--- END FILE: <relative/path/to/file.cs> ---` markers.\n";
    prompt += "After all file changes, provide a clear 'Explanation:' section detailing the overall approach and how the user can apply the changes using the interactive webview. For example, explain that the user can edit the code directly and use the 'Apply' buttons.\n\n";

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
    prompt += "These changes are designed to work with the interactive webview. Once you have made any necessary edits to the code directly in the provided text areas, you can use the 'Apply All Changes' or 'Apply Selected Changes' buttons to apply the modifications directly to your workspace.\n\n";

    return prompt;
}


async function callLLM(prompt: string, apiKey: string): Promise<string> {


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
                case 'applySelectedChanges':
                    const selectedChanges = message.changes as ProposedFileChange[];
                    if (selectedChanges && selectedChanges.length > 0) {
                        await applyCodeChanges(selectedChanges);
                    } else {
                        vscode.window.showWarningMessage('No selected changes to apply.');
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

function getCodeViewContent(webview: vscode.Webview, extensionUri: vscode.Uri) {
    // Local path to main script run in the webview
    const scriptPathOnDisk = vscode.Uri.joinPath(extensionUri, 'codeview', 'main.js');
    const markedScriptPathOnDisk = vscode.Uri.joinPath(extensionUri, 'codeview', 'marked.min.js'); 
    const stylePathOnDisk = vscode.Uri.joinPath(extensionUri, 'codeview', 'styles.css');


    // And the uri to the script and style for the webview
    const scriptUri = webview.asWebviewUri(scriptPathOnDisk);
    const markedUri = webview.asWebviewUri(markedScriptPathOnDisk);
    const styleUri = webview.asWebviewUri(stylePathOnDisk);

    // Prism.js URIs for syntax highlighting
    const prismCssUri = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'codeview', 'prism.css'));
    const prismJsUri = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'codeview', 'prism.js'));
    const prismSQLUri = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'codeview', 'prism-sql.min.js'));
    const prismCsharpUri = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'codeview', 'prism-csharp.min.js'));
   
    // Use a nonce to only allow a specific script to be run.
    const nonce = getNonce();

    return `<!DOCTYPE html>
            <html lang="en">
            <head>
                <meta charset="UTF-8">
                <meta name="viewport" content="width=device-width, initial-scale=1.0">
                <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';">
                <link href="${styleUri}" rel="stylesheet">
                <!-- Add Prism.js CSS for a dark theme -->
                <link href="${prismCssUri}" rel="stylesheet">
                <title>SaralFlow Code Generator</title>
            </head>
            <body>
                <h1>SaralFlow: Story to Code</h1>
                <p>Describe the feature or change you want to implement:</p>
                <textarea id="userStory" rows="10" cols="60" placeholder="e.g., 'As a user, I want to add a new API endpoint that lists all products with a 'special' tag.'"></textarea>
                <br>
                <button id="generateButton">Generate Code</button>
                <hr>
                <div id="loadingMessage" class="hidden">
                    <div class="loading-spinner"></div>
                    <p>Generating Code Changes... Please wait.</p>
                </div>
                <h2>Proposed Code Change:</h2>
                <div id="result"></div>
                
                <script nonce="${nonce}" src="${markedUri}"></script>
                <!-- Add Prism.js script to enable highlighting -->
                <script nonce="${nonce}" src="${prismJsUri}"></script>
                <script nonce="${nonce}" src="${prismSQLUri}"></script>
                <script nonce="${nonce}" src="${prismCsharpUri}"></script>
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

/**
 * Parses the LLM response into structured changes and a final explanation.
 * This version is corrected to handle file markers and content directly,
 * without relying on markdown code blocks.
 *
 * @param llmResponse The raw string response from the LLM.
 * @returns A promise that resolves to the parsed LLM response.
 */
export async function parseLLMResponse(llmResponse: string): Promise<ParsedLLMResponse> {
    const fileChanges: ProposedFileChange[] = [];
    let explanation = '';
    const lines = llmResponse.split('\n');
    let currentFilePath: string | null = null;
    let currentContent: string[] = [];
    let parsingExplanation = false;

    // These markers are expected from the LLM
    const startFileMarker = '--- START FILE: ';
    const endFileMarker = '--- END FILE: ';
    const explanationStart = 'Explanation:';
    const codeBlockRegex = /^\s*```.*/;

    for (const line of lines) {
        const trimmedLine = line.trim();

        // Skip lines that are just code block markers
        if (codeBlockRegex.test(trimmedLine)) {
            continue;
        }

        if (trimmedLine.startsWith(startFileMarker)) {
            // A new file marker was found. If we were previously parsing a file, save it.
            if (currentFilePath !== null) {
                fileChanges.push({
                    filePath: currentFilePath,
                    content: currentContent.join('\n').trim(),
                    isNewFile: false
                });
            }
            
            // Start parsing the new file
            currentFilePath = trimmedLine.substring(startFileMarker.length).trim();
            // Remove the trailing ' ---' if it exists.
            if (currentFilePath.endsWith(' ---')) {
                currentFilePath = currentFilePath.substring(0, currentFilePath.length - 4).trim();
            }

            currentContent = [];
            parsingExplanation = false; 
        } else if (trimmedLine.startsWith(endFileMarker)) {
            // End of a file marker. Save the content.
            if (currentFilePath !== null) {
                fileChanges.push({
                    filePath: currentFilePath,
                    content: currentContent.join('\n').trim(),
                    isNewFile: false
                });
            }
            currentFilePath = null; // Clear the current file path
            currentContent = [];
        } else if (trimmedLine.startsWith(explanationStart)) {
            // Found the start of the explanation block
            parsingExplanation = true;
            explanation = trimmedLine.substring(explanationStart.length).trim() + '\n';
            // Stop parsing file content if explanation begins
            currentFilePath = null;
            currentContent = [];
        } else if (parsingExplanation) {
            // Append lines to the explanation
            explanation += line + '\n';
        } else if (currentFilePath !== null) {
            // Collect file content
            currentContent.push(line);
        }
    }

    // Final check for any remaining content if parsing ended abruptly
    if (currentFilePath !== null && currentContent.length > 0) {
        fileChanges.push({
            filePath: currentFilePath,
            content: currentContent.join('\n').trim(),
            isNewFile: false
        });
    }

    // Now, determine `isNewFile` based on actual file existence using a robust method
    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (workspaceFolders && workspaceFolders.length > 0) {
        const rootPath = workspaceFolders[0].uri.fsPath;
        for (const change of fileChanges) {
            const fullPath = path.join(rootPath, change.filePath);
            const fileUri = vscode.Uri.file(fullPath);

            try {
                // Use await to check for file existence
                await vscode.workspace.fs.stat(fileUri);
                // If stat succeeds, the file exists
                change.isNewFile = false;
            } catch (err: any) {
                // If stat throws an error, the file doesn't exist
                change.isNewFile = true;
            }
        }
    }
    
    return { fileChanges, explanation: explanation.trim() };
}

// This is the unified function to apply code changes using diff-match-patch
async function applyCodeChanges(changesToApply: ProposedFileChange[]) {
    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (!workspaceFolders || workspaceFolders.length === 0) {
        vscode.window.showErrorMessage('No workspace folder open to apply changes.');
        return;
    }
    const rootPath = workspaceFolders[0].uri.fsPath;
    const dmp = new DiffMatchPatch();

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

