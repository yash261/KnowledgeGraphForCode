// generate-tests.js
const fs = require('fs').promises;
const path = require('path');
const { parse } = require('@babel/parser');
const traverse = require('@babel/traverse').default;
const { GoogleGenerativeAI } = require('@google/generative-ai');
const { pipeline } = require('@xenova/transformers');
const dotenv = require('dotenv');
const pdfParse = require('pdf-parse');

// Load environment variables from .env file
const envConfig = dotenv.config();
if (envConfig.error) {
  throw new Error('Failed to load .env file: ' + envConfig.error.message);
}

if (!process.env.GEMINI_API_KEY) {
  throw new Error('GEMINI_API_KEY is not defined in .env file');
}

// Initialize Gemini API with gemini-2.0-flash
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const model = genAI.getGenerativeModel({ model: 'gemini-2.0-flash' });

// Constants
const CACHE_FILE = './cache.json';
const COMPONENTS_DIR = '../frontend/src/components/';
const DESIGN_PDF_PATH = '../design/design-task-management.pdf';
const FEATURES_DIR = '../tests/features/';

// Initialize embedding model
let embedder;
async function initializeModels() {
  if (!embedder) {
    console.log('Initializing embedder...');
    embedder = await pipeline('feature-extraction', 'Xenova/all-MiniLM-L6-v2');
    console.log('Embedder initialized');
  }
  return { embedder };
}

// Generate embedding for code or text
async function generateEmbedding(text) {
  const { embedder } = await initializeModels();
  const result = await embedder(text, { pooling: 'mean', normalize: true });
  return Array.from(result.data);
}

// Cosine similarity function (synchronous, assumes inputs are resolved arrays)
function cosineSimilarity(vecA, vecB) {
  if (!vecA || !vecB || vecA.length !== vecB.length) {
    console.warn('Invalid vectors for cosine similarity:', vecA, vecB);
    return 0;
  }
  const dotProduct = vecA.reduce((sum, a, i) => sum + a * vecB[i], 0);
  const magA = Math.sqrt(vecA.reduce((sum, a) => sum + a * a, 0));
  const magB = Math.sqrt(vecB.reduce((sum, b) => sum + b * b, 0));
  return magB === 0 || magA === 0 ? 0 : dotProduct / (magA * magB);
}

// Load or initialize cache
async function loadCache() {
  try {
    const data = await fs.readFile(CACHE_FILE, 'utf-8');
    const cache = JSON.parse(data);
    if (!cache.files) cache.files = {};
    if (!cache.knowledgeGraph) cache.knowledgeGraph = { design: {}, code: {} };
    if (!cache.tests) cache.tests = {};
    return cache;
  } catch (error) {
    console.log('Cache not found or invalid, initializing new cache:', error.message);
    return { files: {}, knowledgeGraph: { design: {}, code: {} }, tests: {} };
  }
}

async function saveCache(cache) {
  await fs.writeFile(CACHE_FILE, JSON.stringify(cache, null, 2));
}

// Extract React component code
async function extractComponentCode(code, componentName) {
  const ast = parse(code, {
    sourceType: 'module',
    plugins: ['jsx', 'typescript'],
  });
  let componentCode = code;
  for (const node of ast.program.body) {
    if (
      (node.type === 'FunctionDeclaration' && node.id.name === componentName) ||
      (node.type === 'VariableDeclaration' &&
        node.declarations[0]?.id.name === componentName &&
        (node.declarations[0].init.type === 'ArrowFunctionExpression' || node.declarations[0].init.type === 'FunctionExpression'))
    ) {
      componentCode = code.slice(node.start, node.end);
      break;
    } else if (node.type === 'ExportDefaultDeclaration' && node.declaration.name === componentName) {
      componentCode = code.slice(node.start, node.end);
      break;
    }
  }
  return componentCode;
}

// Retrieve similar context using in-memory cache
async function retrieveSimilarContext(currentCode, cache, filePath) {
  const currentEmbedding = await generateEmbedding(currentCode);
  let bestMatch = null;
  let highestSimilarity = -1;

  for (const [cachedPath, entry] of Object.entries(cache.files)) {
    if (entry.embedding) {
      const similarity = cosineSimilarity(currentEmbedding, entry.embedding);
      if (similarity > highestSimilarity) {
        highestSimilarity = similarity;
        bestMatch = { filePath: cachedPath, code: entry.code, tests: cache.tests[cachedPath], similarity };
      }
    }
  }

  if (highestSimilarity > 0.8) {
    console.log(`Retrieved similar context from ${bestMatch.filePath} with similarity ${highestSimilarity}`);
    return bestMatch;
  }
  console.log('No sufficiently similar context found for', filePath);
  return null;
}

// Clean markdown fences from test code
function cleanTestCode(testCode) {
  let cleaned = testCode.trim();
  cleaned = cleaned.replace(/^```(?:gherkin)?\s*\n?/i, '');
  cleaned = cleaned.replace(/\n?```\s*$/, '');
  cleaned = cleaned.replace(/```/g, '');
  return cleaned.trim();
}

// Chunk PDF text into sections
function chunkPdfText(text) {
  const chunks = [];
  const lines = text.split('\n');
  let currentChunk = [];
  for (const line of lines) {
    if (line.match(/^\d+\.\s/) || line.match(/^\d+\.\d+\s/)) {
      if (currentChunk.length > 0) {
        chunks.push(currentChunk.join(' '));
        currentChunk = [];
      }
    }
    currentChunk.push(line.trim());
  }
  if (currentChunk.length > 0) {
    chunks.push(currentChunk.join(' '));
  }
  return chunks;
}

// Extract entities and relationships from PDF chunks
async function extractEntitiesAndRelations(chunk) {
  const entities = { components: [], routes: [], apis: [], actions: [], credentials: null, baseUrl: null };
  const relations = [];

  const capitalize = (str) => str.charAt(0).toUpperCase() + str.slice(1);

  const queries = {
    landingPage: "is the first page",
    navigation: "navigates-to",
    requiresLogin: "requires login",
    route: "at ",
    api: "API:",
  };

  const chunkEmbedding = await generateEmbedding(chunk);

  const componentRegex = /([A-Z][a-zA-Z]+)\s+Page/gi;
  let match;
  while ((match = componentRegex.exec(chunk)) !== null) {
    const componentName = match[1];
    if (!entities.components.includes(componentName) && componentName !== "first" && componentName !== "other") {
      entities.components.push(componentName);
    }
  }

  for (const component of entities.components) {
    const componentContext = chunk.toLowerCase().includes(component.toLowerCase()) ? chunk : '';

    if (componentContext) {
      const landingEmbedding = await generateEmbedding(queries.landingPage);
      if (cosineSimilarity(chunkEmbedding, landingEmbedding) > 0.6) {
        console.log(`Detected ${component} as landing page in chunk: ${chunk}`);
      }

      const navEmbedding = await generateEmbedding(queries.navigation);
      if (cosineSimilarity(chunkEmbedding, navEmbedding) > 0.6) {
        const navMatches = [...chunk.matchAll(/navigates-to\s+([A-Za-z]+)\s+with\s+button\s+data-testid="([^"]+)"/gi)];
        for (const navMatch of navMatches) {
          const targetComponent = capitalize(navMatch[1]);
          const navigationId = navMatch[2];
          if (!entities.components.includes(targetComponent)) {
            entities.components.push(targetComponent);
          }
          relations.push({ from: component, to: targetComponent, relation: 'navigates-to', navigationId });
          console.log(`Detected navigation: ${component} -> ${targetComponent} with ${navigationId}`);
        }
      }

      const reqEmbedding = await generateEmbedding(queries.requiresLogin);
      if (cosineSimilarity(chunkEmbedding, reqEmbedding) > 0.6 || chunk.match(/Requires:\s*Login/i)) {
        relations.push({ from: component, to: 'Login', relation: 'requires' });
      }

      const routeMatch = chunk.match(/Route:\s*[A-Za-z]+\s+at\s+([\/][a-z\/]*)/i);
      if (routeMatch) {
        entities.routes.push(routeMatch[1]);
        relations.push({ from: component, to: routeMatch[1], relation: 'at-route' });
      }

      const apiEmbedding = await generateEmbedding(queries.api);
      if (cosineSimilarity(chunkEmbedding, apiEmbedding) > 0.6) {
        const apiMatch = chunk.match(/(GET|POST|PUT|DELETE)?\s*\/api\/[a-z\/<>-]+/i);
        if (apiMatch) {
          const apiPath = apiMatch[0].trim();
          entities.apis.push(apiPath);
          relations.push({ from: component, to: apiPath, relation: 'uses' });
        }
      }
    }
  }

  const credentialsMatch = chunk.match(/$$ "([^"]+)",\s*"([^"]+)" $$/);
  if (credentialsMatch && entities.components.length > 0) {
    entities.credentials = { username: credentialsMatch[1], password: credentialsMatch[2] };
  }

  const baseUrlMatch = chunk.match(/http:\/\/localhost:[0-9]+/);
  if (baseUrlMatch) entities.baseUrl = baseUrlMatch[0];

  return { entities, relations };
}

// Build design knowledge graph from PDF
async function buildDesignKnowledgeGraph(pdfPath, cache) {
  const pdfBuffer = await fs.readFile(pdfPath);
  const fullText = (await pdfParse(pdfBuffer)).text;
  const pdfHash = require('crypto').createHash('md5').update(fullText).digest('hex');
  if (cache.knowledgeGraph.design[pdfPath] && cache.knowledgeGraph.design[pdfPath].hash === pdfHash) {
    console.log('Using cached design knowledge graph');
    return cache.knowledgeGraph.design[pdfPath].graph;
  }

  console.log('Building design knowledge graph with semantic search...');
  const chunks = chunkPdfText(fullText);
  const graph = { nodes: {}, edges: [], baseUrl: null };

  for (const chunk of chunks) {
    console.log('Processing chunk:', chunk);
    const { entities, relations } = await extractEntitiesAndRelations(chunk);

    for (const component of entities.components) {
      graph.nodes[component] = graph.nodes[component] || { type: 'component' };
      if (entities.credentials && cosineSimilarity(await generateEmbedding(chunk), await generateEmbedding("is the first page")) > 0.6) {
        graph.nodes[component].credentials = entities.credentials;
        graph.nodes[component].isLandingPage = true;
      }
    }

    entities.routes.forEach(route => {
      graph.nodes[route] = { type: 'route' };
    });

    entities.apis.forEach(api => {
      const method = api.match(/(GET|POST|PUT|DELETE)/i)?.[0] || 'GET';
      graph.nodes[api] = { type: 'api', method };
    });

    entities.actions.forEach(action => {
      graph.nodes[action] = { type: 'action' };
    });

    if (entities.baseUrl && !graph.baseUrl) {
      graph.baseUrl = entities.baseUrl;
    }

    relations.forEach(rel => {
      if (rel.relation === 'at-route') {
        graph.nodes[rel.from].route = rel.to;
      } else if (rel.relation === 'requires') {
        graph.nodes[rel.from].requiresLogin = true;
      }
      graph.edges.push(rel);
    });
  }

  const landingQueryEmbedding = await generateEmbedding("is the first page");
  let landingPageSet = false;
  for (const node of Object.keys(graph.nodes)) {
    if (graph.nodes[node].type === 'component') {
      const nodeContext = fullText.toLowerCase().includes(node.toLowerCase()) ? fullText : '';
      if (nodeContext && (cosineSimilarity(await generateEmbedding(nodeContext), landingQueryEmbedding) > 0.6 || nodeContext.includes(`${node.toLowerCase()} at /`))) {
        graph.nodes[node].isLandingPage = true;
        landingPageSet = true;
        console.log(`Identified ${node} as landing page via semantic search or route /`);
      }
    }
  }

  if (!landingPageSet && graph.nodes['Login']) {
    graph.nodes['Login'].isLandingPage = true;
    console.log('No landing page detected; defaulting to Login');
  }

  console.log('Graph nodes:', JSON.stringify(graph.nodes, null, 2));
  console.log('Graph edges:', JSON.stringify(graph.edges, null, 2));
  console.log('Base URL:', graph.baseUrl);

  cache.knowledgeGraph.design[pdfPath] = { hash: pdfHash, graph };
  await saveCache(cache);
  return graph;
}

// Build code knowledge graph from component code
async function buildCodeKnowledgeGraph(filePath, code, componentName, cache) {
  const codeHash = require('crypto').createHash('md5').update(code).digest('hex');
  if (cache.knowledgeGraph.code[filePath] && cache.knowledgeGraph.code[filePath].hash === codeHash) {
    console.log(`Using cached code knowledge graph for ${filePath}`);
    return cache.knowledgeGraph.code[filePath].graph;
  }

  console.log(`Building code knowledge graph for ${componentName}`);
  const graph = { nodes: {}, edges: [], baseUrl: null };

  const ast = parse(code, {
    sourceType: 'module',
    plugins: ['jsx', 'typescript'],
  });

  graph.nodes[componentName] = { type: 'component' };

  traverse(ast, {
    JSXAttribute(path) {
      if (path.node.name.name === 'data-testid') {
        const testId = path.node.value.value;
        graph.nodes[testId] = { type: 'element' };
        graph.edges.push({ from: componentName, to: testId, relation: 'contains' });
      }
    },
    CallExpression(path) {
      if (path.node.callee.name === 'navigate' || (path.node.callee.property && path.node.callee.property.name === 'push')) {
        const route = path.node.arguments[0]?.value;
        if (route) {
          graph.nodes[route] = { type: 'route' };
          graph.edges.push({ from: componentName, to: route, relation: 'navigates-to' });
        }
      }
    },
  });

  console.log(`Code graph for ${componentName}:`, JSON.stringify(graph, null, 2));
  cache.knowledgeGraph.code[filePath] = { hash: codeHash, graph };
  await saveCache(cache);
  return graph;
}

// Merge design and code knowledge graphs
function mergeKnowledgeGraphs(designGraph, codeGraph, componentName) {
  const mergedGraph = {
    nodes: { ...designGraph.nodes, ...codeGraph.nodes },
    edges: [...designGraph.edges, ...codeGraph.edges],
    baseUrl: designGraph.baseUrl || codeGraph.baseUrl,
  };

  for (const node in codeGraph.nodes) {
    if (designGraph.nodes[node]) {
      mergedGraph.nodes[node] = { ...designGraph.nodes[node], ...codeGraph.nodes[node] };
    }
  }

  if (mergedGraph.nodes[componentName]) {
    mergedGraph.nodes[componentName] = {
      ...mergedGraph.nodes[componentName],
      ...codeGraph.nodes[componentName],
    };
  }

  console.log(`Merged graph for ${componentName}:`, JSON.stringify(mergedGraph, null, 2));
  return mergedGraph;
}

// Get component-specific context from merged graph
function getComponentContext(mergedGraph, componentName) {
  const context = [];
  const node = mergedGraph.nodes[componentName] || {};

  if (node.type === 'component') {
    context.push(`Component: ${componentName}`);
    if (node.isLandingPage) context.push('Is Landing Page: true');
    if (node.route) context.push(`Route: ${node.route}`);
    if (node.requiresLogin) context.push('Requires Login: true');
    if (node.credentials) context.push(`Credentials: ${JSON.stringify(node.credentials)}`);
  }

  mergedGraph.edges.forEach(edge => {
    if (edge.from === componentName) {
      if (edge.relation === 'navigates-to') {
        context.push(`Navigates to: ${edge.to} with navigationId: ${edge.navigationId || 'N/A'}`);
      } else if (edge.relation === 'uses') {
        context.push(`Uses API: ${edge.to}`);
      } else if (edge.relation === 'contains') {
        context.push(`Contains Element: ${edge.to}`);
      }
    }
  });

  context.push(`Base URL: ${mergedGraph.baseUrl || 'Not specified'}`);
  return context.join('\n');
}

// Determine test order based on design graph
function determineTestOrder(componentFiles, designGraph) {
  const orderedFiles = [];
  const remainingFiles = [...componentFiles];

  for (const node in designGraph.nodes) {
    if (designGraph.nodes[node].type === 'component' && designGraph.nodes[node].isLandingPage) {
      const fileName = `${node}.js`;
      const index = remainingFiles.indexOf(fileName);
      if (index !== -1) {
        orderedFiles.push(fileName);
        remainingFiles.splice(index, 1);
        break;
      }
    }
  }

  while (remainingFiles.length > 0) {
    let added = false;
    for (const edge of designGraph.edges) {
      if (edge.relation === 'navigates-to' && orderedFiles.includes(`${edge.from}.js`)) {
        const targetFile = `${edge.to}.js`;
        const index = remainingFiles.indexOf(targetFile);
        if (index !== -1) {
          orderedFiles.push(targetFile);
          remainingFiles.splice(index, 1);
          added = true;
          break;
        }
      }
    }
    if (!added) {
      orderedFiles.push(remainingFiles.shift());
    }
  }

  return orderedFiles;
}

// Generate BDD test cases in Gherkin format
async function generateComponentTest(codeSnippet, componentContext, componentName, similarContext, baseUrl) {
  const contextSection = similarContext 
    ? `
      **Similar Previous BDD Scenarios:**
      Code:
      \`\`\`javascript
      ${similarContext.code}
      \`\`\`
      Scenarios:
      \`\`\`gherkin
      ${similarContext.tests}
      \`\`\`
      Similarity: ${similarContext.similarity}
    `
    : 'No similar previous code or scenarios found.';

  const prompt = `
    Generate a BDD test case in Gherkin format (using Feature, Scenario, Given, When, Then) for the provided React component. The test must:
    - Describe the behavior of the component in a human-readable way, focusing on user interactions and expected outcomes.
    - Be part of a test suite starting from the landing page identified in the context.
    - If the component is the landing page:
      - Include a scenario for logging in if credentials are provided, referencing UI elements by their data-testid attributes (e.g., username, password, submit).
      - Verify successful login by checking for a success message.
    - If the component is not the landing page:
      - Assume the user is logged in if required by the context.
      - Include a scenario for navigating to the component's route using a navigation button's data-testid from the context.
      - Test core functionality (e.g., viewing a list, submitting a form) with positive cases.
    - Use provided context for details (e.g., base URL, routes, APIs, credentials, navigation IDs).
    - Use data-testid attributes for UI elements (e.g., '[data-testid="submit"]').
    - Do not include implementation details or automation code (e.g., Playwright commands).
    - Do not include markdown fences (e.g., \`\`\`gherkin)—output raw Gherkin text only.
    - Ensure proper indentation (2 spaces) and consistent Gherkin syntax.

    ${contextSection}

    **Combined Knowledge Graph Context for Component:**
    ${componentContext}

    **React Component Code:**
    \`\`\`javascript
    ${codeSnippet}
    \`\`\`
  `;

  console.log(`Generating BDD test for ${componentName} with Gemini`);
  const result = await model.generateContent(prompt);
  const rawTestCode = result.response.text();
  const testCode = cleanTestCode(rawTestCode);

  console.log(`Raw Gemini output for ${componentName}:`, JSON.stringify(rawTestCode));
  console.log(`Cleaned test code for ${componentName}:`, JSON.stringify(testCode));

  return testCode;
}

// Generate BDD test cases for all components
async function generateTestsForComponents(componentFiles, designGraph, cache) {
  const orderedFiles = determineTestOrder(componentFiles, designGraph);
  console.log('Ordered files before processing:', orderedFiles);

  await fs.mkdir(FEATURES_DIR, { recursive: true });

  for (const file of orderedFiles) {
    const filePath = path.join(COMPONENTS_DIR, file);
    const code = await fs.readFile(filePath, 'utf-8');
    const componentName = path.basename(filePath, path.extname(filePath));
    const currentCode = await extractComponentCode(code, componentName);
    const currentEmbedding = await generateEmbedding(currentCode);

    const fileCache = cache.files[filePath] || { componentName: null, embedding: null, code: '' };
    const cachedEmbedding = fileCache.embedding || null;
    const cachedComponentName = fileCache.componentName || '';

    let generatedTest;
    const similarityThreshold = 0.95;

    if (!cachedEmbedding || cachedComponentName !== componentName || cosineSimilarity(currentEmbedding, cachedEmbedding) < similarityThreshold) {
      console.log(`Generating test for ${componentName} due to new, renamed, or changed code`);
      const similarContext = await retrieveSimilarContext(currentCode, cache, filePath);
      const codeGraph = await buildCodeKnowledgeGraph(filePath, code, componentName, cache);
      const combinedGraph = mergeKnowledgeGraphs(designGraph, codeGraph, componentName);
      const componentContext = getComponentContext(combinedGraph, componentName);
      generatedTest = await generateComponentTest(currentCode, componentContext, componentName, similarContext, combinedGraph.baseUrl);
      cache.files[filePath] = { componentName, embedding: currentEmbedding, code: currentCode };
      cache.tests[filePath] = generatedTest;
      if (cachedComponentName && cachedComponentName !== componentName) {
        console.log(`Component renamed from ${cachedComponentName} to ${componentName}`);
      }
    } else {
      console.log(`Using cached test for ${componentName}`);
      generatedTest = cache.tests[filePath];
    }

    if (!generatedTest || typeof generatedTest !== 'string' || generatedTest.trim() === '') {
      throw new Error(`Generated test for ${componentName} is invalid or empty`);
    }

    const featureFilePath = path.join(FEATURES_DIR, `${componentName.toLowerCase()}.feature`);
    await fs.writeFile(featureFilePath, generatedTest);
    console.log(`Generated BDD test saved at ${featureFilePath}`);
  }

  await saveCache(cache);
}

// Main function to generate tests
async function generateTests() {
  try {
    console.log('Initializing models...');
    await initializeModels();

    console.log('Loading cache...');
    const cache = await loadCache();

    console.log('Building design knowledge graph from PDF...');
    const designGraph = await buildDesignKnowledgeGraph(DESIGN_PDF_PATH, cache);

    console.log('Scanning components directory...');
    const componentFiles = (await fs.readdir(COMPONENTS_DIR)).filter(file => 
      file.endsWith('.js') || file.endsWith('.jsx')
    );

    console.log('Generating BDD tests for all components...');
    await generateTestsForComponents(componentFiles, designGraph, cache);

    console.log('All BDD tests generated successfully in', FEATURES_DIR);
    console.log('Next step: Implement step definitions with a BDD framework like Cucumber.');
  } catch (error) {
    console.error('Error in test generation:', error);
    process.exit(1);
  }
}

generateTests();