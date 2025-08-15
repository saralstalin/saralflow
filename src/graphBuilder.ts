// src/graphBuilder.ts
import * as vscode from 'vscode';
import { CodeGraph, INode, EdgeType, generateNodeId } from './graphTypes';
import { getEmbeddingViaCloudFunction } from './embeddingService';
import { semanticGraph } from './extension';
import pLimit from 'p-limit';

// ===== Tunables =====
const DEFAULT_CONCURRENCY = 8;          // keep modest to avoid overloading LSP
const EMBEDDING_CONCURRENCY = 8;        // parallel embedding calls
const initialLSPWaitTimeMs = 12_000;    // give language servers a head start

// Common search patterns for workspace files
const FILE_EXTENSIONS = ['ts', 'tsx', 'js', 'jsx', 'cs', 'py', 'sql', 'json', 'md', 'ipynb']; // ipynb last
const EXCLUDE_GLOBS = '{**/node_modules/**,**/bin/**,**/obj/**,**/__pycache__/**,**/.venv/**}';

// Public (static) token for your embedding Cloud Function
export const statToken = '9XtremeThermo$teel';

// ===== Internal caches used per run =====
type DocumentCache = Map<string, vscode.TextDocument>;
const fileSymbolsMap = new Map<string, INode[]>();

/** Safe/fast escaping for regex (used in combined-search strategy) */
function escapeRegexLiteral(s: string) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Finds the ID of the innermost symbol that contains the given position in a specific file.
 * Uses binary search over pre-sorted symbols for performance.
 */
const findContainingSymbolId = (fileUriStr: string, position: vscode.Position): string | null => {
  const symbols = fileSymbolsMap.get(fileUriStr);
  if (!symbols || symbols.length === 0) {return null;}

  let low = 0;
  let high = symbols.length - 1;
  let innermostSymbol: INode | null = null;

  while (low <= high) {
    const midIndex = Math.floor((low + high) / 2);
    const symbol = symbols[midIndex];

    if (symbol.range && symbol.range.contains(position)) {
      innermostSymbol = symbol;
      // Look right to find a more nested symbol that still contains the position
      low = midIndex + 1;
    } else if (symbol.range && position.isBefore(symbol.range.start)) {
      high = midIndex - 1;
    } else {
      low = midIndex + 1;
    }
  }
  return innermostSymbol ? innermostSymbol.id : fileUriStr;
};

/**
 * Top-level function to extract or incrementally update the semantic graph.
 * - Caches documents
 * - Merges LSP calls per node
 * - Single-pass combined-regex file scan for manual relationships
 * - Pipelines embeddings early for great UX
 */
export async function extractSemanticGraph(
  filesToProcess?: vscode.Uri[],
  onProgress?: (message: string) => void
): Promise<CodeGraph> {
  if (!vscode.workspace.workspaceFolders || vscode.workspace.workspaceFolders.length === 0) {
    return new CodeGraph();
  }

  const graph = semanticGraph;
  const isIncremental = !!(filesToProcess && filesToProcess.length > 0);
  const newNodesInThisUpdate: INode[] = [];

  // Per-run caches
  const documentCache: DocumentCache = new Map();
  const fileTextCache: Map<string, string> = new Map();
  const allEmbeddingPromises: Promise<void>[] = []; // <-- NEW

  if (isIncremental) {
    onProgress?.(`Incremental update for ${filesToProcess!.length} files...`);
    filesToProcess!.forEach(fileUri => {
      removeFileNodesFromGraph(fileUri);
      fileSymbolsMap.delete(fileUri.toString());
      fileTextCache.delete(fileUri.toString()); // <-- Clear stale file text
    });
  } else {
    onProgress?.('Learning your project...');
    await new Promise(resolve => setTimeout(resolve, initialLSPWaitTimeMs));

    const files = await vscode.workspace.findFiles(
      `**/*.{${FILE_EXTENSIONS.join(',')}}`,
      EXCLUDE_GLOBS
    );

    if (files.length === 0) {
      onProgress?.('No matching files found');
      return graph;
    }

    graph.nodes.clear();
    graph.edges = [];
    fileSymbolsMap.clear();
    filesToProcess = files;
  }

  const limit = pLimit(DEFAULT_CONCURRENCY);
  const embeddingLimit = pLimit(EMBEDDING_CONCURRENCY);

  onProgress?.('Processing files...');
  const fileProcessing = filesToProcess!.map(fileUri =>
    limit(async () => {
      await processFileAndAddNodes(
        fileUri,
        graph,
        documentCache,
        fileTextCache,
        embeddingLimit,
        newNodesInThisUpdate,
        allEmbeddingPromises // <-- pass down for embedding collection
      );
    })
  );
  await Promise.all(fileProcessing);

  const nodesToProcessForRefs = isIncremental ? newNodesInThisUpdate : Array.from(graph.nodes.values());
  const limitedNodesToProcessForRefs = nodesToProcessForRefs.filter(
    node =>
      node.kind === 'Class' ||
      node.kind === 'Method' ||
      node.kind === 'Function' ||
      node.kind === 'Interface'
  );

  onProgress?.('Analyzing interdependencies...');
  const lspPasses = limitedNodesToProcessForRefs.map(node =>
    limit(() => processAllLspForNode(node, graph, documentCache))
  );
  await Promise.all(lspPasses);

  onProgress?.('Finding cross-file references...');
  if (isIncremental) {
    // Restrict manual scan to changed files + connected files
    await findCrossFileRelationshipsManually(
      graph,
      getTwoLayerNeighborhood(graph, newNodesInThisUpdate),
      fileTextCache
    );
  } else {
    await findCrossFileRelationshipsManually(graph, nodesToProcessForRefs, fileTextCache);
  }

  // Wait for all embeddings to finish
  onProgress?.('Finalizing embeddings...');
  await Promise.all(allEmbeddingPromises);

  onProgress?.(`Graph build complete (${graph.nodes.size} nodes, ${graph.edges.length} edges)`);

  return graph;
}

/**
 * Get all nodes within two layers of given nodes.
 */
function getTwoLayerNeighborhood(graph: CodeGraph, baseNodes: INode[]): INode[] {
  const ids = new Set<string>(baseNodes.map(n => n.id));
  const addConnected = (nodeId: string) => {
    for (const e of graph.edges) {
      if (e.from === nodeId && !ids.has(e.to)) {ids.add(e.to);}
      if (e.to === nodeId && !ids.has(e.from)) {ids.add(e.from);}
    }
  };
  baseNodes.forEach(n => addConnected(n.id));
  Array.from(ids).forEach(id => addConnected(id)); // second layer
  return Array.from(ids).map(id => graph.nodes.get(id)!).filter(Boolean);
}

/** Helper to get (and cache) a TextDocument */
async function getDocumentCached(
  uriStrOrUri: string | vscode.Uri,
  documentCache: DocumentCache
): Promise<vscode.TextDocument> {
  const key = typeof uriStrOrUri === 'string' ? uriStrOrUri : uriStrOrUri.toString();
  if (!documentCache.has(key)) {
    const uri = typeof uriStrOrUri === 'string' ? vscode.Uri.parse(uriStrOrUri) : uriStrOrUri;
    const doc = await vscode.workspace.openTextDocument(uri);
    documentCache.set(key, doc);
  }
  return documentCache.get(key)!;
}

/**
 * Merged LSP processing for a single node: references, inheritance, call hierarchy.
 * Reuses the cached document and gracefully falls back to text-based searches if LSP fails.
 */
async function processAllLspForNode(
  node: INode,
  graph: CodeGraph,
  documentCache: DocumentCache
): Promise<void> {
  if (!node.uri || !node.range) {return;}

  try {
    const document = await getDocumentCached(node.uri, documentCache);

    // Type hierarchy / inheritance
    if (node.kind === 'Class' || node.kind === 'Interface') {
      try {
        const typeItems = await vscode.commands.executeCommand<vscode.TypeHierarchyItem[]>(
          'vscode.prepareTypeHierarchy',
          document.uri,
          node.range.start
        );
        if (typeItems && typeItems.length > 0) {
          const supertypes = await vscode.commands.executeCommand<vscode.TypeHierarchyItem[]>(
            'vscode.executeTypeHierarchySupertypes',
            typeItems[0]
          );
          if (supertypes && supertypes.length > 0) {
            supertypes.forEach(s => {
              const superId = generateNodeId(s.uri.toString(), s);
              if (graph.nodes.has(superId)) {
                graph.addEdge({ from: node.id, to: superId, label: EdgeType.INHERITS_FROM });
              }
            });
          }
        }
      } catch (err) {
        console.warn(`[SaralFlow Graph] LSP inheritance failed for ${node.label}: ${err}`);
      }
    }

    // References
    try {
      const refs = await vscode.commands.executeCommand<vscode.Location[]>(
        'vscode.executeReferenceProvider',
        document.uri,
        node.range.start
      );
      if (refs && refs.length > 0) {
        refs.forEach(ref => {
          const refFileUriStr = ref.uri.toString();
          if (refFileUriStr === node.uri && ref.range.isEqual(node.range!)) {return;}

          const fromNodeId = findContainingSymbolId(refFileUriStr, ref.range.start);
          if (fromNodeId && graph.nodes.has(fromNodeId) && fromNodeId !== node.id) {
            graph.addEdge({ from: fromNodeId, to: node.id, label: EdgeType.REFERENCES });
          }
        });
      }
    } catch (err) {
      console.warn(`[SaralFlow Graph] LSP references failed for ${node.label}: ${err}`);
    }

    // Call Hierarchy (outgoing/incoming) for functions/methods
    if (node.kind === 'Function' || node.kind === 'Method') {
      try {
        const callItems = await vscode.commands.executeCommand<vscode.CallHierarchyItem[]>(
          'vscode.prepareCallHierarchy',
          document.uri,
          node.range.start
        );
        if (callItems && callItems.length > 0) {
          const outgoing = await vscode.commands.executeCommand<vscode.CallHierarchyOutgoingCall[]>(
            'vscode.executeCallHierarchyOutgoingCalls',
            callItems[0]
          );
          if (outgoing && outgoing.length > 0) {
            outgoing.forEach(call => {
              const toId = generateNodeId(call.to.uri.toString(), call.to);
              if (graph.nodes.has(toId)) {
                graph.addEdge({ from: node.id, to: toId, label: EdgeType.CALLS });
              }
            });
          }

          const incoming = await vscode.commands.executeCommand<vscode.CallHierarchyIncomingCall[]>(
            'vscode.executeCallHierarchyIncomingCalls',
            callItems[0]
          );
          if (incoming && incoming.length > 0) {
            incoming.forEach(call => {
              const fromId = generateNodeId(call.from.uri.toString(), call.from);
              if (graph.nodes.has(fromId)) {
                graph.addEdge({ from: fromId, to: node.id, label: EdgeType.CALLS });
              }
            });
          }
        }
      } catch (err) {
        console.warn(`[SaralFlow Graph] LSP call hierarchy failed for ${node.label}: ${err}`);

        // Fallback: light text scan in already-processed files
        try {
          for (const fileUriStr of fileSymbolsMap.keys()) {
            const doc = await getDocumentCached(fileUriStr, documentCache);
            const text = doc.getText();
            const regex = new RegExp(`\\b${escapeRegexLiteral(node.label)}\\b`, 'g');
            let match: RegExpExecArray | null;
            while ((match = regex.exec(text)) !== null) {
              const pos = doc.positionAt(match.index);
              const callerId = findContainingSymbolId(fileUriStr, pos);
              if (callerId && callerId !== node.id) {
                graph.addEdge({ from: callerId, to: node.id, label: EdgeType.CALLS });
              }
            }
          }
        } catch (fallbackErr) {
          console.warn(`[SaralFlow Graph] Fallback call search failed for ${node.label}: ${fallbackErr}`);
        }
      }
    }
  } catch (outerErr) {
    console.warn(`[SaralFlow Graph] Processing LSP for ${node.label} failed: ${outerErr}`);
  }
}

/**
 * Manually search workspace files for references/calls using a combined regex per file.
 * This reduces O(files * labels) to approximately O(files + totalMatches).
 */
async function findCrossFileRelationshipsManually(
  graph: CodeGraph,
  nodesToSearchFor: INode[],
  fileTextCache: Map<string, string>
) {
  const labelToNode = new Map<string, INode>();
  const labels: string[] = [];

  for (const node of nodesToSearchFor) {
    if (node.label && node.kind !== 'File' && node.kind !== 'Module') {
      labelToNode.set(node.label, node);
      labels.push(escapeRegexLiteral(node.label));
    }
  }
  if (labels.length === 0) {return;}

  // Combined regex capturing label in group 1
  const combined = new RegExp(`\\b(${labels.join('|')})\\b`, 'g');

  // Get all workspace files once
  const allWorkspaceFiles = await vscode.workspace.findFiles(
    `**/*.{${FILE_EXTENSIONS.join(',')}}`,
    EXCLUDE_GLOBS
  );

  // Process each file once — streaming matches and mapping back to nodes
  const limit = pLimit(DEFAULT_CONCURRENCY);
  const filePromises = allWorkspaceFiles.map(fileUri =>
    limit(async () => {
      try {
        const fileKey = fileUri.toString();
        let text = fileTextCache.get(fileKey);
        if (text === undefined) {
          const doc = await vscode.workspace.openTextDocument(fileUri);
          text = doc.getText();
          fileTextCache.set(fileKey, text);
        }

        let match: RegExpExecArray | null;
        while ((match = combined.exec(text)) !== null) {
          const matchedLabel = match[1];
          const node = labelToNode.get(matchedLabel);
          if (!node) {continue;}

          // Which symbol contains this position?
          const doc = await vscode.workspace.openTextDocument(fileUri);
          const pos = doc.positionAt(match.index);
          const fromNodeId = findContainingSymbolId(fileKey, pos);
          if (fromNodeId && fromNodeId !== node.id && graph.nodes.has(fromNodeId)) {
            const edgeLabel =
              node.kind === 'Function' || node.kind === 'Method' ? EdgeType.CALLS : EdgeType.REFERENCES;
            graph.addEdge({ from: fromNodeId, to: node.id, label: edgeLabel });
          }
        }
      } catch {
        // keep logs light for large workspaces
        console.warn(
          `[SaralFlow Graph] Could not scan file for manual relationships: ${fileUri.toString()}`
        );
      }
    })
  );

  await Promise.all(filePromises);
}

/**
 * Processes a single file, adds the File node and symbol nodes + CONTAINS edges.
 * Also starts embedding generation for nodes as they are created (pipelined).
 */
async function processFileAndAddNodes(
  fileUri: vscode.Uri,
  graph: CodeGraph,
  documentCache: DocumentCache,
  fileTextCache: Map<string, string>,
  embeddingLimit: (fn: () => Promise<any>) => Promise<any>,
  newNodesCollector: INode[],
  allEmbeddingPromises: Promise<void>[] // <-- NEW
): Promise<void> {
  const relativePath = vscode.workspace.asRelativePath(fileUri, true);
  const fileNodeId = fileUri.toString();

  try {
    const document = await getDocumentCached(fileUri, documentCache);
    const fileText = document.getText();
    fileTextCache.set(fileNodeId, fileText);

    // Create File node
    const fileNode: INode = {
      id: fileNodeId,
      label: relativePath,
      kind: 'File',
      detail: '',
      uri: fileNodeId,
      range: new vscode.Range(0, 0, 0, 0),
      codeSnippet: fileText
    };
    graph.addNode(fileNode);
    newNodesCollector.push(fileNode);

    // Pull document symbols
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
            codeSnippet
          };

          graph.addNode(symbolNode);
          newNodesCollector.push(symbolNode);
          graph.addEdge({ from: parentId, to: symbolId, label: EdgeType.CONTAINS });
          symbolsInFile.push(symbolNode);

          // Start embedding pipeline and track promise
          if (symbolNode.codeSnippet) {
            const textToEmbed = `${symbolNode.kind}: ${symbolNode.label}\n${symbolNode.detail || ''}\n${symbolNode.codeSnippet}`;
            const truncated = textToEmbed.length > 8000 ? textToEmbed.substring(0, 8000) : textToEmbed;

            const p = embeddingLimit(async () => {
              try {
                const emb = await getEmbeddingViaCloudFunction(truncated, statToken);
                if (emb) { symbolNode.embedding = emb; }
              } catch (e) {
                console.error(`[SaralFlow Graph] Embedding error for ${symbolNode.label}: ${e}`);
              }
            });
            allEmbeddingPromises.push(p);
          }
        }

        // Recurse into children
        if (symbol.children && symbol.children.length > 0) {
          symbol.children.forEach(child => processSymbol(child, symbolId));
        }
      };

      documentSymbols.forEach(topLevel => processSymbol(topLevel, fileNodeId));

      // Sort symbols for binary search
      symbolsInFile.sort((a, b) => {
        if (!a.range || !b.range) return 0;
        return a.range.start.line - b.range.start.line ||
               a.range.start.character - b.range.start.character;
      });
      fileSymbolsMap.set(fileUri.toString(), symbolsInFile);
    }
  } catch (error: any) {
    console.error(`[SaralFlow Graph] Failed to process ${relativePath}: ${error.message}`);
  }
}

/** Removes nodes/edges from the shared semanticGraph for a given file */
export function removeFileNodesFromGraph(fileUri: vscode.Uri) {
  const fileUriStr = fileUri.toString();
  const nodesToRemove = Array.from(semanticGraph.nodes.values()).filter(
    node => node.uri === fileUriStr
  );
  const removedNodeIds = new Set(nodesToRemove.map(node => node.id));

  nodesToRemove.forEach(node => semanticGraph.nodes.delete(node.id));

  semanticGraph.edges = semanticGraph.edges.filter(
    edge => !removedNodeIds.has(edge.from) && !removedNodeIds.has(edge.to)
  );
}

/**
 * Re-embed nodes in the graph that don't have embeddings (uses static key; no Firebase check).
 */
export async function reEmbedGraphNodes() {
  const unembeddedNodes = Array.from(semanticGraph.nodes.values()).filter(
    n => !n.embedding && n.codeSnippet
  );
  if (unembeddedNodes.length === 0) {
    console.log('[SaralFlow Graph] No nodes found requiring re-embedding.');
    return;
  }

  console.log(`[SaralFlow Graph] Found ${unembeddedNodes.length} nodes to re-embed.`);
  const embeddingLimit = pLimit(EMBEDDING_CONCURRENCY);

  const results = await Promise.all(
    unembeddedNodes.map(n =>
      embeddingLimit(async () => {
        const text = `${n.kind}: ${n.label}\n${n.detail || ''}\n${n.codeSnippet}`;
        const truncated = text.length > 8000 ? text.substring(0, 8000) : text;
        try {
          const e = await getEmbeddingViaCloudFunction(truncated, statToken);
          if (e) {n.embedding = e;}
          return true;
        } catch (err) {
          console.error(`[SaralFlow Graph] Error re-embedding ${n.label}: ${err}`);
          return false;
        }
      })
    )
  );

  const successCount = results.filter(Boolean).length;
  console.log(
    `[SaralFlow Graph] Finished re-embedding. Successfully re-embedded ${successCount} nodes.`
  );
}
