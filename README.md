# LunarCrush Analytics

🚀 Real-time crypto social media analytics platform with sentiment analysis and trend tracking.

## Features

- **Real-time Data Collection**: Automated Twitter/X data collection using MCP browserdocker tools
- **Sentiment Analysis**: AI-powered sentiment analysis for crypto posts
- **Ticker Extraction**: Automatic cryptocurrency ticker detection ($BTC, $ETH, etc.)
- **Live Dashboard**: Real-time analytics dashboard with trends and insights
- **SQLite Database**: Efficient data storage with 262KB+ of real crypto data
- **REST API**: Complete API for accessing analytics data
- **Social Platform Integration**: Direct links to Twitter searches and DexScreener

## Quick Start

```bash
# Install dependencies
npm install

# Build TypeScript
npm run build

# Start server
npm start
```

## API Endpoints

- `GET /api/health` - Server health check
- `GET /api/trends` - Crypto trend data
- `GET /api/tickers` - Ticker rankings and sentiment
- `GET /api/snapshots` - Recent data collection sessions
- `POST /api/snapshots` - Store new snapshot data

## Dashboard

Access the live dashboard at `http://localhost:3001/dashboard`

## Data Collection

Data is collected using the MCP browserdocker snapshotstore tool:

```javascript
// Example data collection from Twitter/X
mcp__browserdocker__snapshotstore({
  extractTickers: true,
  analyzeSentiment: true,
  maxNodes: 1000
})
```

## Database Schema

### Posts Table
- Real-time crypto social media posts
- Sentiment analysis (bullish/bearish/neutral)
- Extracted tickers and metadata
- Content deduplication via hash

### Links Table  
- Direct URLs to original posts
- Enables clickable dashboard links

### Snapshots Table
- Data collection session summaries
- Platform and timing metadata

## Technology Stack

- **Backend**: Node.js + Express + TypeScript
- **Database**: SQLite3 with optimized indexing
- **Frontend**: HTML5 + CSS3 + JavaScript
- **Data Collection**: MCP browserdocker tools
- **Deployment**: Docker-ready, Tailscale compatible

## Configuration

Server runs on port 3001 by default. Database file: `twitter_trends.db`

## License

MIT License - see LICENSE file for details

---

🤖 Generated with [Claude Code](https://claude.ai/code)

Co-Authored-By: Claude <noreply@anthropic.com>