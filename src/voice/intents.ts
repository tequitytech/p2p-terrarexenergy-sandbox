export const INTENTS = [
  {
    name: 'sell_energy',
    description: 'User wants to sell excess energy to the grid or other consumers',
    examples: ['I want to sell 50 units', 'sell my solar power', 'bijli bechni hai']
  },
  {
    name: 'buy_energy',
    description: 'User wants to purchase energy from producers',
    examples: ['buy 100 units of solar', 'mujhe bijli chahiye', 'purchase green energy']
  },
  {
    name: 'check_price',
    description: 'User wants to check current market prices or rates',
    examples: ['what is the current rate', 'kitne ka hai', 'show me prices']
  },
  {
    name: 'view_meter',
    description: 'User wants to view meter readings or consumption data',
    examples: ['show my meter', 'check consumption', 'meter reading dikhao']
  },
  {
    name: 'help',
    description: 'User needs assistance or wants to know available actions',
    examples: ['help me', 'what can I do', 'kya kar sakta hoon']
  },
  {
    name: 'auto_bid',
    description: 'User wants to auto bid',
    examples: ['auto bid', 'auto bid for energy', 'start auto bidding', 'auto bid karna hai', 'auto bid lagao']
  },
  {
    name: 'my_earning',
    description: 'User wants to check their earnings',
    examples: ['my earning', 'my earnings', 'check my earnings', 'my earnings check karo', 'meri kamai check karo']
  },
  {
    name: 'off_topic',
    description: 'Input is unrelated to energy trading or app functionality',
    examples: []
  }
];
