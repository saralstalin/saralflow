console.log('main.js loaded.');

const vscode = acquireVsCodeApi();

const userStoryTextArea = document.getElementById('userStory');
const generateButton = document.getElementById('generateButton');
const resultDiv = document.getElementById('result');
const loadingMessage = document.getElementById('loadingMessage');

// New "Apply All" button
const applyAllButton = document.createElement('button');
applyAllButton.id = 'applyAllButton';
applyAllButton.textContent = 'Apply All Changes';
applyAllButton.style.display = 'none'; // Initially hidden

// Add applyAllButton to the DOM only if resultDiv exists
if (resultDiv) {
    resultDiv.after(applyAllButton);
} else {
    document.body.appendChild(applyAllButton); // Fallback
}

applyAllButton.addEventListener('click', () => {
    vscode.postMessage({ command: 'applyAllChanges' });
});

generateButton.addEventListener('click', () => {
    const userStory = userStoryTextArea.value;
    if (userStory) {
        // Clear previous results and show loading message
        resultDiv.innerHTML = '';
        loadingMessage.classList.remove('hidden');
        applyAllButton.style.display = 'none';
        vscode.postMessage({ command: 'generateCode', text: userStory });
    }
});

// Helper function to get the language class from a file path
function getLanguageFromPath(filePath) {
    const extension = filePath.split('.').pop().toLowerCase();
    switch (extension) {
        case 'ts':
            return 'typescript';
        case 'js':
            return 'javascript';
        case 'html':
            return 'html';
        case 'css':
            return 'css';
        case 'sql':
            return 'sql';
        case 'json':
            return 'json';
        case 'md':
            return 'markdown';
        default:
            return 'clike'; // A generic fallback for Prism.js
    }
}

// Listen for messages from the extension
window.addEventListener('message', event => {
    const message = event.data;
    switch (message.command) {
        // Correctly handle the message structure for 'displayParsedResult'
        case 'displayParsedResult':
            console.log('Command: displayParsedResult');
            const { explanation, fileChanges } = message;

            resultDiv.innerHTML = ''; // Clear previous content

            // Display the overall explanation
            if (explanation) {
                const explanationPara = document.createElement('p');
                // Use marked.parse to render markdown in the explanation
                explanationPara.innerHTML = marked.parse(explanation);
                resultDiv.appendChild(explanationPara);
            }

            // Loop through each file change and display it
            if (fileChanges && Array.isArray(fileChanges)) {
                fileChanges.forEach(change => {
                    const fileHeader = document.createElement('h3');
                    fileHeader.textContent = (change.isNewFile ? 'New File' : 'Modified File') + ': ' + change.filePath;
                    resultDiv.appendChild(fileHeader);

                    const codeContainer = document.createElement('pre');
                    const codeBlock = document.createElement('code');
                    
                    // Add the language class for Prism.js to apply highlighting
                    const language = getLanguageFromPath(change.filePath);
                    codeBlock.classList.add(`language-${language}`);
                    
                    // Use textContent to safely insert the code and prevent XSS
                    codeBlock.textContent = change.content;

                    codeContainer.appendChild(codeBlock);
                    resultDiv.appendChild(codeContainer);
                });
            }

            // Highlight all code blocks after they have been added to the DOM
            Prism.highlightAll();
            applyAllButton.style.display = 'block';
            break;
        case 'showLoading':
            console.log('Command: showLoading');
            loadingMessage.classList.remove('hidden');
            resultDiv.innerHTML = '';
            applyAllButton.style.display = 'none';
            break;
        case 'hideLoading':
            console.log('Command: hideLoading');
            loadingMessage.classList.add('hidden');
            break;
        case 'showError':
            console.log('Command: showError', message.text);
            resultDiv.innerHTML = `<p style="color: red;">${escapeHtml(message.text)}</p>`;
            applyAllButton.style.display = 'none';
            break;
        case 'clearResults':
            console.log('Command: clearResults');
            resultDiv.innerHTML = '';
            applyAllButton.style.display = 'none';
            break;
        default:
            console.warn('Unknown command received:', message.command, message);
            break;
    }
});

// Helper function to escape HTML for displaying raw code safely
function escapeHtml(unsafe) {
    return unsafe
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#039;");
}