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

// --- Firebase Initialization
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
const provider = new firebase.auth.GoogleAuthProvider(); // Google Auth Provider

let firebaseIdToken = null;

if (auth) {
    auth.onAuthStateChanged(user => {
        if (user) {
            authSection.classList.add('hidden');
            appSection.classList.remove('hidden');
            // Display the user's email
            userNameSpan.textContent = user.email;
        } else {
            authSection.classList.remove('hidden');
            appSection.classList.add('hidden');
            // Clear the user's info
            userNameSpan.textContent = '';
        }
    });
}

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
        const userCredential = await auth.signInWithEmailAndPassword(email, password);
        handleSuccessfulAuth(userCredential.user);
    } catch (error) {
        authStatus.textContent = `Login failed, Please re-check email/password. If you are new user, click on register instead.`;
        console.error('Firebase Login Error:', error);
    }
});



// Handle Register Button Click
if (registerButton) {
    registerButton.addEventListener('click', async () => {
        // First click shows the confirm password field
        if (!isRegisterMode) {
            confirmPasswordGroup.classList.remove('hidden');
            isRegisterMode = true;
            registerButton.textContent = 'Confirm Registration'; // Change button text
            authStatus.textContent = 'Please confirm your password.'; // Prompt user
            return;
        }

        // Second click performs the registration
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

        // Check if passwords match
        if (password !== confirmPassword) {
            authStatus.textContent = 'Passwords do not match!';
            return;
        }

        try {
            authStatus.textContent = 'Registering...';
            const userCredential = await auth.createUserWithEmailAndPassword(email, password);
            handleSuccessfulAuth(userCredential.user);
            authStatus.textContent = 'Registration successful! You are now logged in.';
            // Clear inputs after successful registration
            emailInput.value = '';
            passwordInput.value = '';
            confirmPasswordInput.value = '';
            // Reset to login mode
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
            // authStateChanged listener will handle UI changes
        } catch (error) {
            console.error('Logout failed:', error);
        }
    });
}



// New helper function to handle successful authentication
async function handleSuccessfulAuth(user) {
    firebaseIdToken = await user.getIdToken();
    console.log('Firebase ID Token obtained:', firebaseIdToken);
    
    authSection.classList.add('hidden');
    appSection.classList.remove('hidden');
    
    vscode.postMessage({ command: 'firebaseToken', token: firebaseIdToken });
}

// Initial check for existing login state
auth.onAuthStateChanged(async (user) => {
    if (user) {
        firebaseIdToken = await user.getIdToken();
        authStatus.textContent = `Already logged in as ${user.email || user.displayName}!`;
        authSection.classList.add('hidden');
        appSection.classList.remove('hidden');
        vscode.postMessage({ command: 'firebaseToken', token: firebaseIdToken });
    } else {
        authStatus.textContent = 'Please log in or register.';
        authSection.classList.remove('hidden');
        appSection.classList.add('hidden');
    }
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
        // Hide the apply button and show the "Applying changes..." message
        applySelectedButton.style.display = 'none';
        applyStatusMessage.style.display = 'block';
        applyStatusMessage.textContent = 'Applying changes...';
        applyStatusMessage.style.color = 'var(--vscode-editor-foreground)';
        vscode.postMessage({ command: 'applySelectedChanges', changes: selectedChanges });
    } else {
        vscode.postMessage({ command: 'showError', text: 'Please select at least one change to apply.' });
    }
});

generateButton.addEventListener('click', () => {
    
    const userStory = userStoryTextArea.value;

    if (!firebaseIdToken) {
        vscode.postMessage({ command: 'showError', text: 'Please log in to Firebase first.' });
        return;
    }
    
    if (userStory) {
        // Clear previous results and show loading message
        resultDiv.innerHTML = '';
        loadingMessage.classList.remove('hidden');
        applySelectedButton.style.display = 'none';
        applyStatusMessage.style.display = 'none';
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

window.addEventListener('message', async event => {
    const message = event.data;
    switch (message.command) {
        case 'displayParsedResult':
            // Call the new function to display the results
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
                // Use the custom token to sign in to Firebase
                const userCredential = await auth.signInWithCustomToken(message.token);
                handleSuccessfulAuth(userCredential.user);
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
    applyStatusMessage.style.display = 'none';
    applySelectedButton.style.display = 'block';

    if (explanation) {
        // Display the explanation using markdown
        resultDiv.innerHTML += `<h3>Explanation:</h3><div class="explanation-text">${marked.parse(explanation)}</div>`;
    }

    if (fileChanges && fileChanges.length > 0) {
        resultDiv.innerHTML += `<h3>File Changes:</h3>`;
        fileChanges.forEach((change, index) => {

            // Create the main container for the file change
            const fileChangeContainer = document.createElement('div');
            fileChangeContainer.classList.add('file-change-container');

            // Create the header for the collapsible section
            const header = document.createElement('div');
            header.classList.add('file-collapse-header', 'collapsed');
            header.dataset.targetId = `file-content-${index}`;

            // Create the arrow icon
            const arrow = document.createElement('span');
            arrow.classList.add('arrow');
            arrow.textContent = '▶'; // Right-pointing triangle
            header.appendChild(arrow);
            
            // Add a checkbox for selection
            const checkbox = document.createElement('input');
            checkbox.type = 'checkbox';
            checkbox.id = `checkbox-${index}`;
            checkbox.dataset.filePath = change.filePath; // Store the file path
            checkbox.checked = true; // Default to selected
            
            const fileLabel = document.createElement('label');
            fileLabel.htmlFor = `checkbox-${index}`;
            fileLabel.textContent = ` ${change.filePath} (${change.isNewFile ? 'New File' : 'Edit'})`;

            header.appendChild(checkbox);
            header.appendChild(fileLabel);

            // Create an editable div for the code content
            const codeContent = document.createElement('div');
            codeContent.id = `file-content-${index}`;
            codeContent.classList.add('file-collapse-content', 'collapsed');

            const codeEditableDiv = document.createElement('div');
            codeEditableDiv.classList.add('code-editable-div');
            codeEditableDiv.setAttribute('contenteditable', 'true');
            codeEditableDiv.dataset.filePath = change.filePath;

            // Get the language class dynamically
            const languageClass = getLanguageFromPath(change.filePath);

            // Use innerHTML to allow Prism.js to render syntax highlighting
            codeEditableDiv.innerHTML = `<pre><code class="language-${languageClass}">${escapeHtml(change.content)}</code></pre>`;

            codeContent.appendChild(codeEditableDiv);
            
            // Append the new elements to the fileChangeContainer
            fileChangeContainer.appendChild(header);
            fileChangeContainer.appendChild(codeContent);
            resultDiv.appendChild(fileChangeContainer);

            // Add the click event listener to the header
            header.addEventListener('click', () => {
                header.classList.toggle('collapsed');
                codeContent.classList.toggle('collapsed');
            });
            
            // Trigger Prism.js highlighting after the element is in the DOM
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
};

// Function to validate email format
function isValidEmail(email) {
    // A basic regex for email validation
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    return emailRegex.test(email);
}