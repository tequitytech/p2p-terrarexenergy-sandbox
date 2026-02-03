export const ENTITY_TYPES = {
  quantity: {
    description: 'Energy quantity as a number',
    unit: 'kWh'
  },
  price: {
    description: 'Price per unit as a number',
    unit: 'INR/kWh'
  },
  time_window: {
    description: 'Delivery time as ISO 8601 timestamp',
    unit: 'ISO8601'
  },
  meter_id: {
    description: 'Meter identifier string',
    unit: 'mRID'
  },
  source_type: {
    description: 'Energy source type',
    unit: 'enum',
    values: ['solar', 'wind', 'battery', 'grid']
  }
};
