export const INTENTS = [
  {
    name: "sell_energy",
    description:
      "User wants to sell energy AND explicitly mentions a quantity/units",
    examples: [
      "I want to sell 50 units",
      "sell 100 kWh tomorrow",
      "mujhe 50 unit bechna hai",
    ],
  },
  {
    name: "buy_energy",
    description: "User wants to purchase energy from producers",
    examples: [
      "buy 100 units of solar",
      "mujhe bijli chahiye",
      "purchase green energy",
    ],
  },
  {
    name: "check_price",
    description: "User wants to check current market prices or rates",
    examples: ["what is the current rate", "kitne ka hai", "show me prices"],
  },
  {
    name: "view_meter",
    description: "User wants to view meter readings or consumption data",
    examples: ["show my meter", "check consumption", "meter reading dikhao"],
  },
  {
    name: "help",
    description: "User needs assistance or wants to know available actions",
    examples: ["help me", "what can I do", "kya kar sakta hoon"],
  },
  {
    name: "auto_bid",
    description:
      "User wants to auto bid OR user wants to sell but does NOT mention specific units/quantity",
    examples: [
      "auto bid",
      "start auto bidding",
      "auto bid karna hai",
      "sell my solar power",
      "bijli bechni hai",
      "I want to sell energy",
    ],
  },
  {
    name: "my_earning",
    description: "User wants to check their earnings",
    examples: [
      "my earning",
      "my earnings",
      "check my earnings",
      "my earnings check karo",
      "meri kamai check karo",
    ],
  },
  {
    name: "gifting_energy",
    description:
      "User wants to gift, transfer, bhet, or send energy to someone (distinct from selling)",
    examples: [
      "gift 50 units",
      "send 100 kWh",
      "give 10 units",
      "bhet dena hai",
      "gift karna hai",
      "gift kar do",
      "100 unit gift kar do",
      "20 kWh bhet dena hai",
      "I want to give gift",
      "100 unit light transfer karni hai"
    ],
  },
  {
    name: "off_topic",
    description: "Input is unrelated to energy trading or app functionality",
    examples: [],
  },
];
