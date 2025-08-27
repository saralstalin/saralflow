export type NodeId = string;

export class PackedCosineIndex {
    private dim = 0;
    private data = new Float32Array(0);     // row-major: [row0..row0, row1..row1, ...]
    private ids: NodeId[] = [];             // row -> nodeId ('' means free/tombstone)
    private rowOf = new Map<NodeId, number>(); // nodeId -> row
    private freeRows: number[] = [];
    private size = 0;                       // highest used row count (includes free rows)
    constructor(private initialRows = 2048, private growthFactor = 1.5) { }

    private ensureCapacity(rowsNeeded: number, dim: number) {
        if (this.dim === 0) { this.dim = dim; }
        if (this.dim !== dim) { throw new Error(`Embedding dimension changed: ${this.dim} -> ${dim}`); }
        const need = rowsNeeded * dim;
        if (this.data.length >= need) { return; }
        const currentRows = this.data.length ? this.data.length / dim : 0;
        const newRows = Math.max(
            Math.ceil(currentRows * this.growthFactor),
            rowsNeeded,
            this.initialRows
        );
        const next = new Float32Array(newRows * dim);
        if (this.data.length) { next.set(this.data); }
        this.data = next;
        while (this.ids.length < newRows) { this.ids.push(''); }
    }

    private static normalize(v: readonly number[]): Float32Array {
        let n = 0; for (let i = 0; i < v.length; i++) { n += v[i] * v[i]; }
        const out = new Float32Array(v.length);
        if (!n) { return out; }
        const inv = 1 / Math.sqrt(n);
        for (let i = 0; i < v.length; i++) { out[i] = v[i] * inv; }
        return out;
    }

    upsert(nodeId: NodeId, embedding: readonly number[]) {
        const dim = embedding.length;
        const norm = PackedCosineIndex.normalize(embedding);
        let row = this.rowOf.get(nodeId);
        if (row === undefined) {
            row = this.freeRows.pop() ?? this.size++;
            this.ensureCapacity(this.size, dim);
            this.rowOf.set(nodeId, row);
            this.ids[row] = nodeId;
        }
        this.data.set(norm, row * this.dim);
    }

    remove(nodeId: NodeId) {
        const row = this.rowOf.get(nodeId);
        if (row === undefined) { return; }
        this.rowOf.delete(nodeId);
        this.ids[row] = '';
        this.freeRows.push(row);
        // optional: zero out for cleanliness
        this.data.fill(0, row * this.dim, row * this.dim + this.dim);
    }

    compact() {
        if (!this.freeRows.length) { return; }
        const dim = this.dim;
        let write = 0;
        for (let read = 0; read < this.size; read++) {
            const id = this.ids[read];
            if (!id) { continue; }
            if (read !== write) {
                this.data.copyWithin(write * dim, read * dim, read * dim + dim);
                this.ids[write] = id;
                this.rowOf.set(id, write);
            }
            write++;
        }
        for (let r = write; r < this.size; r++) { this.ids[r] = ''; }
        this.size = write;
        this.freeRows = [];
    }

    search(query: readonly number[], topK = 20): Array<{ id: NodeId; score: number }> {
        if (!this.size) { return []; }
        const q = PackedCosineIndex.normalize(query);
        const dim = this.dim;

        // tiny min-heap
        const heapIds: number[] = [];
        const heapScores: number[] = [];
        const push = (idx: number, score: number) => {
            if (heapIds.length < topK) {
                heapIds.push(idx); heapScores.push(score); up(heapScores, heapIds, heapIds.length - 1);
            } else if (score > heapScores[0]) {
                heapIds[0] = idx; heapScores[0] = score; down(heapScores, heapIds, 0);
            }
        };

        for (let row = 0; row < this.size; row++) {
            if (!this.ids[row]) { continue; } // skip free row
            let dot = 0;
            const off = row * dim;
            // small unroll for speed
            let i = 0, end = dim & ~3;
            for (; i < end; i += 4) {
                dot += this.data[off + i] * q[i]
                    + this.data[off + i + 1] * q[i + 1]
                    + this.data[off + i + 2] * q[i + 2]
                    + this.data[off + i + 3] * q[i + 3];
            }
            for (; i < dim; i++) { dot += this.data[off + i] * q[i]; }
            push(row, dot);
        }

        const out = heapIds.map((idx, i) => ({ idx, score: heapScores[i] }))
            .sort((a, b) => b.score - a.score);
        return out.map(o => ({ id: this.ids[o.idx], score: o.score }));
    }
}

function up(scores: number[], ids: number[], i: number) {
    while (i > 0) {
        const p = (i - 1) >> 1;
        if (scores[i] >= scores[p]) { break; }
        [scores[i], scores[p]] = [scores[p], scores[i]];
        [ids[i], ids[p]] = [ids[p], ids[i]];
        i = p;
    }
}
function down(scores: number[], ids: number[], i: number) {
    for (; ;) {
        let l = (i << 1) + 1, r = l + 1, s = i;
        if (l < ids.length && scores[l] < scores[s]) { s = l; }
        if (r < ids.length && scores[r] < scores[s]) { s = r; }
        if (s === i) { break; }
        [scores[i], scores[s]] = [scores[s], scores[i]];
        [ids[i], ids[s]] = [ids[s], ids[i]];
        i = s;
    }
}
