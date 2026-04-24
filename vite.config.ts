iimport { jsxLocPlugin } from "@builder.io/vite-plugin-jsx-loc";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import fs from "node:fs";
import path from "node:path";
import { defineConfig, type Plugin, type ViteDevServer } from "vite";
import { vitePluginManusRuntime } from "vite-plugin-manus-runtime";

// =============================================================================
// Manus Debug Collector - Vite Plugin
// Coleta logs do navegador e os escreve em arquivos, com limite de tamanho
// =============================================================================

const PROJECT_ROOT = import.meta.dirname;
const LOG_DIR = path.join(PROJECT_ROOT, ".manus-logs");
const MAX_LOG_SIZE_BYTES = 1 * 1024 * 1024; // 1MB por arquivo
const TRIM_TARGET_BYTES = Math.floor(MAX_LOG_SIZE_BYTES * 0.6); // 60% após trim

type LogSource = "browserConsole" | "networkRequests" | "sessionReplay";

// Garante que o diretório de logs existe
async function ensureLogDir() {
  try {
    await fs.promises.mkdir(LOG_DIR, { recursive: true });
  } catch {
    // ignora erros de criação
  }
}

// Corta o arquivo mantendo apenas as linhas mais recentes
async function trimLogFile(logPath: string, maxSize: number) {
  try {
    const stats = await fs.promises.stat(logPath).catch(() => null);
    if (!stats || stats.size <= maxSize) return;

    const content = await fs.promises.readFile(logPath, "utf-8");
    const lines = content.split("\n");
    const keptLines: string[] = [];
    let keptBytes = 0;

    // Mantém as linhas mais recentes até atingir o tamanho alvo
    for (let i = lines.length - 1; i >= 0; i--) {
      const lineBytes = Buffer.byteLength(`${lines[i]}\n`, "utf-8");
      if (keptBytes + lineBytes > TRIM_TARGET_BYTES) break;
      keptLines.unshift(lines[i]);
      keptBytes += lineBytes;
    }

    await fs.promises.writeFile(logPath, keptLines.join("\n"), "utf-8");
  } catch {
    // ignora erros de trim
  }
}

// Escreve entradas no arquivo de log correspondente
async function writeToLogFile(source: LogSource, entries: unknown[]) {
  if (entries.length === 0) return;

  await ensureLogDir();
  const logPath = path.join(LOG_DIR, `${source}.log`);

  const lines = entries.map((entry) => {
    const ts = new Date().toISOString();
    return `[${ts}] ${JSON.stringify(entry)}`;
  });

  await fs.promises.appendFile(logPath, `${lines.join("\n")}\n`, "utf-8");
  await trimLogFile(logPath, MAX_LOG_SIZE_BYTES);
}

// Código cliente que será injetado na página (coleta logs e envia via POST)
const CLIENT_SCRIPT = `
(function() {
  if (window.__MANUS_DEBUG_COLLECTOR__) return;
  window.__MANUS_DEBUG_COLLECTOR__ = true;

  const ENDPOINT = '/__manus__/logs';
  const FLUSH_INTERVAL = 2000;
  let queue = { consoleLogs: [], networkRequests: [], sessionEvents: [] };
  let timer = null;

  function flush() {
    if (timer) clearTimeout(timer);
    timer = null;
    const payload = {};
    let hasData = false;
    for (const key in queue) {
      if (queue[key].length) {
        payload[key] = queue[key];
        queue[key] = [];
        hasData = true;
      }
    }
    if (!hasData) return;
    fetch(ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      keepalive: true
    }).catch(() => {});
  }

  function scheduleFlush() {
    if (timer) return;
    timer = setTimeout(flush, FLUSH_INTERVAL);
  }

  // Captura console
  const originalConsole = { ...console };
  ['log', 'info', 'warn', 'error', 'debug'].forEach(level => {
    console[level] = function(...args) {
      originalConsole[level].apply(console, args);
      try {
        queue.consoleLogs.push({ level, args: args.map(a => {
          try { return JSON.stringify(a); } catch { return String(a); }
        }) });
        scheduleFlush();
      } catch (e) {}
    };
  });

  // Captura erros não tratados
  window.addEventListener('error', (event) => {
    queue.consoleLogs.push({ level: 'error', args: [event.message, event.filename, event.lineno, event.colno] });
    scheduleFlush();
  });
  window.addEventListener('unhandledrejection', (event) => {
    queue.consoleLogs.push({ level: 'unhandledrejection', args: [String(event.reason)] });
    scheduleFlush();
  });

  // Captura requisições fetch
  const originalFetch = window.fetch;
  window.fetch = function(...args) {
    const startTime = Date.now();
    return originalFetch.apply(this, args).then(response => {
      const duration = Date.now() - startTime;
      queue.networkRequests.push({ url: args[0], method: args[1]?.method || 'GET', status: response.status, duration });
      scheduleFlush();
      return response;
    }).catch(error => {
      queue.networkRequests.push({ url: args[0], method: args[1]?.method || 'GET', error: error.message });
      scheduleFlush();
      throw error;
    });
  };

  // Captura XMLHttpRequest
  const XHR = XMLHttpRequest.prototype;
  const originalOpen = XHR.open;
  const originalSend = XHR.send;
  XHR.open = function(method, url) {
    this._manusUrl = url;
    this._manusMethod = method;
    return originalOpen.apply(this, arguments);
  };
  XHR.send = function() {
    const startTime = Date.now();
    this.addEventListener('loadend', () => {
      const duration = Date.now() - startTime;
      queue.networkRequests.push({ url: this._manusUrl, method: this._manusMethod, status: this.status, duration });
      scheduleFlush();
    });
    this.addEventListener('error', () => {
      queue.networkRequests.push({ url: this._manusUrl, method: this._manusMethod, error: 'XHR failed' });
      scheduleFlush();
    });
    return originalSend.apply(this, arguments);
  };

  // Replay de eventos de usuário (básico)
  function captureEvent(type, target) {
    queue.sessionEvents.push({ type, target: target?.tagName || 'unknown', time: Date.now() });
    scheduleFlush();
  }
  document.addEventListener('click', (e) => captureEvent('click', e.target), true);
  document.addEventListener('input', (e) => captureEvent('input', e.target), true);
  document.addEventListener('keydown', (e) => captureEvent('keydown', e.target), true);

  // flush final antes de sair da página
  window.addEventListener('beforeunload', () => flush());
})();
`;

/**
 * Plugin Vite para coletar logs de debug do navegador.
 * - Injeta script cliente em desenvolvimento.
 * - Endpoint POST /__manus__/logs recebe os logs e escreve em arquivos.
 * - Arquivos: .manus-logs/browserConsole.log, networkRequests.log, sessionReplay.log
 * - Cada arquivo é limitado a 1MB (mantém as entradas mais recentes).
 */
function vitePluginManusDebugCollector(): Plugin {
  const isDev = process.env.NODE_ENV !== "production";

  return {
    name: "manus-debug-collector",
    apply: "serve", // só roda em modo de desenvolvimento

    transformIndexHtml(html) {
      if (!isDev) return html;
      return {
        html,
        tags: [
          {
            tag: "script",
            children: CLIENT_SCRIPT, // injeta o código diretamente, sem requisição extra
            injectTo: "head",
          },
        ],
      };
    },

    configureServer(server: ViteDevServer) {
      if (!isDev) return;

      // Middleware para receber logs via POST
      server.middlewares.use("/__manus__/logs", async (req, res, next) => {
        if (req.method !== "POST") {
          return next();
        }

        let body = "";
        try {
          for await (const chunk of req) {
            body += chunk;
          }
          const payload = JSON.parse(body);

          // Processa cada tipo de log de forma assíncrona, sem bloquear
          const promises = [];
          if (payload.consoleLogs?.length) {
            promises.push(writeToLogFile("browserConsole", payload.consoleLogs));
          }
          if (payload.networkRequests?.length) {
            promises.push(writeToLogFile("networkRequests", payload.networkRequests));
          }
          if (payload.sessionEvents?.length) {
            promises.push(writeToLogFile("sessionReplay", payload.sessionEvents));
          }
          await Promise.all(promises);

          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ success: true }));
        } catch (e) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ success: false, error: String(e) }));
        }
      });
    },
  };
}

const plugins = [
  react(),
  tailwindcss(),
  jsxLocPlugin(),
  vitePluginManusRuntime(),
  vitePluginManusDebugCollector(),
];

export default defineConfig({
  plugins,
  resolve: {
    alias: {
      "@": path.resolve(import.meta.dirname, "client", "src"),
      "@shared": path.resolve(import.meta.dirname, "shared"),
      "@assets": path.resolve(import.meta.dirname, "attached_assets"),
    },
  },
  envDir: path.resolve(import.meta.dirname),
  root: path.resolve(import.meta.dirname, "client"),
  publicDir: path.resolve(import.meta.dirname, "client", "public"),
  build: {
    outDir: path.resolve(import.meta.dirname, "dist/public"),
    emptyOutDir: true,
  },
  server: {
    host: true,
    allowedHosts: [
      ".manuspre.computer",
      ".manus.computer",
      ".manus-asia.computer",
      ".manuscomputer.ai",
      ".manusvm.computer",
      "localhost",
      "127.0.0.1",
    ],
    hmr: {
      protocol: "wss",
      host: "3000-i4y9u0dwxzbg71m8h4102-1e8c81e8.us2.manus.computer",
      port: 443,
    },
    fs: {
      strict: true,
      deny: ["**/..*"],
    },
  },
});