import type { ISemanticGraph, INode } from './types/graphTypes';
import { PackedCosineIndex } from './packedCosineIndex';

type GraphLike =
    | ISemanticGraph
    | { nodes: Map<string, INode>; edges?: any }; // edges unused by search

export class GraphSearch {
    private index = new PackedCosineIndex(4096);
    private nodeById = new Map<string, INode>();

    constructor(graph?: GraphLike) {
        if (graph) { this.build(graph); }
    }

    build(graph: GraphLike) {
        this.nodeById.clear();

        const nodesArr: INode[] = Array.isArray((graph as ISemanticGraph).nodes)
            ? (graph as ISemanticGraph).nodes as INode[]
            : Array.from((graph as { nodes: Map<string, INode> }).nodes.values());

        for (const n of nodesArr) {
            this.nodeById.set(n.id, n);
            if (n.embedding?.length) {this.index.upsert(n.id, n.embedding);}
        }
    }

    // call when a node’s embedding changed or a node was added
    upsertNode(node: INode) {
        this.nodeById.set(node.id, node);
        if (node.embedding && node.embedding.length) {
            this.index.upsert(node.id, node.embedding);
        } else {
            // if it lost its embedding, treat as removal from the index
            this.index.remove(node.id);
        }
    }

    // call when a node is removed from graph
    removeNode(nodeId: string) {
        this.nodeById.delete(nodeId);
        this.index.remove(nodeId);
    }

    // optional: housekeeping after many edits
    compact() {
        this.index.compact();
    }

    // main entry point: returns { node, score }[]
    search(storyEmbedding: number[], topK = 20) {
        const hits = this.index.search(storyEmbedding, topK);
        return hits.map(h => {
            const node = this.nodeById.get(h.id)!; // present by construction
            return { node, score: h.score };
        });
    }
}
