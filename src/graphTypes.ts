// src/graphTypes.ts

import * as vscode from 'vscode';

// A numeric enum for Node kinds, to be used for internal graph logic.
export enum NodeKind {
    File,
    Module,
    Namespace,
    Package,
    Class,
    Method,
    Property,
    Field,
    Constructor,
    Enum,
    Interface,
    Function,
    Variable,
    Constant,
    String,
    Number,
    Boolean,
    Array,
    Object,
    Key,
    Null,
    EnumMember,
    Struct,
    Event,
    Operator,
    TypeParameter,
    Reference,
    Value,
    ObjectLiteral,
    Comment,
    Statement,
    Expression,
    Type,
    Block,
    Member,
    Literal,
    Template,
    ClassLiteral,
    Keyword,
    Decorator,
    Annotation,
    TypeAlias,
    TypeReference,
    ConditionalType,
    UnionType,
    IntersectionType,
    Import,
    Export,
    NamespaceImport,
    NamespaceExport
}

// An enum for the different types of edges in our graph.
export enum EdgeType {
    CONTAINS = 'CONTAINS',
    CALLS = 'CALLS',
    CALLED_BY = 'CALLED_BY',
    REFERENCES = 'REFERENCES', // Added to be consistent with graphBuilder
    INHERITS_FROM = 'INHERITS_FROM', // Added to be consistent with graphBuilder
    DEFINES = 'DEFINES', // A container defines a member (e.g., Class defines Method)
    HAS_TYPE = 'HAS_TYPE', // A variable has a certain type
    IMPORTS = 'IMPORTS', // A file/module imports another module
    EXTENDS = 'EXTENDS', // A class extends another class
    IMPLEMENTS = 'IMPLEMENTS', // A class implements an interface
   
}

// Interface for a code snippet's range.
export interface IRange {
    start: vscode.Position;
    end: vscode.Position;
}

// The core interface for a graph node.
export interface INode {
    id: string;
    label: string;
    kind: string;
    uri: string;
    range?: vscode.Range;
    detail?: string;
    codeSnippet?: string;
    parentIds?: string[];
    embedding?: number[];
}

// Interface for a graph edge.
export interface IEdge {
    from: string;
    to: string;
    label: EdgeType;
}

// The interface for the full semantic graph object.
export interface ISemanticGraph {
    nodes: INode[];
    edges: IEdge[];
}

// A helper function to convert vscode.SymbolKind to a string kind.
export function toNodeKind(kind: vscode.SymbolKind): string {
    return vscode.SymbolKind[kind] as string;
}

// A helper function to generate a unique node ID.
export function generateNodeId(uri: string, symbol: vscode.DocumentSymbol | vscode.CallHierarchyItem | vscode.SymbolInformation): string {
    // Use a type guard to correctly handle SymbolInformation which has a nested range
    const range = (symbol as vscode.SymbolInformation).location ? (symbol as vscode.SymbolInformation).location.range : (symbol as vscode.DocumentSymbol).range;
    const symbolQualifier = `${symbol.name}:${range.start.line}:${range.start.character}`;
    return `${uri}#${symbolQualifier}`;
}

// The CodeGraph class that manages the nodes and edges.
export class CodeGraph {
    nodes: Map<string, INode> = new Map();
    edges: IEdge[] = [];

    addNode(node: INode) {
        if (!this.nodes.has(node.id)) {
            this.nodes.set(node.id, node);
        }
    }

    addEdge(edge: IEdge) {
        this.edges.push(edge);
    }
}