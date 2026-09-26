// Server-sent "something changed" pings per workspace; the dashboard refetches on each.
const clients = new Map(); // workspaceId → Set<res>

export function subscribe(workspaceId, res) {
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
  res.write('retry: 3000\n\n');
  if (!clients.has(workspaceId)) clients.set(workspaceId, new Set());
  clients.get(workspaceId).add(res);
  const keepAlive = setInterval(() => res.write(': ping\n\n'), 25_000);
  res.on('close', () => {
    clearInterval(keepAlive);
    clients.get(workspaceId)?.delete(res);
  });
}

export function publish(workspaceId) {
  for (const res of clients.get(workspaceId) ?? []) res.write(`data: ${Date.now()}\n\n`);
}
