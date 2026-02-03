export const ENTITY_TYPES = {
  quantity: { description: 'Energy quantity in kWh', unit: 'kWh' },
  price: { description: 'Price per unit', unit: '₹/kWh' },
  time_window: {
    description: 'Time range for energy delivery as ISO 8601 timestamps',
    format: 'ISO 8601 (YYYY-MM-DDTHH:mm:ss.sssZ)',
    note: 'Convert relative times (tomorrow, today, 3PM) to actual timestamps'
  },
  meter_id: { description: 'Meter identifier' },
  source_type: { description: 'Energy source type', values: ['solar', 'wind', 'battery', 'grid'] }
};
