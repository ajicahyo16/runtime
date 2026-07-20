// Console State Management
const STATE = {
  currentEnv: 'dev',
  currentMode: 'builder',
  isUplinkConnected: false,
  totalQueries: 0,
  activeDOsCount: 0,
  projects: ['new-runtime'],
  activeProject: 'new-runtime',
  activeActors: []
};

// Server API helpers for Phase 6
async function saveActorToServer(actor) {
  try {
    const project = STATE.activeProject || 'new-runtime';
    await fetch(`/api/save-contract?project=${project}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(actor)
    });
  } catch (e) {
    console.error('Failed to save actor to server:', e);
  }
}

async function loadContractsFromServer() {
  try {
    const project = STATE.activeProject || 'new-runtime';
    const response = await fetch(`/api/load-contracts?project=${project}`);
    const data = await response.json();
    if (data.success && data.actors) {
      STATE.activeActors = data.actors;
      renderActors();
      updateMetricsDashboard();
      if (data.actors.length > 0) {
        addLog(`[System] Loaded ${data.actors.length} aggregate configurations from local disk for "${project}".`, 'success');
      } else {
        // If no files on server for this project, save defaults
        const defaults = [
          { id: 'outlet-pos', name: 'Outlet Jakarta', size: '1.0 MB', queries: 0, status: 'dormant' },
          { id: 'erp-finance', name: 'Warehouse Main', size: '4.8 MB', queries: 0, status: 'dormant' },
          { id: 'crm-contacts', name: 'Booking Calendar', size: '2.1 MB', queries: 0, status: 'dormant' }
        ];
        for (const actor of defaults) {
          if (actor.id === 'outlet-pos') {
            actor.aggregateType = 'Outlet';
            actor.key = 'outletId';
            actor.objects = [
              { name: 'Order', fields: 'id, subtotal, tax, total' },
              { name: 'Product', fields: 'id, name, price, stock' },
              { name: 'Payment', fields: 'id, amount, status' },
              { name: 'Shift', fields: 'id, cashierName, openedAt' }
            ];
            actor.actions = ['CreateOrder', 'AddOrderItem', 'ApplyOrderDiscount', 'PayOrder', 'CloseShift'];
            actor.states = [
              { obj: 'Order', flow: ['Draft', 'Open', 'Paid', 'Cancelled'] },
              { obj: 'Shift', flow: ['Open', 'Closed'] }
            ];
          } else if (actor.id === 'erp-finance') {
            actor.aggregateType = 'Warehouse';
            actor.key = 'warehouseId';
            actor.objects = [
              { name: 'Product', fields: 'id, sku, name, details' },
              { name: 'StockItem', fields: 'id, productId, quantity' },
              { name: 'StockMovement', fields: 'id, type, quantity' },
              { name: 'StockTransfer', fields: 'id, sourceId, destId' }
            ];
            actor.actions = ['ReceiveStock', 'TransferStock', 'AdjustStock', 'CompleteStockOpname'];
            actor.states = [
              { obj: 'StockTransfer', flow: ['Pending', 'Approved', 'InTransit', 'Completed'] }
            ];
          } else {
            actor.aggregateType = 'BookingCalendar';
            actor.key = 'calendarId';
            actor.objects = [
              { name: 'Reservation', fields: 'id, startTime, status' },
              { name: 'TimeSlot', fields: 'id, isBooked, resources' },
              { name: 'Resource', fields: 'id, name, availability' }
            ];
            actor.actions = ['CreateBooking', 'CheckAvailability', 'ReserveTimeSlot', 'SendConfirmation'];
            actor.states = [
              { obj: 'Reservation', flow: ['Available', 'OnHold', 'Confirmed', 'Cancelled'] }
            ];
          }
          STATE.activeActors.push(actor);
          await saveActorToServer(actor);
        }
        renderActors();
        updateMetricsDashboard();
        addLog(`[System] Initialized new project "${project}" with default aggregates.`, 'system');
      }
    }
  } catch (e) {
    console.error('Failed to load contracts:', e);
  }
}

// Universe Graph Coordinates & Logic
let canvas, ctx;
let nodes = [];
let links = [];
let particles = [];
let animationFrameId = null;

// Initialise Elements
document.addEventListener('DOMContentLoaded', async () => {
  initSpaceSwitcher();
  initEnvSwitcher();
  initModeToggler();
  initCredentialsForm();
  initActorsGrid();
  initLifecycleSimulation();
  initUniverseView();
  initMonitoringRoom();
  initBusinessDesigner();
  initReleasePromoter();
  initOpsSpacePlayground();
  
  // Initialize dynamic project management UI
  initProjectManagement();

  // Load projects list
  await loadProjectsFromServer();
  // Load contracts for default project
  await loadContractsFromServer();
});


// Environment Switcher logic
// Environment tabs — only shown inside Monitor view
function initEnvSwitcher() {
  const envTabs = document.getElementById('envTabs');
  if (!envTabs) return;
  envTabs.addEventListener('click', (e) => {
    const btn = e.target.closest('.env-tab');
    if (!btn) return;
    envTabs.querySelectorAll('.env-tab').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    STATE.currentEnv = btn.dataset.env;
    addLog(`[System] Environment switched to ${STATE.currentEnv.toUpperCase()}.`, 'system');
    updateEnvVisuals();
    if (STATE.currentMode === 'universe') {
      rebuildUniverseGraph();
    }
  });
}

function updateEnvVisuals() {
  const statusMessage = document.getElementById('statusMessage');
  if (STATE.isUplinkConnected) {
    statusMessage.textContent = `Uplink Status: Connected (${STATE.currentEnv.toUpperCase()})`;
    statusMessage.style.color = '#10b981';
  } else {
    statusMessage.textContent = `Uplink Status: Disconnected (${STATE.currentEnv.toUpperCase()})`;
    statusMessage.style.color = '#64748b';
  }
}

// Mode Switcher: Build / Monitor / Graph / Simulate
function initModeToggler() {
  const modeToggle = document.getElementById('modeToggle');
  const builderView  = document.getElementById('builderView');
  const monitorView  = document.getElementById('monitorView');
  const universeView = document.getElementById('universeView');
  const simulateView = document.getElementById('simulateView');
  const envTabs      = document.getElementById('envTabs');

  modeToggle.addEventListener('click', (e) => {
    const btn = e.target.closest('.mode-btn');
    if (!btn) return;

    document.querySelectorAll('.mode-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');

    STATE.currentMode = btn.dataset.mode;

    // Update breadcrumb
    const crumbView = document.getElementById('crumbView');
    if (crumbView) {
      crumbView.textContent = btn.querySelector('span') ? btn.querySelector('span').textContent : btn.textContent.trim();
    }

    // Stop universe animation if leaving that view
    if (animationFrameId) {
      cancelAnimationFrame(animationFrameId);
      animationFrameId = null;
    }

    // Hide all views
    [builderView, monitorView, universeView, simulateView].forEach(v => v && v.classList.remove('active'));

    // Show env tabs ONLY on Monitor
    if (envTabs) envTabs.style.display = STATE.currentMode === 'monitor' ? 'flex' : 'none';

    if (STATE.currentMode === 'builder') {
      builderView && builderView.classList.add('active');
    } else if (STATE.currentMode === 'monitor') {
      monitorView && monitorView.classList.add('active');
      updateMonitoringDashboard();
    } else if (STATE.currentMode === 'universe') {
      universeView && universeView.classList.add('active');
      startUniverseGraph();
    } else if (STATE.currentMode === 'simulate') {
      simulateView && simulateView.classList.add('active');
    }
  });
}

// Credentials Form & Uplink handshake
function initCredentialsForm() {
  const form = document.getElementById('credentialsForm');
  const connectBtn = document.getElementById('connectBtn');
  const toggleApiToken = document.getElementById('toggleApiToken');
  const apiTokenInput = document.getElementById('apiToken');
  const uplinkContainer = document.querySelector('.uplink-status-container');
  const cloudNode = document.getElementById('cloudNode');
  const statusMessage = document.getElementById('statusMessage');

  const headerBtn = document.getElementById('headerUplinkBtn');
  const modal = document.getElementById('uplinkModal');
  const closeBtn = document.getElementById('closeUplinkModalBtn');

  // Toggle Modal visibility
  if (headerBtn && modal && closeBtn) {
    headerBtn.addEventListener('click', () => {
      modal.style.display = 'flex';
    });
    closeBtn.addEventListener('click', () => {
      modal.style.display = 'none';
    });
  }

  function handleSuccessConnection(message = 'Connected') {
    STATE.isUplinkConnected = true;
    connectBtn.disabled = false;
    connectBtn.querySelector('span').textContent = 'Uplink Connected';
    if (uplinkContainer) uplinkContainer.classList.remove('animating');
    if (cloudNode) cloudNode.classList.add('connected');
    if (statusMessage) {
      statusMessage.textContent = `Uplink Status: Connected (${STATE.currentEnv.toUpperCase()})`;
      statusMessage.style.color = '#10b981';
    }

    // Update sidebar uplink button
    if (headerBtn) {
      headerBtn.setAttribute('data-connected', 'true');
      const label = headerBtn.querySelector('#uplinkBtnLabel');
      if (label) label.textContent = 'Uplink Connected';
    }

    // Auto-close modal after delay
    setTimeout(() => {
      modal.style.display = 'none';
    }, 1200);

    // Refresh simulate view active state if open
    checkUserSpaceStatus();
  }
  
  toggleApiToken.addEventListener('click', () => {
    const isPassword = apiTokenInput.type === 'password';
    apiTokenInput.type = isPassword ? 'text' : 'password';
  });

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const accountId = document.getElementById('accountId').value.trim();
    const apiToken = apiTokenInput.value.trim();

    connectBtn.disabled = true;
    connectBtn.querySelector('span').textContent = 'Connecting Handshake...';
    uplinkContainer.classList.add('animating');
    statusMessage.textContent = 'Performing secure handshake...';
    statusMessage.style.color = '#f59e0b';
    addLog(`[Uplink] Authenticating credentials with Cloudflare edge...`, 'warn');

    // Sandbox Mock Mode
    if (apiToken === 'sandbox' || apiToken === 'mock') {
      setTimeout(() => {
        handleSuccessConnection();
        addLog(`[Uplink] Sandbox mode loaded. Mock access active for DO/R2/SQLite.`, 'success');
      }, 1500);
      return;
    }

    // Real API integration via local proxy
    try {
      const response = await fetch('/api/verify-uplink', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ accountId, apiToken })
      });
      const data = await response.json();

      if (response.ok && data.success) {
        handleSuccessConnection();
        addLog(`[Uplink] Secure uplink established. Linked to Account: ${data.message.replace('Linked to account: ', '')}`, 'success');
      } else {
        throw new Error(data.message || 'Verification failed.');
      }
    } catch (error) {
      connectBtn.disabled = false;
      connectBtn.querySelector('span').textContent = 'Retry Handshake';
      uplinkContainer.classList.remove('animating');
      cloudNode.classList.remove('connected');
      statusMessage.textContent = `Error: ${error.message}`;
      statusMessage.style.color = '#ef4444';
      addLog(`[Uplink Error] Handshake failed: ${error.message}`, 'warn');
      addLog(`[Tip] Type 'sandbox' in API Token for offline test mode.`, 'system');
    }
  });
}


// Actors Management (Durable Objects)
function initActorsGrid() {
  const deployBtn = document.getElementById('deployBtn');
  const addAggregateBtn = document.getElementById('addAggregateBtn');
  
  addAggregateBtn.addEventListener('click', () => {
    const name = prompt('Enter Business Aggregate Name (e.g. Booking System, Inventory Ledger):');
    if (!name || !name.trim()) return;

    const trimmedName = name.trim();
    // Generate clean type name (camel case alphanumeric)
    const typeName = trimmedName.split(/\s+/).map(w => w.charAt(0).toUpperCase() + w.slice(1).replace(/[^a-zA-Z0-9]/g, '')).join('');
    const id = trimmedName.toLowerCase().replace(/[^a-z0-9]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');

    if (STATE.activeActors.some(v => v.id === id)) {
      alert('An aggregate with this identifier already exists.');
      return;
    }

    const key = typeName.charAt(0).toLowerCase() + typeName.slice(1) + 'Id';

    const newActor = {
      id,
      name: trimmedName,
      aggregateType: typeName,
      key,
      size: '1.0 MB',
      queries: 0,
      status: 'dormant',
      objects: [
        { name: typeName + 'Record', fields: 'id, status' }
      ],
      actions: ['Create' + typeName, 'Update' + typeName],
      states: [
        { obj: typeName + 'Record', flow: ['Draft', 'Processed'] }
      ]
    };
    STATE.activeActors.push(newActor);
    saveActorToServer(newActor);
    
    addLog(`[Builder] Created Business Aggregate "${trimmedName}" schema configuration.`, 'system');
    renderActors();
  });

  deployBtn.addEventListener('click', () => {
    if (!STATE.isUplinkConnected) {
      alert('Please connect to Cloudflare Uplink first.');
      return;
    }
    
    deployBtn.disabled = true;
    deployBtn.querySelector('span').textContent = 'Deploying SQLite Durable Objects...';
    addLog(`[Deployment] Packaging and compiling Worker scripts for "${STATE.currentEnv}"...`, 'warn');
    
    STATE.activeActors.forEach((v, index) => {
      setTimeout(() => {
        v.status = 'active';
        saveActorToServer(v);
        addLog(`[Deployment] Durable Object deployed: ${v.name} (SQLite schema initialized)`, 'success');
        renderActors();
        updateMetricsDashboard();
      }, (index + 1) * 600);
    });
    
    setTimeout(() => {
      deployBtn.disabled = false;
      deployBtn.querySelector('span').textContent = 'Redeploy Active Schema';
    }, 2500);
  });
  
  renderActors();
}

function renderActors() {
  const grid = document.getElementById('actorsGrid');
  if (!grid) return;
  grid.innerHTML = STATE.activeActors.map(actor => `
    <div class="actor-card" id="actor-${actor.id}" style="cursor: pointer; position: relative;">
      <button class="delete-actor-btn" data-id="${actor.id}" title="Delete Aggregate" style="position: absolute; top: 0.5rem; right: 0.5rem; background: transparent; border: none; color: #64748b; cursor: pointer; padding: 0.25rem; font-size: 0.9rem; transition: color 0.2s; z-index: 10;">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="14" height="14"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><line x1="10" y1="11" x2="10" y2="17"/><line x1="14" y1="11" x2="14" y2="17"/></svg>
      </button>
      <div class="actor-info">
        <h4>${actor.name}</h4>
        <div class="actor-meta">
          <span>Durable Object / SQLite</span>
          <span>Size: ${actor.size}</span>
          <span>Queries: ${actor.queries}</span>
        </div>
      </div>
      <span class="actor-badge ${actor.status}">${actor.status.toUpperCase()}</span>
    </div>
  `).join('');

  // Register click events to open Business Object Designer
  STATE.activeActors.forEach(actor => {
    const card = document.getElementById(`actor-${actor.id}`);
    if (card) {
      card.addEventListener('click', (e) => {
        if (e.target.closest('.delete-actor-btn')) return;
        openBusinessObjectDesigner(actor);
      });
    }
  });

  // Register delete events
  document.querySelectorAll('.delete-actor-btn').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const id = btn.dataset.id;
      if (confirm(`Are you sure you want to delete aggregate "${id}"?`)) {
        await deleteActorFromServer(id);
      }
    });
  });
}

async function deleteActorFromServer(id) {
  try {
    const project = STATE.activeProject || 'new-runtime';
    const response = await fetch(`/api/delete-contract?project=${project}&id=${id}`, {
      method: 'DELETE'
    });
    if (!response.ok) throw new Error('Failed to delete contract file.');
    
    // Remove from state
    STATE.activeActors = STATE.activeActors.filter(actor => actor.id !== id);
    addLog(`[Compiler] Deleted contract for "${id}".`, 'info');
    renderActors();
    updateMetricsDashboard();
  } catch (e) {
    alert(e.message);
  }
}


// Log utility
function addLog(text, type = '') {
  const consoleLogs = document.getElementById('consoleLogs');
  if (!consoleLogs) return;
  const line = document.createElement('div');
  line.className = `log-line ${type}`;
  line.textContent = text;
  consoleLogs.appendChild(line);
  consoleLogs.scrollTop = consoleLogs.scrollHeight;
}

// Update live metric panel values
function updateMetricsDashboard() {
  const activeDoEl = document.getElementById('activeDoMetric');
  const totalQueriesEl = document.getElementById('totalQueriesMetric');
  
  STATE.activeDOsCount = STATE.activeActors.filter(v => v.status === 'active').length;
  if (activeDoEl) activeDoEl.textContent = STATE.activeDOsCount;
  if (totalQueriesEl) totalQueriesEl.textContent = STATE.totalQueries;
}

// Live Lifecycle Pipeline Visualizer
function initLifecycleSimulation() {
  const triggerBtn = document.getElementById('triggerRequestBtn');
  const speedSelect = document.getElementById('simSpeed');
  const orb = document.getElementById('lifecycleOrb');
  const label = document.getElementById('orbLabel');
  const steps = document.querySelectorAll('.pipeline-step');
  
  const lifecycleStates = [
    { key: 'wake', class: 'state-wake', text: 'Wake DO' },
    { key: 'validate', class: 'state-validate', text: 'Validate Data' },
    { key: 'execute', class: 'state-execute', text: 'Execute Logic' },
    { key: 'persist', class: 'state-persist', text: 'Persist SQLite' },
    { key: 'update-summary', class: 'state-execute', text: 'Update Metrics' },
    { key: 'respond', class: 'state-wake', text: 'Respond Client' },
    { key: 'sleep', class: 'state-sleep', text: 'Sleep' }
  ];
  
  let isRunning = false;
  
  triggerBtn.addEventListener('click', () => {
    if (isRunning) return;
    if (STATE.activeDOsCount === 0) {
      alert('Please deploy at least one Aggregate to activate Durable Objects.');
      return;
    }
    
    isRunning = true;
    triggerBtn.disabled = true;
    
    const stepDuration = parseInt(speedSelect.value);
    let currentStepIndex = 0;
    
    function runNextStep() {
      if (currentStepIndex >= lifecycleStates.length) {
        isRunning = false;
        triggerBtn.disabled = false;
        steps.forEach(s => s.classList.remove('active', 'success'));
        return;
      }
      
      const step = lifecycleStates[currentStepIndex];
      orb.className = `lifecycle-orb ${step.class}`;
      label.textContent = step.text;
      
      steps.forEach((s, idx) => {
        if (idx === currentStepIndex) {
          s.classList.add('active');
          s.classList.remove('success');
        } else if (idx < currentStepIndex) {
          s.classList.add('success');
          s.classList.remove('active');
        } else {
          s.classList.remove('active', 'success');
        }
      });
      
      addLog(`[Engine] Stage: ${step.text.toUpperCase()} - processed.`, 'system');
      
      if (step.key === 'persist') {
        STATE.totalQueries += 1;
        const activeActor = STATE.activeActors.find(v => v.status === 'active');
        if (activeActor) {
          activeActor.queries += 1;
          renderActors();
        }
        updateMetricsDashboard();
      }
      
      currentStepIndex++;
      setTimeout(runNextStep, stepDuration);
    }
    
    runNextStep();
  });
}



// UNIVERSE GRAPH ANIMATION (Obsidian-Style Canvas Model)
function initUniverseView() {
  canvas = document.getElementById('universeCanvas');
  ctx = canvas.getContext('2d');
  const triggerBtn = document.getElementById('universeTriggerBtn');

  // Resize handler
  window.addEventListener('resize', resizeCanvas);
  
  triggerBtn.addEventListener('click', () => {
    sendTransactionPulse();
  });
}

function resizeCanvas() {
  if (!canvas) return;
  const wrapper = canvas.parentElement;
  canvas.width = wrapper.clientWidth;
  canvas.height = wrapper.clientHeight;
}

function startUniverseGraph() {
  resizeCanvas();
  rebuildUniverseGraph();
  
  // Animation Loop
  function tick() {
    updateUniverseForces();
    drawUniverseGraph();
    animationFrameId = requestAnimationFrame(tick);
  }
  tick();
}

function rebuildUniverseGraph() {
  nodes = [];
  links = [];
  particles = [];
  
  const width = canvas.width;
  const height = canvas.height;
  const isMobile = width < 600;

  // 1. Gateway node
  const gatewayNode = {
    id: 'gateway',
    name: 'Gateway Link',
    x: isMobile ? width * 0.12 : width * 0.15,
    y: height / 2,
    vx: 0, vy: 0,
    r: isMobile ? 12 : 16,
    color: '#00e5ff',
    pulse: 0
  };
  nodes.push(gatewayNode);

  // 2. R2 Asset Storage node
  const r2Node = {
    id: 'r2-storage',
    name: 'R2 Store',
    x: isMobile ? width * 0.88 : width * 0.85,
    y: height * 0.25,
    vx: 0, vy: 0,
    r: isMobile ? 10 : 14,
    color: '#38bdf8',
    pulse: 0
  };
  nodes.push(r2Node);

  // 3. Durable Object actors
  const activeActors = STATE.activeActors.filter(v => v.status === 'active');
  
  activeActors.forEach((v, index) => {
    const angle = ((index - (activeActors.length - 1) / 2) * Math.PI) / 4;
    const dist = isMobile ? width * 0.28 : width * 0.35;
    const targetX = width * 0.5 + Math.cos(angle) * dist * 0.5;
    const targetY = height / 2 + Math.sin(angle) * height * (isMobile ? 0.22 : 0.3);
    
    const doNode = {
      id: v.id,
      name: isMobile ? v.name.replace(' Actor', '') : v.name,
      x: targetX,
      y: targetY,
      vx: 0, vy: 0,
      r: isMobile ? 15 : 22,
      color: '#10b981',
      pulse: 0,
      queries: v.queries,
      isDO: true
    };
    nodes.push(doNode);

    // Link: Gateway -> Durable Object
    links.push({ source: gatewayNode, target: doNode });
    // Link: Durable Object -> R2 Store
    links.push({ source: doNode, target: r2Node });
  });

}

function updateUniverseForces() {
  const k = 0.05; // spring strength
  
  // Drift / Float Physics
  nodes.forEach(node => {
    // Soft Brownian drift
    node.vx += (Math.random() - 0.5) * 0.1;
    node.vy += (Math.random() - 0.5) * 0.1;
    
    // Repulsive forces between nodes
    nodes.forEach(other => {
      if (node.id === other.id) return;
      const dx = node.x - other.x;
      const dy = node.y - other.y;
      const dist = Math.hypot(dx, dy) || 1;
      if (dist < 180) {
        const force = (180 - dist) * 0.005;
        node.vx += (dx / dist) * force;
        node.vy += (dy / dist) * force;
      }
    });

    // Update positions
    node.x += node.vx;
    node.y += node.vy;

    // Dampen speeds
    node.vx *= 0.92;
    node.vy *= 0.92;
    
    // Bounds clamping
    node.x = Math.max(node.r + 20, Math.min(canvas.width - node.r - 20, node.x));
    node.y = Math.max(node.r + 20, Math.min(canvas.height - node.r - 20, node.y));

    // Fade out pulse animations
    if (node.pulse > 0) node.pulse -= 0.05;
  });

  // Keep gateway anchored to its left sector
  const gw = nodes.find(n => n.id === 'gateway');
  if (gw) {
    gw.x += (canvas.width * 0.15 - gw.x) * 0.1;
    gw.y += (canvas.height / 2 - gw.y) * 0.1;
  }

  // Keep R2 anchored to top-right sector
  const r2 = nodes.find(n => n.id === 'r2-storage');
  if (r2) {
    r2.x += (canvas.width * 0.85 - r2.x) * 0.1;
    r2.y += (canvas.height * 0.25 - r2.y) * 0.1;
  }

  // Update particles along links
  particles.forEach((p, idx) => {
    p.progress += p.speed;
    
    // Calculate position
    const dx = p.target.x - p.source.x;
    const dy = p.target.y - p.source.y;
    p.x = p.source.x + dx * p.progress;
    p.y = p.source.y + dy * p.progress;

    if (p.progress >= 1) {
      // Arrived at target
      p.target.pulse = 1;
      
      // If it arrived at a DO, trigger a secondary flow to R2 or SQLite
      if (p.target.isDO) {
        STATE.totalQueries += 1;
        p.target.queries += 1;
        // Find R2 node
        const r2Node = nodes.find(n => n.id === 'r2-storage');
        if (r2Node && Math.random() > 0.4) {
          particles.push({
            source: p.target,
            target: r2Node,
            progress: 0,
            speed: 0.03,
            color: '#38bdf8',
            x: p.target.x,
            y: p.target.y
          });
        }
      }
      
      // Remove particle
      particles.splice(idx, 1);
    }
  });
}

function drawUniverseGraph() {
  ctx.clearRect(0, 0, canvas.width, canvas.height);

  // 1. Draw Links
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.05)';
  ctx.lineWidth = 1.5;
  links.forEach(link => {
    ctx.beginPath();
    ctx.moveTo(link.source.x, link.source.y);
    ctx.lineTo(link.target.x, link.target.y);
    ctx.stroke();
  });

  // 2. Draw active flow particles
  particles.forEach(p => {
    ctx.shadowBlur = 8;
    ctx.shadowColor = p.color;
    ctx.fillStyle = p.color;
    ctx.beginPath();
    ctx.arc(p.x, p.y, 4, 0, Math.PI * 2);
    ctx.fill();
  });
  ctx.shadowBlur = 0; // Reset shadow

  // 3. Draw Nodes
  const isMobile = canvas.width < 600;
  nodes.forEach(node => {
    // Pulse expansion outline
    if (node.pulse > 0) {
      ctx.strokeStyle = node.color;
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.arc(node.x, node.y, node.r + (1 - node.pulse) * (isMobile ? 12 : 20), 0, Math.PI * 2);
      ctx.stroke();
    }

    // Outer boundary ring
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.15)';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(node.x, node.y, node.r, 0, Math.PI * 2);
    ctx.stroke();

    // Solid core
    ctx.fillStyle = node.color;
    ctx.beginPath();
    ctx.arc(node.x, node.y, node.isDO ? (isMobile ? 8 : 12) : (isMobile ? 5 : 8), 0, Math.PI * 2);
    ctx.fill();

    // Inner SQLite Database ring (for Durable Objects)
    if (node.isDO) {
      ctx.strokeStyle = 'rgba(0, 229, 255, 0.4)';
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.arc(node.x, node.y, isMobile ? 4 : 6, 0, Math.PI * 2);
      ctx.stroke();
    }

    // Text Label
    ctx.fillStyle = '#cbd5e1';
    ctx.font = isMobile ? '500 9px Outfit' : '500 11px Outfit';
    ctx.textAlign = 'center';
    ctx.fillText(node.name, node.x, node.y + node.r + (isMobile ? 12 : 18));
  });

}

function sendTransactionPulse() {
  const activeDOs = nodes.filter(n => n.isDO);
  if (activeDOs.length === 0) {
    alert('Please deploy the aggregates from the Build view first.');
    return;
  }
  
  // Pick random DO target
  const targetDO = activeDOs[Math.floor(Math.random() * activeDOs.length)];
  const gwNode = nodes.find(n => n.id === 'gateway');
  if (gwNode && targetDO) {
    particles.push({
      source: gwNode,
      target: targetDO,
      progress: 0,
      speed: 0.02,
      color: '#00e5ff',
      x: gwNode.x,
      y: gwNode.y
    });
  }
}


// MONITORING ROOM INSTRUMENTATION
function initMonitoringRoom() {
  const triggerMonitorBtn = document.getElementById('triggerMonitorRequestBtn');
  if (triggerMonitorBtn) {
    triggerMonitorBtn.addEventListener('click', () => {
      triggerMonitorEventSourcing();
    });
  }
}

function updateMonitoringDashboard() {
  // Update stats counts
  STATE.activeDOsCount = STATE.activeActors.filter(v => v.status === 'active').length;
  
  // Render Aggregate Table (Aggregate Explorer)
  const tableBody = document.getElementById('aggregateTableBody');
  if (tableBody) {
    // Modify one actor to represent large size for testing warning flag
    if (STATE.activeActors[1]) {
      STATE.activeActors[1].size = '8.4 GB'; // Triggers warning (exceeds 8 GB)
    }

    tableBody.innerHTML = STATE.activeActors.map(actor => {
      const isWarning = parseFloat(actor.size) >= 8.0 && actor.size.includes('GB');
      const sizeDisplay = isWarning 
        ? `<span style="color:#f59e0b; font-weight:600;">⚠ ${actor.size} / 10 GB</span>`
        : `<span>${actor.size} / 10 GB</span>`;
      
      const reads = actor.status === 'active' ? '1.2 M' : '0';
      const writes = actor.status === 'active' ? '230 K' : '0';
      const latency = actor.status === 'active' ? '24 ms' : '0 ms';
      
      return `
        <tr>
          <td style="font-weight: 500; color: #fff;">${actor.name}</td>
          <td>${actor.queries * 12 + (actor.status === 'active' ? 12430 : 0)}</td>
          <td>${reads}</td>
          <td>${writes}</td>
          <td>${sizeDisplay}</td>
          <td>${latency}</td>
          <td>
            <span class="actor-badge ${actor.status}">${actor.status.toUpperCase()}</span>
          </td>
        </tr>
      `;
    }).join('');
  }

  // Render Score Warnings
  const scoreWarning = document.getElementById('scoreWarning');
  const doTimeoutAlert = document.getElementById('doTimeoutAlert');
  const healthScoreNum = document.getElementById('healthScoreNum');

  const hasHighStorage = STATE.activeActors.some(actor => parseFloat(actor.size) >= 8.0 && actor.size.includes('GB'));
  
  if (scoreWarning) {
    scoreWarning.style.display = hasHighStorage ? 'block' : 'none';
  }

  // Render Topology
  renderTopologyTree();
}

function renderTopologyTree() {
  const treeEl = document.getElementById('topologyTree');
  if (!treeEl) return;

  let html = `
<div class="tree-node root">[Root] Company Workspace Context (${STATE.currentEnv.toUpperCase()})</div>
`;

  STATE.activeActors.forEach(actor => {
    const statusLabel = actor.status === 'active' ? '[Active]' : '[Dormant]';
    html += `
<div class="tree-node branch">├── ${statusLabel} ${actor.name} (Durable Object / SQLite)</div>
`;
    if (actor.id === 'outlet-pos') {
      html += `
<div class="tree-node leaf">│   ├── table: inventory</div>
<div class="tree-node leaf">│   ├── table: shifts</div>
<div class="tree-node leaf">│   ├── cache: reports_summary</div>
<div class="tree-node leaf">│   └── state: booking_state_machine</div>
`;
    } else if (actor.id === 'erp-finance') {
      html += `
<div class="tree-node leaf">│   ├── table: general_ledger</div>
<div class="tree-node leaf">│   └── table: accounts_payable</div>
`;
    } else {
      html += `
<div class="tree-node leaf">│   ├── table: leads_directory</div>
<div class="tree-node leaf">│   └── table: customer_agreements</div>
`;
    }
  });

  treeEl.innerHTML = html;

}

// Simulated event sourcing timeline
function triggerMonitorEventSourcing() {
  const timelineEl = document.getElementById('inspectorTimeline');
  if (!timelineEl) return;

  const events = [
    { title: 'payment-created', time: '10:02:15 AM', desc: 'Create Payment (A123) initialized - waiting state', dotClass: 'success' },
    { title: 'payment-validating', time: '10:02:16 AM', desc: 'Validate input parameters & user token - OK', dotClass: 'success' },
    { title: 'payment-received', time: '10:02:17 AM', desc: 'Receive payment gateway API response', dotClass: 'success' },
    { title: 'payment-persisted', time: '10:02:18 AM', desc: 'Persist SQL transaction records to local DO storage', dotClass: 'success' },
    { title: 'payment-notify', time: '10:02:19 AM', desc: 'Notify Billing Outpost & upload PDF receipt to R2 bucket', dotClass: 'warn' },
    { title: 'payment-completed', time: '10:02:20 AM', desc: 'Payment process complete. State sealed. Sleeping.', dotClass: 'success' }
  ];

  timelineEl.innerHTML = '';
  let index = 0;

  function addNextEvent() {
    if (index >= events.length) return;
    const ev = events[index];
    
    const evItem = document.createElement('div');
    evItem.className = 'timeline-item';
    evItem.style.animation = 'fadeIn 0.3s ease-out forwards';
    evItem.innerHTML = `
      <div class="timeline-dot ${ev.dotClass}"></div>
      <div class="timeline-content">
        <div class="timeline-title">${ev.title.toUpperCase()}</div>
        <div class="timeline-desc" style="font-size:0.8rem; color:#94a3b8;">${ev.desc}</div>
        <div class="timeline-time">${ev.time}</div>
      </div>
    `;
    
    timelineEl.appendChild(evItem);
    timelineEl.scrollTop = timelineEl.scrollHeight;

    // Simulate Cost and Queries updating in background on persist
    if (ev.title === 'payment-persisted') {
      STATE.totalQueries += 1;
      if (STATE.activeActors[0]) {
        STATE.activeActors[0].queries += 1;
      }
      updateMonitoringDashboard();
    }
    
    index++;
    setTimeout(addNextEvent, 600);
  }

  addNextEvent();
}

// Dynamic tabs content compiler gen
function generateTabsContent(actor) {
  // Normalize objects
  const objects = (actor.objects || []).map(o => {
    if (typeof o === 'string') return { name: o, fields: 'id' };
    return o;
  });

  // Normalize states
  let states = actor.states || [];
  if (states.length > 0 && typeof states[0] === 'string') {
    const targetObj = (objects && objects[0]) ? (objects[0].name || objects[0]) : 'Record';
    states = [{
      obj: targetObj,
      flow: states
    }];
  }

  const aggregateType = actor.aggregateType || 'Custom';
  const key = actor.key || 'id';
  
  // 1. contract YAML
  const contractYaml = `Aggregate:
  Name: ${aggregateType}
  IdentityKey: ${key}
  PartitionKey: ${key}
  RuntimeMapping:
    DurableObject: ${aggregateType}DO
    SQLiteDatabase: aggregate-local

Objects:
${objects.map(o => `  - Name: ${o.name}\n    Fields: [${o.fields}]`).join('\n')}

Commands:
${(actor.actions || []).map(a => `  - Name: ${a}\n    Input:\n      ${key}: ${aggregateType}Id`).join('\n')}

States:
${states.map(s => `  - Object: ${s.obj}\n    Flow: [${s.flow.join(', ')}]`).join('\n')}`;

  // 2. Client SDK TS
  const firstAction = (actor.actions && actor.actions[0]) || 'executeCommand';
  const sdkCode = `// Generated Client SDK
const result = await lacify.${aggregateType.toLowerCase()}s.${firstAction.charAt(0).toLowerCase() + firstAction.slice(1)}({
  ${key}: "mock-${actor.id}",
  timestamp: Date.now()
});`;

  // 3. API Routes
  const apiRoutes = (actor.actions || []).map(a => {
    return `POST /v1/${aggregateType.toLowerCase()}s/{${key}}/${a.toLowerCase()}`;
  }).join('\n') + `\n\nGET  /v1/${aggregateType.toLowerCase()}s/{${key}}`;

  // 4. Readme doc
  const readmeDoc = `# ${actor.name} Aggregate (Type: ${aggregateType})
Represents the consistency boundary for ${actor.name} business operations.
All transactions are serialized inside the ${aggregateType} Durable Object namespace with SQLite local commits.

### Objects List:
${(actor.objects || []).map(o => `- **${o.name}**: fields \`(${o.fields})\``).join('\n')}

### Commands:
${(actor.actions || []).map(a => `- **${a}**`).join('\n')}`;

  return {
    contract: contractYaml,
    sdk: sdkCode,
    api: apiRoutes,
    readme: readmeDoc
  };
}

// BUSINESS OBJECT DESIGNER & AI PROPOSAL ENGINE
function openBusinessObjectDesigner(actor) {
  const panel = document.getElementById('objectDesignerPanel');
  const title = document.getElementById('designerAggregateName');
  const objectsList = document.getElementById('designerObjectsList');
  const actionsList = document.getElementById('designerActionsList');
  const statesList = document.getElementById('designerStatesList');

  const boundaryName = document.getElementById('boundaryName');
  const boundaryKey = document.getElementById('boundaryKey');
  const boundaryRuntime = document.getElementById('boundaryRuntime');
  const boundaryStorage = document.getElementById('boundaryStorage');
  const mapAggregateName = document.getElementById('mapAggregateName');

  if (!panel) return;

  title.textContent = `${actor.name} - Aggregate Design Room`;
  panel.style.display = 'block';
  const workspace = document.getElementById('builderWorkspaceArea');
  if (workspace) workspace.style.display = 'none';
  panel.scrollIntoView({ behavior: 'smooth' });

  // Fallback defaults if they don't exist yet on custom actors
  if (!actor.objects) actor.objects = [];
  if (!actor.actions) actor.actions = [];
  if (!actor.states) actor.states = [];
  if (!actor.aggregateType) actor.aggregateType = 'Custom';
  if (!actor.key) actor.key = 'id';

  // Normalize objects formatted as strings
  actor.objects = actor.objects.map(o => {
    if (typeof o === 'string') return { name: o, fields: 'id' };
    return o;
  });

  // Normalize states formatted as strings
  if (actor.states.length > 0 && typeof actor.states[0] === 'string') {
    const targetObj = (actor.objects && actor.objects[0]) ? (actor.objects[0].name || actor.objects[0]) : 'Record';
    actor.states = [{
      obj: targetObj,
      flow: actor.states
    }];
  }

  const aggregateType = actor.aggregateType;
  const key = actor.key;

  // Populate boundary specs
  if (boundaryName) boundaryName.textContent = aggregateType;
  if (boundaryKey) boundaryKey.textContent = key;
  if (boundaryRuntime) boundaryRuntime.textContent = `${aggregateType}Runtime`;
  if (boundaryStorage) boundaryStorage.textContent = `aggregate-local`;
  if (mapAggregateName) mapAggregateName.textContent = aggregateType;

  // Setup tab switcher logic
  const contentArea = document.getElementById('compilerTabContent');
  const tabs = document.querySelectorAll('#compilerTabs .mini-tab');

  function updateTabsAndCompile() {
    const tabsContent = generateTabsContent(actor);
    const activeTab = document.querySelector('#compilerTabs .mini-tab.active');
    const targetTab = activeTab ? activeTab.dataset.tab : 'contract';
    if (contentArea && tabsContent[targetTab]) {
      contentArea.textContent = tabsContent[targetTab];
    }

    tabs.forEach(tab => {
      // Clone node to clear old click listeners
      const newTab = tab.cloneNode(true);
      tab.parentNode.replaceChild(newTab, tab);

      newTab.addEventListener('click', () => {
        document.querySelectorAll('#compilerTabs .mini-tab').forEach(t => t.classList.remove('active'));
        newTab.classList.add('active');
        const target = newTab.dataset.tab;
        if (contentArea && tabsContent[target]) {
          contentArea.textContent = tabsContent[target];
        }
      });
    });
  }

  function renderDesignerLists() {
    // 1. Objects List
    objectsList.innerHTML = `
      <div class="nested-root-header">Root: ${aggregateType}</div>
      <div class="nested-children">
        ${actor.objects.map(o => `
          <div class="designer-item" style="position:relative; padding-right:2rem;">
            <strong>${o.name}</strong>
            <span class="property-type">${o.fields}</span>
            <button class="delete-spec-btn delete-obj-btn" data-name="${o.name}" title="Delete Object" style="position:absolute; right:0.5rem; top:50%; transform:translateY(-50%); background:transparent; border:none; color:#ef4444; cursor:pointer; font-size:0.8rem; padding:2px;">&times;</button>
          </div>
        `).join('')}
      </div>
    `;

    // 2. Commands List
    actionsList.innerHTML = actor.actions.map(a => `
      <div class="designer-item action-trigger-item" style="cursor: pointer; transition: all 0.2s; position:relative; padding-right:2rem;" data-action="${a}">
        ⚡ ${a}
        <button class="delete-spec-btn delete-cmd-btn" data-name="${a}" title="Delete Command" style="position:absolute; right:0.5rem; top:50%; transform:translateY(-50%); background:transparent; border:none; color:#ef4444; cursor:pointer; font-size:0.8rem; padding:2px; z-index: 10;">&times;</button>
      </div>
    `).join('');

    // 3. States List
    statesList.innerHTML = actor.states.map(s => `
      <div style="margin-bottom: 0.75rem; position:relative; border: 1px solid rgba(255,255,255,0.03); padding:0.5rem; border-radius:6px; background:rgba(0,0,0,0.1);">
        <div style="font-size: 0.8rem; color:#64748b; font-weight:600; margin-bottom:0.25rem; display:flex; justify-content:space-between; align-items:center;">
          <span>${s.obj} State Machine</span>
          <button class="delete-spec-btn delete-state-btn" data-obj="${s.obj}" title="Delete State" style="background:transparent; border:none; color:#ef4444; cursor:pointer; font-size:0.8rem; padding:0;">&times;</button>
        </div>
        <div style="display:flex; flex-direction:column; gap:0.4rem;">
          ${s.flow.map((flowStep, idx) => `
            <div class="designer-item" style="font-size: 0.8rem; padding: 0.35rem 0.5rem;">
              ${idx + 1}. <em>${flowStep}</em>
            </div>
          `).join('')}
        </div>
      </div>
    `).join('');

    // Wire command execution simulator clicks (ignoring deletes)
    actionsList.querySelectorAll('.action-trigger-item').forEach(item => {
      item.addEventListener('click', (e) => {
        if (e.target.closest('.delete-spec-btn')) return;
        
        actionsList.querySelectorAll('.action-trigger-item').forEach(el => {
          el.style.background = '';
          el.style.borderColor = '';
        });
        item.style.background = 'rgba(56, 189, 248, 0.12)';
        item.style.borderColor = 'rgba(56, 189, 248, 0.25)';
        
        const actionName = item.dataset.action;
        activateActionVisualizer(actor, actionName);
      });
    });

    // Wire Deletes click handlers
    document.querySelectorAll('.delete-obj-btn').forEach(btn => {
      btn.addEventListener('click', async (e) => {
        e.stopPropagation();
        const name = btn.dataset.name;
        if (confirm(`Delete Object "${name}"?`)) {
          actor.objects = actor.objects.filter(o => o.name !== name);
          // Also remove any state machine bound to it
          actor.states = actor.states.filter(s => s.obj !== name);
          await saveActorToServer(actor);
          renderDesignerLists();
          updateTabsAndCompile();
        }
      });
    });

    document.querySelectorAll('.delete-cmd-btn').forEach(btn => {
      btn.addEventListener('click', async (e) => {
        e.stopPropagation();
        const name = btn.dataset.name;
        if (confirm(`Delete Command "${name}"?`)) {
          actor.actions = actor.actions.filter(a => a !== name);
          await saveActorToServer(actor);
          renderDesignerLists();
          updateTabsAndCompile();
        }
      });
    });

    document.querySelectorAll('.delete-state-btn').forEach(btn => {
      btn.addEventListener('click', async (e) => {
        e.stopPropagation();
        const obj = btn.dataset.obj;
        if (confirm(`Delete State Machine for "${obj}"?`)) {
          actor.states = actor.states.filter(s => s.obj !== obj);
          await saveActorToServer(actor);
          renderDesignerLists();
          updateTabsAndCompile();
        }
      });
    });
  }

  // Bind Add Buttons clicks (clearing old listeners by cloning)
  const addObjBtn = document.getElementById('addDesignerObjectBtn');
  const addCmdBtn = document.getElementById('addDesignerCommandBtn');
  const addStateBtn = document.getElementById('addDesignerStateBtn');

  if (addObjBtn) {
    const clone = addObjBtn.cloneNode(true);
    addObjBtn.parentNode.replaceChild(clone, addObjBtn);
    clone.addEventListener('click', async () => {
      const name = prompt('Enter Object Name (e.g. Refund):');
      if (name && name.trim()) {
        const fields = prompt('Enter comma-separated fields (e.g. id, amount, reason):', 'id, createdAt');
        actor.objects.push({
          name: name.trim(),
          fields: fields ? fields.trim() : 'id'
        });
        await saveActorToServer(actor);
        renderDesignerLists();
        updateTabsAndCompile();
      }
    });
  }

  if (addCmdBtn) {
    const clone = addCmdBtn.cloneNode(true);
    addCmdBtn.parentNode.replaceChild(clone, addCmdBtn);
    clone.addEventListener('click', async () => {
      const name = prompt('Enter Command Name (e.g. ApproveRefund):');
      if (name && name.trim()) {
        actor.actions.push(name.trim());
        await saveActorToServer(actor);
        renderDesignerLists();
        updateTabsAndCompile();
      }
    });
  }

  if (addStateBtn) {
    const clone = addStateBtn.cloneNode(true);
    addStateBtn.parentNode.replaceChild(clone, addStateBtn);
    clone.addEventListener('click', async () => {
      const objOptions = actor.objects.map(o => o.name);
      if (objOptions.length === 0) {
        alert('Please create at least one Business Object first.');
        return;
      }
      const objName = prompt(`Enter object to apply states to (Available: ${objOptions.join(', ')}):`);
      if (objName && objOptions.includes(objName.trim())) {
        const flowStr = prompt('Enter comma-separated states (e.g. Draft, Approved, Rejected):', 'Draft, Completed');
        if (flowStr && flowStr.trim()) {
          const flow = flowStr.split(',').map(s => s.trim());
          // Remove old state machine if it exists for this object
          actor.states = actor.states.filter(s => s.obj !== objName.trim());
          actor.states.push({
            obj: objName.trim(),
            flow
          });
          await saveActorToServer(actor);
          renderDesignerLists();
          updateTabsAndCompile();
        }
      } else if (objName) {
        alert('Invalid object name selected.');
      }
    });
  }

  // Initial compile and render
  renderDesignerLists();
  updateTabsAndCompile();

  // Hide visualizer box initially
  const vizBox = document.getElementById('designerVisualizerBox');
  if (vizBox) vizBox.style.display = 'none';
}

function initBusinessDesigner() {
  const closeBtn = document.getElementById('closeDesignerBtn');
  const designerPanel = document.getElementById('objectDesignerPanel');
  const aiGenerateBtn = document.getElementById('aiGenerateBtn');
  const aiPromptInput = document.getElementById('aiPromptInput');
  const aiProposalModal = document.getElementById('aiProposalModal');
  const rejectBtn = document.getElementById('rejectProposalBtn');
  const acceptBtn = document.getElementById('acceptProposalBtn');
  const proposalDetails = document.getElementById('proposalDetails');

  const promptAiBtn = document.getElementById('promptAiBtn');
  const aiModal = document.getElementById('aiBuilderModal');
  const closeAiModalBtn = document.getElementById('closeAiModalBtn');

  // Toggle AI Modal visibility
  if (promptAiBtn && aiModal && closeAiModalBtn) {
    promptAiBtn.addEventListener('click', () => {
      aiModal.style.display = 'flex';
      aiPromptInput.focus();
    });
    closeAiModalBtn.addEventListener('click', () => {
      aiModal.style.display = 'none';
    });
  }

  if (closeBtn) {
    closeBtn.addEventListener('click', () => {
      if (designerPanel) designerPanel.style.display = 'none';
      const workspace = document.getElementById('builderWorkspaceArea');
      if (workspace) {
        workspace.style.display = 'block';
        workspace.scrollIntoView({ behavior: 'smooth' });
      }
      // Re-render actors just to sync any potential state changes instantly
      renderActors();
    });
  }

  const deployFromDesignerBtn = document.getElementById('deployFromDesignerBtn');
  if (deployFromDesignerBtn) {
    deployFromDesignerBtn.addEventListener('click', () => {
      const deployBtn = document.getElementById('deployBtn');
      if (deployBtn) {
        // Switch back to workspace instantly so the user sees the pipeline animations
        if (closeBtn) closeBtn.click();
        deployBtn.click();
      }
    });
  }

  if (aiGenerateBtn && aiProposalModal && proposalDetails) {
    aiGenerateBtn.addEventListener('click', () => {
      const promptText = aiPromptInput.value.trim();
      if (!promptText) {
        alert('Please describe your business model prompt first.');
        return;
      }

      // Hide prompt modal before opening proposal preview modal
      if (aiModal) aiModal.style.display = 'none';

      // Propose custom structures based on prompt keywords
      let aggregateName = 'Inventory POS System';
      let objList = ['StockItem', 'Product', 'Order', 'Receipt'];
      let actionList = ['AdjustStock', 'SellProduct', 'LogReceipt'];
      let stateList = ['Draft', 'Processed', 'Synced'];

      if (promptText.toLowerCase().includes('klinik') || promptText.toLowerCase().includes('clinic')) {
        aggregateName = 'Clinic Booking Calendar';
        objList = ['Patient', 'Appointment', 'DoctorSchedule', 'Prescription'];
        actionList = ['BookAppointment', 'CheckInPatient', 'WritePrescription'];
        stateList = ['Scheduled', 'Arrived', 'CheckedOut', 'NoShow'];
      } else if (promptText.toLowerCase().includes('finance') || promptText.toLowerCase().includes('accounting')) {
        aggregateName = 'Billing Operations Ledger';
        objList = ['Invoice', 'PaymentReceived', 'TaxRecord', 'LedgerEntry'];
        actionList = ['CreateInvoice', 'ApplyPayment', 'GenerateTaxSummary'];
        stateList = ['Unpaid', 'PartiallyPaid', 'Paid', 'Overdue'];
      }

      proposalDetails.innerHTML = `
        <div class="proposal-section">
          <h4>Proposed Business Aggregate</h4>
          <p><strong>${aggregateName}</strong> (Mapped internally to <code>Durable Object</code> and <code>SQLite</code>)</p>
        </div>
        <div class="proposal-section">
          <h4>Proposed Business Objects</h4>
          <ul>
            ${objList.map(o => `<li>${o}</li>`).join('')}
          </ul>
        </div>
        <div class="proposal-section">
          <h4>Proposed Allowed Actions</h4>
          <ul>
            ${actionList.map(a => `<li>${a}</li>`).join('')}
          </ul>
        </div>
        <div class="proposal-section">
          <h4>Proposed State Machine</h4>
          <ul>
            ${stateList.map(s => `<li>${s}</li>`).join('')}
          </ul>
        </div>
      `;

      // Cache proposed details on active elements to retrieve during accept
      aiProposalModal.dataset.proposedName = aggregateName;
      aiProposalModal.dataset.proposedId = aggregateName.toLowerCase().replace(/\s+/g, '-');
      aiProposalModal.dataset.proposedObjects = JSON.stringify(objList);
      aiProposalModal.dataset.proposedActions = JSON.stringify(actionList);
      aiProposalModal.dataset.proposedStates = JSON.stringify(stateList);
      
      aiProposalModal.style.display = 'flex';
    });
  }

  if (rejectBtn) {
    rejectBtn.addEventListener('click', () => {
      aiProposalModal.style.display = 'none';
    });
  }

  if (acceptBtn) {
    acceptBtn.addEventListener('click', () => {
      const name = aiProposalModal.dataset.proposedName;
      const id = aiProposalModal.dataset.proposedId;

      if (STATE.activeActors.some(v => v.id === id)) {
        alert('This Business Aggregate model already exists.');
        aiProposalModal.style.display = 'none';
        return;
      }

      const objects = JSON.parse(aiProposalModal.dataset.proposedObjects || '[]');
      const actions = JSON.parse(aiProposalModal.dataset.proposedActions || '[]');
      const states = JSON.parse(aiProposalModal.dataset.proposedStates || '[]');
      const isClinic = name.toLowerCase().includes('clinic');
      const isBilling = name.toLowerCase().includes('billing');
      const typeName = name.split(' ')[0];

      const newActor = {
        id: id,
        name: name,
        aggregateType: typeName,
        key: isClinic ? 'appointmentId' : (isBilling ? 'invoiceId' : 'itemId'),
        size: '1.2 MB',
        queries: 0,
        status: 'dormant',
        objects,
        actions,
        states
      };

      // Add to state
      STATE.activeActors.push(newActor);
      saveActorToServer(newActor);

      addLog(`[AI Compiler] Compiled and design approved for: "${name}". Ready for deployment.`, 'success');
      renderActors();
      updateMonitoringDashboard();

      aiPromptInput.value = '';
      aiProposalModal.style.display = 'none';
      
      // Auto open designer for the newly compiled aggregate
      openBusinessObjectDesigner(STATE.activeActors[STATE.activeActors.length - 1]);
    });
  }

  const downloadBtn = document.getElementById('downloadPackageBtn');
  if (downloadBtn) {
    downloadBtn.addEventListener('click', async () => {
      downloadBtn.disabled = true;
      downloadBtn.querySelector('span').textContent = '📥 Packaging ZIP...';
      
      try {
        const response = await fetch('/api/compile-package', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(STATE.activeActors)
        });

        if (!response.ok) {
          throw new Error('Failed to generate compilation package.');
        }

        const blob = await response.blob();
        const url = window.URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = 'lacify-runtime-package.zip';
        document.body.appendChild(a);
        a.click();
        a.remove();
        window.URL.revokeObjectURL(url);

        addLog(`[Compiler] Generated Cloudflare Workers ZIP package. Download started.`, 'success');
      } catch (e) {
        alert(e.message);
      } finally {
        downloadBtn.disabled = false;
        downloadBtn.querySelector('span').textContent = '📥 Download Deployable Package';
      }
    });
  }
}

function activateActionVisualizer(actor, actionName) {
  const vizBox = document.getElementById('designerVisualizerBox');
  const actionLabel = document.getElementById('visualizerActionName');
  const logsContent = document.getElementById('simulatorLogs');
  const steps = document.querySelectorAll('#designerPipelineTrack .pipeline-step');
  const orb = document.getElementById('designerLifecycleOrb');
  const orbLabel = document.getElementById('designerOrbLabel');

  if (!vizBox) return;

  actionLabel.textContent = actionName;
  vizBox.style.display = 'block';
  vizBox.scrollIntoView({ behavior: 'smooth' });

  // Reset visualizer states
  steps.forEach(s => s.classList.remove('active', 'success'));
  orb.className = 'lifecycle-orb';
  orbLabel.textContent = 'Idle';
  logsContent.innerHTML = `&gt; Ready to run simulation for action: <strong>${actionName}</strong>.<br>&gt; Click "Run Simulator" to execute.`;

  // Clone button to remove previous event listeners
  const oldBtn = document.getElementById('triggerSimulatorBtn');
  const newBtn = oldBtn.cloneNode(true);
  oldBtn.parentNode.replaceChild(newBtn, oldBtn);

  newBtn.addEventListener('click', () => {
    runConveyorBeltSimulation(actor, actionName, newBtn, steps, orb, orbLabel, logsContent);
  });
}

function runConveyorBeltSimulation(actor, actionName, triggerBtn, steps, orb, orbLabel, logsContent) {
  triggerBtn.disabled = true;
  logsContent.innerHTML = '';

  const speed = parseInt(document.getElementById('simSpeedSelector').value);

  // Customize logs based on actionName
  let valPayload = '{}';
  let execLog = '';
  let sqlLog = '';
  let summaryLog = '';

  if (actionName === 'PayOrder') {
    valPayload = '{\n    outletId: "outlet-pos",\n    orderId: "order-5491",\n    amount: {\n      value: 250000,\n      currency: "IDR"\n    },\n    method: "QRIS"\n  }';
    execLog = `Execute transition: Draft -> Paid. Verify payment signature. Emits PaymentConfirmed event.`;
    sqlLog = `INSERT INTO payments (id, amount, status) VALUES ('pay-98b1', 250000, 'PAID');\n  UPDATE orders SET status = 'paid' WHERE id = 'order-5491';`;
    summaryLog = `UPDATE daily_sales_summary SET total = total + 250000, txn_count = txn_count + 1 WHERE day = DATE('now');`;
  } else if (actionName === 'TransferStock') {
    valPayload = '{\n    warehouseId: "wh-jakarta",\n    productId: "prod-992",\n    quantity: 150,\n    sourceWh: "wh-jakarta",\n    destWh: "wh-surabaya"\n  }';
    execLog = `Check inventory availability in "wh-jakarta": Stock level is 420 (Required: 150). OK. Emits TransferInitiated event.`;
    sqlLog = `UPDATE stock SET quantity = quantity - 150 WHERE warehouse_id = 'wh-jakarta' AND product_id = 'prod-992';\n  INSERT INTO stock_movements (id, type, qty) VALUES ('m-77b', 'TRANSFER', 150);`;
    summaryLog = `UPDATE inventory_balance SET stock_in_transit = stock_in_transit + 150;`;
  } else if (actionName === 'CreateBooking') {
    valPayload = '{\n    calendarId: "cal-clinic",\n    slotId: "slot-098",\n    customerId: "cust-552"\n  }';
    execLog = `Verify availability for Slot "slot-098". Slot is FREE. Emits BookingCreated event.`;
    sqlLog = `INSERT INTO reservations (id, slot_id, status) VALUES ('res-331a', 'slot-098', 'CONFIRMED');\n  UPDATE time_slots SET is_booked = 1 WHERE id = 'slot-098';`;
    summaryLog = `UPDATE daily_booking_metrics SET active_bookings = active_bookings + 1;`;
  } else {
    valPayload = `{\n    aggregateId: "${actor.id}",\n    timestamp: ${Date.now()}\n  }`;
    execLog = `Processing allowed command "${actionName}" handler.`;
    sqlLog = `INSERT INTO audit_logs (id, action) VALUES ('log-99a', '${actionName}');`;
    summaryLog = `UPDATE aggregate_metrics SET queries_count = queries_count + 1;`;
  }

  const pipelineStages = [
    {
      key: 'wake',
      class: 'state-wake',
      label: 'Wake',
      log: `&gt; [1/7] Waking up Durable Object namespace context for ${actor.name}...\n&gt; [System] Cloudflare routing ID: do_ref_${actor.id}_3001`
    },
    {
      key: 'validate',
      class: 'state-validate',
      label: 'Validate',
      log: `&gt; [2/7] Scanning client request headers & signature.\n&gt; [Params] Payload matches type contract:\n${valPayload}`
    },
    {
      key: 'execute',
      class: 'state-execute',
      label: 'Execute',
      log: `&gt; [3/7] Loading state machine rule processor.\n&gt; [Logic] ${execLog}`
    },
    {
      key: 'persist',
      class: 'state-persist',
      label: 'Persist',
      log: `&gt; [4/7] Opening atomic SQLite database transaction.\n&gt; [SQL DML] Executing SQLite statement:\n  ${sqlLog}\n&gt; [System] SQLite Write: SUCCESS. Transaction committed.`
    },
    {
      key: 'update-summary',
      class: 'state-execute',
      label: 'Summary',
      log: `&gt; [5/7] Compiling offline reports metrics inside cache.\n&gt; [SQL Summary] updating metrics tables:\n  ${summaryLog}`
    },
    {
      key: 'respond',
      class: 'state-wake',
      label: 'Respond',
      log: `&gt; [6/7] Dispatching HTTP response callback payload to frontend Client SDK.\n&gt; [SDK] Response delivered successfully in 18ms.`
    },
    {
      key: 'sleep',
      class: 'state-sleep',
      label: 'Sleep',
      log: `&gt; [7/7] Executing cleanup handlers. Entering standby mode.\n&gt; [System] Durable Object memory sealed. Going to Sleep.`
    }
  ];

  let currentStageIndex = 0;

  function runNextStage() {
    if (currentStageIndex >= pipelineStages.length) {
      triggerBtn.disabled = false;
      steps.forEach(s => s.classList.remove('active', 'success'));
      return;
    }

    const stage = pipelineStages[currentStageIndex];
    orb.className = `lifecycle-orb ${stage.class}`;
    orbLabel.textContent = stage.label;

    steps.forEach((s, idx) => {
      if (idx === currentStageIndex) {
        s.classList.add('active');
        s.classList.remove('success');
      } else if (idx < currentStageIndex) {
        s.classList.add('success');
        s.classList.remove('active');
      } else {
        s.classList.remove('active', 'success');
      }
    });

    const pre = document.createElement('pre');
    pre.style.margin = '0 0 0.5rem 0';
    pre.innerHTML = stage.log;
    logsContent.appendChild(pre);
    logsContent.scrollTop = logsContent.scrollHeight;

    // Increment states on Persist step
    if (stage.key === 'persist') {
      STATE.totalQueries += 1;
      actor.queries += 1;
      
      // Flash table row if in Monitoring Room
      updateMonitoringDashboard();
      
      // Update Grid UI
      renderActors();
    }

    currentStageIndex++;
    setTimeout(runNextStage, speed);
  }

  runNextStage();
}

// SPACE SWITCHER (Developer Deck vs Operational User Space)
function initSpaceSwitcher() {
  // Space switcher removed — Simulate is now a primary nav item (data-mode="simulate")
}

// RELEASE PROMOTION PIPELINE
function initReleasePromoter() {
  const deployBtn = document.getElementById('deployBtn');
  const promoteStagingBtn = document.getElementById('promoteStagingBtn');
  const promoteProdBtn = document.getElementById('promoteProdBtn');
  
  const fillDevStaging = document.getElementById('fill-dev-staging');
  const fillStagingProd = document.getElementById('fill-staging-prod');
  
  const verDev = document.getElementById('verLabel-dev');
  const verStaging = document.getElementById('verLabel-staging');
  const verProd = document.getElementById('verLabel-prod');

  if (!deployBtn) return;

  let releaseMajor = 1;
  let releaseMinor = 0;
  let releasePatch = 0;

  deployBtn.addEventListener('click', () => {
    releasePatch++;
    const nextVer = `v${releaseMajor}.${releaseMinor}.${releasePatch}`;
    verDev.textContent = nextVer;
    
    addLog(`[Compiler] Successfully compiled business contract! Promoted release build ${nextVer} to DEV.`, 'success');
    
    // Enable staging promote
    promoteStagingBtn.disabled = false;
    document.getElementById('promoNode-dev').classList.add('active');
    
    // Reset connectors
    fillDevStaging.style.width = '0%';
    fillStagingProd.style.width = '0%';
    document.getElementById('promoNode-staging').classList.remove('active');
    document.getElementById('promoNode-prod').classList.remove('active');
    promoteProdBtn.disabled = true;
  });

  promoteStagingBtn.addEventListener('click', () => {
    promoteStagingBtn.disabled = true;
    fillDevStaging.style.width = '100%';
    
    const ver = verDev.textContent;
    addLog(`[Promotion] Packaging release artifact ${ver} for Staging...`, 'info');
    addLog(`[Promotion] Deploying to worker environment: lacify-runtime-worker-staging`, 'info');
    addLog(`[Promotion] Mapping isolated bindings: STAGING Durable Object Namespace & isolated SQLite Staging DB`, 'info');
    
    setTimeout(() => {
      verStaging.textContent = ver;
      document.getElementById('promoNode-staging').classList.add('active');
      promoteProdBtn.disabled = false;
      addLog(`[Promotion] Staging runtime active at: https://staging-api.lacify.app`, 'success');
      addLog(`[Promotion] Environment promotion complete! Staging isolated database initialized.`, 'success');
    }, 1500);
  });

  promoteProdBtn.addEventListener('click', () => {
    promoteProdBtn.disabled = true;
    fillStagingProd.style.width = '100%';
    
    const ver = verStaging.textContent;
    addLog(`[Promotion] Promoting release artifact ${ver} to PRODUCTION environment...`, 'info');
    addLog(`[Promotion] Deploying to worker environment: lacify-runtime-worker-prod`, 'info');
    addLog(`[Promotion] Mapping isolated bindings: PRODUCTION Durable Object Namespace & isolated SQLite Production DB`, 'info');
    
    setTimeout(() => {
      verProd.textContent = ver;
      document.getElementById('promoNode-prod').classList.add('active');
      addLog(`[Promotion] Production runtime active at: https://api.lacify.app`, 'success');
      addLog(`[Promotion] Production isolated databases fully operational. Zero crossover active.`, 'success');
    }, 1500);
  });
}

// USER SPACE OPERATIONAL PLAYGROUND
STATE.sqliteTables = {};
STATE.opsActiveActorId = null;

function initOpsSpacePlayground() {
  const opsAggregatesList = document.getElementById('opsAggregatesList');
  const opsControlBoard = document.getElementById('opsControlBoard');
  const opsActiveAggregateTitle = document.getElementById('opsActiveAggregateTitle');
  const opsCommandDeck = document.getElementById('opsCommandDeck');
  const opsSqliteTableBody = document.getElementById('opsSqliteTableBody');
  const opsAuditLedger = document.getElementById('opsAuditLedger');

  if (!opsAggregatesList) return;

  // Render Aggregate Selector cards
  if (STATE.activeActors.length === 0) {
    opsAggregatesList.innerHTML = `<div style="color:#64748b; font-style:italic; font-size:0.8rem; text-align:center;">No aggregates designed in this project. Go to <strong>Build</strong> to add aggregates.</div>`;
    if (opsControlBoard) opsControlBoard.style.display = 'none';
    if (opsSqliteTableBody) {
      opsSqliteTableBody.innerHTML = `<tr><td colspan="4" style="text-align:center; padding:2rem 0; color:#64748b; font-style:italic;">No aggregates designed.</td></tr>`;
    }
    return;
  }

  // Set default active actor if none selected
  if (!STATE.opsActiveActorId || !STATE.activeActors.some(a => a.id === STATE.opsActiveActorId)) {
    STATE.opsActiveActorId = STATE.activeActors[0].id;
  }

  opsAggregatesList.innerHTML = STATE.activeActors.map(actor => {
    const isSelected = STATE.opsActiveActorId === actor.id;
    return `
      <div class="actor-card ops-actor-card-item ${isSelected ? 'active' : ''}" data-id="${actor.id}" style="cursor: pointer; padding: 0.8rem; border-radius: 8px; border: 1px solid ${isSelected ? 'rgba(56, 189, 248, 0.4)' : 'rgba(255,255,255,0.04)'}; background: ${isSelected ? 'rgba(56, 189, 248, 0.08)' : 'rgba(0,0,0,0.15)'}; transition: all 0.2s; margin-bottom: 0.5rem;">
        <div style="display:flex; justify-content:space-between; align-items:center;">
          <strong style="font-size:0.85rem; color:#fff;">${actor.name}</strong>
          <span class="badge ${actor.status}" style="font-size:0.6rem; padding:0.1rem 0.3rem;">${actor.status.toUpperCase()}</span>
        </div>
        <div style="font-size:0.7rem; color:#64748b; margin-top:0.25rem;">Type: ${actor.aggregateType || 'Custom'}</div>
      </div>
    `;
  }).join('');

  // Wire selection click handlers
  document.querySelectorAll('.ops-actor-card-item').forEach(card => {
    card.addEventListener('click', () => {
      const id = card.dataset.id;
      STATE.opsActiveActorId = id;
      initOpsSpacePlayground();
    });
  });

  // Load selected actor details
  const activeActor = STATE.activeActors.find(a => a.id === STATE.opsActiveActorId);
  if (!activeActor) {
    if (opsControlBoard) opsControlBoard.style.display = 'none';
    return;
  }

  // Show control board
  if (opsControlBoard) opsControlBoard.style.display = 'block';
  if (opsActiveAggregateTitle) opsActiveAggregateTitle.textContent = `${activeActor.name} Operations`;

  // Render commands triggers
  const actions = activeActor.actions || [];
  if (actions.length === 0) {
    opsCommandDeck.innerHTML = `<div style="color:#64748b; font-style:italic; font-size:0.8rem; text-align:center; padding:1rem;">No commands designed. Add commands in Design Room.</div>`;
  } else {
    opsCommandDeck.innerHTML = actions.map(a => `
      <button class="primary-btn ops-execute-btn" data-action="${a}" style="width:100%; justify-content:flex-start; padding: 0.6rem 1rem; border-radius: 8px;">
        <span style="font-weight:600;">⚡ ${a}</span>
      </button>
    `).join('');

    // Wire command execution triggers
    document.querySelectorAll('.ops-execute-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const action = btn.dataset.action;
        executeOpsCommand(activeActor, action);
      });
    });
  }

  // Render SQLite table data
  renderOpsSqliteTable(activeActor);
}

function renderOpsSqliteTable(actor) {
  const body = document.getElementById('opsSqliteTableBody');
  if (!body) return;

  const rows = STATE.sqliteTables[actor.id] || [];
  if (rows.length === 0) {
    body.innerHTML = `
      <tr>
        <td colspan="4" style="text-align:center; padding:2.5rem 0; color:#64748b; font-style:italic;">SQLite table is empty. Click command buttons on the left to write transaction data.</td>
      </tr>
    `;
    return;
  }

  body.innerHTML = rows.map(r => `
    <tr style="border-bottom: 1px solid rgba(255,255,255,0.03);">
      <td style="padding:0.75rem 0.5rem; font-family:monospace; color:#38bdf8; vertical-align:top;">${r.id}</td>
      <td style="padding:0.75rem 0.5rem; font-weight:600; color:#fff; vertical-align:top;">${r.type}</td>
      <td style="padding:0.75rem 0.5rem; vertical-align:top;">
        <span class="actor-badge dormant" style="font-size:0.7rem; padding:0.15rem 0.4rem; background:rgba(56, 189, 248, 0.12); color:#38bdf8; border-radius:4px; border:1px solid rgba(56, 189, 248, 0.2); text-transform:uppercase;">${r.state}</span>
      </td>
      <td style="padding:0.75rem 0.5rem; font-size:0.75rem; color:#94a3b8; font-family:monospace; vertical-align:top; white-space:pre-wrap; word-break:break-all;">${JSON.stringify(r.data, null, 2)}</td>
    </tr>
  `).join('');
}

function executeOpsCommand(actor, action) {
  const ledger = document.getElementById('opsAuditLedger');
  const sdkOverlay = document.getElementById('sdkCodeOverlay');
  const overlayCode = document.getElementById('overlayCodeContent');

  if (!STATE.isUplinkConnected) {
    alert('Ops Terminal is offline. Switch to Developer Deck, connect the Uplink with sandbox API token, and click "Compile & Deploy Dev" first!');
    return;
  }

  // 1. Show client SDK floating request card
  const recordId = `REC-${Math.floor(Math.random()*9000)+1000}`;
  const key = actor.key || 'id';
  
  const sdkCallSnippet = `const client = new LacifyClient("${actor.id}");\nconst result = await client.${action.charAt(0).toLowerCase() + action.slice(1)}({\n  ${key}: "${actor.id}-partition",\n  recordId: "${recordId}",\n  timestamp: Date.now()\n});`;

  if (overlayCode) overlayCode.textContent = sdkCallSnippet;
  if (sdkOverlay) sdkOverlay.style.display = 'block';

  addLog(`[SDK] Invoking client.${action.charAt(0).toLowerCase() + action.slice(1)} on partition "${actor.id}"...`, 'info');

  // Trigger visual Orb pulse
  sendTransactionPulse();

  setTimeout(() => {
    if (sdkOverlay) sdkOverlay.style.display = 'none';

    // 2. Perform SQLite transaction mutations
    if (!STATE.sqliteTables[actor.id]) STATE.sqliteTables[actor.id] = [];
    const rows = STATE.sqliteTables[actor.id];

    // Determine target object matching action prefix or first object
    const targetObj = (actor.objects && actor.objects[0]) ? actor.objects[0].name : 'Record';
    
    // Check if command is state transition or creation
    const isCreate = action.toLowerCase().includes('create') || action.toLowerCase().includes('book') || action.toLowerCase().includes('receive') || rows.length === 0;

    let targetRowId = recordId;
    let eventName = `${targetObj}Created`;

    if (isCreate) {
      // Add row
      const initialFields = (actor.objects && actor.objects[0]) ? actor.objects[0].fields.split(',').reduce((acc, cur) => {
        const fieldName = cur.trim();
        acc[fieldName] = fieldName === 'id' ? recordId : 'value';
        return acc;
      }, {}) : { id: recordId };

      const initialState = (actor.states && actor.states[0] && actor.states[0].flow[0]) ? actor.states[0].flow[0] : 'Draft';

      rows.push({
        id: recordId,
        type: targetObj,
        state: initialState,
        data: initialFields
      });
      addLog(`[User Space] Inserted new row ${recordId} into SQLite table.`, 'success');
    } else {
      // Update the last active row
      const lastRow = rows[rows.length - 1];
      targetRowId = lastRow.id;
      
      const stateMachine = actor.states.find(s => s.obj === lastRow.type);
      if (stateMachine && stateMachine.flow) {
        const currentIdx = stateMachine.flow.indexOf(lastRow.state);
        const nextIdx = (currentIdx + 1) % stateMachine.flow.length;
        lastRow.state = stateMachine.flow[nextIdx];
        eventName = `${lastRow.type}StateTransitioned`;
        lastRow.data.updatedAt = Date.now();
      } else {
        lastRow.state = 'Processed';
        eventName = `${lastRow.type}Updated`;
      }
      addLog(`[User Space] Executed SQL UPDATE set state='${lastRow.state}' where id='${targetRowId}'.`, 'success');
    }

    // Refresh UI list tables
    renderOpsSqliteTable(actor);

    // 3. Emit Audit domain event
    if (ledger) {
      // Clear empty placeholder if first event
      if (ledger.querySelector('div[style*="font-style:italic"]')) {
        ledger.innerHTML = '';
      }

      const timestamp = new Date().toLocaleTimeString();
      const entry = document.createElement('div');
      entry.className = 'log-line success';
      entry.style.padding = '0.35rem 0.5rem';
      entry.style.borderBottom = '1px solid rgba(255,255,255,0.03)';
      entry.innerHTML = `
        <span style="color:#64748b;">[${timestamp}]</span> 
        <span style="color:#10b981; font-weight:600;">EVENT EMITTED</span> 
        <span style="color:#fff; font-weight:600;">${eventName}</span> 
        <span style="color:#94a3b8;">{ actor: "${actor.id}", ref: "${targetRowId}" }</span>
      `;
      ledger.appendChild(entry);
      ledger.scrollTop = ledger.scrollHeight;
    }

    // Update global queries count
    STATE.totalQueries += 1;
    actor.queries = (actor.queries || 0) + 1;
    updateMonitoringDashboard();
  }, 2000);
}

async function loadProjectsFromServer() {
  try {
    const response = await fetch('/api/load-projects');
    const data = await response.json();
    if (data.success && data.projects) {
      STATE.projects = data.projects;
      
      // Update sidebar project select
      const select = document.getElementById('projectSelect');
      if (select) {
        select.innerHTML = STATE.projects.map(p => `
          <option value="${p}" ${p === STATE.activeProject ? 'selected' : ''}>${p}</option>
        `).join('') + `<option value="+create">+ Create New Project...</option>`;
      }
      
      // Render Workspace Projects Grid
      renderProjectsGrid();
    }
  } catch (e) {
    console.error('Failed to load projects:', e);
  }
}

function renderProjectsGrid() {
  const grid = document.getElementById('projectsGrid');
  if (!grid) return;
  grid.innerHTML = STATE.projects.map(p => `
    <div class="actor-card project-card-item" data-project="${p}" style="cursor: pointer; border: 1px solid rgba(255, 255, 255, 0.08); padding: 1.5rem; border-radius: 12px; transition: all 0.25s; position:relative;">
      <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom: 0.5rem;">
        <h4 style="margin:0; font-size:1.1rem; color:#fff;">${p}</h4>
        <span class="badge" style="background:rgba(56, 189, 248, 0.1); color:#38bdf8; font-size:0.7rem; padding:0.15rem 0.4rem; border-radius:4px;">Active</span>
      </div>
      <p style="font-size:0.8rem; color:#94a3b8; margin: 0 0 1rem 0;">Local Cloudflare Workers project boundary.</p>
      <div style="font-size:0.75rem; color:#64748b; font-weight:600; display:flex; gap:0.8rem;">
        <span>📁 sqlite schema active</span>
      </div>
    </div>
  `).join('');

  // Add click listeners to project cards
  document.querySelectorAll('.project-card-item').forEach(card => {
    card.addEventListener('click', async () => {
      const p = card.dataset.project;
      await switchActiveProject(p);
    });
  });
}

async function switchActiveProject(p) {
  STATE.activeProject = p;
  
  // Sync select dropdown in sidebar
  const select = document.getElementById('projectSelect');
  if (select) select.value = p;

  // Update breadcrumbs
  const projectCrumb = document.getElementById('projectCrumb');
  if (projectCrumb) {
    projectCrumb.style.display = 'inline';
    projectCrumb.textContent = p;
    // Show arrow separators
    const arrow1 = projectCrumb.nextElementSibling;
    if (arrow1) arrow1.style.display = 'inline';
  }

  const crumbEnv = document.getElementById('crumbEnv');
  if (crumbEnv) {
    crumbEnv.style.display = 'inline';
    const arrow2 = crumbEnv.nextElementSibling;
    if (arrow2) arrow2.style.display = 'inline';
  }

  // Show active project dashboard, hide workspace overview
  const workspaceArea = document.getElementById('builderWorkspaceArea');
  const overviewArea = document.getElementById('workspaceOverviewArea');
  const designerPanel = document.getElementById('objectDesignerPanel');
  
  if (workspaceArea) workspaceArea.style.display = 'block';
  if (overviewArea) overviewArea.style.display = 'none';
  if (designerPanel) designerPanel.style.display = 'none';

  // Load contracts
  await loadContractsFromServer();
}

function initProjectManagement() {
  const select = document.getElementById('projectSelect');
  const workspaceCrumb = document.getElementById('workspaceCrumb');
  const projectCrumb = document.getElementById('projectCrumb');
  const createBtn = document.getElementById('createNewProjectBtn');

  if (select) {
    select.addEventListener('change', async () => {
      const val = select.value;
      if (val === '+create') {
        const name = prompt('Enter new project name:');
        if (name && name.trim()) {
          const cleanName = name.trim().toLowerCase().replace(/[^a-z0-9-_]/g, '-');
          STATE.activeProject = cleanName;
          await switchActiveProject(cleanName);
          await loadProjectsFromServer();
        } else {
          select.value = STATE.activeProject;
        }
      } else {
        await switchActiveProject(val);
      }
    });
  }

  if (workspaceCrumb) {
    workspaceCrumb.addEventListener('click', () => {
      // Show Workspace Projects list
      const workspaceArea = document.getElementById('builderWorkspaceArea');
      const overviewArea = document.getElementById('workspaceOverviewArea');
      const designerPanel = document.getElementById('objectDesignerPanel');

      if (workspaceArea) workspaceArea.style.display = 'none';
      if (overviewArea) overviewArea.style.display = 'block';
      if (designerPanel) designerPanel.style.display = 'none';

      // Update breadcrumbs
      const crumbEnv = document.getElementById('crumbEnv');
      const crumbView = document.getElementById('crumbView');
      const arrow1 = projectCrumb.nextElementSibling;
      const arrow2 = crumbEnv ? crumbEnv.nextElementSibling : null;

      if (projectCrumb) projectCrumb.style.display = 'none';
      if (arrow1) arrow1.style.display = 'none';
      if (crumbEnv) crumbEnv.style.display = 'none';
      if (arrow2) arrow2.style.display = 'none';
      if (crumbView) crumbView.textContent = 'Workspace Overview';
      
      addLog(`[Workspace] Navigated to Workspace Projects overview list.`, 'system');
    });
  }

  if (projectCrumb) {
    projectCrumb.addEventListener('click', () => {
      switchActiveProject(STATE.activeProject);
      
      // Restore breadcrumbs
      const crumbEnv = document.getElementById('crumbEnv');
      const crumbView = document.getElementById('crumbView');
      const arrow1 = projectCrumb.nextElementSibling;
      const arrow2 = crumbEnv ? crumbEnv.nextElementSibling : null;

      if (projectCrumb) projectCrumb.style.display = 'inline';
      if (arrow1) arrow1.style.display = 'inline';
      if (crumbEnv) crumbEnv.style.display = 'inline';
      if (arrow2) arrow2.style.display = 'inline';
      
      const activeDevBtn = document.querySelector('#modeToggle .mode-btn.active');
      if (crumbView) {
        crumbView.textContent = activeDevBtn ? (activeDevBtn.querySelector('span') ? activeDevBtn.querySelector('span').textContent : activeDevBtn.textContent.trim()) : 'Build';
      }
    });
  }

  if (createBtn) {
    createBtn.addEventListener('click', async () => {
      const name = prompt('Enter new project name:');
      if (name && name.trim()) {
        const cleanName = name.trim().toLowerCase().replace(/[^a-z0-9-_]/g, '-');
        await switchActiveProject(cleanName);
        await loadProjectsFromServer();
      }
    });
  }
}



