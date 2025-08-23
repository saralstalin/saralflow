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

const progressDetails = document.createElement('details');
progressDetails.id = 'progressBox';
progressDetails.open = true; // expanded by default

const summary = document.createElement('summary');
summary.textContent = 'Progress';
summary.style.cursor = 'pointer';
summary.style.userSelect = 'none';
summary.style.fontWeight = '600';
summary.style.marginTop = '12px';

// optional: a compact summary line we can update after completion
const summaryStatus = document.createElement('span');
summaryStatus.id = 'progressSummaryStatus';
summaryStatus.style.opacity = '0.8';
summaryStatus.style.marginLeft = '8px';
summary.appendChild(summaryStatus);

const progressContainer = document.createElement('div');
progressContainer.id = 'progressContainer';
progressContainer.style.marginTop = '8px';
progressContainer.style.display = 'flex';
progressContainer.style.alignItems = 'flex-start';
progressContainer.style.gap = '24px';

const stepsList = document.createElement('ol');
stepsList.id = 'progressSteps';
stepsList.style.listStyle = 'none';
stepsList.style.padding = '0';
stepsList.style.margin = '0';
stepsList.style.minWidth = '220px';
stepsList.style.flex = '0 0 auto';

const liveLog = document.createElement('div');
liveLog.id = 'liveLog';
liveLog.style.fontSize = '12px';
liveLog.style.maxHeight = '240px';
liveLog.style.overflow = 'auto';
liveLog.style.borderLeft = '2px solid var(--vscode-editor-foreground)';
liveLog.style.paddingLeft = '8px';
liveLog.style.flex = '1';
liveLog.setAttribute('aria-live', 'polite');

progressContainer.appendChild(stepsList);
progressContainer.appendChild(liveLog);

progressDetails.appendChild(summary);
progressDetails.appendChild(progressContainer);

// Attach under your loading message or wherever you want it to live
if (loadingMessage && loadingMessage.parentElement) {
    loadingMessage.parentElement.insertBefore(progressDetails, loadingMessage.nextSibling);
}

// ----- logic (same API as before, with summary helpers) -----
const DEFAULT_STEPS = [
    { id: 'understand', label: 'Understanding story', status: 'pending' },
    { id: 'retrieve', label: 'Finding relevant code', status: 'pending' },
    { id: 'plan', label: 'Planning changes', status: 'pending' },
    { id: 'generate', label: 'Generating code', status: 'pending' },
    { id: 'format', label: 'Formatting & imports', status: 'pending' },
    { id: 'validate', label: 'Validating changes', status: 'pending' },
    { id: 'preview', label: 'Preparing preview', status: 'pending' },
];

let currentSteps = [];

function renderSteps() {
    stepsList.innerHTML = '';
    for (const s of currentSteps) {
        const li = document.createElement('li');
        li.id = `step-${s.id}`;
        li.style.display = 'flex';
        li.style.alignItems = 'center';
        li.style.gap = '6px';
        const icon = document.createElement('span');
        icon.style.width = '16px';
        icon.style.display = 'inline-block';
        if (s.status === 'done') { icon.textContent = '✔'; }
        else if (s.status === 'active') { icon.textContent = '⏳'; }
        else if (s.status === 'error') { icon.textContent = '⚠'; }
        else { icon.textContent = '•'; }
        const text = document.createElement('span');
        text.textContent = s.label;
        li.appendChild(icon);
        li.appendChild(text);
        stepsList.appendChild(li);
    }
}

function setStepStatus(id, status) {
    const s = currentSteps.find(x => x.id === id);
    if (!s) { return; }
    s.status = status;
    renderSteps();
}

function setProgressSummary(text) {
    summaryStatus.textContent = text ? `— ${text}` : '';
}

function startProgress() {
    progressDetails.open = true;        // expand on new run
    setProgressSummary('running…');     // initial summary hint
    currentSteps = DEFAULT_STEPS.map(x => ({ ...x }));
    currentSteps[0].status = 'active';
    renderSteps();
    liveLog.innerHTML = '';
}

function completeAll(success = true) {
    for (const s of currentSteps) {
        if (s.status !== 'done') { s.status = (s.status === 'error' ? 'error' : 'done'); }
    }
    renderSteps();
    setProgressSummary(success ? 'completed' : 'failed');
}

function collapseProgress() {
    progressDetails.open = false;
}

function logEvent(msg) {
    const p = document.createElement('div');
    p.textContent = `• ${msg}`;
    liveLog.appendChild(p);
    liveLog.scrollTop = liveLog.scrollHeight;
}


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
            // Current ID token
            const idToken = await user.getIdToken(/* forceRefresh */ false);
            // Expiration time (ISO string like "2025-08-23T12:34:56.000Z")
            const tokenInfo = await user.getIdTokenResult();
            const expiresAt = tokenInfo.expirationTime;
            // Refresh token (secret) lives on the compat user object
            const refreshToken = user.refreshToken;

            updateUIForUser(user);

            // Send all three to extension so it can refresh tokens even when webview is closed
            vscode.postMessage({
                command: 'firebaseToken',
                token: idToken,
                refreshToken,     // <-- extension stores in SecretStorage
                expiresAt         // <-- extension converts to epoch and refreshes before expiry
            });

            // Optional: reduce noisy logs / avoid printing whole tokens
            console.log('Firebase token updated; expires at:', expiresAt);

        } catch (err) {
            console.error('Error getting Firebase token:', err);
        }
    } else {
        // Signed out
        if (tokenRefreshInterval) { clearInterval(tokenRefreshInterval); }
        updateUIForUser(null);
        authStatus.textContent = 'Please log in or register.';
        // Tell the extension to clear stored secrets
        vscode.postMessage({ command: 'firebaseSignOut' });
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
    const userStory = userStoryTextArea.value.trim();
    if (!auth.currentUser) {
        vscode.postMessage({ command: 'showError', text: 'Please log in first' });
        return;
    }
    if (!userStory) {
        vscode.postMessage({ command: 'showError', text: 'Please enter a user story.' });
        return;
    }
    resultDiv.innerHTML = '';
    loadingMessage.classList.remove('hidden');
    applySelectedButton.style.display = 'none';
    applyStatusMessage.style.display = 'none';
    startProgress();
    logEvent('Story submitted');
    setStepStatus('understand', 'active');
    vscode.postMessage({ command: 'generateCode', text: userStory });

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
        case 'generationStart': {
            startProgress();
            loadingMessage.classList.remove('hidden');
            break;
        }
        case 'generationStep': {
            // payload: { id: 'retrieve'|'plan'|'generate'|'format'|'validate'|'preview', status?: 'active'|'done'|'error', note?: string }
            const { id, status = 'active', note } = message;
            setStepStatus(id, status);
            if (note) { logEvent(note); }
            // Automatically advance: mark previous active as done when a new one becomes active
            if (status === 'active') {
                for (const s of currentSteps) {
                    if (s.id !== id && s.status === 'active') { s.status = 'done'; }
                }
                renderSteps();
            }
            break;
        }
        case 'fileReady': {
            // payload: { fileChange: { filePath, content, isNewFile }, note?: string }
            const { fileChange, note } = message;
            if (note) { logEvent(note); }
            setStepStatus('generate', 'done');
            setStepStatus('format', 'active'); // your host can flip statuses too
            // Show incremental preview: reuse existing renderer for one file
            displayParsedResult('', [fileChange]); // keep explanation empty to avoid top block
            setStepStatus('preview', 'active');
            break;
        }
        case 'generationError': {
            // payload: { id?: stepId, message: string }
            const { id, message: errMsg } = message;
            if (id) { setStepStatus(id, 'error'); }
            logEvent(`Error: ${errMsg}`);
            loadingMessage.classList.add('hidden');
            break;
        }
        case 'generationDone': {
            const { success = true, summary } = message;
            if (summary) { setProgressSummary(summary); } // show brief outcome in the <summary>
            completeAll(success);
            loadingMessage.classList.add('hidden');
            // Auto-collapse after a beat so users can focus on the results
            setTimeout(() => collapseProgress(), 300);
            if (resultDiv && resultDiv.innerText.trim().length > 0) {
                applySelectedButton.style.display = 'block';
            }
            break;
        }
        default:
            console.warn('Unknown command received:', message.command, message);
            break;
    }
});

function escapeHtml(unsafe) {
    if (unsafe === null) { return ''; }
    const s = String(unsafe);
    return s
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');
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
