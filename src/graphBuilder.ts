import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { CodeGraph, INode, EdgeType, generateNodeId } from './types/graphTypes';
import { getEmbeddingViaCloudFunction } from './embeddingService';
import { semanticGraph, buildGraphWithStatus, suppressPathOnce, graphSearch } from './extension';
import pLimit from 'p-limit';
import { minimatch } from "minimatch";
import { GraphSearch } from './graphSearch';

// ===== Tunables =====
const CPU_COUNT = Math.max(1, os.cpus?.().length || 4);
const DEFAULT_CONCURRENCY = Math.max(4, Math.floor(CPU_COUNT * 1.5)); // adaptive
const EMBEDDING_CONCURRENCY = Math.max(4, Math.floor(CPU_COUNT));
const GRAPH_CACHE_NAME = '.vscode/.s2c-graph-cache.json';
const initialLSPWaitTimeMs = 12_000;
export let graphBuildInProgress = false;
export const pendingFileChanges = new Set<vscode.Uri>();

const FILE_EXTENSIONS = [
  'ts', 'tsx', 'js', 'jsx',   // Frontend & Node
  'cs', 'py', 'sql',          // Backend & data
  'json', 'md', 'ipynb',      // Config, docs, notebooks
  'html', 'css', 'scss',      // Angular/React templates & styles
  'vue'                       // Vue SFCs
];

const MAX_EMBED_CHARS = 24000;        // ~6k tokens ballpark
const MAX_SNIPPET_CHARS = 12000;      // cap for single symbol snippet
const MAX_FILE_EMBED_CHARS = 4000;    // file "summary" cap
const RETRY_EMBED_CHARS = 8000;       // fallback size if API complains

function safeSlice(s: string, max: number) {
  return s.length > max ? s.slice(0, max) : s;
}

function isMaxContextError(e: unknown): boolean {
  const msg = String((e as any)?.message ?? (e as any)?.error ?? e ?? '');
  return /maximum context length|requested \d+ tokens/i.test(msg);
}


function normalizePatterns(value: string | string[] | undefined, defaults: string[]): string[] {
  if (!value) { return defaults; }
  if (Array.isArray(value)) { return value; }
  return [value]; // wrap single string into array
}

export function getGraphGlobs() {
  const cfg = vscode.workspace.getConfiguration('saralflow');

  const includeRaw = cfg.get<string[] | string>("graph.include", ["**/*"]);
  const excludeRaw = cfg.get<string[] | string>("graph.exclude", [
    "**/node_modules/**",
    "**/dist/**",
    "**/build/**",
    "**/out/**",
    "**/.next/**",
    "**/.nuxt/**",
    "**/bin/**",
    "**/obj/**",
    "**/__pycache__/**",
    "**/.venv/**",
    "**/.vscode/**",
    "**/.angular/**",
    "**/*.min.js",
    "**/*.min.css",
    "**/*.bundle.js",
    "**/*.chunk.js",
    "**/*.map",
    "**/*.d.ts",
    "**/*.spec.{ts,js}",
    "**/*.test.{ts,js}",
    "**/angular.json",
    "**/package-lock.json",
    "**/yarn.lock"
  ]);

  const includeGlobs = normalizePatterns(includeRaw, ["**/*"]);
  const excludeGlobs = normalizePatterns(excludeRaw, []);

  // Apply FILE_EXTENSIONS filter
  const includeWithExtensions = includeGlobs.map(glob =>
    glob.endsWith("/") || glob.endsWith("**")
      ? `${glob}/**/*.{${FILE_EXTENSIONS.join(',')}}`
      : `${glob}.{${FILE_EXTENSIONS.join(',')}}`
  );

  return { includeWithExtensions, excludeGlobs };
}

function isFolderExcludeGlob(p: string): boolean {
  // Safe to combine if it targets a folder tree and uses no brace alternation
  // Examples: **/node_modules/**, **/.vscode/**, **/dist/**, **/.angular/**
  return p.endsWith("/**") && !p.includes("{") && !p.includes("}");
}

function combineFolderExcludesForVscode(excludePatterns: string[]): string | undefined {
  const folderOnly = Array.from(new Set(excludePatterns.filter(isFolderExcludeGlob)));
  if (folderOnly.length === 0) { return undefined; }

  // Combine into a single brace group without nesting inner braces
  // e.g. {**/node_modules/**,**/.vscode/**,**/dist/**}
  return `{${folderOnly.join(",")}}`;
}

function isExcluded(uri: vscode.Uri, excludePatterns: string[]): boolean {
  const posix = uri.fsPath.replace(/\\/g, "/");
  const nocase = process.platform === "win32"; // Windows FS is case-insensitive
  return excludePatterns.some(pattern =>
    minimatch(posix, pattern, { dot: true, nocase })
  );
}

async function findWorkspaceFiles(
  includePatterns: string[],
  excludePatterns: string[]
): Promise<vscode.Uri[]> {
  const results: vscode.Uri[] = [];
  const excludeCombined = combineFolderExcludesForVscode(excludePatterns);

  // Try with folder-level excludes first (fast path)
  for (const include of includePatterns) {
    try {
      const matches = await vscode.workspace.findFiles(include, excludeCombined);
      results.push(...matches);
    } catch (err) {
      // Fallback: if the glob engine complains, retry without excludes
      console.warn("[SaralFlow Graph] findFiles exclude combine failed; retrying without exclude.", err);
      const matches = await vscode.workspace.findFiles(include);
      results.push(...matches);
    }
  }

  // Final safety net: apply the full exclude list (including file-level patterns)
  return results.filter(uri => !isExcluded(uri, excludePatterns));
}

export const statToken = '9XtremeThermo$teel';

// ===== Internal caches =====
type DocumentCache = Map<string, vscode.TextDocument>;
const fileSymbolsMap = new Map<string, INode[]>();

// ===== Cache helpers =====
function getCachePath(): string {
  const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  return root ? path.join(root, GRAPH_CACHE_NAME) : '';
}

function saveGraphToCache(graph: CodeGraph) {
  const cachePath = getCachePath();
  if (!cachePath) { return; }

  // Ensure parent folder exists
  const dir = path.dirname(cachePath);
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch (err) {
    console.warn(`[SaralFlow Graph] Failed to ensure cache dir: ${err}`);
    return;
  }

  const timestamps: Record<string, number> = {};
  for (const node of graph.nodes.values()) {
    if (node.kind === 'File') {
      try {
        timestamps[node.uri] = fs.statSync(vscode.Uri.parse(node.uri).fsPath).mtimeMs;
      } catch { }
    }
  }

  const cacheData = {
    nodes: Array.from(graph.nodes.values()),
    edges: graph.edges,
    timestamps
  };

  try {
    fs.writeFileSync(cachePath, JSON.stringify(cacheData), 'utf8');
    suppressPathOnce(path.resolve(cachePath));
  } catch (err) {
    console.warn(`[SaralFlow Graph] Failed to write cache: ${err}`);
  }
}


async function loadGraphFromCache(): Promise<vscode.Uri[]> {
  const cachePath = getCachePath();
  if (!cachePath || !fs.existsSync(cachePath)) { return []; }

  try {
    const cache = JSON.parse(fs.readFileSync(cachePath, 'utf8'));

    // Rehydrate nodes/edges
    semanticGraph.nodes = new Map<string, INode>(
      cache.nodes.map((n: INode) => [n.id, n])
    );
    semanticGraph.edges = cache.edges;

    // ⬅️ Rebuild GraphSearch (fast, in-memory)
    graphSearch.build({ nodes: semanticGraph.nodes });

    // Detect changed files
    const changedFiles: vscode.Uri[] = [];
    for (const [uri, oldTime] of Object.entries(cache.timestamps as Record<string, number>)) {
      try {
        const fsPath = vscode.Uri.parse(uri).fsPath;
        const newTime = fs.statSync(fsPath).mtimeMs;
        if (newTime !== oldTime) {
          changedFiles.push(vscode.Uri.parse(uri));
        }
      } catch { }
    }
    return changedFiles;
  } catch (err) {
    console.warn(`[SaralFlow Graph] Failed to load cache: ${err}`);
    return [];
  }
}

// ===== Utility =====
function escapeRegexLiteral(s: string) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Finds the ID of the innermost symbol that contains the given position in a specific file.
 * Uses binary search over pre-sorted symbols for performance.
 */
function findContainingSymbolId(fileUriStr: string, position: vscode.Position): string | null {
  const symbols = fileSymbolsMap.get(fileUriStr);
  if (!symbols || symbols.length === 0) { return null; }
  let low = 0;
  let high = symbols.length - 1;
  let innermostSymbol: INode | null = null;
  while (low <= high) {
    const midIndex = Math.floor((low + high) / 2);
    const symbol = symbols[midIndex];
    if (symbol.range && symbol.range.contains(position)) {
      innermostSymbol = symbol;
      low = midIndex + 1;
    } else if (symbol.range && position.isBefore(symbol.range.start)) {
      high = midIndex - 1;
    } else {
      low = midIndex + 1;
    }
  }
  return innermostSymbol ? innermostSymbol.id : fileUriStr;
}
/**
 * Remove all nodes/edges that belong to a file from the global graph.
 */
export function removeFileNodesFromGraph(fileUri: vscode.Uri) {
  const graph = semanticGraph;
  const fileId = fileUri.toString();
  const idPrefix = `${fileId}#`;

  // Remove nodes belonging to this file
  for (const id of Array.from(graph.nodes.keys())) {
    if (id === fileId || id.startsWith(idPrefix)) {
      graph.nodes.delete(id);
    }
  }
  // Compact edges to only those whose nodes still exist
  graph.edges = graph.edges.filter(e => graph.nodes.has(e.from) && graph.nodes.has(e.to));
  // Forget symbol index for this file (caller also clears caches)
  fileSymbolsMap.delete(fileId);
}

/**
 * Top-level function to extract or incrementally update the semantic graph.
 */
export async function extractSemanticGraph(
  filesToProcess?: vscode.Uri[],
  onProgress?: (message: string) => void
): Promise<CodeGraph> {
  if (!vscode.workspace.workspaceFolders || vscode.workspace.workspaceFolders.length === 0) {
    return new CodeGraph();
  }

  graphBuildInProgress = true;
  const graph = semanticGraph;
  const documentCache: DocumentCache = new Map();
  const fileTextCache: Map<string, string> = new Map();
  const newNodesInThisUpdate: INode[] = [];
  const allEmbeddingPromises: Promise<void>[] = [];

  const workLimit = pLimit(DEFAULT_CONCURRENCY);
  const embeddingLimit = pLimit(EMBEDDING_CONCURRENCY);

  let isIncremental = !!(filesToProcess && filesToProcess.length > 0);

  // Load from cache if no files provided
  if (!filesToProcess) {
    const changedFiles = await loadGraphFromCache();
    if (semanticGraph.nodes.size > 0 && changedFiles.length === 0) {
      onProgress?.('Loaded graph from cache — no changes detected.');
      return graph;
    }
    if (semanticGraph.nodes.size > 0 && changedFiles.length > 0) {
      onProgress?.(`Loaded graph from cache — ${changedFiles.length} files changed.`);
      filesToProcess = changedFiles;
      isIncremental = true;
    }
  }

  if (isIncremental) {
    onProgress?.(`Incremental update for ${filesToProcess!.length} files...`);
    filesToProcess!.forEach(fileUri => {
      removeFileNodesFromGraph(fileUri);
      fileSymbolsMap.delete(fileUri.toString());
      fileTextCache.delete(fileUri.toString());
    });
  } else {
    onProgress?.('Waiting for LSP load...');
    await new Promise(resolve => setTimeout(resolve, initialLSPWaitTimeMs));
    onProgress?.('Learning your project...');
    const { includeWithExtensions, excludeGlobs } = getGraphGlobs();
    const files = await findWorkspaceFiles(includeWithExtensions, excludeGlobs);
    if (files.length === 0) {
      onProgress?.('No matching files found');
      return graph;
    }
    graph.nodes.clear();
    graph.edges = [];
    fileSymbolsMap.clear();
    filesToProcess = files;
  }

  if (filesToProcess!.length === 0) {
    onProgress?.('No files to process — graph unchanged.');
    return graph;
  }

  // Process files with progress count
  onProgress?.('Processing files...');
  let processedCount = 0;
  const totalFiles = filesToProcess!.length;
  const fileProcessing = filesToProcess!.map(fileUri =>
    workLimit(async () => {
      await processFileAndAddNodes(
        fileUri,
        graph,
        documentCache,
        fileTextCache,
        embeddingLimit,
        newNodesInThisUpdate,
        allEmbeddingPromises
      );
      processedCount++;
      onProgress?.(`Processed ${processedCount}/${totalFiles} files`);
    })
  );
  await Promise.all(fileProcessing);

  // LSP passes with progress count
  const nodesToProcessForRefs = isIncremental ? newNodesInThisUpdate : Array.from(graph.nodes.values());
  const limitedNodesToProcessForRefs = nodesToProcessForRefs.filter(
    node =>
      node.kind === 'Class' ||
      node.kind === 'Method' ||
      node.kind === 'Function' ||
      node.kind === 'Interface'
  );
  onProgress?.('Analyzing interdependencies...');
  let lspDone = 0;
  const totalLsp = limitedNodesToProcessForRefs.length;
  const lspPasses = limitedNodesToProcessForRefs.map(node =>
    workLimit(async () => {
      await processAllLspForNode(node, graph, documentCache);
      lspDone++;
      onProgress?.(`LSP analysis ${lspDone}/${totalLsp} nodes`);
    })
  );
  await Promise.all(lspPasses);

  // Manual scan with progress
  const relTargets = isIncremental
    ? getTwoLayerNeighborhood(graph, newNodesInThisUpdate)
    : nodesToProcessForRefs;
  onProgress?.('Finding cross-file references...');
  let relDone = 0;
  const totalRelTargets = relTargets.length;
  await findCrossFileRelationshipsManually(
    graph,
    relTargets,
    fileTextCache,
    documentCache,
    async fn => {
      const result = await workLimit(fn);
      relDone++;
      onProgress?.(`Regex scan ${relDone}/${totalRelTargets} targets`);
      return result;
    }
  );

  const totalEmbeddings = allEmbeddingPromises.length;
  let completedEmbeddings = 0;

  // Await embeddings
  onProgress?.('Finalizing embeddings...');
  await Promise.all(
    allEmbeddingPromises.map(p =>
      p.then(() => {
        completedEmbeddings++;
        // update every 10 embeddings or at the end
        if (completedEmbeddings % 10 === 0 || completedEmbeddings === totalEmbeddings) {
          onProgress?.(
            `Embedded ${completedEmbeddings}/${totalEmbeddings} nodes`
          );
        }
      })
    )
  );

  if (pendingFileChanges.size > 0) {
    const uris = Array.from(pendingFileChanges);
    pendingFileChanges.clear();
    await buildGraphWithStatus(uris);
  }

  graphBuildInProgress = false;
  // Save after build/update
  saveGraphToCache(graph);

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
      if (e.from === nodeId && !ids.has(e.to)) { ids.add(e.to); }
      if (e.to === nodeId && !ids.has(e.from)) { ids.add(e.from); }
    }
  };
  baseNodes.forEach(n => addConnected(n.id));
  Array.from(ids).forEach(id => addConnected(id));
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
 * Parallelized LSP processing for a node.
 */
async function processAllLspForNode(
  node: INode,
  graph: CodeGraph,
  documentCache: DocumentCache
): Promise<void> {
  if (!node.uri || !node.range) { return; }

  try {
    const document = await getDocumentCached(node.uri, documentCache);
    const tasks: Promise<void>[] = [];

    // Type hierarchy
    if (node.kind === 'Class' || node.kind === 'Interface') {
      tasks.push((async () => {
        try {
          const typeItems = await vscode.commands.executeCommand<vscode.TypeHierarchyItem[]>(
            'vscode.prepareTypeHierarchy',
            document.uri,
            node.range!.start
          );
          if (typeItems && typeItems.length > 0) {
            const supertypes = await vscode.commands.executeCommand<vscode.TypeHierarchyItem[]>(
              'vscode.executeTypeHierarchySupertypes',
              typeItems[0]
            );
            supertypes?.forEach(s => {
              const superId = generateNodeId(s.uri.toString(), s);
              if (graph.nodes.has(superId)) {
                graph.addEdge({ from: node.id, to: superId, label: EdgeType.INHERITS_FROM });
              }
            });
          }
        } catch (err) {
          console.warn(`[SaralFlow Graph] LSP inheritance failed for ${node.label}: ${err}`);
        }
      })());
    }

    // References
    tasks.push((async () => {
      try {
        const refs = await vscode.commands.executeCommand<vscode.Location[]>(
          'vscode.executeReferenceProvider',
          document.uri,
          node.range!.start
        );
        refs?.forEach(ref => {
          const refFileUriStr = ref.uri.toString();
          if (refFileUriStr === node.uri && ref.range.isEqual(node.range!)) { return; } // self
          const fromNodeId = findContainingSymbolId(refFileUriStr, ref.range.start);
          if (fromNodeId && graph.nodes.has(fromNodeId) && fromNodeId !== node.id) {
            graph.addEdge({ from: fromNodeId, to: node.id, label: EdgeType.REFERENCES });
          }
        });
      } catch (err) {
        console.warn(`[SaralFlow Graph] LSP references failed for ${node.label}: ${err}`);
      }
    })());

    // Call hierarchy
    if (node.kind === 'Function' || node.kind === 'Method') {
      tasks.push((async () => {
        try {
          const callItems = await vscode.commands.executeCommand<vscode.CallHierarchyItem[]>(
            'vscode.prepareCallHierarchy',
            document.uri,
            node.range!.start
          );
          if (callItems && callItems.length > 0) {
            const [outgoing, incoming] = await Promise.all([
              vscode.commands.executeCommand<vscode.CallHierarchyOutgoingCall[]>(
                'vscode.executeCallHierarchyOutgoingCalls',
                callItems[0]
              ),
              vscode.commands.executeCommand<vscode.CallHierarchyIncomingCall[]>(
                'vscode.executeCallHierarchyIncomingCalls',
                callItems[0]
              )
            ]);
            outgoing?.forEach(call => {
              const toId = generateNodeId(call.to.uri.toString(), call.to);
              if (graph.nodes.has(toId)) {
                graph.addEdge({ from: node.id, to: toId, label: EdgeType.CALLS });
              }
            });
            incoming?.forEach(call => {
              const fromId = generateNodeId(call.from.uri.toString(), call.from);
              if (graph.nodes.has(fromId)) {
                graph.addEdge({ from: fromId, to: node.id, label: EdgeType.CALLS });
              }
            });
          }
        } catch (err) {
          console.warn(`[SaralFlow Graph] LSP call hierarchy failed for ${node.label}: ${err}`);
          // Fallback: text search to recover some callers
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
      })());
    }

    await Promise.all(tasks);
  } catch (outerErr) {
    console.warn(`[SaralFlow Graph] Processing LSP for ${node.label} failed: ${outerErr}`);
  }
}

/**
 * Manual cross-file relationship finder.
 * - Opens each file once (reuses doc for text & position)
 * - In incremental runs, narrows to neighborhood file URIs when possible
 */
async function findCrossFileRelationshipsManually(
  graph: CodeGraph,
  nodesToSearchFor: INode[],
  fileTextCache: Map<string, string>,
  documentCache: DocumentCache,
  workWrapper: <T>(fn: () => Promise<T>) => Promise<T>
) {
  const labelToNode = new Map<string, INode>();
  const labels: string[] = [];

  for (const node of nodesToSearchFor) {
    if (node.label && node.kind !== 'File' && node.kind !== 'Module') {
      labelToNode.set(node.label, node);
      labels.push(escapeRegexLiteral(node.label));
    }
  }
  if (labels.length === 0) { return; }

  const combined = new RegExp(`\\b(${labels.join('|')})\\b`, 'g');

  // Try to scan only files in this neighborhood
  const uriHints = new Set<string>();
  for (const n of nodesToSearchFor) {
    if (n.uri) { uriHints.add(n.uri); }
  }
  const { includeWithExtensions, excludeGlobs } = getGraphGlobs();
  const allWorkspaceFiles = await findWorkspaceFiles(includeWithExtensions, excludeGlobs);
  const filesToScan = uriHints.size > 0
    ? allWorkspaceFiles.filter(u => uriHints.has(u.toString()))
    : allWorkspaceFiles;

  const filePromises = filesToScan.map(fileUri =>
    workWrapper(async () => {
      try {
        const fileKey = fileUri.toString();
        const doc = await getDocumentCached(fileUri, documentCache);
        let text = fileTextCache.get(fileKey);
        if (text === undefined) {
          text = doc.getText();
          fileTextCache.set(fileKey, text);
        }
        let match: RegExpExecArray | null;
        while ((match = combined.exec(text)) !== null) {
          const matchedLabel = match[1];
          const node = labelToNode.get(matchedLabel);
          if (!node) { continue; }
          const pos = doc.positionAt(match.index);
          const fromNodeId = findContainingSymbolId(fileKey, pos);
          if (fromNodeId && fromNodeId !== node.id && graph.nodes.has(fromNodeId)) {
            const edgeLabel =
              node.kind === 'Function' || node.kind === 'Method' ? EdgeType.CALLS : EdgeType.REFERENCES;
            graph.addEdge({ from: fromNodeId, to: node.id, label: edgeLabel });
          }
        }
      } catch {
        console.warn(`[SaralFlow Graph] Could not scan file for manual relationships: ${fileUri.toString()}`);
      }
    })
  );

  await Promise.all(filePromises);
}

/**
 * Processes a single file, adds the File node and symbol nodes + CONTAINS edges.
 * Also queues embeddings for symbol nodes (awaited at the very end of extractSemanticGraph).
 */
/** 
 * Processes a single file, adds the File node and symbol nodes + CONTAINS edges.
 * Also queues embeddings for symbol nodes (awaited at the very end of extractSemanticGraph).
 */
export async function processFileAndAddNodes(
  fileUri: vscode.Uri,
  graph: CodeGraph,
  documentCache: DocumentCache,
  fileTextCache: Map<string, string>,
  embeddingLimit: <T>(fn: () => Promise<T>) => Promise<T>,
  newNodesCollector: INode[],
  allEmbeddingPromises: Promise<void>[]
): Promise<void> {
  try {
    const uriStr = fileUri.toString();
    const isIpynb = fileUri.fsPath.toLowerCase().endsWith('.ipynb');

    let doc: vscode.TextDocument | null = null;
    let fullText = '';

    // Load file text — special handling for .ipynb
    if (isIpynb) {
      try {
        const raw = fs.readFileSync(fileUri.fsPath, 'utf8');
        const nb = JSON.parse(raw);
        const codeCells = Array.isArray(nb?.cells)
          ? nb.cells.filter((c: any) => c?.cell_type === 'code')
          : [];
        const chunks: string[] = [];
        for (const c of codeCells) {
          const src = Array.isArray(c?.source) ? c.source.join('') : (c?.source ?? '');
          chunks.push(String(src));
        }
        fullText = chunks.join('\n\n');
      } catch (err) {
        console.warn(`[SaralFlow Graph] Failed to parse ipynb: ${fileUri.fsPath}`, err);
        return;
      }
    } else {
      doc = await getDocumentCached(fileUri, documentCache);
      fullText = doc.getText();
    }

    // Cache file text for manual relationship scanning
    fileTextCache.set(uriStr, fullText);

    // Create file node
    const fileNode: INode = {
      id: uriStr,
      label: path.basename(fileUri.fsPath),
      kind: 'File',
      uri: uriStr,
      range: new vscode.Range(new vscode.Position(0, 0), new vscode.Position(0, 0))
    };
    graph.addNode(fileNode);
    newNodesCollector.push(fileNode);

    const symbolNodes: INode[] = [];

    // Try LSP first (skip for ipynb to avoid delays)
    let lspItems: vscode.DocumentSymbol[] | undefined;
    if (!isIpynb) {
      try {
        const provided = await vscode.commands.executeCommand<any>(
          'vscode.executeDocumentSymbolProvider',
          fileUri
        );
        if (Array.isArray(provided) && provided.length > 0) {
          const flat: vscode.DocumentSymbol[] = [];
          const flatten = (syms: vscode.DocumentSymbol[]) => {
            for (const s of syms) {
              flat.push(s);
              if (s.children?.length) { flatten(s.children); }
            }
          };
          flatten(provided as vscode.DocumentSymbol[]);

          for (const sym of flat) {
            const range = sym.range;
            const kindStr = vscode.SymbolKind[sym.kind] as unknown as string;
            const id = `${uriStr}#${sym.name}:${range.start.line}:${range.start.character}`;
            const codeSnippet = doc?.getText(range) ?? '';
            const node: INode = {
              id,
              label: sym.name,
              kind: kindStr,
              uri: uriStr,
              range,
              codeSnippet
            };
            graph.addNode(node);
            graph.addEdge({ from: fileNode.id, to: node.id, label: EdgeType.CONTAINS });
            symbolNodes.push(node);
            newNodesCollector.push(node);
          }
        }
      } catch {
        // ignore LSP errors
      }
    }

    // Fallback symbol extraction (for ipynb or when LSP returns nothing)
    if (symbolNodes.length === 0 && fullText.trim().length > 0) {
      const lines = fullText.split(/\r?\n/);
      const defRe = /^[ \t]*def[ \t]+([A-Za-z_][A-Za-z0-9_]*)/;
      const classRe = /^[ \t]*class[ \t]+([A-Za-z_][A-Za-z0-9_]*)/;

      lines.forEach((line, idx) => {
        let match: RegExpExecArray | null;
        if ((match = defRe.exec(line))) {
          const name = match[1];
          const range = new vscode.Range(idx, 0, idx, line.length);
          const id = `${uriStr}#${name}:${idx}:0`;
          const node: INode = {
            id,
            label: name,
            kind: 'Function',
            uri: uriStr,
            range,
            codeSnippet: line
          };
          graph.addNode(node);
          graph.addEdge({ from: fileNode.id, to: node.id, label: EdgeType.CONTAINS });
          symbolNodes.push(node);
          newNodesCollector.push(node);
        } else if ((match = classRe.exec(line))) {
          const name = match[1];
          const range = new vscode.Range(idx, 0, idx, line.length);
          const id = `${uriStr}#${name}:${idx}:0`;
          const node: INode = {
            id,
            label: name,
            kind: 'Class',
            uri: uriStr,
            range,
            codeSnippet: line
          };
          graph.addNode(node);
          graph.addEdge({ from: fileNode.id, to: node.id, label: EdgeType.CONTAINS });
          symbolNodes.push(node);
          newNodesCollector.push(node);
        }
      });
    }

    // Save sorted symbols to fileSymbolsMap for manual relationship scanning
    fileSymbolsMap.set(
      uriStr,
      symbolNodes.sort((a, b) => a.range!.start.line - b.range!.start.line)
    );

    // Queue embeddings for file + symbols
    const queueEmbeddings = (nodes: INode[]) => {
      for (const node of nodes) {
        if (!node.embedding || node.embedding.length === 0) {
          const p = embeddingLimit(async () => {
            try {
              let text: string;

              if (node.kind === 'File') {
                // Compact file summary for file nodes
                text = buildFileEmbeddingText({
                  uri: node.uri || uriStr,
                  fileName: path.basename(fileUri.fsPath),
                  fullText,
                  symbolNodesInFile: symbolNodes,
                  maxChars: MAX_FILE_EMBED_CHARS
                });
              } else {
                // Rich symbol embedding: add filePath/language and safe defaults
                text = buildEmbeddingText({
                  kind: node.kind,
                  label: node.label,
                  detail: node.detail,
                  codeSnippet: node.codeSnippet ?? '',
                  path: path.basename(fileUri.fsPath),
                  language: guessLanguageFromUri(node.uri || uriStr),
                  // signatureLine can be threaded in if you want:
                  // signatureLine: firstNonEmptyLine(node.codeSnippet ?? '')
                });
              }

              try {
                const emb = await getEmbeddingViaCloudFunction(text, statToken);
                node.embedding = Array.isArray(emb) ? emb : [];
              } catch (e) {
                if (isMaxContextError(e)) {
                  // retry with a shorter payload derived from the same text
                  const shorter = safeSlice(text, RETRY_EMBED_CHARS);
                  const emb2 = await getEmbeddingViaCloudFunction(shorter, statToken);
                  node.embedding = Array.isArray(emb2) ? emb2 : [];
                } else {
                  throw e;
                }
              }
            } catch (e) {
              console.warn(`[SaralFlow Graph] Embedding failed for ${node.id}:`, e);
              node.embedding = [];
            }
          }).then(() => undefined);
          allEmbeddingPromises.push(p);
        }
      }
    };

    queueEmbeddings([fileNode, ...symbolNodes]);
  } catch (err) {
    console.error(`[SaralFlow Graph] Error processing file ${fileUri.fsPath}:`, err);
  }
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
        const text = buildEmbeddingText({
          kind: n.kind,
          label: n.label,
          detail: n.detail,
          codeSnippet: n.codeSnippet ?? "",
        });

        // Truncate from the END (code section) — metadata stays intact.
        const truncated = text.length > MAX_EMBED_CHARS ? text.slice(0, MAX_EMBED_CHARS) : text;

        try {
          const e = await getEmbeddingViaCloudFunction(truncated, statToken);
          if (e) { n.embedding = e; }
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


function splitIdentifiers(s: string): string[] {
  // Split camelCase/PascalCase, snake_case, kebab-case, and dots
  const raw = s
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')  // camel→space
    .replace(/[_\-.]+/g, ' ')                 // snake/kebab/dots→space
    .toLowerCase();
  const toks = raw.split(/\s+/).filter(Boolean);
  // keep unigrams + join bigrams for better match with NL phrases
  const bigrams: string[] = [];
  for (let i = 0; i < toks.length - 1; i++) { bigrams.push(`${toks[i]} ${toks[i + 1]}`); }
  return Array.from(new Set([...toks, ...bigrams]));
}

function buildEmbeddingText(n: {
  kind: string;            // e.g., "class" | "property" | "method"
  label: string;           // e.g., "MotherName"
  detail?: string;         // optional docstring/signature
  codeSnippet: string;     // code block
  path?: string;           // file path if you have it
  language?: string;       // "csharp" | "typescript" | ...
}): string {
  const identifiers = Array.from(new Set([
    n.label,
    ...splitIdentifiers(n.label),
    ...splitIdentifiers(n.codeSnippet.match(/[A-Za-z_][A-Za-z0-9_]*/g)?.join(' ') || '')
  ]));
  const actions = ['add', 'remove', 'delete', 'rename', 'update', 'deprecate', 'migrate'];

  // Put the most useful stuff FIRST; CODE is last and can be truncated safely.
  const header = [
    `FILE: ${n.path || '(unknown)'}`,
    `LANG: ${n.language || 'plain'}`,
    `KIND: ${n.kind}`,
    `LABEL: ${n.label}`,
    `IDENTIFIERS: ${identifiers.slice(0, 50).join(', ')}`,   // cap to keep concise
    `ACTIONS: ${actions.join(', ')}`
  ].join('\n');

  const detail = n.detail ? `\nDETAIL:\n${n.detail.trim()}` : '';

  return `${header}${detail}\n\nCODE:\n${n.codeSnippet}`;
}


/**
 * Build a compact file-level embedding payload:
 * - LANGUAGE + imports/includes
 * - top-level symbols (kind:name)
 */
function buildFileEmbeddingText(params: {
  uri: string;
  fileName: string;
  fullText: string;
  symbolNodesInFile: INode[];
  maxChars: number;
}): string {
  const { uri, fileName, fullText, symbolNodesInFile, maxChars } = params;
  const lang = guessLanguageFromUri(uri);

  const imports = (fullText.match(
    /^(?:\s*import\s.+|#include\s.+|from\s.+\simport\s.+)/gmi
  ) || []).slice(0, 100).join('\n');

  const topSymbols = symbolNodesInFile
    .filter(s => s.uri === uri)
    .slice(0, 200)
    .map(s => `${s.kind}:${s.label}`)
    .join('\n');

  const header = `File: ${fileName}\nURI: ${uri}\nLANGUAGE: ${lang}\n`;
  const body = [imports, '--- symbols ---', topSymbols]
    .filter(Boolean)
    .join('\n');

  return safeSlice(header + body, maxChars);
}


function guessLanguageFromUri(uriStr: string): string {
  const ext = (uriStr.split('.').pop() || '').toLowerCase();
  const map: Record<string, string> = {
    ts: 'TypeScript', tsx: 'TypeScript',
    js: 'JavaScript', jsx: 'JavaScript',
    cs: 'C#', java: 'Java',
    py: 'Python', go: 'Go',
    rs: 'Rust', php: 'PHP',
    cpp: 'C++', c: 'C',
    kt: 'Kotlin', swift: 'Swift',
    rb: 'Ruby'
  };
  return map[ext] || ext;
}

function firstNonEmptyLine(s: string): string {
  return (s || '').split(/\r?\n/).find(l => l.trim().length > 0) ?? '';
}