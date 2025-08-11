import * as vscode from 'vscode';
import {CodeGraph, INode, IEdge, EdgeType, toNodeKind, generateNodeId,  ISemanticGraph, NodeKind  } from './graphTypes';
import { getEmbeddingViaCloudFunction } from './embeddingService'; // Updated import
import {  semanticGraph, firebaseIdToken } from './extension'; // Import firebaseIdToken
import pLimit from 'p-limit';

const limit = pLimit(10);
const initialLSPWaitTimeMs = 10_000;

// This map will store sorted symbols for each file to optimize lookups
const fileSymbolsMap = new Map<string, INode[]>();

/**
 * Finds the ID of the innermost symbol that contains the given position in a specific file.
 * This is an optimized version that uses a pre-sorted map for efficient lookups.
 */
const findContainingSymbolId = (fileUriStr: string, position: vscode.Position): string | null => {
    const symbols = fileSymbolsMap.get(fileUriStr);
    if (!symbols || symbols.length === 0) {
        return null;
    }

    let low = 0;
    let high = symbols.length - 1;
    let innermostSymbol: INode | null = null;

    while (low <= high) {
        const midIndex = Math.floor((low + high) / 2);
        const symbol = symbols[midIndex];

        if (symbol.range && symbol.range.contains(position)) {
            // Potential candidate, but keep searching for a more nested symbol
            innermostSymbol = symbol;
            low = midIndex + 1; // Search in the right half
        } else if (symbol.range && position.isBefore(symbol.range.start)) {
            high = midIndex - 1; // Search in the left half
        } else {
            low = midIndex + 1; // Search in the right half
        }
    }

    return innermostSymbol ? innermostSymbol.id : fileUriStr;
};

/**
 * Extracts a complete semantic graph from the workspace, or incrementally updates for a list of files.
 * @param filesToProcess An optional array of URIs of files to process. If not provided, a full graph is built.
 * @returns A Promise that resolves to the CodeGraph instance.
 */
export async function extractSemanticGraph(filesToProcess?: vscode.Uri[]): Promise<CodeGraph> {
    if (!vscode.workspace.workspaceFolders || vscode.workspace.workspaceFolders.length === 0) {
        return new CodeGraph();
    }

    const graph = semanticGraph;
    const processedFiles = new Set<string>();
    
    // Determine the list of files to process
    let files: vscode.Uri[];
    if (filesToProcess && filesToProcess.length > 0) {
        console.log(`[SaralFlow Graph] Starting incremental update for ${filesToProcess.length} files.`);
        files = filesToProcess;
        // For incremental updates, we first remove the old nodes and edges for the files being updated.
        files.forEach(fileUri => removeFileNodesFromGraph(fileUri));
    } else {
        console.log('[SaralFlow Graph] Starting full graph extraction...');
        await new Promise(resolve => setTimeout(resolve, initialLSPWaitTimeMs));
        files = await vscode.workspace.findFiles('**/*.{ts,tsx,js,jsx,cs,py,sql}', '{**/node_modules/**,**/bin/**,**/obj/**,**/__pycache__/**,**/.venv/**}');
        if (files.length === 0) {
            return graph;
        }
        // Clear the graph for a full rebuild
        graph.nodes.clear();
        graph.edges = [];
        fileSymbolsMap.clear();
    }

    console.log('[SaralFlow Graph] Starting file processing...');
    const fileProcessingPromises = files.map(fileUri => limit(() => processFileAndAddNodes(fileUri, graph, processedFiles)));
    await Promise.all(fileProcessingPromises);

    const allNodes = Array.from(graph.nodes.values());

    console.log('[SaralFlow Graph] Starting LSP reference lookup...');
    const referencePromises = allNodes.map(node => limit(() => fetchAndProcessReferences(node, graph)));
    await Promise.all(referencePromises);

    console.log('[SaralFlow Graph] Starting inheritance lookup...');
    const inheritancePromises = allNodes.map(node => limit(() => fetchAndProcessInheritance(node, graph)));
    await Promise.all(inheritancePromises);

    console.log('[SaralFlow Graph] Starting LSP call hierarchy lookup...');
    const callHierarchyPromises = allNodes.map(node => limit(() => fetchAndProcessCallHierarchy(node, graph)));
    await Promise.all(callHierarchyPromises);

    await findCrossFileRelationshipsManually(graph, files);

    if (firebaseIdToken) {
        console.log('[SaralFlow Graph] Starting embedding generation...');
        const nodesToEmbed = allNodes.filter(node => node.codeSnippet);
        const embeddingPromises = nodesToEmbed.map(node => limit(async () => {
            const textToEmbed = `${node.kind}: ${node.label}\n${node.detail || ''}\n${node.codeSnippet}`;
            const maxEmbedTextLength = 8000;
            const truncatedText = textToEmbed.length > maxEmbedTextLength ?
                textToEmbed.substring(0, maxEmbedTextLength) : textToEmbed;
            
            try {
                const embedding = await getEmbeddingViaCloudFunction(truncatedText, firebaseIdToken!);
                if (embedding) {
                    node.embedding = embedding;
                }
            } catch (error: any) {
                console.error(`[SaralFlow Graph] Error embedding node ${node.label}: ${error.message}`);
            }
        }));
        await Promise.all(embeddingPromises);
    }
    
    console.log(`[SaralFlow Graph] Graph creation complete with ${graph.nodes.size} nodes and ${graph.edges.length} edges.`);
    return graph;
}

/**
 * Fetches and processes inheritance relationships for a single node, adding 'INHERITS_FROM' edges.
 */
async function fetchAndProcessInheritance(node: INode, graph: CodeGraph): Promise<void> {
    if ((node.kind !== 'Class' && node.kind !== 'Interface') || !node.uri || !node.range) {
        return;
    }
    try {
        const typeHierarchyItems = await vscode.commands.executeCommand<vscode.TypeHierarchyItem[]>(
            'vscode.prepareTypeHierarchy',
            vscode.Uri.parse(node.uri),
            node.range.start
        );

        if (typeHierarchyItems && typeHierarchyItems.length > 0) {
            const supertypes = await vscode.commands.executeCommand<vscode.TypeHierarchyItem[]>(
                'vscode.executeTypeHierarchySupertypes',
                typeHierarchyItems[0]
            );

            if (supertypes && supertypes.length > 0) {
                supertypes.forEach(supertypeItem => {
                    const supertypeId = generateNodeId(supertypeItem.uri.toString(), supertypeItem);
                    if (graph.nodes.has(supertypeId)) {
                        graph.addEdge({ from: node.id, to: supertypeId, label: EdgeType.INHERITS_FROM });
                    }
                });
            }
        }
    } catch (error: any) {
        console.warn(`[SaralFlow Graph] ERROR: LSP Type Hierarchy lookup failed for ${node.label}: ${error.message}`);
    }
}

/**
 * Fetches and processes references for a single node, adding 'REFERENCES' edges to the graph.
 */
async function fetchAndProcessReferences(node: INode, graph: CodeGraph): Promise<void> {
    if (node.kind === 'File' || !node.uri || !node.range) {
        return;
    }
    try {
        const references = await vscode.commands.executeCommand<vscode.Location[]>(
            'vscode.executeReferenceProvider',
            vscode.Uri.parse(node.uri),
            node.range.start
        );

        if (references && references.length > 0) {
            references.forEach(referenceLocation => {
                const refFileUriStr = referenceLocation.uri.toString();
                // Avoid self-referencing
                if (refFileUriStr === node.uri && referenceLocation.range.isEqual(node.range!)) {
                    return;
                }
                const fromNodeId = findContainingSymbolId(refFileUriStr, referenceLocation.range.start);
                
                if (fromNodeId && graph.nodes.has(fromNodeId) && fromNodeId !== node.id) {
                    graph.addEdge({ from: fromNodeId, to: node.id, label: EdgeType.REFERENCES });
                }
            });
        }
    } catch (error: any) {
        console.warn(`[SaralFlow Graph] ERROR: LSP Reference lookup failed for ${node.label}: ${error.message}`);
    }
}

/**
 * Manually searches the entire workspace for text occurrences and adds 'REFERENCES' or 'CALLS' edges.
 * This function replaces the use of `findTextInFiles` for wider compatibility.
 */
async function findCrossFileRelationshipsManually(graph: CodeGraph, files: vscode.Uri[]): Promise<void> {
    console.log('[SaralFlow Graph] Starting manual text-based cross-file relationship search...');
    const nodesToSearchFor = Array.from(graph.nodes.values())
        .filter(node => node.label && node.kind !== 'File' && node.kind !== 'Module');

    const searchPromises = files.map(fileUri => limit(async () => {
        try {
            const document = await vscode.workspace.openTextDocument(fileUri);
            const fileText = document.getText();
            for (const node of nodesToSearchFor) {
                const regex = new RegExp(`\\b${node.label}\\b`, 'g');
                let match;
                while ((match = regex.exec(fileText)) !== null) {
                    const position = document.positionAt(match.index);
                    const referencingNodeId = findContainingSymbolId(fileUri.toString(), position);
                    if (referencingNodeId && referencingNodeId !== node.id) {
                        graph.addEdge({ from: referencingNodeId, to: node.id, label: EdgeType.REFERENCES });
                    }
                }
            }
        } catch (err) {
            console.warn(`[SaralFlow Graph] Could not open document for manual text search: ${fileUri.toString()}`);
        }
    }));
    await Promise.all(searchPromises);
}

/**
 * Processes a single file, adding its nodes and 'CONTAINS' edges to the graph.
 */
async function processFileAndAddNodes(fileUri: vscode.Uri, graph: CodeGraph, processedFiles: Set<string>): Promise<INode[]> {
    const newNodesInFile: INode[] = [];
    const filePath = fileUri.fsPath;
    const relativePath = vscode.workspace.asRelativePath(fileUri, true);
    const fileNodeId = fileUri.toString();

    if (processedFiles.has(filePath)) {
        return [];
    }
    processedFiles.add(filePath);

    try {
        const document = await vscode.workspace.openTextDocument(fileUri);
        
        // Add the file node
        const fileNode: INode = {
            id: fileNodeId,
            label: relativePath,
            kind: 'File',
            detail: '',
            uri: fileNodeId,
            range: new vscode.Range(0, 0, 0, 0),
            codeSnippet: document.getText()
        };
        graph.addNode(fileNode);
        newNodesInFile.push(fileNode);

        const documentSymbols = await vscode.commands.executeCommand<vscode.DocumentSymbol[]>(
            'vscode.executeDocumentSymbolProvider',
            document.uri
        );

        if (documentSymbols && documentSymbols.length > 0) {
            const symbolsInFile: INode[] = [];
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
                    newNodesInFile.push(symbolNode);
                    graph.addEdge({ from: parentId, to: symbolId, label: EdgeType.CONTAINS });
                    symbolsInFile.push(symbolNode);
                }
                if (symbol.children && symbol.children.length > 0) {
                    symbol.children.forEach(childSymbol => processSymbol(childSymbol, symbolId));
                }
            };

            documentSymbols.forEach(topLevelSymbol => processSymbol(topLevelSymbol, fileNodeId));
            
            // Sort symbols by range for faster lookups later
            symbolsInFile.sort((a, b) => {
                if (!a.range || !b.range) { return 0; }
                return a.range.start.line - b.range.start.line || a.range.start.character - b.range.start.character;
            });
            fileSymbolsMap.set(fileUri.toString(), symbolsInFile);
        }
    } catch (error: any) {
        console.error(`[SaralFlow Graph] Failed to open or process document ${relativePath}: ${error.message}`);
    }
    return newNodesInFile;
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

async function fetchAndProcessCallHierarchy(node: INode, graph: CodeGraph): Promise<void> {
    if ((node.kind !== 'Function' && node.kind !== 'Method') || !node.uri || !node.range) {
        return;
    }
    
    let lspSuccess = false;
    try {
        const document = await vscode.workspace.openTextDocument(vscode.Uri.parse(node.uri));
        const callHierarchyItems = await vscode.commands.executeCommand<vscode.CallHierarchyItem[]>(
            'vscode.prepareCallHierarchy',
            document.uri,
            node.range.start
        );

        if (callHierarchyItems && callHierarchyItems.length > 0) {
            const calls = await vscode.commands.executeCommand<vscode.CallHierarchyOutgoingCall[]>(
                'vscode.executeCallHierarchyOutgoingCalls',
                callHierarchyItems[0]
            );
            if (calls && calls.length > 0) {
                calls.forEach(call => {
                    const toNodeId = generateNodeId(call.to.uri.toString(), call.to);
                    if (graph.nodes.has(toNodeId)) {
                        graph.addEdge({ from: node.id, to: toNodeId, label: EdgeType.CALLS });
                    }
                });
            }

            const incomingCalls = await vscode.commands.executeCommand<vscode.CallHierarchyIncomingCall[]>(
                'vscode.executeCallHierarchyIncomingCalls',
                callHierarchyItems[0]
            );
            if (incomingCalls && incomingCalls.length > 0) {
                incomingCalls.forEach(call => {
                    const fromNodeId = generateNodeId(call.from.uri.toString(), call.from);
                    if (graph.nodes.has(fromNodeId)) {
                        graph.addEdge({ from: fromNodeId, to: node.id, label: EdgeType.CALLS });
                    }
                });
            }
            lspSuccess = true;
        }
    } catch (error: any) {
        console.warn(`[SaralFlow Graph] ERROR: LSP Call Hierarchy lookup failed for ${node.label}: ${error.message}`);
    }

    if (!lspSuccess) {
        console.log(`[SaralFlow Graph] Falling back to text-based call search for ${node.label}...`);
        
        const allFiles = Array.from(fileSymbolsMap.keys());
        const searchPromises = allFiles.map(fileUriStr => limit(async () => {
            const document = await vscode.workspace.openTextDocument(vscode.Uri.parse(fileUriStr));
            const text = document.getText();
            const regex = new RegExp(`\\b${node.label}\\b`, 'g');
            let match;
            while ((match = regex.exec(text)) !== null) {
                const position = document.positionAt(match.index);
                const callingNodeId = findContainingSymbolId(fileUriStr, position);
                if (callingNodeId && callingNodeId !== node.id) {
                    graph.addEdge({ from: callingNodeId, to: node.id, label: EdgeType.CALLS });
                }
            }
        }));
        await Promise.all(searchPromises);
    }
}

/**
 * Removes all nodes and edges associated with a specific file from the graph.
 * @param fileUri The URI of the file whose nodes and edges are to be removed.
 * @returns A list of IEdge objects that were removed from the graph.
 */
export function removeFileNodesFromGraph(fileUri: vscode.Uri): IEdge[] {
    const fileUriStr = fileUri.toString();
    const removedNodeIds: string[] = [];

    // Identify nodes to remove and store their IDs
    const nodesToRemove = Array.from(semanticGraph.nodes.values()).filter(node => node.uri === fileUriStr);
    nodesToRemove.forEach(node => removedNodeIds.push(node.id));

    // Identify and store edges that will be removed
    const removedEdges: IEdge[] = semanticGraph.edges.filter(edge => 
        removedNodeIds.includes(edge.from) || removedNodeIds.includes(edge.to)
    );

    // Remove nodes
    nodesToRemove.forEach(node => {
        semanticGraph.nodes.delete(node.id);
    });

    // Remove edges
    semanticGraph.edges = semanticGraph.edges.filter(edge => 
        !removedNodeIds.includes(edge.from) && !removedNodeIds.includes(edge.to)
    );
    
    return removedEdges;
}


/**
 * Helper function to find a node in the graph by its URI and label (name).
 * This is useful for finding nodes after a file has been re-parsed and their IDs may have changed.
 * @param uri The URI of the file containing the node.
 * @param label The label (name) of the node.
 * @returns The found INode, or undefined if not found.
 */
function findNodeByUriAndName(uri: string, label: string): INode | undefined {
    for (const node of semanticGraph.nodes.values()) {
        if (node.uri === uri && node.label === label) {
            return node;
        }
    }
    return undefined;
}

/**
 * Re-embeds nodes in the semantic graph that do not yet have an embedding.
 * This function should be called after Firebase authentication is complete.
 */
export async function reEmbedGraphNodes() {
    if (!firebaseIdToken) {
        console.warn('[SaralFlow Graph] Cannot re-embed nodes: Firebase ID Token is not available.');
        vscode.window.showWarningMessage('SaralFlow: Unable to embed semantic nodes. Please log in or contact support.');
        return;
    }

    let reEmbeddedNodesCount = 0;
    const nodesToReEmbed: { node: INode; textToEmbed: string }[] = [];

    // Create a filtered array of only the nodes that need re-embedding
    const unembeddedNodes = Array.from(semanticGraph.nodes.values()).filter(node => !node.embedding && node.codeSnippet);

    for (const node of unembeddedNodes) {
        // This loop now only runs for the nodes that actually need to be processed
        const textToEmbed = `${node.kind}: ${node.label}\n${node.detail || ''}\n${node.codeSnippet}`;
        const maxEmbedTextLength = 8000;
        const truncatedText = textToEmbed.length > maxEmbedTextLength ?
            textToEmbed.substring(0, maxEmbedTextLength) : textToEmbed;
        nodesToReEmbed.push({ node, textToEmbed: truncatedText });
    }

    if (nodesToReEmbed.length > 0) {
        console.log(`[SaralFlow Graph] Found ${nodesToReEmbed.length} nodes to re-embed.`);
        const embeddingPromises = nodesToReEmbed.map(item =>
            limit(() => // Use p-limit for concurrency control
                getEmbeddingViaCloudFunction(item.textToEmbed, firebaseIdToken!)
                    .then(embedding => ({ node: item.node, embedding }))
                    .catch(error => {
                        console.error(`[SaralFlow Graph] Error re-embedding node ${item.node.label}: ${error.message}`);
                        return { node: item.node, embedding: null };
                    })
            )
        );
        const embeddingResults = await Promise.all(embeddingPromises);
        for (const result of embeddingResults) {
            if (result.embedding) {
                result.node.embedding = result.embedding;
                reEmbeddedNodesCount++;
            }
        }
        console.log(`[SaralFlow Graph] Finished re-embedding. Successfully re-embedded ${reEmbeddedNodesCount} nodes.`);
    } else {
        console.log('[SaralFlow Graph] No nodes found requiring re-embedding.');
    }
}
