import express from 'express';
import cors from 'cors';
import { chromium } from 'playwright';
import { randomUUID } from 'crypto';
import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);
const app = express();
app.use(cors());
app.use(express.json({ limit: '1mb' }));

const PORT = process.env.PORT || 8787;
const MAX_URLS = 200;
const JOB_TTL_MS = 10 * 60 * 1000;
const jobs = new Map();

function normalizeUrl(rawUrl) {
  const candidate = rawUrl.startsWith('http://') || rawUrl.startsWith('https://') ? rawUrl : `https://${rawUrl}`;
  return new URL(candidate).toString();
}

function sanitizeFilePart(value) {
  return (value || 'page')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 80) || 'page';
}

function extractLocUrls(xmlText) {
  return [...xmlText.matchAll(/<loc>([\s\S]*?)<\/loc>/gi)]
    .map((match) => match[1].trim())
    .filter(Boolean);
}

async function fetchText(url) {
  const response = await fetch(url, { redirect: 'follow' });
  if (!response.ok) {
    throw new Error(`Failed to fetch ${url}: HTTP ${response.status}`);
  }
  return response.text();
}

async function collectSitemapUrls(startSitemapUrl) {
  const visitedSitemaps = new Set();
  const queue = [startSitemapUrl];
  const pageUrls = [];

  while (queue.length && pageUrls.length < MAX_URLS) {
    const sitemapUrl = queue.shift();
    if (!sitemapUrl || visitedSitemaps.has(sitemapUrl)) continue;
    visitedSitemaps.add(sitemapUrl);

    let xml;
    try {
      xml = await fetchText(sitemapUrl);
    } catch {
      continue;
    }

    const locs = extractLocUrls(xml);
    for (const loc of locs) {
      if (pageUrls.length >= MAX_URLS) break;
      if (loc.endsWith('.xml')) {
        if (!visitedSitemaps.has(loc)) queue.push(loc);
      } else {
        pageUrls.push(loc);
      }
    }
  }

  return [...new Set(pageUrls)];
}

async function createPdf(page, url, viewport) {
  await page.setViewportSize(viewport);
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60_000 });
  await page.waitForLoadState('networkidle', { timeout: 60_000 }).catch(() => {});
  await page.emulateMedia({ media: 'screen' });

  await dismissCookieBanners(page);
  await page.waitForTimeout(300);
  await scrollPageForLazyLoad(page);
  await page.waitForTimeout(200);
  await normalizeForFullPageCapture(page);
  await hideStickyElementsForMobile(page);
  await ensureScrollTop(page);

  const pageTitle = await page.title();
  const measured = await getDocumentSize(page);
  const targetWidth = Math.max(viewport.width, measured.width, 320);

  await page.setViewportSize({ width: targetWidth, height: viewport.height });
  await page.waitForTimeout(150);

  const finalSize = await getDocumentSize(page);
  const targetHeight = Math.max(finalSize.height, viewport.height, 640);

  const png = await page.screenshot({ fullPage: true, type: 'png', captureBeyondViewport: true });
  const pdf = await renderImagePdf(page, png, targetWidth, targetHeight);

  return {
    title: sanitizeFilePart(pageTitle),
    pdf
  };
}

async function scrollPageForLazyLoad(page) {
  await page.evaluate(async () => {
    const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    const viewportHeight = window.innerHeight;
    const root = document.scrollingElement || document.documentElement;

    const candidates = Array.from(document.querySelectorAll('body *')).filter((el) => {
      const style = window.getComputedStyle(el);
      const overflowY = style.overflowY;
      if (!['auto', 'scroll'].includes(overflowY)) return false;
      if (el.scrollHeight <= el.clientHeight + 100) return false;
      const rect = el.getBoundingClientRect();
      return rect.height >= viewportHeight * 0.6 && rect.width >= window.innerWidth * 0.6;
    });

    candidates.sort((a, b) => b.scrollHeight - a.scrollHeight);
    const main = candidates[0] || root;

    const getScrollHeight = (el) => {
      if (el === root) {
        return Math.max(
          document.body.scrollHeight,
          document.documentElement.scrollHeight,
          document.body.offsetHeight,
          document.documentElement.offsetHeight
        );
      }
      return el.scrollHeight;
    };

    const scrollTo = (pos) => {
      if (main === root) {
        window.scrollTo(0, pos);
      } else {
        main.scrollTop = pos;
      }
    };

    const maxTries = 50;
    let lastHeight = 0;

    for (let i = 0; i < maxTries; i += 1) {
      scrollTo(getScrollHeight(main));
      await delay(300);
      const height = getScrollHeight(main);
      if (height === lastHeight) break;
      lastHeight = height;
    }

    scrollTo(0);
    if (main !== root) {
      window.scrollTo(0, 0);
    }
  });
}

async function normalizeForFullPageCapture(page) {
  await page.evaluate(() => {
    const html = document.documentElement;
    const body = document.body;
    const viewportHeight = window.innerHeight;

    html.style.height = 'auto';
    html.style.overflow = 'visible';
    body.style.height = 'auto';
    body.style.overflow = 'visible';

    const candidates = Array.from(document.querySelectorAll('body *')).filter((el) => {
      const style = window.getComputedStyle(el);
      const overflowY = style.overflowY;
      if (!['auto', 'scroll'].includes(overflowY)) return false;
      if (el.scrollHeight <= el.clientHeight + 100) return false;
      const rect = el.getBoundingClientRect();
      return rect.height >= viewportHeight * 0.6 && rect.width >= window.innerWidth * 0.6;
    });

    candidates.sort((a, b) => b.scrollHeight - a.scrollHeight);
    const main = candidates[0];
    if (main) {
      main.style.overflow = 'visible';
      main.style.height = 'auto';
      main.style.maxHeight = 'none';
    }
  });
}

async function ensureScrollTop(page) {
  await page.evaluate(() => {
    const root = document.scrollingElement || document.documentElement;
    root.scrollTop = 0;
    window.scrollTo(0, 0);
  });
}

async function hideStickyElementsForMobile(page) {
  const viewport = page.viewportSize();
  if (!viewport || viewport.width >= 600) return;

  await page.evaluate(() => {
    const viewportHeight = window.innerHeight || 0;
    const viewportWidth = window.innerWidth || 0;
    const candidates = Array.from(document.querySelectorAll('body *'));

    candidates.forEach((el) => {
      const style = window.getComputedStyle(el);
      if (!['fixed', 'sticky'].includes(style.position)) return;
      const rect = el.getBoundingClientRect();
      const area = rect.width * rect.height;
      const viewportArea = viewportWidth * viewportHeight;
      const isFullWidth = rect.width >= viewportWidth * 0.85;
      const isBottom = rect.bottom >= viewportHeight - 4;
      const isTop = rect.top <= 4;
      const isLarge = viewportArea > 0 ? area / viewportArea > 0.05 : false;

      if ((isBottom || isTop) && isFullWidth && isLarge) {
        el.style.setProperty('display', 'none', 'important');
        el.setAttribute('data-capture-hidden', 'true');
      }
    });
  });
}

async function renderImagePdf(page, pngBuffer, width, height) {
  const imagePage = await page.context().newPage();
  const dataUrl = `data:image/png;base64,${pngBuffer.toString('base64')}`;
  const html = `<!doctype html>
    <html>
      <head>
        <meta charset="utf-8" />
        <style>
          html, body { margin: 0; padding: 0; background: #fff; }
          img { display: block; width: ${width}px; height: ${height}px; }
        </style>
      </head>
      <body>
        <img src="${dataUrl}" alt="Full page screenshot" />
      </body>
    </html>`;
  await imagePage.setContent(html, { waitUntil: 'load' });

  const pdf = await imagePage.pdf({
    printBackground: true,
    width: `${width}px`,
    height: `${height}px`,
    margin: { top: '0px', right: '0px', bottom: '0px', left: '0px' }
  });
  await imagePage.close();
  return pdf;
}

async function getDocumentSize(page) {
  return page.evaluate(() => {
    const body = document.body;
    const html = document.documentElement;
    const width = Math.max(body?.scrollWidth || 0, html?.scrollWidth || 0, html?.clientWidth || 0);
    const height = Math.max(body?.scrollHeight || 0, html?.scrollHeight || 0, html?.clientHeight || 0);
    return { width, height };
  });
}

async function dismissCookieBanners(page) {
  const acceptPattern = /accept|agree|allow all|allow|ok|got it|continue|yes|i agree/i;
  const rejectPattern = /reject|decline|deny|no thanks|necessary only|essential only/i;

  const clickFirstVisible = async (locator) => {
    const count = await locator.count();
    for (let i = 0; i < count; i += 1) {
      const candidate = locator.nth(i);
      const visible = await candidate.isVisible().catch(() => false);
      if (!visible) continue;
      await candidate.click({ timeout: 1500, force: true }).catch(() => {});
      return true;
    }
    return false;
  };

  const candidates = [
    page.getByRole('button', { name: acceptPattern }),
    page.getByRole('link', { name: acceptPattern }),
    page.locator(`button:has-text("Accept"), button:has-text("I agree"), button:has-text("Allow all")`),
    page.locator(`text=/accept|agree|allow all|allow|ok|got it|continue|yes/i`).locator('..')
  ];

  for (const candidate of candidates) {
    if (await clickFirstVisible(candidate)) break;
  }

  const rejectCandidates = [
    page.getByRole('button', { name: rejectPattern }),
    page.getByRole('link', { name: rejectPattern }),
    page.locator(`button:has-text("Reject"), button:has-text("Decline"), button:has-text("Deny")`)
  ];

  for (const candidate of rejectCandidates) {
    if (await clickFirstVisible(candidate)) break;
  }

  await page.evaluate(() => {
    const selectors = [
      '[id*="cookie"]',
      '[class*="cookie"]',
      '[aria-label*="cookie"]',
      '[data-testid*="cookie"]',
      '[id*="consent"]',
      '[class*="consent"]',
      '[aria-label*="consent"]',
      '[data-consent]',
      '.cookie',
      '.cookies'
    ];
    const viewportArea = window.innerWidth * window.innerHeight;
    selectors.forEach((selector) => {
      document.querySelectorAll(selector).forEach((el) => {
        const style = window.getComputedStyle(el);
        const rect = el.getBoundingClientRect();
        const area = rect.width * rect.height;
        const isOverlay = style.position === 'fixed' || style.position === 'sticky' || Number(style.zIndex || 0) > 1000;
        if (isOverlay || area / viewportArea > 0.15) {
          el.remove();
        }
      });
    });
  });
}

function sendEvent(job, type, payload) {
  const data = `event: ${type}\ndata: ${JSON.stringify(payload)}\n\n`;
  job.clients.forEach((res) => {
    res.write(data);
  });
}

function updateJob(job, updates) {
  job.stage = updates.stage ?? job.stage;
  job.message = updates.message ?? job.message;
  job.completed = updates.completed ?? job.completed;
  job.total = updates.total ?? job.total;
  job.currentUrl = updates.currentUrl ?? job.currentUrl;
  sendEvent(job, 'progress', {
    stage: job.stage,
    message: job.message,
    completed: job.completed,
    total: job.total,
    currentUrl: job.currentUrl
  });
}

async function exportSite(normalizedUrl, onProgress) {
  const sitemapUrl = normalizedUrl.endsWith('.xml') ? normalizedUrl : new URL('/sitemap.xml', normalizedUrl).toString();
  onProgress?.({ stage: 'sitemap', message: `Discovering URLs from ${sitemapUrl}` });

  const discoveredUrls = await collectSitemapUrls(sitemapUrl);
  if (discoveredUrls.length === 0) {
    throw new Error(`No page URLs discovered from sitemap: ${sitemapUrl}`);
  }

  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'site-export-'));
  const desktopDir = path.join(tempRoot, 'Desktop');
  const mobileDir = path.join(tempRoot, 'Mobile');
  await fs.mkdir(desktopDir, { recursive: true });
  await fs.mkdir(mobileDir, { recursive: true });

  onProgress?.({ stage: 'browser', message: 'Launching browser…', total: discoveredUrls.length, completed: 0 });

  let browser;
  try {
    browser = await chromium.launch({ headless: true });
    const context = await browser.newContext();
    const page = await context.newPage();
    const usedNames = new Map();

    let completed = 0;
    for (const pageUrl of discoveredUrls) {
      onProgress?.({ stage: 'capture', message: `Capturing ${pageUrl}`, currentUrl: pageUrl, completed, total: discoveredUrls.length });
      try {
        const desktop = await createPdf(page, pageUrl, { width: 1920, height: 1080 });
        const mobile = await createPdf(page, pageUrl, { width: 390, height: 844 });

        const currentCount = usedNames.get(desktop.title) || 0;
        usedNames.set(desktop.title, currentCount + 1);
        const suffix = currentCount === 0 ? '' : `_${currentCount + 1}`;
        const baseName = `${desktop.title}${suffix}`;

        await fs.writeFile(path.join(desktopDir, `${baseName}_desktop.pdf`), desktop.pdf);
        await fs.writeFile(path.join(mobileDir, `${baseName}_mobile.pdf`), mobile.pdf);
      } catch {
        // skip pages that fail
      } finally {
        completed += 1;
        onProgress?.({
          stage: 'capture',
          message: `Captured ${completed}/${discoveredUrls.length} pages`,
          completed,
          total: discoveredUrls.length,
          currentUrl: pageUrl
        });
      }
    }

    onProgress?.({ stage: 'zip', message: 'Creating export ZIP…', completed, total: discoveredUrls.length });

    const archiveName = `${sanitizeFilePart(new URL(normalizedUrl).hostname)}_exports.zip`;
    const archivePath = path.join(tempRoot, archiveName);
    await execFileAsync('zip', ['-r', archivePath, 'Desktop', 'Mobile'], { cwd: tempRoot });

    return { archiveName, archivePath, tempRoot };
  } finally {
    if (browser) await browser.close();
  }
}

app.get('/api/health', (_req, res) => {
  res.json({ ok: true });
});

app.get('/api/export/stream/:jobId', (req, res) => {
  const { jobId } = req.params;
  const job = jobs.get(jobId);
  if (!job) {
    return res.status(404).json({ error: 'Export job not found.' });
  }

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive'
  });

  res.write('\n');
  job.clients.add(res);

  sendEvent(job, 'progress', {
    stage: job.stage,
    message: job.message,
    completed: job.completed,
    total: job.total,
    currentUrl: job.currentUrl
  });

  req.on('close', () => {
    job.clients.delete(res);
  });
});

app.post('/api/export/start', async (req, res) => {
  const { url } = req.body || {};

  if (!url || typeof url !== 'string') {
    return res.status(400).json({ error: 'A sitemap or website URL is required.' });
  }

  let normalizedUrl;
  try {
    normalizedUrl = normalizeUrl(url);
  } catch {
    return res.status(400).json({ error: 'Invalid URL.' });
  }

  const jobId = randomUUID();
  const job = {
    id: jobId,
    stage: 'queued',
    message: 'Queued for processing…',
    completed: 0,
    total: 0,
    currentUrl: '',
    clients: new Set(),
    archiveName: null,
    archivePath: null,
    tempRoot: null
  };
  jobs.set(jobId, job);

  res.json({ jobId });

  try {
    updateJob(job, { stage: 'starting', message: 'Starting export…' });
    const result = await exportSite(normalizedUrl, (progress) => updateJob(job, progress));
    job.archiveName = result.archiveName;
    job.archivePath = result.archivePath;
    job.tempRoot = result.tempRoot;
    sendEvent(job, 'done', { archiveName: job.archiveName });
  } catch (error) {
    sendEvent(job, 'failed', { error: error.message || 'Export generation failed.' });
  }

  setTimeout(() => {
    if (jobs.has(jobId)) {
      const existing = jobs.get(jobId);
      if (existing?.tempRoot) {
        fs.rm(existing.tempRoot, { recursive: true, force: true }).catch(() => {});
      }
      jobs.delete(jobId);
    }
  }, JOB_TTL_MS);
});

app.get('/api/export/download/:jobId', async (req, res) => {
  const { jobId } = req.params;
  const job = jobs.get(jobId);
  if (!job || !job.archivePath || !job.archiveName) {
    return res.status(404).json({ error: 'Export file not found.' });
  }

  try {
    const zipBuffer = await fs.readFile(job.archivePath);
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename="${job.archiveName}"`);
    res.send(zipBuffer);
    res.on('finish', () => {
      if (job.tempRoot) {
        fs.rm(job.tempRoot, { recursive: true, force: true }).catch(() => {});
      }
      jobs.delete(jobId);
    });
  } catch (error) {
    res.status(500).json({ error: error.message || 'Failed to read export archive.' });
  }
});

app.post('/api/export', async (req, res) => {
  const { url } = req.body || {};

  if (!url || typeof url !== 'string') {
    return res.status(400).json({ error: 'A sitemap or website URL is required.' });
  }

  let normalizedUrl;
  try {
    normalizedUrl = normalizeUrl(url);
  } catch {
    return res.status(400).json({ error: 'Invalid URL.' });
  }

  let result;
  try {
    result = await exportSite(normalizedUrl);
    const zipBuffer = await fs.readFile(result.archivePath);
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename="${result.archiveName}"`);
    return res.send(zipBuffer);
  } catch (error) {
    return res.status(500).json({ error: error.message || 'Export generation failed.' });
  } finally {
    if (result?.tempRoot) {
      await fs.rm(result.tempRoot, { recursive: true, force: true }).catch(() => {});
    }
  }
});

app.listen(PORT, () => {
  console.log(`Server listening on http://localhost:${PORT}`);
});
