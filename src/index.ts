import express, { Request, Response, NextFunction } from 'express';
import crypto from 'crypto';
import { config } from './config.js';
import { initDb, getApiStatusDetails } from './db.js';
import { forwardChatCompletions, forwardResponses } from './openai.js';
import { selectNextKey } from './router.js';
import { renderDashboard } from './dashboard.js';

const app = express();
app.use(express.json({ limit: '10mb' }));

// Initialize SQLite database
initDb();

// Secure constant-time string comparison to prevent timing attacks
export function timingSafeCompare(a: string, b: string): boolean {
  const aHash = crypto.createHash('sha256').update(a).digest();
  const bHash = crypto.createHash('sha256').update(b).digest();
  return crypto.timingSafeEqual(aHash, bHash);
}

// Client Bearer Token Authentication Middleware
function authenticateClient(req: Request, res: Response, next: NextFunction): void {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    res.status(401).json({
      error: {
        message: 'Missing or malformed Authorization header. Must be "Bearer <PROXY_API_KEY>".',
        type: 'authentication_error',
        code: 'missing_token'
      }
    });
    return;
  }

  const token = authHeader.substring(7);
  if (!timingSafeCompare(token, config.proxyApiKey)) {
    res.status(401).json({
      error: {
        message: 'Invalid proxy API key provided.',
        type: 'authentication_error',
        code: 'invalid_token'
      }
    });
    return;
  }

  next();
}

// Admin HTTP Basic Authentication Middleware
function authenticateAdmin(req: Request, res: Response, next: NextFunction): void {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Basic ')) {
    res.setHeader('WWW-Authenticate', 'Basic realm="Proxy Dashboard"');
    res.status(401).send('Authentication required for administrative access.');
    return;
  }

  const base64Credentials = authHeader.substring(6);
  const credentials = Buffer.from(base64Credentials, 'base64').toString('ascii');
  const [username, password] = credentials.split(':');

  if (
    !timingSafeCompare(username || '', config.adminUsername) ||
    !timingSafeCompare(password || '', config.adminPassword)
  ) {
    res.setHeader('WWW-Authenticate', 'Basic realm="Proxy Dashboard"');
    res.status(401).send('Invalid admin username or password.');
    return;
  }

  next();
}

// ----------------------------------------------------
// Public Endpoints
// ----------------------------------------------------

app.get('/health', (req: Request, res: Response) => {
  res.json({ ok: true });
});

// ----------------------------------------------------
// Client API Endpoints (Bearer Authenticated)
// ----------------------------------------------------

app.post('/v1/chat/completions', authenticateClient, (req: Request, res: Response) => {
  forwardChatCompletions(req, res);
});

app.post('/v1/responses', authenticateClient, (req: Request, res: Response) => {
  forwardResponses(req, res);
});

app.get('/v1/models', authenticateClient, async (req: Request, res: Response) => {
  try {
    const selectedKey = selectNextKey();
    const response = await fetch(`${config.openaiBaseUrl}/models`, {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${selectedKey.key}`
      }
    });

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}));
      return res.status(response.status).json(errorData);
    }

    const data = await response.json();
    res.json(data);
  } catch (error) {
    console.error('Failed to fetch models dynamically from upstream, falling back to emergency static list:', error);
    
    // Emergency Fallback: Only return a single model (gpt-4o) as a diagnostics indicator
    // that upstream keys are exhausted/cooldowned or network is down.
    res.json({
      object: 'list',
      data: [
        {
          id: 'gpt-4o',
          object: 'model',
          created: 1715644800,
          owned_by: 'openai'
        }
      ]
    });
  }
});

// ----------------------------------------------------
// Administrative Dashboard Endpoints (Basic Auth)
// ----------------------------------------------------

app.get('/status', authenticateAdmin, (req: Request, res: Response) => {
  const statusDetails = getApiStatusDetails(config.openaiSharedKeys, config.openaiMasterKey);
  const html = renderDashboard(statusDetails);
  res.setHeader('Content-Type', 'text/html');
  res.send(html);
});

app.get('/api/status', authenticateAdmin, (req: Request, res: Response) => {
  const statusDetails = getApiStatusDetails(config.openaiSharedKeys, config.openaiMasterKey);
  res.json(statusDetails);
});

// Start Server
app.listen(config.port, config.host, () => {
  console.log(`🚀 openai-shared-proxy is running on http://${config.host}:${config.port}`);
  console.log(`🔒 Proxy Bearer Auth enabled. admin Basic Auth enabled on /status.`);
});
