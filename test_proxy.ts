import { spawn, ChildProcess } from 'child_process';
import fs from 'fs';
import path from 'path';
import express from 'express';
import Database from 'better-sqlite3';

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
    if (state.mockErrorText.startsWith('<') || state.mockErrorText.includes('Gateway') || state.mockErrorText.includes('key')) {
      res.status(state.mockErrorStatus).send(state.mockErrorText);
    } else {
      res.status(state.mockErrorStatus).json({
        error: {
          message: state.mockErrorText,
          type: 'mock_error',
          code: 'mock_failure'
        }
      });
    }
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

mockApp.post('/v1/responses', (req, res) => {
  const authHeader = req.headers.authorization || '';
  const key = authHeader.replace('Bearer ', '').trim();
  
  // Track requests per key
  state.requestCounts[key] = (state.requestCounts[key] || 0) + 1;
  console.log(`[Mock Upstream] Received /responses request on key: ${key.substring(0, 15)}... (Request #${state.requestCounts[key]})`);

  // Verify parameter normalization assertions
  if (req.body.max_tokens !== undefined) {
    console.error('❌ [Mock Server Assertion Failed] max_tokens was not removed!');
    res.status(400).json({ error: { message: 'Upstream received raw max_tokens parameters. Normalization failed.' } });
    return;
  }
  // In TEST 7 and TEST 7a, max_tokens: 100 is sent, which should be normalized to max_output_tokens: 100
  if ((req.body.model === 'gpt-4o' && req.body.stream !== true) || req.body.model === 'responses-fail-nonstream') {
    if (req.body.max_output_tokens === undefined) {
      console.error('❌ [Mock Server Assertion Failed] max_output_tokens is missing for normalized request!');
      res.status(400).json({ error: { message: 'Upstream did not receive max_output_tokens parameter. Mapping failed.' } });
      return;
    }
    if (req.body.max_output_tokens !== 100) {
      console.error(`❌ [Mock Server Assertion Failed] max_output_tokens value was wrong: ${req.body.max_output_tokens}!`);
      res.status(400).json({ error: { message: 'Upstream received wrong max_output_tokens value.' } });
      return;
    }
    console.log('✅ [Mock Server Assertion Passed] max_output_tokens normalized successfully.');
  }

  // Simulate failures if state.mockErrorStatus is set
  if (state.mockErrorStatus) {
    console.log(`[Mock Upstream] Simulating responses failure: HTTP ${state.mockErrorStatus}`);
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

    if (req.body.model === 'responses-fail-stream') {
      // Mock stream failure event (Finding 1 validation)
      res.write('event: response.created\r\ndata: {"id":"resp-test"}\r\n\r\n');
      res.write('event: response.failed\r\ndata: {"id":"resp-test","type":"response.failed","response":{"status":{"error":{"message":"Mock Agent Failure"}},"usage":{"input_tokens":10,"output_tokens":4,"input_tokens_details":{"cached_tokens":2}}}}\r\n\r\n');
      res.write('data: [DONE]\n\n');
      res.end();
      return;
    }

    // Send event blocks with varying event and type headers, CRLF, and LF variations
    res.write('event: response.created\r\ndata: {"id":"resp-test"}\r\n\r\n');
    res.write('event: response.delta\ndata: {"id":"resp-test","delta":{"content":"Hi"}}\n\n');
    // Test event block with response.completed event carrying usage and cached token info
    res.write('event: response.completed\r\ndata: {"id":"resp-test","type":"response.completed","response":{"usage":{"input_tokens":12,"output_tokens":6,"input_tokens_details":{"cached_tokens":4}}}}\r\n\r\n');
    res.write('data: [DONE]\n\n');
    res.end();
  } else {
    if (req.body.model === 'responses-fail-nonstream') {
      // Mock semantic failure for non-streaming Responses API (Finding 1 validation)
      res.json({
        id: 'resp-test',
        object: 'response',
        status: 'failed',
        created: Math.floor(Date.now() / 1000),
        model: 'responses-fail-nonstream',
        usage: {
          input_tokens: 8,
          output_tokens: 2,
          input_tokens_details: {
            cached_tokens: 1
          }
        }
      });
      return;
    }

    // Return standard responses json body with mapped token details and cached input details
    res.json({
      id: 'resp-test',
      object: 'response',
      created: Math.floor(Date.now() / 1000),
      model: req.body.model || 'gpt-4o',
      usage: {
        input_tokens: 12,
        output_tokens: 6,
        input_tokens_details: {
          cached_tokens: 4
        }
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

    // Wait for cooldowns to reset before testing 4a
    console.log('Waiting 2 seconds for cooldowns to clear...');
    await sleep(2000);

    console.log('\n--- 🧪 TEST 4a: Non-JSON Upstream Error Handling ---');
    state.mockErrorStatus = 502;
    state.mockErrorText = 'Bad Gateway';

    const nonJsonResp = await fetch('http://127.0.0.1:3001/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer test-proxy-token'
      },
      body: JSON.stringify({ messages: [{ role: 'user', content: 'test non-json' }] })
    });

    console.log(`Non-JSON status: ${nonJsonResp.status} (Expected: 502)`);
    const nonJsonData = await nonJsonResp.json() as any;
    console.log(`Response structure:`, JSON.stringify(nonJsonData));
    if (!nonJsonData.error || !nonJsonData.error.message || !nonJsonData.error.message.includes('Bad Gateway')) {
      throw new Error('Non-JSON error fallback did not return standard error payload!');
    }
    console.log('✅ Standard error payload returned successfully!');
    state.mockErrorStatus = null;

    // Wait for cooldowns to reset before testing 4b
    console.log('Waiting 2 seconds for cooldowns to clear...');
    await sleep(2000);

    console.log('\n--- 🧪 TEST 4b: 401 Permanent Disabling ---');
    // Set mock server to return 401 Unauthorized
    state.mockErrorStatus = 401;
    state.mockErrorText = 'Invalid API key';

    const authFailResp2 = await fetch('http://127.0.0.1:3001/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer test-proxy-token'
      },
      body: JSON.stringify({ messages: [{ role: 'user', content: 'trigger 401' }] })
    });

    console.log(`401 response status: ${authFailResp2.status} (Expected: 401)`);
    state.mockErrorStatus = null; // Restore mock server to normal

    // Wait a tiny bit for DB to update
    await sleep(200);

    // The first free key (sk-free-key-1) should now be permanently disabled.
    // Let's verify by sending a successful request. It should route to sk-free-key-2 instead of sk-free-key-1!
    const routeCheckResp = await fetch('http://127.0.0.1:3001/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer test-proxy-token'
      },
      body: JSON.stringify({ messages: [{ role: 'user', content: 'check routed key' }] })
    });

    console.log(`Route check status: ${routeCheckResp.status} (Expected: 200)`);
    const routedKeyType = routeCheckResp.headers.get('X-Proxy-Upstream-Key-Type');
    console.log(`Routed to key type: ${routedKeyType} (Expected: free)`);
    
    // We should fetch status details to verify that one of the keys is indeed marked as isDisabled: true
    const basicAuthCheck = Buffer.from('admin:adminpass').toString('base64');
    const adminCheckResp = await fetch('http://127.0.0.1:3001/api/status', {
      headers: { 'Authorization': `Basic ${basicAuthCheck}` }
    });
    const checkData = await adminCheckResp.json() as any;
    const disabledKey = checkData.upstreamKeys.find((k: any) => k.isDisabled === true);
    if (!disabledKey) {
      throw new Error('Key was not marked as permanently disabled in database after 401!');
    }
    console.log(`✅ Verified key ${disabledKey.label} was permanently disabled!`);

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
      console.log(`- Key label: ${key.label}, Type: ${key.keyType}, Healthy: ${key.healthy}, Cooldown: ${key.cooldownUntil !== null}, Disabled: ${key.isDisabled}, Errors: ${key.lastError}`);
    });

    if (adminData.usageEstimate.inputTokens === undefined || adminData.usageEstimate.outputTokens === undefined) {
      throw new Error('API status usageEstimate is missing inputTokens or outputTokens splits!');
    }
    console.log(`Verified usageEstimate splits: inputTokens = ${adminData.usageEstimate.inputTokens}, outputTokens = ${adminData.usageEstimate.outputTokens}`);

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

    console.log('\n--- 🧪 TEST 7: Responses API Non-Streaming Call ---');
    const resp1 = await fetch('http://127.0.0.1:3001/v1/responses', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer test-proxy-token'
      },
      body: JSON.stringify({
        model: 'gpt-4o',
        max_tokens: 100 // Test max_tokens -> max_output_tokens normalization!
      })
    });
    console.log(`Status code: ${resp1.status} (Expected: 200)`);
    if (resp1.status !== 200) throw new Error('Responses non-stream request failed');
    const resp1Json = await resp1.json() as any;
    console.log(`Usage returned:`, JSON.stringify(resp1Json.usage));
    if (resp1Json.usage?.input_tokens !== 12 || resp1Json.usage?.output_tokens !== 6) {
      throw new Error('Responses usage returned does not match expected upstream values!');
    }
    if (resp1Json.usage?.input_tokens_details?.cached_tokens !== 4) {
      throw new Error('Responses cached tokens returned does not match expected values!');
    }

    console.log('\n--- 🧪 TEST 7a: Responses API Failed Non-Streaming Call & Observable Status ---');
    const respFailNonStream = await fetch('http://127.0.0.1:3001/v1/responses', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer test-proxy-token'
      },
      body: JSON.stringify({
        model: 'responses-fail-nonstream',
        max_tokens: 100
      })
    });
    console.log(`Status code: ${respFailNonStream.status} (Expected: 200)`);
    if (respFailNonStream.status !== 200) throw new Error('Responses fail non-stream request failed');
    const respFailNonStreamJson = await respFailNonStream.json() as any;
    console.log(`Semantic status:`, respFailNonStreamJson.status);
    if (respFailNonStreamJson.status !== 'failed') {
      throw new Error('Expected status to be failed!');
    }
    
    // Wait a tiny bit for DB update
    await sleep(200);

    // Verify key status in Dashboard API (should NOT be disabled or cooled down under Option A)
    const adminCheckRespFailNS = await fetch('http://127.0.0.1:3001/api/status', {
      headers: { 'Authorization': `Basic ${basicAuth}` }
    });
    const checkDataFailNS = await adminCheckRespFailNS.json() as any;
    const masterKeyNS = checkDataFailNS.upstreamKeys.find((k: any) => k.label === 'sha256:da89830a');
    console.log(`Paid Master Key - Healthy: ${masterKeyNS.healthy}, Cooldown: ${masterKeyNS.cooldownUntil !== null}`);
    if (!masterKeyNS.healthy || masterKeyNS.cooldownUntil !== null) {
      throw new Error('Key was mistakenly penalized under Option A for a non-stream agent failure!');
    }
    console.log('✅ Verified: Key remains healthy and is NOT penalized (Option A verified for non-streaming).');

    console.log('\n--- 🧪 TEST 8: Responses API Streaming Call & SSE Block Parser ---');
    const respStream = await fetch('http://127.0.0.1:3001/v1/responses', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer test-proxy-token'
      },
      body: JSON.stringify({
        model: 'gpt-4o',
        stream: true
      })
    });
    console.log(`Status code: ${respStream.status} (Expected: 200)`);
    if (respStream.status !== 200) throw new Error('Responses stream request failed');
    
    const respReader = respStream.body?.getReader();
    const respDecoder = new TextDecoder();
    let respStreamText = '';
    while (true) {
      const { done, value } = await respReader!.read();
      if (done) break;
      respStreamText += respDecoder.decode(value, { stream: true });
    }
    console.log(`Stream complete. Output includes response.completed: ${respStreamText.includes('response.completed')}`);
    if (!respStreamText.includes('response.completed')) throw new Error('Responses stream did not contain completed event data');

    console.log('\n--- 🧪 TEST 8a: Responses API Failed Streaming Call & Observable Status ---');
    const respFailStream = await fetch('http://127.0.0.1:3001/v1/responses', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer test-proxy-token'
      },
      body: JSON.stringify({
        model: 'responses-fail-stream',
        stream: true
      })
    });
    console.log(`Status code: ${respFailStream.status} (Expected: 200)`);
    if (respFailStream.status !== 200) throw new Error('Responses fail stream request failed to establish initial connection');
    
    const respFailReader = respFailStream.body?.getReader();
    const respFailDecoder = new TextDecoder();
    let respFailStreamText = '';
    while (true) {
      const { done, value } = await respFailReader!.read();
      if (done) break;
      respFailStreamText += respFailDecoder.decode(value, { stream: true });
    }
    console.log(`Stream complete. Output includes response.failed: ${respFailStreamText.includes('response.failed')}`);
    if (!respFailStreamText.includes('response.failed')) throw new Error('Responses fail stream did not contain failed event data');

    // Wait a tiny bit for DB update
    await sleep(200);

    // Verify key status in Dashboard API (should NOT be disabled or cooled down under Option A)
    const adminCheckRespFail = await fetch('http://127.0.0.1:3001/api/status', {
      headers: { 'Authorization': `Basic ${basicAuth}` }
    });
    const checkDataFail = await adminCheckRespFail.json() as any;
    const masterKey = checkDataFail.upstreamKeys.find((k: any) => k.label === 'sha256:da89830a');
    console.log(`Paid Master Key - Healthy: ${masterKey.healthy}, Cooldown: ${masterKey.cooldownUntil !== null}, Disabled: ${masterKey.isDisabled}`);
    if (!masterKey.healthy || masterKey.isDisabled || masterKey.cooldownUntil !== null) {
      throw new Error('Key was mistakenly penalized under Option A for an agent stream failure!');
    }
    console.log('✅ Verified: Key remains healthy and is NOT penalized (Option A verified).');

    console.log('\n--- 🧪 TEST 9: Responses API Ambiguous Parameter Validation ---');
    const badParamResp = await fetch('http://127.0.0.1:3001/v1/responses', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer test-proxy-token'
      },
      body: JSON.stringify({
        max_tokens: 100,
        max_output_tokens: 100
      })
    });
    console.log(`Ambiguity check status code: ${badParamResp.status} (Expected: 400)`);
    if (badParamResp.status !== 400) throw new Error('Proxy did not reject ambiguous parameters with 400!');
    const badParamJson = await badParamResp.json() as any;
    console.log(`Response error message: ${badParamJson.error?.message}`);

    console.log('\n--- 🧪 TEST 10: Responses API SQLite Accounting & Cached Tokens Verification ---');
    // Fetch status check to see if SQLite has recorded the correct statistics
    const adminCheckResp2 = await fetch('http://127.0.0.1:3001/api/status', {
      headers: { 'Authorization': `Basic ${basicAuth}` }
    });
    const statusData = await adminCheckResp2.json() as any;
    console.log(`SQLite usageEstimate:`, JSON.stringify(statusData.usageEstimate));
    
    // We expect:
    // Responses API non-streaming (success): 4 cached tokens
    // Responses API non-streaming (failed): 1 cached token
    // Responses API streaming (success): 4 cached tokens
    // Responses API streaming (failed): 2 cached tokens
    // Total cached tokens in SQLite: 11 cached tokens!
    if (statusData.usageEstimate.cachedTokens === undefined) {
      throw new Error('SQLite status did not aggregate cached tokens!');
    }
    console.log(`SQLite total cached tokens: ${statusData.usageEstimate.cachedTokens} (Expected: 11)`);
    if (statusData.usageEstimate.cachedTokens !== 11) {
      throw new Error(`Cached tokens mismatch in database! Expected 11, got ${statusData.usageEstimate.cachedTokens}`);
    }
    console.log(`✅ SQLite usage accounting and cached tokens verified successfully!`);

    // Verify semantic failures were persisted with observable non-200 status codes in request_log.
    const db = new Database(dbPath, { readonly: true });
    const loggedFailedNonStream = db.prepare(`
      SELECT status_code
      FROM request_log
      WHERE model = ?
      ORDER BY id DESC
      LIMIT 1
    `).get('responses-fail-nonstream') as { status_code: number } | undefined;
    const loggedFailedStream = db.prepare(`
      SELECT status_code
      FROM request_log
      WHERE model = ?
      ORDER BY id DESC
      LIMIT 1
    `).get('responses-fail-stream') as { status_code: number } | undefined;
    db.close();

    console.log(`Logged non-stream semantic failure status: ${loggedFailedNonStream?.status_code} (Expected: 500)`);
    if (loggedFailedNonStream?.status_code !== 500) {
      throw new Error(`Expected request_log status_code 500 for responses-fail-nonstream, got ${loggedFailedNonStream?.status_code}`);
    }

    console.log(`Logged stream semantic failure status: ${loggedFailedStream?.status_code} (Expected: 500)`);
    if (loggedFailedStream?.status_code !== 500) {
      throw new Error(`Expected request_log status_code 500 for responses-fail-stream, got ${loggedFailedStream?.status_code}`);
    }
    console.log('✅ Verified semantic failure status codes were persisted correctly in request_log.');

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
