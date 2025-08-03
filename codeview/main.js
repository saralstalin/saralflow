console.log('main.js loaded.');

const vscode = acquireVsCodeApi();

const userStoryTextArea = document.getElementById('userStory');
const generateButton = document.getElementById('generateButton');
const resultDiv = document.getElementById('result');
const loadingMessage = document.getElementById('loadingMessage');

// New "Apply All" and "Apply Selected" buttons
const applyAllButton = document.createElement('button');
applyAllButton.id = 'applyAllButton';
applyAllButton.textContent = 'Apply All Changes';
applyAllButton.style.display = 'none'; // Initially hidden

const applySelectedButton = document.createElement('button');
applySelectedButton.id = 'applySelectedButton';
applySelectedButton.textContent = 'Apply Selected Changes';
applySelectedButton.style.display = 'none'; // Initially hidden

// Add both buttons to the DOM
if (resultDiv) {
    resultDiv.after(applySelectedButton);
    resultDiv.after(applyAllButton);
} else {
    document.body.appendChild(applyAllButton); // Fallback
    document.body.appendChild(applySelectedButton);
}


applyAllButton.addEventListener('click', () => {
    vscode.postMessage({ command: 'applyAllChanges' });
});

applySelectedButton.addEventListener('click', () => {
    const selectedChanges = [];
    document.querySelectorAll('.file-change-container input[type="checkbox"]:checked').forEach(checkbox => {
        const change = JSON.parse(checkbox.dataset.change);
        selectedChanges.push(change);
    });
    // This is the new command to apply only selected changes
    vscode.postMessage({ command: 'applySelectedChanges', changes: selectedChanges });
});

generateButton.addEventListener('click', () => {
    const userStory = userStoryTextArea.value;
    if (userStory) {
        // Clear previous results and show loading message
        resultDiv.innerHTML = '';
        loadingMessage.classList.remove('hidden');
        applyAllButton.style.display = 'none';
        applySelectedButton.style.display = 'none';
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
        case 'cs':
            return 'csharp';
        default:
            return 'clike'; // A generic fallback for Prism.js
    }
}

// Listen for messages from the extension
window.addEventListener('message', event => {
    const message = event.data;
    switch (message.command) {
        case 'displayParsedResult':
            console.log('Command: displayParsedResult');
            const { explanation, fileChanges } = message;

            resultDiv.innerHTML = ''; // Clear previous content

            // Display the overall explanation
            if (explanation) {
                const explanationPara = document.createElement('p');
                explanationPara.innerHTML = marked.parse(explanation);
                resultDiv.appendChild(explanationPara);
            }

            // Loop through each file change and display it
            if (fileChanges && Array.isArray(fileChanges)) {
                fileChanges.forEach(change => {
                    const fileChangeContainer = document.createElement('div');
                    fileChangeContainer.className = 'file-change-container';

                    // Checkbox and label
                    const checkbox = document.createElement('input');
                    checkbox.type = 'checkbox';
                    checkbox.checked = true; // Default to checked
                    checkbox.id = `checkbox-${change.filePath}`;
                    checkbox.dataset.change = JSON.stringify(change); // Store the entire change object
                    
                    const label = document.createElement('label');
                    label.htmlFor = `checkbox-${change.filePath}`;
                    label.textContent = (change.isNewFile ? 'New File' : 'Modified File') + ': ' + change.filePath;

                    const codeContainer = document.createElement('pre');
                    const codeBlock = document.createElement('code');
                    
                    const language = getLanguageFromPath(change.filePath);
                    codeBlock.classList.add(`language-${language}`);
                    codeBlock.textContent = change.content;
                    
                    codeContainer.appendChild(codeBlock);

                    fileChangeContainer.appendChild(checkbox);
                    fileChangeContainer.appendChild(label);
                    fileChangeContainer.appendChild(codeContainer);
                    resultDiv.appendChild(fileChangeContainer);
                });
            }

            Prism.highlightAll();
            // Show both buttons
            applyAllButton.style.display = 'block';
            applySelectedButton.style.display = 'block';
            break;
        case 'showLoading':
            console.log('Command: showLoading');
            loadingMessage.classList.remove('hidden');
            resultDiv.innerHTML = '';
            applyAllButton.style.display = 'none';
            applySelectedButton.style.display = 'none';
            break;
        case 'hideLoading':
            console.log('Command: hideLoading');
            loadingMessage.classList.add('hidden');
            break;
        case 'showError':
            console.log('Command: showError', message.text);
            resultDiv.innerHTML = `<p style="color: red;">${escapeHtml(message.text)}</p>`;
            applyAllButton.style.display = 'none';
            applySelectedButton.style.display = 'none';
            break;
        case 'clearResults':
            console.log('Command: clearResults');
            resultDiv.innerHTML = '';
            applyAllButton.style.display = 'none';
            applySelectedButton.style.display = 'none';
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