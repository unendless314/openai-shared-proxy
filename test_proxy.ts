import { spawn, ChildProcess } from 'child_process';
import fs from 'fs';
import path from 'path';
import express from 'express';

// Interfaces for our test runner
interface TestState {
  mockErrorStatus: number | null;
  mockErrorText: string;
  requestCounts: Record<string, number>;
}

const state: TestState = {
  mockErrorStatus: null,
  mockErrorText: 'Mock Server Error',
  requestCounts: {}
};

// 1. Start the Mock Upstream Server on Port 3002
const mockApp = express();
mockApp.use(express.json());

mockApp.post('/v1/chat/completions', (req, res) => {
  const authHeader = req.headers.authorization || '';
  const key = authHeader.replace('Bearer ', '').trim();
  
  // Track requests per key
  state.requestCounts[key] = (state.requestCounts[key] || 0) + 1;
  console.log(`[Mock Upstream] Received request on key: ${key.substring(0, 15)}... (Request #${state.requestCounts[key]})`);

  // Simulate failures if state.mockErrorStatus is set
  if (state.mockErrorStatus) {
    console.log(`[Mock Upstream] Simulating configured failure: HTTP ${state.mockErrorStatus}`);
    res.status(state.mockErrorStatus).json({
      error: {
        message: state.mockErrorText,
        type: 'mock_error',
        code: 'mock_failure'
      }
    });
    return;
  }

  const isStream = req.body.stream === true;
  
  if (isStream) {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');

    // Send chunks
    res.write('data: {"id":"chatcmpl-test","object":"chat.completion.chunk","choices":[{"delta":{"content":"Hi "}}]}\n\n');
    res.write('data: {"id":"chatcmpl-test","object":"chat.completion.chunk","choices":[{"delta":{"content":"there!"}}]}\n\n');
    // Send standard usage chunk as configured by stream_options
    res.write('data: {"id":"chatcmpl-test","object":"chat.completion.chunk","choices":[],"usage":{"prompt_tokens":10,"completion_tokens":5,"total_tokens":15}}\n\n');
    res.write('data: [DONE]\n\n');
    res.end();
  } else {
    // Non-streaming response
    res.json({
      id: 'chatcmpl-test',
      object: 'chat.completion',
      created: Math.floor(Date.now() / 1000),
      model: req.body.model || 'gpt-4o-mini',
      choices: [{
        index: 0,
        message: {
          role: 'assistant',
          content: 'Hello, this is a mock completion.'
        },
        finish_reason: 'stop'
      }],
      usage: {
        prompt_tokens: 10,
        completion_tokens: 5,
        total_tokens: 15
      }
    });
  }
});

const mockServer = mockApp.listen(3002, () => {
  console.log('✅ Mock Upstream Server listening on http://127.0.0.1:3002');
});

// Helper to delay execution
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

async function runTests() {
  const dbPath = path.resolve(__dirname, 'test_proxy.db');
  
  // Clean up previous database to isolate tests
  if (fs.existsSync(dbPath)) {
    fs.unlinkSync(dbPath);
    console.log(`🧹 Cleaned up old database at: ${dbPath}`);
  }

  // 2. Spawn the Proxy Server on Port 3001 with custom test environments
  const env = {
    ...process.env,
    PORT: '3001',
    HOST: '127.0.0.1',
    PROXY_API_KEY: 'test-proxy-token',
    ADMIN_USERNAME: 'admin',
    ADMIN_PASSWORD: 'adminpass',
    OPENAI_BASE_URL: 'http://127.0.0.1:3002/v1',
    OPENAI_SHARED_KEYS: 'sk-free-key-1,sk-free-key-2',
    OPENAI_MASTER_KEY: 'sk-paid-master-key',
    KEY_DAILY_TOKEN_LIMIT: '35', // limit to 35 tokens (each request consumes 15 tokens, so max 2 requests per key!)
    KEY_DAILY_REQ_LIMIT: '10',
    KEY_COOLDOWN_MS: '1500', // Short cooldown for testing
    REQUEST_TIMEOUT_MS: '4000',
    MAX_RETRIES: '1',
    SQLITE_PATH: dbPath
  };

  console.log('🚀 Spawning proxy server in test mode...');
  const proxyProcess = spawn('npx', ['tsx', 'src/index.ts'], { env });

  // Pipe proxy output to test logs
  proxyProcess.stdout.on('data', (data) => {
    console.log(`[Proxy Server] ${data.toString().trim()}`);
  });
  proxyProcess.stderr.on('data', (data) => {
    console.error(`[Proxy Server Error] ${data.toString().trim()}`);
  });

  // Wait for proxy to start up
  await sleep(3000);

  let exitCode = 0;

  try {
    console.log('\n--- 🧪 TEST 1: Bearer Auth Failure ---');
    const authFailResp = await fetch('http://127.0.0.1:3001/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ messages: [{ role: 'user', content: 'hi' }] })
    });
    console.log(`Status code: ${authFailResp.status} (Expected: 401)`);
    if (authFailResp.status !== 401) throw new Error('Auth failure test failed');

    console.log('\n--- 🧪 TEST 2: Successful Non-Streaming Call ---');
    const successResp1 = await fetch('http://127.0.0.1:3001/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer test-proxy-token'
      },
      body: JSON.stringify({ messages: [{ role: 'user', content: 'hi' }] })
    });
    console.log(`Status code: ${successResp1.status} (Expected: 200)`);
    if (successResp1.status !== 200) throw new Error('First success request failed');
    
    console.log(`X-Proxy-Upstream-Key-Type: ${successResp1.headers.get('X-Proxy-Upstream-Key-Type')} (Expected: free)`);
    console.log(`X-Proxy-Upstream-Model: ${successResp1.headers.get('X-Proxy-Upstream-Model')} (Expected: gpt-4o-mini)`);
    const success1Json = await successResp1.json() as any;
    console.log(`Token usage returned: ${success1Json.usage?.total_tokens} (Expected: 15)`);

    console.log('\n--- 🧪 TEST 3: Successful Streaming Call & SSE Chunk Usage ---');
    const streamResp = await fetch('http://127.0.0.1:3001/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer test-proxy-token'
      },
      body: JSON.stringify({
        messages: [{ role: 'user', content: 'hi stream' }],
        stream: true
      })
    });
    console.log(`Status code: ${streamResp.status} (Expected: 200)`);
    if (streamResp.status !== 200) throw new Error('Stream request failed');
    
    const reader = streamResp.body?.getReader();
    const decoder = new TextDecoder();
    let streamText = '';
    while (true) {
      const { done, value } = await reader!.read();
      if (done) break;
      streamText += decoder.decode(value, { stream: true });
    }
    console.log(`Stream complete. Output includes usage data: ${streamText.includes('usage')}`);
    if (!streamText.includes('usage')) throw new Error('Stream response did not forward usage data');

    console.log('\n--- 🧪 TEST 4: Key Failure and Cooldown Failover ---');
    // Set mock server to return 500 Internal Server Error
    state.mockErrorStatus = 500;
    state.mockErrorText = 'Upstream database deadlock';
    
    const failResp = await fetch('http://127.0.0.1:3001/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer test-proxy-token'
      },
      body: JSON.stringify({ messages: [{ role: 'user', content: 'trigger retry' }] })
    });
    
    // It should have failed on free key 1, and retried automatically on free key 2!
    // Since free key 2 also fails on HTTP 500, it should propagate the 500 error back to us.
    console.log(`Fail status code: ${failResp.status} (Expected: 500)`);
    if (failResp.status !== 500) throw new Error('Expected failover failure propagation to return 500');

    // Reset mock server to operational status
    state.mockErrorStatus = null;

    console.log('\n--- 🧪 TEST 5: Admin API Stats & HTML Dashboard ---');
    const basicAuth = Buffer.from('admin:adminpass').toString('base64');
    const adminApiResp = await fetch('http://127.0.0.1:3001/api/status', {
      headers: { 'Authorization': `Basic ${basicAuth}` }
    });
    
    console.log(`Admin API status: ${adminApiResp.status} (Expected: 200)`);
    if (adminApiResp.status !== 200) throw new Error('Admin API request failed');
    
    const adminData = await adminApiResp.json() as any;
    console.log('Retrieved key states from DB:');
    adminData.upstreamKeys.forEach((key: any) => {
      console.log(`- Key label: ${key.label}, Type: ${key.keyType}, Healthy: ${key.healthy}, Cooldown: ${key.cooldownUntil !== null}, Errors: ${key.lastError}`);
    });

    // Check HTML Dashboard
    const adminHtmlResp = await fetch('http://127.0.0.1:3001/status', {
      headers: { 'Authorization': `Basic ${basicAuth}` }
    });
    console.log(`Admin HTML status: ${adminHtmlResp.status} (Expected: 200)`);
    if (adminHtmlResp.status !== 200) throw new Error('Admin HTML request failed');
    const htmlText = await adminHtmlResp.text();
    console.log(`HTML dashboard loaded successfully! Size: ${htmlText.length} bytes`);

    console.log('\n--- 🧪 TEST 6: Free Pool Exhaustion & Fallback to Paid Master Key ---');
    // Wait for key cooldowns to clear (cooldown is configured as 1.5 seconds)
    console.log('Waiting 2 seconds for cooldowns to reset...');
    await sleep(2000);

    // Currently: 
    // - Free key 1 has 1 successful non-stream (15 tokens)
    // - Free key 2 has 1 successful stream (15 tokens)
    // Let's send 2 more calls. Since KEY_DAILY_TOKEN_LIMIT is 35, sending 2 more calls of 15 tokens
    // will exhaust the free keys (15 + 15 = 30 tokens, next request would hit 45 tokens > 35 limit!)
    
    console.log('Sending more requests to push free keys past token limits...');
    for (let i = 0; i < 4; i++) {
      const resp = await fetch('http://127.0.0.1:3001/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': 'Bearer test-proxy-token'
        },
        body: JSON.stringify({ messages: [{ role: 'user', content: 'push limit' }] })
      });
      const data = await resp.json() as any;
      console.log(`Call #${i + 1} Status: ${resp.status}, routed via Key Type: ${resp.headers.get('X-Proxy-Upstream-Key-Type')}`);
    }

    // Now send one more call. Since all free keys are exhausted (>35 limit), it MUST fall back to the Paid Master Key!
    const fallbackResp = await fetch('http://127.0.0.1:3001/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer test-proxy-token'
      },
      body: JSON.stringify({ messages: [{ role: 'user', content: 'test fallback' }] })
    });
    console.log(`Fallback Call Status: ${fallbackResp.status} (Expected: 200)`);
    const keyTypeHeader = fallbackResp.headers.get('X-Proxy-Upstream-Key-Type');
    console.log(`Routing Tier: ${keyTypeHeader} (Expected: master)`);
    if (keyTypeHeader !== 'master') throw new Error('Failed to fallback to Paid Master Key');

    console.log('\n✅ ALL INTEGRATION TESTS PASSED SUCCESSFULLY! 🎉');

  } catch (error: any) {
    console.error('\n❌ INTEGRATION TESTS FAILED:', error.message);
    exitCode = 1;
  } finally {
    // 3. Clean up Mock Server and Proxy Child Process
    console.log('\n🧹 Cleaning up test processes...');
    mockServer.close();
    proxyProcess.kill('SIGINT');
    
    await sleep(1000);
    
    // Clean up DB file
    if (fs.existsSync(dbPath)) {
      try {
        fs.unlinkSync(dbPath);
        console.log('🧹 Cleaned up temporary test database.');
      } catch (err) {
        console.error('Failed to delete temporary test database file.', err);
      }
    }

    process.exit(exitCode);
  }
}

runTests();
