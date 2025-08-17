import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { CodeGraph,  INode } from './graphTypes'; 
import { getEmbeddingViaCloudFunction, cosineSimilarity } from'./embeddingService';
import {extractSemanticGraph, removeFileNodesFromGraph, reEmbedGraphNodes, statToken, graphBuildInProgress, pendingFileChanges} from './graphBuilder';
const config = vscode.workspace.getConfiguration('saralflow');

const generateCodeFunctionUrl = config.get<string>('cloudFunctions.generateCodeUrl') 
                                     || 'https://us-central1-saralflowapis.cloudfunctions.net/generateCode';

const DiffMatchPatch: any = require('diff-match-patch'); 
// Declare panel globally so it can be reused or disposed
let graphPanel: vscode.WebviewPanel | undefined = undefined;
let codeViewPanel: vscode.WebviewPanel | undefined = undefined;
let extensionContext: vscode.ExtensionContext;
// Global variable to store the built graph
export let semanticGraph: CodeGraph = new CodeGraph();
let isGraphBuilding = false;
// Global variable to store the Firebase ID Token received from the webview
export let firebaseIdToken: string | null = null;
let firebaseTokenPromiseResolve: ((value: string) => void) | null = null;
// Create a status bar item for SaralFlow
const saralCodeStatusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 90);


// Define the expected structure of the Cloud Function's response for generateCode
interface GenerateCodeResponse {
    success: boolean;
    text?: string; // Content for successful code generation
    error?: string; // Error message if success is false
}

export function activate(vsContext: vscode.ExtensionContext) {
    extensionContext = vsContext;

    // Check for a previously saved Firebase token immediately on startup
    const checkTokenOnStartup = async () => {
        const storedToken = await extensionContext.secrets.get('firebaseIdToken');
        if (storedToken) {
            firebaseIdToken = storedToken;
            if (firebaseTokenPromiseResolve) {
                firebaseTokenPromiseResolve(firebaseIdToken);
            }
            console.log('SaralFlow: Found a stored Firebase token on startup.');
        } else {
            console.log('SaralFlow: No stored Firebase token found.');
        }
    };
    checkTokenOnStartup();

    
    saralCodeStatusBarItem.text = `$(robot) Saralflow`;
    saralCodeStatusBarItem.tooltip = 'Show Saral flow';
    saralCodeStatusBarItem.command = 'SaralFlow.openGenerator';
    saralCodeStatusBarItem.show();
    extensionContext.subscriptions.push(saralCodeStatusBarItem);

    

    // *** Initial Graph Building on Activation ***
    let buildGraphDisposable = vscode.commands.registerCommand('SaralFlow.buildGraphOnStartup', async () => {
        if (isGraphBuilding) {
            vscode.window.showInformationMessage('SaralFlow: Graph build already in progress.');
            return;
        }
        isGraphBuilding = true;
        console.log('[SaralFlow] Initial graph build triggered.');
        try {
            await buildGraphWithStatus(); // Uses progress updates

            // If a panel is already open, update it
            if (graphPanel) {
                graphPanel.webview.postMessage({
                    command: 'renderGraph',
                    nodes: semanticGraph.nodes,
                    edges: semanticGraph.edges
                });
            }
        } finally {
            isGraphBuilding = false;
        }
    });
    extensionContext.subscriptions.push(buildGraphDisposable);

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
            await vscode.commands.executeCommand('SaralFlow.buildGraphOnStartup');
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
            'saralFlowGraph',
            'SaralFlow Code Semantic Graph',
            vscode.ViewColumn.Two,
            {
                enableScripts: true,
                retainContextWhenHidden: true,
                localResourceRoots: [vscode.Uri.joinPath(extensionContext.extensionUri, 'dist', 'webview')]
            }
        );

        const htmlPath = vscode.Uri.joinPath(extensionContext.extensionUri, 'dist', 'webview', 'index.html');
        const htmlContent = (await vscode.workspace.fs.readFile(htmlPath)).toString();

        const styleUri = graphPanel.webview.asWebviewUri(vscode.Uri.joinPath(extensionContext.extensionUri, 'dist', 'webview', 'style.css'));
        const scriptUri = graphPanel.webview.asWebviewUri(vscode.Uri.joinPath(extensionContext.extensionUri, 'dist', 'webview', 'main.js'));
        const visNetworkScriptUri = graphPanel.webview.asWebviewUri(vscode.Uri.joinPath(extensionContext.extensionUri, 'dist', 'webview', 'vis-network.min.js'));

        const cspSource = graphPanel.webview.cspSource;

        let finalHtml = htmlContent
            .replace(/{{cspSource}}\/style.css/g, styleUri.toString())
            .replace(/{{cspSource}}\/main.js/g, scriptUri.toString())
            .replace(/{{cspSource}}\/vis-network.min.js/g, visNetworkScriptUri.toString());

        finalHtml = finalHtml.replace(/{{cspSource}}/g, cspSource);
        graphPanel.webview.html = finalHtml;

        graphPanel.webview.onDidReceiveMessage(
            async message => {
                switch (message.command) {
                    case 'webviewReady':
                        if (graphPanel) {
                            graphPanel.webview.postMessage({
                                command: 'renderGraph',
                                nodes: Array.from(semanticGraph.nodes.values()),
                                edges: semanticGraph.edges
                            });
                        }
                        break;
                }
            },
            undefined,
            extensionContext.subscriptions
        );

        graphPanel.onDidDispose(() => {
            graphPanel = undefined;
        }, null, extensionContext.subscriptions);
    });
    extensionContext.subscriptions.push(showGraphCommand);

    // Query graph command
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
        const maxSnippets = 10;

        for (const node of relevantNodes) {
            if (snippetCount >= maxSnippets) {break;}
            const snippet = await getCodeSnippet(node);
            if (snippet.trim() !== '' && !snippet.startsWith('// Error retrieving') && !snippet.startsWith('// No code snippet')) {
                contextForLLM += `// File: ${vscode.workspace.asRelativePath(vscode.Uri.parse(node.uri))}\n`;
                contextForLLM += `// Element: ${node.label} (Kind: ${node.kind})\n`;
                contextForLLM += `// ID: ${node.id}\n`;
                contextForLLM += `\`\`\`${node.uri.endsWith('.cs') ? 'csharp' : node.uri.endsWith('.ts') ? 'typescript': node.uri.endsWith('.sql') ? 'sql' : node.uri.endsWith('.py') ? 'python' : 'plaintext'}\n`;
                contextForLLM += snippet;
                contextForLLM += `\n\`\`\`\n\n`;
                snippetCount++;
            }
        }

        if (snippetCount === 0) {
            vscode.window.showInformationMessage(`SaralFlow: No usable code snippets found for "${query}".`);
            return;
        }

        const outputChannel = vscode.window.createOutputChannel('SaralFlow LLM Context');
        outputChannel.appendLine(contextForLLM);
        outputChannel.show(true);

        vscode.window.showInformationMessage(`SaralFlow: Context generated for "${query}" (see "SaralFlow LLM Context" output).`);
    });
    extensionContext.subscriptions.push(queryGraphCommand);

    // Command to propose code from a story
    extensionContext.subscriptions.push(vscode.commands.registerCommand('SaralFlow.proposeCodeFromStory', async () => {
        if (!semanticGraph || semanticGraph.nodes.size === 0) {
            vscode.window.showWarningMessage('SaralFlow: Graph not built or is empty. Please build the graph first.');
            return;
        }

        const userStory = await vscode.window.showInputBox({
            prompt: 'Describe the feature or change you want to implement (User Story)',
            placeHolder: 'e.g., "As a user, I want to add a new API endpoint that lists all products with a special tag."',
            ignoreFocusOut: true,
        });

        if (!userStory) {return;}
        await proposeCodeFromStory(userStory);
    }));

    // Open generator command
    extensionContext.subscriptions.push(vscode.commands.registerCommand('SaralFlow.openGenerator', () => {
        openSaralFlowWebview(extensionContext.extensionUri);
    }));

    // File system watcher for incremental updates
    const codeFileWatcher = vscode.workspace.createFileSystemWatcher('**/*.{ts,tsx,js,jsx,cs,py,sql,yaml}', false, false, false);
    extensionContext.subscriptions.push(codeFileWatcher);

    let graphUpdateTimeout: NodeJS.Timeout | undefined;
    const changedUris = new Set<vscode.Uri>();

    const debouncedGraphUpdate = (uri: vscode.Uri) => {
        if (graphBuildInProgress) {
            // Initial build still running → buffer this change
            pendingFileChanges.add(uri);
            return;
        }

        changedUris.add(uri);
        if (graphUpdateTimeout) {
            clearTimeout(graphUpdateTimeout);
        }
        graphUpdateTimeout = setTimeout(async () => {
            const urisToProcess = Array.from(changedUris);
            console.log(`[SaralFlow Graph] Debounce triggered. Processing ${urisToProcess.length} files.`);
            await buildGraphWithStatus(urisToProcess);
            changedUris.clear();

            if (graphPanel) {
            graphPanel.webview.postMessage({
                command: 'renderGraph',
                nodes: semanticGraph.nodes,
                edges: semanticGraph.edges
            });
            }
        }, 4000);
    };

    codeFileWatcher.onDidChange(debouncedGraphUpdate);
    codeFileWatcher.onDidCreate(debouncedGraphUpdate);
    codeFileWatcher.onDidDelete(async (uri) => {
        await removeFileNodesFromGraph(uri);
    });
}


// Helper to run a graph build with status bar progress updates
export async function buildGraphWithStatus(filesToProcess?: vscode.Uri[]) {
    try {
        saralCodeStatusBarItem.text = "$(sync~spin) Saralflow: Starting...";
        saralCodeStatusBarItem.tooltip = "Building semantic graph...";

        semanticGraph = await extractSemanticGraph(filesToProcess, (msg) => {
            saralCodeStatusBarItem.text = `$(sync~spin) Saralflow: ${msg}`;
            saralCodeStatusBarItem.tooltip = msg;
        });

        saralCodeStatusBarItem.text = "$(check) Saralflow";
        saralCodeStatusBarItem.tooltip = "Graph build complete";
    } catch (e: any) {
        saralCodeStatusBarItem.text = "$(error) Saralflow";
        saralCodeStatusBarItem.tooltip = "Graph build failed";
        vscode.window.showErrorMessage(`SaralFlow: Graph build failed: ${e.message}`);
        console.error(`[SaralFlow] Graph build failed: ${e.message}`);
    } finally {
        setTimeout(() => {
            saralCodeStatusBarItem.text = "$(robot) Saralflow";
            saralCodeStatusBarItem.tooltip = "Show Saral flow";
        }, 4000);
    }
}


export function deactivate() {
    // Dispose of the file system watcher when the extension deactivates
    // (This is implicitly handled by context.subscriptions.push(sqlWatcher) in activate)
}


async function querySemanticGraph(queryText: string, maxDepth: number = 2, similarityThreshold: number = 0.7): Promise<INode[]> {
    const lowerCaseQuery = queryText.toLowerCase();
    const visitedNodes = new Set<string>();
    const relevantNodes: INode[] = [];
    const queue: { nodeId: string, depth: number }[] = [];

    // --- Get embedding for the query text using the Cloud Function ---
    /*if (!firebaseIdToken) {
        vscode.window.showErrorMessage('SaralFlow: Firebase login required to query semantic graph (missing ID token).');
        return [];
    }*/
    const queryEmbedding = await getEmbeddingViaCloudFunction(queryText, statToken);

    if (!queryEmbedding) {
        vscode.window.showErrorMessage('SaralFlow: Failed to generate embedding for the query. Cannot perform semantic search.');
        return [];
    }

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

async function proposeCodeFromStory(userStory: string) {
    if (!semanticGraph || !codeViewPanel) {
        vscode.window.showErrorMessage('SaralFlow: Semantic Graph is not built or Webview not active.');
        return;
    }

    if (!userStory) {
        vscode.window.showErrorMessage('User story cannot be empty.');
        codeViewPanel?.webview.postMessage({ command: 'showError', text: 'User story cannot be empty.' });
        return;
    }

    // Ensure Firebase ID token is available
    if (!firebaseIdToken) {
        vscode.window.showErrorMessage('Please log in first.');
        codeViewPanel?.webview.postMessage({ command: 'showError', text: 'Please log in first.' });
        return;
    }

    codeViewPanel.webview.postMessage({ command: 'showLoading' });
    codeViewPanel.webview.postMessage({ command: 'clearResults' }); // Clear previous results

    try {
        let relevantFileContents: { filePath: string; content: string }[] = [];

        // --- Use getEmbeddingViaCloudFunction for story embedding ---
        const storyEmbedding = await getEmbeddingViaCloudFunction(userStory, statToken);

        if (!storyEmbedding) {
            vscode.window.showErrorMessage('SaralFlow: Failed to embedd story.');
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

        // Convert Map to an array of objects as expected by the Cloud Function
        relevantFileContents = Array.from(fileContentsMap.entries()).map(([filePath, content]) => ({
            filePath: filePath,
            content: content
        }));

        const response = await fetch(generateCodeFunctionUrl, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${firebaseIdToken}`
            },
            body: JSON.stringify({
                userStory: userStory,
                relevantFileContents: relevantFileContents
            })
        });

        if (!response.ok) {
            const errorText = await response.text();
            throw new Error(`Cloud Function error: ${response.status} - ${errorText}`);
        }

        const result = await response.json() as GenerateCodeResponse; // Type assertion here

        if (result.success && result.text) { // Now TypeScript knows 'success' and 'text' exist
            // Extract the text from the response and then parse it
            const llmResponseText = result.text;
            const parsedResult = await parseLLMResponse(llmResponseText); // Pass the text content

            codeViewPanel?.webview.postMessage({
                command: 'displayParsedResult',
                explanation: parsedResult.explanation,
                fileChanges: parsedResult.fileChanges,
            });
        }
        else {
            throw new Error(result.error || 'Unknown error from Cloud Function.');
        }

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

function openSaralFlowWebview(extensionUri: vscode.Uri) {
    // If a panel already exists, just reveal it
    if (codeViewPanel) {
        codeViewPanel.reveal(vscode.ViewColumn.Beside);
        return;
    }
    codeViewPanel = vscode.window.createWebviewPanel(
        'saralFlowGenerator', // type
        'SaralFlow : Story to Code', // title
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
                 case 'firebaseToken':
                    firebaseIdToken = message.token;
                    if (firebaseIdToken) {
                        extensionContext.secrets.store('firebaseIdToken', firebaseIdToken);
                        if (firebaseTokenPromiseResolve) {
                            firebaseTokenPromiseResolve(firebaseIdToken);
                        }
                    } else {
                        extensionContext.secrets.delete('firebaseIdToken');
                    }
                    console.log('Firebase ID Token received by extension.');
                    await reEmbedGraphNodes();
                    break;

                case 'generateCode':
                    // We need to ensure proposeCodeFromStory also handles codeViewPanel potentially being undefined
                    // if this callback gets invoked after the panel has been disposed.
                    try {

                        codeViewPanel.webview.postMessage({ command: 'showLoading' });
                        await reEmbedGraphNodes(); 
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
                case 'applySelectedChanges':
                    const selectedChanges = message.changes as ProposedFileChange[];
                    if (selectedChanges && selectedChanges.length > 0) {
                        await applyCodeChanges(selectedChanges);
                    } else {
                        vscode.window.showWarningMessage('No selected changes to apply.');
                    }
                    break;
                case 'showDiff':
                    const leftUri = vscode.Uri.file(path.join(vscode.workspace.rootPath || '', message.filePath));
                    const rightDoc = await vscode.workspace.openTextDocument({ content: message.newContent, language:message.language });
                    const rightUri = rightDoc.uri;
                    vscode.commands.executeCommand('vscode.diff', leftUri, rightUri, `Preview Diff: ${message.filePath}`);
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
    const htmlPathOnDisk = vscode.Uri.joinPath(extensionUri, 'codeview', 'index.html'); // Path to the new HTML file

    // And the uri to the script and style for the webview
    const scriptUri = webview.asWebviewUri(scriptPathOnDisk);
    const markedUri = webview.asWebviewUri(markedScriptPathOnDisk);
    const styleUri = webview.asWebviewUri(stylePathOnDisk);

    // Prism.js URIs for syntax highlighting
    const prismCssUri = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'codeview', 'prism.css'));
    const prismJsUri = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'codeview', 'prism.js'));
    const prismSQLUri = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'codeview', 'prism-sql.min.js'));
    const prismCsharpUri = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'codeview', 'prism-csharp.min.js'));
    const prismPythonUri = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'codeview', 'prism-python.min.js'));

    // Firebase SDK URIs
    const firebaseAppUri = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'codeview', 'firebase-app-compat.js'));
    const firebaseAuthUri = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'codeview', 'firebase-auth-compat.js'));
    
    // Read the HTML content
    const htmlContent = fs.readFileSync(htmlPathOnDisk.fsPath, 'utf8');

    // Use a nonce to only allow a specific script to be run.
    const nonce = getNonce();

    const finalHtml = htmlContent
        .replace(/\{\{styleUri\}\}/g, styleUri.toString())
        .replace(/\{\{prismCssUri\}\}/g, prismCssUri.toString())
        .replace(/\{\{firebaseAppUri\}\}/g, firebaseAppUri.toString())
        .replace(/\{\{firebaseAuthUri\}\}/g, firebaseAuthUri.toString())
        .replace(/\{\{markedUri\}\}/g, markedUri.toString())
        .replace(/\{\{prismJsUri\}\}/g, prismJsUri.toString())
        .replace(/\{\{prismSQLUri\}\}/g, prismSQLUri.toString())
        .replace(/\{\{prismCsharpUri\}\}/g, prismCsharpUri.toString())
        .replace(/\{\{prismPythonUri\}\}/g, prismPythonUri.toString())
        .replace(/\{\{scriptUri\}\}/g, scriptUri.toString())
        .replace(/\{\{nonce\}\}/g, nonce)
        .replace(/\{\{webview\.cspSource\}\}/g, webview.cspSource);

    return finalHtml;
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
    let explanationLines: string[] = [];
    const lines = llmResponse.split('\n');
    let currentFilePath: string | null = null;
    let currentContent: string[] = [];
    let parsingExplanation = false;

    // These markers are expected from the LLM
    const startFileMarker = '--- START FILE: ';
    const endFileMarker = '--- END FILE: ';
    const explanationStart = '--- Explanation:';
    const explanationEnd = '--- END EXPLANATION ---'; // New marker for the end of the explanation
    const codeBlockRegex = /^\s*```.*/;

    for (const line of lines) {
        const trimmedLine = line.trim();

        // Skip lines that are just code block markers
        if (codeBlockRegex.test(trimmedLine)) {
            continue;
        }

        // Check for the explanation marker first, as it can appear anywhere
        const explanationIndex = line.indexOf(explanationStart);
        if (explanationIndex !== -1 && currentFilePath === null) {
            // Found the start of the explanation block
            parsingExplanation = true;
            // Capture the text after the explanation marker on the same line
            const firstLineOfExplanation = line.substring(explanationIndex + explanationStart.length).trim();
            if (firstLineOfExplanation.length > 0) {
                explanationLines.push(firstLineOfExplanation);
            }
            continue;
        }

        if (parsingExplanation) {
            if (trimmedLine === explanationEnd) {
                parsingExplanation = false;
                continue;
            }
            // Append lines to the explanation, but only if they are not blank
            if (line.trim().length > 0) {
                explanationLines.push(line);
            }
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
    
    return { fileChanges, explanation: explanationLines.join('\n').trim() };
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

    if (success && codeViewPanel) {
        codeViewPanel.webview.postMessage({ command: 'changesApplied' });
        vscode.window.showInformationMessage('SaralFlow: Code changes applied successfully!');
    }  
    else {
        vscode.window.showErrorMessage('SaralFlow: Failed to apply code changes.');
    }
}
