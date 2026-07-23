import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { exec } from 'child_process';
import { createCipheriv, createDecipheriv, randomBytes } from 'crypto';
import { dump as dumpYaml, load as loadYaml } from 'js-yaml';
import { compileRuntimePackage } from './runtime-package-compiler.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const runtimeEnv = loadEnv(process.env.NODE_ENV || 'development', process.cwd(), '');

const SESSION_TTL_SECONDS = 60 * 60 * 8;
const SESSION_STORE_VERSION = 1;

function decodeSessionEncryptionKey(value) {
  if (!value) return null;
  const key = Buffer.from(value, 'base64url');
  if (key.length !== 32) {
    throw new Error('UPLINK_SESSION_ENCRYPTION_KEY must be a base64url-encoded 32-byte key.');
  }
  return key;
}

/**
 * Small durable session store for the Vite runtime. The token is encrypted at
 * rest with AES-256-GCM; only the opaque session identifier is sent to clients.
 */
class EncryptedUplinkSessionStore {
  constructor(filePath, encryptionKey) {
    this.filePath = filePath;
    this.encryptionKey = encryptionKey;
    this.sessions = new Map();
    this.load();
    this.removeExpired();
  }

  load() {
    if (!fs.existsSync(this.filePath)) return;
    const envelope = JSON.parse(fs.readFileSync(this.filePath, 'utf8'));
    if (envelope.version !== SESSION_STORE_VERSION || envelope.algorithm !== 'aes-256-gcm') {
      throw new Error('Unsupported encrypted Uplink session store format.');
    }
    const decipher = createDecipheriv('aes-256-gcm', this.encryptionKey, Buffer.from(envelope.iv, 'base64url'));
    decipher.setAuthTag(Buffer.from(envelope.tag, 'base64url'));
    const plaintext = Buffer.concat([
      decipher.update(Buffer.from(envelope.ciphertext, 'base64url')),
      decipher.final(),
    ]).toString('utf8');
    const entries = JSON.parse(plaintext);
    if (!Array.isArray(entries)) throw new Error('Invalid encrypted Uplink session store contents.');
    this.sessions = new Map(entries);
  }

  persist() {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.encryptionKey, iv);
    const ciphertext = Buffer.concat([
      cipher.update(JSON.stringify([...this.sessions.entries()]), 'utf8'),
      cipher.final(),
    ]);
    const envelope = JSON.stringify({
      version: SESSION_STORE_VERSION,
      algorithm: 'aes-256-gcm',
      iv: iv.toString('base64url'),
      tag: cipher.getAuthTag().toString('base64url'),
      ciphertext: ciphertext.toString('base64url'),
    });
    const directory = path.dirname(this.filePath);
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    const temporaryPath = `${this.filePath}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
    fs.writeFileSync(temporaryPath, envelope, { encoding: 'utf8', mode: 0o600 });
    fs.renameSync(temporaryPath, this.filePath);
  }

  get(id) {
    const session = this.sessions.get(id);
    if (!session || session.expiresAt < Date.now()) {
      if (session) {
        this.sessions.delete(id);
        this.persist();
      }
      return null;
    }
    return session;
  }

  set(id, session) {
    this.sessions.set(id, session);
    this.persist();
  }

  delete(id) {
    if (!this.sessions.delete(id)) return;
    this.persist();
  }

  removeExpired() {
    let changed = false;
    for (const [id, session] of this.sessions) {
      if (!session || session.expiresAt < Date.now()) {
        this.sessions.delete(id);
        changed = true;
      }
    }
    if (changed) this.persist();
  }
}

function contractString(value, field, fallback = '') {
  if (value == null && fallback) return fallback;
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${field} must be a non-empty string.`);
  return value.trim();
}

function assertRuntimeContract(contract) {
  const identifier = /^[A-Za-z][A-Za-z0-9]*$/;
  const duplicates = (values) => new Set(values.map((value) => value.toLowerCase())).size !== values.length;
  if (!identifier.test(contract.aggregateType)) throw new Error('aggregateType must be a valid identifier.');
  if (!identifier.test(contract.key)) throw new Error('key must be a valid identifier.');
  const objectNames = contract.objects.map((object) => object.name);
  if (objectNames.some((name) => !identifier.test(name)) || duplicates(objectNames)) throw new Error('Object names must be unique valid identifiers.');
  if (!contract.actions.length) throw new Error('At least one action is required.');
  if (contract.actions.some((action) => !identifier.test(action)) || duplicates(contract.actions)) throw new Error('Action names must be unique valid identifiers.');
  const stateObjects = contract.states.map((state) => state.obj);
  if (duplicates(stateObjects)) throw new Error('Each object can have only one state machine.');
  for (const state of contract.states) {
    if (!objectNames.includes(state.obj)) throw new Error(`State machine "${state.obj}" must reference an existing object.`);
    if (state.flow.length < 2) throw new Error(`State machine "${state.obj}" needs at least two states.`);
    if (state.flow.some((name) => !identifier.test(name)) || duplicates(state.flow)) throw new Error(`States for "${state.obj}" must be unique valid identifiers.`);
  }
}

/** Normalize legacy contracts and reject malformed writes before they reach disk. */
function normalizeContract(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('Business object contract must be an object.');
  const id = contractString(raw.id, 'id').toLowerCase();
  if (!/^[a-z0-9][a-z0-9-_]{0,62}$/.test(id)) throw new Error('id must use 1–63 lowercase letters, numbers, hyphens, or underscores.');
  const name = contractString(raw.name, 'name');
  const aggregateType = contractString(raw.aggregateType, 'aggregateType', name.split(/\s+/)[0]);
  const key = contractString(raw.key, 'key', `${aggregateType.charAt(0).toLowerCase()}${aggregateType.slice(1)}Id`);
  const rawObjects = Array.isArray(raw.objects) ? raw.objects : [];
  const objects = rawObjects.map((item, index) => {
    if (typeof item === 'string') return { name: contractString(item, `objects[${index}]`), fields: 'id' };
    if (!item || typeof item !== 'object') throw new Error(`objects[${index}] must be an object.`);
    return { name: contractString(item.name, `objects[${index}].name`), fields: typeof item.fields === 'string' && item.fields.trim() ? item.fields.trim() : 'id' };
  });
  if (!objects.length) objects.push({ name: aggregateType, fields: 'id' });
  const actions = (Array.isArray(raw.actions) ? raw.actions : []).map((action, index) => contractString(action, `actions[${index}]`));
  const rawStates = Array.isArray(raw.states) ? raw.states : [];
  const states = rawStates.every((state) => typeof state === 'string')
    ? rawStates.length ? [{ obj: objects[0].name, flow: rawStates.map((state, index) => contractString(state, `states[${index}]`)) }] : []
    : rawStates.map((state, index) => {
        if (!state || typeof state !== 'object') throw new Error(`states[${index}] must be an object.`);
        const flow = Array.isArray(state.flow) ? state.flow.map((value, flowIndex) => contractString(value, `states[${index}].flow[${flowIndex}]`)) : [];
        return { obj: contractString(state.obj, `states[${index}].obj`, objects[0].name), flow };
      });
  const status = ['active', 'dormant', 'error'].includes(raw.status) ? raw.status : 'dormant';
  const queries = Number.isFinite(Number(raw.queries)) && Number(raw.queries) >= 0 ? Number(raw.queries) : 0;
  const contract = { id, name, aggregateType, key, size: typeof raw.size === 'string' && raw.size.trim() ? raw.size.trim() : '1.0 MB', queries, status, objects, actions, states };
  assertRuntimeContract(contract);
  return contract;
}

export default defineConfig({
  plugins: [
    react(),
    tailwindcss(),
    {
      name: 'compiler-api-endpoints',
      configureServer(server) {
        const encryptionKey = decodeSessionEncryptionKey(
          process.env.UPLINK_SESSION_ENCRYPTION_KEY || runtimeEnv.UPLINK_SESSION_ENCRYPTION_KEY,
        );
        const sessionStorePath = path.resolve(
          process.cwd(),
          process.env.UPLINK_SESSION_STORE_PATH || runtimeEnv.UPLINK_SESSION_STORE_PATH || '.data/uplink-sessions.enc.json',
        );
        // A key enables restart-safe encrypted storage. Keep the no-key fallback
        // only for local development and fail closed in production.
        if (!encryptionKey && process.env.NODE_ENV === 'production') {
          throw new Error('UPLINK_SESSION_ENCRYPTION_KEY is required when NODE_ENV=production.');
        }
        const uplinkSessions = encryptionKey
          ? new EncryptedUplinkSessionStore(sessionStorePath, encryptionKey)
          : new Map();
        if (!encryptionKey) {
          console.warn('[uplink] UPLINK_SESSION_ENCRYPTION_KEY is not set; sessions are memory-only.');
        }
        const sessionCookieName = 'lacify_uplink_session';
        const readCookies = (req) => Object.fromEntries((req.headers.cookie || '').split(';').filter(Boolean).map(part => {
          const [key, ...value] = part.trim().split('=');
          return [key, decodeURIComponent(value.join('='))];
        }));
        const getSession = (req) => {
          const cookies = readCookies(req);
          const session = uplinkSessions.get(cookies[sessionCookieName]);
          if (!session || session.expiresAt < Date.now()) {
            if (session) uplinkSessions.delete(cookies[sessionCookieName]);
            return null;
          }
          return session;
        };
        const establishUplinkSession = (res, accountName, accountId, apiToken) => {
          const id = randomBytes(32).toString('base64url');
          uplinkSessions.set(id, { accountName, accountId, apiToken, expiresAt: Date.now() + SESSION_TTL_SECONDS * 1000 });
          const secure = process.env.NODE_ENV === 'production' ? '; Secure' : '';
          res.setHeader('Set-Cookie', `${sessionCookieName}=${id}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${SESSION_TTL_SECONDS}; Priority=High${secure}`);
        };
        server.middlewares.use(async (req, res, next) => {
        // The local YAML middleware is retained only for explicit legacy work.
        // Normal development uses the Control API proxy, including Uplink, so
        // one session cookie authorizes every authoring and release request.
        if (process.env.LACIFY_USE_LEGACY_API !== '1') {
          return next();
        }
        const parsedUrl = new URL(req.url, 'http://localhost');
        const url = parsedUrl.pathname;
        console.log('MIDDLEWARE REQUEST:', url, req.method);

        if (url === '/api/verify-uplink' && req.method === 'POST') {
          let body = '';
          req.on('data', chunk => { body += chunk.toString(); });
          req.on('end', async () => {
            try {
              const { accountId, apiToken } = JSON.parse(body);
              if (!accountId || !apiToken) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: false, message: 'Missing Account ID or API Token.' }));
                return;
              }
              if (apiToken === 'sandbox' || apiToken === 'mock') {
                establishUplinkSession(res, 'sandbox', accountId, apiToken);
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: true, message: 'Linked to account: sandbox' }));
                return;
              }
              const response = await fetch('https://api.cloudflare.com/client/v4/user/tokens/verify', {
                headers: { 'Authorization': `Bearer ${apiToken}`, 'Content-Type': 'application/json' }
              });
              const data = await response.json();
              if (!response.ok || !data.success) {
                res.writeHead(401, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: false, message: data.errors?.[0]?.message || 'Invalid API Token.' }));
                return;
              }
              const accRes = await fetch(`https://api.cloudflare.com/client/v4/accounts/${accountId}`, {
                headers: { 'Authorization': `Bearer ${apiToken}`, 'Content-Type': 'application/json' }
              });
              const accData = await accRes.json();
              if (!accRes.ok || !accData.success) {
                res.writeHead(403, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: false, message: 'Could not access Account ID.' }));
                return;
              }
              establishUplinkSession(res, accData.result.name, accountId, apiToken);
              res.writeHead(200, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ success: true, message: `Linked to account: ${accData.result.name}` }));
            } catch (error) {
              res.writeHead(500, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ success: false, message: error.message }));
            }
          });
        } 

        else if (url === '/api/uplink-session' && req.method === 'GET') {
          const session = getSession(req);
          if (!session) {
            res.writeHead(401, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: false, connected: false }));
            return;
          }
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: true, connected: true, accountName: session.accountName, expiresAt: session.expiresAt }));
        }

        else if (url === '/api/uplink-session' && req.method === 'DELETE') {
          const cookies = readCookies(req);
          if (cookies[sessionCookieName]) uplinkSessions.delete(cookies[sessionCookieName]);
          res.setHeader('Set-Cookie', `${sessionCookieName}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0`);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: true }));
        }
        
        else if (url === '/api/create-project' && req.method === 'POST') {
          let body = '';
          req.on('data', chunk => { body += chunk.toString(); });
          req.on('end', () => {
            try {
              const { name, template = 'blank' } = JSON.parse(body);
              const project = String(name || '').trim().toLowerCase();
              if (!/^[a-z0-9][a-z0-9-_]{0,62}$/.test(project)) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: false, message: 'Project ID must use 1–63 lowercase letters, numbers, hyphens, or underscores.' }));
                return;
              }
              const contractsDir = path.join(process.cwd(), 'contracts');
              const projectDir = path.join(contractsDir, project);
              if (fs.existsSync(projectDir)) {
                res.writeHead(409, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: false, message: 'A project with this ID already exists.' }));
                return;
              }
              fs.mkdirSync(projectDir, { recursive: true });
              const starters = {
                commerce: { id: 'orders', name: 'Orders', aggregateType: 'Order', key: 'orderId', size: '1.0 MB', queries: 0, status: 'dormant', objects: [{ name: 'Order', fields: 'id, customerId, total, status' }], actions: ['CreateOrder', 'AddOrderItem', 'CheckoutOrder'], states: [{ obj: 'Order', flow: ['Draft', 'Open', 'Paid'] }] },
                inventory: { id: 'inventory', name: 'Inventory', aggregateType: 'StockItem', key: 'sku', size: '1.0 MB', queries: 0, status: 'dormant', objects: [{ name: 'StockItem', fields: 'id, sku, quantity, reorderPoint' }], actions: ['ReceiveStock', 'AdjustStock', 'ReserveStock'], states: [{ obj: 'StockItem', flow: ['Available', 'Reserved', 'OutOfStock'] }] },
                clinic: { id: 'appointments', name: 'Appointments', aggregateType: 'Appointment', key: 'appointmentId', size: '1.0 MB', queries: 0, status: 'dormant', objects: [{ name: 'Appointment', fields: 'id, patientId, doctorId, dateTime, status' }], actions: ['BookAppointment', 'CheckInPatient', 'CancelAppointment'], states: [{ obj: 'Appointment', flow: ['Scheduled', 'CheckedIn', 'Completed', 'Cancelled'] }] },
                billing: { id: 'invoices', name: 'Invoices', aggregateType: 'Invoice', key: 'invoiceId', size: '1.0 MB', queries: 0, status: 'dormant', objects: [{ name: 'Invoice', fields: 'id, customerId, amount, dueDate, status' }], actions: ['CreateInvoice', 'ApplyPayment', 'VoidInvoice'], states: [{ obj: 'Invoice', flow: ['Draft', 'Issued', 'Paid', 'Void'] }] },
              };
              const starter = starters[template];
              if (starter) fs.writeFileSync(path.join(projectDir, `${starter.id}.yaml`), dumpYaml(normalizeContract(starter), { noRefs: true, lineWidth: -1 }), 'utf-8');
              fs.writeFileSync(path.join(projectDir, '.project.json'), JSON.stringify({ id: project, template, createdAt: new Date().toISOString() }, null, 2));
              res.writeHead(201, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ success: true, project }));
            } catch (error) {
              res.writeHead(500, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ success: false, message: error.message }));
            }
          });
        }

        else if (url === '/api/load-projects' && req.method === 'GET') {
          const contractsDir = path.join(process.cwd(), 'contracts');
          if (!fs.existsSync(contractsDir)) {
            fs.mkdirSync(contractsDir);
          }
          try {
            const items = fs.readdirSync(contractsDir, { withFileTypes: true });
            const projects = items
              .filter(item => item.isDirectory())
              .map(item => item.name);
            
            if (!projects.includes('new-runtime')) {
              projects.push('new-runtime');
              const defaultDir = path.join(contractsDir, 'new-runtime');
              if (!fs.existsSync(defaultDir)) {
                fs.mkdirSync(defaultDir);
              }
            }
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: true, projects }));
          } catch (e) {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: false, message: e.message }));
          }
        }

        else if (url === '/api/load-contracts' && req.method === 'GET') {
          const parsedUrl = new URL(req.url, 'http://localhost');
          const project = parsedUrl.searchParams.get('project') || 'new-runtime';
          const contractsDir = path.join(process.cwd(), 'contracts');
          const projectDir = path.join(contractsDir, project);
          
          if (!fs.existsSync(contractsDir)) {
            fs.mkdirSync(contractsDir);
          }
          if (!fs.existsSync(projectDir)) {
            fs.mkdirSync(projectDir);
          }
          try {
            const files = fs.readdirSync(projectDir).filter(f => f.endsWith('.yaml'));
            const actors = files.map(f => {
              const fileContent = fs.readFileSync(path.join(projectDir, f), 'utf-8');
              return normalizeContract(loadYaml(fileContent));
            });
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: true, actors }));
          } catch (e) {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: false, message: e.message }));
          }
        } 
        
        else if (url === '/api/save-contract' && req.method === 'POST') {
          const parsedUrl = new URL(req.url, 'http://localhost');
          const project = parsedUrl.searchParams.get('project') || 'new-runtime';
          let body = '';
          req.on('data', chunk => { body += chunk.toString(); });
          req.on('end', () => {
            try {
              const actor = normalizeContract(JSON.parse(body));
              const contractsDir = path.join(process.cwd(), 'contracts');
              const projectDir = path.join(contractsDir, project);
              if (!fs.existsSync(contractsDir)) {
                fs.mkdirSync(contractsDir);
              }
              if (!fs.existsSync(projectDir)) {
                fs.mkdirSync(projectDir);
              }
              const yamlContent = dumpYaml(actor, { noRefs: true, lineWidth: -1 });
              fs.writeFileSync(path.join(projectDir, `${actor.id}.yaml`), yamlContent, 'utf-8');
              res.writeHead(200, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ success: true }));
            } catch (e) {
              res.writeHead(500, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ success: false, message: e.message }));
            }
          });
        }

        else if (url === '/api/delete-contract' && req.method === 'DELETE') {
          const parsedUrl = new URL(req.url, 'http://localhost');
          const project = parsedUrl.searchParams.get('project') || 'new-runtime';
          const id = parsedUrl.searchParams.get('id');
          if (!id) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: false, message: 'Missing id param.' }));
            return;
          }
          
          const contractsDir = path.join(process.cwd(), 'contracts');
          const projectDir = path.join(contractsDir, project);
          const filePath = path.join(projectDir, `${id}.yaml`);
          
          try {
            if (fs.existsSync(filePath)) {
              fs.unlinkSync(filePath);
            }
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: true }));
          } catch (e) {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: false, message: e.message }));
          }
        } 
        
        else if (url === '/api/compile-package' && req.method === 'POST') {
          // Local Phase 6 delivery: compile the same durable-object lifecycle
          // runtime that the UI describes, then return it as a portable ZIP.
          // This stays a development-only endpoint; the production Control API
          // stores immutable release artifacts instead of writing to disk.
          let requestBody = '';
          req.on('data', chunk => { requestBody += chunk.toString(); });
          req.on('end', () => {
            const scratchDir = path.join(process.cwd(), 'scratch');
            let tempDir;
            let zipFile;
            try {
              const actors = JSON.parse(requestBody).map(normalizeContract);
              if (!actors.length) throw new Error('Add at least one aggregate before compiling a package.');
              fs.mkdirSync(scratchDir, { recursive: true });
              tempDir = fs.mkdtempSync(path.join(scratchDir, 'lacify-package-'));
              zipFile = path.join(scratchDir, `${path.basename(tempDir)}.zip`);
              for (const [file, content] of Object.entries(compileRuntimePackage(actors))) {
                fs.writeFileSync(path.join(tempDir, file), content, 'utf8');
              }
              exec(`cd "${tempDir}" && zip -q -r "${zipFile}" .`, (zipErr) => {
                if (zipErr) {
                  res.writeHead(500, { 'Content-Type': 'application/json' });
                  res.end(JSON.stringify({ success: false, message: 'Compression failed.' }));
                  return;
                }
                const stat = fs.statSync(zipFile);
                res.writeHead(200, { 'Content-Type': 'application/zip', 'Content-Disposition': 'attachment; filename="lacify-runtime-package.zip"', 'Content-Length': stat.size });
                const readStream = fs.createReadStream(zipFile);
                readStream.pipe(res);
                readStream.on('close', () => {
                  fs.rmSync(tempDir, { recursive: true, force: true });
                  fs.rmSync(zipFile, { force: true });
                });
              });
            } catch (error) {
              if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
              if (zipFile) fs.rmSync(zipFile, { force: true });
              res.writeHead(400, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ success: false, message: error instanceof Error ? error.message : 'Package compilation failed.' }));
            }
          });
          return;

          let body = '';
          req.on('data', chunk => { body += chunk.toString(); });
          req.on('end', async () => {
            const scratchDir = path.join(process.cwd(), 'scratch');
            const tempDir = path.join(scratchDir, 'package-temp');
            const zipFile = path.join(scratchDir, 'compiled-package.zip');

            try {
              if (!fs.existsSync(scratchDir)) fs.mkdirSync(scratchDir);
              if (fs.existsSync(tempDir)) fs.rmSync(tempDir, { recursive: true, force: true });
              if (fs.existsSync(zipFile)) fs.unlinkSync(zipFile);
              fs.mkdirSync(tempDir);

              const actors = JSON.parse(body);

              // 1. wrangler.json configuration with staging and production environments
              const wranglerObj = {
                name: "lacify-runtime-worker",
                main: "index.ts",
                compatibility_date: "2024-05-02",
                durable_objects: {
                  bindings: actors.map(a => ({
                    name: `${a.aggregateType.toUpperCase()}_DO_DEV`,
                    class_name: `${a.aggregateType}DO`
                  }))
                },
                migrations: [
                  {
                    tag: "v1",
                    new_classes: actors.map(a => `${a.aggregateType}DO`)
                  }
                ],
                env: {
                  staging: {
                    name: "lacify-runtime-worker-staging",
                    durable_objects: {
                      bindings: actors.map(a => ({
                        name: `${a.aggregateType.toUpperCase()}_DO_STAGING`,
                        class_name: `${a.aggregateType}DO`
                      }))
                    }
                  },
                  production: {
                    name: "lacify-runtime-worker-prod",
                    durable_objects: {
                      bindings: actors.map(a => ({
                        name: `${a.aggregateType.toUpperCase()}_DO_PROD`,
                        class_name: `${a.aggregateType}DO`
                      }))
                    }
                  }
                }
              };
              fs.writeFileSync(path.join(tempDir, 'wrangler.json'), JSON.stringify(wranglerObj, null, 2), 'utf-8');

              // 2. schema.sql DDL setup
              let schemaSql = `-- Auto-generated SQL DDL for Lacify Business Objects\n\n`;
              actors.forEach(a => {
                a.objects.forEach(obj => {
                  const oName = typeof obj === 'string' ? obj : obj.name;
                  const tableName = oName.toLowerCase() + 's';
                  schemaSql += `CREATE TABLE IF NOT EXISTS ${tableName} (\n`;
                  schemaSql += `  id TEXT PRIMARY KEY,\n`;
                  schemaSql += `  ${a.key} TEXT NOT NULL,\n`;
                  schemaSql += `  status TEXT,\n`;
                  schemaSql += `  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP\n`;
                  schemaSql += `);\n\n`;
                });
              });
              fs.writeFileSync(path.join(tempDir, 'schema.sql'), schemaSql, 'utf-8');

              // 3. index.ts Workers Durable Object routing (resolves bindings for staging & production namespaces dynamically)
              let indexTs = `import { DurableObject } from "cloudflare:workers";\n\n`;
              indexTs += `export interface Env {\n`;
              actors.forEach(a => {
                indexTs += `  ${a.aggregateType.toUpperCase()}_DO_DEV?: DurableObjectNamespace;\n`;
                indexTs += `  ${a.aggregateType.toUpperCase()}_DO_STAGING?: DurableObjectNamespace;\n`;
                indexTs += `  ${a.aggregateType.toUpperCase()}_DO_PROD?: DurableObjectNamespace;\n`;
              });
              indexTs += `}\n\n`;

              // Worker Fetch Router
              indexTs += `export default {\n`;
              indexTs += `  async fetch(request: Request, env: Env): Promise<Response> {\n`;
              indexTs += `    const url = new URL(request.url);\n`;
              actors.forEach(a => {
                const pathPrefix = a.aggregateType.toLowerCase() + 's';
                indexTs += `    const match_${a.id} = url.pathname.match(/^\\/v1\\/${pathPrefix}\\/([^\\/]+)\\/commands/);\n`;
                indexTs += `    if (match_${a.id}) {\n`;
                indexTs += `      const idVal = match_${a.id}[1];\n`;
                indexTs += `      const namespace = env.${a.aggregateType.toUpperCase()}_DO_PROD || env.${a.aggregateType.toUpperCase()}_DO_STAGING || env.${a.aggregateType.toUpperCase()}_DO_DEV;\n`;
                indexTs += `      if (!namespace) return new Response("Durable Object namespace not bound for environment", { status: 500 });\n`;
                indexTs += `      const doId = namespace.idFromName(idVal);\n`;
                indexTs += `      const stub = namespace.get(doId);\n`;
                indexTs += `      return stub.fetch(request);\n`;
                indexTs += `    }\n`;
              });
              indexTs += `    return new Response("Not Found", { status: 404 });\n`;
              indexTs += `  }\n`;
              indexTs += `};\n\n`;

              // Generate DO Class for each aggregate
              actors.forEach(a => {
                indexTs += `export class ${a.aggregateType}DO extends DurableObject {\n`;
                indexTs += `  sql: any;\n\n`;
                indexTs += `  constructor(state: any, env: Env) {\n`;
                indexTs += `    super(state, env);\n`;
                indexTs += `    this.sql = state.storage.sql;\n`;
                indexTs += `    this.initializeSchema();\n`;
                indexTs += `  }\n\n`;

                indexTs += `  async initializeSchema() {\n`;
                a.objects.forEach(obj => {
                  const oName = typeof obj === 'string' ? obj : obj.name;
                  const tableName = oName.toLowerCase() + 's';
                  indexTs += `    this.sql.exec(\`CREATE TABLE IF NOT EXISTS ${tableName} (id TEXT PRIMARY KEY, status TEXT, ${a.key} TEXT)\`);\n`;
                });
                indexTs += `  }\n\n`;

                indexTs += `  async fetch(request: Request): Promise<Response> {\n`;
                indexTs += `    try {\n`;
                indexTs += `      const body = await request.json() as any;\n`;
                indexTs += `      const command = body.command;\n\n`;
                
                a.actions.forEach(act => {
                  indexTs += `      if (command === "${act}") {\n`;
                  indexTs += `        // Execute business commands\n`;
                  indexTs += `        return Response.json({ success: true, event: "${act.toLowerCase()}-completed" });\n`;
                  indexTs += `      }\n`;
                });

                indexTs += `      return new Response("Action unsupported", { status: 400 });\n`;
                indexTs += `    } catch (e: any) {\n`;
                indexTs += `      return new Response(e.message, { status: 500 });\n`;
                indexTs += `    }\n`;
                indexTs += `  }\n`;
                indexTs += `}\n\n`;
              });
              fs.writeFileSync(path.join(tempDir, 'index.ts'), indexTs, 'utf-8');

              // 4. Client strongly-typed SDK generator with LacifyClientConfig support
              let sdkTs = `// Strongly-typed Lacify Client SDK generated dynamically\n\n`;
              sdkTs += `export interface LacifyClientConfig {\n`;
              sdkTs += `  environment?: "dev" | "staging" | "production";\n`;
              sdkTs += `  baseUrl?: string;\n`;
              sdkTs += `}\n\n`;
              sdkTs += `export class LacifyClient {\n`;
              sdkTs += `  private endpoint: string;\n\n`;
              sdkTs += `  constructor(config: LacifyClientConfig = {}) {\n`;
              sdkTs += `    if (config.baseUrl) {\n`;
              sdkTs += `      this.endpoint = config.baseUrl;\n`;
              sdkTs += `    } else {\n`;
              sdkTs += `      const env = config.environment || "dev";\n`;
              sdkTs += `      if (env === "production") {\n`;
              sdkTs += `        this.endpoint = "https://api.lacify.app";\n`;
              sdkTs += `      } else if (env === "staging") {\n`;
              sdkTs += `        this.endpoint = "https://staging-api.lacify.app";\n`;
              sdkTs += `      } else {\n`;
              sdkTs += `        this.endpoint = "https://dev-api.lacify.app";\n`;
              sdkTs += `      }\n`;
              sdkTs += `    }\n`;
              sdkTs += `  }\n\n`;

              actors.forEach(a => {
                a.actions.forEach(act => {
                  const methodName = act.charAt(0).toLowerCase() + act.slice(1);
                  const pathPrefix = a.aggregateType.toLowerCase() + 's';
                  sdkTs += `  async ${methodName}(${a.key}: string, payload: any = {}) {\n`;
                  sdkTs += `    const response = await fetch(\`\${this.endpoint}/v1/${pathPrefix}/\${${a.key}}/commands\`, {\n`;
                  sdkTs += `      method: "POST",\n`;
                  sdkTs += `      headers: { "Content-Type": "application/json" },\n`;
                  sdkTs += `      body: JSON.stringify({ command: "${act}", ...payload })\n`;
                  sdkTs += `    });\n`;
                  sdkTs += `    return response.json();\n`;
                  sdkTs += `  }\n\n`;
                });
              });
              sdkTs += `}\n`;
              fs.writeFileSync(path.join(tempDir, 'lacify-client.ts'), sdkTs, 'utf-8');

              // Run native zip utility
              exec(`cd "${tempDir}" && zip -r "${zipFile}" .`, (zipErr) => {
                if (zipErr) {
                  res.writeHead(500, { 'Content-Type': 'application/json' });
                  res.end(JSON.stringify({ success: false, message: 'Compression failed: ' + zipErr.message }));
                  return;
                }

                // Send the generated zip binary down
                const stat = fs.statSync(zipFile);
                res.writeHead(200, {
                  'Content-Type': 'application/zip',
                  'Content-Disposition': 'attachment; filename="lacify-runtime-package.zip"',
                  'Content-Length': stat.size
                });

                const readStream = fs.createReadStream(zipFile);
                readStream.pipe(res);

                readStream.on('end', () => {
                  // Cleanup temp files
                  fs.rmSync(tempDir, { recursive: true, force: true });
                  fs.unlinkSync(zipFile);
                });
              });

            } catch (err) {
              res.writeHead(500, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ success: false, message: err.message }));
            }
          });
        } 
        
        else {
          next();
        }
      });
    }
  }
  ],
  server: {
    port: 5173,
    host: true,
    // The production UI calls the deployed Control API directly. In local
    // development, preserve the same /api contract through this proxy.
    proxy: {
      '/api': {
        target: process.env.LACIFY_CONTROL_API_URL || 'http://127.0.0.1:8787',
        changeOrigin: true,
      },
    },
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
});
