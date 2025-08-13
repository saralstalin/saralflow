const vscode = acquireVsCodeApi();
const authSection = document.getElementById('auth-section');
const appSection = document.getElementById('app-section');
const emailInput = document.getElementById('emailInput');
const passwordInput = document.getElementById('passwordInput');
const loginButton = document.getElementById('loginButton');
const registerButton = document.getElementById('registerButton'); 
const authStatus = document.getElementById('authStatus');
const confirmPasswordInput = document.getElementById('confirmPasswordInput');

const userStoryTextArea = document.getElementById('userStory');
const generateButton = document.getElementById('generateButton');
const resultDiv = document.getElementById('result');
const loadingMessage = document.getElementById('loadingMessage');

const applySelectedButton = document.createElement('button');
applySelectedButton.id = 'applySelectedButton';
applySelectedButton.textContent = 'Apply Changes';
applySelectedButton.style.display = 'none';

const applyStatusMessage = document.createElement('p');
applyStatusMessage.id = 'applyStatusMessage';
applyStatusMessage.style.display = 'none';
applyStatusMessage.style.marginTop = '10px';
applyStatusMessage.style.color = 'var(--vscode-editor-foreground)';

const userNameSpan = document.getElementById('userName');
const logoutButton = document.getElementById('logoutButton');

let isRegisterMode = false;

if (resultDiv) {
    resultDiv.after(applySelectedButton);
    resultDiv.after(applyStatusMessage);
} else {
    document.body.appendChild(applySelectedButton);
    document.body.appendChild(applyStatusMessage);
}

// --- Firebase Initialization ---
const firebaseConfig = {
  apiKey: "AIzaSyD-ufVjCUr7Ub_7arhrW5tqwfk9N_QPsfw",
  authDomain: "saralflowapis.firebaseapp.com",
  projectId: "saralflowapis",
  storageBucket: "saralflowapis.firebasestorage.app",
  messagingSenderId: "59243082833",
  appId: "1:59243082833:web:821bafed4b8588b4c63470",
  measurementId: "G-WK522LTEFX"
};

firebase.initializeApp(firebaseConfig);
const auth = firebase.auth();
const provider = new firebase.auth.GoogleAuthProvider();

let firebaseIdToken = null;
let tokenRefreshInterval = null; // For forced refresh

// --- Unified auth state & token change handler ---
function updateUIForUser(user) {
    if (user) {
        authSection.classList.add('hidden');
        appSection.classList.remove('hidden');
        userNameSpan.textContent = user.email || '';
    } else {
        authSection.classList.remove('hidden');
        appSection.classList.add('hidden');
        userNameSpan.textContent = '';
    }
}

// Automatically update token whenever Firebase refreshes it
auth.onIdTokenChanged(async (user) => {
    if (user) {
        try {
            firebaseIdToken = await user.getIdToken();
            console.log("Updated Firebase ID Token:", firebaseIdToken);
            updateUIForUser(user);
            vscode.postMessage({ command: 'firebaseToken', token: firebaseIdToken });

            // Start periodic forced refresh (every 50 minutes)
            if (tokenRefreshInterval) {clearInterval(tokenRefreshInterval);}
            tokenRefreshInterval = setInterval(async () => {
                try {
                    firebaseIdToken = await user.getIdToken(true);
                    console.log("Forced token refresh successful:", firebaseIdToken);
                    vscode.postMessage({ command: 'firebaseToken', token: firebaseIdToken });
                } catch (err) {
                    console.error("Forced token refresh failed:", err);
                }
            }, 50 * 60 * 1000); // 50 minutes

        } catch (err) {
            console.error("Error getting Firebase token:", err);
        }
    } else {
        firebaseIdToken = null;
        updateUIForUser(null);
        authStatus.textContent = 'Please log in or register.';
        if (tokenRefreshInterval) {clearInterval(tokenRefreshInterval);}
    }
});

// --- Login Button Click ---
loginButton.addEventListener('click', async () => {
    const email = emailInput.value;
    const password = passwordInput.value;

    if (!email || !password) {
        authStatus.textContent = 'Please enter both email and password to login.';
        return;
    }

    if (!isValidEmail(email)) {
        authStatus.textContent = 'Please enter a valid email address.';
        return;
    }

    authStatus.textContent = 'Logging in...';

    try {
        await auth.signInWithEmailAndPassword(email, password);
        // Token updates handled by onIdTokenChanged
    } catch (error) {
        authStatus.textContent = `Login failed, Please re-check email/password. If you are new user, click on register instead.`;
        console.error('Firebase Login Error:', error);
    }
});

// Handle Register Button Click
if (registerButton) {
    registerButton.addEventListener('click', async () => {
        if (!isRegisterMode) {
            confirmPasswordGroup.classList.remove('hidden');
            isRegisterMode = true;
            registerButton.textContent = 'Confirm Registration';
            authStatus.textContent = 'Please confirm your password.';
            return;
        }

        const email = emailInput.value;
        const password = passwordInput.value;
        const confirmPassword = confirmPasswordInput.value;

        if (!isValidEmail(email)) {
            authStatus.textContent = 'Please enter a valid email address.';
            return;
        }

        if (password.length < 6) {
            authStatus.textContent = 'Password should be at least 6 characters.';
            return;
        }

        if (password !== confirmPassword) {
            authStatus.textContent = 'Passwords do not match!';
            return;
        }

        try {
            authStatus.textContent = 'Registering...';
            await auth.createUserWithEmailAndPassword(email, password);
            authStatus.textContent = 'Registration successful! You are now logged in.';
            emailInput.value = '';
            passwordInput.value = '';
            confirmPasswordInput.value = '';
            confirmPasswordGroup.classList.add('hidden');
            isRegisterMode = false;
            registerButton.textContent = 'Register';
        } catch (error) {
            authStatus.textContent = `Registration failed: ${error.message}`;
            console.error('Registration failed:', error);
        }
    });
}

// Handle Logout Button Click
if (logoutButton) {
    logoutButton.addEventListener('click', async () => {
        try {
            await auth.signOut();
            console.log('User signed out.');
        } catch (error) {
            console.error('Logout failed:', error);
        }
    });
}

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
        applySelectedButton.style.display = 'none';
        applyStatusMessage.style.display = 'block';
        applyStatusMessage.textContent = 'Applying changes...';
        applyStatusMessage.style.color = 'var(--vscode-editor-foreground)';
        vscode.postMessage({ command: 'applySelectedChanges', changes: selectedChanges });
    } else {
        vscode.postMessage({ command: 'showError', text: 'Please select at least one change to apply.' });
    }
});

generateButton.addEventListener('click', async () => {
    const userStory = userStoryTextArea.value;

    if (!firebaseIdToken) {
        vscode.postMessage({ command: 'showError', text: 'Please log in to Firebase first.' });
        return;
    }

    try {
        firebaseIdToken = await auth.currentUser.getIdToken(true);
    } catch (err) {
        vscode.postMessage({ command: 'showError', text: 'Failed to refresh authentication token. Please log in again.' });
        return;
    }
    
    if (userStory) {
        resultDiv.innerHTML = '';
        loadingMessage.classList.remove('hidden');
        applySelectedButton.style.display = 'none';
        applyStatusMessage.style.display = 'none';
        vscode.postMessage({ command: 'generateCode', text: userStory });
    }
});

function getLanguageFromPath(filePath) {
    const extension = filePath.split('.').pop().toLowerCase();
    switch (extension) {
        case 'ts': return 'typescript';
        case 'js': return 'javascript';
        case 'html': return 'html';
        case 'css': return 'css';
        case 'sql': return 'sql';
        case 'json': return 'json';
        case 'md': return 'markdown';
        case 'cs': return 'csharp';
        default: return 'clike';
    }
}

window.addEventListener('message', async event => {
    const message = event.data;
    switch (message.command) {
        case 'displayParsedResult':
            displayParsedResult(message.explanation, message.fileChanges);
            break;
        case 'showLoading':
            loadingMessage.classList.remove('hidden');
            resultDiv.innerHTML = '';
            applySelectedButton.style.display = 'none';
            break;
        case 'hideLoading':
            loadingMessage.classList.add('hidden');
            break;
        case 'showError':
            resultDiv.innerHTML = `<p style="color: red;">${escapeHtml(message.text)}</p>`;
            applySelectedButton.style.display = 'none';
            break;
        case 'clearResults':
            resultDiv.innerHTML = '';
            applySelectedButton.style.display = 'none';
            break;
        case 'firebaseCustomToken':
            try {
                await auth.signInWithCustomToken(message.token);
            } catch (error) {
                authStatus.textContent = `Google Sign-in failed: ${error.message}`;
                authStatus.style.color = 'red';
                console.error('Firebase Custom Token Sign-in Error:', error);
            }
            break;
        case 'changesApplied':
            applySelectedButton.style.display = 'none';
            applyStatusMessage.textContent = 'Code changes applied successfully!';
            applyStatusMessage.style.color = 'green';
            applyStatusMessage.style.display = 'block';
            break;
        default:
            console.warn('Unknown command received:', message.command, message);
            break;
    }
});

function escapeHtml(unsafe) {
    return unsafe
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#039;");
}

function displayParsedResult(explanation, fileChanges) {
    console.log('Command: displayParsedResult', { explanation, fileChanges });
    resultDiv.innerHTML = '';
    applyStatusMessage.style.display = 'none';
    applySelectedButton.style.display = 'block';

    if (explanation) {
        resultDiv.innerHTML += `<h3>Explanation:</h3><div class="explanation-text">${marked.parse(explanation)}</div>`;
    }

    if (fileChanges && fileChanges.length > 0) {
        resultDiv.innerHTML += `<h3>File Changes:</h3>`;
        fileChanges.forEach((change, index) => {
            const fileChangeContainer = document.createElement('div');
            fileChangeContainer.classList.add('file-change-container');

            const header = document.createElement('div');
            header.classList.add('file-collapse-header', 'collapsed');
            header.dataset.targetId = `file-content-${index}`;

            const arrow = document.createElement('span');
            arrow.classList.add('arrow');
            arrow.textContent = '▶';
            header.appendChild(arrow);
            
            const checkbox = document.createElement('input');
            checkbox.type = 'checkbox';
            checkbox.id = `checkbox-${index}`;
            checkbox.dataset.filePath = change.filePath;
            checkbox.checked = true;
            
            const fileLabel = document.createElement('label');
            fileLabel.htmlFor = `checkbox-${index}`;
            fileLabel.textContent = ` ${change.filePath} (${change.isNewFile ? 'New File' : 'Edit'})`;

            header.appendChild(checkbox);
            header.appendChild(fileLabel);
            if (!change.isNewFile) {
                const diffButton = document.createElement('button');
                diffButton.textContent = '⇆'; // Unicode compare arrows
                diffButton.classList.add('diff-button');
                diffButton.title = 'View Diff';
                diffButton.addEventListener('click', () => {
                    vscode.postMessage({
                        command: 'showDiff',
                        filePath: change.filePath,
                        newContent: change.content,
                        language: getLanguageFromPath(change.filePath)
                    });
                });
                header.appendChild(diffButton);
            }

            const codeContent = document.createElement('div');
            codeContent.id = `file-content-${index}`;
            codeContent.classList.add('file-collapse-content', 'collapsed');

            const codeEditableDiv = document.createElement('div');
            codeEditableDiv.classList.add('code-editable-div');
            codeEditableDiv.setAttribute('contenteditable', 'true');
            codeEditableDiv.dataset.filePath = change.filePath;

            const languageClass = getLanguageFromPath(change.filePath);
            codeEditableDiv.innerHTML = `<pre><code class="language-${languageClass}">${escapeHtml(change.content)}</code></pre>`;

            codeContent.appendChild(codeEditableDiv);
            fileChangeContainer.appendChild(header);
            fileChangeContainer.appendChild(codeContent);
            resultDiv.appendChild(fileChangeContainer);

            header.addEventListener('click', () => {
                header.classList.toggle('collapsed');
                codeContent.classList.toggle('collapsed');
            });
            
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

window.onload = () => {
    console.log('Webview window loaded. Final marked.js check:', typeof marked);
    if (typeof marked === 'undefined') {
        console.error('marked.js is not loaded.');
        document.getElementById('result').innerHTML = `<p style="color: red;">Error: marked.js failed to load. Markdown content will not be rendered correctly.</p>`;
    }
    if (typeof Prism === 'undefined') {
        console.error('Prism.js is not loaded.');
    }
};

function isValidEmail(email) {
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    return emailRegex.test(email);
}
