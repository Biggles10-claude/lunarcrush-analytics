#!/usr/bin/env node
import express from 'express';
import path from 'path';
import cors from 'cors';
import sqlite3 from 'sqlite3';
import crypto from 'crypto';
const { Database } = sqlite3;
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

interface PostData {
  id?: number;
  sessionId: string;
  timestamp: string;
  url: string;
  title: string;
  nodeId: string;
  role: string;
  text: string;
  sentiment: string;
  tickers: string;
  depth: number;
  backendDOMNodeId: number;
}

interface LinkData {
  id?: number;
  sessionId: string;
  timestamp: string;
  nodeId: string;
  text: string;
  url: string;
  role: string;
}

interface SnapshotSummary {
  id?: number;
  sessionId: string;
  timestamp: string;
  url: string;
  title: string;
  totalPosts: number;
  totalLinks: number;
  totalTickers: number;
  platform: string;
}

class TwitterTrendsServer {
  private app: express.Application;
  private db: any;
  private port: number;

  private static readonly ALLOWED_HOSTS = new Set(['x.com', 'twitter.com']);
  private static readonly ERROR_TEXT_PATTERNS = [
    /this site can[''']?t be reached/i,
    /refused to connect/i,
    /checking the connection/i,
    /dns.*address.*not found/i
  ];

  private static readonly TIME_TOKEN_RE = new RegExp(
    String.raw`(?:(?:\b(?:an?|one)\b|\b\d+)\s*)(?:s|sec|secs|second|seconds|m|min|mins|minute|minutes|h|hr|hrs|hour|hours|d|day|days|w|wk|wks|week|weeks|mo|mos|month|months|y|yr|yrs|year|years)\b(?:\s+ago)?|\bjust now\b`,
    'i'
  );

  constructor(port: number = 3000) {
    this.app = express();
    this.port = port;
    this.db = new Database('./twitter_trends.db');
    this.initializeDatabase();
    this.setupMiddleware();
    this.setupRoutes();
  }

  private initializeDatabase(): void {
    // Create tables for storing snapshot data
    this.db.serialize(() => {
      // Posts table
      this.db.run(`
        CREATE TABLE IF NOT EXISTS posts (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          sessionId TEXT NOT NULL,
          timestamp TEXT NOT NULL,
          url TEXT NOT NULL,
          title TEXT NOT NULL,
          nodeId TEXT NOT NULL,
          role TEXT NOT NULL,
          text TEXT NOT NULL,
          sentiment TEXT NOT NULL,
          tickers TEXT DEFAULT '[]',
          depth INTEGER DEFAULT 0,
          backendDOMNodeId INTEGER DEFAULT 0,
          content_hash TEXT UNIQUE,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )
      `);

      // Links table
      this.db.run(`
        CREATE TABLE IF NOT EXISTS links (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          sessionId TEXT NOT NULL,
          timestamp TEXT NOT NULL,
          nodeId TEXT NOT NULL,
          text TEXT NOT NULL,
          url TEXT NOT NULL,
          role TEXT NOT NULL,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )
      `);

      // Snapshots summary table
      this.db.run(`
        CREATE TABLE IF NOT EXISTS snapshots (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          sessionId TEXT NOT NULL UNIQUE,
          timestamp TEXT NOT NULL,
          url TEXT NOT NULL,
          title TEXT NOT NULL,
          totalPosts INTEGER DEFAULT 0,
          totalLinks INTEGER DEFAULT 0,
          totalTickers INTEGER DEFAULT 0,
          platform TEXT NOT NULL,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )
      `);

      // Create indexes for better performance
      this.db.run(`CREATE INDEX IF NOT EXISTS idx_posts_timestamp ON posts(timestamp)`);
      this.db.run(`CREATE INDEX IF NOT EXISTS idx_posts_session ON posts(sessionId)`);
      this.db.run(`CREATE INDEX IF NOT EXISTS idx_links_timestamp ON links(timestamp)`);
      this.db.run(`CREATE INDEX IF NOT EXISTS idx_snapshots_timestamp ON snapshots(timestamp)`);
      this.db.run(`CREATE UNIQUE INDEX IF NOT EXISTS idx_posts_content_hash ON posts(content_hash)`);
    });

    console.log('✅ Database initialized successfully');
  }

  private setupMiddleware(): void {
    this.app.use(cors());
    this.app.use(express.json({ limit: '10mb' }));
    this.app.use(express.static('./public'));
  }

  private setupRoutes(): void {
    // API Routes
    this.app.get('/api/health', (req, res) => {
      res.json({ status: 'healthy', timestamp: new Date().toISOString() });
    });

    // Store snapshot data (called by SnapshotStoreTool)
    this.app.post('/api/snapshots', (req, res) => {
      const { sessionId, timestamp, url, title, extractedData } = req.body;
      
      try {
        this.storeSnapshotData({
          sessionId,
          timestamp,
          url,
          title,
          posts: extractedData.posts || [],
          links: extractedData.links || [],
          platform: extractedData.summary?.socialPlatform || 'unknown'
        });

        res.json({ success: true, message: 'Snapshot data stored successfully' });
      } catch (error) {
        console.error('Error storing snapshot:', error);
        res.status(500).json({ success: false, error: error instanceof Error ? error.message : String(error) });
      }
    });

    // Get trend data for dashboard
    this.app.get('/api/trends', (req, res) => {
      const { days = 7, limit = 100 } = req.query;

      this.getTrendData(Number(days), Math.min(Number(limit), 1000), (data) => {
        res.json(data);
      });
    });

    // Get recent snapshots
    this.app.get('/api/snapshots', (req, res) => {
      const { limit = 50 } = req.query;
      
      this.db.all(`
        SELECT * FROM snapshots 
        ORDER BY timestamp DESC 
        LIMIT ?
      `, [Number(limit)], (err: any, rows: any) => {
        if (err) {
          res.status(500).json({ error: err.message });
        } else {
          res.json(rows);
        }
      });
    });

    // Get ticker popularity and rankings with project links
    this.app.get('/api/tickers', (req, res) => {
      const { days = 7 } = req.query;
      const since = new Date();
      since.setDate(since.getDate() - Number(days));

      this.db.all(`
        SELECT
          json_extract(tickers, '$') as ticker_json,
          sentiment,
          timestamp
        FROM posts
        WHERE timestamp >= ?
          AND tickers != '[]'
          AND role = 'article'
          AND (url LIKE 'https://x.com/%' OR url LIKE 'https://twitter.com/%')
        ORDER BY timestamp DESC
      `, [since.toISOString()], (err: any, rows: any) => {
        if (err) {
          res.status(500).json({ error: err.message });
          return;
        }

        // Process ticker data
        const tickerStats = new Map();

        rows.forEach((row: any) => {
          try {
            const tickers = JSON.parse(row.ticker_json || '[]');
            tickers.forEach((ticker: string) => {
              const cleanTicker = ticker.replace('$', '').toUpperCase();
              if (!tickerStats.has(cleanTicker)) {
                tickerStats.set(cleanTicker, {
                  ticker: `$${cleanTicker}`,
                  symbol: cleanTicker,
                  totalMentions: 0,
                  bullishCount: 0,
                  bearishCount: 0,
                  neutralCount: 0,
                  lastMention: row.timestamp,
                  twitterUrl: `https://twitter.com/search?q=%24${cleanTicker}&src=typed_query&f=live`,
                  dexscreenerUrl: this.getDexScreenerUrl(cleanTicker)
                });
              }

              const stats = tickerStats.get(cleanTicker);
              stats.totalMentions++;

              if (row.sentiment === 'bullish') stats.bullishCount++;
              else if (row.sentiment === 'bearish') stats.bearishCount++;
              else stats.neutralCount++;

              // Update last mention if more recent
              if (new Date(row.timestamp) > new Date(stats.lastMention)) {
                stats.lastMention = row.timestamp;
              }
            });
          } catch (e) {
            // Skip invalid JSON
          }
        });

        // Convert to array and sort by popularity
        const tickerRankings = Array.from(tickerStats.values())
          .sort((a, b) => b.totalMentions - a.totalMentions)
          .map((ticker, index) => ({
            ...ticker,
            rank: index + 1,
            sentimentScore: (ticker.bullishCount - ticker.bearishCount) / ticker.totalMentions || 0,
            sentimentLabel: this.getSentimentLabel(ticker.bullishCount, ticker.bearishCount, ticker.neutralCount)
          }));

        res.json({
          tickers: tickerRankings,
          totalTickers: tickerRankings.length,
          timeRange: `${days} days`,
          updated: new Date().toISOString()
        });
      });
    });

    // Dashboard route
    this.app.get('/', (req, res) => {
      res.sendFile(path.join(__dirname, 'public', 'dashboard.html'));
    });

    // Dashboard route
    this.app.get('/dashboard', (req, res) => {
      res.sendFile(path.join(__dirname, 'public', 'dashboard.html'));
    });
  }

  private isAllowedUrl(raw: string): boolean {
    try {
      const u = new URL(raw);
      return TwitterTrendsServer.ALLOWED_HOSTS.has(u.hostname.toLowerCase());
    }
    catch {
      return false;
    }
  }

  private isValidPost(post: any, url: string, platform: string): boolean {
    if (platform?.toLowerCase() !== 'twitter') return false;
    if (!this.isAllowedUrl(url)) return false;
    if (post?.role !== 'article') return false;
    const t = (post?.text || '').trim();
    if (!t) return false;
    if (TwitterTrendsServer.ERROR_TEXT_PATTERNS.some(rx => rx.test(t))) return false;
    return true;
  }

  private hashPost(sessionId: string, url: string, nodeId: string, text: string): string {
    return crypto.createHash('sha256')
      .update([sessionId, url, nodeId, text.trim()].join('|'))
      .digest('hex');
  }

  private stripRelativeTime(text: string): string {
    if (!text) return text;

    const token = TwitterTrendsServer.TIME_TOKEN_RE.source;
    const sep = String.raw`[ \t\u00B7|,;:\u2013\u2014-]+`; // separators
    const bracket = String.raw`[()\[\]]?`;

    // Remove lines that are just a time token (optionally wrapped)
    const timeOnlyLine = new RegExp(
      `^\\s*(?:${bracket})\\s*(?:${token})\\s*(?:${bracket})\\s*$`,
      'i'
    );

    let result = text.split(/\r?\n/).filter(l => !timeOnlyLine.test(l)).join('\n');

    // Remove tokens at start/end with optional wrappers and separators
    const edge = new RegExp(
      `^(?:${sep})?(?:${bracket})\\s*(?:${token})\\s*(?:${bracket})(?:${sep})?|(?:${sep})?(?:${bracket})\\s*(?:${token})\\s*(?:${bracket})(?:${sep})?$`,
      'i'
    );
    result = result.replace(edge, '');

    // Remove standalone tokens anywhere (surrounded by separators or line boundaries)
    const anywhere = new RegExp(
      `(?:^|${sep})(?:${bracket})\\s*(?:${token})\\s*(?:${bracket})(?=${sep}|$)`,
      'ig'
    );
    result = result.replace(anywhere, ' ');

    return result.replace(/\s{2,}/g, ' ').trim();
  }

  private storeSnapshotData(data: {
    sessionId: string;
    timestamp: string;
    url: string;
    title: string;
    posts: any[];
    links: any[];
    platform: string;
  }): void {
    const { sessionId, timestamp, url, title, posts, links, platform } = data;

    const cleanedPosts = (posts || []).filter(p => this.isValidPost(p, url, platform));

    this.db.serialize(() => {
      // Store summary
      this.db.run(`
        INSERT OR REPLACE INTO snapshots
        (sessionId, timestamp, url, title, totalPosts, totalLinks, totalTickers, platform)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `, [sessionId, timestamp, url, title, cleanedPosts.length, (links || []).length, 0, platform || 'twitter']);

      // Store posts with validation and deduplication
      const postStmt = this.db.prepare(`
        INSERT OR IGNORE INTO posts
        (sessionId, timestamp, url, title, nodeId, role, text, sentiment, tickers, depth, backendDOMNodeId, content_hash)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);

      cleanedPosts.forEach(post => {
        const rawText = (post.text || '').trim();
        const text = this.stripRelativeTime(rawText);
        const sentiment = post.sentiment || 'neutral';
        const tickers = JSON.stringify(post.tickers || []);
        const contentHash = this.hashPost(sessionId, url, post.nodeId, text);

        postStmt.run([
          sessionId,
          timestamp,
          url,
          title,
          post.nodeId,
          post.role,
          text,
          sentiment,
          tickers,
          post.depth || 0,
          post.backendDOMNodeId || 0,
          contentHash
        ]);
      });
      postStmt.finalize();

      // Store links
      const linkStmt = this.db.prepare(`
        INSERT INTO links 
        (sessionId, timestamp, nodeId, text, url, role)
        VALUES (?, ?, ?, ?, ?, ?)
      `);

      links.forEach(link => {
        linkStmt.run([
          sessionId,
          timestamp,
          link.nodeId,
          link.text,
          link.url,
          link.role
        ]);
      });
      linkStmt.finalize();
    });

    console.log(`📊 Stored snapshot ${sessionId}: ${cleanedPosts.length}/${posts.length} posts saved`);
  }

  private getDexScreenerUrl(ticker: string): string {
    return `https://dexscreener.com/search?q=${ticker}`;
  }

  private getSentimentLabel(bullish: number, bearish: number, neutral: number): string {
    const total = bullish + bearish + neutral;
    if (total === 0) return 'Unknown';

    const bullishPercent = (bullish / total) * 100;
    const bearishPercent = (bearish / total) * 100;

    if (bullishPercent > 60) return 'Very Bullish';
    if (bullishPercent > 40) return 'Bullish';
    if (bearishPercent > 60) return 'Very Bearish';
    if (bearishPercent > 40) return 'Bearish';
    return 'Neutral';
  }

  private getTrendData(days: number, limit: number, callback: (data: any) => void): void {
    const since = new Date();
    since.setDate(since.getDate() - days);
    const sinceISO = since.toISOString();

    this.db.serialize(() => {
      // Get post trends over time
      this.db.all(`
        SELECT 
          DATE(timestamp) as date,
          COUNT(*) as post_count,
          COUNT(DISTINCT sessionId) as session_count
        FROM posts 
        WHERE timestamp >= ?
        GROUP BY DATE(timestamp)
        ORDER BY date
      `, [sinceISO], (err: any, postTrends: any) => {
        if (err) {
          callback({ error: err.message });
          return;
        }

        // Get sentiment distribution
        this.db.all(`
          SELECT 
            sentiment,
            COUNT(*) as count
          FROM posts 
          WHERE timestamp >= ?
          GROUP BY sentiment
        `, [sinceISO], (err: any, sentimentData: any) => {
          if (err) {
            callback({ error: err.message });
            return;
          }

          // Get recent posts - only valid Twitter posts
          this.db.all(`
            SELECT p.*
            FROM posts p
            WHERE p.timestamp >= ?
              AND p.role = 'article'
              AND p.url LIKE 'https://x.com/%'
              AND p.text NOT LIKE '%This site can%be reached%'
              AND p.text NOT LIKE '%refused to connect%'
              AND p.text NOT LIKE '%Checking the connection%'
            ORDER BY p.timestamp DESC
            LIMIT ?
          `, [sinceISO, limit], (err: any, recentPosts: any) => {
            if (err) {
              callback({ error: err.message });
              return;
            }

            // Sanitize text for existing posts to remove time-related content
            const sanitizedPosts = recentPosts.map((p: any) => ({ ...p, text: this.stripRelativeTime(p.text) }));

            callback({
              postTrends,
              sentimentData,
              recentPosts: sanitizedPosts,
              summary: {
                totalPosts: sanitizedPosts.length,
                timeRange: `${days} days`
              }
            });
          });
        });
      });
    });
  }

  public start(): void {
    this.app.listen(this.port, '0.0.0.0', () => {
      console.log(`🚀 LunarCrush Analytics running on http://0.0.0.0:${this.port}`);
      console.log(`📱 Access via Tailscale: http://[YOUR_TAILSCALE_IP]:${this.port}`);
      console.log(`📊 Dashboard: http://[YOUR_TAILSCALE_IP]:${this.port}/dashboard`);
    });
  }

  public close(): void {
    this.db.close();
  }
}

// Start server if run directly
if (import.meta.url === `file://${process.argv[1]}`) {
  const server = new TwitterTrendsServer(3001);
  server.start();

  // Graceful shutdown
  process.on('SIGINT', () => {
    console.log('\n🛑 Shutting down server...');
    server.close();
    process.exit(0);
  });
}

export { TwitterTrendsServer };