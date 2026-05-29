# Dynamic Pricing Q-Learning Agent
# This runs the backend server and handles the RL environment

import os
import sys
import time
import json
import random
import threading
import webbrowser
import numpy as np
from flask import Flask, jsonify, request, render_template, send_from_directory

app = Flask(__name__, template_folder='templates', static_folder='static')


class DynamicPricingEnv:
    def __init__(self, max_inventory=25, marginal_cost=1000.0, holding_cost_rate=15.0, horizon=30, competitor_strategy='adaptive', competitor_base_price=None):
        self.max_inventory = max_inventory
        self.marginal_cost = marginal_cost
        self.holding_cost_rate = holding_cost_rate
        self.horizon = horizon
        self.competitor_strategy = competitor_strategy
        self.competitor_base_price = competitor_base_price if competitor_base_price is not None else marginal_cost * 1.5
        
        # Action space multipliers
        self.action_multipliers = [1.0, 1.2, 1.5, 1.8, 2.2]
        self.num_actions = len(self.action_multipliers)
        
        # State space dimensions
        self.num_inventory_states = 5
        self.num_demand_states = 3
        self.num_competitor_states = 3
        
        # Demand transition matrix (Markov Chain)
        # T[i][j] = probability of transitioning from demand state i to j
        self.demand_transition_matrix = np.array([
            [0.6, 0.3, 0.1],  # From Low
            [0.2, 0.6, 0.2],  # From Medium
            [0.1, 0.3, 0.6]   # From High
        ])
        
        # Reset environment state
        self.reset()
        
    def reset(self):
        self.day = 0
        self.inventory = self.max_inventory
        self.demand_state = 1  # Start at Medium demand
        
        # Initial competitor price
        self.competitor_price = self.competitor_base_price
        self.agent_price = self.marginal_cost * 1.5
        
        return self._get_state_tuple()
        
    def _get_state_tuple(self):
        # 1. Discretize Inventory
        if self.inventory == 0:
            inv_state = 0
        elif self.inventory <= int(self.max_inventory * 0.25):
            inv_state = 1
        elif self.inventory <= int(self.max_inventory * 0.50):
            inv_state = 2
        elif self.inventory <= int(self.max_inventory * 0.75):
            inv_state = 3
        else:
            inv_state = 4
            
        # 2. Demand State (already discrete: 0, 1, 2)
        dem_state = self.demand_state
        
        # 3. Relative Competitor Price
        # Compare current agent price vs competitor price
        price_diff = self.agent_price - self.competitor_price
        threshold = 0.05 * self.competitor_price
        
        if price_diff > threshold:
            comp_state = 0  # Agent is higher
        elif price_diff < -threshold:
            comp_state = 2  # Agent is lower
        else:
            comp_state = 1  # Comparable price
            
        return (inv_state, dem_state, comp_state)
 
    def _get_competitor_price(self):
        # Competitor updates price relative to competitor base price
        if self.competitor_strategy == 'aggressive':
            # Prices aggressively low, e.g. 80% to 95% of competitor base price
            mult = random.uniform(0.80, 0.95)
            return max(self.marginal_cost * 1.0, self.competitor_base_price * mult)
            
        elif self.competitor_strategy == 'high_margin':
            # Prices high, e.g. 110% to 130% of competitor base price
            mult = random.uniform(1.10, 1.30)
            return max(self.marginal_cost * 1.0, self.competitor_base_price * mult)
            
        elif self.competitor_strategy == 'matching':
            # Matches agent's previous price with noise
            noise = np.random.normal(0, 0.05 * self.marginal_cost)
            matched_price = self.agent_price + noise
            return max(self.marginal_cost * 1.0, min(self.marginal_cost * 2.5, matched_price))
            
        else:  # 'adaptive'
            # Adapts price to demand: high in high demand, low in low demand relative to base
            if self.demand_state == 2:  # High demand
                mult = random.uniform(1.10, 1.25)
            elif self.demand_state == 0:  # Low demand
                mult = random.uniform(0.85, 0.95)
            else:  # Medium
                mult = random.uniform(0.95, 1.05)
            return max(self.marginal_cost * 1.0, self.competitor_base_price * mult)

    def step(self, action_idx):
        self.day += 1
        current_demand_state = self.demand_state
        
        # set agent price based on action taken
        if action_idx == 0:
            self.agent_price = max(self.marginal_cost * 1.05, self.competitor_price * 0.90)
        elif action_idx == 1:
            self.agent_price = max(self.marginal_cost * 1.10, self.competitor_price * 0.95)
        elif action_idx == 2:
            self.agent_price = max(self.marginal_cost * 1.15, self.competitor_price * 1.00)
        elif action_idx == 3:
            self.agent_price = max(self.marginal_cost * 1.20, self.competitor_price * 1.05)
        else: # 4
            self.agent_price = max(self.marginal_cost * 1.30, self.competitor_price * 1.15)
        
        # 2. Competitor pricing decision
        self.competitor_price = self._get_competitor_price()
        
        # figure out how many people visit today
        # Low: mean 3 arrivals, Medium: mean 6 arrivals, High: mean 12 arrivals
        lambda_demand = [3.0, 6.0, 12.0][self.demand_state]
        
        # Seasonality factor (sine wave over horizon)
        seasonality = 1.0 + 0.25 * np.sin(2 * np.pi * self.day / 15)
        lambda_demand *= seasonality
        
        # random arrivals
        num_arrivals = np.random.poisson(lambda_demand)
        
        # 4. Multinomial Logit (MNL) customer choice model
        # Base utility of purchase
        alpha_agent = 3.5
        alpha_competitor = 3.5
        beta = 0.002  # Price sensitivity scaled for Rupees
        gamma_rel = 0.0015  # Penalty for being more expensive than competitor scaled for Rupees
        
        # Utility of no-buy option
        u_none = 1.0
        
        sales = 0
        revenue = 0.0
        stockout_attempts = 0
        
        if self.inventory > 0:
            # Calculate agent utility
            u_agent = alpha_agent - beta * self.agent_price
            if self.agent_price > self.competitor_price:
                u_agent -= gamma_rel * (self.agent_price - self.competitor_price)
                
            # Calculate competitor utility
            u_comp = alpha_competitor - beta * self.competitor_price
            if self.competitor_price > self.agent_price:
                u_comp -= gamma_rel * (self.competitor_price - self.agent_price)
                
            # Exponential utilities
            exp_agent = np.exp(u_agent)
            exp_comp = np.exp(u_comp)
            exp_none = np.exp(u_none)
            
            # Purchase shares
            sum_exp = exp_agent + exp_comp + exp_none
            prob_agent = exp_agent / sum_exp
            prob_competitor = exp_comp / sum_exp
            prob_none = exp_none / sum_exp
            
            # Simulate arrivals decisions
            for _ in range(num_arrivals):
                if self.inventory == 0:
                    stockout_attempts += 1
                    continue
                # Customer choice: 0 = Agent, 1 = Competitor, 2 = None
                choice = np.random.choice([0, 1, 2], p=[prob_agent, prob_competitor, prob_none])
                if choice == 0:
                    sales += 1
                    self.inventory -= 1
                    revenue += self.agent_price
        else:
            # Out of stock. Customers only choose competitor or none
            u_comp = alpha_competitor - beta * self.competitor_price
            exp_comp = np.exp(u_comp)
            exp_none = np.exp(u_none)
            sum_exp = exp_comp + exp_none
            prob_competitor = exp_comp / sum_exp
            prob_none = exp_none / sum_exp
            
            # Since agent is out of stock, any attempt to buy from agent is stockout
            # Simple assumption: normal probability agent would have got is stockout_attempts
            u_agent_hypothetical = alpha_agent - beta * self.agent_price
            exp_agent_h = np.exp(u_agent_hypothetical)
            sum_h = exp_agent_h + exp_comp + exp_none
            prob_agent_h = exp_agent_h / sum_h
            
            for _ in range(num_arrivals):
                if np.random.random() < prob_agent_h:
                    stockout_attempts += 1
                    
        # 5. Financial metrics
        cost_of_goods_sold = sales * self.marginal_cost
        gross_profit = revenue - cost_of_goods_sold
        
        # Inventory holding costs
        holding_cost = self.inventory * self.holding_cost_rate
        
        # Stockout penalty (loss of goodwill or urgency penalty)
        stockout_penalty = stockout_attempts * 200.0
        
        # Reward function
        reward = gross_profit - holding_cost - stockout_penalty
        
        # 6. Transitions
        # Transition demand state using Markov matrix
        prob_dist = self.demand_transition_matrix[self.demand_state]
        self.demand_state = np.random.choice([0, 1, 2], p=prob_dist)
        
        # Get next state representation
        next_state = self._get_state_tuple()
        
        # Check termination
        done = (self.day >= self.horizon)
        
        # Step information
        info = {
            'day': self.day,
            'inventory': self.inventory,
            'demand_state': int(current_demand_state),
            'agent_price': float(self.agent_price),
            'competitor_price': float(self.competitor_price),
            'sales': int(sales),
            'revenue': float(revenue),
            'profit': float(gross_profit),
            'holding_cost': float(holding_cost),
            'stockout_attempts': int(stockout_attempts),
            'reward': float(reward)
        }
        
        return next_state, reward, done, info

# -------------------------------------------------------------------------
# 2. Q-LEARNING AGENT
# -------------------------------------------------------------------------

class QLearningAgent:
    def __init__(self, num_actions=5, alpha=0.1, gamma=0.9, epsilon=1.0, epsilon_decay=0.995, epsilon_min=0.05):
        self.num_actions = num_actions
        self.alpha = alpha  # Learning rate
        self.gamma = gamma  # Discount factor
        self.epsilon = epsilon  # Exploration rate
        self.epsilon_decay = epsilon_decay
        self.epsilon_min = epsilon_min
        
        # Q-table shape: (inventory_state, demand_state, competitor_state, action)
        # Dimensions: 5 x 3 x 3 x 5
        self.q_table = np.zeros((5, 3, 3, num_actions))
        
    def choose_action(self, state, force_exploit=False):
        inv_s, dem_s, comp_s = state
        
        # Epsilon-greedy exploration
        if not force_exploit and np.random.rand() < self.epsilon:
            return random.randint(0, self.num_actions - 1)
        else:
            # Exploit: choose best action, break ties randomly
            q_values = self.q_table[inv_s, dem_s, comp_s]
            max_q = np.max(q_values)
            actions = np.where(q_values == max_q)[0]
            return np.random.choice(actions)
            
    def learn(self, state, action, reward, next_state):
        inv_s, dem_s, comp_s = state
        next_inv_s, next_dem_s, next_comp_s = next_state
        
        # Q-learning update
        predict = self.q_table[inv_s, dem_s, comp_s, action]
        target = reward + self.gamma * np.max(self.q_table[next_inv_s, next_dem_s, next_comp_s])
        self.q_table[inv_s, dem_s, comp_s, action] += self.alpha * (target - predict)
        
    def decay_epsilon(self):
        self.epsilon = max(self.epsilon_min, self.epsilon * self.epsilon_decay)


class StaticAgent:
    def __init__(self, action_idx=2):
        self.action_idx = action_idx
        
    def choose_action(self, state):
        return self.action_idx

class RuleBasedAgent:
    def choose_action(self, state):
        inv_s, dem_s, comp_s = state
        
        if inv_s <= 1:  # Low stock or out of stock
            return 4  # Premium price (slow down velocity, extract high margins)
        elif inv_s >= 4:  # Overstock
            return 0  # Discount price (liquidate)
        else:
            # Medium inventory
            if comp_s == 0:  # Competitor is pricing low
                return 1  # Low-margin matching pricing
            elif comp_s == 2:  # Competitor is pricing high
                return 3  # High-margin pricing
            else:  # Comparable
                return 2  # Standard pricing


def run_training(agent, env, num_episodes=5000):
    rewards_history = []
    epsilons_history = []
    
    # Track performance in chunks for visual smoothing
    chunk_size = max(1, num_episodes // 100)
    current_chunk_rewards = []
    
    for episode in range(num_episodes):
        state = env.reset()
        episode_reward = 0
        done = False
        
        while not done:
            action = agent.choose_action(state)
            next_state, reward, done, info = env.step(action)
            agent.learn(state, action, reward, next_state)
            state = next_state
            episode_reward += reward
            
        agent.decay_epsilon()
        
        current_chunk_rewards.append(episode_reward)
        if (episode + 1) % chunk_size == 0:
            rewards_history.append(float(np.mean(current_chunk_rewards)))
            epsilons_history.append(float(agent.epsilon))
            current_chunk_rewards = []
            
    # Calculate Q-table fill rate (percentage of cells that are non-zero)
    non_zero = np.count_nonzero(agent.q_table)
    total_cells = agent.q_table.size
    fill_rate = float(non_zero) / total_cells * 100
    
    return rewards_history, epsilons_history, fill_rate


# Initial global parameters
config = {
    'max_inventory': 25,
    'marginal_cost': 1000.0,
    'holding_cost': 15.0,
    'horizon': 30,
    'competitor_strategy': 'adaptive',
    'alpha': 0.15,
    'gamma': 0.85,
    'epsilon_decay': 0.992,
    'train_episodes': 3000,
    'competitor_base_price': 1500.0
}

# Globally shared agent and environments
global_agent = QLearningAgent(
    num_actions=5, 
    alpha=config['alpha'], 
    gamma=config['gamma'], 
    epsilon=1.0, 
    epsilon_decay=config['epsilon_decay']
)
trained_agent = None  # Will hold a copy of the agent after training

PRODUCTS_FILE = 'products.json'

DEFAULT_PRODUCTS = [
    { "id": "earbuds", "name": "Quantum Earbuds Pro", "rating": "⭐️ 4.8/5.0 (2,450 Reviews)", "icon": "fa-headphones", "baseCost": 1000.0, "holdingCost": 15.0, "stock": 25, "specs": ["40h Battery", "Active Noise Cancelling"], "brand": "QUANTUM", "model": "Earbuds Pro" },
    { "id": "smartwatch", "name": "Horizon Smartwatch Slate", "rating": "⭐️ 4.7/5.0 (1,820 Reviews)", "icon": "fa-stopwatch", "baseCost": 3000.0, "holdingCost": 25.0, "stock": 20, "specs": ["AMOLED Display", "Heart Rate Monitor"], "brand": "HORIZON", "model": "Smartwatch Slate" },
    { "id": "vr", "name": "Spectra VR Headset", "rating": "⭐️ 4.9/5.0 (920 Reviews)", "icon": "fa-vr-cardboard", "baseCost": 12000.0, "holdingCost": 80.0, "stock": 10, "specs": ["2K Per Eye", "120Hz Refresh"], "brand": "SPECTRA", "model": "VR Headset" },
    { "id": "keyboard", "name": "Apex Mechanical Keyboard", "rating": "⭐️ 4.6/5.0 (1,540 Reviews)", "icon": "fa-keyboard", "baseCost": 2000.0, "holdingCost": 18.0, "stock": 30, "specs": ["Red Linear Switches", "RGB Backlit"], "brand": "APEX", "model": "Mechanical Keyboard" },
    { "id": "ssd", "name": "Titan Portable SSD 2TB", "rating": "⭐️ 4.8/5.0 (2,110 Reviews)", "icon": "fa-hard-drive", "baseCost": 5000.0, "holdingCost": 30.0, "stock": 15, "specs": ["USB 3.2 Gen2", "2000MB/s Read"], "brand": "TITAN", "model": "Portable SSD 2TB" },
    { "id": "projector", "name": "Nebula 4K Projector", "rating": "⭐️ 4.5/5.0 (670 Reviews)", "icon": "fa-video", "baseCost": 15000.0, "holdingCost": 100.0, "stock": 8, "specs": ["4K UHD Resolution", "2000 ANSI Lumens"], "brand": "NEBULA", "model": "4K Projector" },
    { "id": "lamp", "name": "Lumina LED Desk Lamp", "rating": "⭐️ 4.4/5.0 (880 Reviews)", "icon": "fa-lightbulb", "baseCost": 800.0, "holdingCost": 10.0, "stock": 40, "specs": ["5 Color Modes", "Wireless Charger"], "brand": "LUMINA", "model": "LED Desk Lamp" },
    { "id": "headphones", "name": "Aura ANC Headphones", "rating": "⭐️ 4.7/5.0 (1,230 Reviews)", "icon": "fa-headphones-simple", "baseCost": 4500.0, "holdingCost": 35.0, "stock": 18, "specs": ["50h Playtime", "Hi-Res Audio"], "brand": "AURA", "model": "ANC Headphones" },
    { "id": "wireless_charger", "name": "VoltCharge Wireless Pad", "rating": "⭐️ 4.3/5.0 (1,420 Reviews)", "icon": "fa-bolt-lightning", "baseCost": 600.0, "holdingCost": 8.0, "stock": 50, "specs": ["15W Fast Charge", "Qi Certified"], "brand": "VOLTCHARGE", "model": "Wireless Pad" },
    { "id": "drone", "name": "Vector Drone Cam Lite", "rating": "⭐️ 4.6/5.0 (750 Reviews)", "icon": "fa-paper-plane", "baseCost": 8000.0, "holdingCost": 60.0, "stock": 12, "specs": ["1080p Camera", "GPS Return Home"], "brand": "VECTOR", "model": "Drone Cam Lite" }
]

def load_products_from_file():
    if not os.path.exists(PRODUCTS_FILE):
        try:
            with open(PRODUCTS_FILE, 'w', encoding='utf-8') as f:
                json.dump(DEFAULT_PRODUCTS, f, indent=4)
        except Exception as e:
            print(f"Error initializing products file: {e}")
            return DEFAULT_PRODUCTS
    try:
        with open(PRODUCTS_FILE, 'r', encoding='utf-8') as f:
            return json.load(f)
    except Exception as e:
        print(f"Error loading products file: {e}")
        return DEFAULT_PRODUCTS

def save_product_to_file(new_prod):
    prods = load_products_from_file()
    # Check if product already exists to avoid duplicates
    existing_idx = -1
    for idx, p in enumerate(prods):
        if p.get('id') == new_prod.get('id'):
            existing_idx = idx
            break
            
    if existing_idx != -1:
        prods[existing_idx] = new_prod
    else:
        prods.append(new_prod)
        
    try:
        with open(PRODUCTS_FILE, 'w', encoding='utf-8') as f:
            json.dump(prods, f, indent=4)
    except Exception as e:
        print(f"Error writing to products file: {e}")
    return prods


@app.route('/')
def home():
    return render_template('index.html')

@app.route('/api/products', methods=['GET', 'POST'])
def api_products():
    if request.method == 'POST':
        new_prod = request.json
        if not new_prod or 'id' not in new_prod or 'name' not in new_prod:
            return jsonify({'error': 'Invalid product structure'}), 400
        updated_list = save_product_to_file(new_prod)
        return jsonify(updated_list)
    return jsonify(load_products_from_file())



@app.route('/api/config', methods=['GET', 'POST'])
def api_config():
    global global_agent, config
    if request.method == 'POST':
        data = request.json
        for key in config:
            if key in data:
                if key in ['max_inventory', 'horizon', 'train_episodes']:
                    config[key] = int(data[key])
                elif key in ['marginal_cost', 'holding_cost', 'alpha', 'gamma', 'epsilon_decay', 'competitor_base_price']:
                    config[key] = float(data[key])
                else:
                    config[key] = str(data[key])
                    
        # Re-initialize the global agent with updated hyper-parameters
        global_agent = QLearningAgent(
            num_actions=5,
            alpha=config['alpha'],
            gamma=config['gamma'],
            epsilon=1.0,
            epsilon_decay=config['epsilon_decay']
        )
        return jsonify({'status': 'Config updated', 'config': config})
    return jsonify(config)

@app.route('/api/train', methods=['POST'])
def api_train():
    global global_agent, trained_agent, config
    
    # Fetch parameters
    episodes = config['train_episodes']
    
    # Environment for training
    env = DynamicPricingEnv(
        max_inventory=config['max_inventory'],
        marginal_cost=config['marginal_cost'],
        holding_cost_rate=config['holding_cost'],
        horizon=config['horizon'],
        competitor_strategy=config['competitor_strategy'],
        competitor_base_price=config.get('competitor_base_price', config['marginal_cost'] * 1.5)
    )
    
    # Start training timing
    start_time = time.time()
    rewards, epsilons, fill_rate = run_training(global_agent, env, episodes)
    training_time = time.time() - start_time
    
    # Save a deep-copy of the agent
    trained_agent = QLearningAgent(num_actions=5)
    trained_agent.q_table = np.copy(global_agent.q_table)
    trained_agent.epsilon = global_agent.epsilon
    
    # Convert Q-table format for JSON response (rounded)
    q_table_list = np.round(global_agent.q_table, 2).tolist()
    
    return jsonify({
        'success': True,
        'rewards': rewards,
        'epsilons': epsilons,
        'fill_rate': fill_rate,
        'training_time_seconds': round(training_time, 3),
        'q_table': q_table_list
    })

@app.route('/api/simulate', methods=['POST'])
def api_simulate():
    global trained_agent, config
    
    # We must have a trained agent, or use the global agent
    agent_to_use = trained_agent if trained_agent is not None else global_agent
    
    data = request.get_json(silent=True) or {}
    strategy = data.get('strategy', 'q_learning')  # 'q_learning', 'static', 'rule_based'
    comp_strategy = data.get('competitor_strategy', config['competitor_strategy'])
    
    env = DynamicPricingEnv(
        max_inventory=config['max_inventory'],
        marginal_cost=config['marginal_cost'],
        holding_cost_rate=config['holding_cost'],
        horizon=config['horizon'],
        competitor_strategy=comp_strategy,
        competitor_base_price=config.get('competitor_base_price', config['marginal_cost'] * 1.5)
    )
    
    # Choose Agent Strategy
    if strategy == 'static':
        agent = StaticAgent(action_idx=2)  # Fixed mid-margin price multiplier (1.5x)
    elif strategy == 'rule_based':
        agent = RuleBasedAgent()
    else:  # q_learning
        agent = agent_to_use
        
    state = env.reset()
    done = False
    history = []
    
    total_profit = 0.0
    total_revenue = 0.0
    total_holding = 0.0
    total_sales = 0
    
    # Record initial state
    history.append({
        'day': 0,
        'inventory': env.inventory,
        'demand_state': env.demand_state,
        'agent_price': env.agent_price,
        'competitor_price': env.competitor_price,
        'sales': 0,
        'revenue': 0.0,
        'profit': 0.0,
        'holding_cost': env.inventory * env.holding_cost_rate,
        'stockout_attempts': 0,
        'reward': 0.0
    })
    
    while not done:
        # Choose action (force exploitation for simulator evaluation)
        if strategy == 'q_learning':
            action = agent.choose_action(state, force_exploit=True)
        else:
            action = agent.choose_action(state)
            
        next_state, reward, done, info = env.step(action)
        state = next_state
        
        total_profit += info['profit']
        total_revenue += info['revenue']
        total_holding += info['holding_cost']
        total_sales += info['sales']
        
        history.append(info)
        
    return jsonify({
        'strategy': strategy,
        'total_profit': round(total_profit, 2),
        'total_revenue': round(total_revenue, 2),
        'total_holding_cost': round(total_holding, 2),
        'total_units_sold': total_sales,
        'unsold_stock': env.inventory,
        'history': history
    })

@app.route('/api/compare', methods=['POST'])
def api_compare():
    global trained_agent, config
    
    # We must have a trained agent, or use the global agent
    agent_to_use = trained_agent if trained_agent is not None else global_agent
    
    data = request.get_json(silent=True) or {}
    comp_strategy = data.get('competitor_strategy', config['competitor_strategy'])
    num_runs = int(data.get('runs', 50))  # Evaluate over 50 episodes for smooth average
    
    strategies = ['q_learning', 'static', 'rule_based']
    comparison_results = {}
    
    for strat in strategies:
        profits = []
        revenues = []
        holdings = []
        sales = []
        unsolds = []
        stockouts = []
        
        for _ in range(num_runs):
            env = DynamicPricingEnv(
                max_inventory=config['max_inventory'],
                marginal_cost=config['marginal_cost'],
                holding_cost_rate=config['holding_cost'],
                horizon=config['horizon'],
                competitor_strategy=comp_strategy,
                competitor_base_price=config.get('competitor_base_price', config['marginal_cost'] * 1.5)
            )
            
            if strat == 'static':
                agent = StaticAgent(action_idx=2)
            elif strat == 'rule_based':
                agent = RuleBasedAgent()
            else:
                agent = agent_to_use
                
            state = env.reset()
            done = False
            
            run_profit = 0
            run_revenue = 0
            run_holding = 0
            run_sales = 0
            run_stockouts = 0
            
            while not done:
                if strat == 'q_learning':
                    action = agent.choose_action(state, force_exploit=True)
                else:
                    action = agent.choose_action(state)
                next_state, reward, done, info = env.step(action)
                
                run_profit += info['profit']
                run_revenue += info['revenue']
                run_holding += info['holding_cost']
                run_sales += info['sales']
                run_stockouts += info['stockout_attempts']
                state = next_state
                
            profits.append(run_profit)
            revenues.append(run_revenue)
            holdings.append(run_holding)
            sales.append(run_sales)
            unsolds.append(env.inventory)
            stockouts.append(run_stockouts)
            
        comparison_results[strat] = {
            'avg_profit': round(float(np.mean(profits)), 2),
            'avg_revenue': round(float(np.mean(revenues)), 2),
            'avg_holding_cost': round(float(np.mean(holdings)), 2),
            'avg_units_sold': round(float(np.mean(sales)), 1),
            'avg_unsold_stock': round(float(np.mean(unsolds)), 1),
            'avg_stockout_attempts': round(float(np.mean(stockouts)), 1)
        }
        
    return jsonify(comparison_results)


def open_browser():
    # Wait for the server to spin up
    time.sleep(1.5)
    url = "http://127.0.0.1:5000/"
    print(f"[*] Opening browser tab for: {url}")
    webbrowser.open(url)

if __name__ == '__main__':
    # Start web browser opening thread
    # Only open browser if not in reloader (or run once)
    if os.environ.get('WERKZEUG_RUN_MAIN') != 'true':
        threading.Thread(target=open_browser, daemon=True).start()
        
    print("[*] Starting AI-Driven Dynamic Pricing Optimization Server...")
    app.run(host='127.0.0.1', port=5000, debug=True)
