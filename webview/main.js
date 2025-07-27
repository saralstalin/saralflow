// webview/main.js

// Acquire the VS Code API. This is necessary for the webview to communicate with the extension.
const vscode = acquireVsCodeApi();

// This function will be called by the extension to render the graph
function renderGraph(nodesData, edgesData) {
    // Create Vis.js DataSets from the received data
    const nodes = new vis.DataSet(nodesData);
    const edges = new vis.DataSet(edgesData);

    // Get the HTML element where the network will be rendered
    const container = document.getElementById('mynetwork');
    const data = { nodes, edges };

    // Define options for the vis-network visualization
    const options = {
        nodes: {
            shape: 'dot', // Default shape for nodes
            size: 16,     // Default size for nodes
            font: {
                size: 14,
                color: '#ffffff' // Default font color
            },
            borderWidth: 2 // Default border width
        },
        edges: {
            width: 2,       // Default edge width
            arrows: 'to',   // Arrows pointing towards the target node
            color: {
                color: '#848484',       // Default edge color
                highlight: '#848484',   // Color when highlighted
                hover: '#848484',       // Color on hover
                inherit: 'from',        // Inherit color from source node
                opacity: 0.5            // Default opacity
            },
            dashes: true // Make edges dashed by default for better differentiation
        },
        physics: {
            enabled: true,
            barnesHut: {
                gravitationalConstant: -2000,
                centralGravity: 0.3,
                springLength: 95,
                springConstant: 0.04,
                damping: 0.09,
                avoidOverlap: 0.5
            },
            solver: 'barnesHut' // Use BarnesHut algorithm for physics simulation
        },
        interaction: {
            navigationButtons: true, // Show navigation buttons (zoom, pan)
            keyboard: true           // Enable keyboard navigation
        }
    };

    // Create a new vis.Network instance
    const network = new vis.Network(container, data, options);

    // Optional: Add event listener for node clicks.
    // When a node is clicked, send a message back to the extension.
    network.on("click", function (params) {
        if (params.nodes.length > 0) {
            const nodeId = params.nodes[0];
            // Send the clicked node's ID back to the extension
            vscode.postMessage({ command: 'nodeClicked', nodeId: nodeId });
        }
    });

    console.log('Graph rendered with vis-network!');
}

// Listen for messages from the extension
window.addEventListener('message', event => {
    const message = event.data; // The JSON data sent from our extension

    switch (message.command) {
        case 'renderGraph':
            console.log('Received renderGraph command from extension.');
            // Call the renderGraph function with the received node and edge data
            renderGraph(message.nodes, message.edges);
            break;
        // You can add more cases here for other commands from the extension (e.g., 'updateGraph')
    }
});

console.log('Webview main.js loaded.');

// Send a 'webviewReady' message to the extension once this script is loaded.
// This signals to the extension that it's safe to send data.
vscode.postMessage({ command: 'webviewReady' });