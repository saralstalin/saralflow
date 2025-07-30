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

/**
 * Generates an embedding for the given text using OpenAI's embedding API.
 * @param text The text to embed.
 * @param apiKey Your OpenAI API key.
 * @returns A promise that resolves to the embedding vector (number[]) or null if an error occurs.
 */
export async function getEmbedding(text: string, apiKey: string): Promise<number[] | null> {
    try {
        const response = await fetch('https://api.openai.com/v1/embeddings', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${apiKey}`
            },
            body: JSON.stringify({
                model: 'text-embedding-ada-002', // Recommended embedding model
                input: text
            })
        });

        if (!response.ok) {
            const errorData: any = await response.json();
            console.error('OpenAI Embedding API error:', errorData);
            throw new Error(`Embedding API error: ${response.status} - ${errorData.error ? errorData.error.message : response.statusText}`);
        }

        const data: any = await response.json();
        return data.data[0].embedding;
    } catch (error: any) {
        console.error('Error getting embedding:', error);
        // Do not show error message here, as it might spam if many files fail.
        // The calling function (loadSchemaContext) will handle overall errors.
        return null;
    }
}