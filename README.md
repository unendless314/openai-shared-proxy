# 🚀 OpenAI Shared Routing Proxy

[![Node.js](https://img.shields.io/badge/Node.js-v18+-green.svg?style=flat-square&logo=node.js)](https://nodejs.org/)
[![TypeScript](https://img.shields.io/badge/TypeScript-v5+-blue.svg?style=flat-square&logo=typescript)](https://www.typescriptlang.org/)
[![Express](https://img.shields.io/badge/Express-v4-lightgrey.svg?style=flat-square)](https://expressjs.com/)
[![SQLite](https://img.shields.io/badge/SQLite-3-orange.svg?style=flat-square&logo=sqlite)](https://www.sqlite.org/)

A lightweight, high-performance, and cost-optimized **OpenAI-compatible proxy** designed for shared, non-private development traffic. It aggregates a pool of free/complementary API keys and automatically falls back to a paid master key when limits are reached, ensuring stable, 24/7 service without interruptions.

---

## 📖 Table of Contents

- [Features](#-features)
- [How It Works (Routing Architecture)](#%EF%B8%8F-how-it-works-routing-architecture)
- [Quick Start](#-quick-start)
  - [Prerequisites](#prerequisites)
  - [Installation](#installation)
  - [Configuration](#configuration)
  - [Running the Server](#running-the-server)
- [Client Integration Guide](#-client-integration-guide)
  - [OpenAI Python SDK](#openai-python-sdk)
  - [OpenAI Node.js SDK](#openai-nodejs-sdk)
  - [cURL Example](#curl-example)
  - [Custom Headers](#custom-headers)
- [Operator Dashboard & Monitoring](#-operator-dashboard--monitoring)
  - [Admin Basic Auth](#admin-basic-auth)
  - [Endpoints](#endpoints)
- [Architecture & Tech Stack](#-architecture--tech-stack)

---

## ✨ Features

- 🔄 **OpenAI Compatibility**: Complete drop-in replacement for OpenAI SDKs using custom `base_url` and a proxy key.
- ⚡ **Two-Tier Smart Routing**:
  - **Tier 1 (Free Pool)**: Round-robin routing across a set of free API keys (`OPENAI_SHARED_KEYS`).
  - **Tier 2 (Paid Fallback)**: Failsafe fallback to a master paid key (`OPENAI_MASTER_KEY`) when free keys are exhausted.
- ⏱️ **Automatic Quota & Cooldown Enforcement**: Voluntary cooldown of free keys for the remainder of the UTC day when they hit 95% of their configured limits to prevent paid spillovers.
- 🌀 **Streaming Supported**: Native support for Server-Sent Events (SSE) streaming (`stream: true`).
- 📊 **Operator Dashboard**: Built-in simple dashboard to view server health, key status, usage estimates, and recent errors.
- 🛡️ **Security First**: Upstream API keys are never exposed to downstream clients. Downstream access is controlled with a stable `PROXY_API_KEY` using constant-time comparison.

---

## ⚙️ How It Works (Routing Architecture)

```mermaid
flowchart TD
    Client[Client Request] --> Auth{Valid Proxy Bearer Token?}
    Auth -- No --> Err401[401 Unauthorized]
    Auth -- Yes --> Route[Router Selects Next Free Key]
    Route --> LimitCheck{Key Daily Limits Safe?}
    
    LimitCheck -- Yes --> Upstream[Forward to OpenAI API]
    LimitCheck -- No/Cooldowned --> Fallback{Paid Master Key Set?}
    
    Upstream -- Success --> Return[Return Response]
    Upstream -- Failure/RateLimit/401 --> Cooldown[Mark Key Cooldown/Invalid]
    Cooldown --> Retry[Retry Next Key / Fallback]
    
    Fallback -- Yes --> UpstreamMaster[Forward via Master Key]
    Fallback -- No --> Err429[429 Quota Exhausted]
    
    UpstreamMaster -- Success --> Return
    UpstreamMaster -- Failure --> Err502[502 Bad Gateway]
```

---

## 🚀 Quick Start

### Prerequisites
- **Node.js** (v18 or higher)
- **npm** (v9 or higher)

### Installation

Clone the repository and install dependencies:
```bash
git clone <your-repo-url>
cd openai-shared-proxy
npm install
```

### Configuration

Copy `.env.example` to `.env` and fill in the required credentials:
```bash
cp .env.example .env
```

Open `.env` and configure:
```env
# Server Network Settings
HOST=0.0.0.0
PORT=3001

# Downstream Client & Admin Credentials
PROXY_API_KEY=your-secure-client-bearer-token
ADMIN_USERNAME=admin
ADMIN_PASSWORD=your-secure-admin-password

# Upstream OpenAI Configuration
OPENAI_BASE_URL=https://api.openai.com/v1
OPENAI_SHARED_KEYS=sk-shared-1,sk-shared-2,sk-shared-3
OPENAI_MASTER_KEY=sk-paid-master-failsafe-key

# Limit Thresholds (Free key daily caps)
KEY_DAILY_TOKEN_LIMIT=950000
KEY_DAILY_REQ_LIMIT=4800
```

### Running the Server

#### Development Mode (with TSX auto-reload on change)
```bash
npm run dev
```

#### Production Mode
Compile TypeScript first, then start the server:
```bash
npm run build
npm start
```
The server will start by default at `http://localhost:3001`.

---

## 🔌 Client Integration Guide

To connect your clients to the proxy, simply override the **Base URL** and use your configured **Proxy API Key**.

### OpenAI Python SDK

```python
from openai import OpenAI

client = OpenAI(
    base_url="http://localhost:3001/v1",
    api_key="your-secure-client-bearer-token" # PROXY_API_KEY
)

response = client.chat.completions.create(
    model="gpt-4o-mini",
    messages=[{"role": "user", "content": "Hello proxy!"}],
    stream=True # Native streaming is fully supported!
)

for chunk in response:
    if chunk.choices[0].delta.content:
        print(chunk.choices[0].delta.content, end="")
```

### OpenAI Node.js SDK

```javascript
import OpenAI from 'openai';

const openai = new OpenAI({
  baseURL: 'http://localhost:3001/v1',
  apiKey: 'your-secure-client-bearer-token', // PROXY_API_KEY
});

async function main() {
  const completion = await openai.chat.completions.create({
    messages: [{ role: 'user', content: 'Hello proxy!' }],
    model: 'gpt-4o-mini',
  });

  print(completion.choices[0].message.content);
}
main();
```

### cURL Example

```bash
curl http://localhost:3001/v1/chat/completions \
  -H "Authorization: Bearer your-secure-client-bearer-token" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "gpt-4o-mini",
    "messages": [{"role": "user", "content": "Hello proxy!"}]
  }'
```

### Custom Headers
For operational diagnostics, the proxy exposes several custom headers in HTTP responses:
- `X-Proxy-Upstream-Key-Type`: Returns `free` (used standard pooled key) or `master` (used failsafe fallback key).
- `X-Proxy-Upstream-Model`: The model used by the upstream service.
- `X-Proxy-Retry-Count`: Number of transparent retries attempted by the proxy before achieving a successful connection.

---

## 📊 Operator Dashboard & Monitoring

### Admin Basic Auth
Administrative and health dashboards require HTTP Basic Authentication using the `ADMIN_USERNAME` and `ADMIN_PASSWORD` defined in your `.env` file.

### Endpoints
* **`GET /health`**
  - Public liveness and readiness check. Returns `{"ok": true}`.
* **`GET /status`**
  - A premium, clean operator dashboard viewable in the browser. Shows live server health, upstream key list, daily limit usage percentage, and recent failure logs.
* **`GET /api/status`**
  - Authenticated JSON endpoint returning detailed key metrics, current active quotas, and estimated accumulated usage.

---

## 🛠️ Architecture & Tech Stack

- **Runtime**: Node.js & TypeScript
- **Web Server**: Express
- **State Store**: SQLite (`proxy.db` via `better-sqlite3`) for robust local metrics, daily token calculations, and liveness states.
- **Key Auto-Prune**: Request logs older than 30 days are automatically pruned to keep the database footprint extremely small (<50 MB RSS Target).
