import * as vscode from 'vscode';
const config = vscode.workspace.getConfiguration('saralflow');

const generateEmbeddingFunctionUrl = config.get<string>('cloudFunctions.generateEmbeddingUrl') 
                                     || 'https://us-central1-saralflowapis.cloudfunctions.net/generateEmbedding';

// Define the expected structure of the Cloud Function's response for generateEmbedding
export interface GenerateEmbeddingResponse {
    success: boolean;
    embedding?: number[]; // The embedding vector
    error?: string; // Error message if success is false
}

/**
 * Calculates the cosine similarity between two vectors.
 * @param vec1 The first vector.
 * @param vec2 The second vector.
 * @returns The cosine similarity (a number between -1 and 1).
 */
export function cosineSimilarity(vec1: number[], vec2: number[]): number {
    if (vec1.length !== vec2.length) {
        console.error("Vectors must be of the same length for cosine similarity.");
        return 0;
    }

    let dotProduct = 0;
    let magnitude1 = 0;
    let magnitude2 = 0;

    for (let i = 0; i < vec1.length; i++) {
        dotProduct += vec1[i] * vec2[i];
        magnitude1 += vec1[i] * vec1[i];
        magnitude2 += vec2[i] * vec2[i];
    }

    magnitude1 = Math.sqrt(magnitude1);
    magnitude2 = Math.sqrt(magnitude2);

    if (magnitude1 === 0 || magnitude2 === 0) {
        return 0; // Avoid division by zero
    }

    return dotProduct / (magnitude1 * magnitude2);
}


/***
 * Generates an embedding for the given text by calling the Cloud Function.
 * @param text The text to embed.
 * @param firebaseIdToken The Firebase ID token for authentication.
 * @returns A promise that resolves to the embedding vector (number[]) or null if an error occurs.
 */
export async function getEmbeddingViaCloudFunction(text: string, firebaseIdToken: string): Promise<number[] | null> {
   
    try {
        const response = await fetch(generateEmbeddingFunctionUrl, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${firebaseIdToken}` // Include the Firebase ID token
            },
            body: JSON.stringify({ text: text }) // Send the text to be embedded
        });

        if (!response.ok) {
            const errorText = await response.text();
            console.error(`Cloud Function (generateEmbedding) error: ${response.status} - ${errorText}`);
            throw new Error(`Embedding Cloud Function error: ${response.status} - ${errorText}`);
        }

        const result = await response.json() as GenerateEmbeddingResponse;

        if (result.success && result.embedding) {
            return result.embedding;
        } else {
            console.error('Invalid response from generateEmbedding Cloud Function:', result.error);
            return null;
        }
    } catch (error) {
        console.error('Error calling generateEmbedding Cloud Function:', error);
        return null;
    }
}
