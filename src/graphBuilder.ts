import * as vscode from 'vscode';
import * as path from 'path';
import {CodeGraph, INode, IEdge, EdgeType, toNodeKind, generateNodeId, GraphNode, ISemanticGraph  } from './graphTypes';
import { getEmbedding } from './embeddingService';
import { getApiKey } from './extension';

export async function extractSemanticGraph(): Promise<ISemanticGraph> {
    const nodes: INode[] = [];
    const edges: IEdge[] = [];
    const nodeMap = new Map<string, INode>(); // Map<NodeId, INode> for quick lookup
    const processedFiles = new Set<string>(); // Set<Filepath> to track files already processed

    // --- API Key and Embedding setup ---
    let apiKey: string | undefined;
    try {
        // Assuming getApiKey fetches the API key from secretStorage
        apiKey = await getApiKey(); // Ensure getApiKey is defined and accessible
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
        // Sort by start position for reliable containment checks if not already sorted
        // (Though your processing loop already ensures this for adding to fileSymbolsMap)
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
                detail: '', // Files don't have LSP detail in this context
                uri: fileNodeId,
                range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } }, // Placeholder range for file
                codeSnippet: await vscode.workspace.openTextDocument(fileUri).then(doc => doc.getText()) // Get full file content for file node
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
                        const codeSnippet = document.getText(symbol.range); // Extract the actual code snippet
                        const symbolNode: INode = {
                            id: symbolId,
                            label: symbol.name,
                            kind: vscode.SymbolKind[symbol.kind],
                            detail: symbol.detail || '', // Keep LSP detail (can be empty)
                            uri: fileUri.toString(),
                            range: {
                                start: { line: symbol.range.start.line, character: symbol.range.start.character },
                                end: { line: symbol.range.end.line, character: symbol.range.end.character }
                            },
                            parentIds: [parentId],
                            codeSnippet: codeSnippet // Store the code snippet
                        };
                        nodes.push(symbolNode);
                        nodeMap.set(symbolId, symbolNode);

                        edges.push({
                            from: parentId,
                            to: symbolId,
                            label: 'CONTAINS'
                        });

                        // Add to fileSymbolsMap only if it's not a 'File' node itself
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
    console.log(`[SaralFlow Graph] DEBUG: After initial file and symbol processing: nodes.length = ${nodes.length}, edges.length = ${edges.length}`);


    // --- NEW: Generate and store embeddings for all nodes ---
    console.log(`[SaralFlow Graph] Generating embeddings for ${nodes.length} nodes...`);
    vscode.window.showInformationMessage(`SaralFlow Graph: Generating embeddings for ${nodes.length} nodes (this may take a while)...`);

    let embeddedNodesCount = 0;
    for (const node of nodes) {
        if (useEmbeddings && node.codeSnippet) { // Only embed if API key is present AND we have a code snippet
            try {
                // Combine relevant text for embedding: label, kind, and the actual code snippet
                // You can adjust this combination based on what you want to emphasize in embeddings
                const textToEmbed = `${node.kind}: ${node.label}\n${node.detail || ''}\n${node.codeSnippet}`;

                // Optional: Trim long snippets to avoid hitting token limits for embedding models
                // OpenAI's text-embedding-3-small supports 8191 tokens
                const maxEmbedTextLength = 8000; // Example, adjust based on model limits
                const truncatedText = textToEmbed.length > maxEmbedTextLength ?
                    textToEmbed.substring(0, maxEmbedTextLength) : textToEmbed;

                const embedding = await getEmbedding(truncatedText, apiKey!);
                if (embedding) {
                    node.embedding = embedding;
                    embeddedNodesCount++;
                } else {
                    console.warn(`[SaralFlow Graph] Failed to generate embedding for node: ${node.label} (${node.kind}). No embedding returned.`);
                }
            } catch (embedError: any) {
                console.error(`[SaralFlow Graph] Error embedding node ${node.label} (${node.kind}) from ${node.uri} at range ${node.range ? `${node.range.start.line}:${node.range.start.character}` : 'N/A'}: ${embedError.message}`);
            }
        } else if (useEmbeddings && !node.codeSnippet) {
            console.warn(`[SaralFlow Graph] Skipping embedding for node ${node.label} (no code snippet available or file node).`);
        } else if (!useEmbeddings) {
            // Already warned at the start if API key is missing
        }
    }
    console.log(`[SaralFlow Graph] Finished generating node embeddings. Successfully embedded ${embeddedNodesCount} nodes.`);
    vscode.window.showInformationMessage(`SaralFlow Graph: Generated embeddings for ${embeddedNodesCount} nodes.`);


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
                    if (fileToCheckPath === symbolNode.uri) {continue;} // Don't check the file defining the symbol

                    if (!processedFiles.has(fileToCheckPath)) {continue;} // Only check files we actually processed

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
            symbolNode.uri && symbolNode.range) {
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
                                    console.log(`[SaralFlow Graph] DEBUG: Added CALLS edge (LSP) from ${nodeMap.get(calleeSymbolId)?.label} to ${symbolNode.label}`);
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

export async function processDocumentSymbols(
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

export async function fetchAndProcessCallHierarchy(document: vscode.TextDocument, node: GraphNode, graph: CodeGraph) {
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