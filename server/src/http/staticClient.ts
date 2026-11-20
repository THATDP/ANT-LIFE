import { createReadStream, existsSync, statSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { extname, relative, resolve, sep } from 'node:path';

const CONTENT_TYPES: Record<string, string> = {
  '.css': 'text/css; charset=utf-8', '.html': 'text/html; charset=utf-8', '.ico': 'image/x-icon',
  '.jpeg': 'image/jpeg', '.jpg': 'image/jpeg', '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.png': 'image/png', '.svg': 'image/svg+xml',
  '.webp': 'image/webp', '.woff': 'font/woff', '.woff2': 'font/woff2',
};

/** Serves the built SPA from a fixed root without allowing path traversal. */
export function serveClientAsset(request: IncomingMessage, response: ServerResponse, url: URL, root: string): boolean {
  let pathname: string;
  try {
    pathname = decodeURIComponent(url.pathname);
  } catch {
    writeJson(response, 400, { error: 'bad_path' });
    return true;
  }

  let filePath = resolve(root, `.${pathname}`);
  const pathFromRoot = relative(root, filePath);
  if (pathFromRoot === '..' || pathFromRoot.startsWith(`..${sep}`)) {
    writeJson(response, 404, { error: 'not_found' });
    return true;
  }

  if (isDirectory(filePath)) filePath = resolve(filePath, 'index.html');
  if (!isFile(filePath)) {
    if (extname(pathname)) {
      writeJson(response, 404, { error: 'not_found' });
      return true;
    }
    filePath = resolve(root, 'index.html');
  }
  if (!isFile(filePath)) {
    writeJson(response, 503, { error: 'client_build_missing' });
    return true;
  }

  const fileInfo = statSync(filePath);
  response.setHeader('Content-Type', CONTENT_TYPES[extname(filePath).toLowerCase()] ?? 'application/octet-stream');
  response.setHeader('Content-Length', fileInfo.size);
  const immutableAsset = relative(root, filePath).startsWith(`assets${sep}`);
  response.setHeader('Cache-Control', immutableAsset ? 'public, max-age=31536000, immutable' : 'no-store');
  if (request.method === 'HEAD') {
    response.writeHead(200).end();
    return true;
  }

  response.writeHead(200);
  createReadStream(filePath).on('error', (error) => {
    if (!response.headersSent) response.writeHead(500);
    response.destroy(error);
  }).pipe(response);
  return true;
}

function isDirectory(path: string): boolean {
  try { return statSync(path).isDirectory(); }
  catch { return false; }
}

function isFile(path: string): boolean {
  try { return statSync(path).isFile(); }
  catch { return false; }
}

function writeJson(response: ServerResponse, status: number, payload: unknown): void {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  response.end(JSON.stringify(payload));
}
