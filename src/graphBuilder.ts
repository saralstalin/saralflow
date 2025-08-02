import * as vscode from 'vscode';
import * as path from 'path';
import {CodeGraph, INode, IEdge, EdgeType, toNodeKind, generateNodeId,  ISemanticGraph, NodeKind  } from './graphTypes';
import { getEmbedding } from './embeddingService';
import { getApiKey, semanticGraph } from './extension';



/**
 * Extracts a complete semantic graph from the workspace, now returning a CodeGraph instance.
 */
export async function extractSemanticGraph(): Promise<CodeGraph> {
    const graph = new CodeGraph(); // Create a new CodeGraph instance
    const processedFiles = new Set<string>();
    let apiKey: string | undefined;
    try {
        apiKey = await getApiKey();
    } catch (e) {
        console.error(`[SaralFlow Graph] Failed to retrieve API Key: ${e}`);
        apiKey = undefined;
    }
    const useEmbeddings = !!apiKey;
    if (!useEmbeddings) {
        vscode.window.showWarningMessage('SaralFlow Graph: API Key not set. Node embeddings will not be generated. Semantic similarity search will be limited or unavailable.');
        console.warn('[SaralFlow Graph] API Key not available. Embeddings will not be generated.');
    } else {
        console.log('[SaralFlow Graph] API Key available. Embeddings will be generated.');
    }
    if (!vscode.workspace.workspaceFolders || vscode.workspace.workspaceFolders.length === 0) {
        vscode.window.showInformationMessage('No workspace folder open. Cannot build graph.');
        console.error('[SaralFlow Graph] ERROR: No workspace folder open.');
        return graph;
    }
    const workspaceFolder = vscode.workspace.workspaceFolders[0].uri;
    console.log(`[SaralFlow Graph] Starting graph extraction for workspace: ${workspaceFolder.fsPath}`);
    const fileSymbolsMap = new Map<string, INode[]>();
    const findContainingSymbolId = (fileUriStr: string, position: vscode.Position): string | null => {
        const symbolsInFile = fileSymbolsMap.get(fileUriStr);
        if (!symbolsInFile) {
            return null;
        }
        for (let i = symbolsInFile.length - 1; i >= 0; i--) {
            const symbol = symbolsInFile[i];
            if (!symbol.range) { continue; }
            const start = new vscode.Position(symbol.range.start.line, symbol.range.start.character);
            const end = new vscode.Position(symbol.range.end.line, symbol.range.end.character);
            const symbolRange = new vscode.Range(start, end);
            if (symbolRange.contains(position)) {
                return symbol.id;
            }
        }
        return null;
    };
    console.log('[SaralFlow Graph] Ensuring C# extension is active...');
    vscode.window.showInformationMessage('SaralFlow Graph: Activating C# language services...');
    const csharpExtensionId = 'ms-dotnettools.csharp';
    const csharpExtension = vscode.extensions.getExtension(csharpExtensionId);
    if (!csharpExtension) {
        console.error(`[SaralFlow Graph] ERROR: C# extension "${csharpExtensionId}" not found. Please ensure it is installed.`);
        vscode.window.showErrorMessage(`SaralFlow Graph: C# extension not found. Please install it for C# features.`);
        return graph;
    }
    if (!csharpExtension.isActive) {
        console.log(`[SaralFlow Graph] C# extension "${csharpExtensionId}" is not active, activating...`);
        try {
            await csharpExtension.activate();
            console.log(`[SaralFlow Graph] C# extension "${csharpExtensionId}" activated.`);
        } catch (e: any) {
            console.error(`[SaralFlow Graph] ERROR activating C# extension: ${e.message}`);
            vscode.window.showErrorMessage(`SaralFlow Graph: Failed to activate C# extension: ${e.message}`);
            return graph;
        }
    } else {
        console.log(`[SaralFlow Graph] C# extension "${csharpExtensionId}" is already active.`);
    }
    const initialLSPWaitTimeMs = 15000;
    console.log(`[SaralFlow Graph] Waiting ${initialLSPWaitTimeMs / 1000} seconds for C# language server to initialize...`);
    await new Promise(resolve => setTimeout(resolve, initialLSPWaitTimeMs));
    console.log('[SaralFlow Graph] Initial C# language server wait complete, proceeding with graph build.');
    const files = await vscode.workspace.findFiles('**/*.{ts,tsx,js,jsx,cs,py}', '{**/node_modules/**,**/bin/**,**/obj/**,**/__pycache__/**,**/.venv/**}');
    console.log(`[SaralFlow Graph] DEBUG: vscode.workspace.findFiles found ${files.length} files.`);
    if (files.length === 0) {
        vscode.window.showWarningMessage('SaralFlow Graph: No code files found matching the pattern. Check your workspace or glob pattern.');
        console.warn('[SaralFlow Graph] No files found, returning empty graph.');
        return graph;
    }
    console.log(`[SaralFlow Graph] Found ${files.length} code files matching pattern.`);
    vscode.window.showInformationMessage(`SaralFlow Graph: Found ${files.length} code files. Processing...`);
    for (const fileUri of files) {
        const filePath = fileUri.fsPath;
        const relativePath = vscode.workspace.asRelativePath(fileUri, true);
        if (processedFiles.has(filePath)) {
            continue;
        }
        processedFiles.add(filePath);
        const fileNodeId = fileUri.toString();
        if (!graph.nodes.has(fileNodeId)) {
            const fileNode: INode = {
                id: fileNodeId,
                label: relativePath,
                kind: 'File',
                detail: '',
                uri: fileNodeId,
                range: new vscode.Range(0, 0, 0, 0),
                codeSnippet: await vscode.workspace.openTextDocument(fileUri).then(doc => doc.getText())
            };
            graph.addNode(fileNode);
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
                    const symbolId = generateNodeId(fileUri.toString(), symbol);
                    if (!graph.nodes.has(symbolId)) {
                        const codeSnippet = document.getText(symbol.range);
                        const symbolNode: INode = {
                            id: symbolId,
                            label: symbol.name,
                            kind: vscode.SymbolKind[symbol.kind],
                            detail: symbol.detail || '',
                            uri: fileUri.toString(),
                            range: new vscode.Range(symbol.range.start, symbol.range.end),
                            parentIds: [parentId],
                            codeSnippet: codeSnippet
                        };
                        graph.addNode(symbolNode);
                        graph.addEdge({
                            from: parentId,
                            to: symbolId,
                            label: EdgeType.CONTAINS
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
            if (!a.range || !b.range) { return 0; }
            return a.range.start.line - b.range.start.line || a.range.start.character - b.range.start.character;
        });
    });
    console.log('[SaralFlow Graph] Finished sorting symbols.');
    console.log(`[SaralFlow Graph] DEBUG: After initial file and symbol processing: nodes.length = ${graph.nodes.size}, edges.length = ${graph.edges.length}`);
    console.log(`[SaralFlow Graph] Generating embeddings for ${graph.nodes.size} nodes...`);
    vscode.window.showInformationMessage(`SaralFlow Graph: Generating embeddings for ${graph.nodes.size} nodes (this may take a while)...`);
    let embeddedNodesCount = 0;
    const nodesToEmbed: { node: INode; textToEmbed: string }[] = [];
    for (const [id, node] of graph.nodes.entries()) {
        if (useEmbeddings && node.codeSnippet) {
            const textToEmbed = `${node.kind}: ${node.label}\n${node.detail || ''}\n${node.codeSnippet}`;
            const maxEmbedTextLength = 8000;
            const truncatedText = textToEmbed.length > maxEmbedTextLength ?
                textToEmbed.substring(0, maxEmbedTextLength) : textToEmbed;
            nodesToEmbed.push({ node, textToEmbed: truncatedText });
        } else if (useEmbeddings && !node.codeSnippet) {
        }
    }
    if (nodesToEmbed.length > 0) {
        console.log(`[SaralFlow Graph] Starting parallel embedding for ${nodesToEmbed.length} nodes...`);
        const embeddingPromises = nodesToEmbed.map(item =>
            getEmbedding(item.textToEmbed, apiKey!)
                .then(embedding => ({ node: item.node, embedding }))
                .catch(error => {
                    console.error(`[SaralFlow Graph] Error embedding node ${item.node.label}: ${error.message}`);
                    return { node: item.node, embedding: null };
                })
        );
        const embeddingResults = await Promise.all(embeddingPromises);
        for (const result of embeddingResults) {
            if (result.embedding) {
                result.node.embedding = result.embedding;
                embeddedNodesCount++;
            }
        }
        console.log(`[SaralFlow Graph] Finished embedding. Successfully embedded ${embeddedNodesCount} nodes.`);
    } else {
        console.log('[SaralFlow Graph] No nodes found to embed or embeddings were disabled.');
    }
    console.log(`[SaralFlow Graph] Finished generating node embeddings. Successfully embedded ${embeddedNodesCount} nodes.`);
    vscode.window.showInformationMessage(`SaralFlow Graph: Generated embeddings for ${embeddedNodesCount} nodes.`);
    console.log('[SaralFlow Graph] Building interdependencies (References)...');
    vscode.window.showInformationMessage('SaralFlow Graph: Building interdependencies (References)...');
    let referenceEdgesCount = 0;
    for (const [symbolNodeId, symbolNode] of graph.nodes.entries()) {
        if (symbolNode.kind === 'File' || !symbolNode.uri || !symbolNode.range) {
            continue;
        }
        let references: vscode.Location[] | null | undefined = null;
        let successViaLSPReferences = false;
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
                        return;
                    }
                    if (!processedFiles.has(referenceLocation.uri.fsPath)) {
                        console.log(`[SaralFlow Graph] DEBUG: Skipping external reference to "${symbolNode.label}" in ${referenceLocation.uri.fsPath}`);
                        return;
                    }
                    const fromNodeId = findContainingSymbolId(refFileUriStr, referenceLocation.range.start);
                    if (fromNodeId && graph.nodes.has(fromNodeId) && fromNodeId !== symbolNodeId) {
                        const isDuplicateEdge = graph.edges.some(e => e.from === fromNodeId && e.to === symbolNodeId && e.label === EdgeType.REFERENCES);
                        if (!isDuplicateEdge) {
                            graph.addEdge({ from: fromNodeId, to: symbolNodeId, label: EdgeType.REFERENCES });
                            referenceEdgesCount++;
                            console.log(`[SaralFlow Graph] DEBUG: Added REFERENCES edge (LSP) from ${graph.nodes.get(fromNodeId)?.label} to ${symbolNode.label}`);
                        }
                    } else if (fromNodeId === null) {
                        const fileContainingRefId = referenceLocation.uri.toString();
                        if (graph.nodes.has(fileContainingRefId) && fileContainingRefId !== symbolNodeId) {
                            const isDuplicateEdge = graph.edges.some(e => e.from === fileContainingRefId && e.to === symbolNodeId && e.label === EdgeType.REFERENCES);
                            if (!isDuplicateEdge) {
                                graph.addEdge({ from: fileContainingRefId, to: symbolNodeId, label: EdgeType.REFERENCES });
                                referenceEdgesCount++;
                                console.log(`[SaralFlow Graph] DEBUG: Added REFERENCES edge (LSP) from file ${graph.nodes.get(fileContainingRefId)?.label} to ${symbolNode.label}`);
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
        if (!successViaLSPReferences && symbolNode.kind !== 'File' && symbolNode.label) {
            try {
                const symbolNameRegex = new RegExp(`\\b${symbolNode.label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'g');
                for (const fileToCheckUri of files) {
                    const fileToCheckPath = fileToCheckUri.fsPath;
                    if (fileToCheckPath === symbolNode.uri) { continue; }
                    if (!processedFiles.has(fileToCheckPath)) { continue; }
                    const documentToCheck = await vscode.workspace.openTextDocument(fileToCheckUri);
                    const fileContent = documentToCheck.getText();
                    let match;
                    while ((match = symbolNameRegex.exec(fileContent)) !== null) {
                        const startPosition = documentToCheck.positionAt(match.index);
                        const fromNodeId = findContainingSymbolId(fileToCheckUri.toString(), startPosition);
                        if (fromNodeId && graph.nodes.has(fromNodeId) && fromNodeId !== symbolNodeId) {
                            const isDuplicateEdge = graph.edges.some(e => e.from === fromNodeId && e.to === symbolNodeId && e.label === EdgeType.REFERENCES);
                            if (!isDuplicateEdge) {
                                graph.addEdge({ from: fromNodeId, to: symbolNodeId, label: EdgeType.REFERENCES });
                                referenceEdgesCount++;
                            }
                        }
                    }
                }
            } catch (error: any) {
                console.error(`[SaralFlow Graph] ERROR: Fallback Reference lookup failed for ${symbolNode.label}: ${error.message}`);
            }
        }
    }
    console.log(`[SaralFlow Graph] Finished building references. Added ${referenceEdgesCount} reference edges. Current total edges: ${graph.edges.length}`);
    console.log('[SaralFlow Graph] Building interdependencies (Inheritance)...');
    vscode.window.showInformationMessage('SaralFlow Graph: Building inheritance relationships...');
    let inheritanceEdgesCount = 0;
    for (const [symbolNodeId, symbolNode] of graph.nodes.entries()) {
        if ((symbolNode.kind === vscode.SymbolKind[vscode.SymbolKind.Class] || symbolNode.kind === vscode.SymbolKind[vscode.SymbolKind.Interface]) && symbolNode.uri && symbolNode.range) {
            const classUri = vscode.Uri.parse(symbolNode.uri);
            const classPosition = new vscode.Position(symbolNode.range.start.line, symbolNode.range.start.character);
            let supertypes: vscode.TypeHierarchyItem[] | null | undefined = null;
            let successViaLSP = false;
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
                            const supertypeId = generateNodeId(supertypeUri, supertypeItem);
                            if (graph.nodes.has(supertypeId)) {
                                const isDuplicateEdge = graph.edges.some(e => e.from === symbolNodeId && e.to === supertypeId && e.label === EdgeType.INHERITS_FROM);
                                if (!isDuplicateEdge) {
                                    graph.addEdge({ from: symbolNodeId, to: supertypeId, label: EdgeType.INHERITS_FROM });
                                    inheritanceEdgesCount++;
                                    console.log(`[SaralFlow Graph] DEBUG: Added INHERITS_FROM edge (LSP) from ${graph.nodes.get(symbolNodeId)?.label} to ${supertypeItem.name}`);
                                }
                            }
                        });
                    }
                }
            } catch (error: any) {
                console.error(`[SaralFlow Graph] ERROR: LSP Type Hierarchy lookup failed for ${symbolNode.label}: ${error.message}`);
            }
        }
    }
    console.log(`[SaralFlow Graph] Finished building inheritance. Added ${inheritanceEdgesCount} inheritance edges.`);
    
    // --- New: Call Hierarchy Section ---
    console.log('[SaralFlow Graph] Building call hierarchy...');
    vscode.window.showInformationMessage('SaralFlow Graph: Building call hierarchy relationships...');
    let callHierarchyEdgesCount = 0;
    
    // Create a list of promises for concurrent execution
    const callHierarchyPromises = [];
    const allNodes = Array.from(graph.nodes.values());

    for (const node of allNodes) {
        // Skip file nodes and nodes without a range (these cannot be part of a call hierarchy)
        if (node.kind === 'File' || !node.range) {
            continue;
        }

        const document = await vscode.workspace.openTextDocument(vscode.Uri.parse(node.uri));
        
        callHierarchyPromises.push(
            fetchAndProcessCallHierarchy(document, node, graph)
                .then(() => {
                    // This function already handles adding nodes and edges, so we just track success.
                    callHierarchyEdgesCount++;
                })
                .catch(error => {
                    console.error(`[SaralFlow Graph] Failed to fetch call hierarchy for ${node.label}:`, error);
                })
        );
    }
    
    await Promise.all(callHierarchyPromises);
    
    console.log(`[SaralFlow Graph] Finished building call hierarchy. Added call hierarchy edges.`);
    // --- End New Section ---

    console.log(`[SaralFlow Graph] Graph extraction complete. Total nodes: ${graph.nodes.size}, Total edges: ${graph.edges.length}.`);
    vscode.window.showInformationMessage(`SaralFlow Graph: Graph built successfully! Total nodes: ${graph.nodes.size}, Total edges: ${graph.edges.length}.`);
    return graph;
}



export async function processDocumentSymbols(
    document: vscode.TextDocument,
    symbols: vscode.DocumentSymbol[] | vscode.SymbolInformation[],
    graph: CodeGraph,
    parentNodeId: string
) {
    for (const symbol of symbols) {
        const nodeId = generateNodeId(document.uri.toString(), symbol); // This line is fine because SimpleSymbolInfo only needs 'name' and 'kind'

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
            uri: symbolUri.toString(), // <-- Use the determined URI
            range: symbolRange, // <-- Use the determined range
            detail: 'detail' in symbol ? symbol.detail : undefined
        });

        graph.addEdge({
            from: parentNodeId,
            to: nodeId,
            label: EdgeType.CONTAINS
        });

        // If it's a DocumentSymbol and has children, recurse
        // `DocumentSymbol` has `children`, `SymbolInformation` does not.
        if ('children' in symbol && symbol.children && symbol.children.length > 0) {
            await processDocumentSymbols(document, symbol.children, graph, nodeId);
        }
    }
}

/**
 * Fetches and processes the call hierarchy for a given node, adding call-related edges to the graph.
 * @param document The TextDocument containing the symbol.
 * @param node The INode representing the symbol to check.
 * @param graph The CodeGraph instance to add edges to.
 */
export async function fetchAndProcessCallHierarchy(document: vscode.TextDocument, node: INode, graph: CodeGraph) {
    if (!node.range) {
        return;
    }

    try {
        const prepareResult = await vscode.commands.executeCommand<vscode.CallHierarchyItem[]>(
            'vscode.executeCallHierarchyPrepare',
            document.uri,
            node.range.start
        );

        if (prepareResult && prepareResult.length > 0) {
            for (const item of prepareResult) {
                const incomingCalls = await vscode.commands.executeCommand<vscode.CallHierarchyIncomingCall[]>(
                    'vscode.executeCallHierarchyIncomingCalls',
                    item
                );
                
                if (incomingCalls) {
                    incomingCalls.forEach(call => {
                        call.fromRanges.forEach(range => {
                            const callerUri = call.from.uri.toString();
                            
                            // Corrected: Create a CallHierarchyItem-compatible object
                            const callerItem = {
                                name: call.from.name,
                                kind: call.from.kind,
                                tags: call.from.tags,
                                detail: call.from.detail,
                                uri: call.from.uri,
                                range: call.from.range,
                                selectionRange: call.from.selectionRange
                            };

                            const callerId = generateNodeId(callerUri, callerItem);
                            
                            // Check if the caller node exists in the graph
                            if (graph.nodes.has(callerId)) {
                                graph.addEdge({ from: callerId, to: node.id, label: EdgeType.CALLS });
                            }
                        });
                    });
                }
                
                const outgoingCalls = await vscode.commands.executeCommand<vscode.CallHierarchyOutgoingCall[]>(
                    'vscode.executeCallHierarchyOutgoingCalls',
                    item
                );
                
                if (outgoingCalls) {
                    outgoingCalls.forEach(call => {
                        const calleeUri = call.to.uri.toString();
                        
                        // Corrected: The 'call.to' object is already a CallHierarchyItem
                        const calleeId = generateNodeId(calleeUri, call.to);
                        
                        // Check if the callee node exists in the graph
                        if (graph.nodes.has(calleeId)) {
                            graph.addEdge({ from: node.id, to: calleeId, label: EdgeType.CALLS });
                        }
                    });
                }
            }
        }
    } catch (error) {
        console.warn(`[SaralFlow Graph] Could not fetch call hierarchy for "${node.label}" (URI: ${node.uri}). This may be due to a language server limitation or an incomplete index. Error:`, error);
        // Continue without throwing an error
    }
}

/**
 * Processes a single file and adds its nodes and edges to the global semanticGraph.
 * This function should be called when a new file is created or a changed file needs to be re-parsed.
 * @param fileUri The URI of the file to process.
 */
export async function processFileAndAddToGraph(fileUri: vscode.Uri) {
    console.log(`[SaralFlow Graph] Processing new or changed file: ${fileUri.fsPath}`);
    try {
        const document = await vscode.workspace.openTextDocument(fileUri);
        const fileUriString = fileUri.toString();
        const fileNodeId = fileUriString;

        const newNodes: INode[] = [];
        const newEdges: IEdge[] = [];
        const fileSymbolsMap = new Map<string, INode[]>();

        // Create the file node
        const fileNode: INode = {
            id: fileNodeId,
            label: vscode.workspace.asRelativePath(fileUri, true),
            kind: 'File',
            detail: '',
            uri: fileUriString,
            range: new vscode.Range(0, 0, 0, 0),
            codeSnippet: document.getText()
        };
        newNodes.push(fileNode);

        const documentSymbols = await vscode.commands.executeCommand<vscode.DocumentSymbol[]>(
            'vscode.executeDocumentSymbolProvider',
            document.uri
        );

        if (documentSymbols && documentSymbols.length > 0) {
            const processSymbol = (symbol: vscode.DocumentSymbol, parentId: string) => {
                const symbolId = generateNodeId(fileUriString, symbol);
                const codeSnippet = document.getText(symbol.range);
                const symbolNode: INode = {
                    id: symbolId,
                    label: symbol.name,
                    kind: vscode.SymbolKind[symbol.kind],
                    detail: symbol.detail || '',
                    uri: fileUriString,
                    range: new vscode.Range(symbol.range.start, symbol.range.end),
                    parentIds: [parentId],
                    codeSnippet: codeSnippet
                };
                newNodes.push(symbolNode);
                newEdges.push({
                    from: parentId,
                    to: symbolId,
                    label: EdgeType.CONTAINS
                });
                
                if (symbol.children && symbol.children.length > 0) {
                    symbol.children.forEach(childSymbol => {
                        processSymbol(childSymbol, symbolId);
                    });
                }
            };

            documentSymbols.forEach(topLevelSymbol => {
                processSymbol(topLevelSymbol, fileNodeId);
            });
        }
        
        newNodes.forEach(node => {
            semanticGraph.nodes.set(node.id, node);
        });

        semanticGraph.edges = semanticGraph.edges.concat(newEdges);
        
        // Re-run call hierarchy for all relevant nodes
        for (const node of newNodes) {
             await fetchAndProcessCallHierarchy(document, node, semanticGraph);
        }

        console.log(`[SaralFlow Graph] Finished processing and adding nodes/edges for: ${fileUri.fsPath}`);
    } catch (error: any) {
        console.error(`[SaralFlow Graph] Error processing file ${fileUri.fsPath}:`, error);
    }
}

/**
 * Removes all nodes and edges associated with a given file URI from the graph.
 * This function should be called when a file is deleted or changed.
 * @param fileUri The URI of the file to remove.
 */
export function removeFileNodesFromGraph(fileUri: vscode.Uri) {
    console.log(`[SaralFlow Graph] Removing nodes/edges for deleted or changed file: ${fileUri.fsPath}`);
    const fileUriString = fileUri.toString();
    const removedNodeIds = new Set<string>();

    // Collect all node IDs to be removed and delete them from the Map
    for (const [key, node] of semanticGraph.nodes.entries()) {
        if (node.uri === fileUriString) {
            removedNodeIds.add(key);
            semanticGraph.nodes.delete(key);
        }
    }

    // Filter out all edges that either start or end at a removed node
    semanticGraph.edges = semanticGraph.edges.filter(edge =>
        !removedNodeIds.has(edge.from) && !removedNodeIds.has(edge.to)
    );

    console.log(`[SaralFlow Graph] Finished removing nodes/edges for: ${fileUri.fsPath}`);
}






