# sLM - Simple Language Model Chat

A lightweight web-based chat interface for language models using the MLC-AI/Web-LLM framework.

## Features

- Clean, modern UI for interacting with language models
- Support for multiple models
- Real-time streaming responses
- Responsive design that works on mobile and desktop
- Built with TypeScript for type safety

## Getting Started

### Prerequisites

- Node.js (v14 or later)
- npm or yarn

### Installation

1. Clone the repository
   ```bash
   git clone https://github.com/JhinQaQ/ANN.git
   cd ANN
2. Run this project
   ```bash
   npm install
   npm start

### Additional Steps for Windows Users

1. **Create a Node.js Script File**:

   - In the `examples\simple-chat` directory, create a file named `copy-config.js`.
   - Add the following code to handle file copying:
     ```javascript
     const fs = require("fs");
     // Copy file
     fs.copyFileSync("src/gh-config.js", "src/app-config.js");
     ```

2. **Modify `package.json`**:

   - In the `scripts` section of your `package.json`, replace Unix-style `cp` commands with our new Node.js script. For example:
     ```json
     "scripts": {
         "start": "node copy-config.js && parcel src/llm_chat.html --port 8888",
         "mlc-local": "node copy-config.js && parcel src/llm_chat.html --port 8888",
         "build": "node copy-config.js && parcel build src/llm_chat.html --dist-dir lib --no-content-hash"
     },
     ```

3. **Run the Application**:
   - Save your changes and run `npm start` in CMD or PowerShell to start the application.
