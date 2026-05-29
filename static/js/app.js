// Global variables for Chart instances
let trainingChart = null;
let sandboxChart = null;
let compareProfitChart = null;
let compareStockChart = null;
let qValuesChart = null;

// Application State
let appState = {
    isTrained: false,
    config: {},
    qTable: null, // Shape: 5 x 3 x 3 x 5
    sandboxData: null,
    sandboxCurrentDay: 0,
    sandboxInterval: null,
    isPlaying: false
};

// Pricing Multipliers Text representation
const priceActions = [
    "Discount (0.90x Competitor / Min 1.05x Cost)",
    "Low Margin (0.95x Competitor / Min 1.10x Cost)",
    "Standard (1.00x Competitor / Min 1.15x Cost)",
    "High Margin (1.05x Competitor / Min 1.20x Cost)",
    "Premium (1.15x Competitor / Min 1.30x Cost)"
];

const demandStatesText = ["Low Demand", "Medium Demand", "High Demand"];
const competitorStatesText = ["Competitor is LOWER", "Comparable Pricing", "Competitor is HIGHER"];

// Initialize on page load
document.addEventListener("DOMContentLoaded", async () => {
    initTabs();
    initSliders();
    await loadProductsFromDB();
    await fetchConfig();
    setupEventListeners();
    initPlaceholderCharts();
    
    // Auto-select first product and sync config
    const selectElement = document.getElementById("store-product-select");
    if (selectElement && selectElement.options.length > 0) {
        selectElement.selectedIndex = 0;
        await handleProductSelectionChange();
    }
});

// -------------------------------------------------------------------------
// Tab Navigation
// -------------------------------------------------------------------------
function initTabs() {
    const tabBtns = document.querySelectorAll(".tab-btn");
    const tabPanes = document.querySelectorAll(".tab-pane");

    tabBtns.forEach(btn => {
        btn.addEventListener("click", () => {
            const tabId = btn.getAttribute("data-tab");
            
            tabBtns.forEach(b => b.classList.remove("active"));
            tabPanes.forEach(p => p.classList.remove("active"));
            
            btn.classList.add("active");
            document.getElementById(tabId).classList.add("active");

            // Trigger chart resize on tab change to prevent rendering glitches
            setTimeout(() => {
                if (trainingChart) trainingChart.resize();
                if (sandboxChart) sandboxChart.resize();
                if (compareProfitChart) compareProfitChart.resize();
                if (compareStockChart) compareStockChart.resize();
                if (qValuesChart) qValuesChart.resize();
            }, 100);
        });
    });
}

// -------------------------------------------------------------------------
// Sliders & Configurations
// -------------------------------------------------------------------------
function initSliders() {
    const sliders = ["alpha", "gamma", "epsilon_decay"];
    sliders.forEach(id => {
        const slider = document.getElementById(id);
        const valSpan = document.getElementById(`${id}-val`);
        if (slider && valSpan) {
            slider.addEventListener("input", () => {
                valSpan.textContent = slider.value;
            });
        }
    });
}

async function fetchConfig() {
    try {
        const response = await fetch('/api/config');
        const data = await response.json();
        appState.config = data;
        
        // Populate inputs
        document.getElementById('max_inventory').value = data.max_inventory;
        document.getElementById('marginal_cost').value = data.marginal_cost;
        document.getElementById('holding_cost').value = data.holding_cost;
        document.getElementById('competitor_base_price').value = data.competitor_base_price;
        document.getElementById('competitor_strategy').value = data.competitor_strategy;
        
        document.getElementById('alpha').value = data.alpha;
        document.getElementById('alpha-val').textContent = data.alpha;
        
        document.getElementById('gamma').value = data.gamma;
        document.getElementById('gamma-val').textContent = data.gamma;
        
        document.getElementById('epsilon_decay').value = data.epsilon_decay;
        document.getElementById('epsilon_decay-val').textContent = data.epsilon_decay;
        
        document.getElementById('train_episodes').value = data.train_episodes;
        
        // Update storefront price & insights with defaults
        updateStorefrontProduct();
    } catch (err) {
        console.error("Error fetching config:", err);
    }
}

// -------------------------------------------------------------------------
// Event Listeners setup
// -------------------------------------------------------------------------
function setupEventListeners() {
    // Config form submission
    document.getElementById("config-form").addEventListener("submit", async (e) => {
        e.preventDefault();
        const formData = new FormData(e.target);
        const configData = {};
        formData.forEach((val, key) => {
            configData[key] = val;
        });
        
        try {
            const response = await fetch('/api/config', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(configData)
            });
            const res = await response.json();
            appState.config = res.config;
            
            // Sync values back to persistent product database
            const prodId = document.getElementById("store-product-select").value;
            const prod = storeProducts.find(p => p.id === prodId);
            if (prod) {
                prod.stock = parseInt(document.getElementById('max_inventory').value);
                prod.baseCost = parseFloat(document.getElementById('marginal_cost').value);
                prod.holdingCost = parseFloat(document.getElementById('holding_cost').value);
                prod.competitorBasePrice = parseFloat(document.getElementById('competitor_base_price').value);
                
                await fetch('/api/products', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(prod)
                });
            }
            
            // Trigger selection update to sync select lists & reload storefront display
            await handleProductSelectionChange();
            
            alert("Configuration applied and saved successfully!");
        } catch (err) {
            console.error("Error saving config:", err);
            alert("Failed to apply configuration.");
        }
    });

    // Training button click
    document.getElementById("start-training-btn").addEventListener("click", startAgentTraining);

    // Sandbox actions
    document.getElementById("play-sim-btn").addEventListener("click", toggleSandboxPlay);
    document.getElementById("step-sim-btn").addEventListener("click", stepSandboxSim);
    document.getElementById("reset-sim-btn").addEventListener("click", resetSandboxSim);

    // Comparison actions
    document.getElementById("run-compare-btn").addEventListener("click", runBenchmarkAnalysis);

    // Q-Table inspector dropdown change
    ["q-inv-select", "q-dem-select", "q-comp-select"].forEach(id => {
        document.getElementById(id).addEventListener("change", renderQValuesChart);
    });

    // Storefront Simulator dropdown change
    ["store-inv-select", "store-traffic-select", "store-comp-select"].forEach(id => {
        document.getElementById(id).addEventListener("change", updateStorefrontProduct);
    });

    document.getElementById("store-product-select").addEventListener("change", handleProductSelectionChange);
    
    document.getElementById("storefront-buy-btn").addEventListener("click", () => {
        const price = document.getElementById("storefront-price-display").textContent;
        const prodName = document.querySelector(".storefront-product-card h2").textContent;
        alert(`🛒 Purchase Confirmed!\n\nYou successfully bought the ${prodName} for ${price}.\n\n(This order reduces the simulated warehouse stock by 1 unit and logs a positive profit reward for the AI agent!)`);
    });

    // Add custom product form submission
    const addProductForm = document.getElementById("add-product-form");
    if (addProductForm) {
        addProductForm.addEventListener("submit", async (e) => {
            e.preventDefault();
            
            const name = document.getElementById("new-prod-name").value.trim();
            const baseCost = parseFloat(document.getElementById("new-prod-cost").value);
            const holdingCost = parseFloat(document.getElementById("new-prod-holding").value);
            const stock = parseInt(document.getElementById("new-prod-stock").value);
            const icon = document.getElementById("new-prod-icon").value;
            const spec1 = document.getElementById("new-prod-spec1").value.trim();
            const spec2 = document.getElementById("new-prod-spec2").value.trim();
            const competitorBasePrice = parseFloat(document.getElementById("new-prod-competitor-price").value);
            
            const specs = [];
            if (spec1) specs.push(spec1);
            if (spec2) specs.push(spec2);
            if (specs.length === 0) {
                specs.push("Premium Quality");
            }
            
            // Generate simple Brand & Model based on Name
            const nameParts = name.split(" ");
            const brand = nameParts[0].toUpperCase();
            const model = nameParts.slice(1).join(" ") || name;
            
            const id = "custom_" + Date.now();
            const rating = `⭐️ ${(4.5 + Math.random() * 0.4).toFixed(1)}/5.0 (${Math.floor(Math.random() * 1200) + 150} Reviews)`;
            
            // UI Loading Feedback
            const submitBtn = addProductForm.querySelector('button[type="submit"]');
            const origBtnText = submitBtn.innerHTML;
            submitBtn.disabled = true;
            submitBtn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Saving...';
            
            const priceSource = "Manually Entered";
            
            const newProduct = {
                id: id,
                name: name,
                rating: rating,
                icon: icon,
                baseCost: baseCost,
                holdingCost: holdingCost,
                stock: stock,
                specs: specs,
                brand: brand,
                model: model,
                competitorBasePrice: competitorBasePrice,
                priceSource: priceSource
            };
            
            // Add to database instead of just local array
            try {
                const saveResponse = await fetch('/api/products', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(newProduct)
                });
                const updatedList = await saveResponse.json();
                storeProducts = updatedList;
            } catch (err) {
                console.error("Error saving product to database:", err);
                storeProducts.push(newProduct);
            }
            
            // Rebuild Storefront Select dropdown
            const selectElement = document.getElementById("store-product-select");
            if (selectElement) {
                selectElement.innerHTML = "";
                storeProducts.forEach(prod => {
                    const opt = document.createElement("option");
                    opt.value = prod.id;
                    opt.textContent = `${prod.name} (Cost: ₹${prod.baseCost.toLocaleString('en-IN')})`;
                    selectElement.appendChild(opt);
                });
            }
            
            // Switch selection to new product
            selectElement.value = id;
            
            // Trigger selection change logic (updates card UI, auto-fills config sidebar, resets training status)
            await handleProductSelectionChange();
            
            // Switch tab view back to customer storefront tab to highlight it
            const storefrontTabBtn = document.querySelector('.tab-btn[data-tab="tab-storefront"]');
            if (storefrontTabBtn) {
                storefrontTabBtn.click();
            }
            
            // Reset form & restore button
            addProductForm.reset();
            submitBtn.disabled = false;
            submitBtn.innerHTML = origBtnText;
            
            // Flash feedback
            let alertMsg = `🎉 Custom Product "${name}" added successfully!\nSelected and ready for simulation on the Storefront.`;
            alert(alertMsg);
        });
    }


}

// -------------------------------------------------------------------------
// Chart Initializations (Placeholder States)
// -------------------------------------------------------------------------
function initPlaceholderCharts() {
    // 1. Training Convergence Chart
    const ctxTrain = document.getElementById("trainingChart").getContext("2d");
    trainingChart = new Chart(ctxTrain, {
        type: 'line',
        data: {
            labels: Array.from({length: 100}, (_, i) => i + 1),
            datasets: [
                {
                    label: 'Avg Episode Reward (Smoothed)',
                    data: Array(100).fill(null),
                    borderColor: '#00f2fe',
                    backgroundColor: 'rgba(0, 242, 254, 0.05)',
                    borderWidth: 2,
                    yAxisID: 'y'
                },
                {
                    label: 'Exploration Rate (Epsilon)',
                    data: Array(100).fill(null),
                    borderColor: '#bd00ff',
                    borderWidth: 1.5,
                    borderDash: [5, 5],
                    yAxisID: 'y1'
                }
            ]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            scales: {
                y: {
                    type: 'linear',
                    display: true,
                    position: 'left',
                    grid: { color: 'rgba(255, 255, 255, 0.05)' },
                    ticks: { color: '#f3f4f6' },
                    title: { display: true, text: 'Cumulative Rewards', color: '#f3f4f6' }
                },
                y1: {
                    type: 'linear',
                    display: true,
                    position: 'right',
                    grid: { drawOnChartArea: false },
                    ticks: { color: '#9ca3af' },
                    title: { display: true, text: 'Exploration (&epsilon;)', color: '#9ca3af' },
                    min: 0,
                    max: 1
                },
                x: {
                    grid: { color: 'rgba(255, 255, 255, 0.05)' },
                    ticks: { color: '#9ca3af' },
                    title: { display: true, text: 'Training Cycles (%)', color: '#9ca3af' }
                }
            },
            plugins: {
                legend: { labels: { color: '#f3f4f6' } }
            }
        }
    });

    // 2. Live Sandbox Simulation Timeline Chart
    const ctxSand = document.getElementById("sandboxChart").getContext("2d");
    sandboxChart = new Chart(ctxSand, {
        type: 'line',
        data: {
            labels: Array.from({length: 31}, (_, i) => i),
            datasets: [
                {
                    label: 'Agent Price (₹)',
                    data: Array(31).fill(null),
                    borderColor: '#00f2fe',
                    backgroundColor: 'transparent',
                    borderWidth: 2.5,
                    yAxisID: 'yPrice',
                    tension: 0.1
                },
                {
                    label: 'Competitor Price (₹)',
                    data: Array(31).fill(null),
                    borderColor: '#bd00ff',
                    backgroundColor: 'transparent',
                    borderWidth: 2,
                    yAxisID: 'yPrice',
                    tension: 0.1
                },
                {
                    label: 'Inventory Level',
                    data: Array(31).fill(null),
                    backgroundColor: 'rgba(255, 159, 67, 0.1)',
                    borderColor: '#ff9f43',
                    borderWidth: 1.5,
                    fill: true,
                    yAxisID: 'yStock',
                    stepped: true
                }
            ]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            scales: {
                yPrice: {
                    type: 'linear',
                    display: true,
                    position: 'left',
                    grid: { color: 'rgba(255, 255, 255, 0.05)' },
                    ticks: { color: '#f3f4f6' },
                    title: { display: true, text: 'Unit Price (₹)', color: '#f3f4f6' }
                },
                yStock: {
                    type: 'linear',
                    display: true,
                    position: 'right',
                    grid: { drawOnChartArea: false },
                    ticks: { color: '#ff9f43' },
                    title: { display: true, text: 'Stock Level (units)', color: '#ff9f43' },
                    min: 0
                },
                x: {
                    grid: { color: 'rgba(255, 255, 255, 0.05)' },
                    ticks: { color: '#9ca3af' },
                    title: { display: true, text: 'Sales Cycle Day', color: '#9ca3af' }
                }
            },
            plugins: {
                legend: { labels: { color: '#f3f4f6' } }
            }
        }
    });

    // 3. Comparison profit chart
    const ctxCompareProfit = document.getElementById("compareProfitChart").getContext("2d");
    compareProfitChart = new Chart(ctxCompareProfit, {
        type: 'bar',
        data: {
            labels: ['Q-Learning Agent', 'Rule-Based Pricing', 'Static Margin'],
            datasets: [
                {
                    label: 'Avg Cumulative Profit (₹)',
                    data: [0, 0, 0],
                    backgroundColor: 'rgba(5, 255, 161, 0.75)',
                    borderColor: '#05ffa1',
                    borderWidth: 1
                },
                {
                    label: 'Avg Cumulative Revenue (₹)',
                    data: [0, 0, 0],
                    backgroundColor: 'rgba(0, 242, 254, 0.6)',
                    borderColor: '#00f2fe',
                    borderWidth: 1
                }
            ]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            scales: {
                y: {
                    grid: { color: 'rgba(255, 255, 255, 0.05)' },
                    ticks: { color: '#f3f4f6' }
                },
                x: {
                    grid: { color: 'rgba(255, 255, 255, 0.05)' },
                    ticks: { color: '#f3f4f6' }
                }
            },
            plugins: {
                legend: { labels: { color: '#f3f4f6' } }
            }
        }
    });

    // 4. Comparison inventory chart
    const ctxCompareStock = document.getElementById("compareStockChart").getContext("2d");
    compareStockChart = new Chart(ctxCompareStock, {
        type: 'bar',
        data: {
            labels: ['Q-Learning Agent', 'Rule-Based Pricing', 'Static Margin'],
            datasets: [
                {
                    label: 'Avg Unsold Stock (units)',
                    data: [0, 0, 0],
                    backgroundColor: 'rgba(255, 159, 67, 0.7)',
                    borderColor: '#ff9f43',
                    borderWidth: 1
                },
                {
                    label: 'Avg Stockout Attempts (units)',
                    data: [0, 0, 0],
                    backgroundColor: 'rgba(255, 74, 90, 0.7)',
                    borderColor: '#ff4a5a',
                    borderWidth: 1
                }
            ]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            scales: {
                y: {
                    grid: { color: 'rgba(255, 255, 255, 0.05)' },
                    ticks: { color: '#f3f4f6' }
                },
                x: {
                    grid: { color: 'rgba(255, 255, 255, 0.05)' },
                    ticks: { color: '#f3f4f6' }
                }
            },
            plugins: {
                legend: { labels: { color: '#f3f4f6' } }
            }
        }
    });

    // 5. Q-Values bar chart
    const ctxQ = document.getElementById("qValuesChart").getContext("2d");
    qValuesChart = new Chart(ctxQ, {
        type: 'bar',
        data: {
            labels: ['1.0x (Cost)', '1.2x', '1.5x (Mid)', '1.8x', '2.2x (Premium)'],
            datasets: [{
                label: 'Expected Long-Term Return',
                data: [0, 0, 0, 0, 0],
                backgroundColor: 'rgba(0, 242, 254, 0.25)',
                borderColor: '#00f2fe',
                borderWidth: 1.5
            }]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            scales: {
                y: {
                    grid: { color: 'rgba(255, 255, 255, 0.05)' },
                    ticks: { color: '#f3f4f6' },
                    title: { display: true, text: 'Expected Reward (Q)', color: '#f3f4f6' }
                },
                x: {
                    grid: { color: 'rgba(255, 255, 255, 0.05)' },
                    ticks: { color: '#f3f4f6' },
                    title: { display: true, text: 'Agent Pricing Action', color: '#f3f4f6' }
                }
            },
            plugins: {
                legend: { display: false }
            }
        }
    });
}

// -------------------------------------------------------------------------
// Tab 1: Agent Training Execution
// -------------------------------------------------------------------------
async function startAgentTraining() {
    const btn = document.getElementById("start-training-btn");
    const progressContainer = document.getElementById("progress-container");
    const progressFill = document.getElementById("progress-fill");
    const progressPercent = document.getElementById("progress-percent");
    
    // UI Feedback locking
    btn.disabled = true;
    progressContainer.classList.remove("hidden");
    
    // Simulate loading progress curve for visual feedback
    let percent = 0;
    const progressInterval = setInterval(() => {
        if (percent < 90) {
            percent += Math.floor(Math.random() * 8) + 2;
            percent = Math.min(percent, 90);
            progressFill.style.width = `${percent}%`;
            progressPercent.textContent = `${percent}%`;
        }
    }, 100);
    
    try {
        // Trigger server-side Q-learning training
        const response = await fetch('/api/train', { method: 'POST' });
        const data = await response.json();
        
        clearInterval(progressInterval);
        
        // Train completes instantly (tabular), animate to 100%
        progressFill.style.width = `100%`;
        progressPercent.textContent = `100%`;
        
        setTimeout(() => {
            // Reset loader
            progressContainer.classList.add("hidden");
            btn.disabled = false;
            
            // Set Trained Status
            appState.isTrained = true;
            appState.qTable = data.q_table;
            
            // Update header badge
            const statusDot = document.getElementById("agent-status-dot");
            const statusText = document.getElementById("agent-status-text");
            statusDot.classList.remove("offline");
            statusDot.classList.add("online");
            statusText.textContent = "Agent Trained";
            
            // Update Training Statistics Panel
            document.getElementById("fill-rate-display").textContent = `${data.fill_rate.toFixed(1)}%`;
            document.getElementById("train-time-display").textContent = `${data.training_time_seconds}s`;
            
            // Populate training chart data
            trainingChart.data.datasets[0].data = data.rewards;
            trainingChart.data.datasets[1].data = data.epsilons;
            trainingChart.update();
            
            // Populate Q-table visualizer
            renderQValuesChart();
            
            // Update storefront dynamic price & insight
            updateStorefrontProduct();
            
            alert("Training completed! The agent policy has converged.");
        }, 300);
        
    } catch (err) {
        clearInterval(progressInterval);
        progressContainer.classList.add("hidden");
        btn.disabled = false;
        console.error("Training error:", err);
        alert("Training failed. Look at backend logs.");
    }
}

// -------------------------------------------------------------------------
// Tab 2: Sandbox Simulator Player
// -------------------------------------------------------------------------
async function startSandboxEpisode() {
    const strategy = document.getElementById("sim-strategy").value;
    
    try {
        const response = await fetch('/api/simulate', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ strategy: strategy })
        });
        const data = await response.json();
        
        appState.sandboxData = data.history;
        appState.sandboxCurrentDay = 0;
        
        // Set chart limits
        sandboxChart.options.scales.yStock.max = appState.config.max_inventory || 25;
        
        // Reset simulation dashboard parameters
        resetSimTimeline();
        
        // Clear log
        const logBox = document.getElementById("sim-log");
        logBox.innerHTML = "";
        
        return true;
    } catch (err) {
        console.error("Error executing sandbox:", err);
        alert("Failed to initialize sandbox simulation.");
        return false;
    }
}

function resetSimTimeline() {
    // Reset pricing timeline to all nulls
    sandboxChart.data.datasets[0].data = Array(31).fill(null);
    sandboxChart.data.datasets[1].data = Array(31).fill(null);
    sandboxChart.data.datasets[2].data = Array(31).fill(null);
    sandboxChart.update();
}

function updateSimUI(stepInfo) {
    const day = stepInfo.day;
    
    // 1. Update Metrics dashboard
    document.getElementById("sim-day-display").textContent = `Day ${day} / 30`;
    document.getElementById("sim-profit-display").textContent = `₹${stepInfo.reward.toFixed(2)}`; // Step reward is cumulative here
    document.getElementById("sim-inventory-display").textContent = `${stepInfo.inventory} units`;
    document.getElementById("sim-demand-display").textContent = demandStatesText[stepInfo.demand_state] || "Medium";
    
    // 2. Add transaction log entry
    const logBox = document.getElementById("sim-log");
    
    if (day > 0) {
        // Daily header log
        const dayHeader = document.createElement("div");
        dayHeader.className = "log-entry day-header";
        dayHeader.innerHTML = `📅 Day ${day} | Demand: ${demandStatesText[stepInfo.demand_state].toUpperCase()} | Remaining Stock: ${stepInfo.inventory} units`;
        logBox.appendChild(dayHeader);
        
        // Sales transaction entry
        if (stepInfo.sales > 0) {
            const salesEntry = document.createElement("div");
            salesEntry.className = "log-entry sale";
            salesEntry.innerHTML = `💵 Sales: Sold ${stepInfo.sales} units at ₹${stepInfo.agent_price.toFixed(2)} each. (Competitor Price: ₹${stepInfo.competitor_price.toFixed(2)}) | Net Profit: +₹${stepInfo.profit.toFixed(2)}`;
            logBox.appendChild(salesEntry);
        } else {
            const noSalesEntry = document.createElement("div");
            noSalesEntry.className = "log-entry";
            noSalesEntry.innerHTML = `⌛ Sales: 0 items sold. (Agent: ₹${stepInfo.agent_price.toFixed(2)} vs Competitor: ₹${stepInfo.competitor_price.toFixed(2)})`;
            logBox.appendChild(noSalesEntry);
        }
        
        // Holding cost entry
        if (stepInfo.holding_cost > 0) {
            const holdingEntry = document.createElement("div");
            holdingEntry.className = "log-entry holding";
            holdingEntry.innerHTML = `📦 Inventory: Holding ${stepInfo.inventory} units in storage. Daily Holding Fee: -₹${stepInfo.holding_cost.toFixed(2)}`;
            logBox.appendChild(holdingEntry);
        }
        
        // Stockout attempts log
        if (stepInfo.stockout_attempts > 0) {
            const stockoutEntry = document.createElement("div");
            stockoutEntry.className = "log-entry stockout";
            stockoutEntry.innerHTML = `⚠️ Lost Sales: ${stepInfo.stockout_attempts} customers wanted to purchase but stock is depleted!`;
            logBox.appendChild(stockoutEntry);
        }
        
        logBox.scrollTop = logBox.scrollHeight;
    } else {
        const initLog = document.createElement("div");
        initLog.className = "log-entry day-header";
        initLog.innerHTML = `🏁 Simulation initialized. Starting stock: ${stepInfo.inventory} units. Marginal Cost: ₹${appState.config.marginal_cost.toFixed(2)}`;
        logBox.appendChild(initLog);
    }
    
    // 3. Append to chart
    sandboxChart.data.datasets[0].data[day] = stepInfo.agent_price;
    sandboxChart.data.datasets[1].data[day] = stepInfo.competitor_price;
    sandboxChart.data.datasets[2].data[day] = stepInfo.inventory;
    sandboxChart.update();
}

async function toggleSandboxPlay() {
    const playBtn = document.getElementById("play-sim-btn");
    
    if (appState.isPlaying) {
        // Pause
        clearInterval(appState.sandboxInterval);
        appState.isPlaying = false;
        playBtn.innerHTML = `<i class="fa-solid fa-play"></i> Resume Play`;
    } else {
        // Play
        if (!appState.sandboxData || appState.sandboxCurrentDay >= 30) {
            const success = await startSandboxEpisode();
            if (!success) return;
        }
        
        appState.isPlaying = true;
        playBtn.innerHTML = `<i class="fa-solid fa-pause"></i> Pause Sim`;
        
        appState.sandboxInterval = setInterval(() => {
            if (appState.sandboxCurrentDay < appState.sandboxData.length) {
                const stepInfo = appState.sandboxData[appState.sandboxCurrentDay];
                // Accumulate profit cumulative display
                if (appState.sandboxCurrentDay > 0) {
                    let prevProfit = appState.sandboxData[appState.sandboxCurrentDay - 1].reward;
                    stepInfo.reward = prevProfit + (stepInfo.profit - stepInfo.holding_cost - (stepInfo.stockout_attempts * 200.0));
                } else {
                    stepInfo.reward = 0;
                }
                
                updateSimUI(stepInfo);
                appState.sandboxCurrentDay++;
            } else {
                clearInterval(appState.sandboxInterval);
                appState.isPlaying = false;
                playBtn.innerHTML = `<i class="fa-solid fa-rotate-left"></i> Run Again`;
                alert("Simulation episode completed!");
            }
        }, 400);
    }
}

async function stepSandboxSim() {
    // If running, pause first
    if (appState.isPlaying) {
        toggleSandboxPlay();
    }
    
    // If no simulation data loaded, or finished, load new one
    if (!appState.sandboxData || appState.sandboxCurrentDay >= 30) {
        const success = await startSandboxEpisode();
        if (!success) return;
    }
    
    if (appState.sandboxCurrentDay < appState.sandboxData.length) {
        const stepInfo = appState.sandboxData[appState.sandboxCurrentDay];
        
        if (appState.sandboxCurrentDay > 0) {
            let prevProfit = appState.sandboxData[appState.sandboxCurrentDay - 1].reward;
            stepInfo.reward = prevProfit + (stepInfo.profit - stepInfo.holding_cost - (stepInfo.stockout_attempts * 200.0));
        } else {
            stepInfo.reward = 0;
        }
        
        updateSimUI(stepInfo);
        appState.sandboxCurrentDay++;
    }
}

function resetSandboxSim() {
    if (appState.isPlaying) {
        clearInterval(appState.sandboxInterval);
        appState.isPlaying = false;
        document.getElementById("play-sim-btn").innerHTML = `<i class="fa-solid fa-play"></i> Play Episode`;
    }
    
    appState.sandboxData = null;
    appState.sandboxCurrentDay = 0;
    
    resetSimTimeline();
    
    document.getElementById("sim-day-display").textContent = "Day 0 / 30";
    document.getElementById("sim-profit-display").textContent = "₹0.00";
    document.getElementById("sim-inventory-display").textContent = "0 / 0";
    document.getElementById("sim-demand-display").textContent = "--";
    
    const logBox = document.getElementById("sim-log");
    logBox.innerHTML = `<div class="log-placeholder">Simulation reset. Press "Play Episode" or "Single Step" to begin.</div>`;
}

// -------------------------------------------------------------------------
// Tab 3: Strategy Comparison Benchmarks
// -------------------------------------------------------------------------
async function runBenchmarkAnalysis() {
    const btn = document.getElementById("run-compare-btn");
    btn.disabled = true;
    btn.innerHTML = `<i class="fa-solid fa-spinner fa-spin"></i> Testing policies...`;
    
    try {
        const response = await fetch('/api/compare', { 
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({})
        });
        const data = await response.json();
        
        btn.disabled = false;
        btn.innerHTML = `<i class="fa-solid fa-sync"></i> Run Benchmark Analysis`;
        
        // 1. Populate comparison charts
        const strategies = ['q_learning', 'rule_based', 'static'];
        
        // Profit & Revenue dataset updates
        compareProfitChart.data.datasets[0].data = strategies.map(s => data[s].avg_profit);
        compareProfitChart.data.datasets[1].data = strategies.map(s => data[s].avg_revenue);
        compareProfitChart.update();
        
        // Inventory dataset updates
        compareStockChart.data.datasets[0].data = strategies.map(s => data[s].avg_unsold_stock);
        compareStockChart.data.datasets[1].data = strategies.map(s => data[s].avg_stockout_attempts);
        compareStockChart.update();
        
        // 2. Populate stats table
        strategies.forEach(s => {
            const row = document.getElementById(`row-${s}`);
            row.querySelector(".rev").textContent = `₹${data[s].avg_revenue.toFixed(2)}`;
            row.querySelector(".prof").textContent = `₹${data[s].avg_profit.toFixed(2)}`;
            row.querySelector(".hold").textContent = `₹${data[s].avg_holding_cost.toFixed(2)}`;
            row.querySelector(".sold").textContent = `${data[s].avg_units_sold.toFixed(1)} units`;
            row.querySelector(".unsold").textContent = `${data[s].avg_unsold_stock.toFixed(1)} units`;
            row.querySelector(".stockout").textContent = `${data[s].avg_stockout_attempts.toFixed(1)} items`;
        });
        
    } catch (err) {
        btn.disabled = false;
        btn.innerHTML = `<i class="fa-solid fa-sync"></i> Run Benchmark Analysis`;
        console.error("Comparison error:", err);
        alert("Failed to retrieve policy benchmark analysis.");
    }
}

// -------------------------------------------------------------------------
// Tab 4: Q-Table Visualizer
// -------------------------------------------------------------------------
function renderQValuesChart() {
    const qBox = document.getElementById("policy-recommendation");
    
    if (!appState.isTrained || !appState.qTable) {
        qBox.innerHTML = `⚠️ Reinforcement Learning policy not trained yet. Run training under the <strong>Agent Training</strong> console first.`;
        return;
    }
    
    // Get active state selectors
    const inv = parseInt(document.getElementById("q-inv-select").value);
    const dem = parseInt(document.getElementById("q-dem-select").value);
    const comp = parseInt(document.getElementById("q-comp-select").value);
    
    // Extract slice of Q-values
    // Q-table dims: [inventory][demand][competitor_relative][action]
    const slice = appState.qTable[inv][dem][comp];
    
    // Find optimal action (max Q-value)
    let maxIdx = 0;
    let maxVal = slice[0];
    for (let i = 1; i < slice.length; i++) {
        if (slice[i] > maxVal) {
            maxVal = slice[i];
            maxIdx = i;
        }
    }
    
    // Highlight the bars: highlight the optimal action differently
    const barColors = slice.map((_, idx) => idx === maxIdx ? 'rgba(5, 255, 161, 0.75)' : 'rgba(0, 242, 254, 0.3)');
    const borderColors = slice.map((_, idx) => idx === maxIdx ? '#05ffa1' : '#00f2fe');
    
    // Update Chart data
    qValuesChart.data.datasets[0].data = slice;
    qValuesChart.data.datasets[0].backgroundColor = barColors;
    qValuesChart.data.datasets[0].borderColor = borderColors;
    qValuesChart.update();
    
    // Update optimal decision box text
    qBox.innerHTML = `Optimal Action: <span style="color: var(--neon-emerald); text-transform: uppercase;">${priceActions[maxIdx]}</span><br>` +
                     `<span style="font-size: 13px; color: var(--text-secondary); font-weight: normal; margin-top: 4px; display: inline-block;">` +
                     `Expected Cumulative Episode Reward: ₹${maxVal.toFixed(2)}</span>`;
}

// -------------------------------------------------------------------------
// Tab 0: Storefront Simulator logic
// -------------------------------------------------------------------------
function updateStorefrontProduct() {
    const inv_s = parseInt(document.getElementById("store-inv-select").value);
    const dem_s = parseInt(document.getElementById("store-traffic-select").value);
    const comp_s = parseInt(document.getElementById("store-comp-select").value);
    
    const marginalCost = appState.config.marginal_cost || 1000.0;
    let selectedActionIdx = 2; // Default Standard Margin
    let isAISmart = false;
    
    if (appState.isTrained && appState.qTable) {
        const qValues = appState.qTable[inv_s][dem_s][comp_s];
        let maxQ = -Infinity;
        let bestAction = 2;
        for (let i = 0; i < qValues.length; i++) {
            if (qValues[i] > maxQ) {
                maxQ = qValues[i];
                bestAction = i;
            }
        }
        selectedActionIdx = bestAction;
        isAISmart = true;
    }
    
    // Calculate and show active competitor price on the product card first
    const baseCompPrice = appState.config.competitor_base_price || (marginalCost * 1.5);
    let activeCompPrice = baseCompPrice;
    if (comp_s === 0) { // Competitor is LOWER
        activeCompPrice = baseCompPrice * 0.85;
    } else if (comp_s === 2) { // Competitor is HIGHER
        activeCompPrice = baseCompPrice * 1.15;
    }
    // Make sure competitor doesn't sell below wholesale cost
    activeCompPrice = Math.max(marginalCost, activeCompPrice);
    
    document.getElementById("storefront-competitor-price-display").textContent = `₹${activeCompPrice.toLocaleString('en-IN', {minimumFractionDigits: 2, maximumFractionDigits: 2})}`;

    // Compute Agent's final price dynamically relative to active competitor price and cost limit (guaranteeing profit)
    let finalPrice = marginalCost * 1.15;
    if (selectedActionIdx === 0) {
        finalPrice = Math.max(marginalCost * 1.05, activeCompPrice * 0.90);
    } else if (selectedActionIdx === 1) {
        finalPrice = Math.max(marginalCost * 1.10, activeCompPrice * 0.95);
    } else if (selectedActionIdx === 2) {
        finalPrice = Math.max(marginalCost * 1.15, activeCompPrice * 1.00);
    } else if (selectedActionIdx === 3) {
        finalPrice = Math.max(marginalCost * 1.20, activeCompPrice * 1.05);
    } else { // 4
        finalPrice = Math.max(marginalCost * 1.30, activeCompPrice * 1.15);
    }
    
    document.getElementById("storefront-price-display").textContent = `₹${finalPrice.toLocaleString('en-IN', {minimumFractionDigits: 2, maximumFractionDigits: 2})}`;

    // Explain in simple English based on state rules and action
    let explanation = "";
    const priceText = `₹${finalPrice.toFixed(2)}`;
    
    if (!isAISmart) {
        explanation = `<strong>Status: Default Matching (Untrained).</strong><br>The AI agent is currently untrained. The store is showing a standard <strong>matching benchmark price of ${priceText}</strong> (secured with a minimum 15% cost safety markup).<br><br>💡 <em>Tip: Navigate to the "Agent Training" tab and click "Run RL Training" to enable smart AI pricing decisions!</em>`;
    } else {
        if (inv_s === 1) { // Low Stock
            explanation = `<strong>Status: Stock Scarcity Mode.</strong><br>Our warehouse stock is critically low. To prevent running out of stock too quickly and losing sales, the AI raised the price to <strong>${priceText}</strong> (extracting high margins from high-intent buyers while slowing demand).`;
        } else if (inv_s === 4 && dem_s === 0) { // High stock, low traffic
            explanation = `<strong>Status: Inventory Liquidation.</strong><br>We are overstocked and market traffic is very slow. To avoid high storage holding fees, the AI offered a discount of <strong>${priceText}</strong> to clear warehouse space quickly.`;
        } else if (dem_s === 2 && comp_s === 2) { // High traffic, competitor high
            explanation = `<strong>Status: High-Demand Harvest.</strong><br>Traffic is surging (Holiday/Flash sale) and our competitors are pricing high. The AI optimized our price to a premium rate of <strong>${priceText}</strong> to capture maximum profits from eager buyers.`;
        } else if (comp_s === 0 && selectedActionIdx <= 1) { // Competitor low, we discounted
            explanation = `<strong>Status: Competitive Undercutting.</strong><br>Our competitor dropped their price to undercut us. To keep customers from leaving, the AI matched them by lowering our price to <strong>${priceText}</strong>.`;
        } else { // Standard
            explanation = `<strong>Status: Balanced Optimization.</strong><br>Market demand is stable and stock is healthy. The AI has set a standard target price of <strong>${priceText}</strong> to maintain a steady flow of sales and steady capital return.`;
        }
    }
    
    document.getElementById("ai-insight-text").innerHTML = explanation;
}

// -------------------------------------------------------------------------
// 10-Product Storefront Data & Logic
// -------------------------------------------------------------------------
let storeProducts = [];

async function loadProductsFromDB() {
    try {
        const response = await fetch('/api/products');
        storeProducts = await response.json();
        
        const selectElement = document.getElementById("store-product-select");
        if (selectElement) {
            selectElement.innerHTML = "";
            storeProducts.forEach(prod => {
                const opt = document.createElement("option");
                opt.value = prod.id;
                opt.textContent = `${prod.name} (Cost: ₹${prod.baseCost.toLocaleString('en-IN')})`;
                selectElement.appendChild(opt);
            });
        }
    } catch (err) {
        console.error("Error loading products from database:", err);
    }
}

async function handleProductSelectionChange() {
    const prodId = document.getElementById("store-product-select").value;
    const prod = storeProducts.find(p => p.id === prodId);
    if (!prod) return;
    
    // Resolve competitor baseline and source details
    const competitorBasePrice = prod.competitorBasePrice !== undefined ? prod.competitorBasePrice : (prod.baseCost * 1.5);
    const priceSource = prod.priceSource || "Default (1.5x Cost)";
    
    // Update Price Source label in storefront card
    document.getElementById("storefront-price-source").textContent = `Source: ${priceSource}`;
    
    // 1. Update Product Card UI
    const card = document.querySelector(".storefront-product-card");
    const mockup = card.querySelector(".phone-mockup");
    mockup.innerHTML = `
        <div class="screen">
            <i class="fa-solid ${prod.icon} fa-4x" style="color: var(--neon-cyan); margin-bottom: 20px;"></i>
            <div class="mock-brand">${prod.brand}</div>
            <div class="mock-model">${prod.model}</div>
        </div>
    `;
    
    card.querySelector("h2").textContent = prod.name;
    card.querySelector(".product-rating").textContent = prod.rating;
    
    const specsContainer = card.querySelector(".specs");
    specsContainer.innerHTML = prod.specs.map(spec => `
        <span><i class="fa-solid fa-circle-check"></i> ${spec}</span>
    `).join("");
    
    // 2. Auto-fill Sidebar Inputs
    document.getElementById("max_inventory").value = prod.stock;
    document.getElementById("marginal_cost").value = prod.baseCost;
    document.getElementById("holding_cost").value = prod.holdingCost;
    document.getElementById("competitor_base_price").value = competitorBasePrice;
    
    // 3. Reset Training state since product settings changed
    appState.isTrained = false;
    appState.qTable = null;
    
    const statusDot = document.getElementById("agent-status-dot");
    const statusText = document.getElementById("agent-status-text");
    statusDot.classList.remove("online");
    statusDot.classList.add("offline");
    statusText.textContent = "Agent Untrained";
    
    // 4. Save Config automatically to Backend
    const configData = {
        max_inventory: prod.stock,
        marginal_cost: prod.baseCost,
        holding_cost: prod.holdingCost,
        competitor_base_price: competitorBasePrice,
        competitor_strategy: document.getElementById("competitor_strategy").value,
        alpha: parseFloat(document.getElementById("alpha").value),
        gamma: parseFloat(document.getElementById("gamma").value),
        epsilon_decay: parseFloat(document.getElementById("epsilon_decay").value),
        train_episodes: parseInt(document.getElementById("train_episodes").value)
    };
    
    try {
        const response = await fetch('/api/config', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(configData)
        });
        const res = await response.json();
        appState.config = res.config;
    } catch (err) {
        console.error("Error auto-updating config:", err);
    }
    
    // 5. Recalculate storefront display
    updateStorefrontProduct();
}
