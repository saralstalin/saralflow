declare module 'diff-match-patch' {
    export class DiffMatchPatch {
        diff_main(text1: string, text2: string, optChecklines?: boolean): [number, string][];
        diff_cleanupSemantic(diffs: [number, string][]): void;
        // Add other methods you use if TypeScript still complains
        // patch_make(text1: string, text2: string, diffs?: [number, string][]): any[];
        // patch_apply(patches: any[], text: string): [string, boolean[]];
    }
}