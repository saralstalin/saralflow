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
    console.log('Apply All Changes button clicked.');
    const allChanges = [];
    document.querySelectorAll('.file-change-container').forEach(container => {
        const filePath = container.querySelector('input[type="checkbox"]').dataset.filePath;
        const editedContent = container.querySelector('.code-editable-div').textContent;
        const isNewFile = container.querySelector('label').textContent.includes('(New File)');
        allChanges.push({ filePath, content: editedContent, isNewFile });
    });
    vscode.postMessage({ command: 'applyAllChanges', changes: allChanges });
});


applySelectedButton.addEventListener('click', () => {
    console.log('Apply Selected Changes button clicked.');
    const selectedChanges = [];
    document.querySelectorAll('.file-change-container input[type="checkbox"]:checked').forEach(checkbox => {
        const container = checkbox.closest('.file-change-container');
        const filePath = checkbox.dataset.filePath;
        const editedContent = container.querySelector('.code-editable-div').textContent;
        const isNewFile = container.querySelector('label').textContent.includes('(New File)');
        selectedChanges.push({ filePath, content: editedContent, isNewFile });
    });
    if (selectedChanges.length > 0) {
        vscode.postMessage({ command: 'applySelectedChanges', changes: selectedChanges });
    } else {
        vscode.postMessage({ command: 'showError', text: 'Please select at least one change to apply.' });
    }
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

window.addEventListener('message', event => {
    const message = event.data;
    switch (message.command) {
        case 'displayParsedResult':
            // Call the new function to display the results
            displayParsedResult(message.explanation, message.fileChanges);
            break;
        case 'showLoading':
            loadingMessage.classList.remove('hidden');
            resultDiv.innerHTML = '';
            applyAllButton.style.display = 'none';
            applySelectedButton.style.display = 'none';
            break;
        case 'hideLoading':
            loadingMessage.classList.add('hidden');
            break;
        case 'showError':
            resultDiv.innerHTML = `<p style="color: red;">${escapeHtml(message.text)}</p>`;
            applyAllButton.style.display = 'none';
            applySelectedButton.style.display = 'none';
            break;
        case 'clearResults':
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

// Function to display the parsed result with editable and highlighted code blocks
function displayParsedResult(explanation, fileChanges) {
    console.log('Command: displayParsedResult', { explanation, fileChanges });

    // Clear previous results
    resultDiv.innerHTML = '';
    applyAllButton.style.display = 'block';
    applySelectedButton.style.display = 'block';

    if (explanation) {
        // Display the explanation using markdown
        resultDiv.innerHTML += `<h3>Explanation:</h3><div class="explanation-text">${marked.parse(explanation)}</div>`;
    }

    if (fileChanges && fileChanges.length > 0) {
        resultDiv.innerHTML += `<h3>File Changes:</h3>`;
        fileChanges.forEach((change, index) => {
            const fileContainer = document.createElement('div');
            fileContainer.classList.add('file-change-container');

            // Add a checkbox for selection
            const checkbox = document.createElement('input');
            checkbox.type = 'checkbox';
            checkbox.id = `checkbox-${index}`;
            checkbox.dataset.filePath = change.filePath; // Store the file path
            checkbox.checked = true; // Default to selected

            const fileLabel = document.createElement('label');
            fileLabel.htmlFor = `checkbox-${index}`;
            fileLabel.textContent = ` ${change.filePath} (${change.isNewFile ? 'New File' : 'Edit'})`;

            // Create an editable div for the code
            const codeEditableDiv = document.createElement('div');
            codeEditableDiv.classList.add('code-editable-div');
            codeEditableDiv.setAttribute('contenteditable', 'true');
            codeEditableDiv.dataset.filePath = change.filePath;

            // Get the language class dynamically
            const languageClass = getLanguageFromPath(change.filePath);

            // Use innerHTML to allow Prism.js to render syntax highlighting
            codeEditableDiv.innerHTML = `<pre><code class="language-${languageClass}">${escapeHtml(change.content)}</code></pre>`;

            fileContainer.appendChild(checkbox);
            fileContainer.appendChild(fileLabel);
            fileContainer.appendChild(codeEditableDiv);
            resultDiv.appendChild(fileContainer);

            // Trigger Prism.js highlighting after the element is in the DOM
            // This is a simple way to highlight, but for real-time highlighting on edit,
            // a more complex solution like CodeMirror would be needed.
            if (languageClass) {
                const codeElement = codeEditableDiv.querySelector('code');
                if (codeElement && typeof Prism !== 'undefined') {
                    Prism.highlightElement(codeElement);
                }
            }
        });
    } else {
        resultDiv.innerHTML += `<p>No changes were generated.</p>`;
    }
}

// Final check for marked.js availability on load
window.onload = () => {
    console.log('Webview window loaded. Final marked.js check:', typeof marked);
    if (typeof marked === 'undefined') {
        console.error('marked.js is not loaded.');
        document.getElementById('result').innerHTML = `<p style="color: red;">Error: marked.js failed to load. Markdown content will not be rendered correctly.</p>`;
    }
    // Also check for prism.js
    if (typeof Prism === 'undefined') {
        console.error('Prism.js is not loaded.');
    }
}
