# E-Commerce Dynamic Pricing Q-Learning Agent

Hey everyone! This is my MCA AI/ML project. I built a dynamic pricing simulator for an online store using Reinforcement Learning (Q-Learning). 

Basically, instead of just setting a fixed price for products, I wanted to see if an AI could learn to adjust prices on the fly to maximize profit. The agent looks at three things:
- **Inventory left**: How much stock do we have?
- **Customer Traffic**: Are we getting a lot of visitors right now?
- **Competitor Prices**: What are the other guys charging?

Based on these, it decides whether to hike the price up or offer a discount. It also learns to balance short-term profit against long-term storage fees if items just sit in the warehouse.

## How to run this locally

It's pretty simple to get running on your machine. You just need Python installed.

1. Install the required libraries:
```bash
pip install flask numpy
```

2. Run the Flask server:
```bash
python main.py
```
This will start up the local server. Just open your browser and go to `http://127.0.0.1:5000/`.

## How the Q-Learning works

I used a standard Q-Learning setup for this. 
- **State Space**: It looks at (Stock Level, Demand Level, Competitor Price Level). There are about 45 possible states.
- **Action Space**: The agent can pick from 5 different pricing multipliers (ranging from cost price to +120% margin).
- **Rewards**: It gets positive points (reward) for actual profit made from a sale. It gets negative points (penalties) for daily warehouse storage fees on unsold items, or if it runs out of stock and misses out on potential customers.

I set it to train over 3,000 episodes by default. At first, it just picks random prices (exploration), but as it plays more and more "months" of sales, it starts exploiting the best prices for each specific situation.

## Dashboard Features

I built a web dashboard using Flask and plain CSS (no heavy frontend frameworks here) to interact with the AI:

- **Storefront**: A fake store UI where you can manually change stock/traffic/competitor variables and see how the AI reacts to your changes in real time.
- **Training Panel**: You can watch the AI train itself and look at the learning curve graph.
- **Sandbox**: A manual 30-day simulator to step through days one by one.
- **Comparison**: I wrote a script to benchmark my Q-learning agent against a static pricing strategy and a simple rule-based bot. (Spoiler: The RL agent wins).
- **Q-Table**: You can inspect the actual Q-values to see the "brain" of the agent and understand why it prefers certain prices in certain states.

Feel free to fork this and mess around with the hyperparameters (alpha, gamma, epsilon) in the sidebar to see how it changes the learning behavior!

---
*Developed by Lalit Kumar Singh*
