// media/main.js

console.log('main.js loaded.');

const vscode = acquireVsCodeApi();

const userStoryTextArea = document.getElementById('userStory');
const generateButton = document.getElementById('generateButton');
const resultDiv = document.getElementById('result');
const loadingMessage = document.getElementById('loadingMessage');

// Ensure all DOM elements are found
console.log('DOM Elements check:');
console.log('userStoryTextArea:', userStoryTextArea);
console.log('generateButton:', generateButton);
console.log('resultDiv:', resultDiv);
console.log('loadingMessage:', loadingMessage);

// New "Apply All" button
const applyAllButton = document.createElement('button');
applyAllButton.id = 'applyAllButton';
applyAllButton.textContent = 'Apply All Changes';
applyAllButton.style.display = 'none'; // Initially hidden

console.log('applyAllButton created:', applyAllButton);

// Add applyAllButton to the DOM only if resultDiv exists, as a safe measure
if (resultDiv) {
    resultDiv.after(applyAllButton); // Insert after resultDiv for better layout
    console.log('applyAllButton appended to DOM.');
} else {
    console.warn('Could not find resultDiv to append applyAllButton after it.');
    document.body.appendChild(applyAllButton); // Fallback to append to body
}


applyAllButton.addEventListener('click', () => {
    console.log('Apply All Changes button clicked.');
    vscode.postMessage({ command: 'applyAllChanges' });
});


generateButton.addEventListener('click', () => {
    console.log('Generate Code button clicked.');
    const userStory = userStoryTextArea.value;
    if (userStory.trim()) {
        console.log('User story is not empty. Sending generateCode command.');
        applyAllButton.style.display = 'none'; // Hide apply button on new generation
        vscode.postMessage({
            command: 'generateCode',
            text: userStory
        });
    } else {
        console.warn('User story is empty. Displaying warning.');
        resultDiv.innerHTML = '<p style="color: red;">Please enter a user story.</p>';
    }
});

// Handle messages sent from the extension to the webview
window.addEventListener('message', event => {
    console.log('Message received from extension:', event.data);
    const message = event.data; // The JSON data from the extension.

    switch (message.command) {
        case 'displayParsedResult': // New command to display structured data
            console.log('Command: displayParsedResult');
            resultDiv.innerHTML = ''; // Clear previous results
            const fileChanges = message.fileChanges;
            const explanation = message.explanation;

            console.log('Received fileChanges:', fileChanges);
            console.log('Received explanation:', explanation);

            if (fileChanges && fileChanges.length > 0) {
                console.log('fileChanges array is not empty. Rendering file changes.');
                resultDiv.innerHTML += '<h3>Proposed File Changes:</h3>';
                fileChanges.forEach((change, index) => {
                    console.log(`Rendering change ${index}:`, change);
                    const fileType = change.isNewFile ? 'New File' : 'Modified File';
                    resultDiv.innerHTML += `<h4>${fileType}: <code>${escapeHtml(change.filePath)}</code></h4>`;
                    resultDiv.innerHTML += `<pre><code class="csharp">${escapeHtml(change.content)}</code></pre>`; // Use escapeHtml for raw code
                });
                resultDiv.innerHTML += `<hr><h3>Explanation:</h3>`;
                
                // Test marked.js
                console.log('Checking marked.parse availability:', typeof marked);
                if (typeof marked !== 'undefined' && marked.parse) {
                    const parsedExplanation = marked.parse(explanation);
                    console.log('Parsed explanation HTML:', parsedExplanation);
                    resultDiv.innerHTML += parsedExplanation; // Render explanation as markdown
                } else {
                    console.error('marked.parse is not available! Displaying raw explanation.');
                    resultDiv.innerHTML += `<pre>${escapeHtml(explanation)}</pre>`;
                }

                applyAllButton.style.display = 'block'; // Show apply button
                console.log('applyAllButton displayed.');
            } else {
                console.log('fileChanges array is empty or null. Displaying only explanation.');
                // Test marked.js for explanation only path
                console.log('Checking marked.parse availability (else block):', typeof marked);
                if (typeof marked !== 'undefined' && marked.parse) {
                    const parsedExplanation = marked.parse(explanation);
                    console.log('Parsed explanation HTML (else block):', parsedExplanation);
                    resultDiv.innerHTML += '<p>No specific file changes proposed. <br>' + parsedExplanation + '</p>';
                } else {
                    console.error('marked.parse is not available (else block)! Displaying raw explanation.');
                    resultDiv.innerHTML += '<p>No specific file changes proposed. <br>' + escapeHtml(explanation) + '</p>';
                }
                applyAllButton.style.display = 'none';
            }
            break; // Crucial 'break' here!

        case 'displayResult': // Old command, just in case it's still sent
            console.log('Command: displayResult (OLD COMMAND)');
            // Check marked.js here too, for safety
            if (typeof marked !== 'undefined' && marked.parse) {
                 resultDiv.innerHTML = marked.parse(message.text);
            } else {
                console.error('marked.parse not available for displayResult!');
                resultDiv.innerHTML = `<pre>${escapeHtml(message.text)}</pre>`;
            }
            break;

        case 'showLoading':
            console.log('Command: showLoading');
            if (loadingMessage) {loadingMessage.innerHTML ="Generating Code Changes...";};
            resultDiv.innerHTML = '';
            applyAllButton.style.display = 'none';
            break;
        case 'hideLoading':
            console.log('Command: hideLoading');
            if (loadingMessage) {loadingMessage.innerHTML ="";};
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
    // console.log('Escaping HTML for:', unsafe); // Can be very chatty for large code blocks
    return unsafe
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#039;");
}

// Final check for marked.js availability on load
window.onload = () => {
    console.log('Webview window loaded. Final marked.js check:', typeof marked);
    if (typeof marked === 'undefined') {
        console.error('ERROR: marked.js is NOT globally available. Check script loading in HTML and CSP.');
    }
};